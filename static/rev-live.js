// Live engine-sim: engine-sim itself (MIT, github.com/ange-yaghi/engine-sim)
// running in the car's browser as WebAssembly, instead of the recorded
// loops. rev-sound.js starts it when the owner picks "Live engine-sim", and
// plays the recorded loops until it is running and whenever it cannot keep up.
//
//   rev-live-worker.js   a Web Worker: the simulation, dry, levelled
//        │ MessageChannel, 44.1 kHz chunks
//   rev-live-worklet.js  'rev-live': ring buffer, resampling, gain
//        │ engine ─► ConvolverNode (engine-sim's "real engine" response) ─┐
//        │ exhaust ► ConvolverNode (its "minimal muffling" response) ─────┤► low shelf 90 Hz +10 dB
//        │                                                                │  ► high shelf 3.5 kHz -4 dB ─┐
//        │ sub ────► low-pass 100 Hz ► low-pass 100 Hz ──────────────────────────────────────────────────┤► 25 Hz rumble filter
//        ▼                                                                                                ▼
//   the player's 'rev-engine' node (its input), so it goes through the cabin like the loops
//
// That is the recorded loops' recipe (rev-samples.js `ir`, `eq`, `sub`,
// and rev-samples.mjs), done live with native nodes: engine-sim's own
// convolution would be half of its cost in WebAssembly. The levels
// (static/live/levels.json, scripts/engine-sim/wasm/calibrate.mjs) make it
// as loud as the loops at the same rpm and load.
//
// Contract with rev-sound.js: new LiveEngine(ctx, node); await load(car,
// quality); set({ rpm, load, gain, exhaust, idle, stopped, limiter }) every
// tick; `playing`; status(); dispose().

import { SAMPLE_SETS } from './rev-samples.js'

const BASE = new URL('./', import.meta.url).href
// Too slow: under SLOW for SLOW_MS, or UNDERRUNS dropouts within UNDERRUN_MS.
export const SLOW = 0.98
export const SLOW_MS = 3000
export const UNDERRUNS = 4
export const UNDERRUN_MS = 10000
const LOAD_TIMEOUT_MS = 60000
const IN_RATE = 44100

// A 16-bit PCM WAV's first channel, as engine-sim's own initializeImpulseResponse
// scales it: volume x sample / 32767.
export function irFromWav(ab, volume) {
  const v = new DataView(ab)
  let o = 12, ch = 1, bits = 16, rate = IN_RATE
  while (o + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)), size = v.getUint32(o + 4, true)
    if (id === 'fmt ') { ch = v.getUint16(o + 10, true); rate = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true) }
    if (id === 'data') {
      if (bits !== 16) throw new Error('impulse response is not 16-bit')
      const n = Math.floor(size / 2 / ch), x = new Float32Array(n)
      for (let i = 0; i < n; i++) x[i] = v.getInt16(o + 8 + i * 2 * ch, true) * volume / 32767
      return { x, rate }
    }
    o += 8 + size + (size & 1)
  }
  throw new Error('impulse response has no data')
}

// Too slow? A pure judge over the worker's reports, for the tests.
//   speed: simulated s per s of compute; fresh: it simulated since the last
//   report (a suspended context sends none, and is never judged).
export class SlowJudge {
  constructor() { this.since = null; this.drops = [] ; this.lastUnderruns = 0 }
  // Returns a reason string once it is too slow, else null.
  report(now, { speed, underruns = 0, fresh = true }) {
    if (underruns > this.lastUnderruns) {
      for (let i = this.lastUnderruns; i < underruns; i++) this.drops.push(now)
      this.lastUnderruns = underruns
    }
    while (this.drops.length && now - this.drops[0] > UNDERRUN_MS) this.drops.shift()
    if (this.drops.length >= UNDERRUNS) return 'dropouts'
    if (!fresh || !Number.isFinite(speed)) return null
    if (speed < SLOW) { if (this.since == null) this.since = now; if (now - this.since >= SLOW_MS) return 'speed' }
    else this.since = null
    return null
  }
}

export class LiveEngine {
  constructor(ctx, node) {
    this.ctx = ctx; this.node = node
    this.state = 'loading'; this.speed = null; this.underruns = 0; this.note = null
    this.filled = false
    this.worker = null; this.live = null; this.nodes = []
    this.judge = new SlowJudge()
    this.gain = 0; this.sentGain = -1
    this.params = null
    this.disposed = false
  }

  get playing() { return this.state === 'running' && this.filled && !this.disposed }

  status() { return { state: this.state, speed: this.speed, underruns: this.underruns, note: this.note } }

  async load(car, quality = 1) {
    if (!SAMPLE_SETS[car]) throw new Error('no engine-sim car ' + car)
    this.car = car
    const ctx = this.ctx
    if (typeof Worker === 'undefined') throw new Error('this browser has no Web Workers')
    if (typeof WebAssembly === 'undefined') throw new Error('this browser has no WebAssembly')
    const irs = Promise.all(['engine', 'exhaust'].map((g) => fetch(BASE + 'live/ir-' + g + '.wav').then((r) => {
      if (!r.ok) throw new Error('ir-' + g + '.wav: HTTP ' + r.status)
      return r.arrayBuffer()
    })))
    await ctx.audioWorklet.addModule(new URL('./rev-live-worklet.js', import.meta.url).href)
    if (this.disposed) return
    const live = new AudioWorkletNode(ctx, 'rev-live', { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [1, 1, 1] })
    this.live = live
    const worker = new Worker(new URL('./rev-live-worker.js', import.meta.url), { type: 'module' })
    this.worker = worker
    const ch = new MessageChannel()
    live.port.postMessage({ port: ch.port1, gain: 0 }, [ch.port1])
    const ready = new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('engine-sim did not start within ' + LOAD_TIMEOUT_MS / 1000 + ' s')), LOAD_TIMEOUT_MS)
      worker.onmessage = (e) => {
        const m = e.data || {}
        if (m.type === 'ready') { clearTimeout(timer); ok(m) }
        else if (m.type === 'error') { clearTimeout(timer); fail(new Error(m.message)) }
        else if (m.type === 'stats') this.onStats(m)
      }
      worker.onerror = (e) => { clearTimeout(timer); fail(new Error(e && e.message ? e.message : 'the engine-sim worker failed')) }
    })
    worker.postMessage({ type: 'init', port: ch.port2, base: BASE, car, quality, params: this.params }, [ch.port2])
    let m
    try {
      m = await ready
    } catch (e) {
      this.fail(e)
      throw e
    }
    if (this.disposed) return
    worker.onerror = (e) => this.fail(new Error(e && e.message ? e.message : 'the engine-sim worker failed'))
    worker.onmessage = (e) => {
      const d = e.data || {}
      if (d.type === 'stats') this.onStats(d)
      else if (d.type === 'error') this.fail(new Error(d.message))
    }
    this.graph(await irs, m.irVolume)
    this.speed = m.speed
    this.state = 'running'
    // The start counts too: it ran flat out, so its speed is the simulation's.
    if (!(m.speed >= SLOW)) this.tooSlow('speed')
  }

  // The recorded recipe, with native nodes (see the header).
  graph([engineWav, exhaustWav], volume) {
    const ctx = this.ctx, sr = ctx.sampleRate
    const conv = (ab) => {
      const { x, rate } = irFromWav(ab, volume)
      const c = new ConvolverNode(ctx, { disableNormalization: true })
      c.normalize = false
      c.buffer = resampleIr(ctx, x, rate)
      return c
    }
    const set = SAMPLE_SETS[this.car] || Object.values(SAMPLE_SETS)[0]
    const ce = conv(engineWav), cx = conv(exhaustWav)
    let eq = null, first = null
    for (const f of set.eq) {
      const b = new BiquadFilterNode(ctx, { type: f.type, frequency: f.hz, gain: f.db })
      if (eq) eq.connect(b); else first = b
      eq = b
    }
    // Butterworth (Q 0.7071, which a lowpass BiquadFilterNode takes in dB),
    // twice, as rev-samples.mjs does.
    const lp1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: set.sub.lowpass, Q: 20 * Math.log10(Math.SQRT1_2) })
    const lp2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: set.sub.lowpass, Q: 20 * Math.log10(Math.SQRT1_2) })
    // rev-samples.mjs level(): a one-pole high-pass at 25 Hz.
    const a = 1 - Math.exp(-2 * Math.PI * 25 / sr)
    const hp = new IIRFilterNode(ctx, { feedforward: [1 - a, -(1 - a)], feedback: [1, -(1 - a)] })
    const live = this.live
    live.connect(ce, 0); live.connect(cx, 1); live.connect(lp1, 2)
    ce.connect(first || hp); cx.connect(first || hp)
    if (eq) eq.connect(hp)
    lp1.connect(lp2).connect(hp)
    hp.connect(this.node)
    this.nodes = [ce, cx, lp1, lp2, hp, ...(eq ? [eq] : [])]
  }

  onStats(m) {
    if (this.state !== 'running') return
    if (Number.isFinite(m.speed)) this.speed = m.speed
    this.underruns = m.underruns || 0
    this.filled = !!m.filled
    const why = this.judge.report(performance.now(), m)
    if (why) this.tooSlow(why)
    this.sendGain()
  }

  tooSlow(why) {
    if (this.state !== 'running') return
    this.state = 'too-slow'
    const s = Number.isFinite(this.speed) ? this.speed.toFixed(2) + '×' : 'too slowly'
    this.note = why === 'dropouts'
      ? 'Live engine-sim kept dropping out (' + this.underruns + ' dropouts at ' + s + ' real time), so the recorded mix plays instead.'
      : 'Live engine-sim simulates at only ' + s + ' real time here, so the recorded mix plays instead. A lower quality may keep up.'
    this.halt()
  }

  fail(e) {
    if (this.disposed) return
    this.state = 'error'
    this.note = 'Live engine-sim stopped: ' + (e && e.message ? e.message : e)
    this.halt()
  }

  // Stop simulating, so it never starves the recorded playback; fade out first.
  halt() {
    this.filled = false
    this.sendGain()
    const worker = this.worker, live = this.live, nodes = this.nodes
    this.worker = null
    if (worker) { try { worker.postMessage({ type: 'stop' }) } catch {} }
    setTimeout(() => {
      if (worker) worker.terminate()
      if (live) { try { live.port.postMessage({ stop: true }); live.disconnect() } catch {} }
      for (const n of nodes) { try { n.disconnect() } catch {} }
    }, 300)
    this.live = null; this.nodes = []
  }

  set(p) {
    const { gain, ...rest } = p
    if (Number.isFinite(gain)) this.gain = Math.max(0, Math.min(1, gain))
    this.params = { ...(this.params || {}), ...rest }
    if (this.worker && this.state === 'running') this.worker.postMessage({ type: 'set', params: rest })
    this.sendGain()
  }

  // Heard only while it keeps up; the recorded loops play otherwise.
  sendGain() {
    const g = this.playing ? this.gain : 0
    if (g === this.sentGain || !this.live) return
    this.sentGain = g
    this.live.port.postMessage({ gain: g })
  }

  // A test hook: make every frame cost `factor` times its compute, so the
  // too-slow fallback can be tried on a fast machine.
  debugSlow(factor) { if (this.worker) this.worker.postMessage({ type: 'debug', slow: factor }) }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.state === 'loading' || this.state === 'running') this.state = 'stopped'
    this.halt()
  }
}

// An impulse response at the context's rate. A ConvolverNode takes only
// buffers at its context's rate; the response is 44.1 kHz. Resampled with
// a windowed sinc, and scaled by 44.1 kHz / rate so the convolution keeps
// engine-sim's gain (more taps per second sum to more).
export function resampleIr(ctx, x, rate) {
  const sr = ctx.sampleRate
  if (sr === rate) {
    const b = ctx.createBuffer(1, x.length, sr)
    b.copyToChannel(x, 0)
    return b
  }
  const y = resample(x, rate, sr)
  const b = ctx.createBuffer(1, y.length, sr)
  b.copyToChannel(y, 0)
  return b
}
export function resample(x, from, to) {
  const ratio = from / to, n = Math.ceil(x.length / ratio), y = new Float32Array(n)
  const cut = Math.min(1, to / from), W = 16
  for (let i = 0; i < n; i++) {
    const t = i * ratio, k0 = Math.floor(t)
    let s = 0
    for (let k = k0 - W + 1; k <= k0 + W; k++) {
      if (k < 0 || k >= x.length) continue
      const d = t - k
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * cut * d) / (Math.PI * cut * d)
      const win = 0.5 + 0.5 * Math.cos(Math.PI * d / W)
      s += x[k] * cut * sinc * win
    }
    y[i] = s * (from / to)
  }
  return y
}
