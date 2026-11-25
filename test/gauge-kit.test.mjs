// The gauge styles' shared kit (static/gauges/kit.js) and registry
// (static/gauges/index.js): the pure parts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SEVEN, segmentsOf, lcdCells, sevenPolys, dialAngle, arcPath, polar, follow, clamp,
  Instruments, REST, AMBIENT_C, tachScale, zone, hhmm,
} from '../static/gauges/kit.js'
import { STYLES, DEFAULT_STYLE, styleKey } from '../static/gauges/index.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('seven-segment digits light the usual segments', () => {
  assert.equal(segmentsOf(8), 'abcdefg')
  assert.equal(segmentsOf('1'), 'bc')
  assert.equal(segmentsOf(' '), '')
  assert.equal(segmentsOf('x'), '', 'anything else is blank')
  assert.equal(segmentsOf('N'), 'abcef', 'gear letters: N is the arch')
  for (let d = 0; d <= 9; d++) assert.ok(SEVEN[d].length >= 2)
  // Every digit lights a different pattern.
  assert.equal(new Set([...Array(10).keys()].map((d) => SEVEN[d])).size, 10)
})

test('an LCD row right-aligns, like a fixed display', () => {
  assert.deepEqual(lcdCells('7', 3), [' ', ' ', '7'])
  assert.deepEqual(lcdCells('104', 3), ['1', '0', '4'])
  assert.deepEqual(lcdCells('1234', 3), ['2', '3', '4'])
  assert.deepEqual(lcdCells('', 2), [' ', ' '])
})

test('segment polygons stay inside their cell and are well formed', () => {
  const p = sevenPolys(10, 20, 40, 80, 8, 0)
  for (const k of 'abcdefg') {
    const pts = p[k].split(' ').map((s) => s.split(',').map(Number))
    assert.equal(pts.length, 6, k)
    for (const [x, y] of pts) { assert.ok(x >= 10 && x <= 50, `${k} x ${x}`); assert.ok(y >= 20 && y <= 100, `${k} y ${y}`) }
  }
})

test('dial angles clamp to the dial and arcs start where they say', () => {
  assert.equal(dialAngle(0, 0, 100, 135, 405), 135)
  assert.equal(dialAngle(100, 0, 100, 135, 405), 405)
  assert.equal(dialAngle(50, 0, 100, 135, 405), 270)
  assert.equal(dialAngle(-5, 0, 100, 135, 405), 135)
  assert.equal(dialAngle(NaN, 0, 100, 135, 405), 135)
  const [x, y] = polar(100, 100, 50, 180)
  assert.ok(arcPath(100, 100, 50, 180, 270).startsWith(`M${x.toFixed(2)} ${y.toFixed(2)}`))
  assert.match(arcPath(0, 0, 10, 0, 300), / 0 1 1 /, 'a long arc sets the large-arc flag')
})

test('the made-up water temperature warms up, then holds near 90 °C', () => {
  const ins = new Instruments()
  let r
  r = ins.step(1, { running: true, rpm: 800, load: 0, redline: 7000 })
  assert.ok(r.water < 40, 'cold at the start')
  for (let t = 0; t < 120; t++) r = ins.step(1, { running: true, rpm: 800, load: 0, redline: 7000 })
  assert.ok(r.water > 70 && r.water < 90, `warming after 2 min: ${r.water}`)
  for (let t = 0; t < 600; t++) r = ins.step(1, { running: true, rpm: 800, load: 0, redline: 7000 })
  assert.ok(Math.abs(r.water - 90) < 2, `warm idle: ${r.water}`)
  // Working hard creeps it up, but never past the hot mark.
  for (let t = 0; t < 600; t++) r = ins.step(1, { running: true, rpm: 6800, load: 1, redline: 7000 })
  assert.ok(r.water > 95 && r.water <= 105, `hard work: ${r.water}`)
  assert.ok(r.oilPress > 4 && r.oilPress <= 6)
  assert.ok(r.volts > 13.5 && r.volts < 14.5)
  assert.ok(r.fuel > 0 && r.fuel <= 1)
})

test('engine off: every needle rests, the engine keeps cooling underneath', () => {
  const ins = new Instruments()
  for (let t = 0; t < 900; t++) ins.step(1, { running: true, rpm: 900, load: 0 })
  const hot = ins.water
  const r = ins.step(1, { running: false })
  for (const k of Object.keys(REST)) assert.equal(r[k], REST[k], k)
  for (let t = 0; t < 600; t++) ins.step(1, { running: false })
  assert.ok(ins.water < hot - 10 && ins.water > AMBIENT_C, `cooling: ${ins.water}`)
})

test('trip and odometer integrate the speed; snapshots cool with time', () => {
  const ins = new Instruments({ odo: 100 })
  for (let t = 0; t < 720; t++) ins.step(5, { running: true, v: 10 }) // an hour at 36 km/h, in 5 s steps
  assert.ok(Math.abs(ins.trip - 36) < 0.01, `trip ${ins.trip}`)
  assert.ok(Math.abs(ins.odo - 136) < 0.01)
  ins.water = 90
  const snap = ins.snapshot(1_000_000)
  const later = new Instruments().restore(snap, 1_000_000 + 900_000) // 15 min later
  assert.ok(later.water < 90 && later.water > AMBIENT_C + 15, `cooled: ${later.water}`)
  assert.equal(later.trip, ins.trip)
  const now = new Instruments().restore(snap, 1_000_000)
  assert.equal(now.water, 90)
  assert.equal(new Instruments().restore(null).water, AMBIENT_C, 'nothing saved: cold')
  assert.equal(new Instruments().restore({ water: 'hot' }).water, AMBIENT_C, 'junk ignored')
})

test('the helpers the styles share behave', () => {
  assert.equal(clamp(5, 0, 1), 1)
  assert.equal(follow(NaN, 3, 0.1), 3)
  assert.equal(follow(0, 1, 0.1, 0), 1)
  assert.ok(follow(0, 1, 0.01, 0.1) < 0.2)
  assert.deepEqual(tachScale(9000, 900), { max: 10000, redFrom: 9000, warnFrom: 8300, label: 1000 })
  // The F1's 18,000 scale is numbered every 2,000, so the numbers do not run together.
  assert.deepEqual(tachScale(17000, 3770), { max: 18000, redFrom: 17000, warnFrom: 16300, label: 2000 })
  assert.equal(zone(8800, tachScale(9000, 900)), 'red')
  assert.equal(hhmm(new Date(2026, 0, 1, 7, 5)), '07:05')
})

test('every listed gauge style has its module, and unknown keys fall back', async () => {
  assert.ok(Object.hasOwn(STYLES, DEFAULT_STYLE))
  assert.equal(styleKey('nonsense'), DEFAULT_STYLE)
  assert.equal(styleKey('twin'), 'twin')
  for (const k of Object.keys(STYLES)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'static', 'gauges', k + '.js')), `static/gauges/${k}.js`)
    const src = fs.readFileSync(path.join(ROOT, 'static', 'gauges', k + '.js'), 'utf8')
    assert.match(src, new RegExp(`key: '${k}'`), `${k}: meta.key`)
    assert.match(src, /export default class \w+ extends GaugeStyle/, `${k}: extends GaugeStyle`)
  }
})
