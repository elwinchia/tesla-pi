// The recorded-engine player (static/rev-sampler.js), driven with synthetic
// loops so the tests need no audio files or decoder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SampleVoice, pairWeights, onLoadMix, MAX_RATE } from '../static/rev-sampler.js'

const SR = 48000
// A loop that is exactly `cycles` periods of a sine at `hz`: seamless.
function sineLoop(hz, cycles = 40, sr = SR) {
  const n = Math.round((cycles * sr) / hz)
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * i * cycles) / n)
  return d
}
function render(v, seconds, each) {
  const L = new Float32Array(128), R = new Float32Array(128)
  const out = new Float32Array(Math.round((seconds * SR) / 128) * 128)
  for (let b = 0; b < out.length / 128; b++) {
    if (each) each(b * 128 / SR)
    v.render([L, R], 128)
    out.set(L, b * 128)
    for (let i = 0; i < 128; i++) assert.equal(L[i], R[i])
  }
  return out
}
// Energy at one frequency (Goertzel), normalised.
function power(a, hz) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (const x of a) { const s0 = x + c * s1 - s2; s2 = s1; s1 = s0 }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (a.length * a.length)
}
function pitch(a) {
  let z = 0
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) z++
  return (z * SR) / a.length
}
const voice = (loops, params = {}) => {
  const v = new SampleVoice(SR)
  v.setSet({ loops })
  v.rpm = params.rpm ?? 1000; v.load = params.load ?? 0; v.gain = 1
  v.set({ rpm: params.rpm ?? 1000, load: params.load ?? 0, gain: 1 })
  return v
}

test('the two loops either side of the rpm share it with equal power', () => {
  const loops = [{ rpm: 1000 }, { rpm: 3000 }, { rpm: 6000 }]
  const w = new Float64Array(3)
  assert.deepEqual([...pairWeights(loops, 500, w)], [1, 0, 0])
  assert.deepEqual([...pairWeights(loops, 9000, w)], [0, 0, 1])
  assert.deepEqual([...pairWeights(loops, 3000, w)].map((x) => Math.round(x * 1e9) / 1e9), [0, 1, 0])
  for (const rpm of [1200, 2000, 2999, 3001, 4500, 5900]) {
    pairWeights(loops, rpm, w)
    assert.ok(Math.abs(w[0] ** 2 + w[1] ** 2 + w[2] ** 2 - 1) < 1e-9, `${rpm}`)
    assert.ok(w.filter((x) => x > 0).length <= 2)
  }
  pairWeights(loops, 2000, w)
  assert.ok(Math.abs(w[0] - w[1]) < 1e-9, 'halfway is half and half')
  assert.equal(pairWeights([], 2000, new Float64Array(0)).length, 0)
})

test('a loop recorded at one rpm is played at the pitch of the engine', () => {
  // A 100 Hz loop "recorded at 2000 rpm" played at 3000 rpm sounds at 150 Hz.
  const v = voice([{ rpm: 2000, data: sineLoop(100), sr: SR }], { rpm: 3000 })
  const out = render(v, 1)
  assert.ok(Math.abs(pitch(out) - 150) < 2, `pitch ${pitch(out)}`)
  // A loop at another sample rate is played at the right speed too.
  const w = voice([{ rpm: 2000, data: sineLoop(100, 40, 44100), sr: 44100 }], { rpm: 2000 })
  assert.ok(Math.abs(pitch(render(w, 1)) - 100) < 2)
})

test('between two loops both are heard, crossfaded', () => {
  const v = voice([{ rpm: 1000, data: sineLoop(110), sr: SR }, { rpm: 4000, data: sineLoop(170), sr: SR }], { rpm: 2500 })
  const out = render(v, 1)
  // At 2500 rpm the 1000 rpm loop is pitched to 275 Hz, the 4000 rpm one to
  // 106.25 Hz, and they are mixed half and half.
  const a = power(out, 275), b = power(out, 106.25)
  assert.ok(a > 0.01 && b > 0.01 && Math.abs(Math.log(a / b)) < 0.5, `${a} vs ${b}`)
})

test('a sweep through every loop has no clicks, and wraps seamlessly', () => {
  const loops = [800, 2000, 3500, 5000, 6500].map((rpm, i) => ({ rpm, data: sineLoop(60 + 15 * i, 7), sr: SR }))
  const v = voice(loops, { rpm: 800 })
  let worst = 0, prev = 0
  const out = render(v, 3, (t) => v.set({ rpm: 800 + (5700 * Math.min(t, 2.5)) / 2.5 }))
  for (let i = 1; i < out.length; i++) { worst = Math.max(worst, Math.abs(out[i] - prev)); prev = out[i] }
  // The fastest a 0.5-amplitude sine near 330 Hz can move between samples
  // is ~0.022; anything far above that is a click.
  assert.ok(worst < 0.05, `largest step ${worst}`)
  for (const x of out) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1)
})

test('pitch is limited past the last loop rather than running away', () => {
  const v = voice([{ rpm: 1000, data: sineLoop(100), sr: SR }], { rpm: 20000 })
  assert.ok(Math.abs(pitch(render(v, 1)) - 100 * MAX_RATE) < 3)
})

test('with on-load and off-load layers, load picks the layer', () => {
  const loops = [
    { rpm: 3000, layer: 'on', data: sineLoop(150), sr: SR },
    { rpm: 3000, layer: 'off', data: sineLoop(90), sr: SR },
  ]
  const pull = render(voice(loops, { rpm: 3000, load: 1 }), 0.5)
  const lift = render(voice(loops, { rpm: 3000, load: -0.6 }), 0.5)
  assert.ok(power(pull, 150) > 20 * power(pull, 90), 'pulling plays the on-load loop')
  assert.ok(power(lift, 90) > 20 * power(lift, 150), 'lifting plays the off-load loop')
  assert.equal(onLoadMix(-1), 0)
  assert.equal(onLoadMix(1), 1)
})

test('with one layer, load makes it louder', () => {
  const loops = [{ rpm: 3000, data: sineLoop(150), sr: SR }]
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length)
  const pull = rms(render(voice(loops, { rpm: 3000, load: 1 }), 0.5))
  const cruise = rms(render(voice(loops, { rpm: 3000, load: 0 }), 0.5))
  assert.ok(pull > cruise * 1.3, `${pull} vs ${cruise}`)
})

test('nothing loaded, bad loops or zero gain: silence', () => {
  const L = new Float32Array(128).fill(1)
  const v = new SampleVoice(SR)
  assert.equal(v.ready, false)
  v.render([L], 128)
  assert.ok(L.every((x) => x === 0))
  v.setSet({ loops: [{ rpm: 0, data: sineLoop(100), sr: SR }, { rpm: 1000, data: new Float32Array(0), sr: SR }, null] })
  assert.equal(v.ready, false)
  const z = voice([{ rpm: 1000, data: sineLoop(100), sr: SR }], { rpm: 1000 })
  z.gain = 0; z.set({ gain: 0 })
  assert.ok(render(z, 0.2).every((x) => x === 0))
  v.setSet(null)
  assert.equal(v.ready, false)
})

test('the exhaust setting crossfades the engine and exhaust groups', () => {
  const loops = [
    { rpm: 3000, layer: 'on', group: 'engine', data: sineLoop(150), sr: SR },
    { rpm: 3000, layer: 'off', group: 'engine', data: sineLoop(150), sr: SR },
    { rpm: 3000, layer: 'on', group: 'exhaust', data: sineLoop(90), sr: SR },
    { rpm: 3000, layer: 'off', group: 'exhaust', data: sineLoop(90), sr: SR },
  ]
  const mix = (exhaust) => {
    const v = voice(loops, { rpm: 3000, load: 1 })
    v.set({ exhaust }); v.exhaust = exhaust
    return render(v, 0.5)
  }
  const engine = mix(0), exhaust = mix(1), both = mix(0.5)
  assert.ok(power(engine, 150) > 100 * power(engine, 90), 'all engine')
  assert.ok(power(exhaust, 90) > 100 * power(exhaust, 150), 'all exhaust')
  const r = power(both, 150) / power(both, 90)
  assert.ok(r > 0.5 && r < 2, `half and half: ${r}`)
  // A car with only one group plays it whatever the setting.
  const solo = voice([{ rpm: 3000, data: sineLoop(150), sr: SR }], { rpm: 3000 })
  solo.set({ exhaust: 1 })
  assert.ok(power(render(solo, 0.3), 150) > 0.01)
})
