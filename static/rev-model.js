// Engine-sound model: turns the car's speed into a virtual engine's rpm and
// load. Pure code with no DOM or Web Audio, so it runs the same in the
// browser and under `node --test` (see test/rev-model.test.mjs).
//
// The car gives us speed and nothing else. Browser geolocation is the car's
// GPS (docs/telemetry-options.md, Tier 1); pedal position, torque and power
// are on the CAN bus only, BLE is seconds per read and holds one of the car's
// three connection slots, and the cloud API freezes while the car sleeps. So:
//
//   speed fixes ──► SpeedTracker ──► v, a ──► loadFromMotion ──► load
//                                      │                          │
//                                      └──────► Gearbox ◄─────────┘ ──► rpm, gear
//
// Load is "how hard the engine would be working": the force the car is using
// (from its acceleration, aero drag and rolling resistance) over the force it
// could use at this speed. Negative load is overrun (lifting off, braking).
// docs/rev-sound.md explains the choices.

export const G = 9.81
const AIR = 1.2 // kg/m^3

// Approximate published figures, used only to scale acceleration into load.
// A wrong number makes the engine work a bit harder or softer than it should;
// it never changes what the car does.
export const CARS = {
  m3rwd:  { name: 'Model 3 RWD',                 mass: 1760, powerW: 208e3, aMax: 5.0, cdA: 0.49 },
  m3lr:   { name: 'Model 3 Long Range AWD',      mass: 1830, powerW: 366e3, aMax: 6.6, cdA: 0.49 },
  m3p:    { name: 'Model 3 Performance',         mass: 1850, powerW: 460e3, aMax: 9.0, cdA: 0.50 },
  myrwd:  { name: 'Model Y RWD',                 mass: 1910, powerW: 220e3, aMax: 4.4, cdA: 0.58 },
  mylr:   { name: 'Model Y Long Range AWD',      mass: 1980, powerW: 378e3, aMax: 5.9, cdA: 0.58 },
}
export const DEFAULT_CAR = 'm3rwd'
const CRR = 0.010

// Drive modes set where the virtual gearbox shifts, the way the real thing
// would: Comfort short-shifts, Sport holds gears.
export const MODES = {
  comfort: { upLow: 0.30, upHigh: 0.70, down: 0.20, kick: 0.85 },
  normal:  { upLow: 0.36, upHigh: 0.86, down: 0.24, kick: 0.70 },
  sport:   { upLow: 0.50, upHigh: 0.97, down: 0.36, kick: 0.50 },
}
export const DEFAULT_MODE = 'normal'

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
const lerp = (a, b, t) => a + (b - a) * t

// ── Speed ─────────────────────────────────────────────────────────────────
// The car's fixes arrive about once a second while moving (unmeasured in
// Drive: docs/telemetry-options.md "What the Drive run must still answer").
// Between fixes the tracker carries on at the last measured acceleration, so
// the engine keeps climbing through a pull instead of stepping once a second,
// and it estimates acceleration from a short regression rather than from two
// points, because a single noisy fix would otherwise kick the load around.
//
// Times are the caller's clock at arrival (ms). Never pos.timestamp: on the
// car it is not epoch time and does not advance between fixes.
export class SpeedTracker {
  constructor({ window = 3500, maxExtrapolate = 1500, staleAfter = 4000 } = {}) {
    this.window = window
    this.maxExtrapolate = maxExtrapolate
    this.staleAfter = staleAfter
    this.fixes = [] // { t, v }
    this.accel = 0
  }

  reset() { this.fixes = []; this.accel = 0 }

  // speed in m/s, or null when the car did not report one (stationary or a
  // coarse fix). A null is treated as 0 only when we have nothing better:
  // the car reports null at a standstill, so that is the honest reading.
  push(t, speed) {
    const v = speed == null || !Number.isFinite(speed) ? 0 : Math.max(0, speed)
    // A second fix at the same instant replaces the first.
    const last = this.fixes[this.fixes.length - 1]
    if (last && t <= last.t) { last.v = v; this.accel = this.slope(); return }
    this.fixes.push({ t, v })
    while (this.fixes.length > 2 && t - this.fixes[0].t > this.window) this.fixes.shift()
    this.accel = this.slope()
  }

  // Least-squares slope over the window, in m/s^2.
  slope() {
    const n = this.fixes.length
    if (n < 2) return 0
    let st = 0, sv = 0
    for (const f of this.fixes) { st += f.t; sv += f.v }
    const mt = st / n, mv = sv / n
    let num = 0, den = 0
    for (const f of this.fixes) { num += (f.t - mt) * (f.v - mv); den += (f.t - mt) ** 2 }
    if (den <= 0) return 0
    // Lean on the newest step more than the regression, so a lift-off is
    // heard at the next fix instead of a whole window later; the regression
    // keeps one odd fix from swinging the load on its own. The car's GPS
    // speed is Doppler-smooth, so the step is not as noisy as it would be
    // from positions.
    const reg = (num / den) * 1000
    const a = this.fixes[n - 2], b = this.fixes[n - 1]
    const step = ((b.v - a.v) / (b.t - a.t)) * 1000
    return clamp(0.3 * reg + 0.7 * step, -12, 12)
  }

  // Estimated { v, a, stale } at time t.
  at(t) {
    const last = this.fixes[this.fixes.length - 1]
    if (!last) return { v: 0, a: 0, stale: true }
    const age = t - last.t
    if (age > this.staleAfter) return { v: last.v, a: 0, stale: true }
    const dt = clamp(age, 0, this.maxExtrapolate) / 1000
    const v = Math.max(0, last.v + this.accel * dt)
    return { v, a: v > 0 ? this.accel : 0, stale: false }
  }
}

// ── Load ──────────────────────────────────────────────────────────────────
// Force the car is using over the force it could use, -1..1.
export function loadFromMotion(v, a, car = CARS[DEFAULT_CAR]) {
  const drag = 0.5 * AIR * car.cdA * v * v
  const roll = v > 0.3 ? CRR * car.mass * G : 0
  const need = car.mass * a + drag + roll
  if (need >= 0) {
    const fMax = Math.min(car.mass * car.aMax, car.powerW / Math.max(v, 1))
    return clamp(need / fMax, 0, 1)
  }
  // Overrun: scaled against firm braking (~0.35 g), so a gentle coast reads
  // as a light lift and a hard stop as a full one.
  return clamp(need / (car.mass * 0.35 * G), -1, 0)
}

// ── Gearbox ───────────────────────────────────────────────────────────────
// A virtual automatic. Each gear is described by the road speed it reaches
// at redline, so a profile can be tall or short without wheel sizes and
// final drives. rpm = speed * redline / gearTop.
export class Gearbox {
  constructor(profile, mode = DEFAULT_MODE) {
    this.setProfile(profile)
    this.setMode(mode)
    this.gear = 1
    this.rpm = profile.idle
    this.lastShift = -Infinity
    this.shiftUntil = 0
    this.shiftDir = 0
  }

  setProfile(p) {
    this.p = p
    if (this.gear > p.gears.length) this.gear = p.gears.length
  }
  setMode(m) { this.mode = MODES[m] || MODES[DEFAULT_MODE] }

  rpmIn(gear, v) { return v * this.p.redline / this.p.gears[gear - 1] }

  // Advance to time t (ms). Returns { rpm, gear, load, shifting }.
  // `load` is the caller's estimate; the gearbox cuts it briefly during an
  // upshift (the ignition cut that makes the "bwaap" between gears).
  step(t, v, load, dt) {
    const p = this.p, m = this.mode
    if (p.turbine) return this.spool(v, load, dt)
    const pos = Math.max(0, load)
    const upAt = p.redline * lerp(m.upLow, m.upHigh, pos)
    const downAt = p.redline * m.down
    const canShift = t - this.lastShift > 700

    if (canShift) {
      const r = this.rpmIn(this.gear, v)
      if (this.gear < p.gears.length && r > upAt) {
        this.shift(t, +1)
      } else if (this.gear > 1) {
        const lower = this.rpmIn(this.gear - 1, v)
        // Never drop into a gear that would want to shift straight back up:
        // the lower gear has to land well under the upshift point, or the box
        // hunts between two gears for as long as the load holds.
        const room = lower < upAt * 0.9
        const kick = pos > m.kick && room
        if ((r < downAt && room) || kick) this.shift(t, -1)
      }
    }

    // Road rpm. Below the speed where first gear pulls idle, the clutch (or
    // converter) is slipping: rpm floats above idle with the throttle, which
    // is what makes a launch sound like a launch.
    const road = this.rpmIn(this.gear, v)
    const slip = this.gear === 1 ? p.idle + pos * (p.launch - p.idle) : p.idle
    let target = Math.max(road, slip, p.idle)
    target = Math.min(target, p.redline)

    // Shifts are quick but not instant; everything else follows within a
    // few tens of ms so a GPS step never clicks.
    const tau = t < this.shiftUntil ? 0.06 : 0.12
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / tau))

    const shifting = t < this.shiftUntil
    const outLoad = shifting && this.shiftDir > 0 ? Math.min(load, -0.15) : load
    return { rpm: this.rpm, gear: this.gear, load: outLoad, shifting }
  }

  // A turbine (the jet) has no gears: the spool chases a demand, set by the
  // throttle (the load) or by what it takes to hold the speed, whichever
  // is more, and gets there slowly (spoolUp / spoolDown s). The sound's
  // load is pulling while it spools up or is held at power, lifting while
  // it spools down.
  spool(v, load, dt) {
    const p = this.p, pos = Math.max(0, load)
    const hold = clamp(p.cruise * (v / 33) ** 2, 0, 0.6) // ~0.35 at 120 km/h
    const demand = clamp(Math.max(pos, hold), 0, 1)
    const target = p.idle + (p.redline - p.idle) * demand
    const tau = target > this.rpm ? p.spoolUp : p.spoolDown
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / tau))
    this.gear = 1
    const gap = (target - this.rpm) / (p.redline - p.idle)
    const outLoad = gap < -0.05 ? clamp(gap * 3, -1, -0.1) : load < 0 ? load : clamp(Math.max(demand, gap * 3), 0, 1)
    return { rpm: this.rpm, gear: 1, load: outLoad, shifting: false }
  }

  shift(t, dir) {
    this.gear += dir
    this.lastShift = t
    this.shiftDir = dir
    this.shiftUntil = t + (dir > 0 ? 140 : 90)
  }
}

// ── Free rev (parked) ─────────────────────────────────────────────────────
// Neutral: the throttle spins the engine up against its own inertia, the
// limiter bounces it off redline, and it falls back to idle when released.
//
// Simulation mode drives it with a finger instead of a throttle: hold(rpm)
// makes the engine chase that rpm (as fast as it can follow without a
// click), release() lets it fall back to idle the way it would off the
// throttle, and a tap is a blip: the engine still reaches the tapped rpm,
// then falls. A target past the redline hits the limiter and stays on it.
export const TOUCH_TAU = 0.04 // s: the engine is within 5 % of the finger in ~120 ms
export const LIMIT_OVER = 1.06 // a finger in the red asks for this much past redline
export class FreeRev {
  constructor(profile) { this.p = profile; this.rpm = profile.idle; this.cut = 0; this.sinceCut = Infinity; this.target = null; this.blip = false }
  setProfile(p) { this.p = p; this.release() }

  hold(rpm) {
    const p = this.p
    this.target = clamp(Number.isFinite(rpm) ? rpm : p.idle, p.idle, p.redline * LIMIT_OVER)
    this.blip = false
  }
  // blip: keep going until the engine gets there, then let go.
  release(blip = false) {
    if (blip && this.target != null && this.rpm < this.reach()) this.blip = true
    else { this.target = null; this.blip = false }
  }
  get touching() { return this.target != null }
  // Touched the limiter in the last 0.3 s: the bounce reads as one state.
  get onLimiter() { return this.sinceCut < 0.3 }
  // Where a blip counts as arrived: near the tapped rpm, or one bang off the
  // limiter for a tap in the red.
  reach() { return this.target >= this.p.redline ? this.p.redline : this.target * 0.97 }

  step(throttle, dt) {
    const p = this.p
    if (this.cut > 0) this.cut -= dt
    this.sinceCut += dt
    const before = this.rpm
    let load
    if (this.target != null && this.cut <= 0) {
      // A turbine spools to the finger, slowly; an engine is there at once.
      const tau = p.turbine ? (this.target > this.rpm ? p.spoolUp : p.spoolDown) : TOUCH_TAU
      this.rpm += (this.target - this.rpm) * (1 - Math.exp(-dt / tau))
      // What a throttle would be doing to move the revs like that: rising
      // is load, holding needs a little, chasing a finger down is overrun.
      const rate = (this.rpm - before) / dt
      load = rate > 200 ? clamp(0.4 + rate / p.revRise, 0.4, 1) : rate < -1500 ? -0.5 : 0.25
    } else {
      throttle = this.target != null ? 0 : clamp(throttle, 0, 1)
      const on = this.cut <= 0 ? throttle : 0
      this.rpm += (on * p.revRise - (1 - on) * p.revFall) * dt
      load = on > 0 ? on : (this.rpm > p.idle * 1.3 ? -0.6 : 0)
    }
    // A governor holds a turbine at the top; an engine bounces off its limiter.
    if (this.rpm >= p.redline) { this.rpm = p.redline; if (!p.governor) { this.cut = (p.limiter || 70) / 1000; this.sinceCut = 0 } }
    if (this.rpm < p.idle) this.rpm = p.idle
    if (this.blip && this.rpm >= this.reach()) this.release()
    return { rpm: this.rpm, gear: 0, load, shifting: false }
  }
}

// ── Simulated car ─────────────────────────────────────────────────────────
// For trying the engine without the car: a pedal in, speed out. It drives
// the same SpeedTracker the GPS does, at a GPS-like fix rate, so the
// simulator exercises the real pipeline rather than a shortcut around it.
export class SimCar {
  constructor(car = CARS[DEFAULT_CAR]) { this.car = car; this.v = 0 }
  setCar(c) { this.car = c }
  // pedal 0..1, brake 0..1, dt in s. Returns speed in m/s.
  step(pedal, brake, dt) {
    const c = this.car
    const v = this.v
    const fDrive = clamp(pedal, 0, 1) * Math.min(c.mass * c.aMax, c.powerW / Math.max(v, 1))
    const drag = 0.5 * AIR * c.cdA * v * v
    const roll = v > 0.1 ? CRR * c.mass * G : 0
    // One-pedal regen when the pedal is up, like the real car.
    const regen = pedal < 0.05 && v > 0.5 ? c.mass * 0.15 * G : 0
    const fBrake = clamp(brake, 0, 1) * c.mass * 0.8 * G
    const a = (fDrive - drag - roll - regen - fBrake) / c.mass
    this.v = Math.max(0, v + a * dt)
    return this.v
  }
}
