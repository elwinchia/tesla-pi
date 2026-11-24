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
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SETS, CREDITS, loopSeconds, PAD_SECONDS } from '../static/rev-samples.js'
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
    '(`--oneshots`).', '')
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
function printLevels(car) {
  const set = SAMPLE_SETS[car]
  const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
  // Each group is levelled on its own: at either end of the Exhaust
  // setting the engine is equally loud.
  for (const group of [...new Set(set.loops.map((l) => l.group || 'engine'))]) {
    const loops = set.loops.filter((l) => (l.group || 'engine') === group)
    const r = {}
    for (const l of loops) r[l.render] ??= rms(stretchFor(set, l, l.seconds))
    const on = loops.filter((l) => l.layer === 'on' && l.render !== 'idle').sort((a, b) => a.rpm - b.rpm)
    const ref = Math.max(...on.map((l) => r[l.render]))
    const raw = (k) => Math.sqrt(r[k] / ref)
    // Resonances in a simulation can make one rev point several dB louder
    // than its neighbours, which pumps as you rev. Each layer is smoothed
    // across rpm with a 3-point geometric mean, keeping the overall rise.
    const smooth = (xs) => xs.map((x, i) => Math.cbrt((xs[i - 1] ?? x) * x * (xs[i + 1] ?? x)))
    const onL = smooth(on.map((l) => raw(l.render))), offL = smooth(on.map((l) => raw(`off-${l.rpm}`)))
    const top = Math.max(...onL)
    const q = (x) => Math.round((x / top) * 1000) / 1000
    console.log(`${group}: idle`, q(0.6 * onL[0]))
    console.log('  [' + on.map((l, i) => `[${l.rpm}, ${q(onL[i])}, ${q(offL[i])}]`).join(', ') + ']')
  }
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
  if (args.includes('--fit-idle')) { fitIdle(args[args.indexOf('--fit-idle') + 1], args.includes('--around') ? { seconds: Number(args[args.indexOf('--around') + 1]), range: 1.5 } : {}); process.exit(0) }
  if (args.includes('--print-levels')) { printLevels(args[args.indexOf('--print-levels') + 1]); process.exit(0) }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), credits())
  if (args.includes('--credits')) process.exit(0)
  let total = 0
  for (const [car, set] of Object.entries(SAMPLE_SETS)) {
    if (only && car !== only) continue
    const done = new Set()
    for (const loop of set.loops) {
      if (done.has(loop.file)) continue // one file can serve both layers
      done.add(loop.file)
      const len = Math.round(loopSeconds(loop) * SR)
      const fade = Math.round(Math.min(0.12, loopSeconds(loop) * 0.25) * SR)
      const rendered = set.kind === 'engine-sim'
      const secs = (len + fade) / SR + 0.05
      const seg = rendered ? stretchFor(set, loop, secs) : decode(source(loop.src), loop.start, secs)
      // Recordings are levelled alike, then louder with revs, the way the
      // engine is: idle about 6 dB under the redline. Renders keep the
      // engine's own levels, which `level` carries (see rev-samples.js).
      const rise = 0.5 + 0.5 * Math.min(1, loop.rpm / PROFILES[car].redline)
      const x = level(makeLoop(seg, len, fade), rendered ? 0.25 * loop.level : 0.3 * rise * (loop.level || 1))
      // Wrap-around padding either side (see PAD_SECONDS).
      const pad = Math.round(PAD_SECONDS * SR)
      const padded = new Float32Array(x.length + 2 * pad)
      padded.set(x.subarray(x.length - pad), 0); padded.set(x, pad); padded.set(x.subarray(0, pad), pad + x.length)
      const tmp = path.join(CACHE, loop.file + '.wav')
      wav(tmp, padded)
      const dest = path.join(OUT, loop.file)
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-c:a', 'libopus', '-b:a', set.bitrate || '48k', '-ac', '1', '-ar', String(SR),
        '-map_metadata', '-1', '-metadata', `comment=${CREDITS[loop.src].title} by ${CREDITS[loop.src].author}, ${CREDITS[loop.src].licence}, ${CREDITS[loop.src].url}`, dest])
      const size = fs.statSync(dest).size
      total += size
      console.log(`${loop.file}: ${(len / SR).toFixed(3)} s at ${loop.rpm} rpm (${loop.layer || 'any'}) from ${loop.src} @ ${loop.start} s, ${(size / 1024).toFixed(1)} kB`)
    }
  }
  console.log(`total ${(total / 1024).toFixed(1)} kB`)
}
