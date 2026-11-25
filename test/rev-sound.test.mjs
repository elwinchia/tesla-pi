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

test('engine sound is off by default: the Tesla, which is silent', () => {
  assert.equal(DEFAULTS.profile, 'tesla')
  assert.ok(PROFILES.tesla.silent)
  assert.equal(loadSettings(memStorage()).profile, 'tesla')
  assert.ok(!('enabled' in DEFAULTS), 'no Play while driving setting')
})

test('settings saved with the old Play while driving: off is the Tesla, on keeps the car', () => {
  assert.equal(loadSettings(memStorage({ revSound: JSON.stringify({ enabled: false, profile: 'lfa' }) })).profile, 'tesla')
  assert.equal(loadSettings(memStorage({ revSound: JSON.stringify({ enabled: true, profile: 'lfa' }) })).profile, 'lfa')
  assert.ok(!('enabled' in loadSettings(memStorage({ revSound: JSON.stringify({ enabled: true }) }))))
})

test('settings survive a round trip and garbage is replaced by defaults', () => {
  const st = memStorage()
  const mine = { volume: 0.3, profile: 'v8', mode: 'sport', car: 'm3p', exhaust: 0.8, cabin: false, gauge: 'twin',
    engineSim: 'live', liveQuality: 0.5, denseRpm: true, partThrottle: true, oneShots: true, longLoops: true }
  saveSettings(mine, st)
  assert.deepEqual(loadSettings(st), mine)
  assert.deepEqual(sanitise({ enabled: 'yes', volume: 7, profile: 'toString', mode: 'warp', car: null, exhaust: 3, cabin: 'no', gauge: 'toString',
    engineSim: 'wasm', liveQuality: 0.3, denseRpm: 1, partThrottle: 'yes', oneShots: null, longLoops: {} }),
    { ...DEFAULTS, volume: 1, exhaust: 1 })
  assert.equal(DEFAULTS.gauge, 'segment', 'the segment arc unless another style is picked')
  assert.equal(DEFAULTS.exhaust, 0.5, 'engine and exhaust half and half by default')
  assert.equal(DEFAULTS.cabin, true, 'heard from the driver\'s seat by default')
  assert.equal(DEFAULTS.engineSim, 'recorded', 'the recorded mix unless live is chosen')
  for (const k of ['denseRpm', 'partThrottle', 'oneShots', 'longLoops']) assert.equal(DEFAULTS[k], false, k + ' off by default: the mix as it was')
  // A car that was removed (the owner had picked one) falls back to the default.
  assert.equal(sanitise({ profile: 'flat6' }).profile, DEFAULTS.profile)
  assert.deepEqual(loadSettings(memStorage({ revSound: '{not json' })), DEFAULTS)
})

test('a browser that refuses storage still gets working defaults', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.deepEqual(loadSettings(broken), DEFAULTS)
  assert.equal(saveSettings({ volume: 0.2 }, broken).volume, 0.2)
})

// The engine tests drive a V8 (the default, the Tesla, has no engine).
const V8 = { ...DEFAULTS, profile: 'v8' }

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
  const run = simulate(new Engine(V8), () => ({ pedal: 0.6 }), 10)
  const end = run[run.length - 1]
  assert.ok(Math.abs(end.v - end.simV) < 2.5, `engine thinks ${end.v}, car is at ${end.simV}`)
})

test('lifting off after a pull reads as overrun', () => {
  const run = simulate(new Engine(V8), (t) => ({ pedal: t < 8000 ? 1 : 0 }), 12)
  assert.ok(run.filter((s) => s.t > 9500).some((s) => s.load < -0.2))
})

test('Rev works only while stopped', () => {
  const p = PROFILES.v8
  const parked = simulate(new Engine(V8), () => ({ rev: 1 }), 2)
  assert.ok(Math.max(...parked.map((s) => s.rpm)) > p.redline * 0.95, 'revs to the limiter parked')

  // Moving at a steady speed with Rev held: the engine must ignore it.
  const e = new Engine(V8)
  for (let t = 0; t <= 5000; t += 20) {
    if (t % 1000 === 0) e.fix(t, 15)
    e.setRev(1)
    e.step(t, 0.02)
  }
  assert.ok(e.state.v > STOPPED_MS)
  assert.ok(e.state.rpm < p.redline * 0.6, `rpm ${e.state.rpm} while moving with Rev held`)
})

test('changing the gearbox mode on the fly takes effect', () => {
  const e = new Engine(V8)
  e.configure({ ...V8, mode: 'sport' })
  assert.equal(e.settings.mode, 'sport')
  assert.equal(e.profile, PROFILES.v8)
  e.step(0, 0.02)
  assert.ok(e.state.rpm >= PROFILES.v8.idle * 0.7)
})

// ── Simulation mode is for a stopped car only ───────────────────────────
test('simulation mode turns on with no speed reading yet, or when stopped', () => {
  const e = new Engine(V8)
  assert.equal(e.setSim(true, 0), true)
  assert.ok(e.touch(4000))
  for (let t = 0; t <= 300; t += 20) e.step(t, 0.02)
  assert.ok(Math.abs(e.state.rpm - 4000) < 200, `rpm ${e.state.rpm}`)
  assert.ok(e.state.sim && e.state.touching && e.state.stopped)

  const parked = new Engine(V8)
  parked.fix(0, 0); parked.fix(1000, null)
  assert.equal(parked.setSim(true, 1100), true)
})

test('simulation mode is refused while the car moves, or when its last reading was moving', () => {
  const e = new Engine(V8)
  e.fix(0, 12); e.fix(1000, 12)
  assert.equal(e.setSim(true, 1100), false)
  assert.equal(e.simEnded, 'moving')
  assert.equal(e.touch(5000), false, 'the finger is ignored outside simulation mode')
  // No readings for 10 s, but the last one was moving: still refused.
  assert.equal(e.setSim(true, 11000), false)
  assert.equal(e.blip(5000, 11000), false, 'no preview blip either')
})

test('simulation mode ends the moment the car moves, and the engine follows the car again', () => {
  const e = new Engine(V8)
  e.fix(0, 0)
  assert.ok(e.setSim(true, 0))
  e.touch(6000)
  let t = 0
  for (; t <= 1000; t += 20) e.step(t, 0.02)
  assert.ok(e.state.rpm > 5000)
  // The car pulls away: fixes of 0.5 then 3 m/s.
  e.fix(1000, 0.5)
  let ended = null
  for (let k = 1; k <= 3; k++) {
    e.fix(1000 + k * 1000, k * 1.5)
    for (let u = 0; u < 1000 && ended == null; u += 20) {
      e.step(t, 0.02)
      if (!e.state.sim) ended = t
      t += 20
    }
  }
  assert.ok(ended != null, 'simulation mode ended')
  assert.equal(e.state.simEnded, 'moving')
  assert.equal(e.state.touching, false)
  for (let u = 0; u < 1000; u += 20, t += 20) e.step(t, 0.02)
  assert.ok(e.state.gear >= 1 && !e.state.stopped, 'back to following the car')
  assert.ok(e.state.rpm < 4000, `rpm ${e.state.rpm} follows the car, not the old finger`)
  // And it cannot be turned back on while moving.
  assert.equal(e.setSim(true, t), false)
})

test('turning simulation mode off lets go of the finger', () => {
  const e = new Engine(V8)
  e.setSim(true, 0); e.touch(5000)
  e.setSim(false, 0)
  for (let t = 0; t <= 3000; t += 20) e.step(t, 0.02)
  assert.equal(e.state.rpm, PROFILES.v8.idle)
  assert.equal(e.state.sim, false)
})

test('every car sound can be chosen and is remembered', () => {
  for (const k of Object.keys(PROFILES)) {
    const st = memStorage()
    saveSettings({ ...DEFAULTS, profile: k }, st)
    assert.equal(loadSettings(st).profile, k)
  }
})

test('the engine always runs; the car picked decides its sound (the Tesla: none)', async () => {
  const { RevSound } = await import('../static/rev-sound.js')
  // Enough of a browser: no location (the engine still runs), no audio
  // until a tap brings it up (ensureAudio, stubbed).
  const saved = globalThis.document
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  const sent = []
  const states = []
  const rs = new RevSound({ storage: memStorage(), onState: (s) => states.push(s) })
  rs.ensureAudio = async () => {
    rs.ctx = { state: 'running', suspend: async () => {}, resume: async () => {} }
    rs.node = { port: { postMessage: (m) => sent.push(m) } }
  }
  try {
    rs.start()
    assert.ok(rs.running, 'running with no tap')
    assert.ok(states.at(-1).running && !states.at(-1).audible)
    // The Tesla (the default): a tap brings up no sound.
    await rs.startSound()
    assert.equal(rs.ctx, null)
    rs.tick()
    assert.ok(states.at(-1).running && !states.at(-1).audible && states.at(-1).electric)
    // An engine, and a tap: heard, the loops at full share.
    rs.update({ profile: 'v8' })
    await rs.startSound()
    assert.ok(rs.audible)
    rs.tick()
    assert.equal(sent.at(-1).params.gain, 1)
    // The Tesla again: silent, the worklet not handed its profile, and the
    // engine and its state run on.
    const before = sent.length
    rs.update({ profile: 'tesla' })
    assert.ok(!rs.audible && rs.running)
    assert.ok(!sent.slice(before).some((m) => m.profile), 'no profile for the worklet')
    rs.tick()
    assert.equal(sent.at(-1).params.gain, 0)
    assert.ok(states.at(-1).running && !states.at(-1).audible)
  } finally {
    clearInterval(rs.timer)
    globalThis.document = saved
  }
})

test('the Tesla: the rev meter shows the motor, 0 parked, with nothing to rev', () => {
  const e = new Engine({ ...DEFAULTS, profile: 'tesla' })
  const p = PROFILES.tesla
  // Parked, holding Rev: still 0; no blip, no simulation mode.
  const parked = simulate(e, () => ({ rev: 1 }), 2)
  assert.ok(parked.every((s) => s.rpm < 1))
  assert.equal(e.blip(5000, 3000), false)
  assert.equal(e.setSim(true, 3000), false)
  // Driving: the rpm follows the speed on one ratio, never past the redline.
  const run = simulate(new Engine({ ...DEFAULTS, profile: 'tesla' }), () => ({ pedal: 1 }), 20)
  for (const s of run.slice(-50)) {
    assert.ok(s.rpm <= p.redline + 1)
    assert.equal(s.gear, 1)
    const want = s.v * p.redline / p.gears[0]
    assert.ok(Math.abs(s.rpm - Math.min(want, p.redline)) < 0.1 * p.redline, `${s.rpm.toFixed(0)} rpm at ${(s.v * 3.6).toFixed(0)} km/h`)
  }
  // About 7,100 rpm at 100 km/h.
  const at100 = (100 / 3.6) * p.redline / p.gears[0]
  assert.ok(at100 > 6800 && at100 < 7400, at100.toFixed(0))
})
