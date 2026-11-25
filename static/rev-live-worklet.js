// Live engine-sim, the playing half: an AudioWorkletProcessor ('rev-live')
// that takes the worker's audio (static/rev-live-worker.js: 44.1 kHz chunks
// over a MessageChannel), keeps it in a ring buffer about TARGET ahead,
// resamples it to the context's rate and plays it on three outputs: the
// engine group (to its ConvolverNode), the exhaust group (to its), and the
// sub layer (to the low-pass). rev-live.js wires them.
//
// It tells the worker how much it holds after every few blocks, which is
// what paces the simulation. If it runs dry (the simulation fell behind) it
// fades out, counts an underrun, and waits until it holds REFILL again.
//
// RingReader is exported so `node --test` can run it offline; the
// processor registers itself only inside an AudioWorkletGlobalScope.

export const IN_RATE = 44100
const CAP = 1 << 16, MASK = CAP - 1 // 1.49 s at 44.1 kHz
const CH = 3

export class RingReader {
  constructor(outRate, { start = 0.1, refill = 0.06 } = {}) {
    this.ratio = IN_RATE / outRate
    this.rings = Array.from({ length: CH }, () => new Float32Array(CAP))
    this.w = 0          // frames received, in total
    this.r = 1          // read position (frames, fractional); one frame of history for the cubic
    this.playing = false
    this.underruns = 0
    this.startFrames = Math.round(start * IN_RATE)
    this.refillFrames = Math.round(refill * IN_RATE)
    this.gain = 0; this.gainTarget = 0
    this.kGain = 1 - Math.exp(-1 / (0.05 * outRate))
  }
  get buffered() { return Math.max(0, this.w - Math.floor(this.r)) }

  // A chunk: n frames per channel, planar in one Float32Array.
  push(buf, n) {
    if (this.w - this.r + n > CAP - 4) return false // never: the worker keeps ~0.12 s ahead
    for (let c = 0; c < CH; c++) {
      const ring = this.rings[c], o = c * n
      for (let i = 0; i < n; i++) ring[(this.w + i) & MASK] = buf[o + i]
    }
    this.w += n
    return true
  }

  // Fill outs (one Float32Array per channel) with n frames.
  render(outs, n) {
    const need = Math.ceil(n * this.ratio) + 3
    if (!this.playing) {
      if (this.buffered >= (this.underruns ? this.refillFrames : this.startFrames)) this.playing = true
      else { for (const o of outs) o.fill(0, 0, n); return }
    }
    let m = n, fade = false
    if (this.buffered < need) {
      // Ran dry: play what there is, fading out, then wait for a refill.
      m = Math.max(0, Math.floor((this.buffered - 3) / this.ratio))
      fade = true
      this.underruns++
      this.playing = false
    }
    const kg = this.kGain
    let g = this.gain
    const r0 = this.r
    for (let c = 0; c < outs.length && c < CH; c++) {
      const ring = this.rings[c], o = outs[c]
      let r = r0
      g = this.gain
      for (let i = 0; i < m; i++) {
        const k = Math.floor(r), t = r - k
        const y0 = ring[(k - 1) & MASK], y1 = ring[k & MASK], y2 = ring[(k + 1) & MASK], y3 = ring[(k + 2) & MASK]
        // Catmull-Rom (cubic Hermite) interpolation.
        const v = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)))
        g += (this.gainTarget - g) * kg
        o[i] = v * g * (fade ? 1 - i / m : 1)
        r += this.ratio
      }
      o.fill(0, m, n)
    }
    this.gain = g
    this.r = r0 + m * this.ratio
  }
}

if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class RevLiveProcessor extends AudioWorkletProcessor {
    constructor() {
      super()
      this.reader = new RingReader(sampleRate)
      this.worker = null
      this.blocks = 0
      this.alive = true
      this.port.onmessage = (e) => {
        const m = e.data || {}
        if (m.port) {
          this.worker = m.port
          this.worker.onmessage = (ev) => { const d = ev.data; if (d && d.audio) this.reader.push(d.audio, d.n) }
          this.tell()
        }
        if (Number.isFinite(m.gain)) this.reader.gainTarget = Math.max(0, Math.min(1, m.gain))
        if (m.stop) this.alive = false
      }
    }
    tell() {
      const r = this.reader
      if (this.worker) this.worker.postMessage({ buffered: r.buffered, received: r.w, underruns: r.underruns, playing: r.playing })
    }
    process(inputs, outputs) {
      const outs = outputs.map((o) => o[0]).filter(Boolean)
      if (outs.length) this.reader.render(outs, outs[0].length)
      // Every 4 blocks (~11 ms at 48 kHz): how much is left.
      if (++this.blocks % 4 === 0) this.tell()
      return this.alive
    }
  }
  registerProcessor('rev-live', RevLiveProcessor)
}
