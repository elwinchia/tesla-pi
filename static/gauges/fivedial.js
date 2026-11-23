// Five dials, 911-style: five round dials in a dark oval housing, as on the
// concept this copies. Left to right: battery volts and oil temperature (a
// split dial), water temperature and oil pressure (split), the big
// tachometer with the gear and a boost bar, the speedometer with a digital
// readout, and a clock with three small chronograph dials.
//
// Every needle is drawn the same way: a glowing orange arc along the rim
// from the start of the scale, brightest at the needle, and the needle
// itself, a glowing stroke from the rim inwards. Numerals are a wide,
// medium-weight sans (stretched sideways, since no system font is
// reliably extended); the big gear and speed digits are thin.
import { GaugeStyle, el, text, setText, polar, arcPath, dialAngle, clamp, hhmm } from './kit.js'

// About 3.2:1, the gauge area's shape. The reference is wider (3.9:1), so
// the side dials are a little smaller next to the tach than on it.
const VIEW = { w: 1136, h: 352 }
const CY = 176
const D = {
  batt:  { cx: 106,  R: 86 },
  temp:  { cx: 310,  R: 110 },
  tach:  { cx: 568,  R: 140 },
  speed: { cx: 826,  R: 110 },
  clock: { cx: 1030, R: 86 },
}
// Rings, as fractions of a dial's outer radius R (measured off the
// reference): the bezel's lit edge, a dark channel the orange arc runs in,
// a thin grey line round the face, ticks inside that.
const RING = { channel: 0.972, arc: 0.94, face: 0.905, tick: 0.8, major: 0.11, minor: 0.045, num: 0.6 }
// Tach: 0 rpm at lower left, round over the top, the scale's end at lower
// right; the gap at the bottom holds the boost bar and "RPM×1000".
const TACH = { a0: 125, a1: 395 }
// Speedometer: 0–200 km/h over the same sweep as the reference's 0–250.
const SPEED = { a0: 133, a1: 413, max: 200 }
// Split dials: each half climbs its own side from the bottom up.
const LEFT = { a0: 125, a1: 235 }
const RIGHT = { a0: 55, a1: -55 }
const ORANGE = '#ff5a24'
const SX = 1.2  // the numerals' sideways stretch

const f1 = (x) => x.toFixed(1)
const rot = (a, cx, cy = CY) => `rotate(${a.toFixed(2)} ${cx} ${cy})`

// The value's fraction under a point on a dial from a0 to a1 (a1 > a0, the
// gap is the rest of the circle); a point in the gap snaps to the nearer end.
function fracAt(x, y, cx, cy, a0, a1) {
  let a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
  while (a < a0) a += 360
  while (a >= a0 + 360) a -= 360
  if (a <= a1) return (a - a0) / (a1 - a0)
  return a - a1 < a0 + 360 - a ? 1 : 0
}

// A fixed pseudo-random sequence, for the housing's grain.
function rng(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) }

export default class FiveDialStyle extends GaugeStyle {
  static meta = {
    key: 'fivedial', name: 'Five dials', era: '911-style', view: VIEW, dark: true,
    blurb: 'Five round dials in an oval: battery and oil, water and oil pressure, the tach with the gear, speed, and a clock.',
  }

  build() {
    const s = this.svg
    this.css(`
      .gs-fivedial text { font-family: "Helvetica Neue", -apple-system, system-ui, sans-serif; fill: #f4f4f4; }
      .gs-fivedial .fd-num { font-size: 17px; font-weight: 600; text-anchor: middle; dominant-baseline: central; }
      .gs-fivedial .fd-num.red { fill: #ff5a3c; }
      .gs-fivedial .fd-snum { font-size: 15px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
      .gs-fivedial .fd-end { font-size: 15px; font-weight: 500; text-anchor: middle; dominant-baseline: central; fill: #ececec; }
      .gs-fivedial .fd-stack { font-size: 14px; font-weight: 600; text-anchor: middle; dominant-baseline: central; fill: #e8e8e8; }
      .gs-fivedial .fd-cap { font-size: 15px; font-weight: 600; text-anchor: middle; letter-spacing: 0.42em; fill: #a9a9ab; }
      .gs-fivedial .fd-small { font-size: 14px; font-weight: 500; text-anchor: middle; fill: #cfcfcf; }
      .gs-fivedial .fd-rpmx { font-size: 14px; font-weight: 500; letter-spacing: 0.2em; fill: #9a9a9c; }
      .gs-fivedial .fd-gear { font-size: 74px; font-weight: 200; text-anchor: middle; fill: #ededed; filter: drop-shadow(0 0 5px rgba(255,255,255,0.22)); }
      .gs-fivedial[data-zone=red] .fd-gear { fill: #ff7a50; }
      .gs-fivedial .fd-kmh { font-size: 40px; font-weight: 200; text-anchor: middle; fill: #ececec; }
      .gs-fivedial .fd-unit { font-size: 15px; font-weight: 600; text-anchor: middle; fill: #a9a9ab; }
      .gs-fivedial .fd-odo { font-size: 14px; font-weight: 500; text-anchor: middle; dominant-baseline: central; letter-spacing: 0.06em; fill: #b9b9bb; font-variant-numeric: tabular-nums; }
      .gs-fivedial .fd-trip { font-size: 15px; font-weight: 500; fill: #f0f0f0; font-variant-numeric: tabular-nums; }
      .gs-fivedial .fd-trip tspan { fill: #a9a9ab; font-weight: 400; }
      .gs-fivedial .fd-tick { stroke: #f2f2f2; stroke-linecap: butt; }
      .gs-fivedial .fd-tick.min { stroke: #77777a; }
      .gs-fivedial .fd-tick.dim { stroke: #5a2219; }
      .gs-fivedial .fd-tick.red { stroke: ${ORANGE}; }
      .gs-fivedial .fd-icon { fill: none; stroke: #e6e6e6; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .gs-fivedial .fd-icon .fill { fill: #e6e6e6; stroke: none; }
      .gs-fivedial .fd-div { fill: none; stroke: #343437; stroke-width: 1.6; }
    `)
    this.defs = el('defs', {}, s)
    this.housing()
    for (const [k, d] of Object.entries(D)) this.dial(k, d.cx, d.R)

    this.halves = []
    this.buildSplit('batt', D.batt, {
      left: { word: 'BATT', key: 'volts', lo: 8, hi: 16, ends: ['8', '16'], icon: 'batt' },
      right: { word: 'OEL', key: 'oilTemp', lo: 50, hi: 150, ends: ['L', 'H'], icon: 'oiltemp' },
    })
    this.buildSplit('temp', D.temp, {
      left: { word: 'TEMP', key: 'water', lo: 50, hi: 130, ends: ['L', 'H'], icon: 'water' },
      right: { word: 'DRUCK', key: 'oilPress', lo: 0, hi: 10, ends: ['0', '10'], icon: 'oil', thirds: true },
    })
    this.buildTach()
    this.buildSpeed()
    this.buildClock()
    this.last = {}
  }

  // ── Shared parts ──────────────────────────────────────────────────────

  grad(kind, name, attrs, stops) {
    const g = el(kind, { id: this.id(name), ...attrs }, this.defs)
    for (const [o, c, a = 1] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, g)
    return g
  }

  // The oval housing: a dark, finely grained stadium whose top and bottom
  // bow out a little, with a lit rim along the top.
  housing() {
    const { w, h } = VIEW, L = 3, Rt = w - 3, T = 3, B = h - 3
    const sh = 292  // where the shoulders meet the bowed top and bottom
    const d = `M${L} ${CY}C${L} ${CY - 128} ${L + 78} ${T + 25} ${L + sh} ${T + 15}` +
      `Q${w / 2} ${T - 9} ${Rt - sh} ${T + 15}C${Rt - 78} ${T + 25} ${Rt} ${CY - 128} ${Rt} ${CY}` +
      `C${Rt} ${CY + 128} ${Rt - 78} ${B - 25} ${Rt - sh} ${B - 15}` +
      `Q${w / 2} ${B + 9} ${L + sh} ${B - 15}C${L + 78} ${B - 25} ${L} ${CY + 128} ${L} ${CY}Z`
    // Grain: a tile of faint specks, cheaper than a noise filter.
    const pat = el('pattern', { id: this.id('grain'), width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, this.defs)
    el('rect', { width: 24, height: 24, fill: '#141415' }, pat)
    const r = rng(7)
    for (let k = 0; k < 46; k++) {
      el('rect', { x: f1(r() * 24), y: f1(r() * 24), width: 1, height: 1, fill: r() > 0.5 ? '#1f1f21' : '#0c0c0d' }, pat)
    }
    this.grad('radialGradient', 'hshade', { cx: 0.5, cy: 0.3, r: 0.7 }, [[0, '#2a2a2c', 0.35], [0.6, '#000', 0], [1, '#000', 0.45]])
    this.grad('linearGradient', 'hrim', { x1: 0, y1: 0, x2: 0, y2: 1 }, [[0, '#4a4a4d'], [0.35, '#2a2a2c'], [1, '#121213']])
    el('path', { d, fill: this.url('grain') }, this.svg)
    el('path', { d, fill: this.url('hshade') }, this.svg)
    el('path', { d, fill: 'none', stroke: this.url('hrim'), 'stroke-width': 1.6 }, this.svg)
    // A second, darker lip just inside the rim.
    el('path', { d, fill: 'none', stroke: '#000', 'stroke-opacity': 0.55, 'stroke-width': 2,
      transform: `translate(${w / 2} ${CY}) scale(0.992 0.972) translate(${-w / 2} ${-CY})` }, this.svg)
  }

  // A dial: a dark recess round it, the bezel with its lit top edge, the
  // dark channel, and the face with a thin grey line round it (brighter at
  // the bottom, where the light catches it).
  dial(k, cx, R) {
    this.grad('radialGradient', 'halo-' + k, { cx: 0.5, cy: 0.5, r: 0.5 }, [[R / (R + 14), '#000', 0.75], [1, '#000', 0]])
    el('circle', { cx, cy: CY + 2, r: R + 14, fill: this.url('halo-' + k) }, this.svg)
    if (!this.dialDefs) {
      this.dialDefs = true
      this.grad('linearGradient', 'bezel', { x1: 0, y1: 0, x2: 0, y2: 1 }, [[0, '#3c3c3f'], [0.45, '#18181a'], [1, '#0a0a0b']])
      this.grad('radialGradient', 'face', { cx: 0.5, cy: 0.4, r: 0.62 }, [[0, '#1d1d1f'], [0.75, '#141415'], [1, '#0e0e0f']])
      this.grad('linearGradient', 'line', { x1: 0, y1: 0, x2: 0, y2: 1 }, [[0, '#2c2c2f'], [0.6, '#2c2c2f'], [1, '#4c4c50']])
    }
    el('circle', { cx, cy: CY, r: R, fill: this.url('bezel') }, this.svg)
    el('circle', { cx, cy: CY, r: R * RING.channel, fill: '#0a0a0b' }, this.svg)
    el('circle', { cx, cy: CY, r: R * RING.face, fill: this.url('face'), stroke: this.url('line'), 'stroke-width': 1.3 }, this.svg)
  }

  tick(parent, cx, a, r0, r1, wd, cls = 'fd-tick') {
    const [x0, y0] = polar(cx, CY, r0, a), [x1, y1] = polar(cx, CY, r1, a)
    return el('line', { x1: f1(x0), y1: f1(y0), x2: f1(x1), y2: f1(y1), class: cls, 'stroke-width': wd }, parent)
  }
  // Text stretched sideways about its own centre.
  wide(parent, x, y, cls, s, sx = SX) {
    return text(parent, 0, 0, cls, s, { transform: `translate(${f1(x)} ${f1(y)}) scale(${sx} 1)` })
  }

  // The orange needle: an arc along the rim from the scale's start a0 to
  // the value, fading out towards a0, and a radial stroke from the rim to
  // rIn that fades inwards. `shade` adds the needle's soft shadow on the
  // side not yet swept (the big dials). Returns a painter for an angle.
  sweep(parent, name, cx, R, { a0, rIn, w = 1, shade = false, fade = 0.85 }) {
    const rA = R * RING.arc
    const [sx, sy] = polar(cx, CY, rA, a0)
    this.grad('radialGradient', name + '-fade', { gradientUnits: 'userSpaceOnUse', cx: f1(sx), cy: f1(sy), r: f1(rA * fade) },
      [[0, ORANGE, 0], [0.45, ORANGE, 0.3], [1, ORANGE, 1]])
    // One path, drawn three times: a wide haze, a glow and the bright core.
    const arc = el('path', { id: this.id(name + '-arc') }, this.defs)
    const g = el('g', { fill: 'none', stroke: this.url(name + '-fade') }, parent)
    for (const [sw, op] of [[13 * w, 0.12], [7 * w, 0.3], [3.4 * w, 1]]) {
      el('use', { href: '#' + this.id(name + '-arc'), 'stroke-width': sw, opacity: op }, g)
    }
    // The needle, drawn pointing right (0°) and turned about the centre.
    const ng = el('g', {}, parent)
    if (shade) {
      this.grad('linearGradient', name + '-shade', { gradientUnits: 'userSpaceOnUse', x1: cx, y1: CY, x2: cx, y2: CY + R * 0.45 },
        [[0, '#000', 0.42], [1, '#000', 0]])
      const rf = R * RING.face
      const [ex, ey] = polar(cx, CY, rf, 42)
      el('path', { d: `M${cx} ${CY}L${cx + rf} ${CY}A${rf} ${rf} 0 0 1 ${f1(ex)} ${f1(ey)}Z`, fill: this.url(name + '-shade') }, ng)
    }
    this.grad('linearGradient', name + '-ndl', { gradientUnits: 'userSpaceOnUse', x1: cx + rIn, y1: CY, x2: cx + rA, y2: CY },
      [[0, ORANGE, 0.15], [0.55, ORANGE, 0.85], [1, ORANGE, 1]])
    const x0 = f1(cx + rIn), x1 = f1(cx + rA + 1.7 * w)
    el('line', { x1: x0, y1: CY, x2: x1, y2: CY, stroke: this.url(name + '-ndl'), 'stroke-width': 8 * w, opacity: 0.22 }, ng)
    el('line', { x1: x0, y1: CY, x2: x1, y2: CY, stroke: this.url(name + '-ndl'), 'stroke-width': 2.8 * w }, ng)
    return (a) => {
      arc.setAttribute('d', Math.abs(a - a0) > 0.3 ? arcPath(cx, CY, rA, a0, a) : '')
      ng.setAttribute('transform', rot(a, cx))
    }
  }

  icon(parent, kind, x, y, k = 1) {
    const g = el('g', { class: 'fd-icon', transform: `translate(${f1(x)} ${f1(y)}) scale(${k})` }, parent)
    const oilcan = () => {
      el('path', { d: 'M-10 -1H-6L-4 -3H3L10 -6L5 5H-7Z' }, g)
      el('path', { d: 'M-1 -3V-6M-3 -6H1M-10 -1L-11 3' }, g)
      el('path', { class: 'fill', d: 'M11 1Q12.4 3.4 11 4.2Q9.6 3.4 11 1Z' }, g)
    }
    if (kind === 'batt') {
      el('rect', { x: -9, y: -5, width: 18, height: 12, rx: 1.5 }, g)
      el('path', { d: 'M-6 -5V-7.5H-3V-5M3 -5V-7.5H6V-5M-6.5 1H-2.5M-4.5 -1V3M2.5 1H6.5' }, g)
    } else if (kind === 'oil') {
      oilcan()
    } else if (kind === 'oiltemp') {
      oilcan()
      el('path', { d: 'M1 -6V-14M1 -11H3.5M1 -8.5H3.5' }, g)
    } else {
      el('path', { d: 'M0 -11V2M0 -8H3M0 -5H3' }, g)
      el('circle', { cx: 0, cy: 4, r: 2.6 }, g)
      el('path', { d: 'M-10 10q2.5 -2.2 5 0t5 0t5 0t5 0' }, g)
    }
  }

  // ── Split dials ───────────────────────────────────────────────────────
  // Two half scales either side of a lens-shaped middle band; the band's
  // edges are arcs that pinch in and flare out near the top and bottom,
  // and each half's name stands in it letter by letter.
  buildSplit(name, d, { left, right }) {
    const { cx, R } = d
    const g = el('g', { class: 'fd-split' }, this.svg)
    // The dividers, in units of R: a flared end, the joint, then an arc
    // of radius 0.595 R round to the other joint.
    const div = (sx) => {
      const P = (x, y) => `${f1(cx + sx * x * R)} ${f1(CY + y * R)}`
      return `M${P(0.25, -0.57)}Q${P(0.185, -0.53)} ${P(0.2, -0.47)}` +
        `A${f1(0.595 * R)} ${f1(0.595 * R)} 0 0 ${sx < 0 ? 0 : 1} ${P(0.2, 0.47)}Q${P(0.185, 0.53)} ${P(0.25, 0.57)}`
    }
    el('path', { d: div(-1), class: 'fd-div' }, g)
    el('path', { d: div(1), class: 'fd-div' }, g)
    // Short ticks at 12 and 6 o'clock.
    this.tick(g, cx, -90, R * 0.84, R * 0.79, 1.4, 'fd-tick min')
    this.tick(g, cx, 90, R * 0.84, R * 0.79, 1.4, 'fd-tick min')
    const stack = (x, word) => {
      const lh = 15.5, y0 = CY - ((word.length - 1) * lh) / 2
      ;[...word].forEach((ch, k) => text(g, f1(x), f1(y0 + k * lh), 'fd-stack', ch))
    }
    const sweeps = el('g', {}, this.svg)
    for (const [h, side, sx] of [[left, LEFT, -1], [right, RIGHT, 1]]) {
      stack(cx + sx * R * 0.29, h.word)
      // Long ticks at the ends and the middle (or the thirds), short ones
      // between, all inside the face line.
      const n = h.thirds ? 15 : 16, majors = h.thirds ? 5 : 8
      const rT = R * 0.845
      for (let k = 0; k <= n; k++) {
        const a = side.a0 + (k / n) * (side.a1 - side.a0)
        const major = k % majors === 0
        this.tick(g, cx, a, rT, major ? R * 0.72 : R * 0.8, major ? 1.8 : 1.2, major ? 'fd-tick' : 'fd-tick min')
      }
      // End labels just inside the end ticks.
      const lab = (a, s) => { const [x, y] = polar(cx, CY, R * 0.62, a); text(g, f1(x), f1(y), 'fd-end', s) }
      lab(side.a0 + sx * -11, h.ends[0])
      lab(side.a1 + sx * 11, h.ends[1])
      const [ix, iy] = polar(cx, CY, R * 0.58, sx < 0 ? 180 : 0)
      this.icon(g, h.icon, ix, iy, R > 100 ? 1.05 : 0.95)
      const paint = this.sweep(sweeps, `${name}-${sx < 0 ? 'l' : 'r'}`, cx, R, { a0: side.a0, rIn: R * 0.47, w: R > 100 ? 0.95 : 0.85, fade: 1.05 })
      this.halves.push({ ...h, side, paint })
    }
    el('circle', { cx, cy: CY, r: R * 0.075, fill: this.url('knob'), stroke: '#000', 'stroke-width': 1 }, this.svg)
    if (!this.knobDef) {
      this.knobDef = true
      this.grad('radialGradient', 'knob', { cx: 0.45, cy: 0.35, r: 0.7 }, [[0, '#3a3a3d'], [0.6, '#151516'], [1, '#050505']])
    }
  }

  // ── Tachometer ────────────────────────────────────────────────────────
  buildTach() {
    const { cx, R } = D.tach
    const g = this.tachG = el('g', { class: 'fd-tach' }, this.svg)
    this.scaleG = el('g', {}, g)
    // RPM×1000 round the lower right rim, in the dark channel past the
    // scale's end, reading upwards.
    const tp = el('path', { id: this.id('rpmx'), d: arcPath(cx, CY, R * 0.985, 80, 34) }, this.defs)
    const t = el('text', { class: 'fd-rpmx' }, g)
    const tpath = el('textPath', { href: '#' + tp.id }, t)
    tpath.textContent = 'RPM×1000'
    // A short tick at 6 o'clock across the grey line.
    this.tick(g, cx, 90, R * 0.95, R * 0.86, 1.6, 'fd-tick min')
    // Boost, 0 to 1.2 bar, under the gear: numbers above, "bar" below.
    const bw = R * 0.92, bh = 12, bx = cx - bw / 2, by = CY + 73
    this.boost = { bx, by, bw, bh }
    ;[[0, '0'], [0.4, '0,4'], [0.8, '0,8'], [1.2, '1,2']].forEach(([v, s]) =>
      text(g, f1(bx + bh / 2 + (v / 1.2) * (bw - bh)), by - 7, 'fd-small', s))
    text(g, cx, by + bh + 19, 'fd-small', 'bar')
    this.grad('linearGradient', 'btrack', { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0, '#3a1810'], [1, '#26120d']])
    this.grad('linearGradient', 'bfill', { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0, '#6a2412'], [0.7, '#e2461c'], [1, '#ff6a34']])
    this.grad('radialGradient', 'bglow', {}, [[0, '#ff5a24', 0.55], [1, '#ff5a24', 0]])
    el('rect', { x: f1(bx), y: by, width: f1(bw), height: bh, rx: bh / 2, fill: this.url('btrack') }, g)
    this.boostGlow = el('ellipse', { cy: by + bh / 2, rx: 20, ry: 14, fill: this.url('bglow'), style: 'display:none' }, g)
    this.boostBar = el('rect', { x: f1(bx), y: by, width: 0, height: bh, rx: bh / 2, fill: this.url('bfill') }, g)
    // Needle above the scale, the gear above the needle.
    this.tachSweep = this.sweep(g, 'tach', cx, R, { a0: TACH.a0, rIn: R * 0.2, shade: true, fade: 0.7 })
    this.gear = this.wide(g, cx, CY + 22, 'fd-gear', '–', 1.2)
    text(g, cx + 3, CY + 46, 'fd-cap', 'GEAR')
    this.finger = el('circle', { r: 22, class: 'rv-finger', style: 'display:none' }, g)
  }

  onScale(scale) {
    const { cx, R } = D.tach
    const g = this.scaleG
    while (g.firstChild) g.removeChild(g.firstChild)
    const ang = (v) => dialAngle(v, 0, scale.max, TACH.a0, TACH.a1)
    const rT = R * RING.tick
    // Ticks every 200 rpm, long and white on the thousands; past the
    // redline they go dark red, and the redline itself is an orange bar.
    for (let v = 0; v <= scale.max + 1; v += 200) {
      const a = ang(v), major = v % 1000 === 0 && v > 0, past = v > scale.redFrom
      const cls = past ? 'fd-tick dim' : major ? 'fd-tick' : 'fd-tick min'
      this.tick(g, cx, a, rT, rT - R * (major ? RING.major : RING.minor), major ? 1.7 : 1.3, cls)
      if (major) this.wide(g, ...polar(cx, CY, R * RING.num, a), past ? 'fd-num red' : 'fd-num', String(v / 1000))
    }
    this.tick(g, cx, ang(scale.redFrom), rT + 1, rT - R * RING.major, 3.2, 'fd-tick red')
    this.last = {}
  }

  rpmAt(x, y) {
    const { cx, R } = D.tach
    if (Math.hypot(x - cx, y - CY) > R + 10) return null
    return fracAt(x, y, cx, CY, TACH.a0, TACH.a1) * this.scale.max
  }
  // Holding anywhere on the tach revs the engine.
  tachHit(x, y) { return Math.hypot(x - D.tach.cx, y - CY) <= D.tach.R + 6 }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(D.tach.cx, CY, D.tach.R - 22, dialAngle(rpm, 0, this.scale.max, TACH.a0, TACH.a1))
    this.finger.setAttribute('cx', f1(fx)); this.finger.setAttribute('cy', f1(fy))
    this.finger.style.display = ''
    this.finger.classList.toggle('red', rpm >= this.scale.redFrom)
  }
  onFingerUp() { this.finger.style.display = 'none' }

  // ── Speedometer ───────────────────────────────────────────────────────
  buildSpeed() {
    const { cx, R } = D.speed
    const g = el('g', { class: 'fd-speed' }, this.svg)
    const rT = R * RING.tick
    for (let v = 0; v <= SPEED.max; v += 5) {
      const a = dialAngle(v, 0, SPEED.max, SPEED.a0, SPEED.a1)
      const major = v % 50 === 0, end = v === SPEED.max
      this.tick(g, cx, a, rT, rT - R * (major ? RING.major : RING.minor), end ? 3.2 : major ? 1.7 : 1.3,
        end ? 'fd-tick red' : major ? 'fd-tick' : 'fd-tick min')
      if (major) this.wide(g, ...polar(cx, CY, R * 0.6, a), 'fd-snum', String(v))
    }
    // The little red comb before 50, as on the reference.
    for (let k = 0; k < 4; k++) {
      const a = dialAngle(38 + k * 2.6, 0, SPEED.max, SPEED.a0, SPEED.a1)
      el('line', { x1: f1(polar(cx, CY, R * 0.74, a)[0]), y1: f1(polar(cx, CY, R * 0.74, a)[1]),
        x2: f1(polar(cx, CY, R * 0.66, a + 4)[0]), y2: f1(polar(cx, CY, R * 0.66, a + 4)[1]),
        stroke: '#ff4a2a', 'stroke-width': 2.2, opacity: 1 - k * 0.2 }, g)
    }
    this.tick(g, cx, 90, R * 0.95, R * 0.86, 1.6, 'fd-tick min')
    // Odometer chip under the top numeral.
    el('rect', { x: cx - 31, y: CY - 46, width: 62, height: 18, rx: 2, fill: '#060606', stroke: '#2c2c2f', 'stroke-width': 1 }, g)
    this.odo = text(g, cx, CY - 36.5, 'fd-odo', '000000')
    this.speedSweep = this.sweep(g, 'speed', cx, R, { a0: SPEED.a0, rIn: R * 0.2, w: 0.9, shade: true, fade: 0.7 })
    this.kmh = this.wide(g, cx, CY + 14, 'fd-kmh', '0', 1.2)
    text(g, cx, CY + 38, 'fd-unit', 'km/h')
    // Trip under it, with a small road icon.
    const tg = el('g', {}, g)
    const ic = el('g', { class: 'fd-icon', transform: `translate(${cx - 34} ${CY + 76})` }, tg)
    el('path', { d: 'M-6 7L-2 -7M6 7L2 -7M0 -5.5V-3M0 0V2.5M0 5V7' }, ic)
    this.trip = text(g, cx - 22, CY + 81, 'fd-trip', '')
    this.tripN = el('tspan', {}, this.trip)
    this.tripU = el('tspan', { dx: 3 }, this.trip)
    this.tripU.textContent = 'km'
    this.tripN.style.fill = '#f0f0f0'
  }

  // ── Clock ─────────────────────────────────────────────────────────────
  // Hours and minutes in orange, the minute hand trailing the same glowing
  // arc as the needles; three small dials: running seconds (left), the
  // minutes of a half hour (right), and the hours (bottom).
  buildClock() {
    const { cx, R } = D.clock
    const g = el('g', { class: 'fd-clock' }, this.svg)
    const rT = R * 0.84
    for (let k = 0; k < 60; k++) {
      const hr = k % 5 === 0
      this.tick(g, cx, k * 6 - 90, rT, rT - R * (hr ? 0.11 : 0.045), hr ? 1.7 : 1.2, hr ? 'fd-tick' : 'fd-tick min')
    }
    for (const [k, s] of [[0, '12'], [3, '3'], [6, '6'], [9, '9']]) {
      this.wide(g, ...polar(cx, CY, R * 0.6, k * 30 - 90), 'fd-snum', s, 1.1)
    }
    this.subs = []
    for (const [dx, dy, n] of [[-0.31, 0.0, 60], [0.31, 0.0, 30], [0, 0.31, 12]]) {
      const sx = cx + dx * R, sy = CY + dy * R, r = R * 0.2
      el('circle', { cx: f1(sx), cy: f1(sy), r: f1(r), fill: '#0b0b0c', stroke: '#2a2a2d', 'stroke-width': 1 }, g)
      for (let k = 0; k < 12; k++) {
        const [x0, y0] = polar(sx, sy, r - 1.5, k * 30), [x1, y1] = polar(sx, sy, r - (k % 3 ? 3.5 : 5.5), k * 30)
        el('line', { x1: f1(x0), y1: f1(y0), x2: f1(x1), y2: f1(y1), stroke: k % 3 ? '#555' : '#bbb', 'stroke-width': 0.9 }, g)
      }
      const hand = el('line', { x1: f1(sx), y1: f1(sy + 2), x2: f1(sx), y2: f1(sy - r + 3), stroke: '#ff4a2a', 'stroke-width': 1.4, 'stroke-linecap': 'round' }, g)
      el('circle', { cx: f1(sx), cy: f1(sy), r: 2, fill: '#dcdcdc' }, g)
      this.subs.push({ hand, sx, sy, n })
    }
    // The minute hand and its trailing arc, drawn at 12 and turned.
    const rA = R * RING.arc
    const tail = 220
    this.minG = el('g', {}, g)
    const [tx, ty] = polar(cx, CY, rA, -90 - tail)
    this.grad('radialGradient', 'ctail', { gradientUnits: 'userSpaceOnUse', cx: f1(tx), cy: f1(ty), r: f1(rA * 1.3) },
      [[0, ORANGE, 0], [0.5, ORANGE, 0.35], [1, ORANGE, 1]])
    const td = arcPath(cx, CY, rA, -90 - tail, -90)
    for (const [sw, op] of [[11, 0.12], [6, 0.3], [3, 1]]) {
      el('path', { d: td, fill: 'none', stroke: this.url('ctail'), 'stroke-width': sw, opacity: op }, this.minG)
    }
    el('line', { x1: cx, y1: CY - 6, x2: cx, y2: f1(CY - rA - 1.5), stroke: ORANGE, 'stroke-width': 7, opacity: 0.2 }, this.minG)
    el('line', { x1: cx, y1: CY - 6, x2: cx, y2: f1(CY - rA - 1.5), stroke: ORANGE, 'stroke-width': 2.6 }, this.minG)
    this.hourH = el('line', { x1: cx, y1: CY - R * 0.12, x2: cx, y2: CY - R * 0.52, stroke: '#f2582a', 'stroke-width': 4.6, 'stroke-linecap': 'round' }, g)
    el('circle', { cx, cy: CY, r: R * 0.065, fill: this.url('knob'), stroke: '#3a3a3d', 'stroke-width': 1 }, g)
  }

  // True when key's value moved since the last paint (or force).
  moved(key, val, force) {
    if (!force && this.last[key] === val) return false
    this.last[key] = val
    return true
  }

  paint(force) {
    if (!this.halves || !this.scale) return
    const v = this.v, i = this.i
    // Angles rounded to a tenth of a degree: finer is invisible.
    const q = (a) => Math.round(a * 10) / 10
    const ta = q(dialAngle(v.rpm, 0, this.scale.max, TACH.a0, TACH.a1))
    if (this.moved('tach', ta, force)) this.tachSweep(ta)
    const sa = q(dialAngle(v.kmh, 0, SPEED.max, SPEED.a0, SPEED.a1))
    if (this.moved('speed', sa, force)) this.speedSweep(sa)
    this.halves.forEach((h, k) => {
      const a = q(dialAngle(v[h.key], h.lo, h.hi, h.side.a0, h.side.a1))
      if (this.moved('h' + k, a, force)) h.paint(a)
    })
    // Boost: the bar grows from its left cap; the glow sits on its end.
    const { bx, bw, bh } = this.boost
    const f = Math.round(clamp(v.boost / 1.2, 0, 1) * 200) / 200
    if (this.moved('boost', f, force)) {
      const wd = f > 0 ? bh + f * (bw - bh) : 0
      this.boostBar.setAttribute('width', f1(wd))
      this.boostGlow.style.display = f > 0 ? '' : 'none'
      this.boostGlow.setAttribute('cx', f1(bx + wd - bh / 2))
    }
    setText(this.gear, i.gear || '–')
    setText(this.kmh, i.stale ? '--' : String(Math.min(999, Math.round(v.kmh))))
    setText(this.odo, String(Math.floor(v.odo) % 1000000).padStart(6, '0'))
    setText(this.tripN, (Math.floor(v.trip * 10) / 10).toFixed(1))
    // The clock: turn the hands only when the second changes.
    const c = i.clock instanceof Date ? i.clock : new Date()
    const sec = c.getHours() * 3600 + c.getMinutes() * 60 + c.getSeconds()
    if (this.moved('clock', sec, force)) {
      const { cx } = D.clock
      const m = c.getMinutes() + c.getSeconds() / 60
      const h = (c.getHours() % 12) + m / 60
      this.hourH.setAttribute('transform', rot(h * 30, cx))
      this.minG.setAttribute('transform', rot(m * 6, cx))
      const [s, hs, hr] = this.subs
      s.hand.setAttribute('transform', rot(c.getSeconds() * 6, s.sx, s.sy))
      hs.hand.setAttribute('transform', rot((m % 30) * 12, hs.sx, hs.sy))
      hr.hand.setAttribute('transform', rot(h * 30, hr.sx, hr.sy))
      this.svg.setAttribute('aria-label', 'Engine speed and road speed, ' + hhmm(c))
    }
  }
}
