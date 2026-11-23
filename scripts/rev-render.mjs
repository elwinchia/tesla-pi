#!/usr/bin/env node
// Render a simulated drive with the engine sound to a WAV file, to hear it
// without the car or a browser:
//
//   node scripts/rev-render.mjs                       # V8, writes rev-v8.wav
//   node scripts/rev-render.mjs --profile i6 --mode sport --out /tmp/i6.wav
//   node scripts/rev-render.mjs --fix-ms 100          # as if GPS gave 10 fixes/s
//
// It runs the same code the car's browser runs (static/rev-*.js): a simulated
// car reports its speed once a second like the car's GPS, the Engine turns
// that into rpm and load, and the worklet's voice renders the sound.
//
// The drive: idle, two blips of the Rev control, a full-throttle launch, a
// lift-off, a steady cruise, a part-throttle overtake, then a stop.
import fs from 'node:fs'
import { Engine, DEFAULTS, sanitise } from '../static/rev-sound.js'
import { SimCar, CARS } from '../static/rev-model.js'
import { PROFILES } from '../static/rev-profiles.js'
import { EngineVoice } from '../static/rev-worklet.js'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: rev-render.mjs [--profile ' + Object.keys(PROFILES).join('|') + '] [--mode comfort|normal|sport]\n' +
    '                     [--car ' + Object.keys(CARS).join('|') + '] [--fix-ms 1000] [--out file.wav]')
  process.exit(0)
}
const settings = sanitise({ ...DEFAULTS, profile: opt('profile', DEFAULTS.profile), mode: opt('mode', DEFAULTS.mode), car: opt('car', DEFAULTS.car) })
if (settings.profile !== opt('profile', settings.profile)) { console.error('unknown profile'); process.exit(2) }
const fixMs = Number(opt('fix-ms', 1000))
const out = opt('out', `rev-${settings.profile}.wav`)

const SR = 48000, TICK = 0.02, BLOCK = SR * TICK // 960 frames per 20 ms tick
const script = (t) => {
  if (t < 2) return {}
  if (t < 2.5) return { rev: 1 }
  if (t < 3.5) return {}
  if (t < 4.2) return { rev: 1 }
  if (t < 6) return {}
  if (t < 12) return { pedal: 1 }           // launch
  if (t < 15) return {}                     // lift off (regen)
  if (t < 29) return { pedal: 0.07 }        // cruise
  if (t < 34) return { pedal: 0.6 }         // overtake
  if (t < 42) return { brake: 0.35 }        // stop
  return {}
}
const seconds = 45

const engine = new Engine(settings)
const sim = new SimCar(CARS[settings.car])
const voice = new EngineVoice(SR, 0x5eed)
voice.setProfile(PROFILES[settings.profile])
voice.set({ gain: 0.5 })

const frames = Math.round(seconds / TICK) * BLOCK
const pcm = Buffer.alloc(frames * 4)
const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK)
let lastFix = -Infinity, w = 0, maxKmh = 0, maxGear = 0
for (let i = 0; i < seconds / TICK; i++) {
  const t = i * TICK, ms = t * 1000
  const { pedal = 0, brake = 0, rev = 0 } = script(t)
  const v = sim.step(pedal, brake, TICK)
  if (ms - lastFix >= fixMs) { lastFix = ms; engine.fix(ms, v) }
  engine.setRev(rev)
  const s = engine.step(ms, TICK)
  maxKmh = Math.max(maxKmh, v * 3.6); maxGear = Math.max(maxGear, s.gear)
  voice.set({ rpm: s.rpm, load: s.load })
  // The browser renders in 128-frame quanta; do the same so filter updates
  // happen at the same rate.
  for (let o = 0; o < BLOCK; o += 128) {
    const n = Math.min(128, BLOCK - o)
    voice.render([L.subarray(o, o + n), R.subarray(o, o + n)], n)
  }
  for (let k = 0; k < BLOCK; k++) {
    pcm.writeInt16LE(Math.round(L[k] * 32767), w); w += 2
    pcm.writeInt16LE(Math.round(R[k] * 32767), w); w += 2
  }
}

const head = Buffer.alloc(44)
head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8)
head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22)
head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34)
head.write('data', 36); head.writeUInt32LE(pcm.length, 40)
fs.writeFileSync(out, Buffer.concat([head, pcm]))
console.log(`${out}: ${seconds} s, ${PROFILES[settings.profile].name}, ${settings.mode}, ${CARS[settings.car].name}; ` +
  `top ${maxKmh.toFixed(0)} km/h in gear ${maxGear}, speed fix every ${fixMs} ms`)
