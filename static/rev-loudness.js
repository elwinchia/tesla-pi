// Loud enough to hear over the road, the last stage before the speakers.
//
// Measured with scripts/rev-render.mjs (drive scene, cabin on), the loops
// at the old full volume came out at -18 to -25 LUFS on a cruise and -25 to
// -29 at idle, against about -14 LUFS for streamed music and -8 to -10 for
// a loud master. In the car that meant turning the car's own volume up from
// a music setting of 25-30 % to 50-60 %. And what is quiet is also what
// the road hides: after the cabin filter the engine lives below ~600 Hz,
// where the tyres and the wind are.
//
//   in ──► compressor (brings a cruise and the idle up towards a hard pull,
//          ratio RATIO above THRESHOLD) ──► make-up gain ──► build (the
//          engine working: idle and a light cruise turned down, a pull
//          left alone) ──► volume (the page's slider, squared) ──► peak
//          limiter (no sample over the ceiling) ──► out
//
// The build: the compressor that makes an idle and a cruise loud enough
// also flattens a rev, so a pull was only about 4 dB over the idle where a
// real car's is 15-20. After the compressor, the build turns the sound
// down by up to BUILD.depth dB when the engine is not working, by how far
// it is from a hard pull (buildDb): all of it at idle, about half on a
// light cruise, nothing at full throttle. A pull stays as loud as before;
// the idle is what comes down, so a rev climbs about 9 dB over it.
//
// The volume comes after the compressor, so the slider turns the whole
// sound down evenly instead of the compressor partly undoing it. The
// limiter comes after the volume, so it only works near the top of the
// slider.
//
// Pure, like rev-cabin.js: the AudioWorklet runs it after the cabin, and
// scripts/rev-render.mjs and the tests run it offline.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
const dbToLin = (db) => Math.pow(10, db / 20)

export const LOUDNESS = {
  threshold: -30,  // dBFS of the detector's RMS where the compressor starts
  ratio: 2.5,
  knee: 8,         // dB, soft
  makeup: 16,      // dB
  attack: 0.02,    // s, the detector rising
  release: 0.35,   // s, the detector falling
  ceiling: 0.89,   // -1 dBFS: the limiter's most
  limRelease: 0.12, // s
  tauVolume: 0.05, // s, the slider's glide
}

// The build (above): depth, dB at idle; tau, s, how fast it follows.
// load counts most, the revs some.
export const BUILD = { depth: 5, rev: 0.3, tau: 0.2 }

// How hard the engine is working (0..1) at a load (-1..1) and rev, the
// share of the way from idle to the redline (0..1).
export function drive(load, rev) {
  return clamp(BUILD.rev * clamp(rev, 0, 1) + (1 - BUILD.rev) * Math.sqrt(clamp(load, 0, 1)), 0, 1)
}
// The build's gain, dB (-depth..0).
export function buildDb(load, rev) {
  return -BUILD.depth * (1 - drive(load, rev)) ** 2
}

// The compressor's gain, in dB, at a detector level in dBFS: a soft knee
// around the threshold, then 1/ratio above it, plus the make-up.
export function compGainDb(levelDb) {
  const { threshold: T, ratio: R, knee: W, makeup } = LOUDNESS
  const over = levelDb - T
  let gr = 0
  if (2 * over > W) gr = over * (1 - 1 / R)
  else if (2 * over > -W) gr = (1 - 1 / R) * (over + W / 2) ** 2 / (2 * W)
  return makeup - gr
}

export class Loudness {
  constructor(sampleRate) {
    this.sr = sampleRate
    this.env = 0            // the detector: mean square, followed
    this.vol = 0; this.volTarget = 0
    this.lim = 1            // the limiter's gain
    this.kAtt = 1 - Math.exp(-1 / (LOUDNESS.attack * sampleRate))
    this.kRel = 1 - Math.exp(-1 / (LOUDNESS.release * sampleRate))
    this.kLim = 1 - Math.exp(-1 / (LOUDNESS.limRelease * sampleRate))
    this.kVol = 1 - Math.exp(-1 / (LOUDNESS.tauVolume * sampleRate))
    this.limited = 0        // samples the limiter turned down (for the tests and the render)
    // The build: off (0 dB) until the car's load or rpm arrive.
    this.load = NaN; this.rpm = NaN; this.idle = 0; this.redline = 0
    this.build = 1; this.buildTarget = 1
    this.kBuild = 1 - Math.exp(-1 / (BUILD.tau * sampleRate))
  }
  // params: { volume (0..1, the page's slider; squared here), load, rpm },
  // and the car's { idle, redline } (its profile).
  set({ volume, load, rpm, idle, redline }) {
    if (Number.isFinite(volume)) this.volTarget = clamp(volume, 0, 1) ** 2
    if (Number.isFinite(idle) && Number.isFinite(redline)) { this.idle = idle; this.redline = redline }
    if (Number.isFinite(load)) this.load = load
    if (Number.isFinite(rpm)) this.rpm = rpm
    if (Number.isFinite(this.load) && Number.isFinite(this.rpm) && this.redline > this.idle) {
      this.buildTarget = dbToLin(buildDb(this.load, clamp((this.rpm - this.idle) / (this.redline - this.idle), 0, 1)))
    }
  }
  // Processes outs (channel arrays, the same signal on each or not) in place.
  process(outs, n) {
    const C = outs.length, ceil = LOUDNESS.ceiling
    let env = this.env, vol = this.vol, lim = this.lim, build = this.build
    // The compressor's gain changes slowly: work it out once per 16 frames.
    let g = dbToLin(compGainDb(10 * Math.log10(env + 1e-12)))
    for (let i = 0; i < n; i++) {
      let p = 0
      for (let c = 0; c < C; c++) { const x = outs[c][i]; p += x * x }
      p /= C
      env += (p - env) * (p > env ? this.kAtt : this.kRel)
      if ((i & 15) === 0) g = dbToLin(compGainDb(10 * Math.log10(env + 1e-12)))
      vol += (this.volTarget - vol) * this.kVol
      build += (this.buildTarget - build) * this.kBuild
      const k = g * build * vol
      // The limiter: down at once to hold the peak at the ceiling, back up
      // over limRelease.
      let peak = 0
      for (let c = 0; c < C; c++) { const a = Math.abs(outs[c][i]) * k; if (a > peak) peak = a }
      lim += (1 - lim) * this.kLim
      if (peak * lim > ceil) { lim = ceil / peak; this.limited++ }
      const kk = k * lim
      for (let c = 0; c < C; c++) outs[c][i] = clamp(outs[c][i] * kk, -1, 1)
    }
    this.env = env; this.vol = vol; this.lim = lim; this.build = build
  }
}
