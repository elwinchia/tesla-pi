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
    'Ogg Opus by `scripts/rev-samples.mjs`.', '')
  for (const [id, c] of Object.entries(CREDITS)) {
    const used = [...new Set(Object.entries(SAMPLE_SETS).flatMap(([car, set]) => set.loops.filter((l) => l.src === id).map((l) => `\`${l.file}\` (${car}, ${l.rpm} rpm${l.layer && l.layer !== 'any' ? ', ' + l.layer : ''})`)))]
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
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
