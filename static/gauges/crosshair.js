// Crosshair, Integrale-style: two big round dials in grey rings, each with
// a gunsight in the middle (thin cross, concentric circles, yellow marks at
// 12, 3, 6 and 9) and a dotted band that a glowing yellow sweep runs along.
// Speed reads as big wide numerals on the left; the tach on the right has
// the gear in a yellow roundel. Between them, a 2x2 grid of small bar
// gauges: boost, water, battery volts and fuel.
import { GaugeStyle, el, text, setText, polar, arcPath, dialAngle, clamp } from './kit.js'

const VIEW = { w: 1100, h: 400 }
// The band runs almost all the way round: from just left of the bottom
// mark, clockwise over the top, to just right of it.
const A0 = 105, A1 = 435
const SPEEDO = { cx: 195, cy: 200, max: 300 }
const TACH = { cx: 905, cy: 200 }
const R = { ring: 186, rim: 177, red: 172, band: 160, tickOut: 146, tickIn: 126, dots: 136, num: 112, c1: 94, c2: 70 }
const TIP = 16
const YELLOW = '#f5c518'
// The centre grid: four panels inside a grey frame.
const GRID = { x: 405, y: 88, w: 290, h: 224, pad: 6 }
const PANELS = [
  { key: 'boost', lo: 0, hi: 1.2, labels: ['0', '0.6', '1.2'], unit: 'bar', fmt: (v) => v.toFixed(1) },
  { key: 'water', lo: 50, hi: 130, labels: ['50', '90', '130'], unit: '°C', fmt: (v) => String(Math.round(v)), hot: 115 },
  { key: 'volts', lo: 9, hi: 15, labels: ['9', '12', '15'], unit: 'volt', fmt: (v) => v.toFixed(1) },
  { key: 'fuel', lo: 0, hi: 1, labels: ['0', '1/2', '1'], unit: 'fuel', fmt: (v) => eighths(v) },
]

// Fuel in eighths, as a gauge reads it: 0, 1/8, 1/4 … 1.
function eighths(f) {
  const k = Math.round(clamp(f, 0, 1) * 8)
  if (k === 0 || k === 8) return String(k / 8)
  let n = k, d = 8
  while (n % 2 === 0) { n /= 2; d /= 2 }
  return n + '/' + d
}
const near = (a, list, w) => list.some((c) => Math.abs((((a - c) % 360) + 540) % 360 - 180) < w)
const CARDINAL = [0, 90, 180, 270]

export default class CrosshairStyle extends GaugeStyle {
  static meta = {
    key: 'crosshair', name: 'Crosshair', era: 'Integrale-style', view: VIEW, dark: true,
    blurb: 'Two gunsight dials with glowing yellow sweeps, wide speed numerals, the gear in a roundel, and four bar gauges.',
  }

  build() {
    const s = this.svg
    this.css(`
      .gs-crosshair .cx-ring { fill: none; stroke: #767b84; stroke-width: 7; }
      .gs-crosshair .cx-rim { fill: none; stroke: #222833; stroke-width: 2; }
      .gs-crosshair .cx-band { fill: none; stroke: #262212; stroke-width: 16; }
      .gs-crosshair .cx-red { fill: none; stroke: #ff3b2a; stroke-width: 3; opacity: 0.85; }
      .gs-crosshair .cx-dot { fill: #8a7414; }
      .gs-crosshair .cx-dot.big { fill: #c9a514; }
      .gs-crosshair .cx-dot.red { fill: #ff3b2a; }
      .gs-crosshair .cx-dot.dim { fill: #3a3420; }
      .gs-crosshair .cx-circle { fill: none; stroke: #3c3a2c; stroke-width: 1.5; }
      .gs-crosshair .cx-cross { stroke: #4e4b3c; stroke-width: 3; stroke-linecap: round; }
      .gs-crosshair .cx-cross.y { stroke: #8f7816; stroke-width: 4; }
      .gs-crosshair .cx-mark { stroke: ${YELLOW}; stroke-width: 5; stroke-linecap: round; }
      .gs-crosshair .cx-num { fill: #a8964c; font: 600 18px -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-num.red { fill: #ff5a3a; }
      .gs-crosshair .cx-arc-label { fill: #b89a24; font: 600 16px -apple-system, system-ui, sans-serif; letter-spacing: 0.08em; }
      .gs-crosshair .cx-sweep { fill: none; stroke: ${YELLOW}; stroke-width: 9; }
      .gs-crosshair .cx-sweep.halo { stroke-width: 30; opacity: 0.16; }
      .gs-crosshair .cx-sweep.tip { stroke: #fff1a6; stroke-width: 11; }
      .gs-crosshair .cx-cap-end { fill: #fff1a6; }
      .gs-crosshair[data-zone=red] .cx-tach .cx-cap-end { fill: #ffc0a0; }
      .gs-crosshair[data-zone=red] .cx-tach .cx-sweep { stroke: #ff5a2a; }
      .gs-crosshair[data-zone=red] .cx-tach .cx-sweep.tip { stroke: #ffc0a0; }
      .gs-crosshair .cx-speed { fill: ${YELLOW}; font: 600 74px "Avenir Next", Futura, "Century Gothic", "Trebuchet MS", system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-unit { fill: #c9a514; font: 500 18px -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-roundel { fill: ${YELLOW}; }
      .gs-crosshair .cx-roundel-in { fill: none; stroke: #0a0d14; stroke-width: 3; }
      .gs-crosshair .cx-gear { fill: #0a0d14; font: 800 40px "Avenir Next", Futura, "Century Gothic", system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-gearg.off { opacity: 0.3; }
      .gs-crosshair .cx-frame { fill: #5d626b; }
      .gs-crosshair .cx-panel { fill: #10141b; }
      .gs-crosshair .cx-val { fill: #f2efe6; font: 700 24px -apple-system, system-ui, sans-serif; }
      .gs-crosshair .cx-val .u { fill: #a3a7ae; font-weight: 500; font-size: 18px; }
      .gs-crosshair .cx-tdot { fill: #4a4428; }
      .gs-crosshair .cx-fill { stroke: ${YELLOW}; stroke-width: 6; stroke-linecap: round; }
      .gs-crosshair .cx-pbar.hot .cx-fill { stroke: #ff5a2a; }
      .gs-crosshair .cx-plabel { fill: #a8a290; font: 500 16px -apple-system, system-ui, sans-serif; dominant-baseline: central; }
      .gs-crosshair .cx-icon { fill: none; stroke: ${YELLOW}; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      .gs-crosshair .cx-finger { fill: rgba(245, 197, 24, 0.18); stroke: #ffe680; stroke-width: 3; pointer-events: none; }
    `)
    const defs = el('defs', {}, s)
    const bg = el('radialGradient', { id: this.id('bg'), cx: '0.5', cy: '0.45', r: '0.65' }, defs)
    el('stop', { offset: '0', 'stop-color': '#16213a' }, bg)
    el('stop', { offset: '1', 'stop-color': '#07090d' }, bg)
    const face = el('radialGradient', { id: this.id('face') }, defs)
    el('stop', { offset: '0', 'stop-color': '#111827' }, face)
    el('stop', { offset: '1', 'stop-color': '#05080e' }, face)
    // Static yellow backlight behind the speed and the gear.
    const glow = el('radialGradient', { id: this.id('glow') }, defs)
    el('stop', { offset: '0', 'stop-color': YELLOW, 'stop-opacity': '0.22' }, glow)
    el('stop', { offset: '1', 'stop-color': YELLOW, 'stop-opacity': '0' }, glow)
    // "RPM x 1000" follows the tach's ring, upper right.
    el('path', { id: this.id('rpmlabel'), d: arcPath(TACH.cx, TACH.cy, R.dots + 3, 292, 345) }, defs)

    el('rect', { x: 0, y: 0, width: VIEW.w, height: VIEW.h, rx: 24, fill: this.url('bg') }, s)

    // ── Speedometer ──
    const sp = el('g', { class: 'cx-speedo' }, s)
    this.dialFace(sp, SPEEDO, [R.c1, R.c1 + 18])
    this.cross(sp, SPEEDO, R.c1 + 4, R.tickIn - 4, 'cx-cross')
    for (let v = 0; v <= SPEEDO.max; v += 10) {
      const [x, y] = polar(SPEEDO.cx, SPEEDO.cy, R.band, dialAngle(v, 0, SPEEDO.max, A0, A1))
      el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: v % 50 === 0 ? 3.4 : 2.2, class: v % 50 === 0 ? 'cx-dot big' : 'cx-dot' }, sp)
    }
    this.speedSweep = this.sweep(sp)
    el('ellipse', { cx: SPEEDO.cx, cy: SPEEDO.cy, rx: 110, ry: 70, fill: this.url('glow') }, sp)
    this.speed = text(sp, 0, 0, 'cx-speed', '0', { transform: `translate(${SPEEDO.cx} ${SPEEDO.cy - 4}) scale(1.22 1)` })
    text(sp, SPEEDO.cx, SPEEDO.cy + 54, 'cx-unit', 'km/h')

    // ── Tachometer: dots, red end and numbers come from the scale ──
    const tg = el('g', { class: 'cx-tach' }, s)
    this.dialFace(tg, TACH, [R.c2, R.c1])
    this.cross(tg, TACH, 40, R.c1 - 2, 'cx-cross y')
    this.tachScaleG = el('g', {}, tg)
    const lab = text(tg, 0, 0, 'cx-arc-label', '')
    lab.removeAttribute('x'); lab.removeAttribute('y')
    el('textPath', { href: '#' + this.id('rpmlabel') }, lab).textContent = 'RPM × 1000'
    this.tachSweep = this.sweep(tg)
    const gg = this.gearG = el('g', { class: 'cx-gearg' }, tg)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: 66, fill: this.url('glow') }, gg)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: 36, class: 'cx-roundel' }, gg)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: 29, class: 'cx-roundel-in' }, gg)
    this.gear = text(gg, TACH.cx, TACH.cy + 1, 'cx-gear', '–')
    this.finger = el('circle', { r: 22, class: 'cx-finger', style: 'display:none' }, tg)

    // ── Centre grid ──
    const { x: gx, y: gy, w: gw, h: gh, pad } = GRID
    el('rect', { x: gx, y: gy, width: gw, height: gh, rx: 22, class: 'cx-frame' }, s)
    const pw = (gw - 3 * pad) / 2, ph = (gh - 3 * pad) / 2
    this.panels = PANELS.map((p, k) => {
      const px = gx + pad + (k % 2) * (pw + pad), py = gy + pad + Math.floor(k / 2) * (ph + pad)
      const g = el('g', { class: 'cx-pbar' }, s)
      el('rect', { x: px, y: py, width: pw, height: ph, rx: k === 0 ? 16 : 12, class: 'cx-panel' }, g)
      this.icon(g, p.key, px + 22, py + 26)
      const t = el('text', { x: px + pw - 12, y: py + 34, class: 'cx-val', 'text-anchor': 'end' }, g)
      const val = el('tspan', {}, t)
      el('tspan', { class: 'u' }, t).textContent = ' ' + p.unit
      const x0 = px + 14, x1 = px + pw - 14, ty = py + 56
      for (let x = x0; x <= x1 + 0.1; x += (x1 - x0) / 12) el('circle', { cx: x.toFixed(1), cy: ty, r: 1.8, class: 'cx-tdot' }, g)
      const fill = el('line', { x1: x0, y1: ty, x2: x0, y2: ty, class: 'cx-fill' }, g)
      text(g, px + 10, py + 82, 'cx-plabel', p.labels[0])
      text(g, px + pw / 2, py + 82, 'cx-plabel', p.labels[1], { 'text-anchor': 'middle' })
      text(g, px + pw - 10, py + 82, 'cx-plabel', p.labels[2], { 'text-anchor': 'end' })
      return { ...p, g, val, fill, x0, x1, x: NaN, isHot: false }
    })
  }

  // Grey ring, dark face, the dim inner dotted ring and the gunsight's
  // circles and yellow marks.
  dialFace(g, d, circles) {
    el('circle', { cx: d.cx, cy: d.cy, r: R.ring, class: 'cx-ring', fill: this.url('face') }, g)
    el('circle', { cx: d.cx, cy: d.cy, r: R.rim, class: 'cx-rim' }, g)
    el('path', { d: arcPath(d.cx, d.cy, R.band, A0, A1), class: 'cx-band' }, g)
    for (const r of circles) el('circle', { cx: d.cx, cy: d.cy, r, class: 'cx-circle' }, g)
    for (let a = 0; a < 360; a += 7.5) {
      // Leave room for the marks, and for the tach's lettering.
      if (near(a, CARDINAL, 5) || (d === TACH && a > 286 && a < 350)) continue
      const [x, y] = polar(d.cx, d.cy, R.dots, a)
      el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 1.8, class: 'cx-dot dim' }, g)
    }
    for (const a of CARDINAL) {
      const [x0, y0] = polar(d.cx, d.cy, R.tickIn, a)
      const [x1, y1] = polar(d.cx, d.cy, R.tickOut, a)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: 'cx-mark' }, g)
    }
  }
  cross(g, d, r0, r1, cls) {
    for (const a of CARDINAL) {
      const [x0, y0] = polar(d.cx, d.cy, r0, a)
      const [x1, y1] = polar(d.cx, d.cy, r1, a)
      el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: cls }, g)
    }
  }
  sweep(g) {
    const mk = (cls) => el('path', { class: 'cx-sweep ' + cls }, g)
    // Round on the leading edge only, so nothing pokes out behind zero.
    const cap = el('circle', { r: 5.5, class: 'cx-cap-end', style: 'display:none' }, g)
    return { halo: mk('halo'), main: mk('main'), tip: mk('tip'), cap, last: NaN }
  }
  icon(g, kind, x, y) {
    const ic = el('g', { class: 'cx-icon', transform: `translate(${x} ${y})` }, g)
    if (kind === 'boost') {
      // A turbo snail on a base line.
      el('circle', { cx: -2, cy: 0, r: 7 }, ic)
      el('circle', { cx: -2, cy: 0, r: 2 }, ic)
      el('path', { d: 'M-2 -7 H11 V-2 M-13 10 H13' }, ic)
    } else if (kind === 'water') {
      el('path', { d: 'M0 -12 V2' }, ic)
      el('circle', { cx: 0, cy: 5, r: 3 }, ic)
      el('path', { d: 'M3.5 -9 H7 M3.5 -5 H7 M3.5 -1 H7' }, ic)
      el('path', { d: 'M-12 11 q3 -2.5 6 0 t6 0 t6 0 t6 0' }, ic)
    } else if (kind === 'volts') {
      el('rect', { x: -12, y: -6, width: 24, height: 15, rx: 1.5 }, ic)
      el('path', { d: 'M-7 -6 V-9 M7 -6 V-9 M-9 1.5 H-4 M-6.5 -1 V4 M4 1.5 H9' }, ic)
    } else {
      // A fuel pump with its hose.
      el('rect', { x: -10, y: -10, width: 12, height: 19, rx: 1.5 }, ic)
      el('path', { d: 'M-7 -6 H-1 M2 -5 H5 L8 -2 V6 Q8 9 5.5 9 M-12 9.5 H4' }, ic)
    }
  }

  onScale(scale) {
    const g = this.tachScaleG
    while (g.firstChild) g.removeChild(g.firstChild)
    const max = scale.max
    el('path', { d: arcPath(TACH.cx, TACH.cy, R.red, dialAngle(scale.redFrom, 0, max, A0, A1), A1), class: 'cx-red' }, g)
    // Band dots every 250 rpm (500 on a big scale), big on the thousands,
    // red from the redline; numbers inside the gunsight's outer circle.
    const step = max <= 10000 ? 250 : 500
    for (let v = 0; v <= max; v += step) {
      const a = dialAngle(v, 0, max, A0, A1)
      const big = v % 1000 === 0, red = v >= scale.redFrom
      const [x, y] = polar(TACH.cx, TACH.cy, R.band, a)
      el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: big ? 3.4 : 2.2, class: 'cx-dot' + (red ? ' red' : big ? ' big' : '') }, g)
      if (big) {
        const [nx, ny] = polar(TACH.cx, TACH.cy, R.num, a)
        text(g, nx.toFixed(1), ny.toFixed(1), red ? 'cx-num red' : 'cx-num', String(v / 1000))
      }
    }
    this.tachSweep.last = NaN
  }

  rpmAt(x, y) {
    const dx = x - TACH.cx, dy = y - TACH.cy
    const r = Math.hypot(dx, dy)
    if (r < 40 || r > R.ring + 14) return null
    let a = (Math.atan2(dy, dx) * 180) / Math.PI
    while (a < A0) a += 360
    // The short gap at the bottom: snap to the nearer end.
    if (a > A1) return a < (A1 + A0 + 360) / 2 ? this.scale.max : 0
    return ((a - A0) / (A1 - A0)) * this.scale.max
  }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(TACH.cx, TACH.cy, R.band, dialAngle(rpm, 0, this.scale.max, A0, A1))
    this.finger.setAttribute('cx', fx.toFixed(1)); this.finger.setAttribute('cy', fy.toFixed(1))
    this.finger.style.display = ''
  }
  onFingerUp() { this.finger.style.display = 'none' }

  paint(force) {
    if (!this.scale) return
    const v = this.v, i = this.i
    this.paintSweep(this.speedSweep, SPEEDO, dialAngle(v.kmh, 0, SPEEDO.max, A0, A1), force)
    this.paintSweep(this.tachSweep, TACH, dialAngle(v.rpm, 0, this.scale.max, A0, A1), force)
    setText(this.speed, i.stale ? '--' : String(clamp(Math.round(v.kmh), 0, 999)))
    setText(this.gear, i.gear)
    const on = !!i.running
    if (force || on !== this.gearOn) { this.gearOn = on; this.gearG.classList.toggle('off', !on) }
    for (const p of this.panels) this.paintPanel(p, v[p.key], force)
  }

  paintSweep(sw, d, a, force) {
    if (!force && Math.abs(a - sw.last) < 0.05) return
    sw.last = a
    if (a - A0 < 0.3) {
      for (const k of ['halo', 'main', 'tip']) sw[k].setAttribute('d', '')
      sw.cap.style.display = 'none'
      return
    }
    const full = arcPath(d.cx, d.cy, R.band, A0, a)
    sw.halo.setAttribute('d', full)
    sw.main.setAttribute('d', full)
    sw.tip.setAttribute('d', arcPath(d.cx, d.cy, R.band, Math.max(A0, a - TIP), a))
    const [x, y] = polar(d.cx, d.cy, R.band, a)
    sw.cap.setAttribute('cx', x.toFixed(1)); sw.cap.setAttribute('cy', y.toFixed(1))
    sw.cap.style.display = ''
  }

  paintPanel(p, val, force) {
    const n = Number.isFinite(val) ? val : 0
    setText(p.val, p.fmt(n))
    const f = clamp((n - p.lo) / (p.hi - p.lo), 0, 1)
    const x = Math.round((p.x0 + f * (p.x1 - p.x0)) * 2) / 2
    if (force || x !== p.x) {
      p.x = x
      p.fill.setAttribute('x2', x)
      // A zero-length round-capped line is a dot: hide it when empty.
      p.fill.style.display = f > 0 ? '' : 'none'
    }
    const hot = p.hot != null && this.i.running && n >= p.hot
    if (force || hot !== p.isHot) { p.isHot = hot; p.g.classList.toggle('hot', hot) }
  }
}
