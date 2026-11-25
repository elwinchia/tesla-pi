// The loudness stage (static/rev-loudness.js): compressor, make-up, the
// Volume slider and the peak limiter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Loudness, LOUDNESS, BUILD, TONE, compGainDb, buildDb, drive } from '../static/rev-loudness.js'

const SR = 48000

// A sine at `amp` through a Loudness at `volume` for `secs`; the last
// quarter's RMS in dBFS and its peak.
function through(amp, volume, secs = 1, hz = 90, engine = null) {
  const ld = new Loudness(SR)
  ld.set({ volume }); ld.vol = ld.volTarget
  if (engine) { ld.set({ idle: 1000, redline: 7000, ...engine }); ld.build = ld.buildTarget }
  const n = 128, L = new Float32Array(n), R = new Float32Array(n)
  let ph = 0, ss = 0, cnt = 0, peak = 0
  const blocks = Math.round((secs * SR) / n)
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < n; i++) { L[i] = R[i] = amp * Math.sin(ph); ph += (2 * Math.PI * hz) / SR }
    ld.process([L, R], n)
    if (b > blocks * 0.75) for (let i = 0; i < n; i++) { ss += L[i] * L[i]; cnt++; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])) }
  }
  return { db: 10 * Math.log10(ss / cnt), peak, ld }
}
const sineRms = (amp) => 20 * Math.log10(amp / Math.SQRT2)

test('quiet sounds get the whole make-up; loud ones are compressed', () => {
  assert.equal(compGainDb(-60), LOUDNESS.makeup)
  // Well above the threshold the gain falls 1 - 1/ratio dB for every dB more.
  const a = compGainDb(-10), b = compGainDb(-5)
  assert.ok(Math.abs((a - b) - 5 * (1 - 1 / LOUDNESS.ratio)) < 1e-9)
  // The knee is smooth: no step in gain across it.
  for (let l = LOUDNESS.threshold - 10; l < LOUDNESS.threshold + 10; l += 0.1) {
    assert.ok(Math.abs(compGainDb(l) - compGainDb(l + 0.1)) < 0.1)
  }
  // An idle 20 dB under a hard pull comes out closer to it, not further.
  const idle = through(0.01, 1), pull = through(0.1, 1)
  const inGap = sineRms(0.1) - sineRms(0.01), outGap = pull.db - idle.db
  assert.ok(outGap < inGap - 4 && outGap > 4, `gap ${outGap.toFixed(1)} dB from ${inGap.toFixed(1)}`)
})

test('the Volume slider turns everything down evenly (squared), after the compressor', () => {
  const full = through(0.05, 1), half = through(0.05, 0.5)
  assert.ok(Math.abs((full.db - half.db) - 20 * Math.log10(4)) < 0.3, `${(full.db - half.db).toFixed(2)} dB`)
  assert.ok(through(0.05, 0).db < -100)
})

test('nothing goes over the ceiling, however hot the input', () => {
  for (const amp of [0.5, 1]) {
    const r = through(amp, 1)
    assert.ok(r.peak <= LOUDNESS.ceiling + 1e-6, `peak ${r.peak}`)
    assert.ok(r.ld.limited > 0)
  }
  // At an ordinary level the limiter stays out of it.
  assert.equal(through(0.02, 1).ld.limited, 0)
})

test('silence stays silence', () => {
  const r = through(0, 1)
  assert.equal(r.peak, 0)
})

test('the build: a hard pull is left alone, the idle comes down, a cruise between', () => {
  assert.equal(buildDb(1, 1), -0)
  assert.equal(buildDb(0, 0), -BUILD.depth)
  assert.equal(buildDb(-1, 0), -BUILD.depth, 'overrun at idle revs: all of it')
  const cruise = buildDb(0.15, 0.2)
  assert.ok(cruise < -1.5 && cruise > -4, `cruise ${cruise.toFixed(1)} dB`)
  for (let l = 0; l < 1; l += 0.1) for (let r = 0; r < 1; r += 0.1) {
    assert.ok(drive(l + 0.1, r) >= drive(l, r) && drive(l, r + 0.1) >= drive(l, r))
  }
  // Through the stage: the same input at idle and in a pull, BUILD.depth apart.
  const idle = through(0.05, 1, 1, 90, { rpm: 1000, load: 0 })
  const pull = through(0.05, 1, 1, 90, { rpm: 7000, load: 1 })
  assert.ok(Math.abs(pull.db - idle.db - BUILD.depth) < 0.3, `${(pull.db - idle.db).toFixed(2)} dB`)
  // Until the car's revs and load arrive it does nothing.
  assert.ok(Math.abs(through(0.05, 1).db - pull.db) < 0.1)
})

test('the tone: more bass and treble than the mids', () => {
  // Quiet tones (under the compressor), so only the tone tells them apart.
  const lo = through(0.003, 1, 1, 40).db, mid = through(0.003, 1, 1, 700).db, hi = through(0.003, 1, 1, 9000).db
  assert.ok(Math.abs(lo - mid - TONE.bass.db) < 1, `bass +${(lo - mid).toFixed(1)} dB`)
  assert.ok(Math.abs(hi - mid - TONE.treble.db) < 1, `treble +${(hi - mid).toFixed(1)} dB`)
})
