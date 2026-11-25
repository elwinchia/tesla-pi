#!/usr/bin/env node
// Build the recorded engine loops in static/sounds/ from their sources.
//
//   node scripts/rev-samples.mjs            # build every loop
//   node scripts/rev-samples.mjs --car v8   # one car
//
// Every loop is described in static/rev-samples.js: which recording, where in
// it, how long, and the rpm it was recorded at. This script fetches each
// recording from the address recorded in its credit (the Freesound preview of
// that exact sound page; nothing else is ever downloaded), cuts the stretch,
// makes it loop seamlessly, levels it, and encodes it as Ogg Opus.
//
// It needs `ffmpeg` and `curl` on the machine building the files. The car
// needs neither: it plays the .ogg files with its own browser.
//
// engine-sim sets (kind: 'engine-sim') are cut from our own renders instead,
// in .cache/engine-sim/out/<set.renders>/: run scripts/engine-sim/build.sh
// and scripts/engine-sim/render-set.sh first (see scripts/engine-sim/README.md).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SETS, CREDITS, loopSeconds, PAD_SECONDS, extrasPlan, LONG_SECONDS, SHIFT } from '../static/rev-samples.js'
import { PROFILES } from '../static/rev-profiles.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'static', 'sounds')
const CACHE = path.join(ROOT, '.cache', 'rev-samples')
const SR = 48000
const args = process.argv.slice(2)
const only = args.includes('--car') ? args[args.indexOf('--car') + 1] : null

// The recording, fetched once from the address in its credit.
function source(id) {
  const c = CREDITS[id]
  if (!c) throw new Error(`no credit for ${id}`)
  const file = path.join(CACHE, id + path.extname(new URL(c.audio).pathname))
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true })
    console.log(`fetching ${c.audio}`)
    execFileSync('curl', ['-4', '-sSfL', '--retry', '3', '-o', file + '.part', c.audio], { stdio: 'inherit' })
    fs.renameSync(file + '.part', file)
  }
  return file
}

function decode(file, start, seconds) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(seconds), '-i', file,
    '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length))
}

// RBJ shelving filter: { type: 'lowshelf' | 'highshelf', hz, db }, shelf
// slope 1. Applied to a whole buffer in place.
export function shelf(x, sr, { type, hz, db }) {
  const A = Math.pow(10, db / 40), w = 2 * Math.PI * hz / sr, c = Math.cos(w), sn = Math.sin(w)
  const alpha = sn / 2 * Math.SQRT2, k = 2 * Math.sqrt(A) * alpha
  let b0, b1, b2, a0, a1, a2
  if (type === 'lowshelf') {
    b0 = A * ((A + 1) - (A - 1) * c + k); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - k)
    a0 = (A + 1) + (A - 1) * c + k; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - k
  } else if (type === 'highshelf') {
    b0 = A * ((A + 1) + (A - 1) * c + k); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - k)
    a0 = (A + 1) - (A - 1) * c + k; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - k
  } else throw new Error('unknown filter ' + type)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
    x[i] = y0
  }
  return x
}

// RBJ low-pass, Butterworth Q; run twice for 24 dB/octave.
export function lowpass(x, sr, hz) {
  const w = 2 * Math.PI * hz / sr, c = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha, b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i], y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
    x[i] = y0
  }
  return x
}

// Decode a loop's stretch with a set's EQ applied. The filters run from
// WARM seconds earlier, so they have settled before the stretch begins
// (a cold start would leave a step at the seam).
const WARM = 0.3
function decodeEq(file, start, seconds, eq) {
  if (!eq || !eq.length) return decode(file, start, seconds)
  const pre = Math.min(WARM, start)
  const x = decode(file, start - pre, seconds + pre)
  for (const f of eq) shelf(x, SR, f)
  return x.slice(Math.round(pre * SR))
}

// The stretch a loop is cut from. For an engine-sim set with `sub`, the
// same simulation rendered dry (no exhaust impulse response) is low-passed
// and mixed under it: the impulse response that gives the main render its
// body also strips the lowest octave, and the dry render still has the
// engine's own firing pulse there. The sub layer's RMS is `sub.level` x the
// main stretch's, so every loop gets the same share.
function stretchFor(set, loop, seconds) {
  const main = decodeEq(renderFile(set, loop), loop.start, seconds, set.eq)
  if (!set.sub) return main
  const pre = Math.min(WARM, loop.start)
  const subFile = renderFile({ renders: set.sub.renders }, loop)
  const sub = decode(subFile, loop.start - pre, seconds + pre)
  lowpass(sub, SR, set.sub.lowpass); lowpass(sub, SR, set.sub.lowpass)
  const s2 = sub.slice(Math.round(pre * SR), Math.round(pre * SR) + main.length)
  const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) || 1
  const g = set.sub.level * rms(main) / rms(s2)
  for (let i = 0; i < main.length; i++) main[i] += g * (s2[i] || 0)
  return main
}

// A seamless loop of `len` samples: the stretch after the loop's end is
// faded into its start with equal power, so the last sample runs straight
// on into the first.
export function makeLoop(seg, len, fade) {
  if (seg.length < len + fade) throw new Error('segment too short for the loop and its crossfade')
  const out = seg.slice(0, len)
  for (let i = 0; i < fade; i++) {
    const t = (i + 0.5) / fade
    out[i] = seg[i] * Math.sin(t * Math.PI / 2) + seg[len + i] * Math.cos(t * Math.PI / 2)
  }
  return out
}

function level(x, target) {
  // Remove DC and rumble below ~25 Hz, then set the RMS.
  // The filter is warmed up on the loop itself first, as if it had already
  // been playing round: started cold, it would leave a step at the seam.
  let lp = 0
  const a = 1 - Math.exp(-2 * Math.PI * 25 / SR)
  for (let i = 0; i < x.length; i++) lp += (x[i] - lp) * a
  for (let i = 0; i < x.length; i++) { lp += (x[i] - lp) * a; x[i] -= lp }
  const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)
  let g = target / (rms || 1)
  const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  g = Math.min(g, 0.95 / (peak || 1))
  for (let i = 0; i < x.length; i++) x[i] *= g
  return x
}

function wav(file, x) {
  const pcm = Buffer.alloc(x.length * 2)
  for (let i = 0; i < x.length; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, pcm]))
}

// Ogg Opus, mono, with the credit in its comment.
function encode(tmp, dest, bitrate, src) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-c:a', 'libopus', '-b:a', bitrate, '-ac', '1', '-ar', String(SR),
    '-map_metadata', '-1', '-metadata', `comment=${CREDITS[src].title} by ${CREDITS[src].author}, ${CREDITS[src].licence}, ${CREDITS[src].url}`, dest])
}

// ── Levelling the options' loops ──
const isOpt = (l) => (Array.isArray(l.opt) ? l.opt.length > 0 : !!l.opt)
// The RMS an option's loop should have, as decoded. A long loop matches its
// short twin as the car hears it (the short file, decoded: a set's own
// loop may have been held under its level by level()'s peak cap); any
// other, 0.25 x its level, as level() gives an uncapped loop.
function optTarget(loop) {
  if (loop.file.endsWith('-long.ogg')) {
    const short = path.join(OUT, loop.file.replace(/-long\.ogg$/, '.ogg'))
    if (!fs.existsSync(short)) throw new Error(`${short} is missing: build the short loops first`)
    const x = decodeAll(short), a = Math.round(PAD_SECONDS * SR)
    return rmsOf(x, a, x.length - a)
  }
  return 0.25 * loop.level
}
// A soft ceiling instead of level()'s peak cap: a loop with a higher peak
// than its twin would otherwise come out quieter. Above `knee` the peaks
// are rounded off towards `top`; below it nothing changes.
export function ceiling(x, knee = 0.9, top = 0.99) {
  const k = top - knee
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i])
    if (a > knee) x[i] = Math.sign(x[i]) * (knee + k * Math.tanh((a - knee) / k))
  }
  return x
}
// As level(), with the ceiling for the cap.
function levelOpt(x, target) {
  let lp = 0
  const a = 1 - Math.exp(-2 * Math.PI * 25 / SR)
  for (let i = 0; i < x.length; i++) lp += (x[i] - lp) * a
  for (let i = 0; i < x.length; i++) { lp += (x[i] - lp) * a; x[i] -= lp }
  const g = target / (rmsOf(x) || 1)
  for (let i = 0; i < x.length; i++) x[i] *= g
  return ceiling(x)
}
// Encode, decode, and scale until the decoded RMS over [a, b) is `target`
// within 0.05 dB: Opus at 40 kbit/s loses up to ~0.8 dB of a busy loop's
// energy, at 64 kbit/s (the set's own loops) under 0.1 dB.
function encodeMatched(x, tmp, dest, bitrate, src, [a, b], target) {
  let y = x
  for (let pass = 0; pass < 4; pass++) {
    wav(tmp, y)
    encode(tmp, dest, bitrate, src)
    const d = decodeAll(dest)
    const got = rmsOf(d, a, Math.min(b, d.length))
    const err = 20 * Math.log10(got / target)
    if (Math.abs(err) < 0.05) return err
    y = Float32Array.from(y, (v) => v * (target / got))
    ceiling(y)
  }
  return null
}

// An engine-sim set's rendered WAV for one loop.
function renderFile(set, loop) {
  const dir = typeof set.renders === 'string' ? set.renders : set.renders[loop.group || 'engine']
  const f = path.join(ROOT, '.cache', 'engine-sim', 'out', dir, loop.render + '.wav')
  if (!fs.existsSync(f)) throw new Error(`${f} is missing: render it with scripts/engine-sim/render-set.sh (see scripts/engine-sim/README.md)`)
  return f
}

// static/sounds/CREDITS.md, from the same data the page and tests use.
function credits() {
  const recordings = Object.values(CREDITS).some((c) => c.kind !== 'render')
  const lines = ['# Engine sound credits', '']
  if (recordings) lines.push(
    'Some loops in this folder are cut from recordings. They are **not** covered',
    "by this repository's BSD licence: each keeps its own licence, as listed. Each",
    'was recorded and uploaded to Freesound by the person named, and is used under',
    'CC0 or CC BY (credit given here and on `rev.html` next to the car it is used',
    "for), from the 128 kbit/s MP3 preview on the sound's own page.", '')
  lines.push(
    'The `*-es-*` loops are our own renders, made with engine-sim (MIT) from its',
    'bundled engine scripts; engine-sim is credited below all the same. They are',
    'rendered with `scripts/engine-sim/`, then cut, made to loop by crossfading',
    'each end into its start, equalised and given a low-passed dry sub layer where',
    '`static/rev-samples.js` says so, filtered below 25 Hz, levelled and encoded as',
    'Ogg Opus by `scripts/rev-samples.mjs`. The `*-start` and `*-stop` clips are',
    'renders of the engine starting and stopping (`render-oneshots.sh`); the',
    "start's cranking is mixed with a starter motor we synthesise",
    '(`--oneshots`). The optional extras (`*-long`, `*-part-*`, `*-limiter*`,',
    '`*-shift-*` and the rev points between the others) are renders of the',
    'same engines held longer, at light throttle, on the rev limiter and',
    'through an upshift (`render-extras.sh`), cut and levelled the same way.', '')
  for (const [id, c] of Object.entries(CREDITS)) {
    const used = [...new Set(Object.entries(SAMPLE_SETS).flatMap(([car, set]) => [
      ...set.loops.filter((l) => l.src === id).map((l) => `\`${l.file}\` (${car}, ${l.rpm} rpm${l.layer && l.layer !== 'any' ? ', ' + l.layer : ''})`),
      ...(c.kind === 'render' && set.oneshots ? ['start', 'stop'].flatMap((k) => ['engine', 'exhaust'].map((g) => `\`${set.oneshots[k][g]}\` (${car}, ${k})`)) : []),
    ]))]
    if (c.kind === 'render') {
      lines.push(`## ${c.title} by ${c.author}`, '',
        `- What: ${c.recording}`,
        `- Source: ${c.url} at commit ${c.commit}`,
        `- Engine scripts: ${c.engineScripts.map((x) => '`' + x + '`').join(', ')}`,
        `- Author: ${c.author}`,
        `- Licence: [${c.licence}](${c.licenceUrl})`,
        `- Used for: ${used.join(', ')}`, '')
      continue
    }
    lines.push(`## "${c.title}" by ${c.author}`, '',
      `- Recording: ${c.recording}`,
      `- Page: ${c.url}`,
      `- Author: ${c.author}`,
      `- Licence: [${c.licence}](${c.licenceUrl})`,
      `- File fetched: ${c.audio} on ${c.fetched}`,
      `- Used for: ${used.join(', ')}`, '')
  }
  return lines.join('\n')
}

// --fit-idle <car>: where to cut an engine-sim set's idle loops. A free-
// running idle never sits exactly at the rpm asked for, and wanders a
// little, so a loop rounded to whole cycles at the nominal rpm wraps part
// of a firing out of step: the crossfade then blends two out-of-step
// firings, a dip and a stumble every lap. This measures the idle's real rpm
// (its 720° cycle, by autocorrelation of the dry render), then for each
// group finds the loop length where both what is heard (its own render)
// and the dry sub layer mixed under it repeat best over the crossfade.
// Paste the result into the set's `idle` in static/rev-samples.js.
function fitIdle(car, { start = 1.0, seconds = 5.5, range = 1.0 } = {}) {
  const set = SAMPLE_SETS[car]
  const prep = (file) => {
    const x = decode(file, start, seconds + range + 0.5)
    for (let i = x.length - 1; i > 0; i--) x[i] -= 0.995 * x[i - 1] // drop DC
    // Match the firing pulses, not the combustion noise riding on them.
    lowpass(x, SR, 300); lowpass(x, SR, 300)
    return x
  }
  const corr = (x, a, b, n) => {
    let ab = 0, aa = 0, bb = 0
    for (let i = 0; i < n; i++) { ab += x[a + i] * x[b + i]; aa += x[a + i] ** 2; bb += x[b + i] ** 2 }
    return ab / Math.sqrt(aa * bb || 1)
  }
  const idle = set.loops.find((l) => l.render === 'idle')
  const dry = prep(renderFile({ renders: set.sub.renders }, idle))
  // The engine's cycle: the best self-match within ±12 % of the nominal one
  // (wider finds a flat-6's five-firing lag instead).
  const nominal = 120 / PROFILES[car].idle, W = Math.round(1.5 * SR)
  let cyc = 0, best = -2
  for (let L = Math.round(nominal * 0.88 * SR); L <= Math.round(nominal * 1.12 * SR); L++) {
    const c = corr(dry, 0, L, W)
    if (c > best) { best = c; cyc = L }
  }
  const out = { rpm: Math.round((120 * SR) / cyc), start, seconds: {} }
  const F = Math.round(0.12 * SR), lo = Math.round((seconds - range) * SR), hi = Math.round((seconds + range) * SR)
  const notes = []
  for (const group of Object.keys(set.renders)) {
    const main = prep(renderFile(set, { ...idle, group }))
    let len = lo, score = -2
    for (let L = lo; L <= hi; L++) {
      const c = Math.min(corr(main, 0, L, F), corr(dry, 0, L, F))
      if (c > score) { score = c; len = L }
    }
    out.seconds[group] = Math.round((len / SR) * 1e5) / 1e5
    notes.push(`${group} seam ${score.toFixed(2)}`)
  }
  console.log(`${car}: idle: ${JSON.stringify(out).replace(/"/g, '')},  (cycle match ${best.toFixed(2)}; ${notes.join(', ')})`)
  return out
}

// --print-levels <car>: an engine-sim set's `level` for every loop, from its
// renders with its EQ: each loop's RMS over the loudest on-load loop's,
// square-rooted so overrun and idle stay audible; idle at 0.6 x the lowest
// on-load loop. Paste them into static/rev-samples.js.
//
// The options' loops (rev-samples.js) are put on the same scale, from the
// same reference (the group's loudest own on-load loop) and the same top:
//   dense    each point smoothed with its two neighbours, the set's own
//            points either side (3-point geometric mean, as the set's own)
//   part     smoothed along the set's own points, and the dense ones with
//            their neighbours, as above
//   limiter  its loop as it is
//   shifts   the on-load level at the clip's `from` (interpolated in log
//            rpm between the points either side, dense ones included): the
//            clip is levelled so the full load before its cut is exactly
//            that loud, and the cut keeps its own depth
// Long loops have their short twin's level (each loop's RMS is set to it).
// --json prints the options' levels as one JSON line per group instead.
function printLevels(car, json = false) {
  const set = SAMPLE_SETS[car], plan = extrasPlan(set)
  const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
  const own = (l) => !(Array.isArray(l.opt) ? l.opt.length : l.opt)
  const out = {}
  // Each group is levelled on its own: at either end of the Exhaust
  // setting the engine is equally loud.
  for (const group of [...new Set(set.loops.map((l) => l.group || 'engine'))]) {
    const loops = set.loops.filter((l) => (l.group || 'engine') === group && own(l))
    const r = {}
    for (const l of loops) r[l.render] ??= rms(stretchFor(set, l, l.seconds))
    const on = loops.filter((l) => l.layer === 'on' && l.render !== 'idle').sort((a, b) => a.rpm - b.rpm)
    const ref = Math.max(...on.map((l) => r[l.render]))
    // A render's raw level: the RMS of its stretch, over the reference.
    const rawOf = (render, start = 0.4, seconds = 1.5) => {
      if (!(render in r)) {
        try { r[render] = rms(stretchFor(set, { group, render, start, seconds }, seconds)) } catch { r[render] = null }
      }
      return r[render] == null ? null : Math.sqrt(r[render] / ref)
    }
    const raw = (k) => Math.sqrt(r[k] / ref)
    // Resonances in a simulation can make one rev point several dB louder
    // than its neighbours, which pumps as you rev. Each layer is smoothed
    // across rpm with a 3-point geometric mean, keeping the overall rise.
    const smooth = (xs) => xs.map((x, i) => Math.cbrt((xs[i - 1] ?? x) * x * (xs[i + 1] ?? x)))
    const onL = smooth(on.map((l) => raw(l.render))), offL = smooth(on.map((l) => raw(`off-${l.rpm}`)))
    const top = Math.max(...onL)
    const q = (x) => Math.round((x / top) * 1000) / 1000
    if (!json) {
      console.log(`${group}: idle`, q(0.6 * onL[0]))
      console.log('  [' + on.map((l, i) => `[${l.rpm}, ${q(onL[i])}, ${q(offL[i])}]`).join(', ') + ']')
    }
    const g = (out[group] = {})
    const pts = plan.points
    // A dense point between own points i and i+1, smoothed with them.
    const mid = (layerRaw, i, m) => {
      const x = layerRaw(m), a = layerRaw(pts[i]), b = layerRaw(pts[i + 1])
      return x == null || a == null || b == null ? null : q(Math.cbrt(a * x * b))
    }
    const onRaw = (rpm) => rawOf(`on-${rpm}`), offRaw = (rpm) => rawOf(`off-${rpm}`)
    g.dense = plan.dense.map((m, i) => [m, mid(onRaw, i, m), mid(offRaw, i, m)])
    if (g.dense.some(([, a, b]) => a == null || b == null)) g.dense = null
    if (set.part) {
      const pRaw = (rpm) => rawOf(`part-${rpm}`)
      const ownP = pts.map(pRaw)
      if (ownP.every((x) => x != null)) {
        const sm = smooth(ownP).map(q)
        g.part = [...pts.map((rpm, i) => [rpm, sm[i]]), ...plan.dense.map((m, i) => [m, mid(pRaw, i, m)])].sort((a, b) => a[0] - b[0])
        if (g.part.some(([, l]) => l == null)) g.part = null
        // Never louder than full throttle at the same rpm: near the redline
        // the flat-6 is up to 6 dB louder at light throttle than at full in
        // engine-sim, which would make easing off sound like pulling harder.
        else {
          const full = new Map([...on.map((l, i) => [l.rpm, q(onL[i])]), ...(g.dense || []).map(([m, a]) => [m, a])])
          g.part = g.part.map(([rpm, l]) => [rpm, Math.min(l, full.get(rpm))])
        }
      }
    }
    const lim = set.limiter?.[group]
    if (lim) g.limiter = q(rawOf('limiter', lim.start, lim.seconds))
    // The on-load level at any rpm, from the own and dense points.
    const curve = [...on.map((l, i) => [l.rpm, q(onL[i])]), ...(g.dense || []).map(([m, a]) => [m, a])].sort((a, b) => a[0] - b[0])
    const onAt = (rpm) => {
      if (rpm <= curve[0][0]) return curve[0][1]
      for (let i = 1; i < curve.length; i++) {
        if (rpm <= curve[i][0]) {
          const t = Math.log(rpm / curve[i - 1][0]) / Math.log(curve[i][0] / curve[i - 1][0])
          return Math.round(Math.exp(Math.log(curve[i - 1][1]) * (1 - t) + Math.log(curve[i][1]) * t) * 1000) / 1000
        }
      }
      return curve[curve.length - 1][1]
    }
    g.shifts = plan.shifts.map(({ from }) => [from, onAt(from)])
    g.shiftsTo = plan.shifts.map(({ to }) => [to, onAt(to)])
    // How alike the engine and exhaust renders of the limiter and each
    // shift are, played together in step (the player mixes them for it).
    if (group === 'engine') {
      const rho = (a, b) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i] } return Math.round((ab / Math.sqrt(aa * bb || 1)) * 100) / 100 }
      const both = (l) => ['engine', 'exhaust'].map((gr) => { const x = stretchFor(set, { ...l, group: gr }, l.seconds); derumble(x); return x })
      if (lim) g.limiterCorr = rho(...both({ render: 'limiter', start: lim.start, seconds: lim.seconds }))
      g.shiftCorr = plan.shifts.map(({ from }) => { try { return rho(...both({ render: `shift-${from}`, start: SHIFT.renderAt - SHIFT.at, seconds: SHIFT.seconds })) } catch { return null } })
    }
    if (json) console.log(JSON.stringify({ car, group, ...g }))
    else {
      if (g.dense) console.log('  dense: ' + JSON.stringify(g.dense))
      if (g.part) console.log('  part: ' + JSON.stringify(g.part))
      if (g.limiter) console.log('  limiter: ' + g.limiter)
      console.log('  shifts: ' + JSON.stringify(g.shifts))
    }
  }
  return out
}

// ── Start and stop ───────────────────────────────────────────────────────
// --oneshots [car]: each car's engine start and stop, from the renders of
// scripts/engine-sim/render-oneshots.sh, heard the same two ways as its
// loops (engine, exhaust) with the same EQ and dry sub layer, levelled so
// the clip's idle is exactly as loud as the car's idle loop: the player
// hands over from one to the other.
//
// The start: engine-sim models combustion and the exhaust, not the starter
// motor, and its cranking is 35-40 dB under its idle. So the cranking is
// taken from the render made 33x louder (start-hi.wav, the same run), set
// to CHUFF x the idle, and a starter motor is synthesised over it: the
// solenoid's clunk, the motor's whine labouring at each compression, a
// little gear grind, and the clunk as it lets go when the engine catches.
// The flare after the catch is held to FLARE_CAP x the idle: the loops'
// own levels are square-rooted (rev-samples.js), and an unsquashed flare
// would be ten times louder than anything else the engine does. And as the
// revs fall back from the flare, closed throttle, engine-sim goes as quiet
// as its overrun; that is lifted to FALL_FLOOR x the idle, as the loops'
// overrun is (their levels are square-rooted too).
const CHUFF = 0.3, STARTER = 0.55, FLARE_CAP = 2.6, FALL_FLOOR = 0.6
const HI_GAIN = 0.2 / 0.006 // render-oneshots.sh's two gains

function rmsOf(x, a = 0, b = x.length) {
  let s = 0
  for (let i = a; i < b; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, b - a))
}
// The same rumble filter as level(), from cold: these clips start silent.
function derumble(x) {
  let lp = 0
  const a = 1 - Math.exp(-2 * Math.PI * 25 / SR)
  for (let i = 0; i < x.length; i++) { lp += (x[i] - lp) * a; x[i] -= lp }
  return x
}
function decodeAll(file) { return decode(file, 0, 100) }
function eqd(file, eq) { const x = decodeAll(file); for (const f of eq || []) shelf(x, SR, f); return x }
// The main render with its EQ and the dry sub layer, the sub's share
// measured where the engine idles (from a to b).
function oneshotMix(set, group, name, a, b) {
  const main = eqd(path.join(ROOT, '.cache', 'engine-sim', 'out', set.renders[group], name + '.wav'), set.eq)
  if (!set.sub) return main
  const sub = decodeAll(path.join(ROOT, '.cache', 'engine-sim', 'out', set.sub.renders, name + '.wav'))
  lowpass(sub, SR, set.sub.lowpass); lowpass(sub, SR, set.sub.lowpass)
  const g = set.sub.level * rmsOf(main, a, b) / (rmsOf(sub, a, b) || 1)
  for (let i = 0; i < main.length; i++) main[i] += g * (sub[i] || 0)
  return main
}

// A small deterministic noise source, so a rebuild gives the same file.
function noise(seed = 1) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 31 - 1 }
}
// The starter motor, from `from` to `to` seconds: its whine (gear mesh,
// ~380 Hz, spinning up as it engages) wobbles and labours `fc` times a
// second, once per compression; the solenoid clunks in and out. RMS of the
// whine part = `level`.
export function starterMotor(n, sr, { from, to, fc, level }) {
  const out = new Float32Array(n), rnd = noise(7)
  const i0 = Math.round(from * sr), i1 = Math.min(n, Math.round(to * sr))
  let ph = 0, bp1 = 0, bp2 = 0
  // Band-pass for the grind: RBJ, 2.4 kHz, Q 1.5.
  const w = 2 * Math.PI * 2400 / sr, al = Math.sin(w) / 3, a0 = 1 + al
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0
  let x1 = 0, x2 = 0
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / sr, left = (i1 - i) / sr
    const spin = 1 - 0.7 * Math.exp(-t / 0.06)
    const wob = Math.sin(2 * Math.PI * fc * t)
    const f = 380 * spin * (1 + 0.04 * wob)
    ph += 2 * Math.PI * f / sr
    const labour = 0.6 + 0.4 * (0.5 - 0.5 * Math.cos(2 * Math.PI * fc * t))
    const env = Math.min(1, t / 0.03) * Math.min(1, left / 0.04)
    const whine = Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph) + 0.1 * Math.sin(5 * ph)
    const r = rnd()
    const g = b0 * r + b2 * x2 - a1 * bp1 - a2 * bp2
    x2 = x1; x1 = r; bp2 = bp1; bp1 = g
    out[i] = env * labour * (whine + 0.6 * g)
  }
  const k = level / (rmsOf(out, i0, i1) || 1)
  for (let i = i0; i < i1; i++) out[i] *= k
  // The solenoid: a low knock and a click, in as it engages and (softer)
  // out as it lets go.
  const clunk = (at, amp) => {
    const j0 = Math.round(at * sr)
    for (let j = 0; j < 0.15 * sr && j0 + j < n; j++) {
      const t = j / sr
      out[j0 + j] += amp * level * (2.2 * Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t / 0.035) + 1.6 * rnd() * Math.exp(-t / 0.004))
    }
  }
  clunk(from, 1); clunk(to, 0.5)
  return out
}

// Hold the level between `floor` and `cap` from sample `from` on: a gain
// that follows a smoothed envelope (fast attack, slow release; lifting at
// most 4x), so the idle, already between the two, passes untouched.
function squeeze(x, { from = 0, floor = 0, cap = Infinity }) {
  const att = 1 - Math.exp(-1 / (0.005 * SR)), rel = 1 - Math.exp(-1 / (0.15 * SR))
  const envK = 1 - Math.exp(-1 / (0.03 * SR))
  let env = 0, g = 1
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]) * 1.41 // ~RMS for a busy waveform
    env += (v - env) * (v > env ? att : envK)
    if (i < from) continue
    const want = env > cap ? cap / env : env < floor ? Math.min(4, floor / (env || 1e-9)) : 1
    g += (want - g) * (want < g ? att : rel)
    x[i] *= g
  }
  return x
}

// Where the engine fires: the first 50 ms window louder than `frac` x the
// idle at the end. Cranking reaches 0.5 x at most (the flat-6, whose starter
// spins it fast); the first firings jump to 1-20 x.
function catchTime(x, idle, frac = 1) {
  const w = Math.round(0.05 * SR)
  for (let i = Math.round(0.3 * SR); i + w < x.length; i += w) if (rmsOf(x, i, i + w) > frac * idle) return i / SR
  return 1
}

export function buildOneshots(car) {
  const set = SAMPLE_SETS[car], os = set.oneshots
  const p = PROFILES[car]
  const out = []
  for (const group of ['engine', 'exhaust']) {
    const idleLoop = set.loops.find((l) => l.render === 'idle' && (l.group || 'engine') === group)
    const target = 0.25 * idleLoop.level // level()'s RMS for the idle loop
    // ── start ──
    {
      let x = oneshotMix(set, group, 'start', Math.round((os.start.seconds - 1.5) * SR), Math.round(os.start.seconds * SR))
      x = x.slice(0, Math.round(os.start.seconds * SR))
      derumble(x)
      const tail = [x.length - Math.round(1.5 * SR), x.length]
      const idle = rmsOf(x, ...tail)
      // The catch, found in the main render alone: the dry sub layer has
      // the cranking's pressure pulses at full strength, the impulse
      // response does not.
      const hi = eqd(path.join(ROOT, '.cache', 'engine-sim', 'out', set.renders[group], 'start-hi.wav'), set.eq)
      derumble(hi)
      const fire = catchTime(hi, rmsOf(hi, ...tail))
      // Cranking from the loud render, up to just before the catch.
      const cut = Math.round((fire - 0.02) * SR), xf = Math.round(0.03 * SR)
      const crank = rmsOf(hi, Math.round(0.2 * SR), cut) / HI_GAIN
      const boost = crank > 0 ? (CHUFF * idle) / crank : 0
      for (let i = 0; i < cut + xf && i < x.length; i++) {
        const v = (hi[i] / HI_GAIN) * boost
        const t = i < cut ? 0 : (i - cut) / xf
        x[i] = v * (1 - t) + x[i] * t
      }
      const fc = (os.crankRpm / 60) * (p.cylinders.length / 2)
      const st = starterMotor(x.length, SR, { from: 0.15, to: fire + 0.05, fc, level: STARTER * idle })
      for (let i = 0; i < x.length; i++) x[i] += st[i]
      squeeze(x, { from: Math.round(fire * SR), floor: FALL_FLOOR * idle, cap: FLARE_CAP * idle })
      const g = Math.min(target / idle, 0.95 / (x.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1))
      for (let i = 0; i < x.length; i++) x[i] *= g
      out.push({ file: os.start[group], x, note: `catch ${fire.toFixed(2)} s, idle x${(g * idle / target).toFixed(2)} of the loop's` })
    }
    // ── stop ──
    {
      let x = oneshotMix(set, group, 'stop', 0, Math.round(0.35 * SR))
      x = x.slice(0, Math.round(os.stop.seconds * SR))
      derumble(x)
      const idle = rmsOf(x, 0, Math.round(0.35 * SR))
      const g = Math.min(target / idle, 0.95 / (x.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1))
      const fade = Math.round(0.08 * SR)
      for (let i = 0; i < x.length; i++) x[i] *= g * Math.min(1, (x.length - i) / fade)
      out.push({ file: os.stop[group], x, note: `idle x${(g * idle / target).toFixed(2)} of the loop's` })
    }
  }
  return out
}

// ── The recorded mix's options (rev-samples.js: dense, part, limiter,
// shifts, long loops) ────────────────────────────────────────────────────
const ES = path.join(ROOT, '.cache', 'engine-sim')
const ES_RENDER = path.join(ES, 'build', 'es-render')

// Run es-render jobs ({ args, env }) in parallel, from engine-sim's source
// root as render-set.sh does; resolves to each job's stderr.
function esRender(jobs, par = Math.max(1, os.cpus().length)) {
  if (!fs.existsSync(ES_RENDER)) throw new Error(`${ES_RENDER} is missing: run scripts/engine-sim/build.sh`)
  const results = new Array(jobs.length)
  let next = 0, done = 0
  return new Promise((resolve, reject) => {
    if (!jobs.length) return resolve(results)
    const run = () => {
      if (next >= jobs.length) return
      const i = next++, j = jobs[i]
      const ch = spawn(ES_RENDER, j.args, { cwd: path.join(ES, 'src'), env: { ...process.env, ...j.env } })
      let err = ''
      ch.stderr.on('data', (d) => { err += d })
      ch.on('close', (code) => {
        if (code !== 0) return reject(new Error(`es-render ${j.args.join(' ')} failed (${code}): ${err.slice(-400)}`))
        results[i] = err
        if (j.done) j.done(err)
        if (++done === jobs.length) resolve(results)
        else run()
      })
    }
    for (let k = 0; k < Math.min(par, jobs.length); k++) run()
  })
}

// Engine scripts import from engine-sim's own folders, so the wrapper is
// placed among them (as render-set.sh does), once, before any job runs.
function stageScript(set) {
  const dest = path.join(ES, 'src', 'assets', 'headless_' + path.basename(set.script))
  fs.copyFileSync(path.join(ROOT, set.script), dest)
  return path.relative(path.join(ES, 'src'), dest)
}

// The three ways every run is heard: the engine and exhaust impulse
// responses, and dry (the sub layer). As render-set.sh with ES_IR / ES_CONV.
// ES_SYNC: every run identical (render.cpp); a fixed gain as the loops'.
function groupsOf(set) {
  return [
    { dir: set.renders.engine, env: { ES_IR: set.ir.engine } },
    { dir: set.renders.exhaust, env: { ES_IR: set.ir.exhaust } },
    { dir: set.sub.renders, env: { ES_CONV: '0' } },
  ].map((g) => ({ ...g, env: { ES_GAIN: '0.0006', ES_SYNC: '1', ...g.env } }))
}

// --fit-part <car> [--torque 0.2]: for each rev point (the set's own and
// the dense ones), the throttle at which the engine makes `torque` of its
// full-throttle torque at that rpm, on the dyno. engine-sim's throttle is
// far from linear (the LS makes no torque at all at 0.15 and 55 % at 0.3),
// so a fixed throttle would be a cruise at one rpm and a pull at another.
// Paste the result into the set's `part.throttle`.
async function fitPart(car, torque) {
  const set = SAMPLE_SETS[car], plan = extrasPlan(set), s = stageScript(set)
  const pts = [...plan.points, ...plan.dense].sort((a, b) => a - b)
  const grid = []
  for (let t = 0.025; t <= 0.5001; t += 0.025) grid.push(Math.round(t * 1000) / 1000)
  const jobs = [], tq = {}
  for (const rpm of pts) for (const th of [...grid, 1]) {
    jobs.push({ args: [s, '/dev/null', 'hold', String(rpm), String(th), '1.5', '2'],
      env: { ES_SYNC: '1', ES_TORQUE: '1', ES_GAIN: '0.0006' },
      done: (err) => { (tq[rpm] ||= {})[th] = Number(/torque (-?[\d.]+)/.exec(err)[1]) } })
  }
  console.error(`${car}: ${jobs.length} dyno holds`)
  await esRender(jobs)
  const out = []
  for (const rpm of pts) {
    const full = tq[rpm][1], want = torque * full
    let th = NaN
    for (let i = 1; i < grid.length; i++) {
      const a = tq[rpm][grid[i - 1]], b = tq[rpm][grid[i]]
      if (a < want && b >= want) { th = grid[i - 1] + (grid[i] - grid[i - 1]) * (want - a) / (b - a); break }
    }
    if (!Number.isFinite(th)) throw new Error(`${car} ${rpm} rpm: no throttle on the grid gives ${torque} of full torque`)
    out.push([rpm, Math.round(th * 1000) / 1000])
    console.error(`  ${rpm}: full ${full.toFixed(0)} N m; ` + grid.map((g) => `${g}:${(tq[rpm][g] / full * 100).toFixed(0)}%`).join(' '))
  }
  console.log(`${car}: part: { torque: ${torque}, throttle: ${JSON.stringify(out)} }`)
}

// --render-extras <car> [--force]: every render the options need, in
// .cache/engine-sim/out/<dir>/ beside the set's own, the three ways each,
// in parallel. Skips what exists unless --force. All ES_SYNC, 5 s holds
// (LONG_SECONDS + the crossfade, from 0.4 s), after a 3 s warmup as ever:
//   on-<rpm>-5s / off-<rpm>-5s   the set's own points again, for long loops
//   on-<mid> / off-<mid>          the dense points
//   part-<rpm>                    every point at its `part.throttle`
//   limiter                       8 s of free revving on the limiter
//   shift-<from>                  an upshift from <from> to <to>
// The engine group's limiter and shifts also log their rpm (-rpm.txt).
async function renderExtras(car, force) {
  const set = SAMPLE_SETS[car], plan = extrasPlan(set), s = stageScript(set)
  const specs = []
  const hold = (name, rpm, th) => specs.push({ name, args: ['hold', String(rpm), String(th), '5', '3'] })
  for (const r of plan.points) { hold(`on-${r}-5s`, r, 1); hold(`off-${r}-5s`, r, 0) }
  for (const r of plan.dense) { hold(`on-${r}`, r, 1); hold(`off-${r}`, r, 0) }
  for (const [r, th] of set.part?.throttle || []) hold(`part-${r}`, r, th)
  const lim = { ES_REV_LIMIT: String(plan.limiter.rpm), ES_LIMITER_S: String(plan.limiter.cut) }
  if (set.idleThrottle) lim.ES_IDLE_THROTTLE = String(set.idleThrottle)
  specs.push({ name: 'limiter', args: ['limiter', '8', '2'], env: lim, log: true })
  for (const sh of plan.shifts) {
    specs.push({ name: `shift-${sh.from}`, args: ['shift', String(sh.from), String(sh.to), String(SHIFT.renderAt + SHIFT.seconds + 0.3), '3'],
      env: { ES_SHIFT_AT: String(SHIFT.renderAt), ES_SHIFT_CUT: String(SHIFT.cut) }, log: true })
  }
  const jobs = []
  for (const [gi, g] of groupsOf(set).entries()) {
    const dir = path.join(ES, 'out', g.dir)
    fs.mkdirSync(dir, { recursive: true })
    for (const sp of specs) {
      const wavOut = path.join(dir, sp.name + '.wav')
      if (!force && fs.existsSync(wavOut)) continue
      const env = { ...g.env, ...sp.env }
      if (sp.log && gi === 0) env.ES_RPM_LOG = path.join(dir, sp.name + '-rpm.txt')
      jobs.push({ args: [s, wavOut, ...sp.args], env })
    }
  }
  console.log(`${car}: ${jobs.length} renders`)
  const t0 = Date.now()
  await esRender(jobs)
  console.log(`${car}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

// --fit-limiter <car>: where to cut the limiter loops. On the limiter the
// revs bounce (a cut, a rise, a cut) in a rhythm that is not a whole number
// of engine cycles, and drifts a little. From where the bouncing has
// settled, for each group and for both lengths (1.5 s and LONG_SECONDS),
// the loop length within 0.3 s of it where both its own render and the dry
// sub layer repeat best over the crossfade, as --fit-idle does.
function fitLimiter(car) {
  const set = SAMPLE_SETS[car]
  const log = fs.readFileSync(path.join(ES, 'out', set.renders.engine, 'limiter-rpm.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number))
  const top = PROFILES[car].redline
  const first = log.find(([, r]) => r >= top)[0]
  const start = Math.round((first + 1.0) * 100) / 100 // a second of bouncing first
  // The bounce period: mean time between crossings of the limit.
  const ups = []
  for (let i = 1; i < log.length; i++) if (log[i - 1][1] < top && log[i][1] >= top && log[i][0] > start) ups.push(log[i][0])
  const period = (ups[ups.length - 1] - ups[0]) / (ups.length - 1)
  const prep = (file) => {
    const x = decode(file, start, LONG_SECONDS + 0.3 + 0.6)
    for (let i = x.length - 1; i > 0; i--) x[i] -= 0.995 * x[i - 1]
    lowpass(x, SR, 300); lowpass(x, SR, 300)
    return x
  }
  const corr = (x, a, b, n) => {
    let ab = 0, aa = 0, bb = 0
    for (let i = 0; i < n; i++) { ab += x[a + i] * x[b + i]; aa += x[a + i] ** 2; bb += x[b + i] ** 2 }
    return ab / Math.sqrt(aa * bb || 1)
  }
  const ref = { render: 'limiter' }
  const dry = prep(renderFile({ renders: set.sub.renders }, ref))
  // One length for both groups: they are the same run, started together,
  // so they stay in step as they loop (the player allows for how alike they
  // are when it mixes them: `corr`, from --print-levels).
  const F = Math.round(0.12 * SR), out = { start, period: Math.round(period * 1e4) / 1e4 }
  const mains = ['engine', 'exhaust'].map((group) => prep(renderFile(set, { ...ref, group })))
  for (const [k, want] of [['seconds', 1.5], ['long', LONG_SECONDS]]) {
    let len = 0, score = -2
    for (let L = Math.round((want - 0.3) * SR); L <= Math.round((want + 0.3) * SR); L++) {
      const c = Math.min(corr(mains[0], 0, L, F), corr(mains[1], 0, L, F), corr(dry, 0, L, F))
      if (c > score) { score = c; len = L }
    }
    out[k] = Math.round((len / SR) * 1e5) / 1e5
    out[k + 'Seam'] = Math.round(score * 100) / 100
  }
  for (const group of ['engine', 'exhaust']) out[group] = { seconds: out.seconds, long: out.long }
  console.log(`${car}: limiter ${JSON.stringify(out)}`)
  return out
}

// A shift clip: the stretch from the render with the set's EQ and sub
// layer, derumbled from WARM s earlier, PAD_SECONDS of the run either side
// (the player takes the clip from PAD_SECONDS on, as with loops). Its
// level follows the loops' own law: engine-sim's loudness swings with rpm
// (the LFA is 15 dB louder at 6,700 than at 4,600), and the loops' levels
// are square-rooted and smoothed, so a clip left as rendered would come in
// and hand back at a different level from the loops either side. So the
// clip is held at `level` (the on-load level at `from`) before its cut and
// at `levelTo` (at `to`) once it fires again, gliding between them through
// the cut, and the cut's dip, like every level, is square-rooted (in dB,
// half as deep as rendered: the V8's 14 dB is 7).
function shiftClip(set, loop) {
  const pad = PAD_SECONDS, pre = WARM
  const x = stretchFor(set, { ...loop, start: loop.start - pad - pre }, loop.seconds + 2 * pad + pre)
  derumble(x)
  const y = x.slice(Math.round(pre * SR), Math.round(pre * SR) + Math.round((loop.seconds + 2 * pad) * SR))
  const a = Math.round(pad * SR), iCut = a + Math.round(loop.at * SR)
  const iBack = a + Math.round((loop.at + loop.cut + 0.12) * SR), iEnd = y.length - a
  // 20 ms RMS envelope, centred.
  const W = Math.round(0.02 * SR), env = new Float64Array(y.length)
  let acc = 0
  for (let i = 0; i < y.length + W; i++) {
    if (i < y.length) acc += y[i] * y[i]
    if (i >= W) acc -= y[i - W] * y[i - W]
    const c = i - (W >> 1)
    if (c >= 0 && c < y.length) env[c] = Math.sqrt(Math.max(0, acc) / W)
  }
  const ePre = rmsOf(y, a, iCut), ePost = rmsOf(y, iBack, iEnd)
  const tPre = 0.25 * loop.level, tPost = 0.25 * (loop.levelTo ?? loop.level)
  for (let i = 0; i < y.length; i++) {
    const u = Math.min(1, Math.max(0, (i - iCut) / (iBack - iCut)))
    const base = ePre ** (1 - u) * ePost ** u, t = tPre ** (1 - u) * tPost ** u
    y[i] *= Math.min(4 * t / base, t / Math.sqrt(base * Math.max(env[i], 1e-9)))
  }
  return ceiling(y)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (args.includes('--oneshots')) {
    fs.mkdirSync(CACHE, { recursive: true })
    const car1 = args[args.indexOf('--oneshots') + 1]
    let total = 0
    for (const car of Object.keys(SAMPLE_SETS)) {
      if (car1 && !car1.startsWith('--') && car !== car1) continue
      for (const c of buildOneshots(car)) {
        const tmp = path.join(CACHE, c.file + '.wav'), dest = path.join(OUT, c.file)
        wav(tmp, c.x)
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', '-ar', String(SR),
          '-map_metadata', '-1', '-metadata', `comment=${CREDITS.enginesim.title} by ${CREDITS.enginesim.author}, ${CREDITS.enginesim.licence}, ${CREDITS.enginesim.url}`, dest])
        const size = fs.statSync(dest).size
        total += size
        console.log(`${c.file}: ${(c.x.length / SR).toFixed(2)} s, ${c.note}, ${(size / 1024).toFixed(1)} kB`)
      }
    }
    console.log(`total ${(total / 1024).toFixed(1)} kB`)
    process.exit(0)
  }
  const argOf = (k) => args[args.indexOf(k) + 1]
  if (args.includes('--fit-part')) { await fitPart(argOf('--fit-part'), args.includes('--torque') ? Number(argOf('--torque')) : 0.2); process.exit(0) }
  if (args.includes('--render-extras')) {
    const c = argOf('--render-extras')
    for (const car of c && !c.startsWith('--') ? [c] : Object.keys(SAMPLE_SETS)) await renderExtras(car, args.includes('--force'))
    process.exit(0)
  }
  if (args.includes('--fit-limiter')) { fitLimiter(argOf('--fit-limiter')); process.exit(0) }
  if (args.includes('--fit-idle')) { fitIdle(args[args.indexOf('--fit-idle') + 1], args.includes('--around') ? { seconds: Number(args[args.indexOf('--around') + 1]), range: 1.5 } : {}); process.exit(0) }
  if (args.includes('--print-levels')) { printLevels(args[args.indexOf('--print-levels') + 1], args.includes('--json')); process.exit(0) }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), credits())
  if (args.includes('--credits')) process.exit(0)
  let total = 0
  // --missing: only the files not in static/sounds/ yet, so the ones
  // already there (the set's own loops) are never re-encoded.
  const missing = args.includes('--missing')
  for (const [car, set] of Object.entries(SAMPLE_SETS)) {
    if (only && car !== only) continue
    const done = new Set()
    for (const loop of set.loops) {
      if (done.has(loop.file)) continue // one file can serve both layers
      done.add(loop.file)
      if (missing && fs.existsSync(path.join(OUT, loop.file))) continue
      if (loop.layer === 'shift') {
        const y = shiftClip(set, loop)
        const tmp = path.join(CACHE, loop.file + '.wav'), dest = path.join(OUT, loop.file)
        const a = Math.round(PAD_SECONDS * SR), b = a + Math.round(loop.at * SR)
        encodeMatched(y, tmp, dest, set.bitrate || '48k', loop.src, [a, b], 0.25 * loop.level)
        const size = fs.statSync(dest).size
        total += size
        console.log(`${loop.file}: ${loop.seconds.toFixed(3)} s shift ${loop.from}-${loop.to} rpm, ${(size / 1024).toFixed(1)} kB`)
        continue
      }
      const len = Math.round(loopSeconds(loop) * SR)
      const fade = Math.round(Math.min(0.12, loopSeconds(loop) * 0.25) * SR)
      const rendered = set.kind === 'engine-sim'
      const secs = (len + fade) / SR + 0.05
      const seg = rendered ? stretchFor(set, loop, secs) : decode(source(loop.src), loop.start, secs)
      // Recordings are levelled alike, then louder with revs, the way the
      // engine is: idle about 6 dB under the redline. Renders keep the
      // engine's own levels, which `level` carries (see rev-samples.js).
      const rise = 0.5 + 0.5 * Math.min(1, loop.rpm / PROFILES[car].redline)
      const opt = isOpt(loop)
      // The options' loops: their level exactly, as heard (see optTarget).
      const target = opt ? optTarget(loop) : null
      const x = opt ? levelOpt(makeLoop(seg, len, fade), target) : level(makeLoop(seg, len, fade), rendered ? 0.25 * loop.level : 0.3 * rise * (loop.level || 1))
      // Wrap-around padding either side (see PAD_SECONDS).
      const pad = Math.round(PAD_SECONDS * SR)
      const padded = new Float32Array(x.length + 2 * pad)
      padded.set(x.subarray(x.length - pad), 0); padded.set(x, pad); padded.set(x.subarray(0, pad), pad + x.length)
      const tmp = path.join(CACHE, loop.file + '.wav')
      const dest = path.join(OUT, loop.file)
      const br = (loop.file.endsWith('-long.ogg') && set.longBitrate) || set.optBitrate || set.bitrate || '48k'
      if (opt) encodeMatched(padded, tmp, dest, br, loop.src, [pad, pad + len], target)
      else { wav(tmp, padded); encode(tmp, dest, set.bitrate || '48k', loop.src) }
      const size = fs.statSync(dest).size
      total += size
      console.log(`${loop.file}: ${(len / SR).toFixed(3)} s at ${loop.rpm} rpm (${loop.layer || 'any'}) from ${loop.src} @ ${loop.start} s, ${(size / 1024).toFixed(1)} kB`)
    }
  }
  console.log(`total ${(total / 1024).toFixed(1)} kB`)
}
