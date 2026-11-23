// Geometry and colour of the engine sound page's cluster (static/rev-gauge.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARC, VIEW, SEG_PER_1000, BAR_N, tachScale, angleFor, polar, segmentsFor, litCount, shownLit,
  mix, litColor, LIT, barLit, follow, zone, ZoneLatch,
} from '../static/rev-gauge.js'
import { FreeRev } from '../static/rev-model.js'
import { PROFILES } from '../static/rev-profiles.js'

for (const [name, p] of Object.entries(PROFILES)) {
  test(`${name}: the arc covers the whole rev range and ends in red past the redline`, () => {
    const s = tachScale(p.redline, p.idle)
    assert.equal(s.max % 1000, 0)
    assert.ok(s.max - p.redline >= 500 && s.max - p.redline <= 1500, `max ${s.max} for redline ${p.redline}`)
    const segs = segmentsFor(s)
    assert.equal(segs.length, (s.max / 1000) * SEG_PER_1000)
    // Red is one unbroken run at the end, starting at the redline.
    const firstRed = segs.findIndex((x) => x.red)
    assert.ok(firstRed > 0)
    assert.ok(segs.slice(firstRed).every((x) => x.red))
    assert.ok(segs.slice(0, firstRed).every((x) => !x.red))
    const mid = (x) => (x.from + x.to) / 2
    assert.ok(mid(segs[firstRed]) >= p.redline && mid(segs[firstRed - 1]) < p.redline)
    // At least three red segments, so the zone reads as a zone.
    assert.ok(segs.length - firstRed >= 3)
  })
}

test('the arc is a shallow bow across the top, symmetric about the middle', () => {
  const s = tachScale(6800)
  const segs = segmentsFor(s)
  const [x0, y0] = polar(ARC.cx, ARC.cy, ARC.rOut, segs[0].angle)
  const [x1, y1] = polar(ARC.cx, ARC.cy, ARC.rOut, segs[segs.length - 1].angle)
  assert.ok(Math.abs((ARC.cx - x0) - (x1 - ARC.cx)) < 1e-6, 'symmetric')
  assert.ok(Math.abs(y0 - y1) < 1e-6)
  // Inside the picture, with the top of the bow near the top edge.
  assert.ok(x0 > 0 && x1 < VIEW.w)
  assert.ok(ARC.cy - ARC.rOut > 0 && ARC.cy - ARC.rOut < 100)
  assert.ok(y0 < VIEW.h / 2, 'ends sit in the upper half, above the pill')
  // Angles climb left to right.
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].angle > segs[i - 1].angle)
})

test('values map onto the arc and are clamped to it', () => {
  assert.equal(angleFor(0, 8000), ARC.a0)
  assert.equal(angleFor(8000, 8000), ARC.a1)
  assert.equal(angleFor(4000, 8000), (ARC.a0 + ARC.a1) / 2)
  assert.equal(angleFor(-5, 8000), ARC.a0)
  assert.equal(angleFor(1e9, 8000), ARC.a1)
  assert.equal(angleFor(NaN, 8000), ARC.a0)
  assert.equal(angleFor(5, 0), ARC.a0)
})

test('the engine lights segments in proportion, none when off and all at the top', () => {
  const segs = segmentsFor(tachScale(6800))
  assert.equal(litCount(0, segs), 0)
  assert.equal(litCount(NaN, segs), 0)
  assert.equal(litCount(8000, segs), segs.length)
  assert.equal(litCount(99999, segs), segs.length)
  assert.equal(litCount(4000, segs), 24)
  let prev = 0
  for (let v = 0; v <= 8000; v += 37) {
    const n = litCount(v, segs)
    assert.ok(n >= prev)
    prev = n
  }
  assert.equal(litCount(100, []), 0)
})

test('lit segments warm from deep orange to yellow at the tip', () => {
  assert.equal(litColor(0), LIT[0][1])
  assert.equal(litColor(1), LIT[LIT.length - 1][1])
  assert.equal(litColor(2), litColor(1))
  assert.equal(litColor(-1), litColor(0))
  assert.equal(litColor(NaN), litColor(0))
  // Each step toward the tip is at least as bright (green channel rises).
  const g = (c) => parseInt(c.slice(3, 5), 16)
  let last = -1
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const v = g(litColor(t))
    assert.ok(v >= last, `t=${t.toFixed(2)}`)
    last = v
  }
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
  assert.equal(mix('#102030', '#102030', 0.7), '#102030')
})

test('side bars light in proportion and clamp', () => {
  assert.equal(barLit(0, BAR_N), 0)
  assert.equal(barLit(-0.4, BAR_N), 0)
  assert.equal(barLit(NaN, BAR_N), 0)
  assert.equal(barLit(0.5, BAR_N), BAR_N / 2)
  assert.equal(barLit(1, BAR_N), BAR_N)
  assert.equal(barLit(3, BAR_N), BAR_N)
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
  let a = 0, b = 0
  for (let i = 0; i < 6; i++) a = follow(a, 100, 1 / 30)
  for (let i = 0; i < 24; i++) b = follow(b, 100, 1 / 120)
  assert.ok(Math.abs(a - b) < 1e-9, 'frame-rate independent')
  assert.equal(follow(NaN, 5, 0.016), 5)
  assert.equal(follow(3, 5, -1), 3)
})

test('the tachometer turns amber near the redline and red at it', () => {
  const s = tachScale(6800, 720)
  assert.equal(zone(3000, s), 'ok')
  assert.equal(zone(6400, s), 'warn')
  assert.equal(zone(6800, s), 'red')
  assert.equal(zone(6650, s), 'red', 'the limiter bounce counts as red')
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
    let t = 0, z = 'red'
    while (z === 'red' && t < 2) { z = latch.next(fr.step(0, dt).rpm, s, dt); t += dt }
    assert.ok(t < 0.6, `${name}: still red ${t.toFixed(2)} s after lifting`)
  }
})

test('at the redline the run reaches into the red zone, even with the display easing behind', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const s = tachScale(p.redline, p.idle)
    const segs = segmentsFor(s)
    const firstRed = segs.findIndex((x) => x.red)
    // An eased display a few percent under the redline lights no red by itself...
    const eased = p.redline * 0.96
    assert.ok(litCount(eased, segs) <= firstRed, name)
    // ...but in the red zone the first red segment is lit.
    assert.equal(shownLit(eased, segs, 'red'), firstRed + 1, name)
    // Outside the red zone nothing is added, and a higher reading is kept.
    assert.equal(shownLit(eased, segs, 'warn'), litCount(eased, segs))
    assert.equal(shownLit(s.max, segs, 'red'), segs.length)
  }
})
