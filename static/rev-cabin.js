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
// What it does not add: the cabin's own echo and booming. The speakers
// play inside the real cabin, which supplies both; adding them here would
// count them twice.
//
//   in ──► high shelf (the body, opening up with load) ──► low-pass (the
//          deadening) ──► make-up gain ──► out
//
// Pure, like SampleVoice: the AudioWorklet runs it after the voice (the
// start and stop clips are fed through it too), and scripts/rev-render.mjs
// and the tests run it offline.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// shelf: where the body's loss starts, and how deep it is at a closed
// throttle (overrun, idle) and at full load. lowpass: the deadening's
// corner. makeup: brings the level back to where the open sound was, on
// the demo drive (scripts/rev-render.mjs --scene demo), since most of the
// energy is in the low end the filter keeps.
export const CABIN = {
  shelf: { hz: 650, dbClosed: -11, dbFull: -6 },
  lowpass: { hz: 3200, q: 0.6 },
  makeup: 1.12,
  // How fast the shelf follows the load (s), and the cabin setting (s).
  tauLoad: 0.15, tauMix: 0.05,
}

// The shelf's depth at a load (-1..1): closed below zero, opening to full
// load.
export function shelfDb(load) {
  const { dbClosed, dbFull } = CABIN.shelf
  return dbClosed + (dbFull - dbClosed) * clamp(load, 0, 1)
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
export function lowPass(f, q, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr
  const c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha
  return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0]
}

// |H| of a biquad at f, and of the whole cabin at a load, in dB: for the
// tests and the docs.
export function biquadDb([b0, b1, b2, a1, a2], f, sr) {
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2)
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}
export function cabinDb(f, load = 0, sr = 48000) {
  return biquadDb(highShelf(CABIN.shelf.hz, shelfDb(load), sr), f, sr) +
    biquadDb(lowPass(CABIN.lowpass.hz, CABIN.lowpass.q, sr), f, sr) + 20 * Math.log10(CABIN.makeup)
}

// One channel's two biquads, transposed direct form II.
class Chain {
  constructor() { this.z = new Float64Array(4) }
  run(x, sh, lp) {
    const z = this.z
    const y1 = sh[0] * x + z[0]
    z[0] = sh[1] * x - sh[3] * y1 + z[1]
    z[1] = sh[2] * x - sh[4] * y1
    const y2 = lp[0] * y1 + z[2]
    z[2] = lp[1] * y1 - lp[3] * y2 + z[3]
    z[3] = lp[2] * y1 - lp[4] * y2
    return y2
  }
}

export class Cabin {
  constructor(sampleRate) {
    this.sr = sampleRate
    this.on = true; this.mix = 1
    this.load = 0; this.loadTarget = 0
    this.lp = lowPass(CABIN.lowpass.hz, CABIN.lowpass.q, sampleRate)
    this.db = NaN
    this.chains = []
    this.shelf()
  }
  // params: { load, cabin } (the worklet's params; others are ignored).
  set({ load, cabin }) {
    if (Number.isFinite(load)) this.loadTarget = clamp(load, -1, 1)
    if (typeof cabin === 'boolean') this.on = cabin
  }
  // New shelf coefficients only when its depth has moved enough to hear:
  // small steps in a direct-form biquad do not click.
  shelf() {
    const db = shelfDb(this.load)
    if (Math.abs(db - this.db) < 0.05) return
    this.db = db
    this.sh = highShelf(CABIN.shelf.hz, db, this.sr)
  }
  // Filters outs (channel arrays) in place over n frames. The filters always
  // run, so turning the setting over crossfades instead of clicking.
  process(outs, n) {
    const sr = this.sr
    while (this.chains.length < outs.length) this.chains.push(new Chain())
    this.load += (this.loadTarget - this.load) * (1 - Math.exp(-n / (CABIN.tauLoad * sr)))
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
        const y = c.run(x, this.sh, this.lp) * CABIN.makeup
        o[i] = clamp(x + (y - x) * m, -1, 1)
      }
      if (ch === outs.length - 1) this.mix = m
    }
  }
}
