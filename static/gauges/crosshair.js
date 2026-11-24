// Crosshair, Integrale-style, after Blackbox Infinite's Integrale cluster:
// two big round dials in grey metal bezels, each with a gunsight in the
// middle (thin olive cross, two concentric circles, short yellow marks at
// 12, 3, 6 and 9) and a dotted olive band just inside the bezel that a
// glowing yellow sweep runs along. The speedo's band starts at 9 o'clock
// and runs clockwise to 6; the tach's starts at 3 and runs clockwise to 12,
// leaving its upper right for the "RPM × 1000" lettering. Speed is big wide
// numerals; the gear sits in a notched yellow roundel. Between the dials,
// a 2x2 grid of bar tiles in a grey frame: boost, water, battery, fuel.
// No numerals round the dials, as on the original; the tach's red zone
// follows the engine's redline instead.
import { GaugeStyle, el, text, setText, polar, arcPath, clamp } from './kit.js'

const VIEW = { w: 1100, h: 355 }
const RB = 168 // the bezel's outer radius
const SPEEDO = { cx: 185, cy: 178, a0: 180, a1: 450, max: 200 }
const TACH = { cx: 915, cy: 178, a0: 0, a1: 270 }
const R = { bezel: RB - 3.5, rim: RB - 8.5, band: 148, dots: 133, tickIn: 123, tickOut: 141, c1: 91, c2: 84, cross: 96 }
// Dots along the band: 30 gaps over 270 degrees, as on the original.
const N = 30
const YELLOW = '#f5c814'
const CARDINAL = [0, 90, 180, 270]
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
// The centre grid: four tiles in a grey frame.
const GRID = { x: 370, y: 96, w: 360, h: 178, pad: 6 }
const TILES = [
  { key: 'boost', lo: 0, hi: 1.2, labels: ['0', '0.6', '1.2'], unit: 'bar', fmt: (v) => v.toFixed(1) },
  { key: 'water', lo: 50, hi: 130, labels: ['50', '90', '130'], unit: 'C', deg: true, fmt: (v) => String(Math.round(v)), hot: 115 },
  { key: 'volts', lo: 9, hi: 15, labels: ['9', '12', '15'], unit: 'volt', fmt: (v) => String(Math.round(v)) },
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
const fx = (n) => n.toFixed(1)
// Whole degrees with a true minus sign (and no "-0").
const degC = (c) => { const n = Math.round(c); return (n < 0 ? '\u2212' + -n : String(n)) + '°' }
// Angles a and c within w degrees of each other, round the circle.
const near = (a, c, w) => Math.abs((((a - c) % 360) + 540) % 360 - 180) < w
// Narrowed text: the tiles' numerals are a condensed face, and the car's
// browser has no condensed font we can count on.
const narrow = (x, y, sx = 0.76) => `translate(${fx(x)} ${fx(y)}) scale(${sx} 1)`

export default class CrosshairStyle extends GaugeStyle {
  static meta = {
    key: 'crosshair', name: 'Crosshair', era: 'Integrale-style', view: VIEW,
    blurb: 'Two gunsight dials with glowing yellow sweeps, wide speed numerals, the gear in a roundel, and four bar tiles.',
  }

  build() {
    const s = this.svg
    this.css(`
      .gs-crosshair .cx-bezel { stroke-width: 7; }
      .gs-crosshair .cx-rim { fill: none; stroke: #040506; stroke-width: 2; }
      .gs-crosshair .cx-track { fill: none; stroke: #39320f; stroke-width: 8; stroke-linecap: round; }
      .gs-crosshair .cx-track.red { stroke: #4a1610; stroke-linecap: butt; }
      .gs-crosshair .cx-bdot { fill: #8a761c; }
      .gs-crosshair .cx-bdot.on { fill: #ffe24e; }
      .gs-crosshair .cx-bdot.red { fill: #8a2a1c; }
      .gs-crosshair .cx-bdot.red.on { fill: #ff5a3c; }
      .gs-crosshair .cx-idot { fill: #3a3418; }
      .gs-crosshair .cx-circle { fill: none; stroke: #4a4115; stroke-width: 1.4; }
      .gs-crosshair .cx-cross { stroke: #322d14; stroke-width: 3.2; stroke-linecap: round; }
      .gs-crosshair .cx-mark { stroke: ${YELLOW}; stroke-width: 3.5; }
      .gs-crosshair .cx-sweep { fill: none; stroke-linecap: round; }
      .gs-crosshair .cx-sweep.halo { stroke: #ffc81a; stroke-width: 22; opacity: 0.12; stroke-linecap: butt; }
      .gs-crosshair .cx-sweep.main { stroke: #c9a612; stroke-width: 8; }
      .gs-crosshair .cx-sweep.head { stroke: #ffe14a; stroke-width: 8; }
      .gs-crosshair .cx-sweep.core { stroke: #fffbe6; stroke-width: 3.5; }
      .gs-crosshair[data-zone=red] .cx-tach .cx-sweep.main { stroke: #d8461e; }
      .gs-crosshair[data-zone=red] .cx-tach .cx-sweep.head { stroke: #ff7a3a; }
      .gs-crosshair[data-zone=red] .cx-tach .cx-sweep.halo { stroke: #ff5a2a; }
      .gs-crosshair .cx-speed { fill: ${YELLOW}; font: 600 72px "Avenir Next", "Helvetica Neue", -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-unit { fill: #d4ae14; font: 600 15px "Avenir Next", "Helvetica Neue", -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-arc-label { fill: #b8940f; font: 500 14px "Avenir Next", "Helvetica Neue", -apple-system, system-ui, sans-serif; letter-spacing: 0.06em; }
      .gs-crosshair .cx-roundel { fill: ${YELLOW}; }
      .gs-crosshair .cx-roundel-in { fill: none; stroke: #16140a; stroke-width: 2.5; }
      .gs-crosshair .cx-notch { stroke: #0d0e10; stroke-width: 3.5; }
      .gs-crosshair .cx-gear { fill: #16140a; font: 800 44px "Avenir Next", "Helvetica Neue", -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-gearg.off { opacity: 0.35; }
      .gs-crosshair .cx-tile { fill: #141518; }
      .gs-crosshair .cx-val { fill: #f4eed4; font: 700 25px "Helvetica Neue", -apple-system, system-ui, sans-serif; text-anchor: end; }
      .gs-crosshair .cx-val .u { fill: #aca688; font-weight: 600; }
      .gs-crosshair .cx-val .deg { font-size: 14px; font-weight: 600; fill: #aca688; }
      .gs-crosshair .cx-ttrack { stroke: #2e2a14; stroke-width: 4; stroke-linecap: round; }
      .gs-crosshair .cx-tdot { fill: #6b5d18; }
      .gs-crosshair .cx-fill { stroke: ${YELLOW}; stroke-width: 4.5; stroke-linecap: round; }
      .gs-crosshair .cx-tileg.hot .cx-fill { stroke: #ff5a2a; }
      .gs-crosshair .cx-tlabel { fill: #a39e84; font: 600 15px "Helvetica Neue", -apple-system, system-ui, sans-serif; }
      .gs-crosshair .cx-icon { fill: none; stroke: ${YELLOW}; stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
      .gs-crosshair .cx-icon .f { fill: ${YELLOW}; stroke: none; }
      .gs-crosshair .cx-arrow { opacity: 0.3; }
      .gs-crosshair .cx-arrow path { fill: #1a160a; }
      .gs-crosshair .cx-lamp { fill: #3a1310; opacity: 0.8; }
      .gs-crosshair .cx-finger { fill: rgba(245, 200, 20, 0.18); stroke: #ffe680; stroke-width: 3; pointer-events: none; }
      .gs-crosshair .cx-temp { fill: #f4eed4; font: 700 24px "Helvetica Neue", -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-temp .in { fill: #aca688; font-size: 16px; font-weight: 600; }
      .gs-crosshair .cx-head { font-size: 16px; font-weight: 600; }
      .gs-crosshair .cx-bug { fill: ${YELLOW}; }
      .gs-crosshair .cx-tyre { fill: #f4eed4; font: 700 18px "Helvetica Neue", -apple-system, system-ui, sans-serif; dominant-baseline: central; }
      .gs-crosshair .cx-tyreu { fill: #a39e84; font: 600 12px "Helvetica Neue", -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-crosshair .cx-carbody { fill: none; stroke: #8a761c; stroke-width: 1.6; }
      .gs-crosshair .cx-wheel { fill: ${YELLOW}; }
      .gs-crosshair .cx-tyres.warn .cx-tyre { fill: #ff5a3c; }
      .gs-crosshair .cx-tyres.warn .cx-wheel { fill: #ff5a3c; }

      /* Day: the same instrument in Tesla's light UI, on the #d6d7d6 floor.
         Light faces in pale metal bezels, the sweeps in solid darker amber
         with no glow, dark grey type. */
      .gs-crosshair[data-theme=day] .st-bz0 { stop-color: #e4e6e8; }
      .gs-crosshair[data-theme=day] .st-bz1 { stop-color: #cfd1d3; }
      .gs-crosshair[data-theme=day] .st-bz2 { stop-color: #b5b8bb; }
      .gs-crosshair[data-theme=day] .st-fc0 { stop-color: #fbfbfb; }
      .gs-crosshair[data-theme=day] .st-fc1 { stop-color: #eff0f1; }
      .gs-crosshair[data-theme=day] .st-gl0,
      .gs-crosshair[data-theme=day] .st-gl1 { stop-opacity: 0; }
      .gs-crosshair[data-theme=day] .st-fr0 { stop-color: #d2d4d6; }
      .gs-crosshair[data-theme=day] .st-fr1 { stop-color: #c2c5c8; }
      .gs-crosshair[data-theme=day] .cx-bezel,
      .gs-crosshair[data-theme=day] .cx-frame { filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.16)); }
      .gs-crosshair[data-theme=day] .cx-rim { stroke: #a9acb0; stroke-width: 1.2; }
      .gs-crosshair[data-theme=day] .cx-track { stroke: rgba(0, 0, 0, 0.07); }
      .gs-crosshair[data-theme=day] .cx-track.red { stroke: rgba(200, 40, 20, 0.16); }
      .gs-crosshair[data-theme=day] .cx-bdot { fill: rgba(0, 0, 0, 0.2); }
      .gs-crosshair[data-theme=day] .cx-bdot.on { fill: #fff2b8; }
      .gs-crosshair[data-theme=day] .cx-bdot.red { fill: rgba(190, 40, 20, 0.45); }
      .gs-crosshair[data-theme=day] .cx-bdot.red.on { fill: #ffd2c4; }
      .gs-crosshair[data-theme=day] .cx-idot { fill: rgba(0, 0, 0, 0.16); }
      .gs-crosshair[data-theme=day] .cx-circle { stroke: rgba(0, 0, 0, 0.14); }
      .gs-crosshair[data-theme=day] .cx-cross { stroke: rgba(0, 0, 0, 0.1); }
      .gs-crosshair[data-theme=day] .cx-mark { stroke: #c99700; }
      .gs-crosshair[data-theme=day] .cx-sweep.halo,
      .gs-crosshair[data-theme=day] .cx-hotglow { opacity: 0; }
      .gs-crosshair[data-theme=day] .cx-sweep.main { stroke: #e0aa00; }
      .gs-crosshair[data-theme=day] .cx-sweep.head { stroke: #d29700; }
      .gs-crosshair[data-theme=day] .cx-sweep.core { stroke: #fff4cc; }
      .gs-crosshair[data-theme=day][data-zone=red] .cx-tach .cx-sweep.main { stroke: #d8401a; }
      .gs-crosshair[data-theme=day][data-zone=red] .cx-tach .cx-sweep.head { stroke: #bf2e10; }
      .gs-crosshair[data-theme=day][data-zone=red] .cx-tach .cx-sweep.core { stroke: #ffe0d4; }
      .gs-crosshair[data-theme=day] .cx-speed { fill: #1f2124; }
      .gs-crosshair[data-theme=day] .cx-unit,
      .gs-crosshair[data-theme=day] .cx-arc-label { fill: #5c5e62; }
      .gs-crosshair[data-theme=day] .cx-roundel { fill: #f2c200; }
      .gs-crosshair[data-theme=day] .cx-roundel-in { stroke: #1f2124; }
      .gs-crosshair[data-theme=day] .cx-notch { stroke: #f6f6f7; }
      .gs-crosshair[data-theme=day] .cx-gear { fill: #1f2124; }
      .gs-crosshair[data-theme=day] .cx-tile { fill: #f7f7f7; }
      .gs-crosshair[data-theme=day] .cx-val { fill: #1f2124; }
      .gs-crosshair[data-theme=day] .cx-val .u,
      .gs-crosshair[data-theme=day] .cx-val .deg { fill: #5c5e62; }
      .gs-crosshair[data-theme=day] .cx-ttrack { stroke: rgba(0, 0, 0, 0.08); }
      .gs-crosshair[data-theme=day] .cx-tdot { fill: rgba(0, 0, 0, 0.2); }
      .gs-crosshair[data-theme=day] .cx-fill { stroke: #d9a300; }
      .gs-crosshair[data-theme=day] .cx-tileg.hot .cx-fill { stroke: #d8401a; }
      .gs-crosshair[data-theme=day] .cx-tlabel { fill: #5c5e62; }
      .gs-crosshair[data-theme=day] .cx-icon { stroke: #393c41; }
      .gs-crosshair[data-theme=day] .cx-icon .f { fill: #393c41; }
      .gs-crosshair[data-theme=day] .cx-icon .hole { fill: #f7f7f7; }
      .gs-crosshair[data-theme=day] .cx-arrow { opacity: 1; }
      .gs-crosshair[data-theme=day] .cx-arrow circle { fill: rgba(0, 0, 0, 0.06); stroke: rgba(0, 0, 0, 0.1); }
      .gs-crosshair[data-theme=day] .cx-arrow path { fill: rgba(0, 0, 0, 0.28); }
      .gs-crosshair[data-theme=day] .cx-lamp { fill: rgba(190, 40, 20, 0.14); opacity: 1; }
      .gs-crosshair[data-theme=day] .cx-finger { fill: rgba(217, 163, 0, 0.18); stroke: #c78f00; }
      .gs-crosshair[data-theme=day] .cx-temp,
      .gs-crosshair[data-theme=day] .cx-tyre { fill: #1f2124; }
      .gs-crosshair[data-theme=day] .cx-temp .in,
      .gs-crosshair[data-theme=day] .cx-tyreu { fill: #5c5e62; }
      .gs-crosshair[data-theme=day] .cx-bug { fill: #c99700; }
      .gs-crosshair[data-theme=day] .cx-carbody { stroke: #8d9094; }
      .gs-crosshair[data-theme=day] .cx-wheel { fill: #d9a300; }
      .gs-crosshair[data-theme=day] .cx-tyres.warn .cx-tyre,
      .gs-crosshair[data-theme=day] .cx-tyres.warn .cx-wheel { fill: #d8401a; }
    `)
    const defs = el('defs', {}, s)
    // Brushed grey metal: lighter on top, as if lit from above.
    const bezel = el('linearGradient', { id: this.id('bezel'), x1: '0', y1: '0', x2: '0', y2: '1' }, defs)
    el('stop', { offset: '0', 'stop-color': '#959aa2', class: 'st-bz0' }, bezel)
    el('stop', { offset: '0.5', 'stop-color': '#71757d', class: 'st-bz1' }, bezel)
    el('stop', { offset: '1', 'stop-color': '#565a61', class: 'st-bz2' }, bezel)
    const face = el('radialGradient', { id: this.id('face') }, defs)
    el('stop', { offset: '0', 'stop-color': '#18181a', class: 'st-fc0' }, face)
    el('stop', { offset: '1', 'stop-color': '#0a0a0c', class: 'st-fc1' }, face)
    // Static yellow light behind the speed, the gear and the sweep's head.
    const glow = el('radialGradient', { id: this.id('glow') }, defs)
    el('stop', { offset: '0', 'stop-color': YELLOW, 'stop-opacity': '0.2', class: 'st-gl0' }, glow)
    el('stop', { offset: '1', 'stop-color': YELLOW, 'stop-opacity': '0', class: 'st-gl1' }, glow)
    const hot = el('radialGradient', { id: this.id('hot') }, defs)
    el('stop', { offset: '0', 'stop-color': '#fff4b0', 'stop-opacity': '0.75' }, hot)
    el('stop', { offset: '0.35', 'stop-color': '#ffd21a', 'stop-opacity': '0.3' }, hot)
    el('stop', { offset: '1', 'stop-color': '#ffc81a', 'stop-opacity': '0' }, hot)
    const frame = el('linearGradient', { id: this.id('frame'), x1: '0', y1: '0', x2: '0', y2: '1' }, defs)
    el('stop', { offset: '0', 'stop-color': '#5c5f66', class: 'st-fr0' }, frame)
    el('stop', { offset: '1', 'stop-color': '#43464c', class: 'st-fr1' }, frame)
    const gold = el('linearGradient', { id: this.id('gold'), x1: '0', y1: '0', x2: '0', y2: '1' }, defs)
    el('stop', { offset: '0', 'stop-color': '#f0d56a' }, gold)
    el('stop', { offset: '1', 'stop-color': '#9c7d22' }, gold)
    // "RPM × 1000" follows the tach's ring in its empty upper right.
    el('path', { id: this.id('rpmlabel'), d: arcPath(TACH.cx, TACH.cy, R.dots + 2, 296, 352) }, defs)
    // The heading follows the speedo's ring in its empty lower left, run
    // anticlockwise so it reads upright, tops toward the centre.
    el('path', { id: this.id('headlabel'), d: arcPath(SPEEDO.cx, SPEEDO.cy, R.dots + 12, 166, 104) }, defs)

    // ── Speedometer: no numerals, as on the original ──
    const sp = el('g', { class: 'cx-speedo' }, s)
    this.dialFace(sp, SPEEDO)
    el('ellipse', { cx: SPEEDO.cx, cy: SPEEDO.cy, rx: 100, ry: 62, fill: this.url('glow') }, sp)
    this.gunsight(sp, SPEEDO, 0)
    // The speedo's head burns longer and brighter, as on the original.
    this.speedDial = this.band(sp, SPEEDO, { glow: 34, head: 32, core: 18 })
    this.speedDial.dots = this.bandDots(this.speedDial.dotsG, SPEEDO, () => false)
    this.speed = text(sp, 0, 0, 'cx-speed', '0')
    this.speedW = 0
    text(sp, SPEEDO.cx, SPEEDO.cy + 50, 'cx-unit', 'km/h')

    // ── Tachometer: the red zone comes from the scale ──
    const tg = el('g', { class: 'cx-tach' }, s)
    this.dialFace(tg, TACH)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: 78, fill: this.url('glow') }, tg)
    this.gunsight(tg, TACH, 40)
    const lab = text(tg, 0, 0, 'cx-arc-label', '')
    lab.removeAttribute('x'); lab.removeAttribute('y')
    el('textPath', { href: '#' + this.id('rpmlabel'), startOffset: '50%', 'text-anchor': 'middle' }, lab).textContent = 'RPM × 1000'
    this.tachDial = this.band(tg, TACH, { glow: 24, head: 26, core: 13 })
    const gg = this.gearG = el('g', { class: 'cx-gearg' }, tg)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: 35, class: 'cx-roundel' }, gg)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: 29.5, class: 'cx-roundel-in' }, gg)
    // Notches in the roundel where the cross meets it.
    for (const a of CARDINAL) {
      const [x0, y0] = polar(TACH.cx, TACH.cy, 30.5, a)
      const [x1, y1] = polar(TACH.cx, TACH.cy, 36, a)
      el('line', { x1: fx(x0), y1: fx(y0), x2: fx(x1), y2: fx(y1), class: 'cx-notch' }, gg)
    }
    this.gear = text(gg, 0, 0, 'cx-gear', '–', { transform: `translate(${TACH.cx} ${TACH.cy + 1}) scale(1.2 1)` })
    this.finger = el('circle', { r: 20, class: 'cx-finger', style: 'display:none' }, tg)

    // ── Centre: turn arrows (dim: we don't know the indicators), the tile
    // grid, and two warning lamps (dim) ──
    this.arrow(s, GRID.x - 16, 53, 1)
    this.arrow(s, GRID.x + GRID.w + 16, 55, -1)
    el('circle', { cx: GRID.x - 16, cy: 308, r: 14, class: 'cx-lamp' }, s)
    el('circle', { cx: GRID.x + GRID.w + 16, cy: 308, r: 14, class: 'cx-lamp' }, s)
    const { x: gx, y: gy, w: gw, h: gh, pad } = GRID
    el('rect', { x: gx, y: gy, width: gw, height: gh, rx: 16, fill: this.url('frame'), class: 'cx-frame' }, s)
    const tw = (gw - 3 * pad) / 2, th = (gh - 3 * pad) / 2
    this.tiles = TILES.map((p, k) => {
      const tx = gx + pad + (k % 2) * (tw + pad), ty = gy + pad + Math.floor(k / 2) * (th + pad)
      const g = el('g', { class: 'cx-tileg' }, s)
      el('rect', { x: tx, y: ty, width: tw, height: th, rx: 10, class: 'cx-tile' }, g)
      this.icon(g, p.key, tx + 25, ty + 22)
      const t = el('text', { class: 'cx-val', transform: narrow(tx + tw - 12, ty + 32, 0.72) }, g)
      const val = el('tspan', {}, t)
      el('tspan', { class: 'u' }, t).textContent = ' ' + p.unit
      if (p.deg) el('tspan', { class: 'deg', dx: 2, dy: -9 }, t).textContent = 'o'
      const x0 = tx + 14, x1 = tx + tw - 18, by = ty + 45
      el('line', { x1: x0, y1: by, x2: x1, y2: by, class: 'cx-ttrack' }, g)
      for (let k2 = 0; k2 <= 10; k2++) el('circle', { cx: fx(x0 + (k2 * (x1 - x0)) / 10), cy: by, r: 2, class: 'cx-tdot' }, g)
      const fill = el('line', { x1: x0, y1: by, x2: x0, y2: by, class: 'cx-fill' }, g)
      const ly = ty + 66
      el('text', { class: 'cx-tlabel', transform: narrow(x0 - 2, ly) }, g).textContent = p.labels[0]
      el('text', { class: 'cx-tlabel', 'text-anchor': 'middle', transform: narrow((x0 + x1) / 2, ly) }, g).textContent = p.labels[1]
      el('text', { class: 'cx-tlabel', 'text-anchor': 'end', transform: narrow(x1 + 2, ly) }, g).textContent = p.labels[2]
      return { ...p, g, val, fill, x0, x1, x: NaN, isHot: false, shown: '' }
    })
    this.carReadouts(s, sp)
  }

  // The car's own readouts, each hidden until it is read: the outside and
  // cabin temperatures over the tiles, level with the turn arrows; the
  // heading on the speedo's empty lower left, with a bug on its gunsight;
  // the tyre pressures under the tiles, round a little car seen from above.
  carReadouts(s, sp) {
    const t = this.temp = el('text', { class: 'cx-temp', transform: narrow(GRID.x + GRID.w / 2, 54, 0.82), style: 'display:none' }, s)
    this.tempOut = el('tspan', {}, t)
    this.tempIn = el('tspan', { class: 'in' }, t)
    this.tempShown = null

    const hg = this.headG = el('g', { style: 'display:none' }, sp)
    const lab = text(hg, 0, 0, 'cx-arc-label cx-head', '')
    lab.removeAttribute('x'); lab.removeAttribute('y')
    this.headText = el('textPath', { href: '#' + this.id('headlabel'), startOffset: '50%', 'text-anchor': 'middle' }, lab)
    // A small bug just outside the gunsight's outer circle, pointing in;
    // north is up.
    const { cx, cy } = SPEEDO, r = R.c1 + 2
    this.bug = el('path', { class: 'cx-bug', d: `M${cx} ${cy - r}L${cx - 5} ${cy - r - 10}H${cx + 5}Z` }, hg)
    this.headShown = null

    const cx2 = GRID.x + GRID.w / 2, y0 = GRID.y + GRID.h + 12
    const tg = this.tyreG = el('g', { class: 'cx-tyres', style: 'display:none' }, s)
    // The car: a body outline and four wheels, front up.
    el('rect', { x: cx2 - 11, y: y0, width: 22, height: 50, rx: 8, class: 'cx-carbody' }, tg)
    el('path', { d: `M${cx2 - 8} ${y0 + 15}Q${cx2} ${y0 + 11} ${cx2 + 8} ${y0 + 15}M${cx2 - 8} ${y0 + 38}Q${cx2} ${y0 + 41} ${cx2 + 8} ${y0 + 38}`, class: 'cx-carbody' }, tg)
    const wy = [y0 + 6, y0 + 33]
    for (const y of wy) for (const x of [cx2 - 15, cx2 + 11]) el('rect', { x, y, width: 4, height: 11, rx: 1.5, class: 'cx-wheel' }, tg)
    this.tyreVals = [0, 1, 2, 3].map((k) => {
      const left = k % 2 === 0, y = wy[k >> 1] + 5.5
      return el('text', { class: 'cx-tyre', 'text-anchor': left ? 'end' : 'start', transform: narrow(cx2 + (left ? -24 : 24), y, 0.8) }, tg)
    })
    text(tg, cx2, y0 + 62, 'cx-tyreu', 'bar')
    this.tyreShown = null
  }

  // Grey bezel, black face, and the dim inner ring of dots along the band.
  dialFace(g, d) {
    el('circle', { cx: d.cx, cy: d.cy, r: R.bezel, class: 'cx-bezel', fill: this.url('face'), stroke: this.url('bezel') }, g)
    el('circle', { cx: d.cx, cy: d.cy, r: R.rim, class: 'cx-rim' }, g)
    for (let k = 0; k < N; k++) {
      const a = d.a0 + ((k + 0.5) * (d.a1 - d.a0)) / N
      if (CARDINAL.some((c) => near(a, c, 6))) continue
      const [x, y] = polar(d.cx, d.cy, R.dots, a)
      el('circle', { cx: fx(x), cy: fx(y), r: 1.7, class: 'cx-idot' }, g)
    }
    for (const a of CARDINAL) {
      const [x0, y0] = polar(d.cx, d.cy, R.tickIn, a)
      const [x1, y1] = polar(d.cx, d.cy, R.tickOut, a)
      el('line', { x1: fx(x0), y1: fx(y0), x2: fx(x1), y2: fx(y1), class: 'cx-mark' }, g)
    }
  }
  // The cross (from r0 out) and two circles, broken where the cross runs.
  gunsight(g, d, r0) {
    for (const a of CARDINAL) {
      const [x0, y0] = polar(d.cx, d.cy, r0, a)
      const [x1, y1] = polar(d.cx, d.cy, R.cross, a)
      el('line', { x1: fx(x0), y1: fx(y0), x2: fx(x1), y2: fx(y1), class: 'cx-cross' }, g)
    }
    for (const r of [R.c1, R.c2]) {
      const gap = (9 / r) * (180 / Math.PI)
      for (const a of CARDINAL) el('path', { d: arcPath(d.cx, d.cy, r, a + gap, a + 90 - gap), class: 'cx-circle' }, g)
    }
  }
  // The band: an olive track, the sweep over it, the dots over that, and
  // the sweep's bright head on top. Groups for the scale's parts sit
  // between, so onScale() can redraw them in place.
  // look: the glow's radius and the head's and white core's lengths (degrees).
  band(g, d, look) {
    el('path', { d: arcPath(d.cx, d.cy, R.band, d.a0, d.a1), class: 'cx-track' }, g)
    const redG = el('g', {}, g)
    const mk = (cls) => el('path', { class: 'cx-sweep ' + cls }, g)
    const halo = mk('halo'), main = mk('main')
    const dotsG = el('g', {}, g)
    const head = mk('head'), core = mk('core')
    const glow = el('circle', { r: look.glow, fill: this.url('hot'), class: 'cx-hotglow', style: 'display:none' }, g)
    return { d, look, redG, dotsG, halo, main, head, core, glow, dots: [], lit: 0, last: NaN }
  }
  // N + 1 dots along the band; red(f) marks the ones in the red zone.
  bandDots(g, d, red) {
    while (g.firstChild) g.removeChild(g.firstChild)
    const dots = []
    for (let k = 0; k <= N; k++) {
      const f = k / N
      const [x, y] = polar(d.cx, d.cy, R.band, d.a0 + f * (d.a1 - d.a0))
      dots.push(el('circle', { cx: fx(x), cy: fx(y), r: 2.3, class: red(f) ? 'cx-bdot red' : 'cx-bdot' }, g))
    }
    return dots
  }
  arrow(g, x, y, dir) {
    const a = el('g', { class: 'cx-arrow', transform: `translate(${x} ${y}) scale(${dir} 1)` }, g)
    el('circle', { r: 14, fill: this.url('gold') }, a)
    el('circle', { r: 11.5, fill: 'none', stroke: '#7a5f14', 'stroke-width': 1.2 }, a)
    el('path', { d: 'M8 -2.6 H-1 V-7 L-8.5 0 L-1 7 V2.6 H8 Z' }, a)
  }
  icon(g, kind, x, y) {
    const ic = el('g', { class: 'cx-icon', transform: `translate(${x} ${y})` }, g)
    if (kind === 'boost') {
      // A turbo: the inlet pipe curling into a snail with its wheel, on a base.
      el('path', { d: 'M-15 -8 H-2 M-15 -3 H-6 Q-4 -3 -4 0' }, ic)
      el('circle', { cx: 4, cy: 1, r: 7.5 }, ic)
      for (let a = 0; a < 360; a += 30) {
        const [x0, y0] = polar(4, 1, 2, a), [x1, y1] = polar(4, 1, 6.5, a + 20)
        el('path', { d: `M${fx(x0)} ${fx(y0)}L${fx(x1)} ${fx(y1)}` }, ic)
      }
      el('path', { d: 'M-15 11 H15' }, ic)
    } else if (kind === 'water') {
      // Coolant: a thermometer standing in waves.
      el('path', { d: 'M0 -12 V3' }, ic)
      el('circle', { cx: 0, cy: 5, r: 3, class: 'f' }, ic)
      el('path', { d: 'M3.5 -10 H7 M3.5 -6 H7 M3.5 -2 H7' }, ic)
      el('path', { d: 'M-12 11 q3 -2.5 6 0 t6 0 t6 0 t6 0' }, ic)
    } else if (kind === 'volts') {
      el('rect', { x: -11, y: -8, width: 22, height: 14, rx: 1.5 }, ic)
      el('path', { d: 'M-7 -8 V-11 M7 -8 V-11 M-8 -1 H-3 M3 -1 H8 M5.5 -3.5 V1.5 M-11 11 H11' }, ic)
    } else {
      // A fuel pump with its hose.
      el('rect', { x: -9, y: -11, width: 12, height: 22, rx: 1.5, class: 'f' }, ic)
      el('rect', { x: -6.5, y: -8, width: 7, height: 6, rx: 0.8, fill: '#141518', stroke: 'none', class: 'hole' }, ic)
      el('path', { d: 'M3 -6 H6 L9 -3 V6 Q9 9 7 9 Q5 9 5 6 V1 H3' }, ic)
    }
  }

  onScale(scale) {
    const t = this.tachDial, max = scale.max || 1
    const rf = clamp(scale.redFrom / max, 0, 1)
    const g = t.redG
    while (g.firstChild) g.removeChild(g.firstChild)
    // A red track from the redline to the end, and red dots on it.
    if (rf < 1) el('path', { d: arcPath(TACH.cx, TACH.cy, R.band, TACH.a0 + rf * (TACH.a1 - TACH.a0), TACH.a1), class: 'cx-track red' }, g)
    t.dots = this.bandDots(t.dotsG, TACH, (f) => f >= rf - 1e-9)
    t.lit = 0; t.last = NaN
  }

  rpmAt(x, y) {
    const dx = x - TACH.cx, dy = y - TACH.cy
    const r = Math.hypot(dx, dy)
    if (r < 40 || r > RB + 14) return null
    let a = (Math.atan2(dy, dx) * 180) / Math.PI
    if (a < 0) a += 360
    // The empty upper right: snap to the nearer end.
    if (a > TACH.a1) return a < (TACH.a1 + 360) / 2 ? this.scale.max : 0
    return (a / TACH.a1) * this.scale.max
  }
  // Pressing anywhere on the rpm dial revs the engine.
  tachHit(x, y) { return Math.hypot(x - TACH.cx, y - TACH.cy) <= RB }
  onFinger(x, y, rpm) {
    const [px, py] = polar(TACH.cx, TACH.cy, R.band, TACH.a0 + clamp(rpm / this.scale.max, 0, 1) * (TACH.a1 - TACH.a0))
    this.finger.setAttribute('cx', fx(px)); this.finger.setAttribute('cy', fx(py))
    this.finger.style.display = ''
  }
  onFingerUp() { this.finger.style.display = 'none' }

  paint(force) {
    if (!this.scale) return
    const v = this.v, i = this.i
    this.paintDial(this.speedDial, clamp(v.kmh / SPEEDO.max, 0, 1), force)
    this.paintDial(this.tachDial, clamp(v.rpm / (this.scale.max || 1), 0, 1), force)
    const sp = i.stale ? '--' : String(clamp(Math.round(v.kmh), 0, 999))
    setText(this.speed, sp)
    // Wide numerals, a little less wide at three digits to stay in the sight.
    const w = sp.length >= 3 ? 1.12 : 1.38
    if (force || w !== this.speedW) {
      this.speedW = w
      this.speed.setAttribute('transform', `translate(${SPEEDO.cx} ${SPEEDO.cy - 4}) scale(${w} 1)`)
    }
    setText(this.gear, i.gear)
    const on = !!i.running
    if (force || on !== this.gearOn) { this.gearOn = on; this.gearG.classList.toggle('off', !on) }
    for (const p of this.tiles) this.paintTile(p, v[p.key], force)
    this.paintCar(force)
  }

  // The car's readouts: touch the DOM only when the shown text changes.
  paintCar(force) {
    const i = this.i
    const out = Number.isFinite(i.outsideC) ? degC(i.outsideC) : ''
    const inn = Number.isFinite(i.insideC) ? 'in ' + degC(i.insideC) : ''
    const tk = out + '|' + inn
    if (force || tk !== this.tempShown) {
      this.tempShown = tk
      this.tempOut.textContent = out
      this.tempIn.textContent = inn
      if (out && inn) this.tempIn.setAttribute('dx', 12); else this.tempIn.removeAttribute('dx')
      this.temp.style.display = out || inn ? '' : 'none'
    }

    const h = Number.isFinite(i.heading) ? ((Math.round(i.heading) % 360) + 360) % 360 : null
    if (force || h !== this.headShown) {
      this.headShown = h
      if (h == null) this.headG.style.display = 'none'
      else {
        this.headText.textContent = POINTS[Math.round(h / 45) % 8] + ' ' + h + '°'
        this.bug.setAttribute('transform', `rotate(${h} ${SPEEDO.cx} ${SPEEDO.cy})`)
        this.headG.style.display = ''
      }
    }

    const ty = Array.isArray(i.tyres) && i.tyres.length === 4 ? i.tyres : null
    const vals = ty ? ty.map((b) => (Number.isFinite(b) ? b.toFixed(2) : '–')) : null
    const yk = vals ? vals.join(' ') + (i.tyreWarn ? ' !' : '') : ''
    if (force || yk !== this.tyreShown) {
      this.tyreShown = yk
      if (!vals) this.tyreG.style.display = 'none'
      else {
        vals.forEach((s, k) => { this.tyreVals[k].textContent = s })
        this.tyreG.classList.toggle('warn', !!i.tyreWarn)
        this.tyreG.style.display = ''
      }
    }
  }

  paintDial(b, f, force) {
    const d = b.d
    const a = d.a0 + f * (d.a1 - d.a0)
    if (!force && Math.abs(a - b.last) < 0.05) return
    b.last = a
    // Light the dots the sweep has passed.
    const lit = f > 0.004 ? Math.min(N + 1, Math.floor(f * N + 1e-6) + 1) : 0
    if (force || lit !== b.lit) {
      const lo = force ? 0 : Math.min(lit, b.lit), hi = force ? N + 1 : Math.max(lit, b.lit)
      for (let k = lo; k < hi; k++) b.dots[k].classList.toggle('on', k < lit)
      b.lit = lit
    }
    if (f <= 0.004) {
      for (const k of ['halo', 'main', 'head', 'core']) b[k].setAttribute('d', '')
      b.glow.style.display = 'none'
      return
    }
    const full = arcPath(d.cx, d.cy, R.band, d.a0, a)
    b.halo.setAttribute('d', full)
    b.main.setAttribute('d', full)
    b.head.setAttribute('d', arcPath(d.cx, d.cy, R.band, Math.max(d.a0, a - b.look.head), a))
    b.core.setAttribute('d', arcPath(d.cx, d.cy, R.band, Math.max(d.a0, a - b.look.core), a))
    const [x, y] = polar(d.cx, d.cy, R.band, a)
    b.glow.setAttribute('cx', fx(x)); b.glow.setAttribute('cy', fx(y))
    b.glow.style.display = ''
  }

  paintTile(p, val, force) {
    const n = Number.isFinite(val) ? val : 0
    const s = p.fmt(n)
    if (s !== p.shown) { p.shown = s; p.val.textContent = s }
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
