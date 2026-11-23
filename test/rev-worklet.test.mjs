// Offline renders of the engine synthesiser (static/rev-worklet.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EngineVoice } from '../static/rev-worklet.js'
import { PROFILES } from '../static/rev-profiles.js'

const SR = 48000

// Render `seconds` at a fixed rpm/load after a settling period.
function render(profile, { rpm, load, gain = 1, seconds = 1, seed = 3, settle = 0.3 }) {
  const v = new EngineVoice(SR, seed)
  v.setProfile(profile)
  v.rpm = rpm; v.load = load; v.gain = gain
  v.set({ rpm, load, gain })
  const L = new Float32Array(128), R = new Float32Array(128)
  for (let i = 0; i < Math.round(settle * SR / 128); i++) v.render([L, R], 128)
  v.firings = 0
  const blocks = Math.round(seconds * SR / 128)
  const out = new Float32Array(blocks * 128)
  for (let b = 0; b < blocks; b++) { v.render([L, R], 128); out.set(L, b * 128) }
  return { out, firings: v.firings, voice: v }
}
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length)

for (const [name, p] of Object.entries(PROFILES)) {
  test(`${name}: fires each cylinder once per two revolutions`, () => {
    for (const rpm of [p.idle, 3000, p.redline]) {
      const { firings } = render(p, { rpm, load: 0.5 })
      const want = rpm / 120 * p.cylinders.length
      assert.ok(Math.abs(firings - want) <= 1, `${rpm} rpm: ${firings} firings, want ${want}`)
    }
  })

  test(`${name}: output is finite, bounded, audible at idle, and louder under load`, () => {
    const idle = render(p, { rpm: p.idle, load: 0 }).out
    const pull = render(p, { rpm: 4000, load: 1 }).out
    for (const a of [idle, pull]) {
      for (const x of a) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1)
    }
    assert.ok(rms(idle) > 0.005, `idle rms ${rms(idle)}`)
    assert.ok(rms(pull) > 2.5 * rms(idle), `pull ${rms(pull)} vs idle ${rms(idle)}`)
  })
}

test('the note repeats at the firing interval of an even-fire engine', () => {
  // Inline six at 3000 rpm fires 150 times a second: every 320 samples.
  const { out } = render(PROFILES.i6, { rpm: 3000, load: 0.7, seconds: 0.5 })
  const ac = (lag) => {
    let s = 0, e = 0
    for (let i = 0; i + lag < out.length; i++) { s += out[i] * out[i + lag]; e += out[i] * out[i] }
    return s / e
  }
  assert.ok(ac(320) > 0.6, `at the firing period ${ac(320)}`)
  assert.ok(ac(320) > ac(160) + 0.3, `at half the period ${ac(160)}`)
})

test('overrun pops appear only when lifting off at speed', () => {
  const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
  const lift = render(PROFILES.flat4, { rpm: 5000, load: -1, seconds: 2 }).out
  const cruise = render(PROFILES.flat4, { rpm: 5000, load: 0, seconds: 2 }).out
  assert.ok(peak(lift) > 2 * peak(cruise), `lift ${peak(lift)} cruise ${peak(cruise)}`)
})

test('zero gain is silence', () => {
  const { out } = render(PROFILES.v8, { rpm: 3000, load: 1, gain: 0 })
  assert.ok(out.every((x) => x === 0))
})

test('the same seed renders the same sound', () => {
  const a = render(PROFILES.v8, { rpm: 2500, load: 0.4, seed: 9 }).out
  const b = render(PROFILES.v8, { rpm: 2500, load: 0.4, seed: 9 }).out
  assert.deepEqual(a, b)
})

test('changing engine and rpm mid-stream stays clean', () => {
  const v = new EngineVoice(SR, 1)
  v.setProfile(PROFILES.v8)
  const L = new Float32Array(128), R = new Float32Array(128)
  const names = Object.keys(PROFILES)
  for (let b = 0; b < 2000; b++) {
    if (b % 250 === 0) v.setProfile(PROFILES[names[(b / 250) % names.length]])
    v.set({ rpm: 800 + (b % 400) * 20, load: Math.sin(b / 50), gain: 1 })
    v.render([L, R], 128)
    for (const x of L) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1)
  }
})

test('a voice with no engine chosen yet is silent', () => {
  const v = new EngineVoice(SR)
  const L = new Float32Array(128).fill(1)
  v.render([L], 128)
  assert.ok(L.every((x) => x === 0))
})
