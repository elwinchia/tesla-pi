// The engine as the driver hears it: through the car's body, not with a
// microphone at the engine and the tailpipe, which is where the loops are
// heard from (engine-sim's impulse responses, rev-samples.js).
//
// From inside, a combustion engine is mostly its firing note and the
// harmonics just above it. The firewall, floor, glass and sound deadening
// pass the low end almost whole, but lose more of every octave above about
// 500 Hz (a panel's transmission loss rises about 6 dB an octave, and the
// absorbers take more on top). So the rasp, valve tick and hiss that make a
// recording sound close, and outside, are a muffled hum in the cabin. Under
// load the intake roars through the bulkhead and more of the top comes
// through; on overrun the cabin hears little but the burble.
//
// High in the revs it opens up: a sporty car lets the intake and exhaust
// through (or plays them on its speakers), and the scream of a high-revving
// engine is its harmonics at 1-5 kHz. So with the revs the shelf grows
// shallow and the low-pass corner climbs, more under load than on overrun.
//
// And under load the body booms: the engine shakes the floor and the panels,
// and the cabin rings at 40-100 Hz. The speakers cannot shake the body, so
// a low shelf adds it, growing with the load. (The cabin's echo the real
// cabin supplies; adding it here would count it twice.)
//
//   in ──► low shelf (the boom, with load) ──► high shelf (the body,
//          opening up with load and revs) ──► low-pass (the deadening,
//          opening with the revs) ──► make-up gain ──► out
//
// Pure, like SampleVoice: the AudioWorklet runs it after the voice (the
// start and stop clips are fed through it too), and scripts/rev-render.mjs
// and the tests run it offline.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// shelf: where the body's loss starts, and how deep it is at a closed
// throttle (overrun, idle) and at full load. lowpass: the deadening's
// corner. open: high in the revs, the shelf's depth and the low-pass corner
// it opens to (from `from` of the way between idle and redline, all the way
// at the redline; on overrun `overrun` of that). boom: the low shelf's
// corner, and its lift with the throttle shut and at full load (the road
// hides the low end too, so a little even at idle). makeup: brings the level back to where
// the open sound was, on the demo drive (scripts/rev-render.mjs --scene
// demo), since most of the energy is in the low end the filter keeps.
export const CABIN = {
  shelf: { hz: 650, dbClosed: -11, dbFull: -6 },
  lowpass: { hz: 3200, q: 0.6 },
  open: { from: 0.25, shelfDb: -1.5, lowpassHz: 10000, overrun: 0.5 },
  boom: { hz: 110, dbClosed: 3, dbFull: 8 },
  makeup: 1.12,
  // How fast the filters follow the load and the revs (s), and the cabin
  // setting (s).
  tauLoad: 0.15, tauMix: 0.05,
}

// The shelf's depth at a load (-1..1): closed below zero, opening to full
// load.
export function shelfDb(load) {
  const { dbClosed, dbFull } = CABIN.shelf
  return dbClosed + (dbFull - dbClosed) * clamp(load, 0, 1)
}

// How far the top has opened (0..1) at `rev`, the share of the way from
// idle to the redline (0..1), and a load: none low in the revs, all of it
// at the redline under load, `overrun` of it with the throttle shut.
export function openness(rev, load) {
  const { from, overrun } = CABIN.open
  const k = clamp((rev - from) / (1 - from), 0, 1), sm = k * k * (3 - 2 * k)
  return sm * (overrun + (1 - overrun) * clamp(load, 0, 1))
}
// The filters' settings at a load and rev: the high shelf's depth (dB), the
// low-pass corner (Hz) and the boom's lift (dB).
export function cabinSettings(load, rev = 0) {
  const o = openness(rev, load), closed = shelfDb(load)
  return {
    shelfDb: closed + (CABIN.open.shelfDb - closed) * o,
    lowpassHz: CABIN.lowpass.hz * Math.pow(CABIN.open.lowpassHz / CABIN.lowpass.hz, o),
    boomDb: CABIN.boom.dbClosed + (CABIN.boom.dbFull - CABIN.boom.dbClosed) * clamp(load, 0, 1),
  }
}
// The share of the way from idle to the redline at an rpm.
export function revShare(rpm, idle, redline) {
  return redline > idle ? clamp((rpm - idle) / (redline - idle), 0, 1) : 0
}

// RBJ Audio EQ Cookbook coefficients, normalised by a0: [b0, b1, b2, a1, a2].
export function highShelf(f, db, sr) {
  const A = Math.pow(10, db / 40), w = 2 * Math.PI * f / sr
  const c = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, sa = 2 * Math.sqrt(A) * alpha // shelf slope S = 1
  const a0 = (A + 1) - (A - 1) * c + sa
  return [
    A * ((A + 1) + (A - 1) * c + sa) / a0, -2 * A * ((A - 1) + (A + 1) * c) / a0, A * ((A + 1) + (A - 1) * c - sa) / a0,
    2 * ((A - 1) - (A + 1) * c) / a0, ((A + 1) - (A - 1) * c - sa) / a0,
  ]
}
export function lowShelf(f, db, sr) {
  const A = Math.pow(10, db / 40), w = 2 * Math.PI * f / sr
  const c = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, sa = 2 * Math.sqrt(A) * alpha
  const a0 = (A + 1) + (A - 1) * c + sa
  return [
    A * ((A + 1) - (A - 1) * c + sa) / a0, 2 * A * ((A - 1) - (A + 1) * c) / a0, A * ((A + 1) - (A - 1) * c - sa) / a0,
    -2 * ((A - 1) + (A + 1) * c) / a0, ((A + 1) + (A - 1) * c - sa) / a0,
  ]
}
export function lowPass(f, q, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr
  const c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha
  return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0]
}

// |H| of a biquad at f, and of the whole cabin at a load and rev, in dB:
// for the tests and the docs.
export function biquadDb([b0, b1, b2, a1, a2], f, sr) {
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2)
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}
export function cabinDb(f, load = 0, rev = 0, sr = 48000) {
  const k = cabinSettings(load, rev)
  return biquadDb(lowShelf(CABIN.boom.hz, k.boomDb, sr), f, sr) +
    biquadDb(highShelf(CABIN.shelf.hz, k.shelfDb, sr), f, sr) +
    biquadDb(lowPass(k.lowpassHz, CABIN.lowpass.q, sr), f, sr) + 20 * Math.log10(CABIN.makeup)
}

// One channel's three biquads, transposed direct form II.
class Chain {
  constructor() { this.z = new Float64Array(6) }
  run(x, bm, sh, lp) {
    const z = this.z
    const y0 = bm[0] * x + z[0]
    z[0] = bm[1] * x - bm[3] * y0 + z[1]
    z[1] = bm[2] * x - bm[4] * y0
    const y1 = sh[0] * y0 + z[2]
    z[2] = sh[1] * y0 - sh[3] * y1 + z[3]
    z[3] = sh[2] * y0 - sh[4] * y1
    const y2 = lp[0] * y1 + z[4]
    z[4] = lp[1] * y1 - lp[3] * y2 + z[5]
    z[5] = lp[2] * y1 - lp[4] * y2
    return y2
  }
}

export class Cabin {
  constructor(sampleRate) {
    this.sr = sampleRate
    this.on = true; this.mix = 1
    this.load = 0; this.loadTarget = 0
    this.rev = 0; this.revTarget = 0
    this.rpm = NaN; this.idle = 0; this.redline = 0
    this.db = NaN; this.hz = NaN; this.boomDb = NaN
    this.chains = []
    this.shelf()
  }
  // params: { load, rpm, cabin } (the worklet's params; others are
  // ignored), and the car's { idle, redline } (its profile).
  set({ load, rpm, idle, redline, cabin }) {
    if (Number.isFinite(load)) this.loadTarget = clamp(load, -1, 1)
    if (Number.isFinite(idle) && Number.isFinite(redline)) { this.idle = idle; this.redline = redline }
    if (Number.isFinite(rpm)) this.rpm = rpm
    if (Number.isFinite(this.rpm)) this.revTarget = revShare(this.rpm, this.idle, this.redline)
    if (typeof cabin === 'boolean') this.on = cabin
  }
  // New coefficients only when a filter has moved enough to hear: small
  // steps in a direct-form biquad do not click.
  shelf() {
    const k = cabinSettings(this.load, this.rev)
    if (!(Math.abs(k.shelfDb - this.db) < 0.05)) { this.db = k.shelfDb; this.sh = highShelf(CABIN.shelf.hz, k.shelfDb, this.sr) }
    if (!(Math.abs(Math.log(k.lowpassHz / this.hz)) < 0.01)) { this.hz = k.lowpassHz; this.lp = lowPass(k.lowpassHz, CABIN.lowpass.q, this.sr) }
    if (!(Math.abs(k.boomDb - this.boomDb) < 0.05)) { this.boomDb = k.boomDb; this.bm = lowShelf(CABIN.boom.hz, k.boomDb, this.sr) }
  }
  // Filters outs (channel arrays) in place over n frames. The filters always
  // run, so turning the setting over crossfades instead of clicking.
  process(outs, n) {
    const sr = this.sr
    while (this.chains.length < outs.length) this.chains.push(new Chain())
    const kLoad = 1 - Math.exp(-n / (CABIN.tauLoad * sr))
    this.load += (this.loadTarget - this.load) * kLoad
    this.rev += (this.revTarget - this.rev) * kLoad
    this.shelf()
    const kMix = 1 - Math.exp(-1 / (CABIN.tauMix * sr))
    const target = this.on ? 1 : 0
    const m0 = this.mix
    for (let ch = 0; ch < outs.length; ch++) {
      const o = outs[ch], c = this.chains[ch]
      let m = m0
      for (let i = 0; i < n; i++) {
        m += (target - m) * kMix
        const x = o[i]
        const y = c.run(x, this.bm, this.sh, this.lp) * CABIN.makeup
        o[i] = clamp(x + (y - x) * m, -1, 1)
      }
      if (ch === outs.length - 1) this.mix = m
    }
  }
}
