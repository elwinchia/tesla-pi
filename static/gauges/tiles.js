// Tile grid, DeLorean-style: Blackbox Infinite's DMC-12 cluster for the new
// CarPlay, redrawn as closely as we can and without its marks. Ten dark,
// grainy rounded tiles in six columns, standing straight on the page (no
// plate behind them):
//   1  the engine's name, etched wide where the original has its logo;
//      a calendar-style list (trip and odometer, clock and gear)
//   2  battery volts; oil temperature
//   3  the speedometer: a grey band from 0 up to the speed, chrome digits
//   4  the tachometer (in hundreds), a fuel arc and the range under it
//   5  oil pressure; fuel
//   6  the green time-circuit clock; a cassette labelled with the engine
import { GaugeStyle, el, text, setText, polar, arcPath, dialAngle, clamp } from './kit.js'

const VIEW = { w: 1200, h: 390 }
// Tiles: [x, y, w, h]. Narrower than the original's (its grid is ~3.7:1),
// so every dial is sized by its tile's width and the tiles run tall.
const T = {
  name: [3, 3, 138, 185], cal: [3, 202, 138, 185],
  volts: [155, 3, 138, 185], oilT: [155, 202, 138, 185],
  speed: [307, 3, 286, 384], tach: [607, 3, 286, 384],
  oilP: [907, 3, 138, 185], fuel: [907, 202, 138, 185],
  clock: [1059, 3, 138, 185], tape: [1059, 202, 138, 185],
}
// The two big dials share one geometry: a 240° scale from bottom left to
// bottom right, ticks outside the numerals, the band under both.
const BIG = { R: 131, tick: 121, maj: 13, min: 7, num: 92, bandO: 125, bandI: 87, a0: 150, a1: 390, cy: 197 }
const SPEED = { max: 200, cx: T.speed[0] + T.speed[2] / 2 }
const TACH = { cx: T.tach[0] + T.tach[2] / 2 }
// The fuel arc fills the tach's open bottom: 0 at the left, 4/4 at the right.
const FUEL = { r: 117, a0: 145, a1: 35 }
const RANGE_KM = 600 // a full tank, for the made-up range
const SMALL_R = 56

const YEL = '#e8bb2c', ORG = '#f29a4a', RED = '#d6392c'
const CSS = `
.gs-tiles { font-family: "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif; }
.gs-tiles .tl-shadow { fill: #000; opacity: 0.35; }
.gs-tiles .tl-tile { stroke: #343434; stroke-width: 1.2; }
.gs-tiles .tl-ring { fill: rgba(0, 0, 0, 0.14); stroke: rgba(255, 255, 255, 0.07); stroke-width: 1.5; }
.gs-tiles .tl-ring.line { fill: none; }
.gs-tiles .tl-tk { stroke-linecap: butt; }
.gs-tiles .tl-tk.maj { stroke: #ececec; stroke-width: 3; }
.gs-tiles .tl-tk.min { stroke: #6e6e6e; stroke-width: 2; }
.gs-tiles .tl-tk.ghost { stroke: #262626; stroke-width: 1.5; }
.gs-tiles .tl-tk.red { stroke: ${RED}; }
.gs-tiles .tl-tk.min.red { stroke: #6e1d16; }
.gs-tiles .tl-num { fill: #f2f2f2; font-size: 17px; font-weight: 600; text-anchor: middle; dominant-baseline: central; font-variant-numeric: tabular-nums; }
.gs-tiles .tl-num.red { fill: #ff3b2c; }
.gs-tiles .tl-num.sm { font-size: 16px; font-weight: 700; }
.gs-tiles .tl-band { fill: #ffffff; opacity: 0.09; }
.gs-tiles .tl-speed { font-size: 64px; font-weight: 800; text-anchor: middle; letter-spacing: -2px; font-variant-numeric: tabular-nums; }
.gs-tiles .tl-unit { fill: #e8e8e8; font-size: 15px; font-weight: 700; text-anchor: middle; letter-spacing: 0.04em; }
.gs-tiles .tl-cap { fill: #8a8a8a; font-size: 14px; font-weight: 600; text-anchor: middle; letter-spacing: 0.1em; }
.gs-tiles .tl-flab { fill: #8c8c8c; font-size: 15px; font-weight: 600; text-anchor: middle; dominant-baseline: central; }
.gs-tiles .tl-range { fill: #f2f2f2; font-size: 19px; font-weight: 700; }
.gs-tiles .tl-fuel-off { fill: none; stroke: #343434; stroke-width: 3.5; }
.gs-tiles .tl-fuel-on { fill: none; stroke: #c9c9c9; stroke-width: 3.5; stroke-linecap: round; }
.gs-tiles .tl-fuel-on.low { stroke: ${YEL}; }
.gs-tiles .tl-hub { stroke: #050505; stroke-width: 1; }
.gs-tiles .tl-icon { fill: none; stroke: #ececec; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.gs-tiles .tl-icon .fill { fill: #ececec; stroke: none; }
.gs-tiles .tl-utag { fill: #8a8a8a; font-size: 14px; font-weight: 600; text-anchor: middle; }
.gs-tiles .tl-turn { fill: #0d0d0d; }
.gs-tiles .tl-arrow { fill: #574812; }
.gs-tiles .tl-etch { font-weight: 800; text-anchor: middle; dominant-baseline: central; }
.gs-tiles .tl-etch.hi { fill: #3d3d3d; }
.gs-tiles .tl-etch.lo { fill: #070707; }
.gs-tiles .tl-etch.face { fill: #262626; stroke: #4a4a4a; stroke-width: 0.9; }
.gs-tiles .tl-etch.sub { font-size: 14px; font-weight: 700; letter-spacing: 0.14em; }
.gs-tiles .tl-cal { font-size: 15px; }
.gs-tiles .tl-cal.when { font-weight: 300; }
.gs-tiles .tl-cal.what { font-size: 17px; font-weight: 600; }
.gs-tiles .tl-cal.where { font-weight: 400; }
.gs-tiles .tl-y { fill: ${YEL}; }
.gs-tiles .tl-y.dim { fill: #a48d2e; }
.gs-tiles .tl-r { fill: #e0392b; }
.gs-tiles .tl-r.dim { fill: #7c1f17; }
.gs-tiles .tl-plate { fill: #430d09; }
.gs-tiles .tl-platet { fill: #e2cdc4; font-size: 14px; font-weight: 700; text-anchor: middle; dominant-baseline: central; letter-spacing: 0.06em; }
.gs-tiles .tl-lcd { fill: #040907; stroke: #4a4d4c; stroke-width: 1.5; }
.gs-tiles .tl-lcd-in { fill: none; stroke: #0b0f0d; stroke-width: 2; }
.gs-tiles .tl-seg .off { fill: #0c271f; }
.gs-tiles .tl-seg .x { display: none; }
.gs-tiles .tl-seg .on { fill: #2fdca4; }
.gs-tiles .tl-shell { stroke: #d6d3ca; stroke-width: 1; }
.gs-tiles .tl-paper { fill: #c4c0b5; opacity: 0.55; }
.gs-tiles .tl-ink { fill: #2c2b28; font-weight: 800; }
.gs-tiles .tl-ink.sm { font-size: 14px; font-weight: 700; text-anchor: middle; letter-spacing: 0.04em; }
.gs-tiles .tl-win { fill: #1d1d1b; stroke: #55534d; stroke-width: 1; }
.gs-tiles .tl-reel { fill: #0e0e0e; stroke: #777570; stroke-width: 1.2; }
.gs-tiles .tl-reel-hub { fill: #d4d1c8; }
.gs-tiles .tl-hole { fill: #2a2926; }
.gs-tiles .tl-prog { fill: #2e2e2e; }
.gs-tiles .tl-prog-on { fill: #8a8a8a; }
.gs-tiles .tl-title { fill: #c9c9c9; font-size: 16px; font-weight: 700; text-anchor: middle; }
.gs-tiles .tl-artist { fill: #5e5e5e; font-size: 15px; font-weight: 700; text-anchor: middle; }
.gs-tiles .tl-finger { fill: rgba(255, 255, 255, 0.14); stroke: #f0f0f0; stroke-width: 3; pointer-events: none; }
.gs-tiles .tl-sim { fill: #c9c9c9; font-size: 14px; font-weight: 700; text-anchor: middle; letter-spacing: 0.12em; }
.gs-tiles[data-zone=red] .tl-num.red { filter: drop-shadow(0 0 4px rgba(255, 59, 44, 0.8)); }
`

// The small dials: `stops` are [value, angle] pairs (piecewise linear, as
// on the original, whose oil-temperature scale is uneven); `per` is ticks
// per quarter turn; `tick(v)` and the labels give the colours.
const SMALL = {
  volts: {
    tile: T.volts, stops: [[8, 90], [13, 180], [18, 270]], per: 10, icon: 'battery', unit: 'V',
    tick: (v) => (v >= 16.5 ? 'red' : 'yel'),
    majors: { 8: 'yel', 13: '', 18: 'red' },
    labels: [[8, '8', ORG], [13, '13', ''], [18, '18', RED]],
  },
  oilTemp: {
    tile: T.oilT, stops: [[40, 90], [80, 180], [120, 270]], per: 10, icon: 'oiltemp', unit: '°C',
    tick: (v) => (v > 80 ? 'olive' : 'grey'),
    majors: { 40: '', 80: '', 120: 'yel' },
    labels: [[40, '40', ''], [80, '80', ''], [120, '120', ORG]],
  },
  // Pressure in bar, like the made-up model (0..6); 0 at the bottom.
  oilPress: {
    tile: T.oilP, stops: [[0, 90], [3, 0], [6, -90]], per: 15, icon: 'oilcan', unit: 'bar',
    tick: () => 'light',
    majors: { 0: '', 3: '', 6: '' },
    labels: [[0, '0', ''], [6, '6', '#c4c4c4']],
  },
  fuel: {
    tile: T.fuel, stops: [[0, 90], [0.5, 0], [1, -90]], per: 15, icon: 'pump', unit: '',
    tick: () => 'light',
    majors: { 0: '', 0.5: '', 1: '' },
    labels: [[0, '0', ''], [0.5, ['1', '2'], ''], [1, ['4', '4'], '']],
  },
}
const TICK_COL = { yel: YEL, red: RED, olive: '#7d6c27', grey: '#555555', light: '#bdbdbd', '': '#ececec' }

// Piecewise-linear angle for a value on a small dial.
function stopAngle(stops, v) {
  if (!Number.isFinite(v) || v <= stops[0][0]) return stops[0][1]
  for (let k = 1; k < stops.length; k++) {
    const [v1, a1] = stops[k], [v0, a0] = stops[k - 1]
    if (v <= v1) return a0 + ((v - v0) / (v1 - v0)) * (a1 - a0)
  }
  return stops[stops.length - 1][1]
}

// ── Time-circuit digits ──
// Fourteen segments: a b c d e f as a seven-segment digit, the middle split
// (g left, G right), the two centre verticals (i top, l bottom) and four
// diagonals (h top left, j top right, k bottom left, m bottom right), so the
// month can be spelled, as on the original ("OCT").
const ALNUM = {
  0: 'abcdef', 1: 'bc', 2: 'abgGed', 3: 'abgGcd', 4: 'fgGbc', 5: 'afgGcd', 6: 'afgGedc', 7: 'abc', 8: 'abcdefgG', 9: 'abcdfgG',
  A: 'abcefgG', B: 'abcdGil', C: 'adef', D: 'abcdil', E: 'adefg', F: 'aefg', G: 'acdefG', J: 'bcde', L: 'def',
  M: 'bcefhj', N: 'bcefhm', O: 'abcdef', P: 'abefgG', R: 'abefgGm', S: 'afgGcd', T: 'ail', U: 'bcdef', V: 'efkj', Y: 'hjl',
  '-': 'gG', ' ': '',
}
// Unlit, only the seven-segment "8" shows faintly, as on the original.
const GHOST = 'abcdefgG'
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
// A bar from p0 to p1 with pointed ends, thickness t.
function hexBar([x0, y0], [x1, y1], t) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1
  const ux = (x1 - x0) / L, uy = (y1 - y0) / L, nx = -uy * t / 2, ny = ux * t / 2
  const e = Math.min(t / 2, L / 2)
  const pts = [[x0, y0], [x0 + ux * e + nx, y0 + uy * e + ny], [x1 - ux * e + nx, y1 - uy * e + ny], [x1, y1], [x1 - ux * e - nx, y1 - uy * e - ny], [x0 + ux * e - nx, y0 + uy * e - ny]]
  return pts.map(([a, b]) => a.toFixed(1) + ',' + b.toFixed(1)).join(' ')
}
function alnumRow(parent, { x, y, n, w, h, t, gap }) {
  const g = el('g', { class: 'tl-seg' }, parent)
  const cells = []
  for (let c = 0; c < n; c++) {
    const X = x + c * (w + gap)
    const L = X + t / 2, R = X + w - t / 2, Tp = y + t / 2, B = y + h - t / 2, M = y + h / 2, C = X + w / 2, s = t * 0.22, d = t * 1.2
    const bars = {
      a: [[L + s, Tp], [R - s, Tp], t], d: [[L + s, B], [R - s, B], t],
      f: [[L, Tp + s], [L, M - s], t], b: [[R, Tp + s], [R, M - s], t],
      e: [[L, M + s], [L, B - s], t], c: [[R, M + s], [R, B - s], t],
      g: [[L + s, M], [C - s * 0.6, M], t], G: [[C + s * 0.6, M], [R - s, M], t],
      i: [[C, Tp + t * 0.7], [C, M - t * 0.7], t * 0.8], l: [[C, M + t * 0.7], [C, B - t * 0.7], t * 0.8],
      h: [[L + d * 0.6, Tp + d], [C - t * 0.4, M - t * 0.8], t * 0.7], j: [[R - d * 0.6, Tp + d], [C + t * 0.4, M - t * 0.8], t * 0.7],
      k: [[L + d * 0.6, B - d], [C - t * 0.4, M + t * 0.8], t * 0.7], m: [[R - d * 0.6, B - d], [C + t * 0.4, M + t * 0.8], t * 0.7],
    }
    const segs = {}
    for (const [k, [p0, p1, th]] of Object.entries(bars)) segs[k] = el('polygon', { points: hexBar(p0, p1, th), class: GHOST.includes(k) ? 'off' : 'x' }, g)
    cells.push({ segs, ch: null })
  }
  return {
    set(s) {
      const chars = String(s).toUpperCase().padStart(n).slice(-n).split('')
      chars.forEach((ch, c) => {
        const cell = cells[c]
        if (cell.ch === ch) return
        cell.ch = ch
        const on = ALNUM[ch] ?? ''
        for (const k of Object.keys(cell.segs)) cell.segs[k].setAttribute('class', on.includes(k) ? 'on' : GHOST.includes(k) ? 'off' : 'x')
      })
    },
  }
}

// A seeded random, so the tile grain is the same on every load.
function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }

// Squeeze a text into maxW if it is wider (only on change: it measures).
function fit(t, maxW) {
  t.removeAttribute('textLength'); t.removeAttribute('lengthAdjust')
  let w = 0
  try { w = t.getComputedTextLength() } catch {}
  if (w > maxW) { t.setAttribute('textLength', maxW); t.setAttribute('lengthAdjust', 'spacingAndGlyphs') }
}

export default class TilesStyle extends GaugeStyle {
  static meta = {
    key: 'tiles', name: 'Tile grid', era: 'DeLorean-style', view: VIEW, dark: true,
    blurb: 'Grainy dark tiles: a speedometer with chrome digits, a tach with a fuel arc, four small dials, a time-circuit clock and a cassette.',
  }

  build() {
    const s = this.svg
    this.css(CSS)
    const defs = el('defs', {}, s)
    this.defs(defs)
    for (const r of Object.values(T)) this.tile(s, r)

    this.buildName(s)
    this.buildCal(s)
    this.small = Object.entries(SMALL).map(([key, d]) => this.smallDial(s, key, d))
    this.buildSpeed(s)
    this.buildTach(s)
    this.buildClock(s)
    this.buildTape(s)
  }

  defs(defs) {
    const lin = (name, stops, attrs = { x1: 0, y1: 0, x2: 0, y2: 1 }) => {
      const g = el('linearGradient', { id: this.id(name), ...attrs }, defs)
      for (const [o, c, op] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': op ?? 1 }, g)
    }
    lin('tile', [[0, '#1f1f1f'], [1, '#161616']])
    // Chrome digits: bright at the top, a hard step at the middle, dark below.
    lin('chrome', [[0, '#fbfbfb'], [0.42, '#d9d9d9'], [0.5, '#a9a9a9'], [0.8, '#8a8a8a'], [1, '#b4b4b4']])
    // Needles: a light upper half and a shaded lower one, turning with them.
    lin('needle', [[0, '#ffffff'], [0.5, '#e6e6e6'], [0.5, '#9d9d9d'], [1, '#bdbdbd']])
    lin('shell', [[0, '#bdbab1'], [0.6, '#a19e95'], [1, '#86837b']])
    const hub = el('radialGradient', { id: this.id('hub'), cx: 0.4, cy: 0.35, r: 0.7 }, defs)
    el('stop', { offset: 0, 'stop-color': '#3c3c3c' }, hub)
    el('stop', { offset: 1, 'stop-color': '#111111' }, hub)
    // Grain: a few hundred faint specks and two scratches in a 96 px pattern,
    // static, so it costs nothing per frame.
    const p = el('pattern', { id: this.id('grain'), width: 96, height: 96, patternUnits: 'userSpaceOnUse' }, defs)
    const r = rand(1985)
    let light = '', dark = ''
    for (let k = 0; k < 220; k++) {
      const x = (r() * 96).toFixed(1), y = (r() * 96).toFixed(1), w = (0.6 + r() * 1.2).toFixed(1)
      const d = `M${x} ${y}h${w}v${w}h-${w}z`
      if (r() < 0.5) light += d; else dark += d
    }
    el('path', { d: light, fill: '#ffffff', opacity: 0.045 }, p)
    el('path', { d: dark, fill: '#000000', opacity: 0.22 }, p)
    el('path', { d: 'M8 30 l34 9 M60 70 l22 -14', stroke: '#ffffff', 'stroke-width': 0.6, opacity: 0.05 }, p)
    // The rev meter's caption follows the rim on the right.
    el('path', { id: this.id('rpmarc'), d: arcPath(TACH.cx, BIG.cy, 126, -13, 25) }, defs)
  }

  tile(s, [x, y, w, h]) {
    el('rect', { x, y: y + 2, width: w, height: h, rx: 13, class: 'tl-shadow' }, s)
    el('rect', { x, y, width: w, height: h, rx: 13, fill: this.url('tile'), class: 'tl-tile' }, s)
    el('rect', { x, y, width: w, height: h, rx: 13, fill: this.url('grain') }, s)
    // The fine lighter edge along the top.
    el('path', { d: `M${x + 13} ${y + 1.2}H${x + w - 13}`, stroke: '#ffffff', 'stroke-opacity': 0.07, 'stroke-width': 1 }, s)
  }

  // ── Column 1, top: the engine's name, etched wide where the logo was ──
  buildName(s) {
    const [x, y, w, h] = T.name
    const cx = x + w / 2, cy = y + h / 2
    const etch = (dy, cls, size) => text(s, cx, cy + dy, 'tl-etch ' + cls, '', { 'font-size': size })
    this.nameT = [etch(-11, 'lo', 34), etch(-9, 'hi', 34), etch(-10, 'face', 34)]
    this.subT = [0, 1].map((k) => [etch(26 + k * 19, 'lo sub', 14), etch(28 + k * 19, 'hi sub', 14), etch(27 + k * 19, 'face sub', 14)])
  }

  // ── Column 1, bottom: two calendar-style entries ──
  buildCal(s) {
    const [x, y] = T.cal
    const tx = x + 22
    const entry = (y0, cls) => {
      el('rect', { x: x + 13, y: y0 - 15, width: 2.5, height: 62, class: cls }, s)
      return [
        text(s, tx, y0, 'tl-cal when ' + cls, ''),
        text(s, tx, y0 + 21, 'tl-cal what ' + cls, ''),
        text(s, tx, y0 + 41, 'tl-cal where ' + cls + ' dim', ''),
      ]
    }
    this.calY = entry(y + 36, 'tl-y')
    this.calR = entry(y + 116, 'tl-r')
    this.calW = T.cal[2] - 22 - 8
  }

  // ── Small dials ──
  smallDial(s, key, d) {
    const [x, y, w, h] = d.tile
    const cx = x + w / 2, cy = y + h / 2, R = SMALL_R
    const lo = d.stops[0], hi = d.stops[d.stops.length - 1]
    const span = hi[1] - lo[1], dir = Math.sign(span)
    el('circle', { cx, cy, r: R + 8, class: 'tl-ring line' }, s)
    const line = (a, r0, r1, cls, color) => {
      const [x0, y0] = polar(cx, cy, r0, a), [x1, y1] = polar(cx, cy, r1, a)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: 'tl-tk ' + cls, style: color ? `stroke:${color}` : null }, s)
    }
    // Faint ticks on the unused half, as on the original's printed face.
    const step = 90 / d.per
    for (let a = hi[1] + dir * step; dir > 0 ? a < lo[1] + 360 - 0.1 : a > lo[1] - 360 + 0.1; a += dir * step) line(a, R, R - 6, 'ghost')
    // Minor ticks, per quarter turn, then the majors at the stops.
    for (let k = 1; k < d.stops.length; k++) {
      const [v0, a0] = d.stops[k - 1], [v1, a1] = d.stops[k]
      const n = Math.round((Math.abs(a1 - a0) / 90) * d.per)
      for (let j = 1; j < n; j++) {
        const v = v0 + ((v1 - v0) * j) / n
        line(a0 + ((a1 - a0) * j) / n, R, R - 6, 'min', TICK_COL[d.tick(v)])
      }
    }
    for (const [v, a] of d.stops) {
      const c = d.majors[v]
      line(a, R + 1, R - 10, 'maj', c ? TICK_COL[c] : null)
    }
    for (const [v, label, color] of d.labels) {
      const [lx, ly] = polar(cx, cy, R * 0.6, stopAngle(d.stops, v))
      if (Array.isArray(label)) this.fraction(s, lx, ly, label[0], label[1])
      else text(s, lx.toFixed(1), ly.toFixed(1), 'tl-num sm', label, { style: color ? `fill:${color}` : null })
    }
    // The icon on the open side, a unit under it.
    const side = span > 0 ? 1 : -1 // left-hand scales open to the right
    this.icon(s, d.icon, cx + side * R * 0.66, cy)
    if (d.unit) text(s, cx + side * R * 0.66, cy + 30, 'tl-utag', d.unit)
    const needle = el('polygon', { points: `${cx - 3},${cy - 2.8} ${cx + R - 5},${cy - 0.7} ${cx + R - 5},${cy + 0.7} ${cx - 3},${cy + 2.8}`, fill: this.url('needle') }, s)
    el('circle', { cx: cx + 1, cy: cy + 2, r: 9, fill: '#000', opacity: 0.4 }, s)
    el('circle', { cx, cy, r: 8, fill: this.url('hub'), class: 'tl-hub' }, s)
    // The needle over its hub's shadow but under the cap, as on the original.
    s.appendChild(needle)
    return { key, d, cx, cy, needle, a: null }
  }

  // "¹⁄₂"-style fractions, as the original prints them.
  fraction(s, x, y, n, d) {
    const t = el('text', { x: x.toFixed(1), y: (y + 1).toFixed(1), class: 'tl-num sm' }, s)
    el('tspan', { 'font-size': 13, dy: -4 }, t).textContent = n
    el('tspan', { 'font-size': 16, dy: 4 }, t).textContent = '/'
    el('tspan', { 'font-size': 13, dy: 4 }, t).textContent = d
  }

  icon(s, kind, x, y) {
    const g = el('g', { class: 'tl-icon', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, s)
    if (kind === 'battery') {
      el('rect', { x: -10, y: -8, width: 20, height: 12, rx: 1.5 }, g)
      el('path', { d: 'M-7 -8 V-10.5 H-3.5 V-8 M3.5 -8 V-10.5 H7 V-8 M-7 -2 H-3 M3 -2 H7 M5 -4 V0 M-9 7 H9 M-7 9.5 H7' }, g)
    } else if (kind === 'oiltemp' || kind === 'oilcan') {
      // An oil can (the drop says oil); the thermometer says temperature.
      el('path', { d: 'M-12 -1 H-7 L-5 -4 H3 L12 -7 L4 5 H-7 Z M-1 -4 V-7 M-3 -7 H1' }, g)
      el('path', { d: 'M-12 -1 L-12 3 L-7 3' }, g)
      if (kind === 'oilcan') el('path', { class: 'fill', d: 'M12.5 0 q-2 3 0 5 q2 -2 0 -5' }, g)
      else {
        el('path', { d: 'M1 -9 V-19 M1 -16 H4 M1 -13 H4' }, g)
        el('circle', { class: 'fill', cx: 1, cy: -8, r: 2.2 }, g)
      }
    } else if (kind === 'pump') {
      el('path', { d: 'M-9 10 V-9 Q-9 -11 -7 -11 H1 Q3 -11 3 -9 V10 Z M-11 10 H5' }, g)
      el('rect', { class: 'fill', x: -7, y: -8.5, width: 8, height: 5, rx: 0.8 }, g)
      el('path', { d: 'M3 -3 H6 Q7.5 -3 7.5 -1.5 V5 Q7.5 7 9 7 Q10.5 7 10.5 5 V-5 L7.5 -8' }, g)
    }
    return g
  }

  // A band from a0 to a between radii rO and rI.
  band(cx, cy, a0, a) {
    if (a - a0 < 0.3) return ''
    const rO = BIG.bandO, rI = BIG.bandI, large = a - a0 > 180 ? 1 : 0, f = (n) => n.toFixed(1)
    const [ox0, oy0] = polar(cx, cy, rO, a0), [ox1, oy1] = polar(cx, cy, rO, a)
    const [ix1, iy1] = polar(cx, cy, rI, a), [ix0, iy0] = polar(cx, cy, rI, a0)
    return `M${f(ox0)} ${f(oy0)}A${rO} ${rO} 0 ${large} 1 ${f(ox1)} ${f(oy1)}L${f(ix1)} ${f(iy1)}A${rI} ${rI} 0 ${large} 0 ${f(ix0)} ${f(iy0)}Z`
  }

  bigTicks(g, cx, max, minorEvery, majorEvery, label, redFrom = Infinity) {
    const cy = BIG.cy
    for (let v = 0; v <= max + 0.01; v += minorEvery) {
      const a = dialAngle(v, 0, max, BIG.a0, BIG.a1)
      const major = Math.abs(v / majorEvery - Math.round(v / majorEvery)) < 1e-6, red = v >= redFrom
      const [x0, y0] = polar(cx, cy, BIG.tick, a), [x1, y1] = polar(cx, cy, BIG.tick - (major ? BIG.maj : BIG.min), a)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: 'tl-tk ' + (major ? 'maj' : 'min') + (red ? ' red' : '') }, g)
      if (major) {
        const [lx, ly] = polar(cx, cy, BIG.num, a)
        text(g, lx.toFixed(1), ly.toFixed(1), 'tl-num' + (red ? ' red' : ''), label(v))
      }
    }
  }

  turn(s, x, y, dir) {
    el('circle', { cx: x, cy: y, r: 12, class: 'tl-turn' }, s)
    // The original's yellow arrows, here unlit: the car tells us nothing.
    el('path', { d: 'M-7 0 L-1 -6 V-2.6 H7 V2.6 H-1 V6 Z', class: 'tl-arrow', transform: `translate(${x} ${y}) scale(${dir} 1)` }, s)
  }

  // ── Column 3: the speedometer ──
  buildSpeed(s) {
    const cx = SPEED.cx, cy = BIG.cy
    this.turn(s, T.speed[0] + 28, T.speed[1] + 28, 1)
    el('circle', { cx, cy, r: BIG.R, class: 'tl-ring' }, s)
    this.speedBand = el('path', { class: 'tl-band' }, s)
    this.bigTicks(el('g', {}, s), cx, SPEED.max, 10, 20, (v) => String(v))
    this.speedT = text(s, cx, cy + 22, 'tl-speed', '', { fill: this.url('chrome') })
    text(s, cx, cy + 45, 'tl-unit', 'KM/H')
  }

  // ── Column 4: the tachometer ──
  buildTach(s) {
    const cx = TACH.cx, cy = BIG.cy
    this.turn(s, T.tach[0] + T.tach[2] - 28, T.tach[1] + 28, -1)
    el('circle', { cx, cy, r: BIG.R, fill: 'rgba(0,0,0,0.14)' }, s)
    // The rim, broken where its caption runs.
    el('path', { d: arcPath(cx, cy, BIG.R, 29, 345), class: 'tl-ring line' }, s)
    this.tachBand = el('path', { class: 'tl-band' }, s)
    this.tachG = el('g', {}, s)
    const cap = el('text', { class: 'tl-cap' }, s)
    el('textPath', { href: '#' + this.id('rpmarc'), startOffset: '50%' }, cap).textContent = 'RPM × 100'

    // Fuel: the arc in the open bottom, lit white from 0.
    el('path', { d: arcPath(cx, cy, FUEL.r, FUEL.a0, FUEL.a1), class: 'tl-fuel-off' }, s)
    const [ex, ey] = polar(cx, cy, FUEL.r, FUEL.a1)
    el('circle', { cx: ex.toFixed(1), cy: ey.toFixed(1), r: 2.6, fill: '#8a8a8a' }, s)
    this.fuelArc = el('path', { class: 'tl-fuel-on' }, s)
    for (const [t, a, r] of [['0', 141, 140], ['2/4', 90, 141], ['4/4', 41, 143]]) {
      const [lx, ly] = polar(cx, cy, r, a)
      text(s, lx.toFixed(1), ly.toFixed(1), 'tl-flab', t)
    }
    // Range, with a pump.
    this.icon(s, 'pump', cx - 40, cy + 92)
    this.rangeT = text(s, cx - 24, cy + 99, 'tl-range', '')

    // The needle points along +x and turns about the hub; it runs out to
    // the rim, past the numerals, as on the original.
    el('circle', { cx: cx + 2, cy: cy + 4, r: 16, fill: '#000', opacity: 0.45 }, s)
    el('circle', { cx, cy, r: 15, fill: this.url('hub'), class: 'tl-hub' }, s)
    this.tachNeedle = el('polygon', { points: `${cx - 16},${cy - 4.4} ${cx + BIG.R - 9},${cy - 1} ${cx + BIG.R - 9},${cy + 1} ${cx - 16},${cy + 4.4}`, fill: this.url('needle') }, s)
    this.finger = el('circle', { r: 24, class: 'tl-finger', style: 'display:none' }, s)
    this.simTag = text(s, cx, cy - 44, 'tl-sim', 'SIM')
    this.simTag.style.display = 'none'
  }

  // ── Column 6, top: the time circuit ──
  buildClock(s) {
    const [x, y, w] = T.clock
    const cw = 15, ch = 24, ct = 3.2, cg = 3
    const field = (cx, top, n, label, plateW) => {
      el('rect', { x: cx - plateW / 2, y: top, width: plateW, height: 16, class: 'tl-plate' }, s)
      text(s, cx, top + 8.5, 'tl-platet', label)
      const W = n * cw + (n - 1) * cg, bw = W + 10
      el('rect', { x: cx - bw / 2, y: top + 19, width: bw, height: ch + 10, rx: 2, class: 'tl-lcd' }, s)
      el('rect', { x: cx - bw / 2 + 2, y: top + 21, width: bw - 4, height: ch + 6, class: 'tl-lcd-in' }, s)
      return alnumRow(s, { x: cx - W / 2, y: top + 24, n, w: cw, h: ch, t: ct, gap: cg })
    }
    const mid = x + w / 2
    this.mon = field(mid - 23.5, y + 8, 3, 'MONTH', 58)
    this.day = field(mid + 33.5, y + 8, 2, 'DAY', 38)
    this.year = field(mid, y + 66, 4, 'YEAR', 48)
    this.hour = field(mid - 24, y + 124, 2, 'HOUR', 44)
    this.min = field(mid + 24, y + 124, 2, 'MIN', 38)
  }

  // ── Column 6, bottom: a cassette with the engine on its label ──
  buildTape(s) {
    const [x, y, w] = T.tape
    const cx = x + w / 2, bw = 116, bh = 74, bx = cx - bw / 2, by = y + 20
    el('rect', { x: bx, y: by, width: bw, height: bh, rx: 5, fill: this.url('shell'), class: 'tl-shell' }, s)
    el('rect', { x: bx + 5, y: by + 4, width: bw - 10, height: bh - 22, rx: 2, class: 'tl-paper' }, s)
    this.tapeNum = text(s, bx + 9, by + 18, 'tl-ink', '', { 'font-size': 15 })
    // Ruled lines where a real label prints its track list.
    for (let k = 0; k < 3; k++) el('rect', { x: bx + 46 + k * 4, y: by + 8 + k * 5, width: 52 - k * 8, height: 1.4, fill: '#55524b', opacity: 0.55 }, s)
    // The window and the two reels, which turn while the engine runs.
    el('rect', { x: cx - 13, y: by + 23, width: 26, height: 12, rx: 1.5, class: 'tl-win' }, s)
    this.reels = [cx - 30, cx + 30].map((rx) => {
      el('circle', { cx: rx, cy: by + 29, r: 9, class: 'tl-reel' }, s)
      const g = el('g', { transform: `translate(${rx} ${by + 29})` }, s)
      el('circle', { r: 5, class: 'tl-reel-hub' }, g)
      for (let k = 0; k < 6; k++) {
        const [px, py] = polar(0, 0, 4.2, k * 60)
        el('circle', { cx: px.toFixed(2), cy: py.toFixed(2), r: 1.1, fill: '#1a1a1a' }, g)
      }
      return { g, rx, ry: by + 29 }
    })
    this.tapeLabel = text(s, cx, by + 53, 'tl-ink sm', '')
    // The bottom ramp with its four holes.
    el('path', { d: `M${bx + 16} ${by + bh}L${bx + 22} ${by + bh - 13}H${bx + bw - 22}L${bx + bw - 16} ${by + bh}`, fill: 'none', stroke: '#6f6c65', 'stroke-width': 1 }, s)
    for (const [dx, r] of [[30, 2.6], [42, 2], [bw - 42, 2], [bw - 30, 2.6]]) el('circle', { cx: bx + dx, cy: by + bh - 6, r, class: 'tl-hole' }, s)
    // Where the original shows the song's progress: the throttle.
    el('rect', { x: bx, y: y + 110, width: bw, height: 5, rx: 2.5, class: 'tl-prog' }, s)
    this.prog = el('rect', { x: bx, y: y + 110, width: 0, height: 5, rx: 2.5, class: 'tl-prog-on' }, s)
    this.progW = bw
    this.titleT = text(s, cx, y + 140, 'tl-title', '')
    this.artistT = text(s, cx, y + 161, 'tl-artist', '')
    this.reelA = 0; this.reelT = null
  }

  onScale(scale) {
    const g = this.tachG
    while (g.firstChild) g.removeChild(g.firstChild)
    // Numerals in hundreds, every thousand: 0 … 70 for a 7,000 rpm scale.
    this.bigTicks(g, TACH.cx, scale.max, 500, 1000, (v) => String(Math.round(v / 100)), scale.redFrom)
    this.tachA = null; this.tachBandA = null
  }

  rpmAt(x, y) {
    const cx = TACH.cx, cy = BIG.cy
    const d = Math.hypot(x - cx, y - cy)
    if (d > BIG.R + 10 || d < 18) return null
    let a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
    if (a < BIG.a0) a += 360
    // In the gap at the bottom, the nearer end.
    if (a > BIG.a1) a = a - BIG.a1 < BIG.a0 + 360 - a ? BIG.a1 : BIG.a0
    return ((a - BIG.a0) / (BIG.a1 - BIG.a0)) * this.scale.max
  }
  // Holding anywhere on the tach's tile revs the engine.
  tachHit(x, y) {
    const [tx, ty, tw, th] = T.tach
    return x >= tx && x <= tx + tw && y >= ty && y <= ty + th
  }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(TACH.cx, BIG.cy, (BIG.bandO + BIG.bandI) / 2, dialAngle(rpm, 0, this.scale.max, BIG.a0, BIG.a1))
    this.finger.setAttribute('cx', fx.toFixed(1)); this.finger.setAttribute('cy', fy.toFixed(1))
    this.finger.style.display = ''
  }
  onFingerUp() { this.finger.style.display = 'none' }
  onTouchMode(on) { this.simTag.style.display = on ? '' : 'none' }

  paint(force) {
    const v = this.v, i = this.i, cy = BIG.cy
    // Tach: the needle and the band behind it.
    const ta = dialAngle(v.rpm, 0, this.scale.max, BIG.a0, BIG.a1)
    if (force || this.tachA == null || Math.abs(ta - this.tachA) > 0.05) {
      this.tachA = ta
      this.tachNeedle.setAttribute('transform', `rotate(${ta.toFixed(2)} ${TACH.cx} ${cy})`)
      this.tachBand.setAttribute('d', this.band(TACH.cx, cy, BIG.a0, ta))
    }
    // Speed: the band from 0 to the speed, and the digits.
    const sa = dialAngle(v.kmh, 0, SPEED.max, BIG.a0, BIG.a1)
    if (force || this.speedA == null || Math.abs(sa - this.speedA) > 0.05) {
      this.speedA = sa
      this.speedBand.setAttribute('d', this.band(SPEED.cx, cy, BIG.a0, sa))
    }
    setText(this.speedT, i.stale ? '--' : String(Math.min(999, Math.round(v.kmh))))

    // Fuel: the tach's arc and the range under it. With the car read over
    // Bluetooth, fuel is its battery's charge and the range is the car's own.
    const fuel = clamp(v.fuel, 0, 1)
    const range = Math.round(i.running && Number.isFinite(i.rangeKm) ? i.rangeKm : fuel * RANGE_KM)
    if (force || this.fuelF == null || Math.abs(fuel - this.fuelF) > 0.002 || range !== this.rangeK) {
      this.fuelF = fuel; this.rangeK = range
      this.fuelArc.setAttribute('d', fuel > 0.005 ? arcPath(TACH.cx, cy, FUEL.r, FUEL.a0, FUEL.a0 + fuel * (FUEL.a1 - FUEL.a0)) : '')
      this.fuelArc.classList.toggle('low', fuel > 0 && fuel < 0.15)
      setText(this.rangeT, range + ' km')
    }

    // Small dials. With the engine off they rest on a peg just past the
    // bottom stop, clear of its numeral, as a real gauge does.
    for (const sd of this.small) {
      const st = sd.d.stops
      const a = i.running ? stopAngle(st, v[sd.key]) : st[0][1] - Math.sign(st[st.length - 1][1] - st[0][1]) * 12
      if (!force && sd.a != null && Math.abs(a - sd.a) < 0.05) continue
      sd.a = a
      sd.needle.setAttribute('transform', `rotate(${a.toFixed(2)} ${sd.cx} ${sd.cy})`)
    }

    // The time circuit: only when the minute changes.
    const c = i.clock instanceof Date ? i.clock : new Date()
    const stamp = c.getFullYear() * 1e8 + (c.getMonth() + 1) * 1e6 + c.getDate() * 1e4 + c.getHours() * 100 + c.getMinutes()
    const two = (n) => String(n).padStart(2, '0')
    if (force || stamp !== this.stamp) {
      this.stamp = stamp
      this.mon.set(MONTHS[c.getMonth()]); this.day.set(two(c.getDate()))
      this.year.set(String(c.getFullYear())); this.hour.set(two(c.getHours())); this.min.set(two(c.getMinutes()))
    }

    // The calendar: trip and odometer in yellow; clock, gear and source in red.
    const trip = (Math.floor(v.trip * 10) / 10 % 100000).toFixed(1) + ' km'
    const odo = 'ODO ' + Math.floor(v.odo % 1e6).toLocaleString('en-US') + ' km'
    const gear = i.gear === '–' || !i.running ? 'ENGINE OFF' : i.gear === 'N' ? 'NEUTRAL' : 'GEAR ' + i.gear
    const src = (i.source || 'GPS') + (i.stale ? ' · no fix' : ' speed')
    const lines = [['TRIP', this.calY[0]], [trip, this.calY[1]], [odo, this.calY[2]],
      [two(c.getHours()) + ':' + two(c.getMinutes()), this.calR[0]], [gear, this.calR[1]], [src, this.calR[2]]]
    for (const [str, t] of lines) {
      if (t.textContent === str) continue
      t.textContent = str
      fit(t, this.calW)
    }

    // The engine's name, split at its dot: "V10" and "LFA-style".
    if (force || i.car !== this.car) {
      this.car = i.car
      const [name, ...rest] = String(i.car || '').split(' · ')
      const style = rest.join(' · ')
      const nm = (name || '—').toUpperCase()
      // Wide, like the original's lettering: stretched to a set width.
      const wide = Math.min(T.name[2] - 22, Math.max(84, nm.length * 34))
      for (const t of this.nameT) { t.textContent = nm; t.setAttribute('textLength', wide); t.setAttribute('lengthAdjust', 'spacingAndGlyphs') }
      const sub = this.wrap(style.toUpperCase(), 12)
      this.subT.forEach((row, k) => row.forEach((t) => { t.textContent = sub[k] || ''; fit(t, T.name[2] - 16) }))
      setText(this.tapeNum, name || '')
      this.tapeLabel.textContent = style.toUpperCase(); fit(this.tapeLabel, 100)
      this.titleT.textContent = name || ''; fit(this.titleT, T.tape[2] - 16)
      this.artistT.textContent = style; fit(this.artistT, T.tape[2] - 16)
    }

    // The throttle as the tape's progress bar.
    const load = i.running ? clamp(v.load, 0, 1) : 0
    if (force || this.loadF == null || Math.abs(load - this.loadF) > 0.005) {
      this.loadF = load
      this.prog.setAttribute('width', (load * this.progW).toFixed(1))
    }
    // The reels turn slowly while the engine runs.
    const now = performance.now()
    if (i.running && this.reelT != null) {
      this.reelA = (this.reelA + (now - this.reelT) * 0.09) % 360
      for (const r of this.reels) r.g.setAttribute('transform', `translate(${r.rx} ${r.ry}) rotate(${this.reelA.toFixed(1)})`)
    }
    this.reelT = now
  }

  // Up to two lines of at most n characters, broken at spaces or hyphens.
  wrap(s, n) {
    if (s.length <= n) return [s]
    const words = s.split(/(?<=[ -])/)
    let a = ''
    while (words.length && (a + words[0]).trimEnd().length <= n) a += words.shift()
    if (!a) a = words.shift()
    return [a.trimEnd(), words.join('').trim()]
  }
}
