// Round gauges for the engine sound page: a tachometer and a speedometer.
// Plain SVG, no library. The geometry (scales, angles, arcs, ticks, easing)
// is pure and exported for `node --test` (test/rev-gauge.test.mjs); the Dial
// class is the only part that needs a DOM.
//
// Both dials sweep 270° clockwise, from bottom-left (135°) to bottom-right
// (405°), with angles in SVG's convention: degrees from +x, clockwise,
// because y points down.

export const START = 135
export const SWEEP = 270

// Tachometer scale for an engine: whole thousands, with at least 500 rpm of
// red zone visible past the redline, so the needle never pins against the end
// stop at the limiter.
export function tachScale(redline, idle = 0) {
  const max = Math.ceil((redline + 500) / 1000) * 1000
  return { max, major: 1000, minor: 500, labelEvery: 1000, label: (v) => String(v / 1000),
    redFrom: redline, warnFrom: Math.max(idle, redline - 700), unit: 'rpm' }
}

// Speedometer scale in km/h. Fixed rather than per-car, so the same speed is
// always at the same place on the dial.
export function speedScale(max = 240) {
  return { max, major: 20, minor: 10, labelEvery: 40, label: (v) => String(v),
    redFrom: null, warnFrom: null, unit: 'km/h' }
}

export function valueToAngle(v, max) {
  const f = max > 0 && Number.isFinite(v) ? Math.min(1, Math.max(0, v / max)) : 0
  return START + f * SWEEP
}

export function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

// SVG path for a clockwise arc from angle a0 to a1. An empty string for a
// zero-length arc: a path with identical end points draws a dot, not nothing.
export function arcPath(cx, cy, r, a0, a1) {
  if (!(a1 - a0 > 0.01)) return ''
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = a1 - a0 > 180 ? 1 : 0
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

// Every minor step, flagged major and labelled where the scale says so.
export function ticks(scale) {
  const out = []
  const n = Math.round(scale.max / scale.minor)
  for (let i = 0; i <= n; i++) {
    const v = i * scale.minor
    const major = v % scale.major === 0
    out.push({ v, major, label: v % scale.labelEvery === 0 ? scale.label(v) : null })
  }
  return out
}

// Exponential follow: frame-rate independent, never overshoots. tau is the
// time constant in seconds; ~80 ms reads as smooth without visible lag.
export function follow(cur, target, dt, tau = 0.08) {
  if (!Number.isFinite(cur)) return target
  return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau))
}

// Which band a value sits in, for colouring the arc and the readout. The
// limiter bounces the engine a few percent under the redline, and that
// bounce is the most "at the redline" an engine gets, so it counts as red.
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

const NS = 'http://www.w3.org/2000/svg'
const C = 100, R = 84 // centre and track radius in a 200×200 viewBox

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (parent) parent.appendChild(e)
  return e
}

// One dial. Colours come from CSS custom properties on the page (--g-*), so
// the day and night themes are the page's business, not the dial's.
export class Dial {
  constructor(host, { scale, label, format = (v) => String(Math.round(v)) }) {
    this.format = format
    this.value = 0
    this.target = 0
    this.svg = el('svg', { viewBox: '0 0 200 200', class: 'dial', role: 'img', 'aria-label': label })
    host.appendChild(this.svg)
    this.setScale(scale)
  }

  setScale(scale) {
    this.scale = scale
    const s = this.svg
    while (s.firstChild) s.removeChild(s.firstChild)
    const end = START + SWEEP

    el('path', { d: arcPath(C, C, R, START, end), class: 'g-track' }, s)
    if (scale.redFrom != null) {
      el('path', { d: arcPath(C, C, R, valueToAngle(scale.redFrom, scale.max), end), class: 'g-redzone' }, s)
    }
    this.glow = el('path', { class: 'g-glow' }, s)
    this.arc = el('path', { class: 'g-arc' }, s)

    for (const t of ticks(scale)) {
      const a = valueToAngle(t.v, scale.max)
      const red = scale.redFrom != null && t.v >= scale.redFrom
      const [x0, y0] = polar(C, C, t.major ? 64 : 69, a)
      const [x1, y1] = polar(C, C, 74, a)
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: (t.major ? 'g-tick major' : 'g-tick') + (red ? ' red' : '') }, s)
      if (t.label != null) {
        const [lx, ly] = polar(C, C, 55, a)
        const txt = el('text', { x: lx, y: ly, class: 'g-label' + (red ? ' red' : '') }, s)
        txt.textContent = t.label
      }
    }

    // A short pointer across the arc rather than a needle from the hub, so
    // the centre stays clear for the number you actually read.
    this.needle = el('line', { x1: C + 60, y1: C, x2: C + 95, y2: C, class: 'g-needle' }, s)
    this.readout = el('text', { x: C, y: C + 12, class: 'g-value' }, s)
    this.unit = el('text', { x: C, y: C + 30, class: 'g-unit' }, s)
    this.unit.textContent = scale.unit
    this.badge = el('g', { class: 'g-badge' }, s)
    el('rect', { x: C - 20, y: C + 42, width: 40, height: 26, rx: 8 }, this.badge)
    this.badgeText = el('text', { x: C, y: C + 55 }, this.badge)
    this.badge.style.display = 'none'
    this.lastZone = null
    this.latch = new ZoneLatch()
    this.dt = 0
    this.draw()
  }

  set(v) { this.target = Number.isFinite(v) ? Math.max(0, v) : 0 }

  // Text under the readout, e.g. the gear. null hides it.
  setBadge(text) {
    if (text == null) { this.badge.style.display = 'none'; return }
    this.badge.style.display = ''
    if (this.badgeText.textContent !== text) this.badgeText.textContent = text
  }

  // Advance the animation by dt seconds. Returns true while still moving.
  frame(dt) {
    this.dt = dt
    const prev = this.value
    this.value = follow(this.value, this.target, dt)
    if (Math.abs(this.value - this.target) < this.scale.max * 1e-4) this.value = this.target
    this.draw()
    return this.value !== prev
  }

  draw() {
    const { scale } = this
    const a = valueToAngle(this.value, scale.max)
    const d = arcPath(C, C, R, START, a)
    this.arc.setAttribute('d', d)
    this.glow.setAttribute('d', d)
    this.needle.setAttribute('transform', `rotate(${a.toFixed(2)} ${C} ${C})`)
    // The colour follows the engine, not the eased needle: a shift light
    // that waits for the animation is late.
    const z = this.latch.next(Math.max(this.value, this.target), scale, this.dt)
    this.dt = 0
    if (z !== this.lastZone) { this.svg.setAttribute('data-zone', z); this.lastZone = z }
    const txt = this.format(this.value)
    if (this.readout.textContent !== txt) this.readout.textContent = txt
  }
}
