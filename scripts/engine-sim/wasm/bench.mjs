// bench.mjs [seconds]: how fast live engine-sim simulates in Node, per car
// and quality: simulated seconds per second of compute, held at 60 % of
// redline at full throttle (the dearest steady state), after the start.
// Above 1 it keeps up; the worker in the car needs headroom on top.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModule, EngineRunner } from '../../../static/rev-live-worker.js'
import { SAMPLE_SETS } from '../../../static/rev-samples.js'

const LIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../static/live')
const seconds = Number(process.argv[2]) || 3
const { default: factory } = await import(path.join(LIVE, 'engine-sim.js'))
const wasm = fs.readFileSync(path.join(LIVE, 'engine-sim.wasm'))
const data = JSON.parse(fs.readFileSync(path.join(LIVE, 'engine-sim-data.json'), 'utf8'))
console.log('car    quality  sim Hz   speed (x real time)')
for (const car of Object.keys(SAMPLE_SETS)) {
  for (const q of [1, 0.75, 0.5]) {
    const M = await createModule(factory, wasm, data)
    const run = new EngineRunner(M, data, car, q)
    run.warmUp()
    run.control(0, 0.6 * M._es_redline(), 1)
    const t0 = run.t, c0 = run.compute
    while (run.t - t0 < seconds) run.dry()
    const speed = (run.t - t0) / ((run.compute - c0) / 1000)
    console.log(`${car.padEnd(6)} ${String(q).padEnd(8)} ${String(run.freq).padEnd(8)} ${speed.toFixed(2)}`)
  }
}
