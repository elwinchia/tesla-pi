// The engine sound controller's pure parts: settings and the Engine that
// turns speed fixes into rpm/load. The audio and GPS halves need a browser
// and are exercised by static/rev.html's simulator.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine, DEFAULTS, sanitise, loadSettings, saveSettings, STOPPED_MS } from '../static/rev-sound.js'
import { SimCar, CARS } from '../static/rev-model.js'
import { PROFILES } from '../static/rev-profiles.js'

function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }
}

test('engine sound is off by default', () => {
  assert.equal(DEFAULTS.enabled, false)
  assert.equal(loadSettings(memStorage()).enabled, false)
})

test('settings survive a round trip and garbage is replaced by defaults', () => {
  const st = memStorage()
  saveSettings({ enabled: true, volume: 0.3, profile: 'v10', mode: 'sport', car: 'm3p' }, st)
  assert.deepEqual(loadSettings(st), { enabled: true, volume: 0.3, profile: 'v10', mode: 'sport', car: 'm3p' })
  assert.deepEqual(sanitise({ enabled: 'yes', volume: 7, profile: 'toString', mode: 'warp', car: null }),
    { ...DEFAULTS, volume: 1 })
  assert.deepEqual(loadSettings(memStorage({ revSound: '{not json' })), DEFAULTS)
})

test('a browser that refuses storage still gets working defaults', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.deepEqual(loadSettings(broken), DEFAULTS)
  assert.equal(saveSettings({ volume: 0.2 }, broken).volume, 0.2)
})

// Drive the Engine the way RevSound does: 50 Hz ticks, speed fixes once a
// second from a simulated car.
function simulate(engine, script, seconds) {
  const sim = new SimCar(CARS.m3rwd)
  const out = []
  let lastFix = -Infinity
  for (let t = 0; t <= seconds * 1000; t += 20) {
    const { pedal = 0, brake = 0, rev = 0 } = script(t)
    const v = sim.step(pedal, brake, 0.02)
    if (t - lastFix >= 1000) { lastFix = t; engine.fix(t, v) }
    engine.setRev(rev)
    out.push({ t, simV: v, ...engine.step(t, 0.02) })
  }
  return out
}

test('a launch revs up through the gears, and the rpm never jumps between ticks', () => {
  const p = PROFILES.v8
  const run = simulate(new Engine({ ...DEFAULTS, profile: 'v8' }), () => ({ pedal: 1 }), 15)
  assert.ok(Math.max(...run.map((s) => s.gear)) >= 3)
  for (let i = 1; i < run.length; i++) {
    const d = Math.abs(run[i].rpm - run[i - 1].rpm)
    assert.ok(d < p.redline * 0.25, `jump of ${d} rpm at ${run[i].t} ms`)
  }
  assert.ok(run.some((s) => s.load > 0.8), 'a full pedal reads as heavy load')
})

test('the engine follows the car within a couple of fixes', () => {
  const run = simulate(new Engine(DEFAULTS), () => ({ pedal: 0.6 }), 10)
  const end = run[run.length - 1]
  assert.ok(Math.abs(end.v - end.simV) < 2.5, `engine thinks ${end.v}, car is at ${end.simV}`)
})

test('lifting off after a pull reads as overrun', () => {
  const run = simulate(new Engine(DEFAULTS), (t) => ({ pedal: t < 8000 ? 1 : 0 }), 12)
  assert.ok(run.filter((s) => s.t > 9500).some((s) => s.load < -0.2))
})

test('Rev works only while stopped', () => {
  const p = PROFILES.v8
  const parked = simulate(new Engine(DEFAULTS), () => ({ rev: 1 }), 2)
  assert.ok(Math.max(...parked.map((s) => s.rpm)) > p.redline * 0.95, 'revs to the limiter parked')

  // Moving at a steady speed with Rev held: the engine must ignore it.
  const e = new Engine(DEFAULTS)
  for (let t = 0; t <= 5000; t += 20) {
    if (t % 1000 === 0) e.fix(t, 15)
    e.setRev(1)
    e.step(t, 0.02)
  }
  assert.ok(e.state.v > STOPPED_MS)
  assert.ok(e.state.rpm < p.redline * 0.6, `rpm ${e.state.rpm} while moving with Rev held`)
})

test('changing engine and gearbox on the fly takes effect', () => {
  const e = new Engine(DEFAULTS)
  e.configure({ ...DEFAULTS, profile: 'v10', mode: 'sport' })
  assert.equal(e.profile, PROFILES.v10)
  e.step(0, 0.02)
  assert.ok(e.state.rpm >= PROFILES.v10.idle * 0.7)
})
