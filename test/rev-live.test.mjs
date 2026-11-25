// Live engine-sim (static/rev-live*.js, static/live/): the WebAssembly
// module runs in Node, compiles a car's script and makes sound at a dyno
// hold; the control mapping, levels, ring buffer and too-slow judge are
// pure and tested on their own.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModule, EngineRunner, ChainMeter, controlFor, levelAt, levelsFor, stateAt, CORRECT_DB, IDLE_THROTTLE } from '../static/rev-live-worker.js'
import { RingReader, IN_RATE } from '../static/rev-live-worklet.js'
import { SlowJudge, SLOW_MS, UNDERRUNS, irFromWav, resample } from '../static/rev-live.js'
import { SAMPLE_SETS, loopsFor } from '../static/rev-samples.js'

const LIVE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'live')
const read = (f) => fs.readFileSync(path.join(LIVE, f))
const data = JSON.parse(read('engine-sim-data.json'))
const levels = JSON.parse(read('levels.json'))

test('the shipped files: module, data bundle, impulse responses, licence, small', () => {
  const sizes = Object.fromEntries(fs.readdirSync(LIVE).map((f) => [f, fs.statSync(path.join(LIVE, f)).size]))
  for (const f of ['engine-sim.js', 'engine-sim.wasm', 'engine-sim-data.json', 'ir-engine.wav', 'ir-exhaust.wav', 'levels.json', 'LICENSE-engine-sim.txt']) assert.ok(sizes[f] > 0, f)
  const total = Object.values(sizes).reduce((a, b) => a + b, 0)
  assert.ok(total < 1.2e6, `static/live/ is ${total} bytes`)
  assert.match(read('LICENSE-engine-sim.txt').toString(), /MIT[\s\S]*AngeTheGreat[\s\S]*Permission is hereby granted/)
  // Every car's script is in the bundle, with what it imports, and only .mr files.
  for (const car of Object.keys(SAMPLE_SETS)) assert.ok(data.files[data.scripts[car]], car)
  assert.ok(Object.keys(data.files).every((f) => f.endsWith('.mr')))
  // A 16-bit mono response, cut to at most engine-sim's 10,000 taps.
  for (const g of ['engine', 'exhaust']) {
    const ab = read(`ir-${g}.wav`)
    const { x, rate } = irFromWav(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.length), 1)
    assert.equal(rate, 44100); assert.ok(x.length > 1000 && x.length <= 10000, g)
  }
})

test('levels: every car, every quality, every rev point of its recorded set', () => {
  for (const [car, set] of Object.entries(SAMPLE_SETS)) {
    const own = loopsFor(set, {})
    const rpms = [...new Set(own.map((l) => l.rpm))].sort((a, b) => a - b)
    for (const q of [1, 0.75, 0.5]) {
      const L = levelsFor(levels, car, q)
      assert.ok(L, `${car} @ ${q}`)
      assert.deepEqual(L.rpm, rpms, car)
      assert.deepEqual(L.loads, [-0.1, 0, 0.1, 0.2, 0.3])
      for (const g of ['e', 'x', 'm']) assert.ok(L.tgt[g].length === rpms.length && L.tgt[g].flat().every(Number.isFinite), `${car} target ${g}`)
      for (const g of ['e', 'x']) {
        assert.equal(L.r[g].length, rpms.length)
        assert.ok(L.r[g].flat().every(Number.isFinite) && L.s[g].flat().every((s) => s > 0), `${car} ${g}`)
      }
    }
  }
})

test('levels: at a calibrated point, live is set to the recorded player\'s loudness there', () => {
  const L = levelsFor(levels, 'v8', 1)
  const i = 4, rpm = L.rpm[i], top = L.loads.length - 1
  // Full throttle at full load: the player's loudness over live's own.
  const on = levelAt(L, 'e', rpm, 1, 1)
  assert.ok(Math.abs(20 * Math.log10(on.gain) - (L.tgt.e[i][top] - L.r.e[i][3])) < 1e-9)
  // Overrun: closed throttle at the player's overrun.
  const off = levelAt(L, 'x', rpm, 0, -0.5)
  assert.ok(Math.abs(20 * Math.log10(off.gain) - (L.tgt.x[i][0] - L.r.x[i][0])) < 1e-9)
  // Between points, between the two.
  const mid = levelAt(L, 'x', (L.rpm[i] + L.rpm[i + 1]) / 2, 1, 1).gain
  const lo = levelAt(L, 'x', L.rpm[i], 1, 1).gain, hi = levelAt(L, 'x', L.rpm[i + 1], 1, 1).gain
  assert.ok(mid >= Math.min(lo, hi) - 1e-12 && mid <= Math.max(lo, hi) + 1e-12)
  // On the limiter: as loud as the player's top rev point at that load, from its own measurement.
  const z = stateAt(L, 6500, 1, 1, true)
  assert.ok(Math.abs(20 * Math.log10(z.e.gain) - (L.tgt.e.at(-1)[top] - L.limiter.r.e)) < 1e-9)
  const cut = stateAt(L, 6500, 1, -0.6, true) // the model's load in a cut
  assert.ok(Math.abs(20 * Math.log10(cut.e.gain) - (L.tgt.e.at(-1)[0] - L.limiter.r.e)) < 1e-9)
})

test('levels: the measured chain corrects the table, never by more than CORRECT_DB', () => {
  const L = levelsFor(levels, 'v8', 1)
  const z = stateAt(L, 4000, 1, 1)
  const run = Object.create(EngineRunner.prototype)
  const meter = (e, x) => ({ ready: true, setSub() {}, power: () => ({ e, x, ex: 0 }) })
  const at = (e, x) => {
    Object.assign(run, { levels: L, exhaust: 0.5, load: 1, p: { limiter: false }, mode: 0, pe: null, px: null,
      M: { _es_rpm: () => 4000, _es_throttle: () => 1 }, meter: meter(e, x) })
    return run.gains()
  }
  // The meter agrees with the table: no correction.
  const pe = 10 ** (z.e.r / 10), px = 10 ** (z.x.r / 10)
  const base = at(pe, px)
  assert.ok(Math.abs(run.last.fe - 1) < 1e-12 && Math.abs(run.last.fx - 1) < 1e-12)
  // The chain makes 4 dB more than the table thought: 4 dB less gain.
  at(pe * 10 ** 0.4, px)
  assert.ok(Math.abs(20 * Math.log10(run.last.fe) + 4) < 1e-9)
  // Silence or a blast: at most CORRECT_DB either way.
  at(1e-30, px); assert.ok(Math.abs(20 * Math.log10(run.last.fe) - CORRECT_DB) < 1e-9)
  at(1e30, px); assert.ok(Math.abs(20 * Math.log10(run.last.fe) + CORRECT_DB) < 1e-9)
  assert.ok(base.e > 0 && base.x > 0 && base.s > 0)
})

test('the chain meter measures what the page\'s graph plays', () => {
  // A unit impulse response with no EQ: the meter's power is the input's
  // own (the 25 Hz rumble filter passes 1 kHz; the sub is at gain 0).
  const ir = new Float32Array(16); ir[0] = 1
  const m = new ChainMeter({ e: ir, x: ir }, { eq: [], sub: { lowpass: 100 } })
  m.setSub(0, 0)
  m.push(Float64Array.from({ length: 44100 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / 44100)))
  const p = m.power()
  assert.ok(m.ready)
  assert.ok(Math.abs(10 * Math.log10(p.e / 0.5)) < 0.1, `sine power ${p.e}`)
  assert.ok(Math.abs(p.ex / Math.sqrt(p.e * p.x) - 1) < 1e-6, 'identical groups correlate fully')
})

test('controls: held on the dyno when driving or revving, free at idle and on the limiter', () => {
  const st = {}, idle = 690
  // Driving: held at the model's rpm, throttle from load, overrun closed.
  assert.deepEqual(controlFor({ rpm: 2500, load: 0.6, idle, stopped: false }, st, 2500), { mode: 0, rpm: 2500, throttle: 0.6 })
  assert.deepEqual(controlFor({ rpm: 2500, load: -0.4, idle, stopped: false }, st, 2500), { mode: 0, rpm: 2500, throttle: 0 })
  assert.equal(controlFor({ rpm: 2500, load: 1.7, idle, stopped: false }, st, 2500).throttle, 1)
  // Rolling at idle rpm is still held: only parked lets it idle on its own.
  assert.equal(controlFor({ rpm: idle, load: 0, idle, stopped: false }, st, idle).mode, 0)
  // Parked at idle: free, with the idle throttle the F136 needs.
  assert.deepEqual(controlFor({ rpm: idle, load: 0, idle, stopped: true }, st, idle, IDLE_THROTTLE.f136), { mode: 1, rpm: idle, throttle: 0.02 })
  // Hysteresis: a touch over the way in stays free; a rev takes it back.
  assert.equal(controlFor({ rpm: idle * 1.1, load: 0.08, idle, stopped: true }, st, idle).mode, 1)
  assert.equal(controlFor({ rpm: 3000, load: 0.5, idle, stopped: true }, st, idle).mode, 0)
  assert.equal(controlFor({ rpm: idle * 1.1, load: 0, idle, stopped: true }, st, idle).mode, 0, 'not back in until near idle')
  assert.equal(controlFor({ rpm: idle, load: 0, idle, stopped: true }, st, idle).mode, 1)
  // The limiter: free at full throttle, bouncing off engine-sim's own limiter.
  assert.deepEqual(controlFor({ rpm: 6500, load: 1, idle, stopped: true, limiter: true }, st, 6400), { mode: 1, rpm: 6500, throttle: 1 })
  // A stall while free: held from then on.
  const s2 = {}
  controlFor({ rpm: idle, load: 0, idle, stopped: true }, s2, idle)
  assert.equal(controlFor({ rpm: idle, load: 0, idle, stopped: true }, s2, 200).mode, 0)
  assert.equal(controlFor({ rpm: idle, load: 0, idle, stopped: true }, s2, idle).mode, 0)
})

test('ring buffer: waits to fill, resamples, fades out and counts an underrun when it runs dry', () => {
  const r = new RingReader(48000, { start: 0.01, refill: 0.005 })
  r.gainTarget = 1; r.gain = 1
  const outs = [new Float32Array(128), new Float32Array(128), new Float32Array(128)]
  r.render(outs, 128)
  assert.ok(outs[0].every((v) => v === 0), 'silent until filled')
  // A 441 Hz sine on channel 0, 0.02 s.
  const n = 882, buf = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * 441 * i / IN_RATE)
  r.push(buf, n)
  let peak = 0, played = 0
  for (let b = 0; b < 6; b++) { r.render(outs, 128); played += 128; for (const v of outs[0]) peak = Math.max(peak, Math.abs(v)) }
  assert.ok(peak > 0.95 && peak <= 1.01, `peak ${peak}`)
  assert.equal(r.underruns, 0)
  // 768 frames at 48 kHz used ~706 of 882 at 44.1 kHz: two more blocks run it dry.
  r.render(outs, 128); r.render(outs, 128)
  assert.equal(r.underruns, 1)
  assert.equal(r.playing, false)
  assert.ok(Math.abs(r.buffered - n) <= 4 + n, 'read position stays inside what was written')
})

test('too slow: under 0.98x for 3 s, or dropouts piling up; a suspended context is never judged', () => {
  const j = new SlowJudge()
  assert.equal(j.report(0, { speed: 0.9 }), null)
  assert.equal(j.report(SLOW_MS - 1, { speed: 0.9 }), null)
  assert.equal(j.report(SLOW_MS, { speed: 0.9 }), 'speed')
  const k = new SlowJudge()
  k.report(0, { speed: 0.9 }); k.report(2000, { speed: 1.4 }) // recovered: the clock restarts
  assert.equal(k.report(4000, { speed: 0.9 }), null)
  assert.equal(k.report(10000, { speed: 0.5, fresh: false }), null, 'no simulating, no verdict')
  const d = new SlowJudge()
  assert.equal(d.report(0, { speed: 2, underruns: UNDERRUNS - 1 }), null)
  assert.equal(d.report(20000, { speed: 2, underruns: UNDERRUNS }), null, 'old dropouts expire')
  assert.equal(d.report(21000, { speed: 2, underruns: 2 * UNDERRUNS }), 'dropouts')
})

test('impulse-response resampling keeps engine-sim\'s gain', () => {
  const x = new Float32Array(2000)
  for (let i = 0; i < x.length; i++) x[i] = Math.exp(-i / 300) * Math.cos(i / 40)
  const y = resample(x, 44100, 48000)
  const sx = x.reduce((a, v) => a + v, 0), sy = y.reduce((a, v) => a + v, 0)
  assert.ok(Math.abs(sy / sx - 1) < 0.01, `DC gain ${sy / sx}`)
  assert.ok(Math.abs(y.length - Math.ceil(2000 * 48000 / 44100)) <= 1)
})

test('the WebAssembly engine compiles a car, holds 3000 rpm on the dyno and makes sound', async () => {
  const { default: factory } = await import(path.join(LIVE, 'engine-sim.js'))
  const M = await createModule(factory, read('engine-sim.wasm'), data)
  const run = new EngineRunner(M, data, 'v8', 1, levelsFor(levels, 'v8', 1))
  assert.equal(run.freq, 10000)
  assert.equal(run.irVolume, 0.001)
  M._es_ignition(1)
  run.control(0, 3000, 1) // the dyno spins it up from rest
  const out = []
  while (run.t < 0.8) { const d = run.dry(); if (run.t > 0.3) out.push(...d) }
  assert.ok(out.length > 0.45 * 44100, `${out.length} samples`)
  assert.ok(out.every(Number.isFinite), 'finite')
  const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length) / 32768
  assert.ok(rms > 0.01, `dry RMS ${rms}`) // a free idle is ~0.004
  assert.ok(Math.abs(run.rpm - 3000) < 60, `rpm ${run.rpm}`)
  // The levelled frame for the graph: three finite channels, audible, not clipping.
  run.set({ load: 1, exhaust: 0.5 })
  const { buf, n } = run.frame()
  assert.equal(buf.length, 3 * n)
  const e = buf.subarray(0, n)
  const peak = e.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  assert.ok(buf.every(Number.isFinite) && peak > 1e-3 && peak < 50, `peak ${peak}`)
})
