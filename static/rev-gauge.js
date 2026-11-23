// The engine sound page's cluster: a wide segmented tachometer arc, a
// glowing speed pill under it, and two small segmented bars. Plain SVG, no
// library. The geometry, colours and easing are pure and exported for
// `node --test` (test/rev-gauge.test.mjs); the Cluster class is the only
// part that needs a DOM.
//
// Angles are SVG's convention: degrees from +x, clockwise, y down, so 270°
// is straight up. The tach is a shallow arc of a large circle whose centre
// sits well below the picture.

export const VIEW = { w: 1000, h: 400 }
export const ARC = { cx: 500, cy: 700, rOut: 640, rIn: 590, a0: 232, a1: 308 }
export const SEG_PER_1000 = 6

// Tachometer scale for an engine: whole thousands, with at least 500 rpm of
// red past the redline, so the limiter never pins against the end.
export function tachScale(redline, idle = 0) {
  const max = Math.ceil((redline + 500) / 1000) * 1000
  return { max, redFrom: redline, warnFrom: Math.max(idle, redline - 700) }
}

export function angleFor(v, max) {
  const f = max > 0 && Number.isFinite(v) ? Math.min(1, Math.max(0, v / max)) : 0
  return ARC.a0 + f * (ARC.a1 - ARC.a0)
}

// The inverse, for a finger on the arc: the value under a point. Points
// beyond either end clamp to that end.
export function valueAt(x, y, max) {
  let a = (Math.atan2(y - ARC.cy, x - ARC.cx) * 180) / Math.PI
  if (a < 0) a += 360
  const f = (a - ARC.a0) / (ARC.a1 - ARC.a0)
  return Math.min(1, Math.max(0, f)) * max
}

// Where a finger can grab the arc: a band far wider than the segments,
// from just above the speed pill to above the arc, and a little past each
// end. Wide on purpose: it is for a finger on a car's screen, not a mouse.
export const HIT = { rMin: 505, rMax: 720, slack: 6 }
export function onArc(x, y) {
  const r = Math.hypot(x - ARC.cx, y - ARC.cy)
  if (r < HIT.rMin || r > HIT.rMax) return false
  let a = (Math.atan2(y - ARC.cy, x - ARC.cx) * 180) / Math.PI
  if (a < 0) a += 360
  return a >= ARC.a0 - HIT.slack && a <= ARC.a1 + HIT.slack
}

// What a finger asks the engine for: the rpm under it, or the limiter when
// it is in the red zone (LIMIT_OVER in rev-model.js takes it from there).
export function fingerRpm(v, scale) {
  return v >= scale.redFrom ? scale.max : Math.max(0, v)
}

// A press shorter than this that barely moved is a tap: a blip.
export const TAP_MS = 250
export const TAP_MOVE = 14 // picture units

export function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

// The arc's segments. A segment is red when most of it lies past the
// redline, which is where the engine's limiter actually lives.
export function segmentsFor(scale) {
  const step = 1000 / SEG_PER_1000
  const n = Math.round(scale.max / step)
  const out = []
  for (let i = 0; i < n; i++) {
    const from = i * step, to = from + step
    out.push({ i, from, to, angle: angleFor(from + step / 2, scale.max), red: from + step / 2 >= scale.redFrom })
  }
  return out
}

// How many segments a value lights: a segment lights once the value reaches
// its middle, so 0 lights none and max lights all.
export function litCount(v, segs) {
  if (!segs.length || !(v > 0)) return 0
  const step = segs[0].to - segs[0].from
  return Math.max(0, Math.min(segs.length, Math.floor(v / step + 0.5)))
}

// Segments to light. On the limiter the eased display sits a little under
// the redline, and the engine is never there long enough to catch up; so in
// the red zone the run reaches at least the first red segment, which is
// what makes the redline visibly light up.
export function shownLit(v, segs, z) {
  const n = litCount(v, segs)
  if (z !== 'red') return n
  const firstRed = segs.findIndex((x) => x.red)
  return firstRed < 0 ? n : Math.max(n, firstRed + 1)
}

// Colours. Hex in, hex out, so tests can read them.
function hex(c) { return [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)) }
export function mix(a, b, t) {
  const A = hex(a), B = hex(b), u = Math.min(1, Math.max(0, t))
  return '#' + A.map((x, k) => Math.round(x + (B[k] - x) * u).toString(16).padStart(2, '0')).join('')
}
// Lit segments warm from deep orange at 0 rpm to yellow at the current revs:
// the brightest segment is always the one under your foot.
export const LIT = [[0, '#ff4a1c'], [0.55, '#ff8a1a'], [0.88, '#ffb022'], [1, '#ffe466']]
export function litColor(t) {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0))
  for (let k = 1; k < LIT.length; k++) {
    if (u <= LIT[k][0]) return mix(LIT[k - 1][1], LIT[k][1], (u - LIT[k - 1][0]) / (LIT[k][0] - LIT[k - 1][0]))
  }
  return LIT[LIT.length - 1][1]
}

// A bar's lit segment count for a 0..1 fraction.
export function barLit(f, n) {
  if (!(f > 0)) return 0
  return Math.min(n, Math.round(Math.min(1, f) * n))
}

// Exponential follow: frame-rate independent, never overshoots.
export function follow(cur, target, dt, tau = 0.08) {
  if (!Number.isFinite(cur)) return target
  return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau))
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
// light, so the limiter (which cuts and recovers every ~100 ms) reads as one
// steady warning instead of a flicker.
export class ZoneLatch {
  constructor(hold = 0.3) { this.hold = hold; this.left = 0 }
  next(v, scale, dt) {
    this.left -= dt
    const z = zone(v, scale)
    if (z === 'red') { this.left = this.hold; return z }
    return this.left > 0 ? 'red' : z
  }
}

// ── DOM ───────────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg'
function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (parent) parent.appendChild(e)
  return e
}
function text(parent, x, y, cls, s) {
  const t = el('text', { x, y, class: cls }, parent)
  t.textContent = s
  return t
}

export const BAR_N = 36
const BARS = {
  load: { x: 118, y: 322, w: 214, lo: 'L', hi: 'H', caption: 'ENGINE LOAD' },
  gps:  { x: 668, y: 322, w: 214, lo: '0', hi: '1/s', caption: 'GPS READINGS' },
}
// Unlit arc segments run from warm brown to cool grey, as on the reference;
// day gets a pale version of the same.
const OFF = { night: ['#5a4434', '#3a3d43'], day: ['#e6d5c8', '#d3d7dd'] }

export class Cluster {
  // theme() returns 'night' or 'day'; checked every frame, so a theme change
  // repaints without the page having to tell us.
  constructor(host, { scale, theme = () => 'night' }) {
    this.theme = theme
    this.rpm = 0; this.rpmTarget = 0
    this.kmh = 0; this.kmhTarget = 0
    this.load = 0; this.loadTarget = 0
    this.gps = 0; this.gpsTarget = 0
    this.stale = false
    this.dt = 0
    this.rpmTau = 0.08
    this.touch = null // { onHold(rpm), onRelease(tap) } in simulation mode
    this.drag = null
    this.latch = new ZoneLatch()
    this.svg = el('svg', { viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, class: 'cluster-svg', role: 'img', 'aria-label': 'Engine speed and road speed' })
    host.appendChild(this.svg)
    this.build()
    this.setScale(scale)
    this.listen()
  }

  build() {
    const s = this.svg
    const defs = el('defs', {}, s)
    const bloom = el('radialGradient', { id: 'rv-bloom' }, defs)
    el('stop', { offset: '0', 'stop-color': '#ff9a2a', 'stop-opacity': '0.5' }, bloom)
    el('stop', { offset: '0.55', 'stop-color': '#ff7a1a', 'stop-opacity': '0.14' }, bloom)
    el('stop', { offset: '1', 'stop-color': '#ff7a1a', 'stop-opacity': '0' }, bloom)
    const tip = el('radialGradient', { id: 'rv-tip' }, defs)
    el('stop', { offset: '0', 'stop-color': '#ffd24a', 'stop-opacity': '0.65' }, tip)
    el('stop', { offset: '1', 'stop-color': '#ff9a1a', 'stop-opacity': '0' }, tip)
    const pill = el('linearGradient', { id: 'rv-pill', x1: '0', y1: '0', x2: '0', y2: '1' }, defs)
    el('stop', { offset: '0', 'stop-color': '#ffc35c' }, pill)
    el('stop', { offset: '1', 'stop-color': '#ff9a24' }, pill)
    // The filter region is the whole picture, in picture units: a region
    // relative to the path would clip the blur into a box when the lit run
    // is short.
    const blur = el('filter', { id: 'rv-blur', filterUnits: 'userSpaceOnUse', x: -100, y: -100, width: VIEW.w + 200, height: VIEW.h + 200 }, defs)
    el('feGaussianBlur', { stdDeviation: '9' }, blur)

    // Layers, back to front.
    el('ellipse', { cx: 500, cy: 262, rx: 300, ry: 150, fill: 'url(#rv-bloom)', class: 'rv-bloom' }, s)
    this.glow = el('path', { class: 'rv-glow', filter: 'url(#rv-blur)' }, s)
    this.tipGlow = el('circle', { r: 70, fill: 'url(#rv-tip)', class: 'rv-tipglow' }, s)
    // The band a finger can grab, shown faintly in simulation mode.
    this.hitBand = el('path', { class: 'rv-hit' }, s)
    this.segG = el('g', { class: 'rv-segs' }, s)
    this.scaleG = el('g', { class: 'rv-scale' }, s)
    this.finger = el('circle', { r: 34, class: 'rv-finger', style: 'display:none' }, s)

    // Speed pill.
    el('rect', { x: 372, y: 200, width: 256, height: 118, rx: 30, class: 'rv-pill', fill: 'url(#rv-pill)' }, s)
    this.speed = text(s, 500, 264, 'rv-speed', '0')
    text(s, 588, 305, 'rv-speed-unit', 'KM/H')
    // A small speedometer glyph, top right of the digits.
    const icon = el('g', { class: 'rv-icon', transform: 'translate(598 228)' }, s)
    el('path', { d: 'M-9 4 A10 10 0 1 1 9 4' }, icon)
    el('path', { d: 'M0 2 L5 -5' }, icon)
    this.simTag = text(s, 404, 229, 'rv-sim-tag', 'SIM')
    this.simTag.style.display = 'none'
    // Engine speed in digits, under the pill.
    this.rpmText = text(s, 500, 352, 'rv-rpm', '0')
    text(s, 500, 382, 'rv-rpm-unit', 'r/min')

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
    this.gear.textContent = 'N'; this.src.textContent = 'GPS'

    // Side bars.
    this.bars = {}
    for (const [k, b] of Object.entries(BARS)) {
      const g = el('g', { class: 'rv-bar rv-bar-' + k }, s)
      text(g, b.x - 16, b.y + 10, 'rv-bar-end', b.lo)
      text(g, b.x + b.w + 20, b.y + 10, 'rv-bar-end', b.hi)
      text(g, b.x + b.w / 2, b.y + 44, 'rv-bar-cap', b.caption)
      const segs = []
      const pitch = b.w / BAR_N
      for (let i = 0; i < BAR_N; i++) {
        segs.push(el('rect', { x: (b.x + i * pitch + pitch * 0.2).toFixed(2), y: b.y, width: (pitch * 0.55).toFixed(2), height: 18, rx: 1.2 }, g))
      }
      this.bars[k] = { segs, lit: -1, kind: k }
    }
  }

  setScale(scale) {
    this.scale = scale
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
    this.paint(true)
  }

  // Simulation mode: the arc becomes a control. onHold(rpm) is called as a
  // finger lands and moves on it, onRelease(tap) when it lifts; null turns
  // it back into a plain gauge.
  setTouch(handlers) {
    this.touch = handlers || null
    if (!this.touch) this.endDrag(false)
    this.rpmTau = this.touch ? 0.03 : 0.08
    if (this.touch) this.svg.setAttribute('data-sim', '')
    else this.svg.removeAttribute('data-sim')
    this.simTag.style.display = this.touch ? '' : 'none'
  }

  // Client (screen) coordinates to picture units.
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
      if (!p || !onArc(p[0], p[1])) return
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
      this.endDrag(performance.now() - d.t0 < TAP_MS && d.moved < TAP_MOVE)
    }
    svg.addEventListener('pointerup', end)
    svg.addEventListener('pointercancel', end)
    svg.addEventListener('lostpointercapture', end)
  }

  hold([x, y]) {
    const v = valueAt(x, y, this.scale.max)
    const [fx, fy] = polar(ARC.cx, ARC.cy, (ARC.rOut + ARC.rIn) / 2, angleFor(v, this.scale.max))
    this.finger.setAttribute('cx', fx.toFixed(1)); this.finger.setAttribute('cy', fy.toFixed(1))
    this.finger.style.display = ''
    this.finger.classList.toggle('red', v >= this.scale.redFrom)
    if (this.touch) this.touch.onHold(fingerRpm(v, this.scale))
  }

  endDrag(tap) {
    if (!this.drag) return
    this.drag = null
    this.finger.style.display = 'none'
    if (this.touch) this.touch.onRelease(tap)
  }

  // State from the engine. rpm 0 means the engine is off.
  set({ rpm, kmh, gear, source, load, fixRate, stale }) {
    if (Number.isFinite(rpm)) this.rpmTarget = Math.max(0, rpm)
    if (Number.isFinite(kmh)) this.kmhTarget = Math.max(0, kmh)
    if (Number.isFinite(load)) this.loadTarget = Math.max(0, Math.min(1, load))
    // A full bar is one reading a second, the rate the car is expected to
    // manage while moving.
    if (Number.isFinite(fixRate)) this.gpsTarget = Math.max(0, Math.min(1, fixRate))
    this.stale = !!stale
    if (gear != null && this.gear.textContent !== gear) this.gear.textContent = gear
    if (source != null && this.src.textContent !== source) this.src.textContent = source
  }

  frame(dt) {
    this.dt += dt
    this.rpm = follow(this.rpm, this.rpmTarget, dt, this.rpmTau)
    this.kmh = follow(this.kmh, this.kmhTarget, dt, 0.15)
    this.load = follow(this.load, this.loadTarget, dt, 0.12)
    this.gps = follow(this.gps, this.gpsTarget, dt, 0.3)
    this.paint(false)
  }

  paint(force) {
    const theme = this.theme()
    if (theme !== this.lastTheme) { this.lastTheme = theme; force = true }
    const off = OFF[theme] || OFF.night
    const n = this.segs.length
    // The colour follows the engine, not the eased display: a shift light
    // that waits for the animation is late.
    const z = this.latch.next(Math.max(this.rpm, this.rpmTarget), this.scale, this.dt)
    this.dt = 0
    if (z !== this.zone) { this.zone = z; this.svg.setAttribute('data-zone', z) }
    const lit = shownLit(this.rpm, this.segs, z)
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
    if (this.rpm > 1) {
      const a = angleFor(this.rpm, this.scale.max)
      const [x0, y0] = polar(cx, cy, rMid, ARC.a0)
      const [x1, y1] = polar(cx, cy, rMid, a)
      this.glow.setAttribute('d', `M${x0.toFixed(1)} ${y0.toFixed(1)}A${rMid} ${rMid} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`)
      this.tipGlow.setAttribute('cx', x1.toFixed(1)); this.tipGlow.setAttribute('cy', y1.toFixed(1))
      this.tipGlow.style.display = ''
    } else {
      this.glow.setAttribute('d', '')
      this.tipGlow.style.display = 'none'
    }
    const sp = this.stale ? '––' : String(Math.round(this.kmh))
    if (this.speed.textContent !== sp) this.speed.textContent = sp
    // Digits to the nearest 10, like a digital tach, so they don't blur.
    const rt = String(Math.round(this.rpm / 10) * 10)
    if (this.rpmText.textContent !== rt) this.rpmText.textContent = rt

    this.paintBar(this.bars.load, this.load, force)
    this.paintBar(this.bars.gps, this.gps, force)
  }

  paintBar(bar, f, force) {
    const lit = barLit(f, BAR_N)
    if (lit === bar.lit && !force) return
    bar.lit = lit
    bar.segs.forEach((e, i) => {
      const on = i < lit
      const t = i / (BAR_N - 1)
      e.classList.toggle('on', on)
      // Load warms toward red at the top; GPS readings are red when there
      // are too few, like a fuel gauge near empty.
      const red = on && (bar.kind === 'load' ? t > 0.85 : t < 0.15)
      e.classList.toggle('red', red)
      e.style.fill = on && !red ? litColor(bar.kind === 'load' ? 0.2 + t * 0.75 : 0.35 + t * 0.6) : ''
    })
  }
}
