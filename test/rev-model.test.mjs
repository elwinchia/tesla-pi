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
  if (p.turbine) continue // the jet: its own tests below
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

// ── A turbine (the jet): no gears, a spool that lags the throttle ─────────
for (const [name, p] of Object.entries(PROFILES).filter(([, x]) => x.turbine)) {
  test(`${name}: full throttle spools up to the governor in a few seconds, never past it, in one gear`, () => {
    const run = drive(p, 'normal', (t) => Math.min(kmh(220), t / 1000 * 4), () => 1, 12)
    for (const s of run) { assert.equal(s.gear, 1); assert.ok(s.rpm <= p.redline + 1 && s.rpm >= p.idle - 1, `rpm ${s.rpm}`) }
    const at = (sec) => run[Math.round(sec / 0.02)].rpm
    assert.ok(at(0.5) < p.idle + 0.5 * (p.redline - p.idle), `not instant: ${at(0.5)} at 0.5 s`)
    assert.ok(at(5) > p.redline * 0.97, `spooled: ${at(5)} at 5 s`)
    // While it spools up the sound is on-load.
    assert.ok(run.slice(5, 50).every((s) => s.load > 0.5))
  })

  test(`${name}: a cruise holds part power, more the faster, and lifting off spools down on overrun`, () => {
    const cruise = (k) => drive(p, 'normal', () => kmh(k), () => 0.05, 15).at(-1).rpm
    const c60 = cruise(60), c120 = cruise(120)
    assert.ok(c60 > p.idle && c120 > c60 + 200 && c120 < p.redline * 0.95, `60: ${c60}, 120: ${c120}`)
    const run = drive(p, 'normal', () => kmh(120), (t) => (t < 8000 ? 1 : -0.3), 14)
    const lift = run.slice(Math.round(8.1 / 0.02), Math.round(9.5 / 0.02))
    assert.ok(lift.every((s) => s.load < 0), 'spooling down reads as overrun')
    assert.ok(run.at(-1).rpm < run[Math.round(8 / 0.02)].rpm - 500)
  })

  test(`${name}: parked, the throttle spools it to the governor, which holds it there without a limiter's cut`, () => {
    const fr = new FreeRev(p)
    let s
    for (let i = 0; i < 300; i++) s = fr.step(1, 0.02)
    assert.equal(s.rpm, p.redline)
    assert.equal(fr.onLimiter, false)
    // A finger is followed with the spool's lag, not at once.
    const f = new FreeRev(p)
    f.hold(p.redline)
    for (let i = 0; i < 10; i++) s = f.step(0, 0.02)
    assert.ok(s.rpm < p.idle + 0.3 * (p.redline - p.idle), `${s.rpm} after 0.2 s`)
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
  const run = drive(PROFILES.v8, 'normal', (t) => (t < 30000 ? Math.min(kmh(120), t / 1000 * 3) : up(t - 30000)), (t) => (t < 30000 ? 0.4 : -0.4), 58)
  const top = Math.max(...run.map((s) => s.gear))
  assert.ok(run[run.length - 1].gear <= 2, `ended in ${run[run.length - 1].gear} from ${top}`)
})

test('FreeRev climbs to the limiter, bounces off it, and falls back to idle', () => {
  const p = PROFILES.v8
  const fr = new FreeRev(p)
  let max = 0, cuts = 0, below = true
  for (let i = 0; i < 150; i++) {
    const s = fr.step(1, 0.02)
    max = Math.max(max, s.rpm)
    if (s.rpm >= p.redline && below) cuts++
    below = s.rpm < p.redline
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

// ── Simulation mode: a finger on the rev meter drives FreeRev ────────────
const run = (fr, seconds, each = () => {}) => {
  const out = []
  for (let i = 0; i < Math.round(seconds / 0.02); i++) { each(i); out.push(fr.step(0, 0.02)) }
  return out
}

test('a held finger: the engine reaches it in about a tenth of a second and stays there', () => {
  const p = PROFILES.v8
  const fr = new FreeRev(p)
  fr.hold(4000)
  const rise = run(fr, 0.14)
  assert.ok(Math.abs(fr.rpm - 4000) < 4000 * 0.05, `at ${fr.rpm} after 140 ms`)
  assert.ok(rise[0].load >= 0.4, 'rising under the finger reads as load')
  run(fr, 1)
  assert.ok(Math.abs(fr.rpm - 4000) < 5, `drifted to ${fr.rpm}`)
  assert.ok(fr.touching)
})

test('a dragging finger is followed closely, up and down', () => {
  const fr = new FreeRev(PROFILES.v8)
  let worst = 0, target = 0
  // Sweep 1000 → 6000 → 1000 rpm over two seconds.
  run(fr, 2, (i) => {
    const t = i * 0.02
    target = 1000 + 5000 * (t < 1 ? t : 2 - t)
    fr.hold(target)
    if (i > 5) worst = Math.max(worst, Math.abs(fr.rpm - target))
  })
  assert.ok(worst < 400, `fell ${worst.toFixed(0)} rpm behind the finger`)
})

test('lifting the finger lets the engine fall back to idle like a real one, on overrun', () => {
  const p = PROFILES.v8
  const fr = new FreeRev(p)
  fr.hold(5000); run(fr, 0.5)
  fr.release()
  const fall = run(fr, 0.3)
  assert.ok(fall.every((s) => s.load < 0), 'falling revs are overrun')
  assert.ok(fall[fall.length - 1].rpm < 5000, 'falling, not dropping to idle at once')
  assert.ok(fall[fall.length - 1].rpm > p.idle, 'not instantly at idle')
  run(fr, 2)
  assert.equal(fr.rpm, p.idle)
  assert.ok(!fr.touching)
})

test('a tap is a blip: the engine reaches the tapped rpm, then falls back', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const fr = new FreeRev(p)
    fr.hold(5000); fr.release(true) // finger up before the engine moved
    const out = run(fr, 3)
    const max = Math.max(...out.map((s) => s.rpm))
    assert.ok(max >= 5000 * 0.97 && max <= 5000 * 1.01, `${name}: blipped to ${max}`)
    assert.equal(fr.rpm, p.idle, name)
  }
})

test('a finger in the red holds the engine on the limiter; a tap there is one bang off it', () => {
  const p = PROFILES.v8
  const fr = new FreeRev(p)
  fr.hold(p.redline * 2)
  let hits = 0, below = true
  const out = run(fr, 2, () => fr.hold(p.redline * 2))
  for (const s of out) { if (s.rpm >= p.redline && below) hits++; below = s.rpm < p.redline }
  assert.equal(Math.max(...out.map((s) => s.rpm)), p.redline)
  assert.ok(hits >= 5, `limiter hit ${hits} times in 2 s`)
  assert.ok(out.slice(25).some((s) => s.load < -0.3), 'the cut is overrun: it crackles')

  const tap = new FreeRev(p)
  tap.hold(p.redline * 2); tap.release(true)
  const t = run(tap, 3)
  hits = 0; below = true
  for (const s of t) { if (s.rpm >= p.redline && below) hits++; below = s.rpm < p.redline }
  assert.equal(hits, 1)
  assert.equal(tap.rpm, p.idle)
})

test('the limiter cut sets the bounce: a short cut bounces faster than the V8\'s lazy one', () => {
  const rate = (p) => {
    const fr = new FreeRev(p)
    let hits = 0, below = true
    run(fr, 3, () => fr.hold(p.redline * 2)).slice(50).forEach((s) => {
      if (s.rpm >= p.redline && below) hits++
      below = s.rpm < p.redline
    })
    return hits
  }
  const race = { ...PROFILES.v8, limiter: 45 }
  assert.ok(rate(race) > rate(PROFILES.v8) * 1.5, `45 ms ${rate(race)} v8 ${rate(PROFILES.v8)}`)
})

test('changing engine lets go of the finger, and the finger is kept inside the engine range', () => {
  const fr = new FreeRev(PROFILES.v8)
  fr.hold(-50)
  assert.equal(fr.target, PROFILES.v8.idle)
  fr.hold(NaN)
  assert.equal(fr.target, PROFILES.v8.idle)
  fr.setProfile({ ...PROFILES.v8 })
  assert.ok(!fr.touching)
})

test('on the limiter reads as one steady state through the bounce', () => {
  const p = PROFILES.v8
  const fr = new FreeRev(p)
  assert.equal(fr.onLimiter, false)
  run(fr, 0.5, () => fr.hold(p.redline * 2))
  const states = []
  run(fr, 1, (i) => { fr.hold(p.redline * 2); if (i > 0) states.push(fr.onLimiter) })
  assert.ok(states.every(Boolean), `dropped off ${states.filter((x) => !x).length} times`)
  fr.release()
  run(fr, 0.5)
  assert.equal(fr.onLimiter, false)
})
