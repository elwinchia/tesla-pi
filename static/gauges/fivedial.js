// Five dials, 911-style: five round black dials in a row on a dark panel.
// Left to right: fuel and oil temperature (a split dial), water temperature
// and oil pressure (split), the big tachometer with the gear in the middle
// and a boost bar under it, the speedometer with a digital readout, and a
// clock. Needles are glowing orange sweeps from the start of each scale,
// as on the reference; the type is a clean, light system sans.
import { GaugeStyle, el, text, setText, polar, arcPath, dialAngle, clamp, hhmm } from './kit.js'

// Picture: five dials edge to edge with a few units between them.
const VIEW = { w: 1128, h: 400 }
const CY = 200
const D = {
  fuel:  { cx: 84,   r: 76 },
  temp:  { cx: 268,  r: 102 },
  tach:  { cx: 538,  r: 162 },
  speed: { cx: 834,  r: 128 },
  clock: { cx: 1044, r: 76 },
}
// Tach: 270° with the gap at the bottom, where the boost bar sits.
const TACH = { a0: 135, a1: 405 }
// Speedometer: 0–300 km/h over 260°.
const SPEED = { a0: 140, a1: 400, max: 300 }
// Split dials: the left half climbs the left side, the right half the
// right side, both from the bottom up.
const LEFT = { a0: 128, a1: 232 }
const RIGHT = { a0: 52, a1: -52 }
const ORANGE = '#ff5a1f'
const BEZEL = 7  // the ring between a dial's edge and its face

const f1 = (x) => x.toFixed(1)
const rot = (a, cx, cy = CY) => `rotate(${a.toFixed(2)} ${cx} ${cy})`

// rpm under a point on a dial from a0 to a1 (a1 > a0, the gap is the rest
// of the circle); a point in the gap snaps to the nearer end.
function fracAt(x, y, cx, cy, a0, a1) {
  let a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
  while (a < a0) a += 360
  while (a >= a0 + 360) a -= 360
  if (a <= a1) return (a - a0) / (a1 - a0)
  return a - a1 < a0 + 360 - a ? 1 : 0
}

export default class FiveDialStyle extends GaugeStyle {
  static meta = {
    key: 'fivedial', name: 'Five dials', era: '911-style', view: VIEW, dark: true,
    blurb: 'Five round dials in a row: fuel and oil, water and oil pressure, the tach with the gear, speed, and a clock.',
  }

  build() {
    const s = this.svg
    this.css(`
      .gs-fivedial text { font-family: -apple-system, 'SF Pro Display', system-ui, 'Helvetica Neue', Roboto, sans-serif; fill: #f2f2f2; }
      .gs-fivedial .fd-num { font-size: 30px; font-weight: 400; text-anchor: middle; dominant-baseline: central; }
      .gs-fivedial .fd-num.red { fill: #ff5a3c; }
      .gs-fivedial .fd-snum { font-size: 20px; font-weight: 500; text-anchor: middle; dominant-baseline: central; }
      .gs-fivedial .fd-small { font-size: 16px; font-weight: 500; text-anchor: middle; dominant-baseline: central; fill: #d8d8d8; }
      .gs-fivedial .fd-cap { font-size: 16px; font-weight: 500; text-anchor: middle; letter-spacing: 0.3em; fill: #c9c9c9; }
      .gs-fivedial .fd-stack { font-size: 16px; font-weight: 500; text-anchor: middle; dominant-baseline: central; fill: #d0d0d0; }
      .gs-fivedial .fd-gear { font-size: 124px; font-weight: 300; text-anchor: middle; fill: #f4f4f4; }
      .gs-fivedial[data-zone=red] .fd-gear { fill: #ff6a3c; }
      .gs-fivedial .fd-kmh { font-size: 56px; font-weight: 300; text-anchor: middle; }
      .gs-fivedial .fd-odo { font-size: 16px; font-weight: 500; text-anchor: middle; dominant-baseline: central; letter-spacing: 0.08em; font-variant-numeric: tabular-nums; }
      .gs-fivedial .fd-rpmx { font-size: 16px; font-weight: 500; letter-spacing: 0.18em; fill: #bdbdbd; }
      .gs-fivedial .fd-tick { stroke: #f0f0f0; stroke-linecap: butt; }
      .gs-fivedial .fd-tick.red { stroke: #ff4a1c; }
      .gs-fivedial .fd-icon { fill: none; stroke: #d6d6d6; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .gs-fivedial .fd-sweep { fill: none; stroke: ${ORANGE}; stroke-linecap: butt; }
      .gs-fivedial[data-zone=red] .fd-tach .fd-sweep { stroke: #ff3b20; }
      .gs-fivedial .fd-needle { stroke: ${ORANGE}; stroke-linecap: round; }
      .gs-fivedial .fd-hand { stroke: ${ORANGE}; stroke-linecap: round; }
    `)
    const defs = el('defs', {}, s)
    // The panel's grain: a fine static dot pattern, cheaper than a noise
    // filter on a car's browser.
    const pat = el('pattern', { id: this.id('grain'), width: 5, height: 5, patternUnits: 'userSpaceOnUse' }, defs)
    el('rect', { width: 5, height: 5, fill: '#0f0f10' }, pat)
    el('rect', { x: 1, y: 1, width: 1, height: 1, fill: '#1d1d1f' }, pat)
    el('rect', { x: 3, y: 3, width: 1.2, height: 1, fill: '#161618' }, pat)
    const bez = el('linearGradient', { id: this.id('bezel'), x1: 0, y1: 0, x2: 0, y2: 1 }, defs)
    el('stop', { offset: 0, 'stop-color': '#3a3b3f' }, bez)
    el('stop', { offset: 0.5, 'stop-color': '#16171a' }, bez)
    el('stop', { offset: 1, 'stop-color': '#050506' }, bez)
    const face = el('radialGradient', { id: this.id('face'), cx: 0.5, cy: 0.42, r: 0.6 }, defs)
    el('stop', { offset: 0, 'stop-color': '#1d1e21' }, face)
    el('stop', { offset: 0.7, 'stop-color': '#0c0c0e' }, face)
    el('stop', { offset: 1, 'stop-color': '#040405' }, face)
    const boost = el('linearGradient', { id: this.id('boost'), x1: 0, y1: 0, x2: 1, y2: 0 }, defs)
    el('stop', { offset: 0, 'stop-color': '#ff3d12' }, boost)
    el('stop', { offset: 1, 'stop-color': '#ff8a3a' }, boost)

    // The panel the dials sit in.
    el('rect', { x: 2, y: 14, width: VIEW.w - 4, height: VIEW.h - 28, rx: 72, fill: this.url('grain'), stroke: '#2a2a2d', 'stroke-width': 2 }, s)
    el('rect', { x: 10, y: 22, width: VIEW.w - 20, height: VIEW.h - 44, rx: 64, fill: 'none', stroke: '#000', 'stroke-opacity': 0.6, 'stroke-width': 3 }, s)

    for (const d of Object.values(D)) this.dial(d.cx, d.r)

    this.buildSplit(D.fuel, {
      // The small dial has no room for numbers between rim and spine.
      left: { caption: 'TANK', lo: 0, hi: 1, ends: ['E', 'F'], icon: 'fuel' },
      right: { caption: 'OEL', lo: 50, hi: 150, ends: ['C', 'H'], icon: 'oil' },
    })
    this.buildSplit(D.temp, {
      left: { caption: 'TEMP', lo: 50, hi: 130, ends: ['C', 'H'], icon: 'temp' },
      right: { caption: 'DRUCK', lo: 0, hi: 10, ends: ['0', '10'], mid: '5', icon: 'oil' },
    })
    this.buildTach()
    this.buildSpeed()
    this.buildClock()
    this.last = {}
  }

  // A dial: bezel ring and black face.
  dial(cx, r) {
    el('circle', { cx, cy: CY + 3, r: r + 2, fill: '#000', opacity: 0.6 }, this.svg)
    el('circle', { cx, cy: CY, r, fill: this.url('bezel') }, this.svg)
    el('circle', { cx, cy: CY, r: r - BEZEL, fill: this.url('face'), stroke: '#000', 'stroke-width': 2 }, this.svg)
  }

  // The orange needle as the reference draws it: a soft wide band and a
  // bright rim line from the start of the scale, and a short needle at
  // the value. Returns a painter for an angle.
  sweep(parent, cx, r, len, a0, w = 1) {
    const g = el('g', {}, parent)
    const soft = el('path', { class: 'fd-sweep', 'stroke-width': 26 * w, opacity: 0.1 }, g)
    const mid = el('path', { class: 'fd-sweep', 'stroke-width': 12 * w, opacity: 0.22 }, g)
    const rim = el('path', { class: 'fd-sweep', 'stroke-width': 4.5 * w }, g)
    const ng = el('g', {}, g)
    el('line', { x1: cx + r - len, y1: CY, x2: cx + r + 2, y2: CY, class: 'fd-needle', 'stroke-width': 10 * w, opacity: 0.25 }, ng)
    el('line', { x1: cx + r - len, y1: CY, x2: cx + r + 2, y2: CY, class: 'fd-needle', 'stroke-width': 4 * w }, ng)
    return (a) => {
      const on = Math.abs(a - a0) > 0.3
      rim.setAttribute('d', on ? arcPath(cx, CY, r - 1, a0, a) : '')
      mid.setAttribute('d', on ? arcPath(cx, CY, r - 7, a0, a) : '')
      soft.setAttribute('d', on ? arcPath(cx, CY, r - 14, a0, a) : '')
      ng.setAttribute('transform', rot(a, cx))
    }
  }

  tick(parent, cx, a, r0, r1, wd, cls = 'fd-tick') {
    const [x0, y0] = polar(cx, CY, r0, a), [x1, y1] = polar(cx, CY, r1, a)
    return el('line', { x1: f1(x0), y1: f1(y0), x2: f1(x1), y2: f1(y1), class: cls, 'stroke-width': wd }, parent)
  }

  // A split dial: two half scales either side of an hourglass spine with
  // the captions stacked letter by letter, as on the old cluster.
  buildSplit(d, { left, right }) {
    const { cx } = d, rf = d.r - BEZEL
    const g = el('g', { class: 'fd-split' }, this.svg)
    const big = d.r > 90
    // The spine: two arcs pinched towards the middle.
    const top = CY - rf + 6, bot = CY + rf - 6
    const wEnd = big ? 40 : 30, wMid = big ? 26 : 19
    const spine = (sx) => `M${cx + sx * wEnd} ${top}Q${cx + sx * (wMid * 2 - wEnd)} ${CY} ${cx + sx * wEnd} ${bot}`
    el('path', { d: spine(-1), fill: 'none', stroke: '#3a3a3e', 'stroke-width': 1.5 }, g)
    el('path', { d: spine(1), fill: 'none', stroke: '#3a3a3e', 'stroke-width': 1.5 }, g)
    el('circle', { cx, cy: CY, r: big ? 10 : 8, fill: '#050505', stroke: '#3a3a3e', 'stroke-width': 1.5 }, g)
    const stack = (x, word) => {
      const lh = 17, y0 = CY - ((word.length - 1) * lh) / 2
      ;[...word].forEach((ch, k) => text(g, x, y0 + k * lh, 'fd-stack', ch))
    }
    const rT = rf - 3, rTi = rf - (big ? 15 : 12), rTm = rf - 9
    this.halves = this.halves || []
    for (const [h, side] of [[left, LEFT], [right, RIGHT]]) {
      const sx = side === LEFT ? -1 : 1
      stack(cx + sx * (big ? 17 : 15), h.caption)
      // Ticks: ends and middle long, quarters short.
      for (let k = 0; k <= 8; k++) {
        const a = side.a0 + (k / 8) * (side.a1 - side.a0)
        this.tick(g, cx, a, rT, k % 4 === 0 ? rTi : k % 2 === 0 ? rTm - 2 : rTm + 2, k % 4 === 0 ? 2.4 : 1.4)
      }
      const rl = rf - (big ? 30 : 25)
      const lab = (a, s) => { const [x, y] = polar(cx, CY, rl, a); text(g, f1(x), f1(y), 'fd-small', s) }
      // End labels a little inside each end, off the needle's rest.
      const inset = big ? 8 : 13
      lab(side.a0 + (side === LEFT ? inset : -inset), h.ends[0])
      lab(side.a1 + (side === LEFT ? -inset : inset), h.ends[1])
      if (h.mid) lab((side.a0 + side.a1) / 2, h.mid)
      // Icon at the side, between the end labels.
      const [ix, iy] = polar(cx, CY, rf - (big ? 34 : 27), side === LEFT ? 180 : 0)
      this.icon(g, h.icon, ix, iy, big ? 1 : 0.8)
      const paint = this.sweep(g, cx, rf - 2, big ? 24 : 18, side.a0, big ? 0.9 : 0.75)
      this.halves.push({ ...h, side, paint, key: null })
    }
  }

  icon(parent, kind, x, y, k = 1) {
    const g = el('g', { class: 'fd-icon', transform: `translate(${f1(x)} ${f1(y)}) scale(${k})` }, parent)
    if (kind === 'fuel') {
      el('rect', { x: -7, y: -9, width: 10, height: 17, rx: 1.5 }, g)
      el('path', { d: 'M-5 -5 H1 M3 -4 L7 -1 V6 Q7 8 5 8' }, g)
    } else if (kind === 'oil') {
      el('path', { d: 'M-10 -1 H3 L10 -5 L4 5 H-7 Z M-4 -1 V-5 M-7 -5 H-1' }, g)
      el('path', { d: 'M11 2 Q12 5 11 6' }, g)
    } else {
      el('path', { d: 'M0 -10 V4' }, g)
      el('circle', { cx: 0, cy: 6, r: 3 }, g)
      el('path', { d: 'M3 -7 H6 M3 -3 H6 M-10 11 q2.5 -2.5 5 0 t5 0 t5 0 t5 0' }, g)
    }
  }

  buildTach() {
    const { cx } = D.tach, rf = D.tach.r - BEZEL
    const g = this.tachG = el('g', { class: 'fd-tach' }, this.svg)
    this.scaleG = el('g', {}, g)
    // The reference runs "RPM×1000" round the rim, but this tach's gap is
    // the boost bar's, so a short label sits upright under the top numeral.
    text(g, cx, CY - 78, 'fd-rpmx', '×1000', { 'text-anchor': 'middle' })
    // Sweep and needle above the ticks, under the gear.
    this.tachSweep = this.sweep(g, cx, rf - 2, 62, TACH.a0)
    this.gear = text(g, cx, CY + 20, 'fd-gear', '–')
    text(g, cx, CY + 52, 'fd-cap', 'GEAR')
    // Boost, 0 to 1 bar, under the gear; its numbers below it, clear of
    // the tach's 0.
    const bw = 124, bx = cx - bw / 2, by = CY + 96
    for (const [v, s] of [[0, '0'], [0.4, '0.4'], [0.8, '0.8'], [1, '1']]) text(g, f1(bx + v * bw), by + 27, 'fd-small', s)
    el('rect', { x: bx, y: by, width: bw, height: 11, rx: 5.5, fill: '#2a1712', stroke: '#3b2620', 'stroke-width': 1 }, g)
    this.boostGlow = el('rect', { x: bx - 3, y: by - 3, width: 0, height: 17, rx: 8.5, fill: '#ff5a1f', opacity: 0.25 }, g)
    this.boostBar = el('rect', { x: bx, y: by, width: 0, height: 11, rx: 5.5, fill: this.url('boost') }, g)
    this.boostW = bw
    text(g, bx + bw + 22, by + 5, 'fd-small', 'bar')
    this.finger = el('circle', { r: 22, class: 'rv-finger', style: 'display:none' }, g)
  }

  buildSpeed() {
    const { cx } = D.speed, rf = D.speed.r - BEZEL
    const g = el('g', { class: 'fd-speed' }, this.svg)
    for (let v = 0; v <= SPEED.max; v += 10) {
      const a = dialAngle(v, 0, SPEED.max, SPEED.a0, SPEED.a1)
      const major = v % 50 === 0
      this.tick(g, cx, a, rf - 3, major ? rf - 17 : rf - 10, major ? 2.6 : 1.4)
      if (major) {
        const [x, y] = polar(cx, CY, rf - 37, a)
        text(g, f1(x), f1(y), 'fd-snum', String(v))
      }
    }
    // Odometer chip above the speed, trip under it.
    el('rect', { x: cx - 36, y: CY - 60, width: 72, height: 23, rx: 4, fill: '#050505', stroke: '#4a4a4e', 'stroke-width': 1.2 }, g)
    this.odo = text(g, cx, CY - 48.5, 'fd-odo', '000000')
    this.kmh = text(g, cx, CY + 18, 'fd-kmh', '0')
    text(g, cx, CY + 44, 'fd-small', 'km/h')
    this.trip = text(g, cx, CY + 84, 'fd-small', '')
    this.speedSweep = this.sweep(g, cx, rf - 2, 44, SPEED.a0, 0.85)
  }

  buildClock() {
    const { cx } = D.clock, rf = D.clock.r - BEZEL
    const g = el('g', { class: 'fd-clock' }, this.svg)
    for (let k = 0; k < 60; k++) {
      const hr = k % 5 === 0
      this.tick(g, cx, k * 6 - 90, rf - 3, hr ? rf - 13 : rf - 7, hr ? 2.4 : 1)
    }
    for (const [k, s] of [[0, '12'], [3, '3'], [6, '6'], [9, '9']]) {
      const [x, y] = polar(cx, CY, rf - 28, k * 30 - 90)
      text(g, f1(x), f1(y), 'fd-snum', s)
    }
    // Hands drawn pointing up (12 o'clock) and turned about the centre.
    this.hourH = el('line', { x1: cx, y1: CY + 8, x2: cx, y2: CY - 30, class: 'fd-hand', 'stroke-width': 5 }, g)
    this.minH = el('line', { x1: cx, y1: CY + 10, x2: cx, y2: CY - 50, class: 'fd-hand', 'stroke-width': 3.5 }, g)
    this.secH = el('line', { x1: cx, y1: CY + 12, x2: cx, y2: CY - 56, stroke: '#e8e8e8', 'stroke-width': 1.2 }, g)
    el('circle', { cx, cy: CY, r: 5, fill: '#111', stroke: ORANGE, 'stroke-width': 2 }, g)
  }

  onScale(scale) {
    const { cx } = D.tach, rf = D.tach.r - BEZEL
    const g = this.scaleG
    while (g.firstChild) g.removeChild(g.firstChild)
    const ang = (v) => dialAngle(v, 0, scale.max, TACH.a0, TACH.a1)
    // A thin red arc under the red-zone ticks.
    el('path', { d: arcPath(cx, CY, rf - 4, ang(scale.redFrom), TACH.a1), fill: 'none', stroke: '#ff3b1c', 'stroke-width': 3, opacity: 0.85 }, g)
    for (let v = 0; v <= scale.max; v += 500) {
      const a = ang(v), major = v % 1000 === 0, red = v >= scale.redFrom
      this.tick(g, cx, a, rf - 3, major ? rf - 19 : rf - 10, major ? 3 : 1.6, red ? 'fd-tick red' : 'fd-tick')
      if (!major) continue
      const [x, y] = polar(cx, CY, rf - 44, a)
      text(g, f1(x), f1(y), red ? 'fd-num red' : 'fd-num', String(v / 1000))
    }
    this.last = {}
  }

  rpmAt(x, y) {
    const { cx, r } = D.tach
    if (Math.hypot(x - cx, y - CY) > r + 10) return null
    return fracAt(x, y, cx, CY, TACH.a0, TACH.a1) * this.scale.max
  }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(D.tach.cx, CY, D.tach.r - 20, dialAngle(rpm, 0, this.scale.max, TACH.a0, TACH.a1))
    this.finger.setAttribute('cx', f1(fx)); this.finger.setAttribute('cy', f1(fy))
    this.finger.style.display = ''
    this.finger.classList.toggle('red', rpm >= this.scale.redFrom)
  }
  onFingerUp() { this.finger.style.display = 'none' }

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
    const vals = [v.fuel, v.oilTemp, v.water, v.oilPress]
    this.halves.forEach((h, k) => {
      const a = q(dialAngle(vals[k], h.lo, h.hi, h.side.a0, h.side.a1))
      if (this.moved('h' + k, a, force)) h.paint(a)
    })
    const bw = Math.round(clamp(v.boost, 0, 1) * this.boostW)
    if (this.moved('boost', bw, force)) {
      this.boostBar.setAttribute('width', bw)
      this.boostGlow.setAttribute('width', bw > 0 ? bw + 6 : 0)
    }
    setText(this.gear, i.gear || '–')
    setText(this.kmh, i.stale ? '--' : String(Math.min(999, Math.round(v.kmh))))
    setText(this.odo, String(Math.floor(v.odo) % 1000000).padStart(6, '0'))
    setText(this.trip, 'TRIP ' + (Math.floor(v.trip * 10) / 10).toFixed(1) + ' km')
    // The clock: turn the hands only when the second changes.
    const c = i.clock instanceof Date ? i.clock : new Date()
    const sec = c.getHours() * 3600 + c.getMinutes() * 60 + c.getSeconds()
    if (this.moved('clock', sec, force)) {
      const { cx } = D.clock
      const m = c.getMinutes() + c.getSeconds() / 60
      this.hourH.setAttribute('transform', rot(((c.getHours() % 12) + m / 60) * 30, cx))
      this.minH.setAttribute('transform', rot(m * 6, cx))
      this.secH.setAttribute('transform', rot(c.getSeconds() * 6, cx))
      this.svg.setAttribute('aria-label', 'Engine speed and road speed, ' + hhmm(c))
    }
  }
}
