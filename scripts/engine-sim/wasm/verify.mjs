// verify.mjs [car] [quality]: live engine-sim against the recorded loops,
// (DEBUG=1 also prints the meter's correction; NO_CORRECT=1 turns it off)
// offline, through the same code the car runs: the worker's EngineRunner
// (controls, levels) and the page's graph (dsp.mjs, as rev-live.js wires
// it) for live, and the worklet's SampleVoice playing the shipped loops
// for recorded, at the same rpm and load, Exhaust 0.5, before the cabin
// (which treats both alike). Prints each one's loudness and the difference.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SETS, loopSlice, loopsFor } from '../../../static/rev-samples.js'
import { SampleVoice } from '../../../static/rev-sampler.js'
import { PROFILES } from '../../../static/rev-profiles.js'
import { createModule, EngineRunner, levelsFor } from '../../../static/rev-live-worker.js'
import { readWav16, convolve, biquad, shelfCoefs, lowpassCoefs, hp25, rms, db } from './dsp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LIVE = path.join(ROOT, 'static/live')
const SR = 44100
const car = process.argv[2] || 'v8', quality = Number(process.argv[3] || 1)
const set = SAMPLE_SETS[car], prof = PROFILES[car]
const SETTLE = 2.0, MEASURE = 3.0

// The states the player produces (rev-model.js): parked idle; a finger
// holding the rev meter (FreeRev: load 0.25); driving at full load and on
// overrun; the limiter.
const states = [
  ['idle (parked)', { rpm: prof.idle, load: 0, stopped: true }],
  ['hold 0.45 redline, load 0.25', { rpm: 0.45 * prof.redline, load: 0.25, stopped: true }],
  ['hold 0.7 redline, load 0.25', { rpm: 0.7 * prof.redline, load: 0.25, stopped: true }],
  ['drive 0.35 redline, load 1', { rpm: 0.35 * prof.redline, load: 1, stopped: false }],
  ['drive 0.6 redline, load 1', { rpm: 0.6 * prof.redline, load: 1, stopped: false }],
  ['drive 0.6 redline, load 0.5', { rpm: 0.6 * prof.redline, load: 0.5, stopped: false }],
  ['drive 0.6 redline, overrun', { rpm: 0.6 * prof.redline, load: -0.5, stopped: false }],
  ['limiter', { rpm: prof.redline, load: 1, stopped: true, limiter: true }],
]

// Recorded: the worklet's SampleVoice with the set's own loops.
const voice = new SampleVoice(SR)
voice.setSet({ loops: loopsFor(set, {}).map((l) => {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(ROOT, 'static/sounds', l.file), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
  return { ...l, data: loopSlice(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)), SR, l), sr: SR }
}) })
function recorded(p) {
  voice.set({ rpm: p.rpm, load: p.load, gain: 1, exhaust: 0.5 })
  voice.rpm = p.rpm; voice.load = p.load; voice.gain = 1
  const n = Math.round(MEASURE * SR), out = new Float32Array(n), blk = new Float32Array(128)
  for (let i = 0; i < n; i += 128) { voice.render([blk], 128); out.set(blk.subarray(0, Math.min(128, n - i)), i) }
  return db(rms(out))
}

// Live: the runner, then the graph.
const { default: factory } = await import(path.join(LIVE, 'engine-sim.js'))
const data = JSON.parse(fs.readFileSync(path.join(LIVE, 'engine-sim-data.json'), 'utf8'))
const levels = JSON.parse(fs.readFileSync(path.join(LIVE, 'levels.json'), 'utf8'))
const M = await createModule(factory, fs.readFileSync(path.join(LIVE, 'engine-sim.wasm')), data)
const run = new EngineRunner(M, data, car, quality, levelsFor(levels, car, quality))
const h = { e: readWav16(path.join(LIVE, 'ir-engine.wav')).map((v) => v * run.irVolume / 32767), x: readWav16(path.join(LIVE, 'ir-exhaust.wav')).map((v) => v * run.irVolume / 32767) }
run.attachMeter({ e: Float32Array.from(h.e), x: Float32Array.from(h.x) }, set) // as the worker does
run.warmUp()
if (process.env.NO_CORRECT) run.correct = false
function live(p) {
  run.set({ ...p, idle: prof.idle, exhaust: 0.5 })
  const ch = { e: [], x: [], s: [] }
  const t0 = run.t
  while (run.t - t0 < SETTLE + MEASURE) {
    const { buf, n } = run.frame()
    ch.e.push(buf.subarray(0, n)); ch.x.push(buf.subarray(n, 2 * n)); ch.s.push(buf.subarray(2 * n))
  }
  const cat = (a) => { const y = new Float64Array(a.reduce((k, c) => k + c.length, 0)); let o = 0; for (const c of a) { y.set(c, o); o += c.length } return y }
  const e = cat(ch.e), x = cat(ch.x), s = cat(ch.s)
  const ce = convolve(e, h.e), cx = convolve(x, h.x)
  let main = new Float64Array(e.length)
  for (let i = 0; i < main.length; i++) main[i] = ce[i] + cx[i]
  for (const f of set.eq) main = biquad(main, shelfCoefs(f, SR))
  const lpc = lowpassCoefs(set.sub.lowpass, SR)
  const sub = biquad(biquad(s, lpc), lpc)
  for (let i = 0; i < main.length; i++) main[i] += sub[i]
  const y = hp25(main, SR)
  if (process.env.DEBUG) console.log(`    correction e ${(20 * Math.log10(run.last.fe)).toFixed(1)} x ${(20 * Math.log10(run.last.fx)).toFixed(1)} dB, groups correlate ${run.last.rho.toFixed(2)}`)
  return { db: db(rms(y, y.length - Math.round(MEASURE * SR))), rpm: run.rpm, th: run.throttle }
}

console.log(`${car} at quality ${quality}: loudness (dB), live vs recorded, Exhaust 0.5, before the cabin`)
const diffs = []
for (const [name, p] of states) {
  const l = live(p), r = recorded(p)
  diffs.push(l.db - r)
  console.log(`  ${name.padEnd(30)} live ${l.db.toFixed(1).padStart(6)}  recorded ${r.toFixed(1).padStart(6)}  diff ${(l.db - r).toFixed(1).padStart(5)}   (engine ${l.rpm.toFixed(0)} rpm, throttle ${l.th.toFixed(2)})`)
}
console.log(`  worst ${Math.max(...diffs.map(Math.abs)).toFixed(1)} dB`)
