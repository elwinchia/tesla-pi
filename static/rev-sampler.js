// Recorded engine sound: plays loops cut from real recordings, each one
// recorded at a known rpm, and crossfades between them as the revs move.
//
//   rpm ──► the two loops either side of it ──► each resampled to sound at
//   this rpm (playback rate = rpm / loop rpm) ──► equal-power crossfade
//   load ──► on-load / off-load layers if the car has both, else a tone
//            filter and level that open up under load
//
// Every loop keeps playing (silently when it is not needed), so a crossfade
// never restarts one mid-cycle. Loops are made seamless when they are cut
// (scripts/rev-samples.mjs), so here a loop simply wraps.
//
// Like EngineVoice this is pure: the AudioWorklet runs it on the car's
// browser, and `node --test` and scripts/rev-render.mjs run it offline.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// How far one loop may be pitched before it sounds like a tape at the wrong
// speed. Past the top loop the engine still rises, just less convincingly.
export const MAX_RATE = 3.2

// Weights for each loop of one layer at `rpm`: the pair either side of it,
// crossfaded with equal power. `loops` must be sorted by rpm.
export function pairWeights(loops, rpm, out) {
  out.fill(0)
  const n = loops.length
  if (!n) return out
  if (rpm <= loops[0].rpm) { out[0] = 1; return out }
  if (rpm >= loops[n - 1].rpm) { out[n - 1] = 1; return out }
  let i = 0
  while (i < n - 2 && rpm > loops[i + 1].rpm) i++
  const t = (rpm - loops[i].rpm) / (loops[i + 1].rpm - loops[i].rpm)
  out[i] = Math.cos(t * Math.PI / 2)
  out[i + 1] = Math.sin(t * Math.PI / 2)
  return out
}

// How much of the on-load layer to use: off at a lift, full from light
// throttle up.
export function onLoadMix(load) { return clamp((load + 0.1) / 0.4, 0, 1) }

// How loud the engine plays at an rpm, on top of the loops' own levels: the
// idle IDLE_LOUDNESS (about -7 dB) as loud, rising evenly in decibels to full
// at the top loop. The loops alone leave the idle almost as loud as a hard
// rev (their levels are square-rooted so overrun stays audible); this lets
// the idle sit back and the revs build. The start and stop clips, which end
// and begin at idle, are played at IDLE_LOUDNESS too (rev-sound.js).
export const IDLE_LOUDNESS = 0.45
export function rpmLoudness(rpm, idle, top, floor = IDLE_LOUDNESS) {
  if (!(top > idle)) return 1
  return Math.pow(floor, 1 - clamp((rpm - idle) / (top - idle), 0, 1))
}

// partThrottle (rev-samples.js): with a light-throttle layer, load picks a
// place on overrun -> part -> full instead (0, 1, 2), each step an
// equal-power crossfade. The model's load is not a throttle: it is the
// force the car uses over what it could use (rev-model.js loadFromMotion),
// so a steady cruise reads 0.02-0.08, a gentle pull 0.15-0.3, a firm one
// 0.5 and up, a lift or the gearbox's shift cut -0.15 and below. Cruise
// (0 to 0.12) sits on the part layer, rendered where the engine makes ~20 %
// of its full-throttle torque; pulls blend into full throttle by 0.5, a
// coast into overrun by -0.1 (where the plain on/off mix is all overrun too).
export const PART_LOAD = { lift: -0.1, cruise: 0, light: 0.12, full: 0.5 }
export function throttlePlace(load) {
  const { lift, cruise, light, full } = PART_LOAD
  if (load <= lift) return 0
  if (load < cruise) return (load - lift) / (cruise - lift)
  if (load <= light) return 1
  if (load < full) return 1 + (load - light) / (full - light)
  return 2
}
// Amplitudes for [overrun, part, full] at a place from throttlePlace.
export function throttleMix(x, out = [0, 0, 0]) {
  const lo = x <= 1, t = (lo ? x : x - 1) * Math.PI / 2
  out[0] = lo ? Math.cos(t) : 0
  out[1] = lo ? Math.sin(t) : Math.cos(t)
  out[2] = lo ? 0 : Math.sin(t)
  return out
}

// oneShots: an upshift under load plays the shift clip if the load before
// it was at least SHIFT_LOAD (a light-throttle shift is near silent in a
// real car). The clip starts SHIFT_LEAD s before its cut: the model drops
// the revs from the tick the gear changes, and the voice's rpm lags it.
// It fades in over SHIFT_IN s and back into the loops over SHIFT_OUT s.
export const SHIFT_LOAD = 0.25
export const SHIFT_LEAD = 0.02
export const SHIFT_IN = 0.015
export const SHIFT_OUT = 0.12
// The limiter loop plays while the model says it is on the limiter and
// the throttle pushed within the last cut + LIMITER_HOLD s: a finger lifted
// in the red leaves it at once rather than 0.3 s later.
export const LIMITER_HOLD = 0.06
const LIMITER_TAU = 0.02 // s, its crossfade
const SHIFT_END = 0.01
const MATCH_TAU = 0.1 // s

// Below this a loop is not heard; a loop under it for a whole block is only
// advanced (exactly as when heard), not interpolated.
const HEARD = 1e-4

export class SampleVoice {
  constructor(sampleRate) {
    this.sr = sampleRate
    this.rpm = 800; this.rpmTarget = 800
    this.load = 0; this.loadTarget = 0
    this.gain = 0; this.gainTarget = 0
    this.loops = []
    this.lp = 0 // one-pole tone filter state
    this.t = 0  // seconds rendered
    // oneShots: the model's gearbox and limiter, from set()
    this.gear = 0; this.shifting = false; this.limiter = false
    this.driveLoad = 0; this.pushAt = -Infinity
    this.lim = 0; this.shot = null; this.shotMix = 0
    this.limiters = []; this.shifts = []
    this.rr = new Float64Array(128); this.mix = new Float64Array(128)
    this.amp = [0, 0, 0]
  }

  // set: { loops: [{ rpm, layer: 'on' | 'off' | 'any' | 'part' | 'limiter'
  // | 'shift', group?: 'engine' | 'exhaust', gain?, data: Float32Array, sr,
  // and for a limiter loop `cut`, for a shift clip `from`, `to`, `at`,
  // `cut` }], quiet? }
  // quiet: rpmLoudness's floor, IDLE_LOUDNESS unless given (1 = flat); its
  // idle and top are the set's lowest and highest rev loops.
  setSet(set) {
    const valid = (set && set.loops ? set.loops : []).filter((l) => l && l.data && l.data.length > 1 && l.rpm > 0 && l.sr > 0)
    const make = (l) => ({ rpm: l.rpm, layer: l.layer || 'any', group: l.group || 'engine', gain: l.gain || 1, data: l.data, sr: l.sr, pos: 0, w: 0, wTarget: 0,
      phaseIndex: l.phaseIndex, phaseOf: l.phaseOf, alias: l.alias })
    // The rev loops: everything but the limiter and the shift clips, which
    // are not pitched by rpm and are mixed in on top of them.
    const special = (l) => l.layer === 'limiter' || l.layer === 'shift'
    const loops = valid.filter((l) => !special(l)).map(make).sort((a, b) => a.rpm - b.rpm)
    // Start each loop at a different point, so two loops of one recording
    // never line up into a comb: by its place in rpm order, or where the
    // set says (phaseIndex, rev-samples.js withPhases: a set's own loops
    // start where they always did when options add loops, and a long loop
    // where its short twin, phaseOf s long, does).
    loops.forEach((l, i) => {
      const k = Number.isInteger(l.phaseIndex) ? l.phaseIndex : i
      const len = l.phaseOf > 0 ? Math.round(l.phaseOf * l.sr) : l.data.length
      l.pos = ((len * 0.37 * k) % len) % l.data.length
    })
    this.loops = loops
    // Each group's limiter loop and shift clips start together and stay in
    // step (they are one run heard two ways): `corr` is how alike they are.
    this.limiters = valid.filter((l) => l.layer === 'limiter').map((l) => ({ ...make(l), cut: l.cut || 0.1, corr: l.corr || 0 }))
    this.shifts = valid.filter((l) => l.layer === 'shift').map((l) => ({ ...make(l), from: l.from, to: l.to, at: l.at, cut: l.cut, corr: l.corr || 0 }))
    this.limCut = Math.max(0, ...this.limiters.map((l) => l.cut))
    // For the one-shots' level match (render): each rev loop's RMS.
    this.match = 1
    if (this.limiters.length || this.shifts.length) {
      for (const l of loops) { let e = 0; const d = l.data; for (let i = 0; i < d.length; i++) e += d[i] * d[i]; l.rms2 = e / d.length }
    }
    this.lim = 0; this.shot = null; this.shotMix = 0
    this.quiet = set && Number.isFinite(set.quiet) ? set.quiet : IDLE_LOUDNESS
    this.idleRpm = loops.length ? loops[0].rpm : 0
    this.topRpm = loops.length ? loops[loops.length - 1].rpm : 0
    // Each group (the same engine heard from the engine or the exhaust) is
    // weighted on its own, by rpm and load, then scaled by the mix.
    this.groups = {}
    for (const l of loops) {
      const g = (this.groups[l.group] ||= { loops: [], layers: {} })
      g.loops.push(l)
      ;(g.layers[l.layer] ||= []).push(l)
    }
    for (const g of Object.values(this.groups)) {
      g.split = !!(g.layers.on && g.layers.off)
      g.part = g.split && !!g.layers.part
      // The idle in the part layer (alias 'idle') is the same file as the
      // on-load and overrun idles: its weight goes to them, in the share the
      // plain on/off mix gives them, so the idle sounds exactly as it did.
      g.partIdle = g.part ? g.layers.part.find((l) => l.alias === 'idle') : null
      if (g.partIdle) {
        g.idleOn = g.layers.on.find((l) => l.rpm === g.partIdle.rpm)
        g.idleOff = g.layers.off.find((l) => l.rpm === g.partIdle.rpm)
        if (!g.idleOn || !g.idleOff) g.partIdle = null
      }
      g.weights = {}
      for (const [k, ls] of Object.entries(g.layers)) g.weights[k] = new Float64Array(ls.length)
      g.allW = new Float64Array(g.loops.length)
    }
    this.split = loops.length > 0 && Object.values(this.groups).every((g) => g.split)
  }
  get ready() { return this.loops.length > 0 }

  // exhaust: 0 = all engine, 1 = all exhaust (only with both groups).
  // shifting, gear, limiter: the model's gearbox and limiter (rev-model.js),
  // for the one-shots.
  set({ rpm, load, gain, exhaust, shifting, gear, limiter }) {
    if (Number.isFinite(rpm)) this.rpmTarget = Math.max(100, rpm)
    if (Number.isFinite(load)) this.loadTarget = clamp(load, -1, 1)
    if (Number.isFinite(gain)) this.gainTarget = clamp(gain, 0, 1)
    if (Number.isFinite(exhaust)) this.exhaust = clamp(exhaust, 0, 1)
    if (typeof limiter === 'boolean') this.limiter = limiter
    if (Number.isFinite(load) && load > 0) this.pushAt = this.t
    if (Number.isFinite(gear)) {
      // An upshift (the gear going up while the gearbox says it is
      // shifting) under load: the shift clip.
      if (gear > this.gear && this.gear >= 1 && shifting && this.shifts.length && this.driveLoad >= SHIFT_LOAD) this.startShift()
      this.gear = gear
    }
    if (typeof shifting === 'boolean') this.shifting = shifting
    if (!this.shifting && Number.isFinite(load)) this.driveLoad = load
  }

  // The clip of each group recorded nearest the rpm the shift starts from.
  startShift() {
    const byGroup = {}
    for (const c of this.shifts) {
      const b = byGroup[c.group]
      if (!b || Math.abs(Math.log(c.from / this.rpm)) < Math.abs(Math.log(b.from / this.rpm))) byGroup[c.group] = c
    }
    const t0 = Math.max(0, (Object.values(byGroup)[0].at ?? 0.1) - SHIFT_LEAD)
    for (const c of this.shifts) { c.w = 0; c.wTarget = 0; c.pos = t0 * c.sr }
    this.shot = { clips: Object.values(byGroup), t0 }
  }

  // How loud each group plays. The groups' loops start at different points,
  // so they add up incoherently: an equal-power crossfade keeps the level
  // steady across the setting.
  groupGain(name) {
    if (!(this.groups.engine && this.groups.exhaust)) return 1
    const m = this.exhaust ?? 0.5
    return name === 'exhaust' ? Math.sqrt(m) : name === 'engine' ? Math.sqrt(1 - m) : 0
  }

  // groupGain for a limiter loop or shift clip. The rev loops of the two
  // groups start at unrelated places, so they add up as unrelated sounds;
  // these play in step, and add up partly coherently (corr: their
  // correlation in step, rev-samples.js), which would make the middle of
  // the Exhaust setting up to 3 dB louder. This takes that back out.
  inStep(l) {
    const gg = this.groupGain(l.group)
    if (!(this.groups.engine && this.groups.exhaust) || !l.corr) return gg
    const m = this.exhaust ?? 0.5
    return gg / Math.sqrt(Math.max(0.25, 1 + 2 * l.corr * Math.sqrt(m * (1 - m))))
  }

  // The weight every loop should have now.
  targets() {
    const rpm = this.rpm
    const on = onLoadMix(this.load)
    const amp = this.amp
    for (const [name, g] of Object.entries(this.groups)) {
      const gg = this.groupGain(name)
      if (g.part) {
        throttleMix(throttlePlace(this.load), amp)
        for (const [k, ls] of Object.entries(g.layers)) {
          const w = pairWeights(ls, rpm, g.weights[k])
          const m = k === 'off' ? amp[0] : k === 'part' ? amp[1] : k === 'on' ? amp[2] : 0
          ls.forEach((l, i) => { l.wTarget = w[i] * m * gg })
        }
        if (g.partIdle) {
          const w = g.partIdle.wTarget
          g.partIdle.wTarget = 0
          g.idleOn.wTarget += w * Math.sqrt(on)
          g.idleOff.wTarget += w * Math.sqrt(1 - on)
        }
      } else if (g.split) {
        for (const [k, ls] of Object.entries(g.layers)) {
          const w = pairWeights(ls, rpm, g.weights[k])
          const m = k === 'on' ? on : k === 'off' ? 1 - on : 0
          ls.forEach((l, i) => { l.wTarget = w[i] * Math.sqrt(m) * gg })
        }
      } else {
        const w = pairWeights(g.loops, rpm, g.allW)
        g.loops.forEach((l, i) => { l.wTarget = w[i] * gg })
      }
    }
    // The limiter loop or a shift clip takes over from the rev loops, with
    // equal power (never both: the limiter is parked, shifts are driving).
    // The rev loops play on underneath at their own weights, and their sum
    // is turned down by `keep` (render), so how loud they are can still be
    // measured while a one-shot covers them.
    this.keepTarget = Math.sqrt(1 - Math.max(this.lim, this.shotMix))
    const match = this.match
    for (const l of this.limiters) l.wTarget = Math.sqrt(this.lim) * this.inStep(l) * match
    const clips = this.shot ? this.shot.clips : []
    for (const c of this.shifts) c.wTarget = clips.includes(c) ? Math.sqrt(this.shotMix) * this.inStep(c) * match : 0
  }

  // Per block: the limiter's crossfade, and where a shift clip is.
  oneShots(n) {
    if (this.limiters.length) {
      const want = this.limiter && this.t - this.pushAt < this.limCut + LIMITER_HOLD ? 1 : 0
      this.lim += (want - this.lim) * (1 - Math.exp(-n / (LIMITER_TAU * this.sr)))
      if (!want && this.lim < 1e-4) this.lim = 0
    }
    if (this.shot) {
      // Where the clip will be at the end of this block (the weights ramp
      // to their targets across it); faded out SHIFT_END s before its last
      // sample, so it never stops while heard.
      const c = this.shot.clips[0]
      const tau = (c.pos + 1.4 * n * (c.sr / this.sr)) / c.sr, end = c.data.length / c.sr - SHIFT_END
      if (c.pos / c.sr >= end) { this.shot = null; this.shotMix = 0 }
      else this.shotMix = clamp(Math.min(1, (tau - this.shot.t0) / SHIFT_IN, (end - tau) / SHIFT_OUT), 0, 1)
    } else this.shotMix = 0
  }

  render(outs, n) {
    if (!this.loops.length) { for (const o of outs) o.fill(0, 0, n); return }
    const sr = this.sr
    const kRpm = 1 - Math.exp(-1 / (0.015 * sr))
    const kGain = 1 - Math.exp(-1 / (0.05 * sr))
    // Per block: where the crossfade is heading; ramped per sample below so
    // a block boundary never clicks.
    const rpm0 = this.rpm
    this.rpm += (this.rpmTarget - this.rpm) * (1 - Math.pow(1 - kRpm, n))
    this.load += (this.loadTarget - this.load) * (1 - Math.pow(1 - kRpm, n))
    if (this.limiters.length || this.shifts.length) this.oneShots(n)
    this.targets()
    // With a single layer, load opens a tone filter and raises the level,
    // the way a real engine gets louder and brighter on the throttle.
    const pos = Math.max(0, this.load)
    const level = this.split ? 1 : 0.6 + 0.4 * pos + (this.load < 0 ? -0.1 * this.load : 0)
    const cut = this.split ? 1 : 0.18 + 0.82 * Math.min(1, 0.35 + pos)
    const a = clamp(cut, 0.02, 1)
    // The rpm's loudness, ramped across the block like the rpm.
    const loud0 = rpmLoudness(rpm0, this.idleRpm, this.topRpm, this.quiet)
    const dLoud = (rpmLoudness(this.rpm, this.idleRpm, this.topRpm, this.quiet) - loud0) / n

    if (this.rr.length < n) { this.rr = new Float64Array(n); this.mix = new Float64Array(n) }
    const rr = this.rr, mix = this.mix
    for (let i = 0; i < n; i++) { rr[i] = rpm0 + (this.rpm - rpm0) * (i / n); mix[i] = 0 }
    // One loop at a time, each sample's sum built in the same order as
    // ever (loop by loop), so the sound is the same to the bit. Every rev
    // loop advances, heard or not, so its phase stays continuous; one not
    // heard all block is only advanced.
    for (const l of this.loops) {
      const dw = (l.wTarget - l.w) / n, ratio = l.sr / sr, d = l.data, len = d.length, lr = l.rpm
      let w = l.w, p = l.pos
      if (w < HEARD * 0.999 && l.wTarget < HEARD * 0.999) {
        for (let i = 0; i < n; i++) {
          w += dw
          p += clamp(rr[i] / lr, 1 / MAX_RATE, MAX_RATE) * ratio
          if (p >= len) p -= len
        }
      } else {
        const g = l.gain
        for (let i = 0; i < n; i++) {
          w += dw
          const rate = clamp(rr[i] / lr, 1 / MAX_RATE, MAX_RATE) * ratio
          if (w > HEARD) {
            const k = Math.floor(p), f = p - k
            const v = d[k] + (d[k + 1 < len ? k + 1 : 0] - d[k]) * f
            mix[i] += v * w * g
          }
          p += rate
          if (p >= len) p -= len
        }
      }
      l.w = w; l.pos = p
    }
    // The one-shots' level match. The rev loops' levels are set for loops
    // that add up as unrelated sounds, but the two pitched to one rpm, and
    // the engine and exhaust loops of one run, line their firing up more or
    // less depending on where each started: the mix comes out up to ~4 dB
    // off its levels, differently at every rpm. A limiter loop or shift
    // clip at its nominal level would then come in louder or quieter than
    // the loops it takes over from. So: how loud the rev loops actually are
    // against how loud their levels say (followed over ~0.1 s while they
    // are what is heard), and the one-shots play by the same factor.
    if (this.limiters.length || this.shifts.length) {
      let nom = 0, act = 0
      for (const l of this.loops) if (l.w > HEARD) nom += l.w * l.w * l.gain * l.gain * l.rms2
      if (nom > 1e-10) {
        for (let i = 0; i < n; i++) act += mix[i] * mix[i]
        const r = clamp(Math.sqrt(act / n / nom), 0.4, 2.5)
        this.match += (r - this.match) * (1 - Math.exp(-n / (MATCH_TAU * sr)))
      }
      // Under a one-shot, the rev loops' sum turned down (equal power).
      const k0 = this.keep ?? 1, k1 = this.keepTarget
      if (k0 !== 1 || k1 !== 1) for (let i = 0; i < n; i++) mix[i] *= k0 + (k1 - k0) * (i / n)
      this.keep = k1
    }
    // The limiter loops, at their own pitch; nothing to do while unheard.
    for (const l of this.limiters) {
      if (l.w < HEARD && l.wTarget < HEARD) { l.w = l.wTarget; continue }
      const dw = (l.wTarget - l.w) / n, rate = l.sr / sr, d = l.data, len = d.length, g = l.gain
      let w = l.w, p = l.pos
      for (let i = 0; i < n; i++) {
        w += dw
        const k = Math.floor(p), f = p - k
        mix[i] += (d[k] + (d[k + 1 < len ? k + 1 : 0] - d[k]) * f) * w * g
        p += rate
        if (p >= len) p -= len
      }
      l.w = w; l.pos = p
    }
    // A shift clip, once through, pitched so the revs it was recorded at
    // follow the model's: rate = rpm now / the clip's rpm (shiftRpm in
    // rev-samples.js), within 0.7-1.4.
    if (this.shot) {
      for (const c of this.shot.clips) {
        const dw = (c.wTarget - c.w) / n, ratio = c.sr / sr, d = c.data, len = d.length, g = c.gain
        const c0 = clipRpm(c, c.pos / c.sr)
        const c1 = clipRpm(c, (c.pos + n * ratio * rr[n - 1] / c0) / c.sr)
        let w = c.w, p = c.pos
        for (let i = 0; i < n && p < len - 1; i++) {
          w += dw
          const k = Math.floor(p), f = p - k
          mix[i] += (d[k] + (d[k + 1] - d[k]) * f) * w * g
          p += clamp(rr[i] / (c0 + (c1 - c0) * (i / n)), 0.7, 1.4) * ratio
        }
        c.w = w; c.pos = p
      }
    }

    const out0 = outs[0]
    for (let i = 0; i < n; i++) {
      this.gain += (this.gainTarget - this.gain) * kGain
      this.lp += (mix[i] - this.lp) * a
      out0[i] = clamp(this.lp * level * this.gain * (loud0 + dLoud * i), -1, 1)
    }
    for (let c = 1; c < outs.length; c++) outs[c].set(out0.subarray(0, n))
    this.t += n / sr
  }
}

// The rpm a shift clip was recorded at, t s into it: held at `from` until
// the cut at `at`, then falling to `to` with the model gearbox's time
// constants (rev-model.js Gearbox: SHIFT_TAU while shifting, SHIFT_AFTER
// once in gear), as es-render's shift mode drives its dyno.
export const SHIFT_TAU = 0.06, SHIFT_AFTER = 0.12
export function clipRpm(c, t) {
  const u = t - (c.at ?? 0.1), cut = c.cut ?? 0.14
  if (u < 0) return c.from
  const d = c.from - c.to
  if (u < cut) return c.to + d * Math.exp(-u / SHIFT_TAU)
  return c.to + d * Math.exp(-cut / SHIFT_TAU) * Math.exp(-(u - cut) / SHIFT_AFTER)
}
