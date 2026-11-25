// Live engine-sim, the simulating half: a dedicated Web Worker running
// engine-sim (MIT, github.com/ange-yaghi/engine-sim) as single-threaded
// WebAssembly (static/live/engine-sim.wasm, scripts/engine-sim/wasm/).
//
//   main thread (rev-live.js) ── controls, 50 Hz ──► this worker
//   this worker ── audio chunks, 44.1 kHz ──► 'rev-live' worklet (MessageChannel)
//   worklet ── how much it holds, ~100 Hz ──► this worker: simulate more?
//
// The worker simulates only as far ahead of the speakers as the worklet's
// buffer needs (TARGET_S), so it never runs away, and it idles when the
// AudioContext is suspended (no reports, nothing to fill). It measures its
// speed (simulated seconds per second of its own compute time) and reports
// it; rev-live.js decides when it is too slow.
//
// What it sends is the DRY synthesizer signal, levelled and split three
// ways for the page's audio graph (rev-live.js): `e` for the engine impulse
// response, `x` for the exhaust one, `s` for the low-passed sub layer. The
// levels make live as loud as the recorded loops at the same rpm and load:
// static/live/levels.json (scripts/engine-sim/wasm/calibrate.mjs) predicts
// them, and ChainMeter, which runs the page's chain on the dry signal here,
// corrects them to what the graph will really play.
//
// EngineRunner and the control mapping are exported for the tests and the
// calibration script, which run them in Node.

import { SAMPLE_SETS } from './rev-samples.js'
import { irFromWav } from './rev-live.js'

export const SR = 44100
// The synthesizer's fixed gain: render-set.sh's ES_GAIN, so the output is
// in the units of the native renders.
export const ES_GAIN = 0.0006
// Scripts that stall at a fully closed throttle idle with it cracked
// (render-set.sh: ES_IDLE_THROTTLE).
export const IDLE_THROTTLE = { f136: 0.02 }
export const FRAME_S = 1 / 200   // one simulation frame
export const STARTER_S = 1.5     // on the starter, as render.cpp
export const WARM_S = 1.0        // then idling, unheard, before it plays
export const TARGET_S = 0.12     // audio kept ahead of the speakers
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// ── Controls ──────────────────────────────────────────────────────────────
// What engine-sim should do for the player's state p = { rpm, load, idle,
// stopped, limiter }. Returns { mode: 0 (held on the dyno at rpm) | 1
// (free), rpm, throttle }. `st` keeps the hysteresis between calls.
//  - Driving or revving: the dyno holds the engine at the model's rpm,
//    with the throttle at the load (overrun = closed).
//  - Parked near idle with no throttle: free, so it idles on its own (with
//    the idle throttle for engines that stall shut).
//  - On the limiter: free at full throttle, bouncing off engine-sim's own
//    rev limiter.
// The dyno engages at the engine's own speed and follows the model's rpm
// smoothly (live.cpp), so the hand-overs do not clunk.
export function controlFor(p, st, engineRpm, idleThrottle = 0) {
  const idle = p.idle > 0 ? p.idle : 800
  const load = Number.isFinite(p.load) ? p.load : 0
  const rpm = Number.isFinite(p.rpm) ? p.rpm : idle
  if (p.limiter) { st.free = false; return { mode: 1, rpm, throttle: 1 } }
  // A stall while free (engineRpm far under idle): hold it from then on.
  if (st.free && engineRpm > 0 && engineRpm < idle * 0.6) st.noFree = true
  const nearIdle = st.free
    ? p.stopped && load <= 0.1 && rpm <= idle * 1.12
    : p.stopped && load <= 0.05 && rpm <= idle * 1.06
  st.free = nearIdle && !st.noFree
  if (st.free) return { mode: 1, rpm: idle, throttle: idleThrottle }
  return { mode: 0, rpm, throttle: clamp(load, 0, 1) }
}

// ── Levels ────────────────────────────────────────────────────────────────
// levels.json (scripts/engine-sim/wasm/calibrate.mjs), per car: rows at the
// recorded set's rev points (its idle first).
//   tgt[g][row][k]  dB: the recorded player's own loudness there, group g
//                   (e = engine, x = exhaust) alone, at load loads[k]: its
//                   loops, crossfades and rpm loudness curve, as it plays
//                   them (SampleVoice), before the cabin. tgt.m: the two
//                   half and half, which shows how far they add in phase.
// and per quality, what live makes at the throttles th[k]:
//   r[g][row][k]    dB: the live chain's loudness at gain 1 (its impulse
//                   response, EQ and sub, as rev-live.js wires them)
//   s[g][row][k]    the sub layer's gain (0.7 × the main's RMS over the
//                   low-passed dry signal's, as rev-samples.mjs mixes it)
//   d, rho          the dry level (dB), and how much the groups correlate
//   limiter         the same for the engine free on its rev limiter
// The table predicts live's gain; ChainMeter corrects it from what the
// engine is really doing (the impulse responses' resonances swing the
// level by 10 dB within a few percent of rpm, finer than any table).
function lerpRow(a, xs, x) {
  if (x <= xs[0]) return a[0]
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return a[i - 1] + (a[i] - a[i - 1]) * t }
  return a[a.length - 1]
}
// Everything the table says at a state: per group { gain, sub, r, T }
// (gain = the recorded loudness T over live's r), and rho. limiter: the
// engine is free on its rev limiter, which has its own entry, and plays
// as loud as the player's top rev point at the model's load.
export function stateAt(L, rpm, throttle, load, limiter = false) {
  const n = L.rpm.length
  let i = 0
  while (i < n - 2 && rpm > L.rpm[i + 1]) i++
  const t = n < 2 ? 0 : clamp((rpm - L.rpm[i]) / (L.rpm[i + 1] - L.rpm[i]), 0, 1)
  const row = (tab, xs, x) => lerpRow(tab[i], xs, x) + (lerpRow(tab[i + 1], xs, x) - lerpRow(tab[i], xs, x)) * t
  const out = {}
  if (limiter && L.limiter) {
    const z = L.limiter
    out.rho = z.rho
    // The player's limiter is its top rev point, flipping to overrun in
    // each cut (the model's load), so the target follows the load there.
    const top = (tab) => lerpRow(tab[n - 1], L.loads, load)
    if (L.tgt.m) out.Tm = top(L.tgt.m)
    for (const g of ['e', 'x']) {
      const T = top(L.tgt[g])
      out[g] = { T, r: z.r[g], sub: z.s[g], gain: 10 ** ((T - z.r[g]) / 20) }
    }
    return out
  }
  out.rho = L.rho ? row(L.rho, L.th, throttle) : 0
  if (L.tgt.m) out.Tm = row(L.tgt.m, L.loads, load)
  for (const g of ['e', 'x']) {
    const T = row(L.tgt[g], L.loads, load), r = row(L.r[g], L.th, throttle)
    out[g] = { T, r, sub: row(L.s[g], L.th, throttle), gain: 10 ** ((T - r) / 20) }
  }
  return out
}
export function levelAt(L, g, rpm, throttle, load) { return stateAt(L, rpm, throttle, load)[g] }
// How far the measured spectrum may pull the table's gain (dB either way),
// and how slowly (s).
export const CORRECT_DB = 9
export const METER_TAU = 0.4

// ── The live chain's loudness, measured ───────────────────────────────────
// The worker runs each group's whole chain on the dry signal, as rev-live.js
// builds it (its impulse response, the EQ shelves, the sub layer at its
// gain through two Butterworth low-passes, the 25 Hz rumble filter), by
// overlap-add FFT convolution in blocks of BLOCK samples, and measures what
// comes out: each group's power at gain 1 and their cross-power, smoothed
// over METER_TAU. That is what the page's graph will play, exactly, a
// fraction of a second ahead of it. (~2 % of a core.)
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < h; k++) {
        const p = i + k, q = p + h
        const vr = re[q] * cr - im[q] * ci, vi = re[q] * ci + im[q] * cr
        re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t
      }
    }
  }
}
// A biquad's response at angular frequency w: [re, im].
function biquadAt([b0, b1, b2, a0, a1, a2], w) {
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2)
  const d = dr * dr + di * di
  return [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d]
}
// RBJ / Web Audio BiquadFilterNode coefficients [b0, b1, b2, a0, a1, a2].
export function shelf({ type, hz, db }, sr) {
  const A = Math.pow(10, db / 40), w = 2 * Math.PI * hz / sr, c = Math.cos(w), k = Math.sqrt(A) * Math.sin(w) * Math.SQRT2
  return type === 'lowshelf'
    ? [A * ((A + 1) - (A - 1) * c + k), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - k), (A + 1) + (A - 1) * c + k, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - k]
    : [A * ((A + 1) + (A - 1) * c + k), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - k), (A + 1) - (A - 1) * c + k, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - k]
}
export function butterLowpass(hz, sr) {
  const w = 2 * Math.PI * hz / sr, c = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  return [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha]
}
export class ChainMeter {
  // ir: { e, x } Float32Arrays (scaled as engine-sim scales them), set: the
  // car's rev-samples.js set (eq, sub).
  constructor(ir, set, sr = SR, block = 8192) {
    let n = 2
    while (n < block + Math.max(ir.e.length, ir.x.length) - 1) n <<= 1
    this.n = n; this.L = block; this.sr = sr
    this.buf = new Float64Array(block); this.w = 0
    this.re = new Float64Array(n); this.im = new Float64Array(n)
    this.yr = new Float64Array(n); this.yi = new Float64Array(n)
    this.tail = { e: new Float64Array(n), x: new Float64Array(n) }
    this.out = { e: new Float64Array(block), x: new Float64Array(block) }
    this.pe = 0; this.px = 0; this.pex = 0; this.blocks = 0
    this.se = 0.1; this.sx = 0.1
    // Each group's main path (impulse response, EQ, rumble filter) and the
    // sub path (low-pass twice, rumble filter), per bin: [re, im].
    const resp = (h) => { const re = new Float64Array(n), im = new Float64Array(n); re.set(h); fft(re, im); return [re, im] }
    const he = resp(ir.e), hx = resp(ir.x)
    const eq = set.eq.map((f) => shelf(f, sr)), lp = butterLowpass(set.sub.lowpass, sr)
    const a = 1 - Math.exp(-2 * Math.PI * 25 / sr)
    this.A = { e: [new Float64Array(n), new Float64Array(n)], x: [new Float64Array(n), new Float64Array(n)] }
    this.B = [new Float64Array(n), new Float64Array(n)]
    for (let k = 0; k < n; k++) {
      const w = 2 * Math.PI * k / n
      let er = 1, ei = 0
      for (const c of eq) { const [r, i] = biquadAt(c, w); const t = er * r - ei * i; ei = er * i + ei * r; er = t }
      const [hr, hi] = biquadAt([1 - a, -(1 - a), 0, 1, -(1 - a), 0], w) // rumble filter
      const t = er * hr - ei * hi; ei = er * hi + ei * hr; er = t
      for (const [g, h] of [['e', he], ['x', hx]]) {
        this.A[g][0][k] = h[0][k] * er - h[1][k] * ei
        this.A[g][1][k] = h[0][k] * ei + h[1][k] * er
      }
      const [lr, li] = biquadAt(lp, w)
      const l2r = lr * lr - li * li, l2i = 2 * lr * li
      this.B[0][k] = l2r * hr - l2i * hi; this.B[1][k] = l2r * hi + l2i * hr
    }
  }
  get ready() { return this.blocks >= 2 }
  // The sub layer's gain for each group, from the next block on.
  setSub(se, sx) { this.se = se; this.sx = sx }
  // Dry samples (full scale 1).
  push(x) {
    for (let i = 0; i < x.length; i++) {
      this.buf[this.w++] = x[i]
      if (this.w === this.L) { this.w = 0; this.block() }
    }
  }
  block() {
    const n = this.n, L = this.L, re = this.re, im = this.im
    re.fill(0); im.fill(0); re.set(this.buf)
    fft(re, im)
    for (const [g, s] of [['e', this.se], ['x', this.sx]]) {
      const A = this.A[g], B = this.B, yr = this.yr, yi = this.yi
      // Inverse FFT by conjugation: ifft(Y) = conj(fft(conj(Y))) / n.
      for (let k = 0; k < n; k++) {
        const gr = A[0][k] + s * B[0][k], gi = A[1][k] + s * B[1][k]
        yr[k] = re[k] * gr - im[k] * gi; yi[k] = -(re[k] * gi + im[k] * gr)
      }
      fft(yr, yi)
      const tail = this.tail[g], out = this.out[g]
      for (let i = 0; i < n; i++) tail[i] += yr[i] / n
      out.set(tail.subarray(0, L))
      tail.copyWithin(0, L); tail.fill(0, n - L)
    }
    let e = 0, x = 0, ex = 0
    const oe = this.out.e, ox = this.out.x
    for (let i = 0; i < L; i++) { e += oe[i] * oe[i]; x += ox[i] * ox[i]; ex += oe[i] * ox[i] }
    e /= L; x /= L; ex /= L
    const k = this.blocks ? 1 - Math.exp(-L / this.sr / METER_TAU) : 1
    this.pe += (e - this.pe) * k; this.px += (x - this.px) * k; this.pex += (ex - this.pex) * k
    this.blocks++
  }
  // Each group's power at gain 1 and their cross-power: { e, x, ex }.
  power() { return { e: this.pe, x: this.px, ex: this.pex } }
}

// One car's table at one quality, as levelAt reads it (null if not calibrated).
export function levelsFor(levels, car, quality) {
  const c = levels && levels[car]
  const q = c && c.q && c.q[String(quality)]
  return q && c.tgt ? { rpm: c.rpm, th: c.th, loads: c.loads, tgt: c.tgt, ...q } : null
}

// ── The engine ────────────────────────────────────────────────────────────
// Writes the data bundle (engine-sim-data.json: { files, scripts }) into the
// module's filesystem and loads one car's script.
export async function createModule(factory, wasmBinary, data) {
  const M = await factory({ wasmBinary, print: () => {}, printErr: () => {} })
  for (const [p, text] of Object.entries(data.files)) {
    const dir = p.split('/').slice(0, -1).join('/')
    if (dir) M.FS.mkdirTree('/' + dir)
    M.FS.writeFile('/' + p, text)
  }
  M.FS.chdir('/')
  return M
}

export class EngineRunner {
  // levels: this car's entry of levels.json (null: unlevelled, gain 1).
  constructor(M, data, car, quality = 1, levels = null) {
    const script = data.scripts[car]
    if (!script) throw new Error('no engine script for ' + car)
    const ptr = M.stringToNewUTF8(script)
    const ok = M._es_load(ptr, quality, ES_GAIN)
    M._free(ptr)
    if (!ok) throw new Error('engine script did not compile: ' + script)
    this.M = M; this.car = car; this.levels = levels
    this.freq = M._es_frequency()
    this.steps = Math.max(1, Math.round(this.freq * FRAME_S))
    this.idleThrottle = IDLE_THROTTLE[car] || 0
    const vols = Array.from({ length: M._es_exhaust_count() }, (_, i) => M._es_ir_volume(i))
    // One impulse response for the summed exhausts is exact only if they
    // all have the same volume (true of all four scripts).
    if (new Set(vols).size !== 1) throw new Error('exhausts have different impulse-response volumes: ' + vols.join(', '))
    this.irVolume = vols[0]
    this.slow = 1
    this.t = 0           // simulated seconds
    this.compute = 0     // ms spent simulating
    this.st = {}         // controlFor's hysteresis
    this.p = null        // the player's last state
    this.exhaust = 0.5
    this.load = 0        // smoothed like the throttle
    this.g = null        // last frame's gains, ramped from
    this.meter = null    // ChainMeter, once attached
    M._es_control(1, 0, this.idleThrottle)
  }
  // Measure the live chain (ChainMeter) from now on. ir: { e, x } as
  // rev-live.js builds them; set: the car's rev-samples.js set.
  attachMeter(ir, set) { this.meter = new ChainMeter(ir, set) }
  get rpm() { return this.M._es_rpm() }
  get throttle() { return this.M._es_throttle() }

  // The start, unheard: ignition on, STARTER_S on the starter, then idling.
  warmUp(seconds = STARTER_S + WARM_S) {
    const manual = this.manual
    this.manual = true // idling on its own whatever the player asks meanwhile
    this.M._es_control(1, 0, this.idleThrottle)
    this.M._es_ignition(1)
    this.M._es_starter(1)
    while (this.t < seconds) {
      if (this.t >= STARTER_S) this.M._es_starter(0)
      this.dry()
    }
    this.M._es_starter(0)
    this.manual = manual
  }

  // The player's state (rev-sound.js tick: rpm, load, idle, stopped, limiter).
  set(p) {
    if (Number.isFinite(p.exhaust)) this.exhaust = clamp(p.exhaust, 0, 1)
    this.p = { ...(this.p || {}), ...p }
  }

  // Drive the engine directly (calibration and tests): mode 0 held at rpm,
  // 1 free; throttle 0..1.
  control(mode, rpm, throttle) { this.manual = true; this.M._es_control(mode, rpm, throttle) }

  // One frame, dry: a Float32Array view (valid until the next call) in
  // int16 units (full scale 32768).
  dry() {
    const M = this.M
    if (this.p && !this.manual) {
      const c = controlFor(this.p, this.st, M._es_rpm(), this.idleThrottle)
      M._es_control(c.mode, c.rpm, c.throttle)
      this.mode = c.mode
    }
    const a = performance.now()
    const n = M._es_run(this.steps)
    const p = M._es_audio() >> 2
    const d = M.HEAPF32.subarray(p, p + n)
    if (this.meter) this.meter.push(Float64Array.from(d, (v) => v / 32768))
    // debugSlow (rev-live.js): pretend each frame cost `slow` times as much.
    if (this.slow > 1) { const until = a + (performance.now() - a) * this.slow; while (performance.now() < until) {} }
    // The speed counts the meter too: it is part of keeping up.
    this.compute += performance.now() - a
    this.t += this.steps / this.freq
    return d
  }

  // One frame, levelled and split for the graph: { e, x, s } (Float32Arrays
  // in a single buffer, transferable), the gains ramped from the last frame.
  frame() {
    const d = this.dry(), n = d.length
    const k = 1 - Math.exp(-FRAME_S / 0.024)
    const load = this.p && Number.isFinite(this.p.load) ? this.p.load : 0
    this.load += (load - this.load) * k
    // The gains glide (30 ms) so a change of state (onto the limiter, off
    // the dyno) never steps the level.
    const want = this.gains()
    const g0 = this.g || want
    const kg = 1 - Math.exp(-FRAME_S / 0.03)
    const g = { e: g0.e + (want.e - g0.e) * kg, x: g0.x + (want.x - g0.x) * kg, s: g0.s + (want.s - g0.s) * kg }
    this.g = g
    const buf = new Float32Array(3 * n)
    const e = buf.subarray(0, n), x = buf.subarray(n, 2 * n), s = buf.subarray(2 * n)
    for (let i = 0; i < n; i++) {
      const u = (i + 1) / n, v = d[i] / 32768
      e[i] = v * (g0.e + (g.e - g0.e) * u)
      x[i] = v * (g0.x + (g.x - g0.x) * u)
      s[i] = v * (g0.s + (g.s - g0.s) * u)
    }
    return { buf, n }
  }

  // The three gains now. Each group plays at the recorded player's loudness
  // for this rpm and load (which has its rpm loudness curve in it): the
  // table's gain, corrected by what the meter says the chain really makes
  // (both smoothed alike, METER_TAU, so a blip moves them together and does
  // not overshoot). Then the Exhaust mix: equal power, as the loops'
  // groups; the two groups add partly in phase in both players, by
  // different amounts, so live's mix is scaled to the player's.
  gains() {
    const rpm = this.rpm, th = this.throttle, m = this.exhaust
    const ge = Math.sqrt(1 - m), gx = Math.sqrt(m)
    const L = this.levels
    if (!L) return { e: ge, x: gx, s: 0 }
    const limiter = !!(this.p && this.p.limiter) && this.mode === 1
    const z = stateAt(L, rpm, th, this.load, limiter)
    let fe = 1, fx = 1, rho = z.rho
    const mt = this.meter
    if (mt && mt.ready) {
      const k = 1 - Math.exp(-FRAME_S / METER_TAU), we = 10 ** (z.e.r / 10), wx = 10 ** (z.x.r / 10)
      this.pe = this.pe == null ? we : this.pe + (we - this.pe) * k
      this.px = this.px == null ? wx : this.px + (wx - this.px) * k
      mt.setSub(z.e.sub, z.x.sub)
      const p = mt.power()
      const f = (want, got) => 10 ** (clamp(10 * Math.log10(want / got), -CORRECT_DB, CORRECT_DB) / 20)
      if (this.correct !== false && p.e > 0 && p.x > 0) { fe = f(this.pe, p.e); fx = f(this.px, p.x) }
      if (p.e > 0 && p.x > 0) rho = p.ex / Math.sqrt(p.e * p.x)
    }
    this.last = { fe, fx, rho } // for verify.mjs
    const ae = z.e.gain * fe, ax = z.x.gain * fx
    // The player's own cross-power, from its half-and-half mix: P(0.5) =
    // (Te² + Tx²) / 2 + X. Its mix at m is then (1-m) Te² + m Tx² + 2 ge gx X.
    const Te = 10 ** (z.e.T / 20), Tx = 10 ** (z.x.T / 20)
    const X = z.Tm != null ? 10 ** (z.Tm / 10) - (Te * Te + Tx * Tx) / 2 : 0
    const pt = Math.max(1e-12, (1 - m) * Te * Te + m * Tx * Tx + 2 * ge * gx * X)
    const pl = (1 - m) * Te * Te + m * Tx * Tx + 2 * ge * gx * Te * Tx * rho
    const c = Math.sqrt(pt / Math.max(0.25 * pt, pl))
    return { e: c * ge * ae, x: c * gx * ax, s: c * (ge * ae * z.e.sub + gx * ax * z.x.sub) }
  }
}

// ── Worker ────────────────────────────────────────────────────────────────
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  let runner = null, port = null
  let sent = 0, report = null, ready = false
  let lastStats = 0, statT = 0, statCompute = 0, speed = null
  const post = (m) => globalThis.postMessage(m)
  const fail = (e) => post({ type: 'error', message: e && e.message ? e.message : String(e) })

  // Fill the worklet up to TARGET_S ahead: what it holds, plus what is on
  // its way to it.
  function fill() {
    if (!runner || !ready || !report) return
    const target = TARGET_S * SR
    let ahead = report.buffered + (sent - report.received)
    while (ahead < target) {
      const { buf, n } = runner.frame()
      port.postMessage({ audio: buf, n }, [buf.buffer])
      sent += n; ahead += n
    }
    stats()
  }
  // Speed over the last ~0.5 s of simulating, smoothed.
  function stats(force) {
    const now = performance.now()
    if (!force && now - lastStats < 250) return
    lastStats = now
    const dt = runner.t - statT, dc = runner.compute - statCompute
    if (dc > 20) {
      const s = dt / (dc / 1000)
      speed = speed == null ? s : speed * 0.6 + s * 0.4
      statT = runner.t; statCompute = runner.compute
    }
    post({ type: 'stats', speed, underruns: report ? report.underruns : 0, filled: !!(report && report.playing),
      buffered: report ? report.buffered / SR : 0, rpm: runner.rpm, fresh: dc > 20 })
  }

  globalThis.onmessage = async (e) => {
    const m = e.data || {}
    try {
      if (m.type === 'init') {
        port = m.port
        port.onmessage = (ev) => { report = ev.data; try { fill() } catch (err) { ready = false; fail(err) } }
        const [{ default: factory }, wasm, data, levels, irs] = await Promise.all([
          import(m.base + 'live/engine-sim.js'),
          fetch(m.base + 'live/engine-sim.wasm').then((r) => { if (!r.ok) throw new Error('engine-sim.wasm: HTTP ' + r.status); return r.arrayBuffer() }),
          fetch(m.base + 'live/engine-sim-data.json').then((r) => { if (!r.ok) throw new Error('engine-sim-data.json: HTTP ' + r.status); return r.json() }),
          fetch(m.base + 'live/levels.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
          Promise.all(['engine', 'exhaust'].map((g) => fetch(m.base + 'live/ir-' + g + '.wav').then((r) => { if (!r.ok) throw new Error('ir-' + g + '.wav: HTTP ' + r.status); return r.arrayBuffer() }))),
        ])
        const M = await createModule(factory, new Uint8Array(wasm), data)
        runner = new EngineRunner(M, data, m.car, m.quality, levelsFor(levels, m.car, m.quality))
        const ir = (ab) => irFromWav(ab, runner.irVolume).x
        runner.attachMeter({ e: ir(irs[0]), x: ir(irs[1]) }, SAMPLE_SETS[m.car])
        if (m.params) runner.set(m.params)
        const c0 = runner.compute
        runner.warmUp()
        speed = runner.t / ((runner.compute - c0) / 1000)
        statT = runner.t; statCompute = runner.compute
        ready = true
        post({ type: 'ready', speed, freq: runner.freq, irVolume: runner.irVolume })
        fill()
      } else if (m.type === 'set') {
        if (runner) runner.set(m.params)
      } else if (m.type === 'debug') {
        if (runner && Number.isFinite(m.slow)) runner.slow = m.slow
      } else if (m.type === 'stop') {
        ready = false
      }
    } catch (err) { fail(err) }
  }
}
