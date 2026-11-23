// Digital bars, Corvette C4-style: an 80s digital dash. Two panels of thin
// bar segments that climb a rounded "L" up and to the right, speed on the
// left and revs on the right, each with a big glowing number in a box; in
// the middle, oil and coolant tiles, a stacked fuel bar, and trip and gear
// readouts. Our own drawing, inspired by the C4's cluster: no marks.
import { GaugeStyle, el, text, setText, clamp, mix } from './kit.js'

const VIEW = { w: 1040, h: 400 }
const C = {
  yellow: '#ffe14a', green: '#6fdc3c', tail: '#4fb432', off: '#22421c', orange: '#ff8a1f', red: '#ff3b30',
  offRed: '#3e1a14', offOrange: '#3a2a12',
}
const SPEED = { max: 280, every: 40, bars: 56 }
const TACH_BARS = 60
const FUEL_BARS = 14

// The bar column's outer edge: up from (x, yb) to (x, yc), a quarter turn
// of radius R, then right to xe. Bars grow inward from it, wider as they
// climb, as on the original.
const G = { x: 66, yb: 378, yc: 232, R: 150, xe: 330, w0: 26, w1: 96 }
const L1 = G.yb - G.yc, L2 = (Math.PI * G.R) / 2, L3 = G.xe - (G.x + G.R), LEN = L1 + L2 + L3
const bandW = (s) => G.w0 + (G.w1 - G.w0) * s
// Point on the outer edge at s (0..1) and the inward normal there, in
// panel coordinates.
function at(s) {
  const d = clamp(s, 0, 1) * LEN
  if (d <= L1) return { x: G.x, y: G.yb - d, nx: 1, ny: 0 }
  if (d <= L1 + L2) {
    const a = Math.PI + (d - L1) / G.R
    const c = Math.cos(a), sn = Math.sin(a)
    return { x: G.x + G.R + G.R * c, y: G.yc + G.R * sn, nx: -c, ny: -sn }
  }
  return { x: G.x + G.R + (d - L1 - L2), y: G.yc - G.R, nx: 0, ny: 1 }
}
// The inverse, for a finger: s under a point, or null if it is off the band.
function sAt(x, y) {
  const cands = []
  if (y <= G.yb + 20 && y >= G.yc) cands.push([(G.yb - y) / LEN, x - G.x])
  const cx = G.x + G.R, cy = G.yc
  if (x <= cx && y <= cy) {
    const a = Math.atan2(y - cy, x - cx) + 2 * Math.PI // 180°..270°
    if (a >= Math.PI && a <= 1.5 * Math.PI) cands.push([(L1 + (a - Math.PI) * G.R) / LEN, G.R - Math.hypot(x - cx, y - cy)])
  }
  if (x >= cx && x <= G.xe + 20) cands.push([(L1 + L2 + x - cx) / LEN, y - (G.yc - G.R)])
  let best = null
  for (const [s, inward] of cands) {
    const w = bandW(clamp(s, 0, 1))
    if (inward < -40 || inward > w + 30) continue
    const miss = Math.abs(inward - w / 2)
    if (!best || miss < best[1]) best = [clamp(s, 0, 1), miss]
  }
  return best ? best[0] : null
}
const pt = (x, y) => x.toFixed(1) + ',' + y.toFixed(1)
// One bar from s0 to s1: a quad across the band.
function barPoints(ox, s0, s1) {
  const a = at(s0), b = at(s1), wa = bandW(s0), wb = bandW(s1)
  return [pt(ox + a.x, a.y), pt(ox + b.x, b.y), pt(ox + b.x + b.nx * wb, b.y + b.ny * wb), pt(ox + a.x + a.nx * wa, a.y + a.ny * wa)].join(' ')
}

// The tach's colour for an rpm: green, then yellow, orange near the
// redline, red past it.
function tachColor(rpm, scale) {
  const r = scale.redFrom
  if (rpm >= r) return C.red
  if (rpm >= scale.warnFrom) return C.orange
  const f = rpm / r
  if (f < 0.45) return C.green
  if (f < 0.7) return mix(C.green, C.yellow, (f - 0.45) / 0.25)
  return mix(C.yellow, C.orange, (f - 0.7) / Math.max(0.01, scale.warnFrom / r - 0.7))
}

const CSS = `
.gs-digital { font-family: ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif; }
.gs-digital .dg-plate { fill: #0b0c09; }
.gs-digital .dg-panel { fill: #14160f; stroke: #2b2f24; stroke-width: 2; }
.gs-digital .dg-inset { fill: #0f110b; stroke: #2b2f24; stroke-width: 2; }
.gs-digital .dg-bar { fill: ${C.off}; }
.gs-digital .dg-bar.red { fill: ${C.offRed}; }
.gs-digital .dg-bar.warn { fill: ${C.offOrange}; }
.gs-digital .dg-num { fill: ${C.yellow}; font-size: 19px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
.gs-digital .dg-num.red { fill: ${C.red}; }
.gs-digital .dg-tick { stroke: ${C.yellow}; stroke-width: 2.5; stroke-linecap: round; }
.gs-digital .dg-tick.minor { stroke-width: 1.6; opacity: 0.55; }
.gs-digital .dg-tick.red { stroke: ${C.red}; }
.gs-digital .dg-box { fill: #12140a; stroke: #6c6a22; stroke-width: 2.5; }
.gs-digital .dg-big { fill: ${C.yellow}; font-weight: 600; text-anchor: middle; font-variant-numeric: tabular-nums; }
.gs-digital .dg-halo { fill: none; stroke: ${C.yellow}; stroke-width: 7; stroke-linejoin: round; opacity: 0.16; }
.gs-digital .dg-unit { fill: ${C.yellow}; font-size: 18px; font-weight: 600; text-anchor: middle; font-style: italic; letter-spacing: 0.04em; }
.gs-digital .dg-lab { fill: ${C.yellow}; font-size: 16px; font-weight: 700; letter-spacing: 0.03em; }
.gs-digital .dg-lab.dim { fill: #77744a; }
.gs-digital .dg-lab.mid { text-anchor: middle; }
.gs-digital .dg-lab.end { text-anchor: end; }
.gs-digital .dg-small { fill: ${C.yellow}; font-size: 16px; font-weight: 600; }
.gs-digital .dg-track { fill: #3a2410; }
.gs-digital .dg-fill { fill: ${C.orange}; }
.gs-digital .dg-fill.hot { fill: ${C.red}; }
.gs-digital .dg-car { fill: #b8b260; font-size: 18px; font-weight: 600; text-anchor: middle; }
.gs-digital .dg-clock { fill: ${C.green}; font-size: 24px; font-weight: 700; text-anchor: middle; font-variant-numeric: tabular-nums; }
.gs-digital .dg-finger { fill: rgba(255, 225, 74, 0.18); stroke: ${C.yellow}; stroke-width: 3; pointer-events: none; }
.gs-digital .dg-hit { fill: none; stroke: transparent; pointer-events: none; }
.gs-digital[data-sim] .dg-hit { stroke: rgba(255, 225, 74, 0.04); }
.gs-digital[data-zone=red] .dg-tach-box { stroke: ${C.red}; }
.gs-digital[data-zone=red] .dg-tach-num { fill: ${C.red}; }
.gs-digital[data-zone=red] .dg-tach-halo { stroke: ${C.red}; opacity: 0.3; }
`

export default class DigitalStyle extends GaugeStyle {
  static meta = {
    key: 'digital', name: 'Digital bars', era: 'Corvette C4-style', view: VIEW, dark: true,
    blurb: 'An 80s digital dash: climbing bar graphs for speed and revs, big glowing numbers, oil, coolant and fuel bars.',
  }

  build() {
    const s = this.svg
    this.css(CSS)
    const defs = el('defs', {}, s)
    const tip = el('radialGradient', { id: this.id('tip') }, defs)
    el('stop', { offset: '0', 'stop-color': C.yellow, 'stop-opacity': '0.45' }, tip)
    el('stop', { offset: '1', 'stop-color': C.yellow, 'stop-opacity': '0' }, tip)

    el('rect', { x: 0, y: 0, width: VIEW.w, height: VIEW.h, rx: 26, class: 'dg-plate' }, s)
    // Left: speed. Right: revs. Both panels share the bar column's shape.
    this.SP = 0; this.TA = 696
    el('rect', { x: 6, y: 6, width: 338, height: 388, rx: 20, class: 'dg-panel' }, s)
    el('rect', { x: this.TA, y: 6, width: 338, height: 388, rx: 20, class: 'dg-panel' }, s)

    this.speedTip = el('circle', { r: 46, fill: this.url('tip'), style: 'display:none' }, s)
    this.tachTip = el('circle', { r: 46, fill: this.url('tip'), style: 'display:none' }, s)

    // Speed bars and scale, drawn once: km/h does not change with the car.
    const sg = el('g', {}, s)
    this.speedBars = []
    for (let i = 0; i < SPEED.bars; i++) {
      this.speedBars.push(el('polygon', { points: barPoints(this.SP, (i + 0.2) / SPEED.bars, (i + 0.8) / SPEED.bars), class: 'dg-bar' }, sg))
    }
    this.drawScale(sg, this.SP, SPEED.max, SPEED.every, SPEED.every / 2, (v) => String(v), () => false)

    // The tach's bars and scale are drawn in onScale.
    this.tachHit = el('path', { class: 'dg-hit' }, s)
    this.tachG = el('g', {}, s)

    // Number boxes.
    const box = (ox, unit, cls) => {
      el('rect', { x: ox + 150, y: 250, width: 170, height: 128, rx: 16, class: 'dg-box ' + cls }, s)
      const halo = text(s, ox + 235, 336, 'dg-big dg-halo ' + cls.replace('box', 'halo'), '', { 'font-size': 86 })
      const t = text(s, ox + 235, 336, 'dg-big ' + cls.replace('box', 'num'), '', { 'font-size': 86 })
      text(s, ox + 235, 366, 'dg-unit', unit)
      return [halo, t]
    }
    this.speedNum = box(this.SP, 'KM/H', 'dg-speed-box')
    this.tachNum = box(this.TA, 'RPM/100', 'dg-tach-box')
    this.simTag = text(s, this.TA + 300, 40, 'dg-lab end', 'SIM')
    this.simTag.style.display = 'none'
    this.finger = el('circle', { r: 30, class: 'dg-finger', style: 'display:none' }, s)

    this.buildCentre(s)
  }

  // Ticks and numbers outside the column, every `every`; minor ticks
  // every `minor`.
  drawScale(g, ox, max, every, minor, label, isRed) {
    for (let v = 0; v <= max + 1e-6; v += minor) {
      const p = at(v / max)
      const major = Math.abs(v / every - Math.round(v / every)) < 1e-6
      const r = isRed(v) ? ' red' : ''
      const t0 = major ? 6 : 6, t1 = major ? 15 : 11
      el('line', { x1: (ox + p.x - p.nx * t0).toFixed(1), y1: (p.y - p.ny * t0).toFixed(1), x2: (ox + p.x - p.nx * t1).toFixed(1), y2: (p.y - p.ny * t1).toFixed(1), class: 'dg-tick' + (major ? '' : ' minor') + r }, g)
      if (major) text(g, (ox + p.x - p.nx * 34).toFixed(1), (p.y - p.ny * 30).toFixed(1), 'dg-num' + r, label(v))
    }
  }

  buildCentre(s) {
    // Oil and coolant tiles: a big number, an orange bar, two labels.
    const tile = (x, cap, sub) => {
      el('rect', { x, y: 6, width: 116, height: 186, rx: 14, class: 'dg-panel' }, s)
      // The unit sits in the corner, above the digits, so 117 still fits.
      const halo = text(s, x + 58, 78, 'dg-big dg-halo', '', { 'font-size': 48 })
      const num = text(s, x + 58, 78, 'dg-big', '', { 'font-size': 48 })
      text(s, x + 106, 28, 'dg-small', '°C', { 'text-anchor': 'end' })
      for (let k = 0; k <= 4; k++) el('line', { x1: x + 14 + k * 22, y1: 92, x2: x + 14 + k * 22, y2: k % 2 ? 98 : 101, class: 'dg-tick minor' }, s)
      el('rect', { x: x + 12, y: 104, width: 92, height: 8, rx: 3, class: 'dg-track' }, s)
      const fill = el('rect', { x: x + 12, y: 104, width: 0, height: 8, rx: 3, class: 'dg-fill' }, s)
      text(s, x + 12, 146, 'dg-lab', cap)
      text(s, x + 12, 174, 'dg-lab dim', sub[0])
      const val = text(s, x + 104, 174, 'dg-lab end', '')
      return { halo, num, fill, val, w: -1, last: '' }
    }
    this.oil = tile(352, 'OIL TEMP', ['PRESS'])
    this.water = tile(572, 'COOLANT', ['VOLTS'])

    // Fuel: a stack of bars, E at the bottom.
    el('rect', { x: 474, y: 6, width: 92, height: 186, rx: 14, class: 'dg-panel' }, s)
    this.fuelBars = []
    for (let k = 0; k < FUEL_BARS; k++) {
      const y = 150 - k * 9.6
      const t = k / (FUEL_BARS - 1)
      const col = k < 2 ? C.orange : t < 0.5 ? mix(C.yellow, '#d8ec46', t * 2) : mix('#d8ec46', C.green, (t - 0.5) * 2)
      this.fuelBars.push({ e: el('rect', { x: 486, y: y.toFixed(1), width: 50, height: 6, rx: 2, class: 'dg-bar' }, s), col })
    }
    for (let k = 0; k <= 4; k++) el('line', { x1: 541, y1: 156 - k * 33.6, x2: k % 2 ? 547 : 550, y2: 156 - k * 33.6, class: 'dg-tick minor' }, s)
    text(s, 556, 26, 'dg-lab', 'F', { 'dominant-baseline': 'central' })
    text(s, 556, 156, 'dg-lab', 'E', { 'dominant-baseline': 'central' })
    text(s, 520, 180, 'dg-lab mid', 'FUEL')

    // Trip and gear: two readouts under headers, one header lit as on the
    // original's mode buttons; the dim one shows the odometer and the speed
    // source instead of a mode we do not have.
    el('rect', { x: 352, y: 200, width: 336, height: 122, rx: 16, class: 'dg-panel' }, s)
    this.odoLab = text(s, 368, 226, 'dg-lab dim', '')
    text(s, 508, 226, 'dg-lab end', 'TRIP')
    text(s, 536, 226, 'dg-lab', 'GEAR')
    this.srcLab = text(s, 672, 226, 'dg-lab dim end', '')
    el('rect', { x: 362, y: 238, width: 154, height: 72, rx: 12, class: 'dg-inset' }, s)
    el('rect', { x: 524, y: 238, width: 154, height: 72, rx: 12, class: 'dg-inset' }, s)
    text(s, 374, 290, 'dg-small', 'KM')
    this.tripNum = text(s, 504, 292, 'dg-big', '', { 'font-size': 40, 'text-anchor': 'end' })
    this.gearHalo = text(s, 601, 293, 'dg-big dg-halo', '', { 'font-size': 46 })
    this.gearNum = text(s, 601, 293, 'dg-big', '', { 'font-size': 46 })

    // Engine name and the time, where the original has its radio strip.
    el('rect', { x: 352, y: 330, width: 336, height: 64, rx: 16, class: 'dg-panel' }, s)
    this.carT = text(s, 520, 356, 'dg-car', '')
    this.clockT = text(s, 520, 384, 'dg-clock', '', { 'font-size': 22 })
  }

  onScale(scale) {
    const g = this.tachG
    while (g.firstChild) g.removeChild(g.firstChild)
    this.tachBars = []
    for (let i = 0; i < TACH_BARS; i++) {
      const rpm = (i / TACH_BARS) * scale.max
      const cls = rpm >= scale.redFrom ? 'dg-bar red' : rpm >= scale.warnFrom ? 'dg-bar warn' : 'dg-bar'
      const e = el('polygon', { points: barPoints(this.TA, (i + 0.2) / TACH_BARS, (i + 0.8) / TACH_BARS), class: cls }, g)
      this.tachBars.push({ e, col: tachColor(rpm + scale.max / TACH_BARS / 2, scale) })
    }
    this.drawScale(g, this.TA, scale.max, 1000, 500, (v) => String(v / 100), (v) => v >= scale.redFrom)
    // The band a finger can grab, shown faintly in simulation mode.
    const mid = (k) => { const p = at(k); const w = bandW(k) / 2; return pt(this.TA + p.x + p.nx * w, p.y + p.ny * w) }
    const pts = []
    for (let k = 0; k <= 40; k++) pts.push(mid(k / 40))
    this.tachHit.setAttribute('d', 'M' + pts.join('L'))
    this.tachHit.setAttribute('stroke-width', 70)
    this.tachLit = -1
  }

  rpmAt(x, y) {
    const sv = sAt(x - this.TA, y)
    return sv == null ? null : sv * this.scale.max
  }
  onFinger(x, y, rpm) {
    const p = at(rpm / this.scale.max), w = bandW(rpm / this.scale.max) / 2
    this.finger.setAttribute('cx', (this.TA + p.x + p.nx * w).toFixed(1))
    this.finger.setAttribute('cy', (p.y + p.ny * w).toFixed(1))
    this.finger.style.display = ''
  }
  onFingerUp() { this.finger.style.display = 'none' }
  onTouchMode(on) { this.simTag.style.display = on ? '' : 'none' }

  paint(force) {
    if (!this.tachBars) return
    const v = this.v, i = this.i

    // Speed: the lit run fades from green into a yellow tip.
    const sLit = clamp(Math.round((v.kmh / SPEED.max) * SPEED.bars), 0, SPEED.bars)
    if (force || sLit !== this.speedLit) {
      this.speedLit = sLit
      this.speedBars.forEach((e, k) => {
        const d = sLit - 1 - k
        e.style.fill = k < sLit ? (d < 2 ? C.yellow : d < 14 ? mix(C.yellow, C.green, (d - 2) / 12) : C.tail) : ''
      })
      this.tip(this.speedTip, this.SP, sLit, SPEED.bars)
    }
    // Revs: each bar keeps its own colour along the scale.
    const tLit = clamp(Math.round((v.rpm / this.scale.max) * TACH_BARS), 0, TACH_BARS)
    if (force || tLit !== this.tachLit) {
      const from = force || this.tachLit < 0 ? 0 : Math.min(tLit, this.tachLit)
      const to = force || this.tachLit < 0 ? TACH_BARS : Math.max(tLit, this.tachLit)
      for (let k = from; k < to; k++) this.tachBars[k].e.style.fill = k < tLit ? this.tachBars[k].col : ''
      this.tachLit = tLit
      this.tip(this.tachTip, this.TA, tLit, TACH_BARS)
    }

    const sp = i.stale ? '--' : String(Math.min(999, Math.round(v.kmh)))
    setText(this.speedNum[0], sp); setText(this.speedNum[1], sp)
    const rp = String(Math.round(v.rpm / 100))
    setText(this.tachNum[0], rp); setText(this.tachNum[1], rp)

    this.paintTile(this.oil, v.oilTemp, 40, 150, 130, v.oilPress.toFixed(1), force)
    this.paintTile(this.water, v.water, 40, 130, 112, v.volts.toFixed(1), force)

    const fLit = clamp(Math.round(v.fuel * FUEL_BARS), 0, FUEL_BARS)
    if (force || fLit !== this.fuelLit) {
      this.fuelLit = fLit
      this.fuelBars.forEach((b, k) => { b.e.style.fill = k < fLit ? b.col : '' })
    }

    setText(this.odoLab, 'ODO ' + Math.floor(v.odo))
    setText(this.tripNum, (Math.floor(v.trip * 10) / 10 % 10000).toFixed(1))
    setText(this.gearHalo, i.gear); setText(this.gearNum, i.gear)
    setText(this.srcLab, i.source)
    setText(this.carT, i.car || '')
    const c = i.clock instanceof Date ? i.clock : new Date()
    setText(this.clockT, String(c.getHours()).padStart(2, '0') + ':' + String(c.getMinutes()).padStart(2, '0'))
  }

  // A soft glow riding the lit run's tip (a gradient, no filter).
  tip(e, ox, lit, n) {
    if (lit < 1) { e.style.display = 'none'; return }
    const sv = (lit - 0.5) / n, p = at(sv), w = bandW(sv) / 2
    e.setAttribute('cx', (ox + p.x + p.nx * w).toFixed(1)); e.setAttribute('cy', (p.y + p.ny * w).toFixed(1))
    e.style.display = ''
  }

  paintTile(t, val, lo, hi, hot, sub, force) {
    const n = String(Math.round(val))
    setText(t.halo, n); setText(t.num, n)
    setText(t.val, sub)
    const w = Math.round(clamp((val - lo) / (hi - lo), 0, 1) * 92)
    if (force || w !== t.w) {
      t.w = w
      t.fill.setAttribute('width', w)
      t.fill.classList.toggle('hot', val >= hot)
    }
  }
}
