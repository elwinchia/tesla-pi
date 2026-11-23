// Tile grid, DeLorean-style: a sterile grid of brushed dark-grey tiles. Two
// big ones in the middle, a speedometer with a grey sweep behind big
// metallic digits and a needle tachometer with a fuel arc; small needle
// gauges either side (volts, oil temperature, oil pressure, coolant); a
// green seven-segment clock and a tile with the engine and the trip. Our
// own drawing, inspired by the DMC-12's cluster: no marks.
import { GaugeStyle, el, text, setText, polar, arcPath, dialAngle, clamp, sevenRow } from './kit.js'

const VIEW = { w: 1100, h: 400 }
const SPEED = { max: 280, every: 40, a0: 135, a1: 405 }
const TACH = { a0: 150, a1: 390 }
// The fuel arc runs under the tach's hub, E on the left, F on the right.
const FUEL = { a0: 125, a1: 55 }
const BIG_R = 138

const CSS = `
.gs-tiles { font-family: "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif; }
.gs-tiles .tl-plate { fill: #101010; }
.gs-tiles .tl-tile { stroke: #3b3b3b; stroke-width: 1.5; }
.gs-tiles .tl-face { fill: #161616; stroke: #2e2e2e; stroke-width: 1.5; }
.gs-tiles .tl-tick { stroke: #e8e8e8; stroke-width: 2; stroke-linecap: butt; }
.gs-tiles .tl-tick.major { stroke-width: 3.5; }
.gs-tiles .tl-tick.minor { stroke: #9a9a9a; stroke-width: 1.5; }
.gs-tiles .tl-tick.amber { stroke: #f0a81c; }
.gs-tiles .tl-tick.red { stroke: #ff3b30; }
.gs-tiles .tl-num { fill: #f0f0f0; font-size: 21px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.gs-tiles .tl-num.small { font-size: 17px; }
.gs-tiles .tl-num.amber { fill: #f0a81c; }
.gs-tiles .tl-num.red { fill: #ff3b30; }
.gs-tiles .tl-cap { fill: #8c8c8c; font-size: 16px; font-weight: 600; text-anchor: middle; letter-spacing: 0.06em; }
.gs-tiles .tl-cap.left { text-anchor: start; }
.gs-tiles .tl-val { fill: #ededed; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.gs-tiles .tl-car { fill: #f2f2f2; font-size: 22px; font-weight: 700; }
.gs-tiles .tl-sweep { fill: #8a8a8a; opacity: 0.28; }
.gs-tiles .tl-sweep-edge { stroke: #d0d0d0; stroke-width: 3; opacity: 0.85; }
.gs-tiles .tl-speed { font-size: 84px; font-weight: 800; text-anchor: middle; letter-spacing: -3px; font-variant-numeric: tabular-nums; }
.gs-tiles .tl-unit { fill: #d8d8d8; font-size: 18px; font-weight: 700; text-anchor: middle; letter-spacing: 0.08em; }
.gs-tiles .tl-needle { fill: #f4f4f4; }
.gs-tiles .tl-needle.thin { stroke: #f4f4f4; stroke-width: 3; stroke-linecap: round; fill: none; }
.gs-tiles .tl-hub { fill: #2a2a2a; stroke: #5a5a5a; stroke-width: 2; }
.gs-tiles .tl-fuel-off { fill: none; stroke: #4a4a4a; stroke-width: 3; }
.gs-tiles .tl-fuel-on { fill: none; stroke: #f0f0f0; stroke-width: 5; stroke-linecap: round; }
.gs-tiles .tl-fuel-on.low { stroke: #f0a81c; }
.gs-tiles .tl-gearbox { fill: #262626; stroke: #4a4a4a; stroke-width: 1.5; }
.gs-tiles .tl-gear { fill: #f0f0f0; font-size: 30px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.gs-tiles .tl-icon { fill: none; stroke: #9a9a9a; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.gs-tiles .tl-lcd { fill: #04100c; stroke: #1d3a30; stroke-width: 1.5; }
.gs-tiles .tl-tab { fill: #5e1d14; }
.gs-tiles .tl-tabt { fill: #f0c2b2; font-size: 16px; font-weight: 700; text-anchor: middle; dominant-baseline: central; letter-spacing: 0.02em; }
.gs-tiles .tl-seg .off { fill: #2fe6a6; opacity: 0.08; }
.gs-tiles .tl-seg .on { fill: #4dffc0; }
.gs-tiles .tl-finger { fill: rgba(255, 255, 255, 0.14); stroke: #f0f0f0; stroke-width: 3; pointer-events: none; }
.gs-tiles .tl-hit { fill: none; pointer-events: none; }
.gs-tiles[data-sim] .tl-hit { fill: rgba(255, 255, 255, 0.025); }
.gs-tiles[data-zone=red] .tl-num.red { filter: drop-shadow(0 0 4px rgba(255, 59, 48, 0.8)); }
.gs-tiles[data-zone=red] .tl-gearbox { stroke: #ff3b30; }
`

// Small dials: arc on the left (opening right) or on the right. `zone`
// colours the ticks and numbers at the ends.
const SMALL = {
  volts: { lo: 8, hi: 18, labels: ['8', '13', '18'], cap: 'VOLTS', side: 'left', zone: (v) => (v >= 16.5 ? 'red' : v <= 10 ? 'amber' : '') },
  oilTemp: { lo: 40, hi: 140, labels: ['40', '90', '140'], cap: 'OIL °C', side: 'left', zone: (v) => (v >= 125 ? 'red' : v >= 115 ? 'amber' : '') },
  oilPress: { lo: 0, hi: 6, labels: ['0', '3', '6'], cap: 'OIL BAR', side: 'right', zone: (v) => (v <= 0.75 ? 'red' : '') },
  water: { lo: 40, hi: 130, labels: ['40', '85', '130'], cap: 'WATER °C', side: 'right', zone: (v) => (v >= 115 ? 'red' : v >= 105 ? 'amber' : '') },
}

export default class TilesStyle extends GaugeStyle {
  static meta = {
    key: 'tiles', name: 'Tile grid', era: 'DeLorean-style', view: VIEW, dark: true,
    blurb: 'Brushed grey tiles: a speedometer with metallic digits, a needle tach, four small dials and a green LCD clock.',
  }

  build() {
    const s = this.svg
    this.css(CSS)
    const defs = el('defs', {}, s)
    // Brushed metal: a vertical shade under fine horizontal lines.
    const shade = el('linearGradient', { id: this.id('shade'), x1: 0, y1: 0, x2: 0, y2: 1 }, defs)
    el('stop', { offset: 0, 'stop-color': '#2d2d2d' }, shade)
    el('stop', { offset: 1, 'stop-color': '#1c1c1c' }, shade)
    const brush = el('pattern', { id: this.id('brush'), width: 7, height: 3, patternUnits: 'userSpaceOnUse' }, defs)
    el('rect', { x: 0, y: 0, width: 7, height: 1, fill: '#ffffff', opacity: 0.035 }, brush)
    el('rect', { x: 2, y: 2, width: 5, height: 1, fill: '#000000', opacity: 0.12 }, brush)
    const chrome = el('linearGradient', { id: this.id('chrome'), x1: 0, y1: 0, x2: 0, y2: 1 }, defs)
    for (const [o, c] of [[0, '#ffffff'], [0.46, '#d9d9d9'], [0.52, '#8e8e8e'], [0.75, '#c8c8c8'], [1, '#f2f2f2']]) el('stop', { offset: o, 'stop-color': c }, chrome)
    this.chromeUrl = this.url('chrome')

    el('rect', { x: 0, y: 0, width: VIEW.w, height: VIEW.h, rx: 22, class: 'tl-plate' }, s)
    const tile = (x, y, w, h) => {
      el('rect', { x, y, width: w, height: h, rx: 14, fill: this.url('shade'), class: 'tl-tile' }, s)
      el('rect', { x, y, width: w, height: h, rx: 14, fill: this.url('brush') }, s)
    }
    tile(10, 10, 135, 185); tile(10, 205, 135, 185)
    tile(155, 10, 310, 380); tile(475, 10, 310, 380)
    tile(795, 10, 135, 185); tile(795, 205, 135, 185)
    tile(940, 10, 150, 220); tile(940, 240, 150, 150)

    this.small = [
      this.smallDial(s, 77.5, 102.5, 'volts'), this.smallDial(s, 77.5, 297.5, 'oilTemp'),
      this.smallDial(s, 862.5, 102.5, 'oilPress'), this.smallDial(s, 862.5, 297.5, 'water'),
    ]
    this.buildSpeed(s)
    this.buildTach(s)
    this.buildClock(s)
    this.buildInfo(s)
  }

  // ── Small needle gauges ──
  smallDial(s, cx, cy, key) {
    const d = SMALL[key], r = 54
    const left = d.side === 'left'
    const a0 = 90, a1 = left ? 270 : -90
    el('circle', { cx, cy, r: r + 6, class: 'tl-face' }, s)
    for (let k = 0; k <= 10; k++) {
      const v = d.lo + ((d.hi - d.lo) * k) / 10
      const a = dialAngle(v, d.lo, d.hi, a0, a1)
      const major = k % 5 === 0
      const [x0, y0] = polar(cx, cy, r, a), [x1, y1] = polar(cx, cy, r - (major ? 11 : 6), a)
      const z = d.zone(v)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: 'tl-tick' + (major ? ' major' : ' minor') + (z ? ' ' + z : '') }, s)
      if (major) {
        // The end labels lean in off the stops, so a resting needle
        // does not cover them.
        const lean = k === 0 ? 1 : k === 10 ? -1 : 0
        const [lx, ly] = polar(cx, cy, r - (lean ? 22 : 25), a + lean * Math.sign(a1 - a0) * 36)
        text(s, lx.toFixed(1), ly.toFixed(1), 'tl-num small' + (z ? ' ' + z : ''), d.labels[k / 5])
      }
    }
    // The icon sits on the open side, the caption under the dial.
    this.icon(s, key, cx + (left ? 26 : -26), cy)
    text(s, cx, cy + r + 30, 'tl-cap', d.cap)
    const needle = el('line', { x1: cx - 8, y1: cy, x2: cx + r - 6, y2: cy, class: 'tl-needle thin' }, s)
    el('circle', { cx, cy, r: 6, class: 'tl-hub' }, s)
    return { key, d, cx, cy, a0, a1, needle, a: null }
  }

  icon(s, key, x, y) {
    const g = el('g', { class: 'tl-icon', transform: `translate(${x} ${y})` }, s)
    if (key === 'volts') {
      el('rect', { x: -11, y: -6, width: 22, height: 14, rx: 2 }, g)
      el('path', { d: 'M-7 -6 V-9 M7 -6 V-9 M-8 1 H-3 M3 1 H8 M5.5 -1.5 V3.5' }, g)
    } else if (key === 'water') {
      el('path', { d: 'M0 -12 V3 M4 -9 H8 M4 -4 H8 M-11 10 q3 -3 5.5 0 t5.5 0 t5.5 0 t5.5 0' }, g)
      el('circle', { cx: 0, cy: 5, r: 3 }, g)
    } else {
      // An oil can: the drop under its spout says oil.
      el('path', { d: 'M-12 -2 H4 L12 -7 L4 6 H-12 Z M-6 -2 V-6 H0 V-2' }, g)
      el('path', { d: 'M12 2 q-2 3 0 5 q2 -2 0 -5' }, g)
      if (key === 'oilTemp') el('path', { d: 'M-4 9 V14 M0 9 V14' }, g)
    }
  }

  // ── Speedometer ──
  buildSpeed(s) {
    const cx = 310, cy = 200
    this.sc = { cx, cy }
    el('circle', { cx, cy, r: BIG_R + 8, class: 'tl-face' }, s)
    this.sweep = el('path', { class: 'tl-sweep' }, s)
    this.sweepEdge = el('line', { class: 'tl-sweep-edge' }, s)
    for (let v = 0; v <= SPEED.max; v += 10) {
      const a = dialAngle(v, 0, SPEED.max, SPEED.a0, SPEED.a1)
      const major = v % SPEED.every === 0, mid = v % 20 === 0
      const [x0, y0] = polar(cx, cy, BIG_R, a), [x1, y1] = polar(cx, cy, BIG_R - (major ? 16 : mid ? 11 : 6), a)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: 'tl-tick' + (major ? ' major' : mid ? '' : ' minor') }, s)
      if (major) {
        const [lx, ly] = polar(cx, cy, BIG_R - 36, a)
        text(s, lx.toFixed(1), ly.toFixed(1), 'tl-num', String(v))
      }
    }
    // Metallic digits, a vertical chrome gradient in the text.
    this.speedT = text(s, cx, cy + 26, 'tl-speed', '', { fill: this.chromeUrl })
    text(s, cx, cy + 56, 'tl-unit', 'KM/H')
    this.srcT = text(s, cx, cy + 160, 'tl-cap', '')
  }

  // ── Tachometer ──
  buildTach(s) {
    const cx = 630, cy = 200
    this.tc = { cx, cy }
    this.tachHit = el('circle', { cx, cy, r: BIG_R + 8, class: 'tl-hit' }, s)
    el('circle', { cx, cy, r: BIG_R + 8, class: 'tl-face' }, s)
    this.tachG = el('g', {}, s)
    text(s, cx, cy - 52, 'tl-cap', 'RPM ×1000')
    // Fuel: an arc under the hub, E 1/2 F, lit white from E.
    el('path', { d: arcPath(cx, cy, BIG_R - 4, FUEL.a0, FUEL.a1), class: 'tl-fuel-off' }, s)
    for (const [f, t] of [[0, 'E'], [0.5, '½'], [1, 'F']]) {
      const a = FUEL.a0 + f * (FUEL.a1 - FUEL.a0)
      const [x0, y0] = polar(cx, cy, BIG_R - 4, a), [x1, y1] = polar(cx, cy, BIG_R - 14, a)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: 'tl-tick' }, s)
      const [lx, ly] = polar(cx, cy, BIG_R - 30, a)
      text(s, lx.toFixed(1), ly.toFixed(1), 'tl-num small', t)
    }
    this.fuelOn = el('path', { class: 'tl-fuel-on' }, s)
    // The gear, in a little square under the hub.
    el('rect', { x: cx - 24, y: cy + 26, width: 48, height: 44, rx: 6, class: 'tl-gearbox' }, s)
    this.gearT = text(s, cx, cy + 49, 'tl-gear', '')
    // The needle points along +x and turns about the hub.
    this.tachNeedle = el('polygon', { points: `${cx - 22},${cy - 4} ${cx + 128},${cy - 1.2} ${cx + 128},${cy + 1.2} ${cx - 22},${cy + 4}`, class: 'tl-needle' }, s)
    el('circle', { cx, cy, r: 13, class: 'tl-hub' }, s)
    this.finger = el('circle', { r: 26, class: 'tl-finger', style: 'display:none' }, s)
    this.simTag = text(s, cx + 120, 40, 'tl-cap', 'SIM')
    this.simTag.style.display = 'none'
  }

  // ── Clock: green seven-segment fields under red-brown tabs ──
  buildClock(s) {
    const field = (cx, y, n, label, tabW) => {
      el('rect', { x: cx - tabW / 2, y, width: tabW, height: 20, rx: 3, class: 'tl-tab' }, s)
      text(s, cx, y + 10.5, 'tl-tabt', label)
      const w = 20, gap = 5, W = n * w + (n - 1) * gap
      el('rect', { x: cx - W / 2 - 6, y: y + 23, width: W + 12, height: 40, rx: 4, class: 'tl-lcd' }, s)
      return sevenRow(s, { x: cx - W / 2, y: y + 26, n, w, h: 34, t: 5, gap, skew: 0, cls: 'tl-seg' })
    }
    this.mon = field(978, 18, 2, 'MONTH', 66)
    this.day = field(1052, 18, 2, 'DAY', 66)
    this.year = field(1015, 86, 4, 'YEAR', 66)
    this.hour = field(978, 154, 2, 'HOUR', 66)
    this.min = field(1052, 154, 2, 'MIN', 66)
  }

  // ── The engine and the distances, where the reference has a cassette ──
  buildInfo(s) {
    text(s, 954, 266, 'tl-cap left', 'ENGINE')
    this.carA = text(s, 954, 292, 'tl-car', '')
    this.carB = text(s, 954, 314, 'tl-cap left', '')
    el('line', { x1: 954, y1: 326, x2: 1076, y2: 326, stroke: '#3a3a3a', 'stroke-width': 1.5 }, s)
    text(s, 954, 350, 'tl-cap left', 'TRIP km')
    this.tripT = text(s, 1076, 350, 'tl-val', '', { 'text-anchor': 'end' })
    text(s, 954, 376, 'tl-cap left', 'ODO km')
    this.odoT = text(s, 1076, 376, 'tl-val', '', { 'text-anchor': 'end' })
  }

  onScale(scale) {
    const g = this.tachG
    while (g.firstChild) g.removeChild(g.firstChild)
    const { cx, cy } = this.tc
    for (let v = 0; v <= scale.max; v += 500) {
      const a = dialAngle(v, 0, scale.max, TACH.a0, TACH.a1)
      const major = v % 1000 === 0, red = v >= scale.redFrom
      // Past the redline the ticks are short red bars, as on the original.
      const len = red ? 18 : major ? 16 : 8
      const [x0, y0] = polar(cx, cy, BIG_R, a), [x1, y1] = polar(cx, cy, BIG_R - len, a)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: 'tl-tick' + (major ? ' major' : ' minor') + (red ? ' red' : '') }, g)
      if (major) {
        const [lx, ly] = polar(cx, cy, BIG_R - 38, a)
        text(g, lx.toFixed(1), ly.toFixed(1), 'tl-num' + (red ? ' red' : ''), String(v / 1000))
      }
    }
    this.tachA = null
  }

  rpmAt(x, y) {
    const { cx, cy } = this.tc
    const d = Math.hypot(x - cx, y - cy)
    if (d > BIG_R + 10 || d < 20) return null
    let a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
    if (a < TACH.a0) a += 360
    // In the gap at the bottom, the nearer end.
    if (a > TACH.a1) a = a - TACH.a1 < TACH.a0 + 360 - a ? TACH.a1 : TACH.a0
    return ((a - TACH.a0) / (TACH.a1 - TACH.a0)) * this.scale.max
  }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(this.tc.cx, this.tc.cy, BIG_R - 60, dialAngle(rpm, 0, this.scale.max, TACH.a0, TACH.a1))
    this.finger.setAttribute('cx', fx.toFixed(1)); this.finger.setAttribute('cy', fy.toFixed(1))
    this.finger.style.display = ''
  }
  onFingerUp() { this.finger.style.display = 'none' }
  onTouchMode(on) { this.simTag.style.display = on ? '' : 'none' }

  paint(force) {
    const v = this.v, i = this.i
    // Tach needle.
    const ta = dialAngle(v.rpm, 0, this.scale.max, TACH.a0, TACH.a1)
    if (force || this.tachA == null || Math.abs(ta - this.tachA) > 0.05) {
      this.tachA = ta
      this.tachNeedle.setAttribute('transform', `rotate(${ta.toFixed(2)} ${this.tc.cx} ${this.tc.cy})`)
    }
    // Speed: the grey sweep from 0 to the speed, and the digits.
    const sa = dialAngle(v.kmh, 0, SPEED.max, SPEED.a0, SPEED.a1)
    if (force || this.speedA == null || Math.abs(sa - this.speedA) > 0.05) {
      this.speedA = sa
      const { cx, cy } = this.sc
      if (sa - SPEED.a0 < 0.2) {
        this.sweep.setAttribute('d', ''); this.sweepEdge.style.display = 'none'
      } else {
        const rO = BIG_R, rI = 76, large = sa - SPEED.a0 > 180 ? 1 : 0
        const [ox0, oy0] = polar(cx, cy, rO, SPEED.a0), [ox1, oy1] = polar(cx, cy, rO, sa)
        const [ix1, iy1] = polar(cx, cy, rI, sa), [ix0, iy0] = polar(cx, cy, rI, SPEED.a0)
        const f = (n) => n.toFixed(1)
        this.sweep.setAttribute('d', `M${f(ox0)} ${f(oy0)}A${rO} ${rO} 0 ${large} 1 ${f(ox1)} ${f(oy1)}L${f(ix1)} ${f(iy1)}A${rI} ${rI} 0 ${large} 0 ${f(ix0)} ${f(iy0)}Z`)
        this.sweepEdge.setAttribute('x1', f(ix1)); this.sweepEdge.setAttribute('y1', f(iy1))
        this.sweepEdge.setAttribute('x2', f(ox1)); this.sweepEdge.setAttribute('y2', f(oy1))
        this.sweepEdge.style.display = ''
      }
    }
    setText(this.speedT, i.stale ? '--' : String(Math.min(999, Math.round(v.kmh))))
    setText(this.srcT, i.source)
    setText(this.gearT, i.gear)

    // Fuel arc.
    const fuel = clamp(v.fuel, 0, 1)
    if (force || this.fuelF == null || Math.abs(fuel - this.fuelF) > 0.002) {
      this.fuelF = fuel
      const { cx, cy } = this.tc
      this.fuelOn.setAttribute('d', fuel > 0.005 ? arcPath(cx, cy, BIG_R - 4, FUEL.a0, FUEL.a0 + fuel * (FUEL.a1 - FUEL.a0)) : '')
      this.fuelOn.classList.toggle('low', fuel < 0.15)
    }

    // Small dials; with the engine off they rest at the bottom stop.
    for (const sd of this.small) {
      const a = dialAngle(v[sd.key], sd.d.lo, sd.d.hi, sd.a0, sd.a1)
      if (!force && sd.a != null && Math.abs(a - sd.a) < 0.05) continue
      sd.a = a
      sd.needle.setAttribute('transform', `rotate(${a.toFixed(2)} ${sd.cx} ${sd.cy})`)
    }

    // Clock: only when the minute changes.
    const c = i.clock instanceof Date ? i.clock : new Date()
    const stamp = c.getFullYear() * 1e8 + (c.getMonth() + 1) * 1e6 + c.getDate() * 1e4 + c.getHours() * 100 + c.getMinutes()
    if (force || stamp !== this.stamp) {
      this.stamp = stamp
      const two = (n) => String(n).padStart(2, '0')
      this.mon.set(two(c.getMonth() + 1)); this.day.set(two(c.getDate()))
      this.year.set(String(c.getFullYear())); this.hour.set(two(c.getHours())); this.min.set(two(c.getMinutes()))
    }

    // The engine's name, split at its dot: "V10" over "LFA-style".
    if (force || i.car !== this.car) {
      this.car = i.car
      const [a, ...b] = String(i.car || '').split(' · ')
      setText(this.carA, a || '—'); setText(this.carB, b.join(' · '))
    }
    setText(this.tripT, (Math.floor(v.trip * 10) / 10 % 10000).toFixed(1))
    setText(this.odoT, String(Math.floor(v.odo) % 1000000))
  }
}
