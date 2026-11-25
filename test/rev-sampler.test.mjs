// The recorded-engine player (static/rev-sampler.js), driven with synthetic
// loops so the tests need no audio files or decoder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SampleVoice, pairWeights, onLoadMix, MAX_RATE, rpmLoudness, IDLE_LOUDNESS, throttlePlace, throttleMix, PART_LOAD, LIMITER_HOLD, clipRpm } from '../static/rev-sampler.js'

const SR = 48000
// A loop that is exactly `cycles` periods of a sine at `hz`: seamless.
function sineLoop(hz, cycles = 40, sr = SR) {
  const n = Math.round((cycles * sr) / hz)
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * i * cycles) / n)
  return d
}
function render(v, seconds, each) {
  const L = new Float32Array(128), R = new Float32Array(128)
  const out = new Float32Array(Math.round((seconds * SR) / 128) * 128)
  for (let b = 0; b < out.length / 128; b++) {
    if (each) each(b * 128 / SR)
    v.render([L, R], 128)
    out.set(L, b * 128)
    for (let i = 0; i < 128; i++) assert.equal(L[i], R[i])
  }
  return out
}
// Energy at one frequency (Goertzel), normalised.
function power(a, hz) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (const x of a) { const s0 = x + c * s1 - s2; s2 = s1; s1 = s0 }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (a.length * a.length)
}
function pitch(a) {
  let z = 0
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) z++
  return (z * SR) / a.length
}
// Flat loudness (quiet: 1) unless a test asks: these check the loops.
const voice = (loops, params = {}, quiet = 1) => {
  const v = new SampleVoice(SR)
  v.setSet({ loops, quiet })
  v.rpm = params.rpm ?? 1000; v.load = params.load ?? 0; v.gain = 1
  v.set({ rpm: params.rpm ?? 1000, load: params.load ?? 0, gain: 1 })
  return v
}

test('the two loops either side of the rpm share it with equal power', () => {
  const loops = [{ rpm: 1000 }, { rpm: 3000 }, { rpm: 6000 }]
  const w = new Float64Array(3)
  assert.deepEqual([...pairWeights(loops, 500, w)], [1, 0, 0])
  assert.deepEqual([...pairWeights(loops, 9000, w)], [0, 0, 1])
  assert.deepEqual([...pairWeights(loops, 3000, w)].map((x) => Math.round(x * 1e9) / 1e9), [0, 1, 0])
  for (const rpm of [1200, 2000, 2999, 3001, 4500, 5900]) {
    pairWeights(loops, rpm, w)
    assert.ok(Math.abs(w[0] ** 2 + w[1] ** 2 + w[2] ** 2 - 1) < 1e-9, `${rpm}`)
    assert.ok(w.filter((x) => x > 0).length <= 2)
  }
  pairWeights(loops, 2000, w)
  assert.ok(Math.abs(w[0] - w[1]) < 1e-9, 'halfway is half and half')
  assert.equal(pairWeights([], 2000, new Float64Array(0)).length, 0)
})

test('a loop recorded at one rpm is played at the pitch of the engine', () => {
  // A 100 Hz loop "recorded at 2000 rpm" played at 3000 rpm sounds at 150 Hz.
  const v = voice([{ rpm: 2000, data: sineLoop(100), sr: SR }], { rpm: 3000 })
  const out = render(v, 1)
  assert.ok(Math.abs(pitch(out) - 150) < 2, `pitch ${pitch(out)}`)
  // A loop at another sample rate is played at the right speed too.
  const w = voice([{ rpm: 2000, data: sineLoop(100, 40, 44100), sr: 44100 }], { rpm: 2000 })
  assert.ok(Math.abs(pitch(render(w, 1)) - 100) < 2)
})

test('between two loops both are heard, crossfaded', () => {
  const v = voice([{ rpm: 1000, data: sineLoop(110), sr: SR }, { rpm: 4000, data: sineLoop(170), sr: SR }], { rpm: 2500 })
  const out = render(v, 1)
  // At 2500 rpm the 1000 rpm loop is pitched to 275 Hz, the 4000 rpm one to
  // 106.25 Hz, and they are mixed half and half.
  const a = power(out, 275), b = power(out, 106.25)
  assert.ok(a > 0.01 && b > 0.01 && Math.abs(Math.log(a / b)) < 0.5, `${a} vs ${b}`)
})

test('a sweep through every loop has no clicks, and wraps seamlessly', () => {
  const loops = [800, 2000, 3500, 5000, 6500].map((rpm, i) => ({ rpm, data: sineLoop(60 + 15 * i, 7), sr: SR }))
  const v = voice(loops, { rpm: 800 })
  let worst = 0, prev = 0
  const out = render(v, 3, (t) => v.set({ rpm: 800 + (5700 * Math.min(t, 2.5)) / 2.5 }))
  for (let i = 1; i < out.length; i++) { worst = Math.max(worst, Math.abs(out[i] - prev)); prev = out[i] }
  // The fastest a 0.5-amplitude sine near 330 Hz can move between samples
  // is ~0.022; anything far above that is a click.
  assert.ok(worst < 0.05, `largest step ${worst}`)
  for (const x of out) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1)
})

test('pitch is limited past the last loop rather than running away', () => {
  const v = voice([{ rpm: 1000, data: sineLoop(100), sr: SR }], { rpm: 20000 })
  assert.ok(Math.abs(pitch(render(v, 1)) - 100 * MAX_RATE) < 3)
})

test('with on-load and off-load layers, load picks the layer', () => {
  const loops = [
    { rpm: 3000, layer: 'on', data: sineLoop(150), sr: SR },
    { rpm: 3000, layer: 'off', data: sineLoop(90), sr: SR },
  ]
  const pull = render(voice(loops, { rpm: 3000, load: 1 }), 0.5)
  const lift = render(voice(loops, { rpm: 3000, load: -0.6 }), 0.5)
  assert.ok(power(pull, 150) > 20 * power(pull, 90), 'pulling plays the on-load loop')
  assert.ok(power(lift, 90) > 20 * power(lift, 150), 'lifting plays the off-load loop')
  assert.equal(onLoadMix(-1), 0)
  assert.equal(onLoadMix(1), 1)
})

test('the idle plays quieter, and the engine gets louder evenly with the rpm', () => {
  assert.equal(rpmLoudness(800, 800, 6000), IDLE_LOUDNESS)
  assert.equal(rpmLoudness(500, 800, 6000), IDLE_LOUDNESS)
  assert.equal(rpmLoudness(6000, 800, 6000), 1)
  assert.equal(rpmLoudness(9000, 800, 6000), 1)
  // Even in decibels: halfway is the geometric middle.
  assert.ok(Math.abs(rpmLoudness(3400, 800, 6000) - Math.sqrt(IDLE_LOUDNESS)) < 1e-12)
  let prev = 0
  for (let r = 800; r <= 6000; r += 100) { const g = rpmLoudness(r, 800, 6000); assert.ok(g > prev); prev = g }
  assert.equal(rpmLoudness(1000, 1000, 1000), 1, 'one loop: flat')
  // In the player: the same loop, one at idle and one at the top.
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length)
  const loops = [{ rpm: 1000, data: sineLoop(100), sr: SR }, { rpm: 5000, data: sineLoop(100), sr: SR }]
  const idle = rms(render(voice(loops, { rpm: 1000 }, null), 0.5))
  const top = rms(render(voice(loops, { rpm: 5000 }, null), 0.5))
  assert.ok(Math.abs(idle / top - IDLE_LOUDNESS) < 0.02, `${idle / top}`)
})

test('with one layer, load makes it louder', () => {
  const loops = [{ rpm: 3000, data: sineLoop(150), sr: SR }]
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length)
  const pull = rms(render(voice(loops, { rpm: 3000, load: 1 }), 0.5))
  const cruise = rms(render(voice(loops, { rpm: 3000, load: 0 }), 0.5))
  assert.ok(pull > cruise * 1.3, `${pull} vs ${cruise}`)
})

test('nothing loaded, bad loops or zero gain: silence', () => {
  const L = new Float32Array(128).fill(1)
  const v = new SampleVoice(SR)
  assert.equal(v.ready, false)
  v.render([L], 128)
  assert.ok(L.every((x) => x === 0))
  v.setSet({ loops: [{ rpm: 0, data: sineLoop(100), sr: SR }, { rpm: 1000, data: new Float32Array(0), sr: SR }, null] })
  assert.equal(v.ready, false)
  const z = voice([{ rpm: 1000, data: sineLoop(100), sr: SR }], { rpm: 1000 })
  z.gain = 0; z.set({ gain: 0 })
  assert.ok(render(z, 0.2).every((x) => x === 0))
  v.setSet(null)
  assert.equal(v.ready, false)
})

test('the exhaust setting crossfades the engine and exhaust groups', () => {
  const loops = [
    { rpm: 3000, layer: 'on', group: 'engine', data: sineLoop(150), sr: SR },
    { rpm: 3000, layer: 'off', group: 'engine', data: sineLoop(150), sr: SR },
    { rpm: 3000, layer: 'on', group: 'exhaust', data: sineLoop(90), sr: SR },
    { rpm: 3000, layer: 'off', group: 'exhaust', data: sineLoop(90), sr: SR },
  ]
  const mix = (exhaust) => {
    const v = voice(loops, { rpm: 3000, load: 1 })
    v.set({ exhaust }); v.exhaust = exhaust
    return render(v, 0.5)
  }
  const engine = mix(0), exhaust = mix(1), both = mix(0.5)
  assert.ok(power(engine, 150) > 100 * power(engine, 90), 'all engine')
  assert.ok(power(exhaust, 90) > 100 * power(exhaust, 150), 'all exhaust')
  const r = power(both, 150) / power(both, 90)
  assert.ok(r > 0.5 && r < 2, `half and half: ${r}`)
  // A car with only one group plays it whatever the setting.
  const solo = voice([{ rpm: 3000, data: sineLoop(150), sr: SR }], { rpm: 3000 })
  solo.set({ exhaust: 1 })
  assert.ok(power(render(solo, 0.3), 150) > 0.01)
})

// ── The recorded mix's options (rev-samples.js loopsFor) ──────────────────

// The player as it was before the options (commit 3c71730), kept here to
// prove that a set without them still plays exactly, to the bit, as it did.
class OldVoice {
  constructor(sr) { this.sr = sr; this.rpm = 800; this.rpmTarget = 800; this.load = 0; this.loadTarget = 0; this.gain = 0; this.gainTarget = 0; this.loops = []; this.lp = 0 }
  setSet(set) {
    const loops = set.loops.map((l) => ({ rpm: l.rpm, layer: l.layer || 'any', group: l.group || 'engine', gain: l.gain || 1, data: l.data, sr: l.sr, pos: 0, w: 0, wTarget: 0 })).sort((a, b) => a.rpm - b.rpm)
    loops.forEach((l, i) => { l.pos = (l.data.length * 0.37 * i) % l.data.length })
    this.loops = loops; this.quiet = Number.isFinite(set.quiet) ? set.quiet : IDLE_LOUDNESS
    this.idleRpm = loops[0].rpm; this.topRpm = loops[loops.length - 1].rpm
    this.groups = {}
    for (const l of loops) { const g = (this.groups[l.group] ||= { loops: [], layers: {} }); g.loops.push(l); (g.layers[l.layer] ||= []).push(l) }
    for (const g of Object.values(this.groups)) { g.split = !!(g.layers.on && g.layers.off); g.weights = {}; for (const [k, ls] of Object.entries(g.layers)) g.weights[k] = new Float64Array(ls.length); g.allW = new Float64Array(g.loops.length) }
    this.split = Object.values(this.groups).every((g) => g.split)
  }
  set({ rpm, load, gain, exhaust }) {
    if (Number.isFinite(rpm)) this.rpmTarget = Math.max(100, rpm)
    if (Number.isFinite(load)) this.loadTarget = Math.min(1, Math.max(-1, load))
    if (Number.isFinite(gain)) this.gainTarget = Math.min(1, Math.max(0, gain))
    if (Number.isFinite(exhaust)) this.exhaust = Math.min(1, Math.max(0, exhaust))
  }
  groupGain(name) { if (!(this.groups.engine && this.groups.exhaust)) return 1; const m = this.exhaust ?? 0.5; return name === 'exhaust' ? Math.sqrt(m) : name === 'engine' ? Math.sqrt(1 - m) : 0 }
  targets() {
    const on = onLoadMix(this.load)
    for (const [name, g] of Object.entries(this.groups)) {
      const gg = this.groupGain(name)
      if (g.split) for (const [k, ls] of Object.entries(g.layers)) { const w = pairWeights(ls, this.rpm, g.weights[k]); const m = k === 'on' ? on : k === 'off' ? 1 - on : 0; ls.forEach((l, i) => { l.wTarget = w[i] * Math.sqrt(m) * gg }) }
      else { const w = pairWeights(g.loops, this.rpm, g.allW); g.loops.forEach((l, i) => { l.wTarget = w[i] * gg }) }
    }
  }
  render(outs, n) {
    const sr = this.sr, clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
    const kRpm = 1 - Math.exp(-1 / (0.015 * sr)), kGain = 1 - Math.exp(-1 / (0.05 * sr))
    const rpm0 = this.rpm
    this.rpm += (this.rpmTarget - this.rpm) * (1 - Math.pow(1 - kRpm, n))
    this.load += (this.loadTarget - this.load) * (1 - Math.pow(1 - kRpm, n))
    this.targets()
    const pos = Math.max(0, this.load)
    const level = this.split ? 1 : 0.6 + 0.4 * pos + (this.load < 0 ? -0.1 * this.load : 0)
    const a = clamp(this.split ? 1 : 0.18 + 0.82 * Math.min(1, 0.35 + pos), 0.02, 1)
    for (const l of this.loops) l.dw = (l.wTarget - l.w) / n
    const loud0 = rpmLoudness(rpm0, this.idleRpm, this.topRpm, this.quiet)
    const dLoud = (rpmLoudness(this.rpm, this.idleRpm, this.topRpm, this.quiet) - loud0) / n
    for (let i = 0; i < n; i++) {
      const r = rpm0 + (this.rpm - rpm0) * (i / n)
      this.gain += (this.gainTarget - this.gain) * kGain
      let s = 0
      for (const l of this.loops) {
        l.w += l.dw
        const rate = clamp(r / l.rpm, 1 / MAX_RATE, MAX_RATE) * (l.sr / sr), d = l.data, len = d.length
        if (l.w > 1e-4) { const k = Math.floor(l.pos), f = l.pos - k; s += (d[k] + (d[k + 1 < len ? k + 1 : 0] - d[k]) * f) * l.w * l.gain }
        l.pos += rate
        if (l.pos >= len) l.pos -= len
      }
      this.lp += (s - this.lp) * a
      outs[0][i] = clamp(this.lp * level * this.gain * (loud0 + dLoud * i), -1, 1)
    }
  }
}

// A small engine: on/off at four rev points and an idle, two groups, each
// a different tone so every loop can be told apart.
function engineLoops({ part = false, limiter = false, shifts = false } = {}) {
  const loops = []
  for (const [gi, group] of ['engine', 'exhaust'].entries()) {
    for (const layer of ['on', 'off', ...(part ? ['part'] : [])]) loops.push({ rpm: 800, layer, group, data: sineLoop(40 + gi, 9), sr: SR })
    for (const [i, rpm] of [1500, 3000, 4500, 6000].entries()) {
      loops.push({ rpm, layer: 'on', group, data: sineLoop(150 + 10 * i + gi, 13), sr: SR })
      loops.push({ rpm, layer: 'off', group, data: sineLoop(90 + 10 * i + gi, 11), sr: SR })
      if (part) loops.push({ rpm, layer: 'part', group, torque: 0.2, data: sineLoop(120 + 10 * i + gi, 12), sr: SR })
    }
    if (limiter) loops.push({ rpm: 6500, layer: 'limiter', group, cut: 0.1, data: sineLoop(333, 30), sr: SR })
    if (shifts) for (const [from, hz] of [[3500, 444], [5500, 555]]) {
      const d = new Float32Array(Math.round(0.75 * SR))
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR)
      loops.push({ rpm: from, layer: 'shift', group, from, to: Math.round(from * 0.7), at: 0.1, cut: 0.14, data: d, sr: SR })
    }
  }
  return loops
}
// A click is a corner in the waveform: the largest second difference. A
// 0.5 sine at 600 Hz has 0.004; a step of 0.02 in it, 0.02.
const corner = (a) => { let worst = 0; for (let i = 2; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - 2 * a[i - 1] + a[i - 2])); return worst }

test('with no option on, the player is the one it was, to the bit', () => {
  const loops = engineLoops()
  for (const quiet of [1, undefined]) {
    const a = new SampleVoice(SR), b = new OldVoice(SR)
    a.setSet({ loops, quiet }); b.setSet({ loops, quiet })
    const L = new Float32Array(128), R = new Float32Array(128), M = new Float32Array(128)
    for (let blk = 0; blk < 1500; blk++) {
      const t = blk * 128 / SR
      // A sweep up and down with the load swinging through lift and pull,
      // the exhaust setting moving, and the one-shot params a newer page sends.
      const p = { rpm: 800 + 5500 * (0.5 - 0.5 * Math.cos(t * 2.2)), load: Math.sin(t * 3.1), gain: 0.8, exhaust: 0.5 + 0.4 * Math.sin(t), shifting: blk % 200 < 7, gear: 1 + Math.floor(blk / 200), limiter: blk % 300 < 40 }
      a.set(p); b.set(p)
      a.render([L, R], 128); b.render([M], 128)
      for (let i = 0; i < 128; i++) if (L[i] !== M[i]) assert.fail(`block ${blk} sample ${i}: ${L[i]} vs ${M[i]}`)
    }
  }
})

test('light throttle: load maps onto overrun, part and full, cruise on the part layer', () => {
  assert.equal(throttlePlace(-1), 0)
  assert.equal(throttlePlace(PART_LOAD.lift), 0)
  for (const cruise of [0.02, 0.05, 0.08, 0.12]) assert.equal(throttlePlace(cruise), 1, `cruise ${cruise}`)
  assert.equal(throttlePlace(0.5), 2)
  assert.equal(throttlePlace(1), 2)
  let prev = -1
  for (let l = -1; l <= 1; l += 0.01) {
    const x = throttlePlace(l)
    assert.ok(x >= prev, `monotonic at ${l}`); prev = x
    const [o, p, f] = throttleMix(x)
    assert.ok(Math.abs(o * o + p * p + f * f - 1) < 1e-12, `equal power at ${l}`)
    assert.ok(o === 0 || f === 0, 'never overrun and full together')
  }
  // In the player: at 3000 rpm, cruise plays the part loop, a pull the
  // on-load one, a lift the overrun, a gentle pull some of both.
  const loops = engineLoops({ part: true }).filter((l) => l.group === 'engine')
  const at = (load) => render(voice(loops, { rpm: 3000, load }), 0.4).subarray(SR * 0.1)
  const cruise = at(0.05), pull = at(1), lift = at(-0.6), gentle = at(0.3)
  // At 3000 rpm (the second rev point) on-load is 160 Hz, part 130, overrun 100.
  assert.ok(power(cruise, 130) > 50 * Math.max(power(cruise, 160), power(cruise, 100)), 'cruise is the part layer')
  assert.ok(power(pull, 160) > 50 * power(pull, 130), 'a pull is full throttle')
  assert.ok(power(lift, 100) > 50 * power(lift, 130), 'a lift is overrun')
  assert.ok(power(gentle, 130) > 0.2 * power(gentle, 160) && power(gentle, 160) > 0.2 * power(gentle, 130), 'a gentle pull blends part and full')
})

test('the limiter loop takes over on the limiter and hands back cleanly', () => {
  const loops = engineLoops({ limiter: true })
  const v = voice(loops, { rpm: 6400, load: 1 })
  // On the limiter for 0.5 s with the throttle pushing between cuts, then
  // off it (the revs fall away).
  const out = render(v, 1, (t) => {
    const on = t >= 0.2 && t < 0.7
    v.set({ rpm: on ? 6450 : t < 0.2 ? 6400 : 5000, limiter: on, load: on ? (Math.floor(t / 0.06) % 2 ? 0.8 : -0.6) : t < 0.2 ? 1 : -0.6 })
  })
  const seg = (a, b) => out.subarray(Math.round(a * SR), Math.round(b * SR))
  assert.ok(power(seg(0.3, 0.65), 333) > 30 * power(seg(0.3, 0.65), 180), 'on the limiter: the limiter loop')
  const lim = power(seg(0.3, 0.65), 333)
  assert.ok(power(seg(0.05, 0.19), 333) < 1e-3 * lim, 'before: not a trace of it')
  assert.ok(power(seg(0.85, 1), 333) < 1e-3 * lim, 'after: gone')
  assert.ok(corner(out) < 0.012, `no click: sharpest corner ${corner(out)}`)
  // A finger lifted in the red: the model still says limiter for 0.3 s,
  // but nothing pushes, so it leaves after the cut and LIMITER_HOLD.
  const w = voice(loops, { rpm: 6450, load: 1 })
  const out2 = render(w, 0.6, (t) => w.set({ rpm: 6450 - 3000 * Math.max(0, t - 0.2), limiter: true, load: t < 0.2 ? (Math.floor(t / 0.06) % 2 ? 0.8 : -0.6) : -0.6 }))
  const late = out2.subarray(Math.round((0.2 + 0.1 + LIMITER_HOLD + 0.08) * SR))
  assert.ok(power(late, 333) < 0.01 * power(out2.subarray(Math.round(0.1 * SR), Math.round(0.19 * SR)), 333), 'lifted: it lets go')
  // Without a limiter loop the same params change nothing.
  const plain = engineLoops()
  const a = voice(plain, { rpm: 6400, load: 1 }), b = voice(plain, { rpm: 6400, load: 1 })
  const ra = render(a, 0.3, (t) => a.set({ rpm: 6450, load: 0.8, limiter: true }))
  const rb = render(b, 0.3, (t) => b.set({ rpm: 6450, load: 0.8 }))
  assert.deepEqual(ra, rb)
})

test('an upshift under load plays the shift clip, pitched with the revs, and hands back to the loops', () => {
  const loops = engineLoops({ shifts: true })
  // The model: pulling in 2nd at 5400 rpm, shifts up at 0.2 s: the revs fall
  // with its 60 ms time constant to 3800, the load cut for 140 ms.
  const drive = (v, pre = 1, dir = +1) => render(v, 1, (t) => {
    const u = t - 0.2, shifting = u >= 0 && u < (dir > 0 ? 0.14 : 0.09)
    const rpm = u < 0 ? 5400 : dir > 0 ? 3800 + 1600 * Math.exp(-u / 0.06) : 5400 + 1000 * (1 - Math.exp(-u / 0.06))
    v.set({ rpm, gear: u < 0 ? 2 : 2 + dir, shifting, load: shifting && dir > 0 ? Math.min(pre, -0.15) : pre })
  })
  const v = voice(loops, { rpm: 5400, load: 1 }); v.set({ gear: 2 })
  const out = drive(v)
  const seg = (a, b) => out.subarray(Math.round(a * SR), Math.round(b * SR))
  // The clip from 5500 rpm is nearest 5400: its tone, pitched by 5400/5500
  // before the cut, is what plays across the shift.
  const hz = 555 * 5400 / 5500
  const clip = power(seg(0.2, 0.28), hz)
  assert.ok(clip > 10 * power(seg(0.2, 0.28), 444 * 5400 / 3500), 'the nearest clip')
  assert.ok(power(seg(0.05, 0.19), hz) < 1e-3 * clip, 'nothing before the shift')
  assert.ok(power(seg(0.9, 1), 555 * 3800 / 3850) < 1e-3 * clip, 'back on the loops after')
  assert.ok(v.shot === null, 'the clip is done')
  assert.ok(corner(out) < 0.012, `no click: sharpest corner ${corner(out)}`)
  // The clip is pitched so its own recorded rpm follows the model's: just
  // after the cut has done most of the fall, its tone sits where the
  // model's rpm puts it (444/555 Hz at `from`, scaled by rpm / clipRpm).
  const shot = { from: 5500, to: 3850, at: 0.1, cut: 0.14 }
  assert.equal(clipRpm(shot, 0.05), 5500)
  assert.ok(Math.abs(clipRpm(shot, 0.1 + 0.06) - (3850 + 1650 / Math.E)) < 1e-9)
  assert.ok(clipRpm(shot, 0.7) < 3850 + 20)
  // A light-throttle upshift, a downshift, or no clips: no clip.
  const light = voice(loops, { rpm: 5400, load: 0.05 }); light.set({ gear: 2 })
  drive(light, 0.05)
  assert.ok(light.shot === null)
  const down = voice(loops, { rpm: 5400, load: 1 }); down.set({ gear: 3 })
  let started = false
  render(down, 0.5, (t) => { down.set({ rpm: 5400, gear: t < 0.2 ? 3 : 2, shifting: t >= 0.2 && t < 0.29, load: 1 }); started ||= !!down.shot })
  assert.ok(!started, 'a downshift has no cut')
  const plain = engineLoops()
  const a = voice(plain, { rpm: 5400, load: 1 }), b = voice(plain, { rpm: 5400, load: 1 })
  a.set({ gear: 2 })
  const ra = render(a, 0.5, (t) => a.set({ rpm: t < 0.2 ? 5400 : 3800, gear: t < 0.2 ? 2 : 3, shifting: t >= 0.2 && t < 0.34, load: t >= 0.2 && t < 0.34 ? -0.15 : 1 }))
  const rb = render(b, 0.5, (t) => b.set({ rpm: t < 0.2 ? 5400 : 3800, load: t >= 0.2 && t < 0.34 ? -0.15 : 1 }))
  assert.deepEqual(ra, rb, 'without clips the shift params change nothing')
})

test('many loops stay cheap: a loop unheard for a block is not interpolated', () => {
  const v = voice(engineLoops({ part: true, limiter: true, shifts: true }), { rpm: 3000, load: 0.05 })
  render(v, 0.2)
  const heard = v.loops.filter((l) => l.w > 1e-4).length
  assert.ok(heard <= 8, `${heard} of ${v.loops.length} loops heard at once`)
})

test('with light throttle on, the idle is the idle it was: the part layer lends its weight to the own idles', () => {
  // Numbered as rev-samples.js withPhases does: the own loops by rpm, the
  // options' after them, so the own loops start where they always did.
  const own = engineLoops()
  const order = own.map((l, i) => [l, i]).sort((a, b) => a[0].rpm - b[0].rpm)
  order.forEach(([l], k) => { l.phaseIndex = k })
  const extra = engineLoops({ part: true }).filter((l) => l.layer === 'part').map((l, i) => ({ ...l, phaseIndex: own.length + i, alias: l.rpm === 800 ? 'idle' : undefined }))
  const plain = voice(own, { rpm: 800, load: 0 }), part = voice([...own, ...extra], { rpm: 800, load: 0 })
  const a = render(plain, 0.5), b = render(part, 0.5)
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  assert.ok(worst < 1e-6, `idle differs by ${worst}`)
  // Off idle, cruising, it is the part layer that plays.
  const c = render(voice([...own, ...extra], { rpm: 3000, load: 0.05 }), 0.3).subarray(SR * 0.1)
  assert.ok(power(c, 130) > 50 * power(c, 160))
})

test('a one-shot comes in at the level the rev loops are actually playing at', () => {
  // Two rev loops of one tone, in phase: they add up 3 dB over their levels.
  // The limiter loop follows that, rather than its own nominal level.
  const tone = sineLoop(150, 30)
  const loops = [{ rpm: 6000, layer: 'on', data: tone, sr: SR, phaseIndex: 0 }, { rpm: 6000, layer: 'off', data: tone, sr: SR, phaseIndex: 0 },
    { rpm: 6500, layer: 'limiter', cut: 0.1, data: sineLoop(333, 30), sr: SR }]
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)
  // Load 0.1: half on-load, half overrun, the two in phase.
  const v = voice(loops, { rpm: 6000, load: 0.1 })
  const before = rms(render(v, 0.4).subarray(SR * 0.2))
  assert.ok(Math.abs(20 * Math.log10(before / rms(tone)) - 3) < 0.3, 'the loops play 3 dB over their level')
  const on = rms(render(v, 0.4, () => v.set({ limiter: true, load: 0.1 })).subarray(SR * 0.2))
  assert.ok(Math.abs(20 * Math.log10(on / before)) < 0.5, `limiter ${on} vs loops ${before}`)
})
