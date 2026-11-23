// Engine-sound synthesiser, run as an AudioWorklet on the car's own browser.
//
// One engine cycle is 720° of crank. Each cylinder fires once per cycle at
// its own point in it; every firing sends a short pressure pulse down its
// bank's exhaust, and the pipe's resonances turn that train of pulses into
// the note. So the pitch is the firing rate (rpm / 120 × cylinders), the
// character is the firing pattern and the pipes, and load is how hard each
// pulse hits and how bright the result is.
//
//   firing ──► pulse ──► bank resonators ─┐
//                                         ├─► tone filter ─► saturation ─► gain
//   induction noise (gated by pulses) ────┘
//   turbo whistle and blow-off (if the engine has one) ───────────► mixed after
//
// Nothing here touches the DOM or the network. EngineVoice is exported so
// `node --test` can render it offline (test/rev-worklet.test.mjs); the
// processor registers itself only inside an AudioWorkletGlobalScope.

// Deterministic noise, so a test render is repeatable.
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

// RBJ band-pass (constant 0 dB peak) and low-pass biquads, transposed direct
// form II.
class Biquad {
  constructor() { this.b0 = 0; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0 }
  bandpass(f, q, sr) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr
    const alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha
    this.b0 = alpha / a0; this.b1 = 0; this.b2 = -alpha / a0
    this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - alpha) / a0
    return this
  }
  lowpass(f, q, sr) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr
    const alpha = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + alpha
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0
    this.a1 = -2 * c / a0; this.a2 = (1 - alpha) / a0
    return this
  }
  run(x) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }
}

// A fixed-capacity list of records of `width` numbers. Removal swaps in the
// last record, so order is not kept (nothing here depends on it). When full,
// a new record is dropped: at that point nobody can hear one more pulse.
class Pool {
  constructor(cap, width) { this.cap = cap; this.w = width; this.a = new Float64Array(cap * width); this.n = 0 }
  add(x, y, z) {
    if (this.n >= this.cap) return
    const o = this.n++ * this.w
    this.a[o] = x; this.a[o + 1] = y; this.a[o + 2] = z
  }
  remove(k) {
    const last = --this.n
    if (k !== last) for (let j = 0; j < this.w; j++) this.a[k * this.w + j] = this.a[last * this.w + j]
  }
}

export class EngineVoice {
  constructor(sampleRate, seed = 1) {
    this.sr = sampleRate
    this.rand = rng(seed)
    this.rpm = 800; this.rpmTarget = 800
    this.load = 0; this.loadTarget = 0
    this.gain = 0; this.gainTarget = 0
    this.phase = 0       // 0..1 over the 720° cycle
    this.next = 0        // index of the next cylinder to fire
    // Fixed pools, so the audio thread never allocates: a garbage collection
    // pause there is an audible click.
    this.pending = new Pool(32, 3) // samplesLeft, bank, amp — held back by header delay
    this.pulses = new Pool(64, 3)  // age, bank, amp
    this.pops = new Pool(16, 3)    // age (negative = not started), amp, length
    this.firings = 0     // counted for tests and the debug readout
    this.dcX = [0, 0]; this.dcY = [0, 0]
    this.lpQ = 0.8
    this.profile = null
    // Turbo: boost 0..1, the whistle's oscillator phase, and the blow-off
    // envelope.
    this.boost = 0; this.whPhase = 0; this.bov = 0
  }

  setProfile(p) {
    this.profile = p
    const sr = this.sr
    this.cyl = p.cylinders.slice().sort((a, b) => a.at - b.at)
      // Fixed small differences between cylinders: no real engine fires
      // identically, and perfectly even pulses sound like a synth.
      .map((c) => ({ ...c, trim: 0.85 + 0.3 * this.rand(), delay: Math.round((c.delayMs || 0) * sr / 1000) }))
    // Start just before the first firing point, so the engine is heard on
    // the first sample rather than one cycle later.
    this.next = 0
    this.phase = (this.cyl[0].at + 1 - 1e-9) % 1
    this.banks = p.banks.map((res) => res.map(([f, q, g]) => ({ f: new Biquad().bandpass(f, q, sr), g })))
    this.tone = p.banks.map(() => new Biquad().lowpass(p.bright[0], this.lpQ, sr))
    this.intake = new Biquad().bandpass(p.intake[0], 1.2, sr)
    this.pulseLen = Math.max(2, Math.round(p.pulseMs * sr / 1000))
    this.pending.n = 0; this.pulses.n = 0; this.pops.n = 0
    this.boost = 0; this.bov = 0
    this.whNoise = new Biquad().bandpass(p.turbo ? p.turbo.whistle[0] : 3000, 6, sr)
    this.bovFilt = new Biquad().bandpass(1600, 0.9, sr)
  }

  // rpm, load (-1..1) and output gain are targets; the voice glides to them
  // per sample so a 20 Hz parameter stream never clicks.
  set({ rpm, load, gain }) {
    if (Number.isFinite(rpm)) this.rpmTarget = Math.max(100, rpm)
    if (Number.isFinite(load)) this.loadTarget = Math.max(-1, Math.min(1, load))
    if (Number.isFinite(gain)) this.gainTarget = Math.max(0, Math.min(1, gain))
  }

  fire(c) {
    const p = this.profile
    const pos = Math.max(0, this.load)
    // Idle and overrun pulses are soft, full load hits hard; a little jitter
    // per firing keeps it from sounding like a loop.
    let amp = (0.25 + 0.75 * pos + (this.load < 0 ? 0.08 : 0)) * c.trim * (0.92 + 0.16 * this.rand())
    // Lope: a big cam or a rotary's ports make idle firings uneven, now and
    // then nearly a miss. It smooths out as the revs rise.
    const lope = (p.lope || 0) * Math.max(0, 1 - this.rpm / (p.idle * 3))
    if (lope > 0) {
      amp *= 1 + lope * (this.rand() * 2 - 1)
      if (this.rand() < lope * 0.12) amp *= 0.25
    }
    if (c.delay > 0) this.pending.add(c.delay, c.bank, amp)
    else this.pulses.add(0, c.bank, amp)
    this.firings++
    // Overrun: fuel cut at speed, the odd unburnt charge lights in the pipe.
    if (this.load < -0.3 && this.rpm > p.redline * 0.35 && this.rand() < p.pops * -this.load) {
      this.pops.add(-Math.floor(this.rand() * this.sr * 0.02), 0.5 + 0.5 * this.rand(),
        Math.round(this.sr * (0.004 + 0.01 * this.rand())))
    }
  }

  // Render n frames into the given channel arrays (1 or 2).
  render(outs, n) {
    const p = this.profile
    if (!p) { for (const o of outs) o.fill(0, 0, n); return }
    const sr = this.sr
    const kRpm = 1 - Math.exp(-1 / (0.015 * sr))
    const kGain = 1 - Math.exp(-1 / (0.05 * sr))
    const cyl = this.cyl, nCyl = cyl.length, nBanks = this.banks.length
    const bankOut = [0, 0]

    // The tone filter follows load and rpm; recomputed once per block, which
    // at 128 frames is under 3 ms and inaudible as steps.
    const rpmFrac = this.rpm / p.redline
    const cutoff = p.bright[0] + p.bright[1] * Math.max(0, this.load) + 900 * rpmFrac
    for (const t of this.tone) t.lowpass(cutoff, this.lpQ, sr)
    const drive = 1 + (p.drive - 1) * Math.max(0, this.load)
    const norm = 1 / Math.tanh(drive)

    // Turbo, per block: boost builds with load and revs over the spool time
    // and bleeds off faster. Lifting with boost up opens the blow-off valve.
    const tb = p.turbo
    let whF = 0, whAmp = 0
    if (tb) {
      const blockS = n / sr
      const want = Math.max(0, this.load) * Math.min(1, Math.max(0, (rpmFrac - 0.2) / 0.4))
      const tau = want > this.boost ? tb.spool : 0.25
      this.boost += (want - this.boost) * (1 - Math.exp(-blockS / tau))
      if (this.load < -0.05 && this.boost > 0.3 && this.bov < 0.05) {
        this.bov = this.boost * tb.bov
        this.boost *= 0.3
      }
      whF = tb.whistle[0] + (tb.whistle[1] - tb.whistle[0]) * this.boost
      whAmp = tb.level * this.boost * this.boost
      this.whNoise.bandpass(whF, 6, sr)
    }
    const kBov = Math.exp(-1 / (0.28 * sr))

    for (let i = 0; i < n; i++) {
      this.rpm += (this.rpmTarget - this.rpm) * kRpm
      this.load += (this.loadTarget - this.load) * kRpm
      this.gain += (this.gainTarget - this.gain) * kGain

      // Advance the cycle and fire every cylinder whose point falls inside
      // this sample's step. Cylinders are sorted by firing point, so the
      // distance to each successive one only grows.
      const prev = this.phase
      const step = this.rpm / 120 / sr
      for (let k = 0; k < nCyl; k++) {
        const c = cyl[this.next]
        let d = c.at - prev
        if (d <= 0) d += 1
        if (d > step) break
        this.fire(c)
        this.next = (this.next + 1) % nCyl
      }
      this.phase = (prev + step) % 1

      const pd = this.pending
      for (let k = pd.n - 1; k >= 0; k--) {
        if (--pd.a[k * 3] <= 0) { this.pulses.add(0, pd.a[k * 3 + 1], pd.a[k * 3 + 2]); pd.remove(k) }
      }

      // Sum live pulses (half-sine, pulseLen samples) per bank.
      bankOut[0] = 0; bankOut[1] = 0
      let env = 0
      const pu = this.pulses, len = this.pulseLen
      for (let k = pu.n - 1; k >= 0; k--) {
        const o = k * 3
        const v = pu.a[o + 2] * Math.sin(Math.PI * pu.a[o] / len)
        bankOut[pu.a[o + 1]] += v
        env += v
        if (++pu.a[o] >= len) pu.remove(k)
      }

      const noise = this.rand() * 2 - 1
      const intake = this.intake.run(noise) * p.intake[1] * (0.3 + Math.max(0, this.load)) * (0.4 + env)

      let pop = 0
      const po = this.pops
      for (let k = po.n - 1; k >= 0; k--) {
        const o = k * 3
        const age = po.a[o]++
        if (age >= 0) {
          pop += po.a[o + 1] * (this.rand() * 2 - 1) * Math.exp(-4 * age / po.a[o + 2])
          if (age + 1 >= po.a[o + 2]) po.remove(k)
        }
      }

      for (let b = 0; b < nBanks; b++) {
        const x = bankOut[b] + 0.15 * noise * bankOut[b]
        let y = 0.35 * x
        for (const r of this.banks[b]) y += r.g * r.f.run(x)
        bankOut[b] = this.tone[b].run(y)
      }
      const l = nBanks > 1 ? bankOut[0] + 0.55 * bankOut[1] : bankOut[0]
      const r = nBanks > 1 ? bankOut[1] + 0.55 * bankOut[0] : bankOut[0]

      // Turbo whistle (a tone plus a breath of noise around it) and the
      // blow-off's hiss. Mixed after the saturation, so they stay clean.
      let turbo = 0
      if (tb) {
        this.whPhase += whF / sr
        if (this.whPhase >= 1) this.whPhase -= 1
        turbo = whAmp * (Math.sin(2 * Math.PI * this.whPhase) + 1.5 * this.whNoise.run(noise))
        if (this.bov > 1e-4) { turbo += this.bov * this.bovFilt.run(noise) * 1.6; this.bov *= kBov }
      }

      for (let ch = 0; ch < outs.length; ch++) {
        const s = (ch === 0 ? l : r) * 0.9 + intake + pop * 0.6
        // Saturation for grit under load, then a DC blocker: the pulses are
        // all positive, and DC in a car's amplifier is wasted excursion.
        const sat = Math.tanh(s * drive) * norm
        const dc = sat - this.dcX[ch] + 0.995 * this.dcY[ch]
        this.dcX[ch] = sat; this.dcY[ch] = dc
        outs[ch][i] = Math.max(-1, Math.min(1, (dc + turbo) * this.gain * 0.7))
      }
    }
  }
}

if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class RevEngineProcessor extends AudioWorkletProcessor {
    constructor() {
      super()
      // `sampleRate` is a global of the worklet scope.
      this.voice = new EngineVoice(sampleRate, 0x5eed)
      this.port.onmessage = (e) => {
        const m = e.data || {}
        if (m.profile) this.voice.setProfile(m.profile)
        if (m.params) this.voice.set(m.params)
      }
    }
    process(_inputs, outputs) {
      const out = outputs[0]
      if (out && out.length) this.voice.render(out, out[0].length)
      return true
    }
  }
  registerProcessor('rev-engine', RevEngineProcessor)
}
