// Digital bars, Corvette C4-style, after Blackbox Infinite's C4 cluster for
// "CarPlay Generations": two rounded panels where a fan of thin bars sweeps
// up from the bottom left and flattens out at the top right, speed on the
// left and revs on the right, each with a framed readout; in the middle, the
// tyre-pressure and coolant boxes either side of a stacked fuel bar, trip and average
// speed readouts, two turn arrows and a "now playing" pill that shows the
// engine, the time and the throttle. Our own drawing: no logos, no CarPlay
// tiles, and no plate behind it all (the page's own background shows).
//
// The picture is laid out in the reference image's own pixels (1920 x 722),
// cropped to the panels by a translate on the root group, so every shape
// can be checked against it directly.
import { GaugeStyle, el, text, setText, polar, clamp, mix, hhmm } from './kit.js'

// The crop of the reference: the panels span x 92..1838, y 83..632.
const OX = 85, OY = 75
const VIEW = { w: 1760, h: 568 }

const C = {
  yellow: '#f6e22c', tip: '#ece832', lime: '#c6dc2c', green: '#7ec832', olive: '#5a661c', oliveDark: '#3a4612',
  off: '#1e2f22', track: '#142219', offRed: '#3a1912',
  tGreen0: '#2c4a25', tGreen1: '#4f8a2e', tGreen2: '#8ed640', orange: '#f27a1c', red: '#ff2b1c',
  dim: '#5c5521', fuelOff: '#1c3022',
}
// The day look: the same instrument as a daylight LCD in Tesla's light UI.
// The colour coding stays, darkened to read on light; the dim (far from the
// tip, low in the revs) end fades towards the panel instead of to black.
const D = {
  tip: '#d9a300', lime: '#86ae12', green: '#3f9a24', olive: '#6c9c40', oliveDark: '#9dbd84',
  tGreen0: '#93c47c', tGreen1: '#56a838', tGreen2: '#2f9324', orange: '#e0620a', red: '#d4261b',
  fuelOff: 'rgba(0, 0, 0, 0.08)',
}

// A fan: a quarter ring about (cx, cy) from 180° (pointing left, the bottom
// of the fan) to 270° (up, its right-hand end). Bars are radial pills.
const FAN = { cy: 578, ro: 410, ri: 335, barIn: 345, barOut: 400, n: 56 }
const SPEED_CX = 580
const DX = 1196                 // the right panel is the left one, moved over
const TACH_CX = SPEED_CX + DX
const SPEED_MAX = 200
const FUEL_BARS = 13
const fanAngle = (f) => 180 + 90 * clamp(f, 0, 1)

// The tach's colour along its scale: dark green, green, yellow near the
// warning band, orange through it, red from the redline.
function tachColor(rpm, scale, P = C) {
  if (rpm >= scale.redFrom) return P.red
  if (rpm >= scale.warnFrom) return mix(P.tip, P.orange, (rpm - scale.warnFrom) / Math.max(1, scale.redFrom - scale.warnFrom) * 1.6)
  const f = rpm / scale.warnFrom
  if (f < 0.6) return mix(P.tGreen0, P.tGreen1, f / 0.6)
  if (f < 0.85) return mix(P.tGreen1, P.tGreen2, (f - 0.6) / 0.25)
  return mix(P.tGreen2, P.tip, (f - 0.85) / 0.15)
}
// The speed run is coloured from its tip back: yellow, lime, green, then
// the long olive tail of the reference.
function speedColor(d, P = C) {
  if (d < 3) return mix(P.tip, P.lime, d / 3)
  if (d < 8) return mix(P.lime, P.green, (d - 3) / 5)
  if (d < 16) return mix(P.green, P.olive, (d - 8) / 8)
  return mix(P.olive, P.oliveDark, (d - 16) / 34)
}
// Fuel bar k's lit colour: red at E, orange, yellow, then green to F.
function fuelColor(k, P = C) {
  if (P === D) return k === 0 ? D.red : k === 1 ? D.orange : k < 4 ? mix(D.orange, D.tip, (k - 1) / 3) : mix(D.tip, D.green, (k - 4) / 8)
  return k === 0 ? '#ff4a1c' : k === 1 ? C.orange : k < 4 ? mix(C.orange, '#f1d92a', (k - 1) / 3) : mix('#e6e22c', C.lime, (k - 4) / 8)
}

const f1 = (x) => x.toFixed(1)
// A rounded box whose bottom edge breaks for a caption, as on the readouts.
function gapBox(x, y, w, h, r, gap) {
  const cx = x + w / 2, b = y + h
  return `M${cx - gap / 2} ${b}H${x + r}A${r} ${r} 0 0 1 ${x} ${b - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}` +
    `H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${b - r}A${r} ${r} 0 0 1 ${x + w - r} ${b}H${cx + gap / 2}`
}
// The ring between radii ri and ro from a0 to a1, as one closed path.
function ringPath(cx, cy, ri, ro, a0, a1) {
  const [x0, y0] = polar(cx, cy, ro, a0), [x1, y1] = polar(cx, cy, ro, a1)
  const [x2, y2] = polar(cx, cy, ri, a1), [x3, y3] = polar(cx, cy, ri, a0)
  return `M${f1(x0)} ${f1(y0)}A${ro} ${ro} 0 0 1 ${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}A${ri} ${ri} 0 0 0 ${f1(x3)} ${f1(y3)}Z`
}

const CSS = `
.gs-digital { font-family: "SF Pro Display", -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif; }
.gs-digital .dg-panel { stroke-width: 4; }
.gs-digital .dg-tile { fill: #100f0b; stroke: #2a2822; stroke-width: 3; }
.gs-digital .dg-track { fill: ${C.track}; stroke: ${C.track}; stroke-width: 12; stroke-linejoin: round; }
.gs-digital .dg-bar { stroke: ${C.off}; stroke-width: 7.5; stroke-linecap: round; }
.gs-digital .dg-bar.red { stroke: ${C.offRed}; }
.gs-digital .dg-num { fill: ${C.yellow}; font-family: "SF Pro Rounded", ui-rounded, "Arial Rounded MT Bold", -apple-system, sans-serif; font-size: 34px; font-weight: 600; text-anchor: middle; dominant-baseline: central; }
.gs-digital .dg-tick { stroke: ${C.yellow}; stroke-width: 4.5; stroke-linecap: round; }
.gs-digital .dg-tick.minor { stroke: #c9cf2a; stroke-width: 3.5; opacity: 0.8; }
.gs-digital .dg-tick.red { stroke: ${C.red}; }
.gs-digital .dg-box { fill: #17150c; }
.gs-digital .dg-frame { fill: none; stroke: #5b5716; stroke-width: 4; }
.gs-digital .dg-inset { fill: #141209; stroke: #3b381a; stroke-width: 3; }
.gs-digital .dg-big { fill: ${C.yellow}; font-weight: 400; text-anchor: middle; font-variant-numeric: tabular-nums; }
.gs-digital .dg-big.end { text-anchor: end; }
.gs-digital .dg-big.start { text-anchor: start; }
.gs-digital .dg-halo { fill: none; stroke: ${C.yellow}; stroke-width: 7; stroke-linejoin: round; opacity: 0.12; }
.gs-digital .dg-unit { fill: ${C.yellow}; font-size: 31px; font-style: italic; text-anchor: middle; dominant-baseline: central; }
.gs-digital .dg-lab { fill: ${C.yellow}; font-size: 23px; font-weight: 500; }
.gs-digital .dg-lab.dim { fill: ${C.dim}; }
.gs-digital .dg-lab.mid { text-anchor: middle; }
.gs-digital .dg-lab.end { text-anchor: end; }
.gs-digital .dg-head { font-size: 26px; text-anchor: middle; }
.gs-digital .dg-fuel-lab { fill: ${C.yellow}; font-size: 25px; font-weight: 500; }
.gs-digital .dg-ftick { stroke: #3f5a37; stroke-width: 5; stroke-linecap: round; }
.gs-digital .dg-icon { fill: none; stroke: ${C.yellow}; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.gs-digital .dg-icon-fill { fill: ${C.yellow}; }
.gs-digital .dg-tyre.none { fill: ${C.dim}; }
.gs-digital .dg-tyres.warn .dg-tyre { fill: ${C.red}; }
.gs-digital .dg-tyres.warn .dg-halo { stroke: ${C.red}; opacity: 0.25; }
.gs-digital .dg-tyres.warn .dg-tpms { stroke: ${C.red}; }
.gs-digital .dg-tyres.warn .dg-tpms-fill { fill: ${C.red}; }
.gs-digital .dg-car { fill: none; stroke: ${C.dim}; stroke-width: 2.5; stroke-linejoin: round; }
.gs-digital .dg-wheel { fill: ${C.dim}; }
.gs-digital .dg-btrack { fill: #4c2b0c; }
.gs-digital .dg-bfill { fill: ${C.orange}; }
.gs-digital .dg-bfill.hot { fill: ${C.red}; }
.gs-digital .dg-btick { stroke: #94440f; stroke-width: 4; stroke-linecap: round; }
.gs-digital .dg-arrow-well { fill: #0c0d09; stroke: #1d2019; stroke-width: 3; }
.gs-digital .dg-arrow { fill: #2f5020; stroke: #2f5020; stroke-width: 6; stroke-linejoin: round; }
.gs-digital .dg-pill { fill: #13110c; stroke: #2d2b26; stroke-width: 4; }
.gs-digital .dg-song { fill: ${C.yellow}; font-size: 23px; font-weight: 600; text-anchor: middle; }
.gs-digital .dg-time { fill: #85742a; font-size: 25px; text-anchor: middle; font-variant-numeric: tabular-nums; }
.gs-digital .dg-ptrack { fill: #24301a; }
.gs-digital .dg-pfill { fill: ${C.orange}; }
.gs-digital .dg-pdot { fill: #ffe14a; }
.gs-digital .dg-sim { fill: ${C.yellow}; font-size: 24px; font-weight: 600; }
.gs-digital .dg-finger { fill: rgba(246, 226, 44, 0.18); stroke: ${C.yellow}; stroke-width: 4; pointer-events: none; }
.gs-digital[data-zone=red] .dg-tach-frame { stroke: ${C.red}; }
.gs-digital[data-zone=red] .dg-tach-num { fill: ${C.red}; }
.gs-digital[data-zone=red] .dg-tach-halo { stroke: ${C.red}; opacity: 0.3; }

/* Day: light panels with soft shadows and mid-grey rims, dark grey type,
   solid bars with no glow. */
.gs-digital[data-theme=day] .dg-panel { filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.13)); }
.gs-digital[data-theme=day] .dg-st-panel0 { stop-color: #fafafa; }
.gs-digital[data-theme=day] .dg-st-panel1 { stop-color: #eff0f1; }
.gs-digital[data-theme=day] .dg-st-rim0 { stop-color: #cfd1d3; }
.gs-digital[data-theme=day] .dg-st-rim1 { stop-color: #c4c7c9; }
.gs-digital[data-theme=day] .dg-st-rim2 { stop-color: #b5b8bb; }
.gs-digital[data-theme=day] .dg-st-pfill0 { stop-color: #d4580a; }
.gs-digital[data-theme=day] .dg-st-pfill1 { stop-color: #ec8a10; }
.gs-digital[data-theme=day] .dg-glowonly,
.gs-digital[data-theme=day] .dg-halo { display: none; }
.gs-digital[data-theme=day] .dg-scale { filter: none; }
.gs-digital[data-theme=day] .dg-tile { fill: #f7f7f7; stroke: #cfd1d3; filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.12)); }
.gs-digital[data-theme=day] .dg-track { fill: #e4e5e6; stroke: #e4e5e6; }
.gs-digital[data-theme=day] .dg-bar { stroke: rgba(0, 0, 0, 0.08); }
.gs-digital[data-theme=day] .dg-bar.red { stroke: rgba(212, 38, 27, 0.16); }
.gs-digital[data-theme=day] .dg-num { fill: #393c41; }
.gs-digital[data-theme=day] .dg-tick { stroke: #393c41; }
.gs-digital[data-theme=day] .dg-tick.minor { stroke: #8e9195; opacity: 1; }
.gs-digital[data-theme=day] .dg-tick.red { stroke: ${D.red}; }
.gs-digital[data-theme=day] .dg-box { fill: #fbfbfb; }
.gs-digital[data-theme=day] .dg-frame { stroke: #b5b8bb; }
.gs-digital[data-theme=day] .dg-inset { fill: #fbfbfb; stroke: #cfd1d3; }
.gs-digital[data-theme=day] .dg-big { fill: #1f2124; }
.gs-digital[data-theme=day] .dg-unit { fill: #393c41; }
.gs-digital[data-theme=day] .dg-lab { fill: #393c41; }
.gs-digital[data-theme=day] .dg-lab.dim { fill: #9a9da1; }
.gs-digital[data-theme=day] .dg-fuel-lab { fill: #393c41; }
.gs-digital[data-theme=day] .dg-ftick { stroke: #a6a9ac; }
.gs-digital[data-theme=day] .dg-icon { stroke: #393c41; }
.gs-digital[data-theme=day] .dg-icon-fill { fill: #393c41; }
.gs-digital[data-theme=day] .dg-tyre.none { fill: #b4b7ba; }
.gs-digital[data-theme=day] .dg-tyres.warn .dg-tyre { fill: ${D.red}; }
.gs-digital[data-theme=day] .dg-tyres.warn .dg-tpms { stroke: ${D.red}; }
.gs-digital[data-theme=day] .dg-tyres.warn .dg-tpms-fill { fill: ${D.red}; }
.gs-digital[data-theme=day] .dg-car { stroke: #b4b7ba; }
.gs-digital[data-theme=day] .dg-wheel { fill: #b4b7ba; }
.gs-digital[data-theme=day] .dg-btrack { fill: rgba(0, 0, 0, 0.08); }
.gs-digital[data-theme=day] .dg-bfill { fill: ${D.orange}; }
.gs-digital[data-theme=day] .dg-bfill.hot { fill: ${D.red}; }
.gs-digital[data-theme=day] .dg-btick { stroke: #a6a9ac; }
.gs-digital[data-theme=day] .dg-arrow-well { fill: #f4f4f4; stroke: #cfd1d3; }
.gs-digital[data-theme=day] .dg-arrow { fill: #c3d4bb; stroke: #c3d4bb; }
.gs-digital[data-theme=day] .dg-pill { fill: #fafafa; stroke: #cfd1d3; filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.12)); }
.gs-digital[data-theme=day] .dg-song { fill: #1f2124; }
.gs-digital[data-theme=day] .dg-time { fill: #5c5e62; }
.gs-digital[data-theme=day] .dg-ptrack { fill: rgba(0, 0, 0, 0.08); }
.gs-digital[data-theme=day] .dg-pdot { fill: #c4540a; }
.gs-digital[data-theme=day] .dg-sim { fill: #1f2124; }
.gs-digital[data-theme=day] .dg-finger { fill: rgba(0, 0, 0, 0.08); stroke: #393c41; }
.gs-digital[data-theme=day][data-zone=red] .dg-tach-frame { stroke: ${D.red}; }
.gs-digital[data-theme=day][data-zone=red] .dg-tach-num { fill: ${D.red}; }
`

export default class DigitalStyle extends GaugeStyle {
  static meta = {
    key: 'digital', name: 'Digital bars', era: 'Corvette C4-style', view: VIEW,
    blurb: 'An 80s digital dash: sweeping bar fans for speed and revs in framed panels, tyre pressures, coolant and fuel bars, trip and average speed.',
  }

  build() {
    this.css(CSS)
    const defs = el('defs', {}, this.svg)
    const lin = (name, stops, attrs = { x1: 0, y1: 0, x2: 0, y2: 1 }) => {
      const g = el('linearGradient', { id: this.id(name), ...attrs }, defs)
      // Each stop gets a class so the day look can recolour it from CSS.
      stops.forEach(([o, c, op], k) => el('stop', { offset: o, 'stop-color': c, 'stop-opacity': op ?? 1, class: `dg-st-${name}${k}` }, g))
    }
    lin('panel', [[0, '#17150f'], [1, '#0e0d0a']])
    lin('rim', [[0, '#1c1b17'], [0.6, '#2a2925'], [1, '#3c3b37']])
    lin('pfill', [[0, '#e8640c'], [1, '#ffa21a']], { x1: 0, y1: 0, x2: 1, y2: 0 })
    const tip = el('radialGradient', { id: this.id('tip') }, defs)
    el('stop', { offset: '0', 'stop-color': '#e8f040', 'stop-opacity': '0.42' }, tip)
    el('stop', { offset: '1', 'stop-color': '#e8f040', 'stop-opacity': '0' }, tip)
    const boxGlow = el('radialGradient', { id: this.id('boxglow') }, defs)
    el('stop', { offset: '0', 'stop-color': '#6a5e1c', 'stop-opacity': '0.55' }, boxGlow)
    el('stop', { offset: '1', 'stop-color': '#6a5e1c', 'stop-opacity': '0' }, boxGlow)
    // A soft glow for the static numerals only: they never change after
    // onScale, so the blur is rasterised once.
    const glow = el('filter', { id: this.id('glow'), x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs)
    el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '3', result: 'b' }, glow)
    const m = el('feMerge', {}, glow)
    el('feMergeNode', { in: 'b' }, m); el('feMergeNode', { in: 'SourceGraphic' }, m)

    const s = this.root = el('g', { transform: `translate(${-OX} ${-OY})` }, this.svg)

    // ── The two big panels ──
    const panel = (x) => el('rect', { x, y: 85, width: 548, height: 546, rx: 36, class: 'dg-panel', fill: this.url('panel'), stroke: this.url('rim') }, s)
    panel(94); panel(94 + DX)

    // Speed: drawn once, km/h does not change with the engine.
    const sg = el('g', {}, s)
    el('path', { d: ringPath(SPEED_CX, FAN.cy, FAN.ri + 6, FAN.ro - 6, 180, 270), class: 'dg-track' }, sg)
    this.speedTip = el('circle', { r: 64, fill: this.url('tip'), class: 'dg-glowonly', style: 'display:none' }, s)
    this.speedBars = this.fanBars(el('g', {}, s), SPEED_CX, () => 'dg-bar')
    const sScale = el('g', { filter: this.url('glow'), class: 'dg-scale' }, s)
    for (let v = 10; v <= SPEED_MAX; v += 10) {
      const lab = (v / 10) % 2 === 1
      this.tick(sScale, SPEED_CX, v / SPEED_MAX, lab ? 'dg-tick' : 'dg-tick minor')
      if (lab) this.label(sScale, SPEED_CX, v / SPEED_MAX, String(v), 'dg-num')
    }
    this.speedNum = this.readout(s, 350, 'KM/H', 92, 'speed')

    // Revs: the track is fixed, the bars and scale follow the engine.
    el('path', { d: ringPath(TACH_CX, FAN.cy, FAN.ri + 6, FAN.ro - 6, 180, 270), class: 'dg-track' }, s)
    this.tachTip = el('circle', { r: 64, fill: this.url('tip'), class: 'dg-glowonly', style: 'display:none' }, s)
    this.tachG = el('g', {}, s)
    this.tachScaleG = el('g', { filter: this.url('glow'), class: 'dg-scale' }, s)
    this.tachNum = this.readout(s, 350 + DX, 'RPM/100', 140, 'tach')
    this.simTag = text(s, 1336, 136, 'dg-sim', 'SIM')
    this.simTag.style.display = 'none'
    this.finger = el('circle', { r: 40, class: 'dg-finger', style: 'display:none' }, s)

    this.buildCentre(s)
  }

  // Bars for one fan, each a radial pill.
  fanBars(g, cx, cls) {
    const bars = []
    for (let k = 0; k < FAN.n; k++) {
      const a = fanAngle((k + 0.5) / FAN.n)
      const [x1, y1] = polar(cx, FAN.cy, FAN.barIn, a), [x2, y2] = polar(cx, FAN.cy, FAN.barOut, a)
      bars.push(el('line', { x1: f1(x1), y1: f1(y1), x2: f1(x2), y2: f1(y2), class: cls(k) }, g))
    }
    return bars
  }
  tick(g, cx, f, cls) {
    const a = fanAngle(f)
    const [x1, y1] = polar(cx, FAN.cy, FAN.ro + 9, a), [x2, y2] = polar(cx, FAN.cy, FAN.ro + 18, a)
    el('line', { x1: f1(x1), y1: f1(y1), x2: f1(x2), y2: f1(y2), class: cls }, g)
  }
  // A numeral just outside the ticks: wide numbers sit further out where
  // the fan is upright, tall ones where it is flat.
  label(g, cx, f, s, cls) {
    const a = fanAngle(f), rad = (a * Math.PI) / 180
    const r = FAN.ro + 26 + Math.abs(Math.cos(rad)) * s.length * 10.5 + Math.abs(Math.sin(rad)) * 13
    const [x, y] = polar(cx, FAN.cy, r, a)
    text(g, f1(x), f1(y), cls, s)
  }
  // The framed readout bottom right of a panel: a big number, the unit
  // breaking the frame's bottom edge.
  readout(s, x, unit, gap, key) {
    el('ellipse', { cx: x + 112, cy: 500, rx: 120, ry: 70, fill: this.url('boxglow'), class: 'dg-glowonly' }, s)
    el('rect', { x, y: 433, width: 223, height: 138, rx: 22, class: 'dg-box' }, s)
    el('path', { d: gapBox(x, 433, 223, 138, 22, gap), class: `dg-frame dg-${key}-frame` }, s)
    text(s, x + 111.5, 571, 'dg-unit', unit)
    const halo = text(s, x + 111.5, 537, `dg-big dg-halo dg-${key}-halo`, '', { 'font-size': 104 })
    const num = text(s, x + 111.5, 537, `dg-big dg-${key}-num`, '', { 'font-size': 104 })
    return [halo, num]
  }

  buildCentre(s) {
    // Each box: the lit label over the dim one and an icon along the bottom.
    const frame = (g, x, lit, dimLab, icon) => {
      el('rect', { x, y: 85, width: 200, height: 216, rx: 22, class: 'dg-tile' }, g)
      this.fit(text(g, x + 16, 262, 'dg-lab', lit), 124)
      this.fit(text(g, x + 16, 290, 'dg-lab dim', dimLab), 124)
      icon(el('g', { transform: `translate(${x + 170} 266) scale(0.8)` }, g))
    }
    // Tyres: the four pressures as the wheels sit seen from above, the
    // front pair over the rear, round a little car. Dashes until read.
    {
      const x = 663, tg = this.tyreG = el('g', { class: 'dg-tyres' }, s)
      frame(tg, x, 'TYRE PRESS', 'BAR', (g) => this.tpmsIcon(g, 0, 0))
      const cx = x + 100
      el('rect', { x: cx - 13, y: 112, width: 26, height: 104, rx: 10, class: 'dg-car' }, tg)
      for (const [dx, y] of [[-1, 128], [1, 128], [-1, 184], [1, 184]]) el('rect', { x: cx + dx * 15 - 3, y, width: 6, height: 18, rx: 2, class: 'dg-wheel' }, tg)
      this.tyreVals = [[-1, 151], [1, 151], [-1, 220], [1, 220]].map(([dx, y]) => {
        const side = dx < 0 ? ' end' : ' start', at = { 'font-size': 46 }
        return [text(tg, cx + dx * 24, y, 'dg-big dg-halo' + side, '', at), text(tg, cx + dx * 24, y, 'dg-big dg-tyre' + side, '', at)]
      })
      this.tyreShown = null
    }
    // Coolant: a big number, a bar with three ticks, the lit label over the
    // dim one, and an icon. The temperature is the lit one.
    const tile = (x, lit, dimLab, icon) => {
      frame(s, x, lit, dimLab, icon)
      const halo = text(s, x + 100, 170, 'dg-big dg-halo', '', { 'font-size': 76 })
      const num = text(s, x + 100, 170, 'dg-big', '', { 'font-size': 76 })
      for (const k of [0, 1, 2]) el('line', { x1: x + 28 + k * 72, y1: 197, x2: x + 28 + k * 72, y2: 206, class: 'dg-btick' }, s)
      el('rect', { x: x + 26, y: 211, width: 148, height: 10, rx: 5, class: 'dg-btrack' }, s)
      const fill = el('rect', { x: x + 26, y: 211, width: 0, height: 10, rx: 5, class: 'dg-bfill' }, s)
      return { halo, num, fill, w: -1 }
    }
    this.water = tile(1082, 'COOLANT TEMP', 'VOLTS', (g) => this.batteryIcon(g, 0, 0))

    // Fuel: thirteen bars, E at the bottom, red to orange to yellow to
    // green going up, as a gauge that warns low.
    this.fuelBars = []
    for (let k = 0; k < FUEL_BARS; k++) {
      const y = 233 - k * 11.25
      this.fuelBars.push({ e: el('rect', { x: 900, y: f1(y), width: 104, height: 7, rx: 3.5, fill: C.fuelOff }, s), col: fuelColor(k), day: fuelColor(k, D) })
    }
    for (let k = 0; k <= 4; k++) {
      const y = 236.5 - k * 33.75
      el('line', { x1: 1014, y1: y, x2: k % 2 ? 1020 : 1027, y2: y, class: 'dg-ftick' }, s)
    }
    text(s, 1040, 106, 'dg-fuel-lab', 'F', { 'dominant-baseline': 'central' })
    text(s, 1040, 240, 'dg-fuel-lab', 'E', { 'dominant-baseline': 'central' })
    this.fit(text(s, 898, 268, 'dg-fuel-lab', 'STATE OF'), 116)
    this.fit(text(s, 898, 293, 'dg-fuel-lab', 'CHARGE'), 116)
    this.battery(s, 1038, 262)

    // Trip and average speed, each under a lit header beside a dim one,
    // as on the original's mode buttons.
    el('rect', { x: 655, y: 316, width: 620, height: 160, rx: 28, class: 'dg-panel', fill: this.url('panel'), stroke: this.url('rim') }, s)
    text(s, 778, 362, 'dg-lab dim dg-head', 'RANGE')
    text(s, 920, 362, 'dg-lab dg-head', 'TRIP')
    text(s, 1033, 362, 'dg-lab dg-head', 'AVERAGE')
    text(s, 1153, 362, 'dg-lab dim dg-head', 'INSTANT')
    el('rect', { x: 670, y: 375, width: 278, height: 72, rx: 14, class: 'dg-inset' }, s)
    el('rect', { x: 982, y: 375, width: 278, height: 72, rx: 14, class: 'dg-inset' }, s)
    text(s, 686, 420, 'dg-lab', 'KM')
    this.tripNum = text(s, 932, 433, 'dg-big end', '', { 'font-size': 58 })
    this.avgNum = text(s, 1102, 433, 'dg-big', '', { 'font-size': 58 })
    text(s, 1246, 420, 'dg-lab', 'KM/H', { 'text-anchor': 'end' })
    this.avg = { km: 0, s: 0, t: 0 }

    // Turn arrows, never lit: we cannot see the indicators.
    const arrow = (cx, dir) => {
      el('circle', { cx, cy: 588, r: 34, class: 'dg-arrow-well' }, s)
      const p = [[-15, 0], [-1, -14], [-1, -6], [14, -6], [14, 6], [-1, 6], [-1, 14]]
      el('polygon', { points: p.map(([x, y]) => f1(cx + dir * x) + ',' + f1(588 + y)).join(' '), class: 'dg-arrow' }, s)
    }
    arrow(701, 1); arrow(1230, -1)

    // The "now playing" pill: the engine's name, the time, and the
    // throttle as the progress bar.
    el('rect', { x: 758, y: 542, width: 414, height: 90, rx: 34, class: 'dg-pill' }, s)
    this.song = text(s, 965, 572, 'dg-song', '')
    this.time = text(s, 965, 598, 'dg-time', '')
    el('rect', { x: 793, y: 602, width: 344, height: 9, rx: 4.5, class: 'dg-ptrack' }, s)
    this.prog = el('rect', { x: 793, y: 602, width: 0, height: 9, rx: 4.5, fill: this.url('pfill') }, s)
    this.progDot = el('circle', { cx: 793, cy: 606.5, r: 6.5, class: 'dg-pdot' }, s)
    this.progW = -1
  }

  // Squeeze a label into `max` units if the car's font sets it wider.
  fit(t, max) {
    try { if (t.getComputedTextLength() > max) { t.setAttribute('textLength', max); t.setAttribute('lengthAdjust', 'spacingAndGlyphs') } } catch {}
    return t
  }

  // Icons, small and plain, after the reference's.
  thermo(s, x, y) {
    el('path', { d: `M${x} ${y - 30}V${y - 14}M${x + 5} ${y - 28}h4M${x + 5} ${y - 22}h4M${x + 5} ${y - 16}h4` +
      `M${x - 13} ${y - 3}q4 -4 8 0t8 0t8 0M${x - 13} ${y + 2}q4 -4 8 0t8 0t8 0`, class: 'dg-icon', 'stroke-width': 2 }, s)
    el('circle', { cx: x, cy: y - 11, r: 3.5, class: 'dg-icon-fill' }, s)
  }
  // The tyre-pressure lamp: a tyre in section, flat on its tread, with a
  // "!" inside.
  tpmsIcon(s, x, y) {
    el('path', { d: `M${x - 13} ${y - 24}C${x - 25} ${y - 12} ${x - 23} ${y + 4} ${x - 16} ${y + 10}H${x + 16}C${x + 23} ${y + 4} ${x + 25} ${y - 12} ${x + 13} ${y - 24}` +
      `M${x - 12} ${y + 10}v5M${x - 4} ${y + 10}v5M${x + 4} ${y + 10}v5M${x + 12} ${y + 10}v5M${x} ${y - 18}v14`, class: 'dg-icon dg-tpms' }, s)
    el('circle', { cx: x, cy: y + 3, r: 2.5, class: 'dg-icon-fill dg-tpms-fill' }, s)
  }
  batteryIcon(s, x, y) {
    this.thermo(s, x, y - 2)
    this.battery(s, x, y)
  }
  // A battery, its terminals on top, minus and plus: centred on x, its
  // body from y + 8 to y + 26.
  battery(s, x, y) {
    el('path', { d: `M${x - 15} ${y + 8}h30v18h-30zM${x - 10} ${y + 8}v-3h5v3M${x + 5} ${y + 8}v-3h5v3M${x - 10} ${y + 17}h6M${x + 4} ${y + 17}h6M${x + 7} ${y + 14}v6`, class: 'dg-icon' }, s)
  }

  onScale(scale) {
    const g = this.tachG, sg = this.tachScaleG
    for (const n of [g, sg]) while (n.firstChild) n.removeChild(n.firstChild)
    const step = scale.max / FAN.n
    this.tachBars = this.fanBars(g, TACH_CX, (k) => (k + 0.5) * step >= scale.redFrom ? 'dg-bar red' : 'dg-bar')
      .map((e, k) => ({ e, col: tachColor((k + 0.5) * step, scale), day: tachColor((k + 0.5) * step, scale, D) }))
    for (let v = 500; v <= scale.max + 1e-6; v += 500) {
      const major = v % 1000 === 0
      this.tick(sg, TACH_CX, v / scale.max, (major ? 'dg-tick' : 'dg-tick minor') + (v >= scale.redFrom ? ' red' : ''))
    }
    for (let v = 0; v <= scale.max + 1e-6; v += 1000) this.label(sg, TACH_CX, v / scale.max, String(v / 100), 'dg-num')
    this.tachLit = -1
  }

  rpmAt(x, y) {
    const dx = x + OX - TACH_CX, dy = y + OY - FAN.cy
    const r = Math.hypot(dx, dy)
    if (r < FAN.ri - 50 || r > FAN.ro + 70) return null
    let a = (Math.atan2(dy, dx) * 180) / Math.PI
    if (a < 0) a += 360
    if (a < 170 || a > 280) return null
    return clamp((a - 180) / 90, 0, 1) * this.scale.max
  }
  // A finger anywhere on the rev panel revs the engine.
  tachHit(x, y) {
    const px = x + OX, py = y + OY
    return px >= 94 + DX && px <= 642 + DX && py >= 85 && py <= 631
  }
  onFinger(x, y, rpm) {
    const [cx, cy] = polar(TACH_CX, FAN.cy, (FAN.barIn + FAN.barOut) / 2, fanAngle(rpm / this.scale.max))
    this.finger.setAttribute('cx', f1(cx)); this.finger.setAttribute('cy', f1(cy))
    this.finger.style.display = ''
  }
  onFingerUp() { this.finger.style.display = 'none' }
  onTouchMode(on) { this.simTag.style.display = on ? '' : 'none' }

  paint(force) {
    if (!this.tachBars) return
    const v = this.v, i = this.i
    const day = this.theme() === 'day', P = day ? D : C
    const now = performance.now()
    const dt = this.avg.t ? clamp((now - this.avg.t) / 1000, 0, 0.5) : 0
    this.avg.t = now

    // Speed: the lit run is coloured from its tip back.
    const sLit = clamp(Math.round((v.kmh / SPEED_MAX) * FAN.n), 0, FAN.n)
    if (force || sLit !== this.speedLit) {
      this.speedLit = sLit
      this.speedBars.forEach((e, k) => { e.style.stroke = k < sLit ? speedColor(sLit - 1 - k, P) : '' })
      this.tip(this.speedTip, SPEED_CX, sLit)
    }
    // Revs: each bar keeps its colour along the scale.
    const tLit = clamp(Math.round((v.rpm / this.scale.max) * FAN.n), 0, FAN.n)
    if (force || tLit !== this.tachLit) {
      const all = force || this.tachLit < 0
      const from = all ? 0 : Math.min(tLit, this.tachLit), to = all ? FAN.n : Math.max(tLit, this.tachLit)
      for (let k = from; k < to; k++) this.tachBars[k].e.style.stroke = k < tLit ? (day ? this.tachBars[k].day : this.tachBars[k].col) : ''
      this.tachLit = tLit
      this.tip(this.tachTip, TACH_CX, tLit)
    }

    const sp = i.stale ? '--' : String(Math.min(999, Math.round(v.kmh)))
    setText(this.speedNum[0], sp); setText(this.speedNum[1], sp)
    const rp = String(Math.round(v.rpm / 100))
    setText(this.tachNum[0], rp); setText(this.tachNum[1], rp)

    this.paintTyres(force)
    this.paintTile(this.water, v.water, 40, 130, 112, force)

    const fLit = clamp(Math.round(v.fuel * FUEL_BARS), 0, FUEL_BARS)
    if (force || fLit !== this.fuelLit) {
      this.fuelLit = fLit
      this.fuelBars.forEach((b, k) => b.e.setAttribute('fill', k < fLit ? (day ? b.day : b.col) : P.fuelOff))
    }

    // Rolls over at 999.9 km, as the old trip meters did.
    setText(this.tripNum, ((Math.floor(v.trip * 10) / 10) % 1000).toFixed(1))
    // Average speed while moving, over the time this style has been shown.
    if (!i.stale && v.kmh >= 2) { this.avg.km += (v.kmh * dt) / 3600; this.avg.s += dt }
    setText(this.avgNum, this.avg.s > 0 ? Math.min(999.9, (this.avg.km * 3600) / this.avg.s).toFixed(1) : '0.0')

    const car = String(i.car || '').toUpperCase().slice(0, 28)
    if (car !== this.carLast) { this.carLast = car; setText(this.song, car) }
    setText(this.time, hhmm(i.clock instanceof Date ? i.clock : new Date()))
    const pw = Math.round(clamp(v.load, 0, 1) * 344)
    if (force || pw !== this.progW) {
      this.progW = pw
      this.prog.setAttribute('width', pw)
      this.progDot.setAttribute('cx', 793 + pw)
    }
  }

  // The tyre pressures, one decimal each; dashes in the unlit ink until
  // they are read, red while any wheel warns. Only touches the DOM when
  // what is shown changes.
  paintTyres(force) {
    const i = this.i
    const ty = Array.isArray(i.tyres) && i.tyres.length === 4 ? i.tyres : null
    const vals = ty ? ty.map((p) => (Number.isFinite(p) ? (Math.round(p * 10) / 10).toFixed(1) : '-.-')) : null
    const key = vals ? vals.join(' ') + (i.tyreWarn ? ' !' : '') : ''
    if (!force && key === this.tyreShown) return
    this.tyreShown = key
    this.tyreG.classList.toggle('warn', !!(vals && i.tyreWarn))
    this.tyreVals.forEach(([halo, num], k) => {
      const t = vals ? vals[k] : '-.-'
      setText(halo, t === '-.-' ? '' : t); setText(num, t)
      num.classList.toggle('none', t === '-.-')
    })
  }

  // A soft glow riding the lit run's tip (a gradient, no filter).
  tip(e, cx, lit) {
    if (lit < 1) { e.style.display = 'none'; return }
    const [x, y] = polar(cx, FAN.cy, (FAN.barIn + FAN.barOut) / 2, fanAngle((lit - 0.5) / FAN.n))
    e.setAttribute('cx', f1(x)); e.setAttribute('cy', f1(y))
    e.style.display = ''
  }

  paintTile(t, val, lo, hi, hot, force) {
    const n = (Math.round(val * 10) / 10).toFixed(1)
    setText(t.halo, n); setText(t.num, n)
    const w = Math.round(clamp((val - lo) / (hi - lo), 0, 1) * 148)
    if (force || w !== t.w) {
      t.w = w
      t.fill.setAttribute('width', w)
      t.fill.classList.toggle('hot', val >= hot)
    }
  }
}
