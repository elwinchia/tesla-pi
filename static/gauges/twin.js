// Twin dials, NSX-style: two big black dials side by side, the tach with a
// gear strip in its middle ("1 2 [3] 4 5") and the speedometer with a big
// digital speed and a fuel arc at its foot, and small half-dials at the
// outer edges: water temperature and oil pressure on the left, a g meter
// and battery volts on the right. A needle that moves leaves an orange
// trail on the rim that fades back into it (Trace in kit.js); at rest
// there is none.
//
// The wide geometric digits are drawn here as stroked paths, not set in a
// font: the car's browser has few fonts, and this keeps the look the same
// everywhere.
import { GaugeStyle, Trace, el, text, setText, polar, arcPath, dialAngle, clamp } from './kit.js'

// Wide (3.1:1): the dash gives the gauge everything beside its one column
// of buttons.
const VIEW = { w: 1240, h: 400 }
const CY = 200
const TACH = { cx: 430, r: 176, a0: 105, a1: 385 }
const SPEED = { cx: 810, r: 176, a0: 160, a1: 380, max: 200 }
// Fuel: E at the lower left of the speedometer's foot, F at the lower right.
const FUEL = { a0: 124, a1: 56, r: 150 }
// Side half-dials: ticks on the side facing the big dials.
const SIDE = {
  water: { cx: 132, cy: 118, r: 64, a0: 48, a1: -48, lo: 50, hi: 130 },
  oil:   { cx: 132, cy: 286, r: 64, a0: 48, a1: -48, lo: 0, hi: 8 },
  g:     { cx: 1108, cy: 118, r: 64 },
  volts: { cx: 1108, cy: 286, r: 64, a0: 132, a1: 228, lo: 8, hi: 16 },
}
const ORANGE = '#ff8a1a'
// Day: the same instrument printed for Tesla's light screen. Near-white
// faces with mid-grey rims on the floor grey, dark-grey ink, and a deeper
// orange for the trails and other accents so they hold on white.
const DAY_ORANGE = '#e8590c'
// The trail behind a moving needle: how slowly its tail follows (s).
const TRAIL_TAU = 0.45

const f1 = (x) => x.toFixed(1)
const rot = (a, cx, cy = CY) => `rotate(${a.toFixed(2)} ${cx} ${cy})`

// ── Stroke digits ────────────────────────────────────────────────────────
// Each glyph in a box 0.8 wide and 1 high (y down), as M/L/A/C commands
// with absolute coordinates; glyphPath() scales and places them.
const GW = 0.8
const ell = (cx, cy, rx, ry) => [['M', cx - rx, cy], ['A', rx, ry, 0, 1, 1, cx + rx, cy], ['A', rx, ry, 0, 1, 1, cx - rx, cy]]
const GLYPHS = {
  0: ell(0.4, 0.5, 0.4, 0.5),
  1: [['M', 0.2, 0.2], ['L', 0.5, 0], ['L', 0.5, 1]],
  2: [['M', 0.04, 0.27], ['A', 0.37, 0.27, 0, 0, 1, 0.78, 0.27], ['C', 0.78, 0.5, 0.3, 0.62, 0.02, 1], ['L', 0.8, 1]],
  3: [['M', 0.05, 0.2], ['A', 0.36, 0.24, 0, 1, 1, 0.38, 0.47], ['A', 0.4, 0.265, 0, 1, 1, 0.02, 0.82]],
  4: [['M', 0.6, 1], ['L', 0.6, 0], ['L', 0, 0.7], ['L', 0.8, 0.7]],
  5: [['M', 0.74, 0], ['L', 0.12, 0], ['L', 0.07, 0.45], ['C', 0.18, 0.4, 0.28, 0.38, 0.4, 0.38], ['A', 0.39, 0.31, 0, 1, 1, 0.02, 0.86]],
  6: [['M', 0.62, 0], ['L', 0.07, 0.52], ...ell(0.4, 0.66, 0.39, 0.33)],
  7: [['M', 0, 0], ['L', 0.8, 0], ['L', 0.28, 1]],
  8: [...ell(0.4, 0.245, 0.33, 0.245), ...ell(0.4, 0.725, 0.39, 0.275)],
  9: [['M', 0.18, 1], ['L', 0.73, 0.48], ...ell(0.4, 0.34, 0.39, 0.33)],
  N: [['M', 0.04, 1], ['L', 0.04, 0], ['L', 0.76, 1], ['L', 0.76, 0]],
  R: [['M', 0.06, 1], ['L', 0.06, 0], ['L', 0.5, 0], ['A', 0.25, 0.25, 0, 0, 1, 0.5, 0.5], ['L', 0.06, 0.5], ['M', 0.42, 0.5], ['L', 0.78, 1]],
  P: [['M', 0.06, 1], ['L', 0.06, 0], ['L', 0.5, 0], ['A', 0.25, 0.25, 0, 0, 1, 0.5, 0.5], ['L', 0.06, 0.5]],
  '-': [['M', 0.14, 0.52], ['L', 0.66, 0.52]],
  '.': [['M', 0.38, 0.97], ['L', 0.42, 0.97]],
}
GLYPHS['–'] = GLYPHS['-']
function glyphPath(ch, x, y, h) {
  const cmds = GLYPHS[ch]
  if (!cmds) return ''
  const X = (u) => f1(x + u * h), Y = (u) => f1(y + u * h)
  return cmds.map((c) => {
    if (c[0] === 'A') return `A${f1(c[1] * h)} ${f1(c[2] * h)} 0 ${c[4]} ${c[5]} ${X(c[6])} ${Y(c[7])}`
    if (c[0] === 'C') return `C${X(c[1])} ${Y(c[2])} ${X(c[3])} ${Y(c[4])} ${X(c[5])} ${Y(c[6])}`
    return `${c[0]}${X(c[1])} ${Y(c[2])}`
  }).join('')
}
// A string of glyphs `h` high centred on (cx, cy); a dot takes less room.
function rowPath(s, cx, cy, h, gap = h * 0.26) {
  const chars = [...String(s)]
  const adv = (ch) => (ch === '.' ? 0.4 * h : GW * h)
  const tw = chars.reduce((t, ch) => t + adv(ch), 0) + gap * Math.max(0, chars.length - 1)
  let x = cx - tw / 2
  let d = ''
  for (const ch of chars) {
    d += glyphPath(ch, ch === '.' ? x - 0.2 * h : x, cy - h / 2, h)
    x += adv(ch) + gap
  }
  return d
}

function fracAt(x, y, cx, cy, a0, a1) {
  let a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
  while (a < a0) a += 360
  while (a >= a0 + 360) a -= 360
  if (a <= a1) return (a - a0) / (a1 - a0)
  return a - a1 < a0 + 360 - a ? 1 : 0
}

export default class TwinStyle extends GaugeStyle {
  static meta = {
    key: 'twin', name: 'Twin dials', era: 'NSX-style', view: VIEW,
    blurb: 'Two big dials with needles that leave an orange trail, a gear strip and a digital speed; water, oil, g and volts at the edges.',
  }

  build() {
    const s = this.svg
    this.css(`
      .gs-twin text { font-family: 'Eurostile', 'Michroma', 'Avenir Next', 'Helvetica Neue', Roboto, Arial, sans-serif; font-stretch: expanded; fill: #e8e8e8; }
      .gs-twin .tw-lab { font-size: 16px; font-weight: 600; letter-spacing: 0.16em; text-anchor: middle; dominant-baseline: central; }
      .gs-twin .tw-dim { fill: #9a9a9a; }
      .gs-twin .tw-gnum { font-size: 22px; font-weight: 600; text-anchor: middle; dominant-baseline: central; letter-spacing: 0.04em; }
      .gs-twin .tw-glyph { fill: none; stroke-linecap: round; stroke-linejoin: round; }
      .gs-twin .tw-tick { stroke: #f2f2f2; stroke-linecap: round; }
      .gs-twin .tw-tick.dim { stroke: #8a8a8a; }
      .gs-twin .tw-icon { fill: none; stroke: #bdbdbd; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .gs-twin .tw-needle { stroke: ${ORANGE}; stroke-linecap: round; }
      .gs-twin .tw-red { stroke: #e8281e; }
      .gs-twin[data-zone=red] .tw-red { stroke: #ff3a24; }
      .gs-twin[data-zone=red] .tw-gear { stroke: #ff4a2a; }
      .gs-twin[data-zone=red] .tw-tach .tw-needle { stroke: #ff4a2a; }

      .gs-twin[data-theme=day] text { fill: #1f2124; }
      .gs-twin[data-theme=day] .tw-dim { fill: #5c5e62; }
      .gs-twin[data-theme=day] .tw-tick { stroke: #1f2124; }
      .gs-twin[data-theme=day] .tw-tick.dim { stroke: #85888c; }
      .gs-twin[data-theme=day] .tw-icon { stroke: #5c5e62; }
      .gs-twin[data-theme=day] .tw-ink { stroke: #1f2124; }
      .gs-twin[data-theme=day] .tw-sub { stroke: #393c41; }
      .gs-twin[data-theme=day] .tw-nb { stroke: #a4a7ab; }
      .gs-twin[data-theme=day] .tw-track { stroke: #cdd0d3; }
      .gs-twin[data-theme=day] .tw-accent { stroke: ${DAY_ORANGE}; }
      .gs-twin[data-theme=day] .tw-gdot { fill: ${DAY_ORANGE}; stroke: #fff; }
      .gs-twin[data-theme=day] .tw-gdec { fill: ${DAY_ORANGE}; }
      .gs-twin[data-theme=day] .tw-trail stop { stop-color: ${DAY_ORANGE}; }
      .gs-twin[data-theme=day][data-zone=red] .tw-gear { stroke: #e8281e; }
      .gs-twin[data-theme=day] .tw-shadow { opacity: 0.22; filter: url(#${this.id('soft')}); }
      .gs-twin[data-theme=day] .tw-rim { stroke: #b5b8bb; stroke-width: 3; }
      .gs-twin[data-theme=day] .tw-srim { stroke: #c4c7ca; stroke-width: 2.5; }
      .gs-twin[data-theme=day] .tw-f0 { stop-color: #fbfbfb; }
      .gs-twin[data-theme=day] .tw-f1 { stop-color: #f3f3f3; }
      .gs-twin[data-theme=day] .tw-f2 { stop-color: #e7e8e9; }
      .gs-twin[data-theme=day] .tw-s0 { stop-color: #fafafa; }
      .gs-twin[data-theme=day] .tw-s1 { stop-color: #efeff0; }
    `)
    const defs = el('defs', {}, s)
    const face = el('radialGradient', { id: this.id('face'), cx: 0.5, cy: 0.45, r: 0.55 }, defs)
    el('stop', { offset: 0, 'stop-color': '#0b0b0d', class: 'tw-f0' }, face)
    el('stop', { offset: 0.85, 'stop-color': '#030304', class: 'tw-f1' }, face)
    el('stop', { offset: 1, 'stop-color': '#111114', class: 'tw-f2' }, face)
    const small = el('radialGradient', { id: this.id('small'), cx: 0.5, cy: 0.5, r: 0.5 }, defs)
    el('stop', { offset: 0, 'stop-color': '#0e0e11', class: 'tw-s0' }, small)
    el('stop', { offset: 1, 'stop-color': '#08080a', class: 'tw-s1' }, small)
    // Day only (CSS): the faces' shadow, blurred and dropped a little.
    const soft = el('filter', { id: this.id('soft'), x: -0.1, y: -0.1, width: 1.2, height: 1.25 }, defs)
    el('feOffset', { dy: 3 }, soft)
    el('feGaussianBlur', { stdDeviation: 4 }, soft)

    this.buildSides()
    for (const d of [TACH, SPEED]) {
      el('circle', { cx: d.cx, cy: CY, r: d.r + 3, fill: '#000', opacity: 0.55, class: 'tw-shadow' }, s)
      el('circle', { cx: d.cx, cy: CY, r: d.r, fill: this.url('face'), stroke: '#2a2a30', 'stroke-width': 1.5, class: 'tw-rim' }, s)
    }
    this.buildTach()
    this.buildSpeed()
    this.last = {}
  }

  tick(parent, cx, cy, a, r0, r1, wd, cls = 'tw-tick') {
    const [x0, y0] = polar(cx, cy, r0, a), [x1, y1] = polar(cx, cy, r1, a)
    return el('line', { x1: f1(x0), y1: f1(y0), x2: f1(x1), y2: f1(y1), class: cls, 'stroke-width': wd }, parent)
  }

  glyphs(parent, s, cx, cy, h, sw, stroke, cls = '') {
    return el('path', { d: rowPath(s, cx, cy, h), class: 'tw-glyph ' + cls, stroke, 'stroke-width': sw }, parent)
  }

  // The trail a moving needle leaves, clipped to its scale: a band exactly
  // as long as the needle, from r0 to r1 out from the centre, so it reads
  // as the needle smeared by its own movement.
  trail(parent, name, cx, r0, r1, clipId) {
    const t = new Trace(parent, this.id(name), { cx, cy: CY, r: (r0 + r1) / 2, color: ORANGE, tau: TRAIL_TAU, clip: clipId,
      layers: [[r1 - r0, 0.8]] })
    t.fade.classList.add('tw-trail')
    return t
  }
  wedge(id, cx, r, a0, a1) {
    const cp = el('clipPath', { id }, this.svg.querySelector('defs'))
    const [x0, y0] = polar(cx, CY, r, a0), [x1, y1] = polar(cx, CY, r, a1)
    el('path', { d: `M${cx} ${CY}L${f1(x0)} ${f1(y0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f1(x1)} ${f1(y1)}Z` }, cp)
  }

  buildTach() {
    const { cx, r } = TACH
    const g = el('g', { class: 'tw-tach' }, this.svg)
    this.scaleG = el('g', {}, g)
    this.wedge(this.id('tclip'), cx, r + 4, TACH.a0, TACH.a1)
    this.tachTail = this.trail(g, 'ttrail', cx, r - 44, r - 2, this.id('tclip'))
    this.tachNeedle = el('g', {}, g)
    el('line', { x1: cx + r - 2, y1: CY, x2: cx + r - 44, y2: CY, class: 'tw-needle', 'stroke-width': 4 }, this.tachNeedle)
    text(g, cx + 42, CY + 140, 'tw-lab tw-dim', 'x1000r/min', { style: 'font-size:16px;letter-spacing:0.06em' })
    // Gear strip: the gear large, its neighbours small and grey.
    this.gear = this.glyphs(g, '', cx, CY, 72, 4.6, '#f4f4f4', 'tw-gear tw-ink')
    this.gearNb = el('path', { class: 'tw-glyph tw-nb', stroke: '#6c6c70', 'stroke-width': 2.6 }, g)
    this.finger = el('circle', { r: 24, class: 'rv-finger', style: 'display:none' }, g)
  }

  buildSpeed() {
    const { cx, r } = SPEED
    const g = el('g', { class: 'tw-speed' }, this.svg)
    for (let v = 0; v <= SPEED.max; v += 10) {
      const a = dialAngle(v, 0, SPEED.max, SPEED.a0, SPEED.a1)
      const major = v % 20 === 0
      this.tick(g, cx, CY, a, r - 8, major ? r - 22 : r - 14, major ? 4 : 2, major ? 'tw-tick' : 'tw-tick dim')
      if (v % 20 === 0) {
        const [x, y] = polar(cx, CY, r - 52, a)
        this.glyphs(g, String(v), x, y, 16, 2.2, '#9c9ca0', 'tw-sub')
      }
    }
    this.wedge(this.id('sclip'), cx, r + 4, SPEED.a0, SPEED.a1)
    this.speedTail = this.trail(g, 'strail', cx, r - 36, r - 2, this.id('sclip'))
    this.speedNeedle = el('g', {}, g)
    el('line', { x1: cx + r - 2, y1: CY, x2: cx + r - 36, y2: CY, class: 'tw-needle', 'stroke-width': 4 }, this.speedNeedle)
    this.kmh = this.glyphs(g, '0', cx, CY - 8, 66, 4.2, '#f6f6f6', 'tw-ink')
    text(g, cx, CY + 50, 'tw-lab', 'KM/H')
    // Fuel, E to F along the foot: grey track, red reserve, orange level.
    const fr = FUEL.r
    el('path', { d: arcPath(cx, CY, fr, FUEL.a0, FUEL.a1), fill: 'none', stroke: '#3a3a40', 'stroke-width': 5, class: 'tw-track' }, g)
    el('path', { d: arcPath(cx, CY, fr, FUEL.a0, FUEL.a0 - 8), fill: 'none', class: 'tw-red', 'stroke-width': 5 }, g)
    for (let k = 0; k <= 4; k++) this.tick(g, cx, CY, FUEL.a0 + (k / 4) * (FUEL.a1 - FUEL.a0), fr + 4, fr + (k % 2 ? 10 : 14), k % 2 ? 2 : 3, 'tw-tick dim')
    this.fuelArc = el('path', { fill: 'none', stroke: ORANGE, 'stroke-width': 5, class: 'tw-accent' }, g)
    const [ex, ey] = polar(cx, CY, fr - 22, FUEL.a0 + 2), [fx, fy] = polar(cx, CY, fr - 22, FUEL.a1 - 2)
    text(g, f1(ex), f1(ey), 'tw-lab tw-dim', 'E')
    text(g, f1(fx), f1(fy), 'tw-lab tw-dim', 'F')
  }

  // The small half-dials at the edges.
  buildSides() {
    const g = el('g', { class: 'tw-sides' }, this.svg)
    this.sides = {}
    for (const [k, d] of Object.entries(SIDE)) {
      el('circle', { cx: d.cx, cy: d.cy, r: d.r, fill: this.url('small'), stroke: '#202026', 'stroke-width': 1.5, class: 'tw-srim' }, g)
    }
    const scale = (k, labels, redAt, icon) => {
      const d = SIDE[k]
      for (let j = 0; j <= 4; j++) {
        const a = d.a0 + (j / 4) * (d.a1 - d.a0)
        const red = j === redAt
        this.tick(g, d.cx, d.cy, a, d.r - 6, d.r - (j % 2 ? 13 : 17), red ? 4 : 3, red ? 'tw-red' : 'tw-tick')
      }
      for (const [v, s] of labels) {
        const [x, y] = polar(d.cx, d.cy, d.r - 31, dialAngle(v, d.lo, d.hi, d.a0, d.a1))
        text(g, f1(x), f1(y), 'tw-gnum', s, { style: 'font-size:16px' })
      }
      this.icon(g, icon, d.cx + (d.a0 < 90 ? -22 : 22), d.cy)
      const n = el('line', { x1: d.cx + d.r - 4, y1: d.cy, x2: d.cx + d.r - 20, y2: d.cy, class: 'tw-needle', 'stroke-width': 6 }, g)
      this.sides[k] = n
    }
    scale('water', [], 4, 'temp')
    scale('oil', [[0, '0'], [4, '4'], [8, '8']], 0, 'oil')
    scale('volts', [[8, '8'], [12, '12'], [16, '16']], 0, 'batt')
    // The g meter: four ticks, a dot that slides with longitudinal g, the
    // reading in the middle with its tenths in orange.
    const d = SIDE.g
    for (const a of [0, 90, 180, 270]) this.tick(g, d.cx, d.cy, a, d.r - 6, d.r - 16, 3)
    el('line', { x1: d.cx - 44, y1: d.cy, x2: d.cx + 44, y2: d.cy, stroke: '#2e2e34', 'stroke-width': 2, class: 'tw-track' }, g)
    this.gDot = el('circle', { cx: d.cx, cy: d.cy, r: 6.5, fill: ORANGE, stroke: '#ffd2a0', 'stroke-width': 1.5, class: 'tw-gdot' }, g)
    const t = text(g, d.cx + 4, d.cy - 22, 'tw-gnum', '')
    this.gInt = el('tspan', {}, t); this.gInt.textContent = '0.'
    this.gDec = el('tspan', { fill: ORANGE, class: 'tw-gdec' }, t); this.gDec.textContent = '0'
    text(g, d.cx, d.cy + 30, 'tw-lab', 'G')
  }

  icon(parent, kind, x, y) {
    const g = el('g', { class: 'tw-icon', transform: `translate(${x} ${y})` }, parent)
    if (kind === 'temp') {
      el('path', { d: 'M0 -14 V2' }, g)
      el('circle', { cx: 0, cy: 5, r: 3.5 }, g)
      el('path', { d: 'M3 -11 H7 M3 -6 H7 M-12 12 q3 -3 6 0 t6 0 t6 0 t6 0' }, g)
    } else if (kind === 'oil') {
      el('path', { d: 'M-13 -2 H3 L12 -7 L5 6 H-9 Z M-5 -2 V-7 M-9 -7 H-1 M13 3 Q14.5 7 13 8' }, g)
    } else {
      el('rect', { x: -12, y: -8, width: 24, height: 16, rx: 2 }, g)
      el('path', { d: 'M-8 -11 V-8 M8 -11 V-8 M-8 0 H-3 M3 0 H8 M5.5 -2.5 V2.5' }, g)
    }
  }

  onScale(scale) {
    const { cx, r } = TACH
    const g = this.scaleG
    while (g.firstChild) g.removeChild(g.firstChild)
    const ang = (v) => dialAngle(v, 0, scale.max, TACH.a0, TACH.a1)
    // The grey inner track the reference runs inside the ticks.
    el('path', { d: arcPath(cx, CY, r - 32, TACH.a0, ang(scale.redFrom)), fill: 'none', stroke: '#3c3c42', 'stroke-width': 2.5, class: 'tw-track' }, g)
    // The red zone: a solid rounded block on the rim, split where the
    // redline sits a whole thousand short of the end.
    el('path', { d: arcPath(cx, CY, r - 15, ang(scale.redFrom) + 1, TACH.a1), fill: 'none', class: 'tw-red', 'stroke-width': 14, 'stroke-linecap': 'round' }, g)
    for (let v = 0; v <= scale.max; v += 500) {
      const a = ang(v), major = v % 1000 === 0
      if (v < scale.redFrom) this.tick(g, cx, CY, a, r - 8, major ? r - 24 : r - 15, major ? 4.5 : 2.2)
      if (!major) continue
      const [x, y] = polar(cx, CY, r - 62, a)
      this.glyphs(g, String(v / 1000), x, y, 25, 4.2, '#f4f4f4', 'tw-ink')
    }
    this.last = {}
  }

  rpmAt(x, y) {
    const { cx, r } = TACH
    if (Math.hypot(x - cx, y - CY) > r + 10) return null
    return fracAt(x, y, cx, CY, TACH.a0, TACH.a1) * this.scale.max
  }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(TACH.cx, CY, TACH.r - 24, dialAngle(rpm, 0, this.scale.max, TACH.a0, TACH.a1))
    this.finger.setAttribute('cx', f1(fx)); this.finger.setAttribute('cy', f1(fy))
    this.finger.style.display = ''
    this.finger.classList.toggle('red', rpm >= this.scale.redFrom)
  }
  onFingerUp() { this.finger.style.display = 'none' }

  moved(key, val, force) {
    if (!force && this.last[key] === val) return false
    this.last[key] = val
    return true
  }

  // Gear strip: lower gears to the left, higher to the right.
  paintGear(gear) {
    const { cx } = TACH
    this.gear.setAttribute('d', rowPath(gear, cx, CY, 72))
    const n = Number(gear)
    let lo = [], hi = []
    if (Number.isInteger(n) && n > 0) {
      lo = [n - 2, n - 1].filter((x) => x >= 1)
      hi = [n + 1, n + 2].filter((x) => x <= Math.max(6, n))
    } else if (gear === 'N') hi = [1, 2]
    else if (gear === 'R') hi = ['N', 1]
    let d = ''
    const at = (k) => (k === 1 ? 50 : 74)
    lo.slice().reverse().forEach((x, k) => { d += rowPath(String(x), cx - at(k + 1), CY, 22) })
    hi.forEach((x, k) => { d += rowPath(String(x), cx + at(k + 1), CY, 22) })
    this.gearNb.setAttribute('d', d)
  }

  paint(force) {
    if (!this.sides || !this.scale) return
    const v = this.v, i = this.i
    const q = (a) => Math.round(a * 10) / 10
    const ta = q(dialAngle(v.rpm, 0, this.scale.max, TACH.a0, TACH.a1))
    // Trails every frame: a needle that has stopped still has one to fade.
    this.tachTail.update(ta)
    if (this.moved('tach', ta, force)) this.tachNeedle.setAttribute('transform', rot(ta, TACH.cx))
    const sa = q(dialAngle(v.kmh, 0, SPEED.max, SPEED.a0, SPEED.a1))
    this.speedTail.update(sa)
    if (this.moved('speed', sa, force)) this.speedNeedle.setAttribute('transform', rot(sa, SPEED.cx))
    const gear = i.gear || '–'
    if (this.moved('gear', gear, force)) this.paintGear(gear)
    const kmh = i.stale ? '--' : String(Math.min(999, Math.round(v.kmh)))
    if (this.moved('kmh', kmh, force)) this.kmh.setAttribute('d', rowPath(kmh, SPEED.cx, CY - 8, 66))
    const fa = q(dialAngle(v.fuel, 0, 1, FUEL.a0, FUEL.a1))
    if (this.moved('fuel', fa, force)) this.fuelArc.setAttribute('d', FUEL.a0 - fa > 0.3 ? arcPath(SPEED.cx, CY, FUEL.r, FUEL.a0, fa) : '')
    for (const [k, val] of [['water', v.water], ['oil', v.oilPress], ['volts', v.volts]]) {
      const d = SIDE[k]
      const a = q(dialAngle(val, d.lo, d.hi, d.a0, d.a1))
      if (this.moved(k, a, force)) this.sides[k].setAttribute('transform', rot(a, d.cx, d.cy))
    }
    // g: the dot goes left as the car pulls forward, as the body is pushed
    // back; a full g is 44 units.
    const g = clamp(v.g, -1.2, 1.2)
    const gx = Math.round(-g * 44 * 10) / 10
    if (this.moved('gx', gx, force)) this.gDot.setAttribute('cx', f1(SIDE.g.cx + clamp(gx, -44, 44)))
    const gs = Math.abs(g).toFixed(1)
    setText(this.gInt, gs.slice(0, 2)); setText(this.gDec, gs.slice(2))
  }
}
