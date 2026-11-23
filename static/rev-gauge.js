// The segment-arc cluster's geometry and colours (static/gauges/segment.js
// draws it), and clusterInput, which every gauge style is fed through.
// Pure, for `node --test` (test/rev-gauge.test.mjs).
//
// Angles are SVG's convention: degrees from +x, clockwise, y down, so 270°
// is straight up. The tach is a shallow arc of a large circle whose centre
// sits well below the picture.

export const VIEW = { w: 1000, h: 400 }
export const ARC = { cx: 500, cy: 700, rOut: 640, rIn: 590, a0: 232, a1: 308 }
export const SEG_PER_1000 = 6

import { tachScale, polar, mix, follow, zone, ZoneLatch, RED_SLACK } from './gauges/kit.js'
export { tachScale, polar, mix, follow, zone, ZoneLatch, RED_SLACK }

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

// What the cluster shows for an engine state from RevSound (rev-sound.js).
// Engine off reads 0, like a real cluster with the ignition off; parked
// reads N; the source chip says where the speed comes from.
export function clusterInput(s) {
  return {
    running: !!s.running,
    rpm: s.running ? s.rpm : 0,
    kmh: (s.v || 0) * 3.6,
    gear: !s.running ? '\u2013' : s.stopped ? 'N' : String(s.gear),
    source: s.sim ? 'SIM' : s.source === 'sim' ? 'TEST' : 'GPS',
    load: s.running ? s.load : 0,
    fixRate: s.fixRate || 0,
    stale: !!(s.running && s.source === 'gps' && s.stale && !s.sim),
  }
}

// The side bars' segment count (segment.js).
export const BAR_N = 36
