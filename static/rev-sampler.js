// Recorded engine sound: plays loops cut from real recordings, each one
// recorded at a known rpm, and crossfades between them as the revs move.
//
//   rpm ──► the two loops either side of it ──► each resampled to sound at
//   this rpm (playback rate = rpm / loop rpm) ──► equal-power crossfade
//   load ──► on-load / off-load layers if the car has both, else a tone
//            filter and level that open up under load
//
// Every loop keeps playing (silently when it is not needed), so a crossfade
// never restarts one mid-cycle. Loops are made seamless when they are cut
// (scripts/rev-samples.mjs), so here a loop simply wraps.
//
// Like EngineVoice this is pure: the AudioWorklet runs it on the car's
// browser, and `node --test` and scripts/rev-render.mjs run it offline.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// How far one loop may be pitched before it sounds like a tape at the wrong
// speed. Past the top loop the engine still rises, just less convincingly.
export const MAX_RATE = 3.2

// Weights for each loop of one layer at `rpm`: the pair either side of it,
// crossfaded with equal power. `loops` must be sorted by rpm.
export function pairWeights(loops, rpm, out) {
  out.fill(0)
  const n = loops.length
  if (!n) return out
  if (rpm <= loops[0].rpm) { out[0] = 1; return out }
  if (rpm >= loops[n - 1].rpm) { out[n - 1] = 1; return out }
  let i = 0
  while (i < n - 2 && rpm > loops[i + 1].rpm) i++
  const t = (rpm - loops[i].rpm) / (loops[i + 1].rpm - loops[i].rpm)
  out[i] = Math.cos(t * Math.PI / 2)
  out[i + 1] = Math.sin(t * Math.PI / 2)
  return out
}

// How much of the on-load layer to use: off at a lift, full from light
// throttle up.
export function onLoadMix(load) { return clamp((load + 0.1) / 0.4, 0, 1) }

export class SampleVoice {
  constructor(sampleRate) {
    this.sr = sampleRate
    this.rpm = 800; this.rpmTarget = 800
    this.load = 0; this.loadTarget = 0
    this.gain = 0; this.gainTarget = 0
    this.loops = []
    this.lp = 0 // one-pole tone filter state
  }

  // set: { loops: [{ rpm, layer: 'on' | 'off' | 'any', gain?, data: Float32Array, sr }] }
  // set: { loops: [{ rpm, layer: 'on' | 'off' | 'any', group?: 'engine' |
  // 'exhaust', gain?, data: Float32Array, sr }] }
  setSet(set) {
    const loops = (set && set.loops ? set.loops : [])
      .filter((l) => l && l.data && l.data.length > 1 && l.rpm > 0 && l.sr > 0)
      .map((l) => ({ rpm: l.rpm, layer: l.layer || 'any', group: l.group || 'engine', gain: l.gain || 1, data: l.data, sr: l.sr, pos: 0, w: 0, wTarget: 0 }))
      .sort((a, b) => a.rpm - b.rpm)
    // Start each loop at a different point, so two loops of one recording
    // never line up into a comb.
    loops.forEach((l, i) => { l.pos = (l.data.length * 0.37 * i) % l.data.length })
    this.loops = loops
    // Each group (the same engine heard from the engine or the exhaust) is
    // weighted on its own, by rpm and load, then scaled by the mix.
    this.groups = {}
    for (const l of loops) {
      const g = (this.groups[l.group] ||= { loops: [], layers: {} })
      g.loops.push(l)
      ;(g.layers[l.layer] ||= []).push(l)
    }
    for (const g of Object.values(this.groups)) {
      g.split = !!(g.layers.on && g.layers.off)
      g.weights = {}
      for (const [k, ls] of Object.entries(g.layers)) g.weights[k] = new Float64Array(ls.length)
      g.allW = new Float64Array(g.loops.length)
    }
    this.split = loops.length > 0 && Object.values(this.groups).every((g) => g.split)
  }
  get ready() { return this.loops.length > 0 }

  // exhaust: 0 = all engine, 1 = all exhaust (only with both groups).
  set({ rpm, load, gain, exhaust }) {
    if (Number.isFinite(rpm)) this.rpmTarget = Math.max(100, rpm)
    if (Number.isFinite(load)) this.loadTarget = clamp(load, -1, 1)
    if (Number.isFinite(gain)) this.gainTarget = clamp(gain, 0, 1)
    if (Number.isFinite(exhaust)) this.exhaust = clamp(exhaust, 0, 1)
  }

  // How loud each group plays. The groups' loops start at different points,
  // so they add up incoherently: an equal-power crossfade keeps the level
  // steady across the setting.
  groupGain(name) {
    if (!(this.groups.engine && this.groups.exhaust)) return 1
    const m = this.exhaust ?? 0.5
    return name === 'exhaust' ? Math.sqrt(m) : name === 'engine' ? Math.sqrt(1 - m) : 0
  }

  // The weight every loop should have now.
  targets() {
    const rpm = this.rpm
    const on = onLoadMix(this.load)
    for (const [name, g] of Object.entries(this.groups)) {
      const gg = this.groupGain(name)
      if (g.split) {
        for (const [k, ls] of Object.entries(g.layers)) {
          const w = pairWeights(ls, rpm, g.weights[k])
          const m = k === 'on' ? on : k === 'off' ? 1 - on : 0
          ls.forEach((l, i) => { l.wTarget = w[i] * Math.sqrt(m) * gg })
        }
      } else {
        const w = pairWeights(g.loops, rpm, g.allW)
        g.loops.forEach((l, i) => { l.wTarget = w[i] * gg })
      }
    }
  }

  render(outs, n) {
    if (!this.loops.length) { for (const o of outs) o.fill(0, 0, n); return }
    const sr = this.sr
    const kRpm = 1 - Math.exp(-1 / (0.015 * sr))
    const kGain = 1 - Math.exp(-1 / (0.05 * sr))
    // Per block: where the crossfade is heading; ramped per sample below so
    // a block boundary never clicks.
    const rpm0 = this.rpm
    this.rpm += (this.rpmTarget - this.rpm) * (1 - Math.pow(1 - kRpm, n))
    this.load += (this.loadTarget - this.load) * (1 - Math.pow(1 - kRpm, n))
    this.targets()
    // With a single layer, load opens a tone filter and raises the level,
    // the way a real engine gets louder and brighter on the throttle.
    const pos = Math.max(0, this.load)
    const level = this.split ? 1 : 0.6 + 0.4 * pos + (this.load < 0 ? -0.1 * this.load : 0)
    const cut = this.split ? 1 : 0.18 + 0.82 * Math.min(1, 0.35 + pos)
    const a = clamp(cut, 0.02, 1)
    for (const l of this.loops) l.dw = (l.wTarget - l.w) / n

    const out0 = outs[0]
    for (let i = 0; i < n; i++) {
      const r = rpm0 + (this.rpm - rpm0) * (i / n)
      this.gain += (this.gainTarget - this.gain) * kGain
      let s = 0
      for (const l of this.loops) {
        l.w += l.dw
        const rate = clamp(r / l.rpm, 1 / MAX_RATE, MAX_RATE) * (l.sr / sr)
        const d = l.data, len = d.length
        // Advance every loop, heard or not, so its phase stays continuous.
        if (l.w > 1e-4) {
          const k = Math.floor(l.pos), f = l.pos - k
          const v = d[k] + (d[k + 1 < len ? k + 1 : 0] - d[k]) * f
          s += v * l.w * l.gain
        }
        l.pos += rate
        if (l.pos >= len) l.pos -= len
      }
      this.lp += (s - this.lp) * a
      const y = clamp(this.lp * level * this.gain, -1, 1)
      out0[i] = y
    }
    for (let c = 1; c < outs.length; c++) outs[c].set(out0.subarray(0, n))
  }
}
