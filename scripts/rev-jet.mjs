#!/usr/bin/env node
// rev-jet.mjs [--force]: our own turbojet, rendered into the same files
// engine-sim renders (.cache/engine-sim/out/<renders>/), so
// scripts/rev-samples.mjs cuts, levels and encodes the jet's loops exactly
// as it does the piston cars'. engine-sim models piston engines only.
//
//   node scripts/rev-jet.mjs                # every render the jet set needs
//   node scripts/rev-samples.mjs --print-levels jet
//   node scripts/rev-samples.mjs --car jet && node scripts/rev-samples.mjs --oneshots jet
//
// What a single-spool turbojet sounds like, and what this makes of it (the
// numbers are our own, chosen to suggest the type, not measured from any
// particular engine). Everything follows the spool speed N (rpm; the shaft
// turns at N/60 Hz) and n = N / the redline:
//
//   - Compressor blade-pass tones: each stage's blades sweep past at
//     blades x N/60 Hz, ~1.7-2.6 kHz for the first stages. The whine, and
//     what the intake (the engine group) is mostly heard as. Grows with n^2.
//   - "Buzz-saw": past ~85 % N the first stage's tips go supersonic and
//     every shaft order sounds, a ripping comb of tones at multiples of N/60.
//   - Turbine whine: more blades, faster: ~6-9 kHz, thin.
//   - Jet roar: the exhaust mixing with the air, broadband, peaking at a few
//     hundred Hz and rising steeply with the jet's speed (Lighthill: power ~
//     Vj^8; here ~n^4.5 in amplitude, ~15 dB from idle to full). What the exhaust group is mostly heard as. Scaled by `fuel`:
//     1 on-load (spooling up or held at power), less at part and on
//     overrun (spooling down), where the whine is left.
//   - Combustion rumble: below ~80 Hz, slowly breathing.
//   - Crackle: at high power, on-load, sparse sharp bursts in the exhaust.
//
// The start: an air-turbine starter's whine spools the core to ~20 %, the
// fuel lights off with a low whump, and the spool accelerates to idle. The
// stop: the fuel is cut, the roar dies, and the whine winds down.
//
// Deterministic: one seeded generator per file, so the same command gives
// the same files.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SETS, extrasPlan } from '../static/rev-samples.js'
import { PROFILES } from '../static/rev-profiles.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '.cache', 'engine-sim', 'out')
export const SR = 48000
const TAU = 2 * Math.PI
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// The sound's parts: shaft orders and their levels.
export const JET = {
  compressor: [[21, 1.0], [33, 0.6], [42, 0.35], [47, 0.4], [66, 0.2]],
  turbine: [[70, 0.25], [140, 0.08]],
  shaft: [[1, 0.15], [2, 0.1]],
  buzz: { from: 6, to: 40, start: 0.82, full: 0.97, level: 1.1 },
  roar: { level: 7.6, power: 4.5, peak: [70, 220] },   // peak: Hz at n = 0, extra at n = 1 (x n^2)
  rumble: { level: 5.5, hz: 70 },
  crackle: { rate: 45, from: 0.9, level: 2.2 },
  // How each place hears the parts: from the intake (engine), from behind
  // (exhaust), and dry, for the low sub layer.
  groups: {
    engine:  { tones: 1.0, buzz: 1.0, turbine: 0.35, roar: 0.35, rumble: 0.5, crackle: 0.2, starter: 1.0 },
    exhaust: { tones: 0.25, buzz: 0.45, turbine: 0.6, roar: 1.0, rumble: 1.0, crackle: 1.0, starter: 0.3 },
    dry:     { tones: 0.2, buzz: 0.2, turbine: 0, roar: 1.0, rumble: 1.0, crackle: 0.5, starter: 0.1 },
  },
  gain: 0.06,         // overall, so the loudest render stays well under full scale
  fuel: { on: 1, part: 0.45, off: 0.12, idle: 0.3 },
}

// A small seeded generator (mulberry32) and a hash for the seeds.
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }

// Smooth random movement in -1..1: white noise through two one-pole
// low-passes at `hz`.
function wander(r, hz) {
  const k = 1 - Math.exp(-TAU * hz / SR)
  let a = 0, b = 0
  return () => { a += ((r() * 2 - 1) * 3.4 - a) * k; b += (a - b) * k; return clamp(b * 2.2, -1, 1) }
}

// RBJ biquads (transposed direct form II), coefficients recomputed as the
// spool moves.
class Biquad {
  constructor() { this.z1 = 0; this.z2 = 0; this.c = [1, 0, 0, 0, 0] }
  set(type, f, q) {
    const w = TAU * Math.min(f, SR * 0.45) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al
    this.c = type === 'lp'
      ? [(1 - cs) / 2 / a0, (1 - cs) / a0, (1 - cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0]
      : [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0]
    return this
  }
  run(x) {
    const [b0, b1, b2, a1, a2] = this.c
    const y = b0 * x + this.z1
    this.z1 = b1 * x - a1 * y + this.z2
    this.z2 = b2 * x - a2 * y
    return y
  }
}

// Render `seconds` of the jet heard by `group`. path(t) gives
// { N, fuel, starter (0..1, its spool), whump (0..1) } at time t (s).
export function render({ seconds, group, redline, path: at, seed }) {
  const g = JET.groups[group], r = rng(seed), n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const tones = [
    ...JET.compressor.map(([o, a]) => ({ o, a: a * g.tones, p: 2 })),
    ...JET.turbine.map(([o, a]) => ({ o, a: a * g.turbine, p: 2 })),
    ...JET.shaft.map(([o, a]) => ({ o, a: a * g.tones, p: 1 })),
  ].filter((t) => t.a > 0).map((t) => ({ ...t, ph: r() * TAU, fm: wander(r, 0.7), am: wander(r, 2.5) }))
  // The buzz-saw comb: each shaft order with its own fixed level, as a real
  // fan's blades are each a little different.
  const buzz = []
  for (let o = JET.buzz.from; o <= JET.buzz.to; o++) buzz.push({ o, a: (0.25 + 0.75 * r()) / Math.sqrt(o), ph: r() * TAU, am: wander(r, 4) })
  const buzzSum = buzz.reduce((s, b) => s + b.a, 0)
  const hp = new Biquad(), lp = new Biquad(), lp2 = new Biquad(), rum = new Biquad().set('lp', JET.rumble.hz, 0.7)
  const rum2 = new Biquad().set('lp', JET.rumble.hz, 0.7), breathe = wander(r, 0.4)
  const crk = new Biquad().set('hp', 900, 0.7), whumpLp = new Biquad().set('lp', 140, 0.8)
  const st = { ph: 0, ph2: 0 }
  let shaft = 0, crackEnv = 0, crackAmp = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const s = at(t), N = Math.max(0, s.N), nn = N / redline, f = N / 60
    if ((i & 63) === 0) {
      const fp = JET.roar.peak[0] + JET.roar.peak[1] * nn * nn
      hp.set('hp', fp * 0.5, 0.6); lp.set('lp', fp * 3, 0.6); lp2.set('lp', fp * 9, 0.5)
    }
    shaft += TAU * f / SR
    let y = 0
    // Tones, each with a slight wander in pitch and level.
    for (const k of tones) {
      k.ph += TAU * k.o * f * (1 + 0.0025 * k.fm()) / SR
      y += k.a * Math.pow(nn, k.p) * Math.sin(k.ph) * (1 + 0.18 * k.am())
    }
    const bz = clamp((nn - JET.buzz.start) / (JET.buzz.full - JET.buzz.start), 0, 1)
    if (bz > 0 && g.buzz > 0) {
      let b = 0
      for (const k of buzz) { k.ph += TAU * k.o * f / SR; b += k.a * Math.sin(k.ph) * (1 + 0.3 * k.am()) }
      y += g.buzz * JET.buzz.level * Math.pow(bz, 1.5) * b / buzzSum * 3
    }
    // Roar: broadband noise, shaped around its peak, rising ~ n^6.
    const w = r() * 2 - 1
    const roar = lp2.run(lp.run(hp.run(w)))
    y += g.roar * JET.roar.level * s.fuel * Math.pow(nn, JET.roar.power) * roar
    // Rumble.
    const rm = rum2.run(rum.run(r() * 2 - 1))
    y += g.rumble * JET.rumble.level * (0.3 + 0.7 * s.fuel) * Math.pow(nn, 3) * (1 + 0.35 * breathe()) * rm
    // Crackle at high power, on-load.
    const cr = clamp((nn - JET.crackle.from) / (1 - JET.crackle.from), 0, 1) * clamp((s.fuel - 0.6) / 0.4, 0, 1)
    if (cr > 0 && r() < JET.crackle.rate * cr / SR) { crackEnv = 1; crackAmp = 0.4 + 0.6 * r() }
    if (crackEnv > 1e-4) { y += g.crackle * JET.crackle.level * crackAmp * crackEnv * crk.run(r() * 2 - 1); crackEnv *= Math.exp(-1 / (0.004 * SR)) }
    // The starter: an air turbine's whine, rising with its own spool.
    if (s.starter > 0 && g.starter > 0) {
      const fs_ = 2600 + 3400 * s.starter
      st.ph += TAU * fs_ / SR; st.ph2 += TAU * fs_ * 2.01 / SR
      y += g.starter * 0.12 * s.starterLevel * (Math.sin(st.ph) + 0.35 * Math.sin(st.ph2))
    }
    // The light-off: a low whump.
    if (s.whump > 0) y += 1.6 * s.whump * whumpLp.run(r() * 2 - 1) * (group === 'engine' ? 0.6 : 1)
    out[i] = y * JET.gain
  }
  void shaft
  return out
}

export function wav(file, x) {
  const b = Buffer.alloc(44 + x.length * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40)
  let clipped = 0
  for (let i = 0; i < x.length; i++) { const v = clamp(x[i], -1, 1); if (v !== x[i]) clipped++; b.writeInt16LE(Math.round(v * 32767), 44 + i * 2) }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, b)
  return clipped
}

const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u) }

// The renders a jet set needs, as engine-sim's would be named.
export function plan(car) {
  const set = SAMPLE_SETS[car], p = PROFILES[car], x = extrasPlan(set)
  const steady = (rpm, fuel) => (t) => ({ N: rpm, fuel, starter: 0, whump: 0 })
  const jobs = []
  const hold = (name, rpm, fuel, seconds) => jobs.push({ name, seconds, path: steady(rpm, fuel) })
  // A free-running idle wanders a little.
  jobs.push({ name: 'idle', seconds: 10, idle: true, path: null })
  for (const r of x.points) { hold(`on-${r}`, r, JET.fuel.on, 3.4); hold(`off-${r}`, r, JET.fuel.off, 3.4); hold(`on-${r}-5s`, r, JET.fuel.on, 5.4); hold(`off-${r}-5s`, r, JET.fuel.off, 5.4) }
  for (const r of x.dense) { hold(`on-${r}`, r, JET.fuel.on, 5.4); hold(`off-${r}`, r, JET.fuel.off, 5.4) }
  for (const r of [...x.points, ...x.dense]) hold(`part-${r}`, r, JET.fuel.part, 5.4)
  // The start: the starter spools the core to `lightOff` x redline by the
  // light-off, then the spool accelerates to idle over `spool` s.
  const os = set.oneshots, lo = os.start.catch, spool = os.start.spool, crank = os.crankRpm
  jobs.push({ name: 'start', seconds: 6, path: (t) => {
    const s0 = 0.15, sp = t < s0 ? 0 : 1 - Math.exp(-(t - s0) / 0.6)
    const nStart = crank * sp
    const u = (t - lo) / spool
    const N = t < lo ? nStart : nStart + (p.idle - nStart) * smooth(u)
    const fuel = t < lo ? 0 : JET.fuel.idle + (0.7 - JET.fuel.idle) * Math.exp(-(t - lo) / 0.8) * clamp((t - lo) / 0.08, 0, 1)
    const starterOn = t >= s0 && t < lo + 1.4
    return { N, fuel, starter: sp * (t < lo ? 1 : 1 + 0.5 * smooth(u)), starterLevel: starterOn ? Math.min(1, (t - s0) / 0.1) * (t < lo + 1.0 ? 1 : 1 - (t - lo - 1.0) / 0.4) : 0,
      whump: t >= lo ? Math.exp(-(t - lo) / 0.3) * clamp((t - lo) / 0.02, 0, 1) : 0 }
  } })
  // The stop: idling 0.4 s, then the fuel is cut and the spool winds down.
  jobs.push({ name: 'stop', seconds: os.stop.seconds + 0.5, path: (t) => {
    const u = Math.max(0, t - 0.4)
    return { N: p.idle * Math.exp(-u / 2.5), fuel: t < 0.4 ? JET.fuel.idle : JET.fuel.idle * Math.exp(-u / 0.15), starter: 0, whump: 0 }
  } })
  return { set, p, jobs }
}

export function renderAll(car, force = false) {
  const { set, p, jobs } = plan(car)
  const dirs = { engine: set.renders.engine, exhaust: set.renders.exhaust, dry: set.sub.renders }
  let made = 0, clipped = 0
  for (const [group, dir] of Object.entries(dirs)) {
    for (const j of jobs) {
      const file = path.join(OUT, dir, j.name + '.wav')
      if (!force && fs.existsSync(file)) continue
      const seed = hash(`${car}/${group}/${j.name}`)
      let pth = j.path
      if (j.idle) { const wr = wander(rng(seed ^ 0x9e3779b9), 0.6); pth = () => ({ N: p.idle * (1 + 0.004 * wr()), fuel: JET.fuel.idle, starter: 0, whump: 0 }) }
      const x = render({ seconds: j.seconds, group, redline: p.redline, path: pth, seed })
      clipped += wav(file, x)
      made++
    }
  }
  console.log(`${car}: ${made} renders${clipped ? `, ${clipped} samples clipped` : ''}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const [car, set] of Object.entries(SAMPLE_SETS)) if (set.kind === 'turbine') renderAll(car, process.argv.includes('--force'))
}
