// Backlit pair, Testarossa-style: two round dials in dark rounded panels,
// their numbers and ticks lit orange from behind, as on the late-80s
// cluster. The speedometer carries a glowing sweep and a big italic
// seven-segment speed ringed by small yellow dots; the tachometer reads
// x100 with a red end and the gear in a glowing orange disc. Between them,
// two small panels: the battery's charge (the car's own over Bluetooth, else
// made up) and water temperature as bars, marked by their icons alone, as
// on the original.
import { GaugeStyle, el, text, polar, arcPath, dialAngle, clamp, sevenRow, sevenPolys, segmentsOf } from './kit.js'

// Wide (3.1:1): the dash gives the gauge everything beside its one column
// of buttons, and the centre panels take the extra width.
const VIEW = { w: 1240, h: 400 }
// Both dials: 0 at bottom left, clockwise over the top to bottom right.
const A0 = 135, A1 = 405
const SPEEDO = { cx: 200, cy: 200, max: 200 }
const TACH = { cx: 1040, cy: 200 }
// Radii shared by both dials.
const R = { well: 184, ring: 175, tickOut: 167, tickIn: 151, tickMinor: 158, sweep: 159, num: 128 }
// The lit sweep fades in toward its tip: a faint full run, a brighter
// tail and a hot tip, stacked (a gradient cannot follow an arc in SVG).
const TAIL = 70, TIP = 22
// The centre bars: the battery's charge in %, water in °C. The battery
// reads red when it runs low, the water when it runs hot.
const MID = 620
const BAR = { x: MID - 150, w: 300, h: 14 }
// The gear: one seven-segment cell in the speed's italic, centred in the
// disc, as big as the speed's own digits (40 x 70, 10-unit segments).
const GEAR = { w: 54, h: 92, t: 14, skew: 0.14 }
// The disc, and its glow out to just short of the scale's numbers.
const DISC = { r: 84, glow: 112 }
const BARS = {
  batt:  { top: 4, lo: 0, hi: 1, labels: ['0', '50', '100'], key: 'fuel', low: 0.15 },
  water: { top: 204, lo: 50, hi: 130, labels: ['50', '90', '130'], key: 'water', hot: 115 },
}

// Upright, narrowed text: the cluster's numerals are a condensed face, and
// the car's browser has no condensed font we can count on.
function ctext(parent, x, y, cls, s, sx = 0.8) {
  return text(parent, 0, 0, cls, s, { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${sx} 1)` })
}

export default class BacklitStyle extends GaugeStyle {
  static meta = {
    key: 'backlit', name: 'Backlit pair', era: 'Testarossa-style', view: VIEW,
    blurb: 'Two orange-backlit dials with glowing sweeps, a seven-segment speed, the gear in a lit disc, battery and water bars.',
  }

  build() {
    const s = this.svg
    this.css(`
      .gs-backlit .bl-panel { fill: #1c1b1b; stroke: #262424; stroke-width: 2; }
      .gs-backlit .bl-well { fill: #161515; stroke: #0c0b0b; stroke-width: 4; }
      .gs-backlit .bl-ring { fill: none; stroke: #ff6a2a; stroke-width: 2; opacity: 0.45; }
      .gs-backlit .bl-ring.red { stroke: #ff2d20; stroke-width: 4; opacity: 0.95; }
      .gs-backlit .bl-tick { stroke: #8a3c1a; stroke-width: 3.2; }
      .gs-backlit .bl-tick.minor { stroke-width: 2; opacity: 0.8; }
      .gs-backlit .bl-tick.red { stroke: #ff2d20; opacity: 1; }
      .gs-backlit .bl-num { fill: #b4501f; font: 500 26px -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-backlit .bl-num.small { font-size: 23px; }
      .gs-backlit .bl-sweep { fill: none; stroke: #ff4f1f; stroke-width: 22; }
      .gs-backlit .bl-sweep.halo { stroke-width: 46; opacity: 0.1; }
      .gs-backlit .bl-sweep.base { opacity: 0.32; }
      .gs-backlit .bl-sweep.tail { opacity: 0.42; }
      .gs-backlit .bl-sweep.tip { stroke: #ff6a2a; opacity: 0.95; }
      .gs-backlit .bl-cap-end { fill: #ff6a2a; opacity: 0.95; }
      .gs-backlit[data-zone=red] .bl-tach .bl-cap-end { fill: #ff2d20; }
      .gs-backlit[data-zone=red] .bl-tach .bl-sweep { stroke: #ff2d20; }
      .gs-backlit .bl-cap { fill: #ff6a2a; font: 700 18px -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; letter-spacing: 0.04em; }
      .gs-backlit .bl-dot { fill: #e8d23a; }
      .gs-backlit .bl-seg .on { fill: #ff5a24; filter: drop-shadow(0 0 3px rgba(255, 106, 42, 0.95)) drop-shadow(0 0 12px rgba(255, 80, 30, 0.55)); }
      .gs-backlit .bl-seg .off { fill: #ff5a24; opacity: 0.06; }
      .gs-backlit .bl-gear-disc { fill: #ff5a1f; }
      .gs-backlit .bl-gseg .on { fill: #2a0c04; }
      .gs-backlit .bl-gseg .off { fill: #2a0c04; opacity: 0.05; }
      .gs-backlit .bl-gearg.off { opacity: 0.28; }
      .gs-backlit .bl-track { fill: #231915; stroke: #ff6a2a; stroke-width: 1.6; stroke-opacity: 0.7; }
      .gs-backlit .bl-fill { fill: #ff5a24; }
      .gs-backlit .bl-fill.halo { opacity: 0.16; }
      .gs-backlit .bl-bar.hot .bl-fill { fill: #ff2d20; }
      .gs-backlit .bl-btick { stroke: #8a3c1a; stroke-width: 3; }
      .gs-backlit .bl-btick.minor { stroke-width: 2; }
      .gs-backlit .bl-blabel { fill: #b4501f; font: 500 24px -apple-system, system-ui, sans-serif; text-anchor: middle; dominant-baseline: central; }
      .gs-backlit .bl-icon { fill: none; stroke: #ff6a2a; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
      .gs-backlit .bl-icon .solid { fill: #ff6a2a; stroke: none; }
      .gs-backlit .bl-finger { fill: rgba(255, 140, 60, 0.18); stroke: #ffb07a; stroke-width: 3; pointer-events: none; }

      /* Day: the same cluster printed rather than backlit, on Tesla's light
         floor: pale housings, white faces, dark numerals and ticks, and the
         orange kept as solid ink with no glow. */
      .gs-backlit[data-theme=day] .bl-panel { fill: #e8e9ea; stroke: #c4c6c8; }
      .gs-backlit[data-theme=day] .bl-well { fill: #f8f8f8; stroke: #b5b8bb; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.14)); }
      .gs-backlit[data-theme=day] .bl-ring { stroke: #d9480f; opacity: 0.55; }
      .gs-backlit[data-theme=day] .bl-ring.red { stroke: #d61f1f; opacity: 1; }
      .gs-backlit[data-theme=day] .bl-tick { stroke: #393c41; }
      .gs-backlit[data-theme=day] .bl-tick.red { stroke: #d61f1f; }
      .gs-backlit[data-theme=day] .bl-num { fill: #1f2124; }
      .gs-backlit[data-theme=day] .bl-sweep { stroke: #f76707; }
      .gs-backlit[data-theme=day] .bl-sweep.halo { opacity: 0; }
      .gs-backlit[data-theme=day] .bl-sweep.base { opacity: 0.24; }
      .gs-backlit[data-theme=day] .bl-sweep.tail { opacity: 0.38; }
      .gs-backlit[data-theme=day] .bl-sweep.tip { stroke: #d9480f; opacity: 1; }
      .gs-backlit[data-theme=day] .bl-cap-end { fill: #d9480f; opacity: 1; }
      .gs-backlit[data-theme=day][data-zone=red] .bl-tach .bl-cap-end { fill: #d61f1f; }
      .gs-backlit[data-theme=day][data-zone=red] .bl-tach .bl-sweep { stroke: #d61f1f; }
      .gs-backlit[data-theme=day] .bl-cap { fill: #d9480f; }
      .gs-backlit[data-theme=day] .bl-dot { fill: #d49a00; }
      .gs-backlit[data-theme=day] .bl-seg .on { fill: #d9480f; filter: none; }
      .gs-backlit[data-theme=day] .bl-seg .off { fill: #000; opacity: 0.08; }
      .gs-backlit[data-theme=day] .bl-glow { opacity: 0; }
      .gs-backlit[data-theme=day] .bl-disc0 { stop-color: #f76707; }
      .gs-backlit[data-theme=day] .bl-disc1 { stop-color: #e8590c; }
      .gs-backlit[data-theme=day] .bl-disc2 { stop-color: #d9480f; }
      .gs-backlit[data-theme=day] .bl-gseg .on { fill: #fff; }
      .gs-backlit[data-theme=day] .bl-gseg .off { fill: #fff; opacity: 0.08; }
      .gs-backlit[data-theme=day] .bl-gearg.off { opacity: 0.35; }
      .gs-backlit[data-theme=day] .bl-track { fill: #f4f4f4; stroke: #b5b8bb; stroke-opacity: 1; }
      .gs-backlit[data-theme=day] .bl-fill { fill: #e8590c; }
      .gs-backlit[data-theme=day] .bl-fill.halo { opacity: 0; }
      .gs-backlit[data-theme=day] .bl-bar.hot .bl-fill { fill: #d61f1f; }
      .gs-backlit[data-theme=day] .bl-btick { stroke: #393c41; }
      .gs-backlit[data-theme=day] .bl-blabel { fill: #393c41; }
      .gs-backlit[data-theme=day] .bl-icon { stroke: #d9480f; }
      .gs-backlit[data-theme=day] .bl-icon .solid { fill: #d9480f; }
      .gs-backlit[data-theme=day] .bl-finger { fill: rgba(217, 72, 15, 0.14); stroke: #d9480f; }
    `)
    const defs = el('defs', {}, s)
    // Soft backlight behind the gear disc: a radial gradient, not a blur,
    // so it costs nothing per frame. The speed digits glow themselves (CSS
    // drop-shadow on the lit segments, redrawn only when a digit changes).
    const glow = el('radialGradient', { id: this.id('glow') }, defs)
    el('stop', { offset: '0', 'stop-color': '#ff6a2a', 'stop-opacity': '0.4' }, glow)
    el('stop', { offset: '0.5', 'stop-color': '#ff5a1f', 'stop-opacity': '0.12' }, glow)
    el('stop', { offset: '1', 'stop-color': '#ff5a1f', 'stop-opacity': '0' }, glow)
    const disc = el('radialGradient', { id: this.id('disc'), cx: '0.45', cy: '0.4', r: '0.6' }, defs)
    el('stop', { offset: '0', 'stop-color': '#ffa070', class: 'bl-disc0' }, disc)
    el('stop', { offset: '0.6', 'stop-color': '#ff6a2a', class: 'bl-disc1' }, disc)
    el('stop', { offset: '1', 'stop-color': '#ff4f1f', class: 'bl-disc2' }, disc)
    const fill = el('linearGradient', { id: this.id('fill'), x1: '0', y1: '0', x2: '1', y2: '0' }, defs)
    el('stop', { offset: '0', 'stop-color': '#ff7a3a' }, fill)
    el('stop', { offset: '1', 'stop-color': '#ff4f1f' }, fill)

    // Three panels.
    el('rect', { x: 4, y: 4, width: 392, height: 392, rx: 22, class: 'bl-panel' }, s)
    el('rect', { x: 406, y: 4, width: 428, height: 192, rx: 18, class: 'bl-panel' }, s)
    el('rect', { x: 406, y: 204, width: 428, height: 192, rx: 18, class: 'bl-panel' }, s)
    el('rect', { x: 844, y: 4, width: 392, height: 392, rx: 22, class: 'bl-panel' }, s)

    // ── Speedometer ──
    const sp = this.speedoG = el('g', { class: 'bl-speedo' }, s)
    this.dialFace(sp, SPEEDO)
    for (let v = 0; v <= SPEEDO.max; v += 10) {
      const a = dialAngle(v, 0, SPEEDO.max, A0, A1)
      this.tick(sp, SPEEDO, a, v % 20 !== 0, false)
      if (v % 20 === 0) {
        const [x, y] = polar(SPEEDO.cx, SPEEDO.cy, R.num + 4, a)
        ctext(sp, x, y, 'bl-num small', String(v), 0.7)
      }
    }
    this.speedSweep = this.sweep(sp)
    for (let k = 0; k < 16; k++) {
      const [x, y] = polar(SPEEDO.cx, SPEEDO.cy, 80, k * 22.5)
      el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.6, class: 'bl-dot' }, sp)
    }
    text(sp, SPEEDO.cx, SPEEDO.cy + 100, 'bl-cap', 'km/h')
    this.speed = sevenRow(sp, { x: SPEEDO.cx - 74, y: SPEEDO.cy - 35, n: 3, w: 40, h: 70, t: 10, gap: 9, skew: 0.14, cls: 'seg7 bl-seg' })

    // ── Tachometer: ticks and numbers come from the scale (onScale) ──
    const tg = this.tachG = el('g', { class: 'bl-tach' }, s)
    this.dialFace(tg, TACH)
    this.tachScaleG = el('g', {}, tg)
    this.tachSweep = this.sweep(tg)
    const gg = this.gearG = el('g', { class: 'bl-gearg' }, tg)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: DISC.glow, fill: this.url('glow'), class: 'bl-glow' }, gg)
    el('circle', { cx: TACH.cx, cy: TACH.cy, r: DISC.r, fill: this.url('disc'), class: 'bl-gear-disc' }, gg)
    this.gear = this.gearCell(gg)
    // In the scale's gap at the bottom, under the disc.
    text(tg, TACH.cx, TACH.cy + DISC.r + 26, 'bl-cap', '× 100')
    this.finger = el('circle', { r: 26, class: 'bl-finger', style: 'display:none' }, tg)

    // ── Centre bars ──
    this.bars = {}
    for (const [k, b] of Object.entries(BARS)) {
      const g = el('g', { class: 'bl-bar' }, s)
      const y = b.top + 92
      this.icon(g, k, MID, b.top + 46)
      el('rect', { x: BAR.x, y, width: BAR.w, height: BAR.h, rx: BAR.h / 2, class: 'bl-track' }, g)
      const halo = el('rect', { x: BAR.x - 4, y: y - 6, width: 0, height: BAR.h + 12, rx: (BAR.h + 12) / 2, class: 'bl-fill halo' }, g)
      const bar = el('rect', { x: BAR.x, y, width: 0, height: BAR.h, rx: BAR.h / 2, class: 'bl-fill', fill: this.url('fill') }, g)
      for (let q = 0; q <= 4; q++) {
        const x = BAR.x + (BAR.w * q) / 4
        const major = q % 2 === 0
        el('line', { x1: x, y1: y + 26, x2: x, y2: y + (major ? 40 : 33), class: major ? 'bl-btick' : 'bl-btick minor' }, g)
        if (major) ctext(g, x, y + 60, 'bl-blabel', b.labels[q / 2], 0.8)
      }
      this.bars[k] = { ...b, g, halo, bar, w: -1, isHot: false }
    }
  }

  // The gear as one seven-segment cell, lit and faint unlit segments as the
  // speed has. The slant shifts the top right by skew x h, so the cell
  // starts half of that left of centre to sit in the middle of the disc.
  gearCell(parent) {
    const { w, h, t, skew } = GEAR
    const polys = sevenPolys(TACH.cx - w / 2 - (skew * h) / 2, TACH.cy - h / 2, w, h, t, skew)
    const g = el('g', { class: 'bl-gseg' }, parent)
    const segs = {}
    for (const k of 'abcdefg') segs[k] = el('polygon', { points: polys[k], class: 'off' }, g)
    let shown = null
    return {
      g,
      set(ch) {
        if (ch === shown) return
        shown = ch
        const on = segmentsOf(ch)
        for (const k of 'abcdefg') segs[k].setAttribute('class', on.includes(k) ? 'on' : 'off')
      },
    }
  }

  // The dark round well, behind ticks and sweep.
  dialFace(g, d) {
    el('circle', { cx: d.cx, cy: d.cy, r: R.well, class: 'bl-well' }, g)
    el('path', { d: arcPath(d.cx, d.cy, R.ring, A0, A1), class: 'bl-ring' }, g)
  }
  tick(g, d, a, minor, red) {
    const [x0, y0] = polar(d.cx, d.cy, minor ? R.tickMinor : R.tickIn, a)
    const [x1, y1] = polar(d.cx, d.cy, R.tickOut, a)
    const cls = 'bl-tick' + (minor ? ' minor' : '') + (red ? ' red' : '')
    el('line', { x1: x0.toFixed(1), y1: y0.toFixed(1), x2: x1.toFixed(1), y2: y1.toFixed(1), class: cls }, g)
  }
  sweep(g) {
    const mk = (cls) => el('path', { class: 'bl-sweep ' + cls }, g)
    // A round end on the leading edge only: a round-capped path would also
    // poke out behind the zero mark at low values.
    const cap = el('circle', { r: 11, class: 'bl-cap-end', style: 'display:none' }, g)
    return { halo: mk('halo'), base: mk('base'), tail: mk('tail'), tip: mk('tip'), cap, last: NaN }
  }
  icon(g, kind, x, y) {
    const ic = el('g', { class: 'bl-icon', transform: `translate(${x} ${y}) scale(1.25)` }, g)
    if (kind === 'batt') {
      // A battery: a box with its two terminals, + and −.
      el('path', { d: 'M-16 -8 H16 V12 H-16 Z M-11 -8 V-12 H-5 V-8 M5 -8 V-12 H11 V-8' }, ic)
      el('path', { d: 'M-11 2 H-5 M5 2 H11 M8 -1 V5' }, ic)
    } else {
      // Coolant: a thermometer standing in waves.
      el('path', { d: 'M0 -14 V3' }, ic)
      el('circle', { cx: 0, cy: 6, r: 3.5 }, ic)
      el('path', { d: 'M4 -11 H8 M4 -6 H8 M4 -1 H8' }, ic)
      el('path', { d: 'M-14 13 q3.5 -3 7 0 t7 0 t7 0 t7 0' }, ic)
    }
  }

  onScale(scale) {
    const g = this.tachScaleG
    while (g.firstChild) g.removeChild(g.firstChild)
    const max = scale.max
    // Red ring over the top end, then ticks every 250 rpm (500 on a big
    // scale), the numbers every 1000 in hundreds: "x100".
    el('path', { d: arcPath(TACH.cx, TACH.cy, R.ring, dialAngle(scale.redFrom, 0, max, A0, A1), A1), class: 'bl-ring red' }, g)
    const step = max <= 10000 ? 250 : 500
    for (let v = 0; v <= max; v += step) {
      const a = dialAngle(v, 0, max, A0, A1)
      this.tick(g, TACH, a, v % 1000 !== 0, v >= scale.redFrom)
      if (v % 1000 === 0) {
        const [x, y] = polar(TACH.cx, TACH.cy, R.num, a)
        ctext(g, x, y, 'bl-num', String(v / 100), 0.72)
      }
    }
    this.tachSweep.last = NaN
  }

  // The tach is the whole right-hand dial: the angle under the finger.
  rpmAt(x, y) {
    const dx = x - TACH.cx, dy = y - TACH.cy
    const r = Math.hypot(dx, dy)
    if (r < 50 || r > R.well + 16) return null
    let a = (Math.atan2(dy, dx) * 180) / Math.PI
    while (a < A0) a += 360
    // The gap at the bottom: snap to whichever end is nearer.
    if (a > A1) return a < (A1 + A0 + 360) / 2 ? this.scale.max : 0
    return ((a - A0) / (A1 - A0)) * this.scale.max
  }
  onFinger(x, y, rpm) {
    const [fx, fy] = polar(TACH.cx, TACH.cy, R.sweep, dialAngle(rpm, 0, this.scale.max, A0, A1))
    this.finger.setAttribute('cx', fx.toFixed(1)); this.finger.setAttribute('cy', fy.toFixed(1))
    this.finger.style.display = ''
  }
  onFingerUp() { this.finger.style.display = 'none' }
  // Pressing anywhere on the tach dial revs, its centre included.
  tachHit(x, y) { return Math.hypot(x - TACH.cx, y - TACH.cy) <= R.well + 16 }

  paint(force) {
    if (!this.scale) return
    const v = this.v, i = this.i
    this.paintSweep(this.speedSweep, SPEEDO, dialAngle(v.kmh, 0, SPEEDO.max, A0, A1), force)
    this.paintSweep(this.tachSweep, TACH, dialAngle(v.rpm, 0, this.scale.max, A0, A1), force)
    this.speed.set(i.stale ? '--' : String(clamp(Math.round(v.kmh), 0, 999)))
    this.gear.set(String(i.gear ?? '–'))
    const on = !!i.running
    if (force || on !== this.gearOn) { this.gearOn = on; this.gearG.classList.toggle('off', !on) }
    for (const b of Object.values(this.bars)) this.paintBar(b, v[b.key], force)
  }

  paintSweep(sw, d, a, force) {
    if (!force && Math.abs(a - sw.last) < 0.05) return
    sw.last = a
    if (a - A0 < 0.3) {
      for (const k of ['halo', 'base', 'tail', 'tip']) sw[k].setAttribute('d', '')
      sw.cap.style.display = 'none'
      return
    }
    const full = arcPath(d.cx, d.cy, R.sweep, A0, a)
    sw.halo.setAttribute('d', full)
    sw.base.setAttribute('d', full)
    sw.tail.setAttribute('d', arcPath(d.cx, d.cy, R.sweep, Math.max(A0, a - TAIL), a))
    sw.tip.setAttribute('d', arcPath(d.cx, d.cy, R.sweep, Math.max(A0, a - TIP), a))
    const [x, y] = polar(d.cx, d.cy, R.sweep, a)
    sw.cap.setAttribute('cx', x.toFixed(1)); sw.cap.setAttribute('cy', y.toFixed(1))
    sw.cap.style.display = ''
  }

  paintBar(b, val, force) {
    const f = Number.isFinite(val) && b.hi > b.lo ? clamp((val - b.lo) / (b.hi - b.lo), 0, 1) : 0
    const w = Math.round(f * BAR.w * 2) / 2
    if (force || w !== b.w) {
      b.w = w
      b.bar.setAttribute('width', w)
      b.halo.setAttribute('width', w > 0 ? w + 8 : 0)
    }
    const hot = this.i.running && ((b.hot != null && val >= b.hot) || (b.low != null && val <= b.low))
    if (force || hot !== b.isHot) { b.isHot = hot; b.g.classList.toggle('hot', hot) }
  }
}
