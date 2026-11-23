// node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpeedTracker, loadFromMotion, Gearbox, FreeRev, SimCar, CARS } from '../static/rev-model.js'
import { PROFILES } from '../static/rev-profiles.js'

const car = CARS.m3rwd
const kmh = (x) => x / 3.6

test('SpeedTracker estimates acceleration from 1 Hz fixes and carries it between them', () => {
  const tr = new SpeedTracker()
  for (let i = 0; i <= 4; i++) tr.push(i * 1000, 2 * i) // 2 m/s^2
  assert.ok(Math.abs(tr.accel - 2) < 1e-9)
  const mid = tr.at(4500)
  assert.ok(Math.abs(mid.v - 9) < 1e-9, `v=${mid.v}`)
  assert.equal(mid.stale, false)
  // Extrapolation is capped: a late fix must not fling the speed off.
  assert.ok(tr.at(5400).v <= 8 + 2 * 1.5 + 1e-9)
})

test('SpeedTracker goes stale without fixes and reads null speed as stopped', () => {
  const tr = new SpeedTracker()
  assert.equal(tr.at(0).stale, true)
  tr.push(0, null)
  assert.equal(tr.at(100).v, 0)
  tr.push(1000, 10)
  assert.equal(tr.at(6000).stale, true)
  assert.equal(tr.at(6000).a, 0)
})

test('SpeedTracker sees a lift-off within one fix', () => {
  const tr = new SpeedTracker()
  for (let i = 0; i <= 3; i++) tr.push(i * 1000, 10 + 3 * i) // pulling
  tr.push(4000, 18) // speed falls
  assert.ok(tr.accel < 0, `accel=${tr.accel}`)
})

test('SpeedTracker replaces a fix that arrives at the same instant', () => {
  const tr = new SpeedTracker()
  tr.push(0, 0); tr.push(1000, 5); tr.push(1000, 6)
  assert.equal(tr.fixes.length, 2)
  assert.equal(tr.fixes[1].v, 6)
})

test('loadFromMotion: cruise is light, a pull is heavy, braking is overrun', () => {
  assert.equal(loadFromMotion(0, 0, car), 0)
  const cruise = loadFromMotion(kmh(100), 0, car)
  assert.ok(cruise > 0.02 && cruise < 0.25, `cruise=${cruise}`)
  assert.ok(loadFromMotion(kmh(30), 4.5, car) > 0.85)
  assert.ok(loadFromMotion(kmh(60), -3, car) < -0.5)
  assert.equal(loadFromMotion(kmh(60), -20, car), -1)
  assert.equal(loadFromMotion(kmh(20), 50, car), 1)
})

function drive(profile, mode, speedAt, loadAt, seconds) {
  const gb = new Gearbox(profile, mode)
  const out = []
  const dt = 0.02
  for (let t = 0; t <= seconds * 1000; t += dt * 1000) out.push({ t, ...gb.step(t, speedAt(t), loadAt(t), dt) })
  return out
}

for (const [name, p] of Object.entries(PROFILES)) {
  test(`${name}: a full-throttle pull climbs the gears and never passes redline`, () => {
    const run = drive(p, 'normal', (t) => Math.min(kmh(220), t / 1000 * 4), () => 1, 20)
    let prev = 1
    for (const s of run) {
      assert.ok(s.gear >= prev, 'no downshift during a pull')
      prev = s.gear
      assert.ok(s.rpm <= p.redline + 1, `rpm ${s.rpm}`)
      assert.ok(s.rpm >= p.idle - 1)
    }
    assert.ok(prev >= 4, `reached gear ${prev}`)
  })

  test(`${name}: cruising at 100 km/h sits in a tall gear at a relaxed rpm`, () => {
    const run = drive(p, 'normal', (t) => Math.min(kmh(100), t / 1000 * 3), (t) => (t < 10000 ? 0.3 : 0.08), 25)
    const end = run[run.length - 1]
    assert.ok(end.gear >= p.gears.length - 2, `gear ${end.gear}`)
    assert.ok(end.rpm > p.idle && end.rpm < p.redline * 0.5, `rpm ${end.rpm}`)
  })
}

test('upshifts come later under load and later still in Sport', () => {
  const p = PROFILES.v8
  const firstShiftRpm = (mode, load) => {
    const run = drive(p, mode, (t) => t / 1000 * 3, () => load, 15)
    const i = run.findIndex((s) => s.gear === 2)
    return run[i - 1].rpm
  }
  const light = firstShiftRpm('normal', 0.2), heavy = firstShiftRpm('normal', 1)
  assert.ok(heavy > light + 1000, `light ${light} heavy ${heavy}`)
  assert.ok(firstShiftRpm('sport', 0.5) > firstShiftRpm('comfort', 0.5))
})

test('an upshift cuts the load briefly', () => {
  const run = drive(PROFILES.v8, 'normal', (t) => t / 1000 * 4, () => 1, 10)
  const i = run.findIndex((s) => s.gear === 2)
  assert.ok(run[i].shifting)
  assert.ok(run[i].load < 0)
  assert.ok(run[i + 20].load === 1, 'load returns after the shift')
})

test('slowing down shifts back down', () => {
  const up = (t) => Math.max(0, kmh(120) - t / 1000 * 4)
  const run = drive(PROFILES.i6, 'normal', (t) => (t < 30000 ? Math.min(kmh(120), t / 1000 * 3) : up(t - 30000)), (t) => (t < 30000 ? 0.4 : -0.4), 58)
  const top = Math.max(...run.map((s) => s.gear))
  assert.ok(run[run.length - 1].gear <= 2, `ended in ${run[run.length - 1].gear} from ${top}`)
})

test('FreeRev climbs to the limiter, bounces off it, and falls back to idle', () => {
  const p = PROFILES.v10
  const fr = new FreeRev(p)
  let max = 0, cuts = 0, wasCut = false
  for (let i = 0; i < 150; i++) {
    const s = fr.step(1, 0.02)
    max = Math.max(max, s.rpm)
    const cut = fr.cut > 0
    if (cut && !wasCut) cuts++
    wasCut = cut
  }
  assert.equal(max, p.redline)
  assert.ok(cuts >= 2, `limiter hit ${cuts} times`)
  for (let i = 0; i < 200; i++) fr.step(0, 0.02)
  assert.equal(fr.rpm, p.idle)
})

test('SimCar: a Model 3 RWD does 0-100 km/h in a believable time', () => {
  const sim = new SimCar(car)
  let t = 0
  while (sim.v < kmh(100) && t < 30) { sim.step(1, 0, 0.01); t += 0.01 }
  assert.ok(t > 4 && t < 9, `0-100 in ${t.toFixed(1)} s`)
  // and the pedal up slows it (one-pedal regen)
  const v = sim.v
  for (let i = 0; i < 100; i++) sim.step(0, 0, 0.01)
  assert.ok(sim.v < v - 1)
})

test('the gearbox does not hunt under a steady part-throttle pull or a steady cruise', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    for (const load of [0, 0.1, 0.5, 0.75, 0.9]) {
      for (const mode of ['comfort', 'normal', 'sport']) {
        // Slow climb through the whole speed range at a fixed load.
        const run = drive(p, mode, (t) => kmh(10) + t / 1000 * 1.5, () => load, 60)
        let changes = 0, dir = 0, reversals = 0
        for (let i = 1; i < run.length; i++) {
          const d = Math.sign(run[i].gear - run[i - 1].gear)
          if (!d) continue
          changes++
          if (dir && d !== dir) reversals++
          dir = d
        }
        assert.ok(reversals === 0, `${name} ${mode} load ${load}: ${reversals} reversals in ${changes} shifts`)
      }
    }
  }
})
