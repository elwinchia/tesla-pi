// Shared parts for the engine sound's gauge styles (static/gauges/*.js):
// SVG helpers, seven-segment digits, the made-up side instruments (water
// temperature and friends), and GaugeStyle, the base every style extends.
//
// A style is one class: it draws into an SVG of its own size and paints the
// values GaugeStyle eases for it. static/gauges/index.js lists them, and
// static/rev-dash.js puts the chosen one between the dash's buttons.
//
// Everything above the DOM section is pure and tested (test/gauge-kit.test.mjs).

// ── Maths ────────────────────────────────────────────────────────────────
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

// SVG angles: degrees from +x, clockwise (y points down), so 270 is up.
export function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}
// An arc path from a0 to a1 (degrees, clockwise when a1 > a0).
export function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  const sweep = a1 >= a0 ? 1 : 0
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
// Where v sits on a dial from a0 to a1 for the range lo..hi.
export function dialAngle(v, lo, hi, a0, a1) {
  const f = hi > lo && Number.isFinite(v) ? clamp((v - lo) / (hi - lo), 0, 1) : 0
  return a0 + f * (a1 - a0)
}
// Exponential follow: frame-rate independent, never overshoots.
export function follow(cur, target, dt, tau = 0.08) {
  if (!Number.isFinite(cur)) return target
  if (!(tau > 0)) return target
  return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau))
}
function hex(c) { return [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)) }
export function mix(a, b, t) {
  const A = hex(a), B = hex(b), u = clamp(t, 0, 1)
  return '#' + A.map((x, k) => Math.round(x + (B[k] - x) * u).toString(16).padStart(2, '0')).join('')
}

// ── Seven-segment digits ─────────────────────────────────────────────────
// Segments a..g, the usual way round: a top, b top right, c bottom right,
// d bottom, e bottom left, f top left, g middle.
export const SEVEN = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg',
  7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', '–': 'g', ' ': '', '': '',
  // Gear letters, as gear readouts draw them: N the tall arch, r and d
  // lower case, P with its bowl at the top.
  N: 'abcef', R: 'eg', P: 'abefg', D: 'bcdeg',
}
export function segmentsOf(ch) { return SEVEN[ch] ?? '' }

// Right-align `s` into n cells, as a fixed LCD does: '7' in three cells
// is '  7'. Too long keeps the last n characters.
export function lcdCells(s, n) {
  const t = String(s)
  return t.length >= n ? t.slice(-n).split('') : (' '.repeat(n - t.length) + t).split('')
}

// Polygons for one digit `w` x `h` at (x, y), segment thickness `t`, slanted
// by `skew` (x shift per unit of height, positive leans right). Each
// segment is a hexagon with pointed ends and a small gap, like a real LCD.
export function sevenPolys(x, y, w, h, t, skew = 0.08) {
  const g = t * 0.18, hh = h / 2, ht = t / 2
  const P = (px, py) => [x + px + skew * (h - py), y + py]
  const horiz = (cy) => [P(ht + g, cy), P(t + g, cy - ht), P(w - t - g, cy - ht), P(w - ht - g, cy), P(w - t - g, cy + ht), P(t + g, cy + ht)]
  const vert = (cx, y0, y1) => [P(cx, y0 + g), P(cx + ht, y0 + ht + g), P(cx + ht, y1 - ht - g), P(cx, y1 - g), P(cx - ht, y1 - ht - g), P(cx - ht, y0 + ht + g)]
  const poly = (pts) => pts.map(([a, b]) => a.toFixed(1) + ',' + b.toFixed(1)).join(' ')
  return {
    a: poly(horiz(ht)), g: poly(horiz(hh)), d: poly(horiz(h - ht)),
    f: poly(vert(ht, ht, hh)), b: poly(vert(w - ht, ht, hh)),
    e: poly(vert(ht, hh, h - ht)), c: poly(vert(w - ht, hh, h - ht)),
  }
}

// ── The side instruments ────────────────────────────────────────────────
// Made up, but well behaved: nothing here reads the car. Water warms from
// cold to ~90 °C over a few minutes of running and creeps up when the
// engine works hard; oil follows more slowly; pressure follows the revs.
// Trip and odometer are real: the car's speed, integrated. Fuel is pretend
// and drains with the odometer, a tank every 500 km.
//
// With the engine off every needle rests (as with the ignition off), while
// the temperatures keep cooling underneath. snapshot()/restore() carry the
// warmth across page reloads, which the CarPlay page does when it changes
// format.
export const AMBIENT_C = 30
export const REST = Object.freeze({ water: 40, oilTemp: 40, oilPress: 0, volts: 0, fuel: 0, boost: 0, g: 0 })
export class Instruments {
  constructor({ odo = 0 } = {}) {
    this.water = AMBIENT_C; this.oil = AMBIENT_C; this.heat = 0
    this.trip = 0; this.odo = odo
    this.running = false
  }
  // How hot the engine runs: 0 idling, 1 flat out for a minute.
  stepHeat(dt, rpm, load, redline) {
    const work = Math.max(0, load) * clamp(rpm / (redline || 7000), 0, 1)
    this.heat = follow(this.heat, work, dt, 40)
  }
  step(dt, { running = false, rpm = 0, load = 0, v = 0, a = 0, redline = 7000 } = {}) {
    dt = clamp(dt, 0, 5)
    this.running = !!running
    const km = (Math.max(0, v) * dt) / 1000
    this.trip += km; this.odo += km
    if (running) {
      this.stepHeat(dt, rpm, load, redline)
      const wTarget = 90 + 14 * this.heat
      // Warm-up is quicker below the thermostat, as in a real engine.
      this.water = follow(this.water, wTarget, dt, this.water < 80 ? 70 : 25)
      this.oil = follow(this.oil, 95 + 18 * this.heat, dt, 150)
    } else {
      this.heat = follow(this.heat, 0, dt, 40)
      this.water = follow(this.water, AMBIENT_C, dt, 900)
      this.oil = follow(this.oil, AMBIENT_C, dt, 1200)
    }
    return this.read({ running, rpm, load, a, redline })
  }
  read({ running = this.running, rpm = 0, load = 0, a = 0, redline = 7000 } = {}) {
    if (!running) return { ...REST, trip: this.trip, odo: this.odo }
    const r = clamp(rpm / (redline || 7000), 0, 1.1)
    const cold = clamp((80 - this.oil) / 50, 0, 1)
    return {
      water: this.water,
      oilTemp: this.oil,
      oilPress: clamp(1 + 0.6 * cold + 4.2 * r, 0, 6),
      volts: 14.2 - 0.25 * clamp(load, 0, 1),
      fuel: 0.82 - 0.72 * ((this.odo % 500) / 500),
      boost: load > 0.05 ? clamp(load * clamp((rpm - 1800) / 2500, 0, 1) * 1.1, 0, 1.2) : load < -0.2 ? -0.7 : -0.5,
      g: clamp(a / 9.81, -1.5, 1.5),
      trip: this.trip, odo: this.odo,
    }
  }
  snapshot(now = Date.now()) { return { water: this.water, oil: this.oil, trip: this.trip, odo: this.odo, t: now } }
  // Restore a snapshot, cooled for the time since it was taken (engine off).
  restore(s, now = Date.now()) {
    if (!s || typeof s !== 'object') return this
    const off = clamp((now - (Number(s.t) || now)) / 1000, 0, 86400)
    const cool = (x, tau) => AMBIENT_C + (x - AMBIENT_C) * Math.exp(-off / tau)
    if (Number.isFinite(s.water)) this.water = cool(clamp(s.water, -20, 130), 900)
    if (Number.isFinite(s.oil)) this.oil = cool(clamp(s.oil, -20, 150), 1200)
    if (Number.isFinite(s.trip)) this.trip = Math.max(0, s.trip)
    if (Number.isFinite(s.odo)) this.odo = Math.max(0, s.odo)
    return this
  }
}

// Tachometer scale for an engine: whole thousands, with at least 500 rpm of
// red past the redline, so the limiter never pins against the end.
// label: how often the dials number their scale. Every 1,000 rpm up to a
// 10,000 scale; every 2,000 past it (the F1's 18,000), where a number at
// every thousand would crowd the dials into one another.
export function tachScale(redline, idle = 0) {
  const max = Math.ceil((redline + 500) / 1000) * 1000
  return { max, redFrom: redline, warnFrom: Math.max(idle, redline - 700), label: max > 10000 ? 2000 : 1000 }
}

// Which band a value sits in. The limiter bounces the engine a few percent
// under the redline, and that bounce counts as red.
export const RED_SLACK = 0.97
export function zone(v, scale) {
  if (scale.redFrom != null && v >= scale.redFrom * RED_SLACK) return 'red'
  if (scale.warnFrom != null && v >= scale.warnFrom) return 'warn'
  return 'ok'
}
// Red latches for `hold` seconds after the last red reading, like a shift
// light, so the limiter reads as one steady warning instead of a flicker.
export class ZoneLatch {
  constructor(hold = 0.3) { this.hold = hold; this.left = 0 }
  next(v, scale, dt) {
    this.left -= dt
    const z = zone(v, scale)
    if (z === 'red') { this.left = this.hold; return z }
    return this.left > 0 ? 'red' : z
  }
}

// Clock text, 24 h, for styles that show the time.
export const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')

// ── DOM ──────────────────────────────────────────────────────────────────
export const NS = 'http://www.w3.org/2000/svg'
export function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v)
  if (parent) parent.appendChild(e)
  return e
}
export function text(parent, x, y, cls, s, attrs = {}) {
  const t = el('text', { x, y, class: cls, ...attrs }, parent)
  t.textContent = s
  return t
}
// Change text only when it changed: cheap enough for every frame.
export function setText(t, s) { if (t.textContent !== s) t.textContent = s }

// A row of seven-segment digits. Unlit segments stay faintly visible (the
// "ghost 8s" of an old LCD) when the style's CSS gives `.off` an opacity.
// Returns set(string): right-aligned, spaces blank a cell.
export function sevenRow(parent, { x, y, n, w, h, t, gap, skew = 0.08, cls = 'seg7' }) {
  const g = el('g', { class: cls }, parent)
  const cells = []
  for (let i = 0; i < n; i++) {
    const polys = sevenPolys(x + i * (w + gap), y, w, h, t, skew)
    const segs = {}
    for (const k of 'abcdefg') segs[k] = el('polygon', { points: polys[k], class: 'off' }, g)
    cells.push({ segs, ch: null })
  }
  return {
    g,
    set(s) {
      lcdCells(s, n).forEach((ch, i) => {
        const c = cells[i]
        if (c.ch === ch) return
        c.ch = ch
        const on = segmentsOf(ch)
        for (const k of 'abcdefg') c.segs[k].setAttribute('class', on.includes(k) ? 'on' : 'off')
      })
    },
  }
}

// The streak a moving needle leaves along its dial's rim: the tail follows
// the head with time constant tau (s), so a sweep draws a glowing arc that
// shrinks back into the needle once it stops; at rest there is none.
// layers: [stroke width, opacity] drawn under one another (haze, glow,
// core). The fade runs from clear at the tail to full at the head. Call
// update(angle) every frame, stopped or not: a stopped needle's streak
// still has to fade. clip: a clip-path id that keeps it on the scale.
export class Trace {
  constructor(parent, id, { cx, cy, r, color, tau = 0.35, min = 0.6, layers = [[3.4, 1]], clip = null }) {
    Object.assign(this, { cx, cy, r, tau, min })
    const defs = el('defs', {}, parent)
    this.fade = el('radialGradient', { id: id + '-fade', gradientUnits: 'userSpaceOnUse', cx, cy, r: 1 }, defs)
    for (const [o, a] of [[0, 0], [0.45, 0.3], [1, 1]]) el('stop', { offset: o, 'stop-color': color, 'stop-opacity': a }, this.fade)
    this.arc = el('path', { id: id + '-arc' }, defs)
    const g = el('g', { fill: 'none', stroke: `url(#${id}-fade)`, 'clip-path': clip ? `url(#${clip})` : null }, parent)
    for (const [sw, op] of layers) el('use', { href: '#' + id + '-arc', 'stroke-width': sw, opacity: op }, g)
    this.tail = null; this.shown = false; this.t = 0
  }
  update(a) {
    const now = performance.now()
    const dt = this.t ? Math.min(0.1, (now - this.t) / 1000) : 0
    this.t = now
    // A jump of more than half a turn (a clock at midnight, a redraw) is
    // not a movement: start again from there.
    if (this.tail == null || Math.abs(a - this.tail) > 180) this.tail = a
    this.tail = follow(this.tail, a, dt, this.tau)
    if (Math.abs(a - this.tail) < this.min) {
      // Hidden, but the tail keeps following, so a slow sweep (a clock's
      // seconds) still grows its streak from here.
      if (this.shown) { this.arc.setAttribute('d', ''); this.shown = false }
      return false
    }
    const { cx, cy, r } = this
    this.arc.setAttribute('d', arcPath(cx, cy, r, this.tail, a))
    const [tx, ty] = polar(cx, cy, r, this.tail), [hx, hy] = polar(cx, cy, r, a)
    this.fade.setAttribute('cx', tx.toFixed(1)); this.fade.setAttribute('cy', ty.toFixed(1))
    this.fade.setAttribute('r', Math.max(1, Math.hypot(hx - tx, hy - ty)).toFixed(1))
    this.shown = true
    return true
  }
}

// Values a style can show. GaugeStyle eases the numeric ones; a style reads
// them from this.v in paint(). The rest arrive as they are in this.i.
//   rpm, kmh, load (-1..1)            the engine and the car
//   water, oilTemp (°C), oilPress (bar), volts, fuel (0..1), boost (bar), g
//                                      made up (Instruments above), or rest
//   trip, odo (km)                     real: speed integrated, the odometer
//                                      set from the car's when it is read
//   gear ('–' off, 'N', '1'..), source ('GPS' | 'SIM' | 'TEST'), stale,
//   running, car (the engine's name), clock (Date)
//   rangeKm (null unless read), carReal  the car's own range, and whether
//                                      fuel is its real battery charge
//                                      (rev-car.js, over Bluetooth)
//   outsideC, insideC (°C)             the car's outside and cabin
//                                      temperatures (null unless read)
//   tyres ([fl, fr, rl, rr] bar), tyreWarn  its tyre pressures (null
//                                      unless read) and whether any wheel
//                                      has a pressure warning
//   heading (0..360°, 0 = north)       the direction of travel from GPS
//                                      (null without a recent fix)
export const EASE = { rpm: 0.08, kmh: 0.15, load: 0.12, water: 0.6, oilTemp: 0.6, oilPress: 0.25, volts: 0.4, fuel: 1.2, boost: 0.12, g: 0.2, trip: 0, odo: 0 }

let UID = 0
export class GaugeStyle {
  // Each style sets its own: key, name, blurb, view { w, h }. Every style
  // has a day and a night look: the svg carries data-theme="day" | "night"
  // (the page's theme), and a style's CSS keys its day colours off
  // .gs-<key>[data-theme=day]. In day it sits on the Tesla screen's floor
  // grey (--dash-a in rev-gauge.css), at night on black.
  static meta = { key: 'base', name: 'Base', blurb: '', view: { w: 1000, h: 400 } }

  constructor(host, { scale, theme = () => 'night' } = {}) {
    this.meta = this.constructor.meta
    this.theme = theme
    this.v = {}; this.t = {}
    for (const k of Object.keys(EASE)) { this.v[k] = k === 'water' || k === 'oilTemp' ? REST.water : 0; this.t[k] = this.v[k] }
    this.i = { gear: '–', source: 'GPS', stale: false, running: false, car: '', clock: new Date() }
    this.tau = { ...EASE }
    this.latch = new ZoneLatch()
    this.zone = 'ok'
    this.dt = 0
    this.touch = null; this.drag = null
    // Ids for gradients and filters must be unique per instance: a page can
    // show the same style twice (the picker's thumbnails).
    this.uid = `${this.meta.key}${++UID}-`
    const { w, h } = this.meta.view
    this.svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: `cluster-svg gs gs-${this.meta.key}`, role: 'img', 'aria-label': 'Engine speed and road speed' })
    this.lastTheme = theme()
    this.svg.setAttribute('data-theme', this.lastTheme)
    host.appendChild(this.svg)
    this.build()
    this.setScale(scale || tachScale(7000, 800))
    this.listen()
  }

  id(name) { return this.uid + name }
  url(name) { return `url(#${this.uid}${name})` }
  // A <style> element for the style's own CSS, scoped by .gs-<key>.
  css(rules) { el('style', {}, this.svg).textContent = rules }

  // ── For styles to implement ──
  build() {}               // create the picture in this.svg
  onScale(scale) {}        // (re)draw the tach's ticks and numbers for scale { max, redFrom, warnFrom }
  paint(force) {}          // draw this.v / this.i; force = redraw everything
  // Simulation mode (rev.html): the rpm under a point in picture units, or
  // null if the point is not on the tach. Default: across the whole width.
  rpmAt(x, y) { return clamp(x / this.meta.view.w, 0, 1) * this.scale.max }
  // Is the point on the rev meter (picture units)? Pressing and holding it
  // revs the engine (rev-dash.js), so be generous: the whole tach dial or
  // panel, not just its scale. Default: wherever rpmAt answers.
  tachHit(x, y) { return this.rpmAt(x, y) != null }

  // ── Plumbing ──
  setScale(scale) {
    this.scale = scale
    this.onScale(scale)
    this.paint(true)
  }
  set(input) {
    for (const [k, val] of Object.entries(input)) {
      if (k in EASE) { if (Number.isFinite(val)) this.t[k] = val }
      else this.i[k] = val
    }
  }
  frame(dt) {
    this.dt += dt
    for (const k of Object.keys(EASE)) this.v[k] = follow(this.v[k], this.t[k], dt, k === 'rpm' ? this.tau.rpm : this.tau[k])
    // The zone follows the engine, not the eased needle: a shift light that
    // waits for the animation is late.
    const z = this.latch.next(Math.max(this.v.rpm, this.t.rpm), this.scale, this.dt)
    this.dt = 0
    if (z !== this.zone) { this.zone = z; this.svg.setAttribute('data-zone', z) }
    const theme = this.theme()
    const force = theme !== this.lastTheme
    if (force) { this.lastTheme = theme; this.svg.setAttribute('data-theme', theme) }
    this.paint(force)
  }
  destroy() { this.endDrag(false); this.svg.remove() }

  // Simulation mode: a finger on the gauge sets the rpm. onHold(rpm) as it
  // lands and moves, onRelease(tap) when it lifts; null turns it off.
  setTouch(handlers) {
    this.touch = handlers || null
    if (!this.touch) this.endDrag(false)
    this.tau.rpm = this.touch ? 0.03 : EASE.rpm
    if (this.touch) this.svg.setAttribute('data-sim', '')
    else this.svg.removeAttribute('data-sim')
    this.onTouchMode(!!this.touch)
  }
  onTouchMode(on) {}
  onFinger(x, y, rpm) {}   // show where the finger is (optional)
  onFingerUp() {}
  toPicture(e) {
    const m = this.svg.getScreenCTM()
    if (!m) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return [p.x, p.y]
  }
  listen() {
    const svg = this.svg
    svg.addEventListener('pointerdown', (e) => {
      if (!this.touch || this.drag) return
      const p = this.toPicture(e)
      if (!p || this.rpmAt(p[0], p[1]) == null) return
      e.preventDefault()
      try { svg.setPointerCapture(e.pointerId) } catch {}
      this.drag = { id: e.pointerId, t0: performance.now(), x0: p[0], y0: p[1], moved: 0 }
      this.hold(p)
    })
    svg.addEventListener('pointermove', (e) => {
      const d = this.drag
      if (!d || e.pointerId !== d.id) return
      e.preventDefault()
      const p = this.toPicture(e)
      if (!p) return
      d.moved = Math.max(d.moved, Math.hypot(p[0] - d.x0, p[1] - d.y0))
      this.hold(p)
    })
    const end = (e) => {
      const d = this.drag
      if (!d || e.pointerId !== d.id) return
      this.endDrag(performance.now() - d.t0 < 250 && d.moved < 14)
    }
    svg.addEventListener('pointerup', end)
    svg.addEventListener('pointercancel', end)
    svg.addEventListener('lostpointercapture', end)
  }
  hold([x, y]) {
    let rpm = this.rpmAt(x, y)
    if (rpm == null) return
    this.onFinger(x, y, rpm)
    // Into the red asks for the limiter (LIMIT_OVER in rev-model.js).
    if (rpm >= this.scale.redFrom) rpm = this.scale.max
    if (this.touch) this.touch.onHold(Math.max(0, rpm))
  }
  endDrag(tap) {
    if (!this.drag) return
    this.drag = null
    this.onFingerUp()
    if (this.touch) this.touch.onRelease(tap)
  }
}
