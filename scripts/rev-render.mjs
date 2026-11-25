#!/usr/bin/env node
// Render a simulated drive with the engine sound to a WAV file, to hear it
// without the car or a browser:
//
//   node scripts/rev-render.mjs                       # V8, writes rev-v8.wav
//   node scripts/rev-render.mjs --mode sport --out /tmp/v8-sport.wav
//   node scripts/rev-render.mjs --fix-ms 100          # as if GPS gave 10 fixes/s
//   node scripts/rev-render.mjs --scene rev               # simulation mode
//   node scripts/rev-render.mjs --all --scene demo --out-dir rev-demos
//   node scripts/rev-render.mjs --all --scene demo --recorded --out-dir rev-demos
//                                 # the recorded loops (needs ffmpeg to decode them)
//   node scripts/rev-render.mjs --recorded --outside   # without the cabin
//                                 # (static/rev-cabin.js): as a microphone
//                                 # at the engine hears it
//   node scripts/rev-render.mjs --recorded --dense --part --shots --long
//                                 # with the recorded mix's options on
//                                 # (denseRpm, partThrottle, oneShots,
//                                 # longLoops; rev-samples.js loopsFor)
//
// It runs the same code the car's browser runs (static/rev-*.js): a simulated
// car reports its speed once a second like the car's GPS, the Engine turns
// that into rpm and load, and the worklet's voice renders the sound.
//
// Scenes:
//   drive  (45 s) idle, two blips of the Rev control, a full-throttle launch,
//          a lift-off, a steady cruise, a part-throttle overtake, a stop.
//   rev    (11 s) simulation mode, parked: taps on the rev meter (blips),
//          a drag up into the red (the limiter), a lift, a tap in the red.
//   demo   (22 s) the rev scene, then a launch through the gears and a lift.
import fs from 'node:fs'
import path from 'node:path'
import { Engine, DEFAULTS, sanitise } from '../static/rev-sound.js'
import { SimCar, CARS } from '../static/rev-model.js'
import { PROFILES } from '../static/rev-profiles.js'
import { EngineVoice } from '../static/rev-worklet.js'
import { SampleVoice } from '../static/rev-sampler.js'
import { Cabin } from '../static/rev-cabin.js'
import { Loudness } from '../static/rev-loudness.js'
import { SAMPLE_SETS, hasRecording, loopSlice, loopsFor } from '../static/rev-samples.js'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: rev-render.mjs [--profile ' + Object.keys(PROFILES).join('|') + ' | --all] [--mode comfort|normal|sport]\n' +
    '                     [--car ' + Object.keys(CARS).join('|') + '] [--scene drive|rev|demo]\n' +
    '                     [--recorded [--exhaust 0..1] [--dense] [--part] [--shots] [--long]] [--outside]\n' +
    '                     [--volume 0..1] [--fix-ms 1000] [--out file.wav | --out-dir dir]')
  process.exit(0)
}
const fixMs = Number(opt('fix-ms', 1000))
const sceneName = opt('scene', 'drive')
const recorded = args.includes('--recorded')
const outside = args.includes('--outside')
// The recorded mix's options, as rev-sound.js's settings name them.
const FLAGS = { dense: 'denseRpm', part: 'partThrottle', shots: 'oneShots', long: 'longLoops' }
const options = Object.fromEntries(Object.entries(FLAGS).map(([f, k]) => [k, args.includes('--' + f)]))
const optTag = Object.keys(FLAGS).filter((f) => options[FLAGS[f]]).join('-')

const SR = 48000, TICK = 0.02, BLOCK = SR * TICK // 960 frames per 20 ms tick
const drive = (t) => {
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
// Simulation mode, as a finger would do it on rev.html. `touch` is the rpm
// under the finger (Infinity: in the red), `lift` lifts it (true = a tap).
const rev = (t, p) => {
  if (t < 1.5) return { sim: true }
  if (t < 1.52) return { sim: true, touch: 3500, lift: true }            // tap
  if (t < 3.0) return { sim: true }
  if (t < 3.02) return { sim: true, touch: p.redline * 0.8, lift: true } // tap
  if (t < 4.5) return { sim: true }
  if (t < 6.0) return { sim: true, touch: p.idle + (t - 4.5) / 1.5 * (p.redline * 1.1 - p.idle) } // drag up
  if (t < 7.2) return { sim: true, touch: Infinity }                     // into the red
  if (t < 7.22) return { sim: true, lift: false }                        // lift
  if (t < 9.2) return { sim: true }
  if (t < 9.22) return { sim: true, touch: Infinity, lift: true }        // tap in the red
  return { sim: true }
}
const demo = (t, p) => {
  if (t < 11) return rev(t, p)
  if (t < 19) return { pedal: 1 }
  return {}
}
const SCENES = { drive: [drive, 45], rev: [rev, 11], demo: [demo, 22] }
if (!SCENES[sceneName]) { console.error('unknown scene'); process.exit(2) }

let names = args.includes('--all') ? Object.keys(PROFILES) : [opt('profile', DEFAULTS.profile)]
if (recorded) {
  const none = names.filter((n) => !hasRecording(n))
  if (none.length) console.log('no recording (synth only): ' + none.join(', '))
  names = names.filter(hasRecording)
}
for (const name of names) {
  if (!Object.hasOwn(PROFILES, name)) { console.error('unknown profile ' + name); process.exit(2) }
  const settings = sanitise({ ...DEFAULTS, profile: name, mode: opt('mode', DEFAULTS.mode), car: opt('car', DEFAULTS.car), cabin: !outside })
  const file = `rev-${name}${sceneName === 'drive' ? '' : '-' + sceneName}${recorded ? '-recorded' : ''}${recorded && optTag ? '-' + optTag : ''}${outside ? '-outside' : ''}.wav`
  const out = names.length === 1 && opt('out') ? opt('out') : path.join(opt('out-dir', '.'), file)
  render(settings, out)
}

function render(settings, out) {
const [script, seconds] = SCENES[sceneName]
const p = PROFILES[settings.profile]
const engine = new Engine(settings)
const sim = new SimCar(CARS[settings.car])
let voice
if (recorded) {
  // The same loops the car plays, decoded here by ffmpeg (the car's browser
  // decodes them itself).
  voice = new SampleVoice(SR)
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'sounds')
  // As RevSound.loadSet: the loops the options call for, each decoded once,
  // with every extra field passed through to the player.
  const decoded = new Map()
  const decode = (file) => {
    if (!decoded.has(file)) {
      const b = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, file), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
      decoded.set(file, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)))
    }
    return decoded.get(file)
  }
  voice.setSet({ options, loops: loopsFor(SAMPLE_SETS[settings.profile], options).map((l) => {
    const { file, src, render, start, seconds, level, exact, ...rest } = l
    return { ...rest, layer: l.layer || 'any', group: l.group || 'engine', gain: l.gain || 1, data: loopSlice(decode(l.file), SR, l), sr: SR }
  }) })
} else {
  voice = new EngineVoice(SR, 0x5eed)
  voice.setProfile(PROFILES[settings.profile])
}
voice.set({ gain: 1, exhaust: Number(opt('exhaust', DEFAULTS.exhaust)) })
const cabin = new Cabin(SR)
cabin.set({ cabin: settings.cabin })
cabin.mix = settings.cabin ? 1 : 0
// Then the loudness stage and the page's Volume slider (--volume 0..1,
// settings' default unless given), as the worklet does.
const loud = new Loudness(SR)
loud.set({ volume: Number(opt('volume', settings.volume)) })
loud.vol = loud.volTarget

const frames = Math.round(seconds / TICK) * BLOCK
const pcm = Buffer.alloc(frames * 4)
const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK)
let lastFix = -Infinity, w = 0, maxKmh = 0, maxGear = 0
for (let i = 0; i < seconds / TICK; i++) {
  const t = i * TICK, ms = t * 1000
  const { pedal = 0, brake = 0, rev = 0, sim: simMode = false, touch, lift } = script(t, p)
  const v = sim.step(pedal, brake, TICK)
  if (ms - lastFix >= fixMs) { lastFix = ms; engine.fix(ms, v) }
  engine.setRev(rev)
  if (simMode !== engine.sim) engine.setSim(simMode, ms)
  if (touch != null) engine.touch(touch === Infinity ? p.redline * 2 : touch)
  if (lift != null) engine.untouch(lift)
  const s = engine.step(ms, TICK)
  maxKmh = Math.max(maxKmh, v * 3.6); maxGear = Math.max(maxGear, s.gear)
  voice.set({ rpm: s.rpm, load: s.load, shifting: s.shifting, limiter: !!s.limiter, gear: s.gear })
  cabin.set({ load: s.load })
  // The browser renders in 128-frame quanta; do the same so filter updates
  // happen at the same rate.
  for (let o = 0; o < BLOCK; o += 128) {
    const n = Math.min(128, BLOCK - o)
    const outs = [L.subarray(o, o + n), R.subarray(o, o + n)]
    voice.render(outs, n)
    cabin.process(outs, n)
    loud.process(outs, n)
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
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, Buffer.concat([head, pcm]))
console.log(`${out}: ${seconds} s ${sceneName}${recorded ? ' (recorded)' : ''}, ${p.name} (${p.style}), ${settings.mode}, ${CARS[settings.car].name}; ` +
  `top ${maxKmh.toFixed(0)} km/h in gear ${maxGear}, speed fix every ${fixMs} ms, heard ${settings.cabin ? 'in the cabin' : 'outside'}`)
}
