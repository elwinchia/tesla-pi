// retroarch-audio-worklet.js — plays the native RetroArch addon's game audio.
//
// The main thread receives raw interleaved-stereo Float32 audio (converted from
// the S16LE PCM stream on /retroarch/audio, always 48 kHz) and posts each chunk
// here. We hold it in a ring buffer and drain it to the speakers.
//
// IMPORTANT: the source is 48 kHz but the AudioContext may run at a different
// rate (e.g. 44.1 kHz hardware) even when we ask for 48 kHz — some browsers
// ignore the requested sampleRate. Playing 48 kHz data 1:1 into a 44.1 kHz
// context overflows the buffer continuously and sounds broken. So we RESAMPLE on
// the fly: the read head advances by srcRate/contextRate per output frame, with
// linear interpolation. When the rates match this is exact passthrough (step=1).
//
// A ~120 ms prebuffer absorbs WebSocket/scheduler jitter; underflow re-cushions.

class RingPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const src = (options && options.processorOptions && options.processorOptions.srcRate) || 48000;
    this.step = src / sampleRate;       // source frames consumed per output frame
    this.F = 48000 * 4;                 // ring capacity in FRAMES (~4 s)
    this.buf = new Float32Array(this.F * 2); // interleaved L,R
    this.wf = 0;                        // write head (frames, integer, monotonic)
    this.rf = 0;                        // read head (frames, fractional, monotonic)
    this.playing = false;
    this.PRE = 48000 * 0.12;            // ~120 ms cushion (in frames)
    this.port.onmessage = (e) => {
      const d = e.data;                 // interleaved float32, even length
      for (let i = 0; i + 1 < d.length; i += 2) {
        const w = (this.wf % this.F) * 2;
        this.buf[w] = d[i];
        this.buf[w + 1] = d[i + 1];
        this.wf++;
      }
      // Drop oldest if the producer outran the consumer (keep within capacity).
      if (this.wf - this.rf > this.F - 2) this.rf = this.wf - (this.F - 2);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    if (!this.playing) {
      if (this.wf - this.rf >= this.PRE) this.playing = true;
      else { L.fill(0); R.fill(0); return true; }
    }
    for (let i = 0; i < n; i++) {
      if (this.wf - this.rf < 2) {
        // Momentary underflow: emit silence for this sample but DON'T reset to
        // re-cushion — resuming the instant data returns avoids the halting,
        // slow-motion playback that a full 120 ms re-buffer on every jitter spike
        // would cause. The source is real-time, so underflows are brief.
        L[i] = 0; R[i] = 0;
        continue;
      }
      const base = Math.floor(this.rf);
      const frac = this.rf - base;
      const a = (base % this.F) * 2;
      const b = ((base + 1) % this.F) * 2;
      L[i] = this.buf[a] * (1 - frac) + this.buf[b] * frac;
      R[i] = this.buf[a + 1] * (1 - frac) + this.buf[b + 1] * frac;
      this.rf += this.step;
    }
    return true;
  }
}

registerProcessor('ra-ring', RingPlayer);
