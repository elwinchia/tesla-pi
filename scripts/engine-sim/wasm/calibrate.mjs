// calibrate.mjs [car...]: measure live engine-sim against the recorded loops
// and write static/live/levels.json, so the two play equally loud.
//
// The recorded loops are the same engine, at the same rpm points, but each
// loop was levelled on its own: its RMS is 0.25 x `level`, and `level` is
// the square root of the render's loudness (rev-samples.js), so overrun and
// idle sit much closer to full load than they do in the raw simulation.
// Live has to make the same curve. Per car:
//   - The recorded player's own loudness (`tgt`): the worklet's SampleVoice
//     playing the shipped loops (decoded with ffmpeg) at each rev point and
//     at the loads in LOADS, each group alone and half and half, as it plays them: with its
//     rpm loudness curve and its crossfades, before the cabin.
//   - What live makes there (`r`, `s`, `d`, `rho`, `limiter`): the WASM
//     module run in Node exactly as the worker runs it, at each rev point
//     (its idle first) and at the throttles in TH, through the chain the
//     page builds (rev-live.js: the impulse response at engine-sim's own
//     volume, the EQ shelves, the dry sub layer at 0.7 x the main's RMS, the
//     25 Hz rumble filter of rev-samples.mjs). Per quality.
// The worker (stateAt in rev-live-worker.js) predicts a gain from these and
// corrects it from the live spectrum (ChainMeter).
//
// Also prints how much the loudness moves with the quality setting.
//
// Run after build-wasm.sh: node scripts/engine-sim/wasm/calibrate.mjs  (a few minutes; one process per car)
// After re-rendering the loops (scripts/rev-samples.mjs), but not the engine:
//   node scripts/engine-sim/wasm/calibrate.mjs --targets   (seconds)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SETS, loopSlice, loopsFor } from '../../../static/rev-samples.js'
import { SampleVoice } from '../../../static/rev-sampler.js'
import { createModule, EngineRunner, IDLE_THROTTLE, STARTER_S, WARM_S } from '../../../static/rev-live-worker.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LIVE = path.join(ROOT, 'static/live')
const SR = 44100
export const TH = [0, 0.25, 0.5, 1]
const QUALITIES = [1, 0.75, 0.5]
const SETTLE = 0.7, MEASURE = 1.0
// The recorded player's loads: onLoadMix (rev-sampler.js) is flat below
// -0.1 and above 0.3, and linear between.
export const LOADS = [-0.1, 0, 0.1, 0.2, 0.3]

import { readWav16, convolve, biquad, shelfCoefs, lowpassCoefs, hp25, rms, db } from './dsp.mjs'

// The live chain for one group: main = EQ(conv(dry)), sub = LP(LP(dry)) at
// 0.7 x main's RMS, out = HP25(main + s sub). Over the last MEASURE s.
function chain(dry, ir, set, lp) {
  let main = convolve(dry, ir)
  for (const f of set.eq) main = biquad(main, shelfCoefs(f, SR))
  const a = dry.length - Math.round(MEASURE * SR)
  const s = set.sub.level * rms(main, a) / (rms(lp, a) || 1)
  const out = new Float64Array(dry.length)
  for (let i = 0; i < out.length; i++) out[i] = main[i] + s * lp[i]
  const y = hp25(out, SR)
  return { y, s, r: rms(y, a), a }
}

// The recorded player's loudness (dB) per group, row and load: SampleVoice
// with the set's own loops (what plays with every recorded option off).
function targets(car, rpms) {
  const loops = loopsFor(SAMPLE_SETS[car], {}).map((l) => {
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(ROOT, 'static/sounds', l.file), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
    return { ...l, data: loopSlice(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)), SR, l), sr: SR }
  })
  // e: the engine group alone (Exhaust 0), x: the exhaust group alone
  // (Exhaust 1), m: the two mixed half and half (Exhaust 0.5), which shows
  // how much the player's two groups add in phase.
  const tgt = { e: [], x: [], m: [] }
  for (const [g, m] of [['e', 0], ['x', 1], ['m', 0.5]]) {
    const v = new SampleVoice(SR)
    v.setSet({ loops })
    for (const rpm of rpms) {
      const row = []
      for (const load of LOADS) {
        v.set({ rpm, load, gain: 1, exhaust: m })
        v.rpm = rpm; v.load = load; v.gain = 1
        const n = 2 * SR, out = new Float32Array(n), blk = new Float32Array(128)
        for (let i = 0; i < n; i += 128) { v.render([blk], 128); out.set(blk.subarray(0, Math.min(128, n - i)), i) }
        row.push(+db(rms(out)).toFixed(2))
      }
      tgt[g].push(row)
    }
  }
  return { loads: LOADS, tgt }
}

async function measure(car, factory, wasm, data, irs) {
  const set = SAMPLE_SETS[car]
  const points = [...new Set(loopsFor(set, {}).filter((l) => l.render !== 'idle').map((l) => l.rpm))].sort((a, b) => a - b)
  const rpms = [loopsFor(set, {}).find((l) => l.render === 'idle').rpm, ...points]
  const out = { rpm: rpms, th: TH, q: {}, ...targets(car, rpms) }
  const notes = []
  for (const q of QUALITIES) {
    const M = await createModule(factory, wasm, data)
    const run = new EngineRunner(M, data, car, q, null)
    const vols = Array.from({ length: M._es_exhaust_count() }, (_, i) => M._es_ir_volume(i))
    if (new Set(vols).size !== 1) throw new Error(`${car}: exhausts have different impulse-response volumes ${vols}`)
    out.irVolume = vols[0]
    const h = { e: irs.engine.map((v) => v * vols[0] / 32767), x: irs.exhaust.map((v) => v * vols[0] / 32767) }
    run.warmUp(STARTER_S + WARM_S)
    const lpc = lowpassCoefs(set.sub.lowpass, SR)
    // One state: SETTLE s to settle, then MEASURE s measured.
    const state = (mode, rpm, th, settle = SETTLE) => {
      run.control(mode, rpm, th)
      const chunks = []
      const t0 = run.t
      while (run.t - t0 < settle + MEASURE) chunks.push(Float64Array.from(run.dry(), (v) => v / 32768))
      const dry = new Float64Array(chunks.reduce((n, c) => n + c.length, 0))
      let o = 0; for (const c of chunks) { dry.set(c, o); o += c.length }
      const lp = biquad(biquad(dry, lpc), lpc)
      const ce = chain(dry, h.e, set, lp), cx = chain(dry, h.x, set, lp)
      let c = 0; for (let k = ce.a; k < dry.length; k++) c += ce.y[k] * cx.y[k]
      return { r: { e: +db(ce.r).toFixed(2), x: +db(cx.r).toFixed(2) }, s: { e: +ce.s.toPrecision(4), x: +cx.s.toPrecision(4) },
        d: +db(rms(dry, ce.a)).toFixed(2), rho: +(c / (dry.length - ce.a) / (ce.r * cx.r)).toFixed(3) }
    }
    const r = { e: [], x: [] }, s = { e: [], x: [] }, rho = [], corr = [], d = []
    for (let i = 0; i < rpms.length; i++) {
      for (const g of ['e', 'x']) { r[g].push([]); s[g].push([]) }
      corr.push([]); d.push([])
      for (const th of TH) {
        const m = i === 0 && th === 0 ? state(1, rpms[0], IDLE_THROTTLE[car] || 0) : state(0, rpms[i], th)
        for (const g of ['e', 'x']) { r[g][i].push(m.r[g]); s[g][i].push(m.s[g]) }
        corr[i].push(m.rho); d[i].push(m.d); rho.push(m.rho)
      }
    }
    // The limiter: free at full throttle, bouncing off engine-sim's own
    // rev limiter (the player's `limiter`), measured on its own.
    const limiter = state(1, 0, 1, 1.0)
    out.q[q] = { r, s, rho: corr, d, limiter }
    if (q !== 1) {
      const d = r.e.flatMap((row, i) => row.map((v, k) => v - out.q[1].r.e[i][k]))
      notes.push(`quality ${q}: loudness ${Math.min(...d).toFixed(1)}..${Math.max(...d).toFixed(1)} dB from quality 1`)
    }
  }
  console.log(`${car}: ${notes.join('; ')}`)
  return out
}

// One car per process, in parallel: `--one <car>` prints its entry.
const args = process.argv.slice(2)
const { default: factory } = await import(path.join(LIVE, 'engine-sim.js'))
const wasm = fs.readFileSync(path.join(LIVE, 'engine-sim.wasm'))
const data = JSON.parse(fs.readFileSync(path.join(LIVE, 'engine-sim-data.json'), 'utf8'))
const irs = { engine: readWav16(path.join(LIVE, 'ir-engine.wav')), exhaust: readWav16(path.join(LIVE, 'ir-exhaust.wav')) }
if (args[0] === '--targets') {
  // The loops changed but the engine did not: only re-read their loudness.
  const file = path.join(LIVE, 'levels.json'), levels = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const car of Object.keys(levels)) { delete levels[car].on; delete levels[car].off; Object.assign(levels[car], targets(car, levels[car].rpm)) }
  fs.writeFileSync(file, JSON.stringify(levels))
  console.log(`re-targeted ${file}`)
} else if (args[0] === '--one') {
  const entry = await measure(args[1], factory, wasm, data, irs)
  process.stdout.write('\n@@' + JSON.stringify(entry) + '\n')
} else {
  const cars = args.length ? args : Object.keys(SAMPLE_SETS).filter((k) => SAMPLE_SETS[k].kind === 'engine-sim')
  const file = path.join(LIVE, 'levels.json')
  const levels = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const { execFile } = await import('node:child_process')
  const me = fileURLToPath(import.meta.url)
  await Promise.all(cars.map((car) => new Promise((ok, fail) => execFile(process.execPath, [me, '--one', car], { maxBuffer: 1 << 26 }, (e, out) => {
    if (e) return fail(e)
    const [text, json] = out.split('\n@@')
    process.stdout.write(text.trim() + '\n')
    levels[car] = JSON.parse(json)
    ok()
  }))))
  const sorted = Object.fromEntries(Object.keys(SAMPLE_SETS).filter((k) => levels[k]).map((k) => [k, levels[k]]))
  fs.writeFileSync(file, JSON.stringify(sorted))
  console.log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} kB)`)
}
