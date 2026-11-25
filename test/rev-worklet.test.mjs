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

// An even-fire inline six, to check the synthesiser itself.
const EVEN6 = {
  ...PROFILES.v8, lope: 0,
  cylinders: [1, 5, 3, 6, 2, 4].map((c, i) => ({ at: i / 6, bank: c <= 3 ? 0 : 1 })),
  banks: [
    [[135, 3.0, 0.85], [300, 4.0, 0.6], [700, 5.0, 0.36], [1850, 6.0, 0.16]],
    [[142, 3.0, 0.85], [315, 4.0, 0.6], [735, 5.0, 0.36], [1950, 6.0, 0.16]],
  ],
  pulseMs: 1.5,
}

test('the note repeats at the firing interval of an even-fire engine', () => {
  // Inline six at 3000 rpm fires 150 times a second: every 320 samples.
  const { out } = render(EVEN6, { rpm: 3000, load: 0.7, seconds: 0.5 })
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
  const lift = render(PROFILES.v8, { rpm: 5000, load: -1, seconds: 2 }).out
  const cruise = render(PROFILES.v8, { rpm: 5000, load: 0, seconds: 2 }).out
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

// ── Car sounds ──────────────────────────────────────────────────────────
test('every car sound is complete and has its own name', () => {
  const names = new Set()
  for (const [k, p] of Object.entries(PROFILES)) {
    for (const f of ['name', 'style', 'blurb']) assert.ok(typeof p[f] === 'string' && p[f].length > 1, `${k}.${f}`)
    names.add(p.name + ' ' + p.style)
    assert.ok(p.idle > 400 && p.idle < p.launch && p.launch < p.redline && p.redline <= 18000, k) // the F1 revs to 17,000
    assert.ok(p.limiter >= 30 && p.limiter <= 200, `${k} limiter`)
    for (let g = 1; g < p.gears.length; g++) assert.ok(p.gears[g] > p.gears[g - 1], `${k} gear ${g + 1}`)
    const ats = p.cylinders.map((c) => c.at)
    assert.equal(new Set(ats).size, ats.length, `${k}: two firings at one point`)
    for (const c of p.cylinders) {
      assert.ok(c.at >= 0 && c.at < 1, k)
      assert.ok(Number.isInteger(c.bank) && c.bank >= 0 && c.bank < p.banks.length && c.bank < 2, `${k} bank`)
    }
  }
  assert.equal(names.size, Object.keys(PROFILES).length)
  assert.ok(Object.keys(PROFILES).length >= 1)
})

test('a lumpy cam lopes at idle and smooths out with revs', () => {
  // Record the strength of every firing.
  const amps = (p, rpm) => {
    const v = new EngineVoice(SR, 5)
    v.setProfile(p)
    v.rpm = rpm; v.load = 0
    v.set({ rpm, load: 0, gain: 1 })
    const got = []
    const add = v.pulses.add.bind(v.pulses)
    v.pulses.add = (x, y, z) => { got.push(z); add(x, y, z) }
    const L = new Float32Array(128), R = new Float32Array(128)
    for (let i = 0; i < Math.round(3 * SR / 128); i++) v.render([L, R], 128)
    const m = got.reduce((a, b) => a + b, 0) / got.length
    return Math.sqrt(got.reduce((a, b) => a + (b - m) ** 2, 0) / got.length) / m
  }
  const v8Idle = amps(PROFILES.v8, PROFILES.v8.idle)
  const smooth = { ...PROFILES.v8, lope: 0 }
  const flatIdle = amps(smooth, smooth.idle)
  const v8High = amps(PROFILES.v8, PROFILES.v8.idle * 4)
  assert.ok(v8Idle > 2 * flatIdle, `V8 ${v8Idle.toFixed(3)} vs no lope ${flatIdle.toFixed(3)} at idle`)
  assert.ok(v8High < v8Idle / 2, `V8 at 4× idle ${v8High.toFixed(3)}`)
})
