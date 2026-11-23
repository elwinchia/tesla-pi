// Segment arc, S2000-style: a wide segmented tachometer arc, an old-school
// seven-segment speed readout in an LCD window, a trip/odometer LCD under
// it, and two segmented bars, water temperature and GPS readings. The
// geometry is in static/rev-gauge.js (tested); this file draws it. It is
// the one style with a day palette as well as night (static/rev-gauge.css).
import {
  ARC, VIEW, segmentsFor, shownLit, litColor, barLit, angleFor, valueAt, onArc, BAR_N, HIT,
} from '../rev-gauge.js'
import { GaugeStyle, el, text, setText, polar, mix, sevenRow } from './kit.js'

// Unlit arc segments run from warm brown to cool grey; day gets a pale
// version of the same.
const OFF = { night: ['#5a4434', '#3a3d43'], day: ['#e6d5c8', '#d3d7dd'] }
// Water: C is 50 °C, H is 130 °C; the needle sits mid-way at a warm 90.
export const WATER = { lo: 50, hi: 130 }
const BARS = {
  water: { x: 130, y: 322, w: 200, lo: 'C', hi: 'H', caption: 'WATER TEMP' },
  gps:   { x: 670, y: 322, w: 200, lo: '0', hi: '1/s', caption: 'GPS READINGS' },
}

export default class SegmentStyle extends GaugeStyle {
  static meta = {
    key: 'segment', name: 'Segment arc', era: 'S2000-style', view: VIEW, dark: false,
    blurb: 'A 9,000 rpm-style segmented arc, a seven-segment speed LCD, trip and odometer.',
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
    el('ellipse', { cx: 500, cy: 262, rx: 300, ry: 150, fill: this.url('bloom'), class: 'rv-bloom' }, s)
    this.glow = el('path', { class: 'rv-glow', filter: this.url('blur') }, s)
    this.tipGlow = el('circle', { r: 70, fill: this.url('tip'), class: 'rv-tipglow' }, s)
    // The band a finger can grab, shown faintly in simulation mode.
    this.hitBand = el('path', { class: 'rv-hit' }, s)
    this.segG = el('g', { class: 'rv-segs' }, s)
    this.scaleG = el('g', { class: 'rv-scale' }, s)
    this.finger = el('circle', { r: 34, class: 'rv-finger', style: 'display:none' }, s)

    // Speed: three seven-segment digits in a dark red LCD window, the
    // unlit segments faintly showing, as on the old cluster.
    el('rect', { x: 372, y: 198, width: 256, height: 116, rx: 26, class: 'rv-lcd', fill: this.url('lcd') }, s)
    this.speed = sevenRow(s, { x: 392, y: 214, n: 3, w: 52, h: 82, t: 12, gap: 16, skew: 0.1, cls: 'seg7 rv-speed7' })
    text(s, 598, 300, 'rv-lcd-unit', 'km/h')
    this.simTag = text(s, 400, 232, 'rv-sim-tag', 'SIM')
    this.simTag.style.display = 'none'

    // Trip and odometer LCD, under the speed.
    el('rect', { x: 386, y: 324, width: 228, height: 44, rx: 10, class: 'rv-lcd small', fill: this.url('lcd') }, s)
    text(s, 398, 340, 'rv-lcd-label', 'ODO')
    this.odo = sevenRow(s, { x: 397, y: 345, n: 6, w: 11, h: 18, t: 3, gap: 4, skew: 0.1, cls: 'seg7 rv-odo7' })
    text(s, 520, 340, 'rv-lcd-label', 'TRIP A')
    this.trip = sevenRow(s, { x: 520, y: 345, n: 5, w: 11, h: 18, t: 3, gap: 4, skew: 0.1, cls: 'seg7 rv-odo7' })
    el('circle', { cx: 584.2, cy: 362, r: 1.8, class: 'rv-lcd-dot' }, s)

    // Where the reference has arrows: the gear on the left, the speed
    // source on the right.
    const chip = (x, cap, cls) => {
      const g = el('g', { class: 'rv-chip' }, s)
      el('circle', { cx: x, cy: 259, r: 26 }, g)
      const t = text(g, x, 260, cls, '')
      text(s, x, 302, 'rv-chip-cap', cap)
      return t
    }
    this.gear = chip(316, 'GEAR', 'rv-chip-text')
    this.src = chip(684, 'SPEED', 'rv-chip-text small')

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
    const th = el('g', { class: 'rv-icon-line', transform: 'translate(86 331)' }, s)
    el('path', { d: 'M0 -14 V4' }, th)
    el('circle', { cx: 0, cy: 7, r: 4 }, th)
    el('path', { d: 'M4 -10 H8 M4 -5 H8 M4 0 H8' }, th)
    el('path', { d: 'M-14 14 q3.5 -3 7 0 t7 0 t7 0 t7 0' }, th)
    // GPS: a satellite dish.
    const sat = el('g', { class: 'rv-icon-line', transform: 'translate(918 331)' }, s)
    el('path', { d: 'M-10 -4 A12 12 0 0 0 4 10 Z' }, sat)
    el('path', { d: 'M-3 3 L6 -6 M6 -14 A8 8 0 0 1 14 -6 M6 -20 A14 14 0 0 1 20 -6' }, sat)
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
    setText(this.gear, i.gear); setText(this.src, i.source)

    const w = (this.v.water - WATER.lo) / (WATER.hi - WATER.lo)
    this.paintBar(this.bars.water, i.running ? w : 0, force)
    this.paintBar(this.bars.gps, i.fixRate || 0, force)
  }

  paintBar(bar, f, force) {
    const lit = barLit(f, BAR_N)
    if (lit === bar.lit && !force) return
    bar.lit = lit
    bar.segs.forEach((e, k) => {
      const on = k < lit
      const t = k / (BAR_N - 1)
      // Water's hot end is red, lit or not; GPS readings are red when there
      // are too few, like a fuel gauge near empty.
      const hot = bar.kind === 'water' && t > 0.85
      e.classList.toggle('on', on)
      e.classList.toggle('hot', hot)
      const red = on && (hot || (bar.kind === 'gps' && t < 0.15))
      e.classList.toggle('red', red)
      e.style.fill = on && !red ? litColor(bar.kind === 'water' ? 0.25 + t * 0.6 : 0.35 + t * 0.6) : ''
    })
  }
}
