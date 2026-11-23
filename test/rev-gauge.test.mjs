// Geometry of the engine sound page's dials (static/rev-gauge.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tachScale, speedScale, valueToAngle, arcPath, polar, ticks, follow, zone, ZoneLatch, START, SWEEP } from '../static/rev-gauge.js'
import { FreeRev } from '../static/rev-model.js'
import { PROFILES } from '../static/rev-profiles.js'

for (const [name, p] of Object.entries(PROFILES)) {
  test(`${name}: the tachometer shows the whole rev range with a visible red zone`, () => {
    const s = tachScale(p.redline, p.idle)
    assert.equal(s.max % 1000, 0)
    assert.ok(s.max - p.redline >= 500 && s.max - p.redline <= 1500, `max ${s.max} for redline ${p.redline}`)
    assert.equal(s.redFrom, p.redline)
    assert.ok(s.warnFrom < s.redFrom && s.warnFrom >= p.idle)
    // Labels are whole thousands, 0 to max.
    const labels = ticks(s).filter((t) => t.label != null).map((t) => t.label)
    assert.deepEqual(labels, Array.from({ length: s.max / 1000 + 1 }, (_, i) => String(i)))
  })
}

test('the speedometer is labelled every 40 km/h with ticks every 10', () => {
  const s = speedScale(240)
  const t = ticks(s)
  assert.equal(t.length, 25)
  assert.deepEqual(t.filter((x) => x.label).map((x) => x.label), ['0', '40', '80', '120', '160', '200', '240'])
  assert.equal(t.filter((x) => x.major).length, 13)
  assert.equal(s.redFrom, null)
})

test('values map onto a 270° sweep and are clamped to it', () => {
  assert.equal(valueToAngle(0, 8000), START)
  assert.equal(valueToAngle(8000, 8000), START + SWEEP)
  assert.equal(valueToAngle(4000, 8000), START + SWEEP / 2)
  assert.equal(valueToAngle(-50, 8000), START)
  assert.equal(valueToAngle(99999, 8000), START + SWEEP)
  assert.equal(valueToAngle(NaN, 8000), START)
  assert.equal(valueToAngle(10, 0), START)
  // 0 sits bottom-left, the top of the dial is the middle of the scale.
  const [x0, y0] = polar(100, 100, 84, START)
  assert.ok(x0 < 100 && y0 > 100)
  const [xm, ym] = polar(100, 100, 84, START + SWEEP / 2)
  assert.ok(Math.abs(xm - 100) < 1e-9 && ym < 100)
})

test('arcs use the large-arc flag past 180° and vanish at zero length', () => {
  assert.equal(arcPath(100, 100, 84, 135, 135), '')
  assert.equal(arcPath(100, 100, 84, 200, 135), '')
  assert.match(arcPath(100, 100, 84, 135, 200), /A84 84 0 0 1 /)
  assert.match(arcPath(100, 100, 84, 135, 405), /A84 84 0 1 1 /)
  // The arc ends where the needle points.
  const d = arcPath(100, 100, 84, 135, 300)
  const [x, y] = polar(100, 100, 84, 300)
  assert.ok(d.endsWith(`${x.toFixed(2)} ${y.toFixed(2)}`))
})

test('easing converges at any frame rate and never overshoots', () => {
  for (const fps of [30, 60, 120]) {
    let v = 0
    const dt = 1 / fps
    for (let i = 0; i < fps; i++) {
      v = follow(v, 6000, dt)
      assert.ok(v <= 6000)
    }
    assert.ok(v > 5990, `${fps} fps: ${v} after 1 s`)
  }
  // Frame-rate independent: 1 s at 30 fps lands where 1 s at 120 fps does.
  let a = 0, b = 0
  for (let i = 0; i < 6; i++) a = follow(a, 100, 1 / 30)
  for (let i = 0; i < 24; i++) b = follow(b, 100, 1 / 120)
  assert.ok(Math.abs(a - b) < 1e-9)
  assert.equal(follow(NaN, 5, 0.016), 5)
  assert.equal(follow(3, 5, -1), 3)
})

test('the tachometer turns amber near the redline and red at it', () => {
  const s = tachScale(6800, 720)
  assert.equal(zone(3000, s), 'ok')
  assert.equal(zone(6400, s), 'warn')
  assert.equal(zone(6800, s), 'red')
  assert.equal(zone(6650, s), 'red', 'the limiter bounce counts as red')
  assert.equal(zone(239, speedScale()), 'ok')
})

test('on the limiter the tachometer stays red, steadily, for every engine', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const s = tachScale(p.redline, p.idle)
    const fr = new FreeRev(p), latch = new ZoneLatch()
    const dt = 1 / 60
    for (let i = 0; i < 120; i++) latch.next(fr.step(1, dt).rpm, s, dt) // reach the limiter
    for (let i = 0; i < 120; i++) {
      const rpm = fr.step(1, dt).rpm
      assert.equal(latch.next(rpm, s, dt), 'red', `${name} flickered at ${Math.round(rpm)} rpm`)
    }
    // Let go: red clears within the hold time once the revs drop.
    let t = 0, z = 'red'
    while (z === 'red' && t < 2) { z = latch.next(fr.step(0, dt).rpm, s, dt); t += dt }
    assert.ok(t < 0.6, `${name}: still red ${t.toFixed(2)} s after lifting`)
  }
})
