// Segment arc, S2000-style: a wide segmented tachometer arc, an old-school
// seven-segment speed readout in an LCD window (the gear in its corner), a
// trip/odometer LCD under it, and two segmented bars, water temperature and the battery's charge
// (the car's own, read over Bluetooth, when there is one; else made up). The
// geometry is in static/rev-gauge.js (tested); this file draws it. It is
// the one style with a day palette as well as night (static/rev-gauge.css).
import {
  ARC, VIEW, segmentsFor, shownLit, litColor, barLit, angleFor, valueAt, onArc, BAR_N, HIT,
} from '../rev-gauge.js'
import { GaugeStyle, el, text, setText, polar, mix, sevenRow } from './kit.js'

// Unlit arc segments run from warm brown to cool grey; day gets a pale
// version of the same.
const OFF = { night: ['#5a4434', '#3a3d43'], day: ['#cdb9aa', '#bcc0c5'] }
// Water: C is 50 °C, H is 130 °C; the needle sits mid-way at a warm 90.
export const WATER = { lo: 50, hi: 130 }
// Everything in the middle is centred on the arc (ARC.cx).
const MID = 620
const BARS = {
  water: { x: 150, y: 322, w: 240, lo: 'C', hi: 'H', caption: 'WATER TEMP' },
  batt:  { x: 850, y: 322, w: 240, lo: 'E', hi: 'F', caption: 'BATTERY' },
}
// The heading, in a small LCD tucked into the top-right corner, clear of
// the arc and its glow; hidden while it is unknown.
const CAR = { y: 16, h: 50, pad: 18 }
// The trip LCD's digits, and the width of the odometer's six and the
// trip's five.
const SMALL = { w: 11, h: 18, t: 3, gap: 4, skew: 0.1, cls: 'seg7 rv-odo7' }
const ODO_W = 6 * 15 - 4, TRIP_W = 5 * 15 - 4
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export default class SegmentStyle extends GaugeStyle {
  static meta = {
    key: 'segment', name: 'Segment arc', era: 'S2000-style', view: VIEW,
    blurb: 'A wide segmented rev arc, a seven-segment speed LCD, trip and odometer, water temperature and battery.',
  }

  build() {
    const s = this.svg
    const defs = el('defs', {}, s)
    const bloom = el('radialGradient', { id: this.id('bloom') }, defs)
    el('stop', { offset: '0', 'stop-color': '#ff9a2a', 'stop-opacity': '0.5' }, bloom)
    el('stop', { offset: '0.55', 'stop-color': '#ff7a1a', 'stop-opacity': '0.14' }, bloom)
    el('stop', { offset: '1', 'stop-color': '#ff7a1a', 'stop-opacity': '0' }, bloom)
    const tip = el('radialGradient', { id: this.id('tip') }, defs)
    el('stop', { offset: '0', 'stop-color': '#ffd24a', 'stop-opacity': '0.65' }, tip)
    el('stop', { offset: '1', 'stop-color': '#ff9a1a', 'stop-opacity': '0' }, tip)
    const lcd = el('linearGradient', { id: this.id('lcd'), x1: '0', y1: '0', x2: '0', y2: '1' }, defs)
    el('stop', { offset: '0', 'stop-color': '#5c1a0c' }, lcd)
    el('stop', { offset: '1', 'stop-color': '#3a0e06' }, lcd)
    // The filter region is the whole picture, in picture units: a region
    // relative to the path would clip the blur into a box when the lit run
    // is short.
    const blur = el('filter', { id: this.id('blur'), filterUnits: 'userSpaceOnUse', x: -100, y: -100, width: VIEW.w + 200, height: VIEW.h + 200 }, defs)
    el('feGaussianBlur', { stdDeviation: '9' }, blur)

    // Layers, back to front.
    el('ellipse', { cx: MID, cy: 262, rx: 360, ry: 150, fill: this.url('bloom'), class: 'rv-bloom' }, s)
    this.glow = el('path', { class: 'rv-glow', filter: this.url('blur') }, s)
    this.tipGlow = el('circle', { r: 70, fill: this.url('tip'), class: 'rv-tipglow' }, s)
    // The band a finger can grab, shown faintly in simulation mode.
    this.hitBand = el('path', { class: 'rv-hit' }, s)
    this.segG = el('g', { class: 'rv-segs' }, s)
    this.scaleG = el('g', { class: 'rv-scale' }, s)
    this.finger = el('circle', { r: 34, class: 'rv-finger', style: 'display:none' }, s)

    // Speed: three seven-segment digits in a dark red LCD window, the
    // unlit segments faintly showing, as on the old cluster. The gear has
    // its own column in the window's top-left corner, and km/h sits in the
    // bottom-right corner, both clear of the digits.
    el('rect', { x: MID - 160, y: 198, width: 320, height: 116, rx: 26, class: 'rv-lcd', fill: this.url('lcd') }, s)
    this.speed = sevenRow(s, { x: MID - 96, y: 214, n: 3, w: 52, h: 82, t: 12, gap: 16, skew: 0.1, cls: 'seg7 rv-speed7' })
    text(s, MID + 148, 296, 'rv-lcd-unit', 'km/h')
    text(s, MID - 146, 219, 'rv-lcd-label', 'GEAR')
    // One seven-segment cell in the speed's slant and stroke, scaled down
    // (kit.js has the gear letters).
    this.gear = sevenRow(s, { x: MID - 146, y: 230, n: 1, w: 28, h: 46, t: 7, gap: 0, skew: 0.1, cls: 'seg7 rv-gear7' })
    this.simTag = text(s, MID - 131, 296, 'rv-sim-tag', 'SIM')
    this.simTag.style.display = 'none'

    // Trip and odometer LCD under the speed, as wide as its window: the
    // odometer centred in the left half, the trip in the right.
    el('rect', { x: MID - 160, y: 324, width: 320, height: 44, rx: 10, class: 'rv-lcd small', fill: this.url('lcd') }, s)
    const odoX = MID - 80 - ODO_W / 2, tripX = MID + 80 - TRIP_W / 2
    text(s, odoX + 1, 340, 'rv-lcd-label', 'ODO')
    this.odo = sevenRow(s, { x: odoX, y: 345, n: 6, ...SMALL })
    text(s, tripX, 340, 'rv-lcd-label', 'TRIP A')
    this.trip = sevenRow(s, { x: tripX, y: 345, n: 5, ...SMALL })
    // The decimal point, between the trip's last two digits.
    el('circle', { cx: tripX + 64.2, cy: 362, r: 1.8, class: 'rv-lcd-dot' }, s)

    // Side bars, with the icons the reference has at their outer ends.
    this.bars = {}
    for (const [k, b] of Object.entries(BARS)) {
      const g = el('g', { class: 'rv-bar rv-bar-' + k }, s)
      text(g, b.x - 16, b.y + 10, 'rv-bar-end', b.lo)
      text(g, b.x + b.w + 22, b.y + 10, 'rv-bar-end', b.hi)
      text(g, b.x + b.w / 2, b.y + 44, 'rv-bar-cap', b.caption)
      const segs = []
      const pitch = b.w / BAR_N
      for (let i = 0; i < BAR_N; i++) {
        segs.push(el('rect', { x: (b.x + i * pitch + pitch * 0.2).toFixed(2), y: b.y, width: (pitch * 0.55).toFixed(2), height: 18, rx: 1.2 }, g))
      }
      this.bars[k] = { segs, lit: -1, kind: k }
    }
    // Coolant: a thermometer over waves.
    const th = el('g', { class: 'rv-icon-line', transform: 'translate(106 331)' }, s)
    el('path', { d: 'M0 -14 V4' }, th)
    el('circle', { cx: 0, cy: 7, r: 4 }, th)
    el('path', { d: 'M4 -10 H8 M4 -5 H8 M4 0 H8' }, th)
    el('path', { d: 'M-14 14 q3.5 -3 7 0 t7 0 t7 0 t7 0' }, th)
    // Battery: the usual box with + and − terminals.
    const bat = el('g', { class: 'rv-icon-line', transform: 'translate(1148 331)' }, s)
    el('path', { d: 'M-13 -7 H13 V11 H-13 Z M-8 -7 V-11 H-3 V-7 M3 -7 V-11 H8 V-7 M-8 2 H-3 M3 2 H8 M5.5 -0.5 V4.5' }, bat)
    this.buildCar(s)
  }

  // The heading (a compass point and its degrees), in the trip LCD's look.
  // Local coordinates; paint() places the window and moves the parts in.
  buildCar(s) {
    this.css(`
      .gs-segment .rv-car { pointer-events: none; }
      .gs-segment .rv-car-deg { fill: none; stroke: #ffb45a; stroke-width: 1.6; }
      .gs-segment .rv-car-dir { fill: #ffb45a; font: 700 25px -apple-system, system-ui, sans-serif; text-anchor: middle; }
    `)
    const { y, h } = CAR
    const hg = el('g', { class: 'rv-car', style: 'display:none' }, s)
    const hWin = el('rect', { y, height: h, rx: 10, class: 'rv-lcd small', fill: this.url('lcd') }, hg)
    const dirG = el('g', {}, hg)
    text(dirG, 0, y + 14, 'rv-lcd-label', 'HEADING')
    // Slanted like the digits beside it.
    const pt = text(el('g', { transform: `translate(24 ${y + 44}) skewX(-5.7)` }, dirG), 0, 0, 'rv-car-dir', '')
    const hdg = sevenRow(dirG, { x: 52, y: y + 26, n: 3, ...SMALL })
    el('circle', { cx: 99, cy: y + 28, r: 2.2, class: 'rv-car-deg' }, dirG)
    this.hdg = { g: hg, win: hWin, dirG, pt, deg: hdg, last: null }
  }

  onScale(scale) {
    this.segs = segmentsFor(scale)
    const { cx, cy, rOut, rIn } = ARC
    const g = this.segG, sc = this.scaleG
    while (g.firstChild) g.removeChild(g.firstChild)
    while (sc.firstChild) sc.removeChild(sc.firstChild)
    this.segEls = this.segs.map((seg) => {
      const [x0, y0] = polar(cx, cy, rIn, seg.angle)
      const [x1, y1] = polar(cx, cy, rOut, seg.angle)
      return el('line', { x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2), class: seg.red ? 'rv-seg red' : 'rv-seg' }, g)
    })
    // Dot ticks and numbers under the arc, upright like the reference.
    for (let v = 0; v <= scale.max; v += 1000) {
      const a = angleFor(v, scale.max)
      const [dx, dy] = polar(cx, cy, rIn - 16, a)
      el('circle', { cx: dx.toFixed(2), cy: dy.toFixed(2), r: 3.2, class: v >= scale.redFrom ? 'rv-dot red' : 'rv-dot' }, sc)
      const [lx, ly] = polar(cx, cy, rIn - 46, a)
      text(sc, lx.toFixed(2), ly.toFixed(2), v >= scale.redFrom ? 'rv-num red' : 'rv-num', String(v / 1000))
      if (v === 0) text(sc, (lx + 20).toFixed(2), (ly + 6).toFixed(2), 'rv-num-unit', '×1000r/min')
    }
    const rh = (HIT.rMin + HIT.rMax) / 2
    const [hx0, hy0] = polar(cx, cy, rh, ARC.a0 - HIT.slack)
    const [hx1, hy1] = polar(cx, cy, rh, ARC.a1 + HIT.slack)
    this.hitBand.setAttribute('d', `M${hx0.toFixed(1)} ${hy0.toFixed(1)}A${rh} ${rh} 0 0 1 ${hx1.toFixed(1)} ${hy1.toFixed(1)}`)
    this.hitBand.setAttribute('stroke-width', HIT.rMax - HIT.rMin)
    this.lit = -1
  }

  rpmAt(x, y) { return onArc(x, y) ? valueAt(x, y, this.scale.max) : null }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(ARC.cx, ARC.cy, (ARC.rOut + ARC.rIn) / 2, angleFor(rpm, this.scale.max))
    this.finger.setAttribute('cx', fx.toFixed(1)); this.finger.setAttribute('cy', fy.toFixed(1))
    this.finger.style.display = ''
    this.finger.classList.toggle('red', rpm >= this.scale.redFrom)
  }
  onFingerUp() { this.finger.style.display = 'none' }
  onTouchMode(on) { this.simTag.style.display = on ? '' : 'none' }

  paint(force) {
    if (!this.segEls) return
    const theme = this.theme()
    const off = OFF[theme] || OFF.night
    const n = this.segs.length
    const rpm = this.v.rpm
    const lit = shownLit(rpm, this.segs, this.zone)
    if (force || lit !== this.lit) {
      this.lit = lit
      for (let i = 0; i < n; i++) {
        const e = this.segEls[i], seg = this.segs[i]
        const on = i < lit
        e.classList.toggle('on', on)
        // Red segments take their colour from the page; the rest are
        // coloured here, because the gradient follows the needle.
        e.style.stroke = seg.red ? '' : on ? litColor(lit > 1 ? i / (lit - 1) : 1) : mix(off[0], off[1], i / (n - 1))
      }
    }
    // Bloom behind the lit run, and a glow that rides the tip.
    const { cx, cy, rOut, rIn } = ARC
    const rMid = (rOut + rIn) / 2
    if (rpm > 1) {
      const a = angleFor(rpm, this.scale.max)
      const [x0, y0] = polar(cx, cy, rMid, ARC.a0)
      const [x1, y1] = polar(cx, cy, rMid, a)
      this.glow.setAttribute('d', `M${x0.toFixed(1)} ${y0.toFixed(1)}A${rMid} ${rMid} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`)
      this.tipGlow.setAttribute('cx', x1.toFixed(1)); this.tipGlow.setAttribute('cy', y1.toFixed(1))
      this.tipGlow.style.display = ''
    } else {
      this.glow.setAttribute('d', '')
      this.tipGlow.style.display = 'none'
    }
    const i = this.i
    this.speed.set(i.stale ? '--' : String(Math.min(999, Math.round(this.v.kmh))))
    this.odo.set(String(Math.floor(this.v.odo) % 1000000).padStart(6, '0'))
    this.trip.set(String(Math.floor(this.v.trip * 10) % 100000).padStart(2, '0'))
    this.gear.set(i.gear ?? '–')

    const w = (this.v.water - WATER.lo) / (WATER.hi - WATER.lo)
    this.paintBar(this.bars.water, i.running ? w : 0, force)
    this.paintBar(this.bars.batt, this.v.fuel, force)
    this.paintCar(force)
  }

  paintCar(force) {
    const i = this.i, H = this.hdg
    // Heading: an 8-point compass letter and whole degrees.
    const h = i.heading == null || !Number.isFinite(i.heading) ? null : ((Math.round(i.heading) % 360) + 360) % 360
    const hKey = h == null ? null : `${POINTS[Math.round(h / 45) % 8]}|${h}`
    if (force || hKey !== H.last) {
      H.last = hKey
      H.g.style.display = h == null ? 'none' : ''
      if (h != null) {
        const w = 12 + 103 + 10, x0 = VIEW.w - CAR.pad - w
        H.win.setAttribute('x', x0); H.win.setAttribute('width', w)
        H.dirG.setAttribute('transform', `translate(${x0 + 12} 0)`)
        setText(H.pt, POINTS[Math.round(h / 45) % 8])
        H.deg.set(String(h))
      }
    }
  }

  paintBar(bar, f, force) {
    const lit = barLit(f, BAR_N)
    if (lit === bar.lit && !force) return
    bar.lit = lit
    bar.segs.forEach((e, k) => {
      const on = k < lit
      const t = k / (BAR_N - 1)
      // Water's hot end is red, lit or not; the battery is red when it
      // runs low, like a fuel gauge near empty.
      const hot = bar.kind === 'water' && t > 0.85
      e.classList.toggle('on', on)
      e.classList.toggle('hot', hot)
      const red = on && (hot || (bar.kind === 'batt' && t < 0.15))
      e.classList.toggle('red', red)
      e.style.fill = on && !red ? litColor(bar.kind === 'water' ? 0.25 + t * 0.6 : 0.35 + t * 0.6) : ''
    })
  }
}
