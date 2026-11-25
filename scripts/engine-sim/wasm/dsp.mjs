// The page's audio graph (static/rev-live.js), offline at 44.1 kHz, for
// calibrate.mjs and verify.mjs.
import fs from 'node:fs'

export function readWav16(file) {
  const b = fs.readFileSync(file)
  const n = b.readUInt32LE(40) / 2, x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + 2 * i)
  return x
}
export function fft(re, im, inv) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
}
export function convolve(x, h) {
  let n = 1
  while (n < x.length + h.length) n <<= 1
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n)
  ar.set(x); br.set(h)
  fft(ar, ai, false); fft(br, bi, false)
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r }
  fft(ar, ai, true)
  return ar.subarray(0, x.length)
}
// RBJ shelf (S = 1) and Butterworth low-pass: what BiquadFilterNode does,
// and what rev-samples.mjs used.
export function biquad(x, [b0, b1, b2, a0, a1, a2]) {
  const y = new Float64Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}
export function shelfCoefs({ type, hz, db }, sr) {
  const A = Math.pow(10, db / 40), w = 2 * Math.PI * hz / sr, c = Math.cos(w), k = 2 * Math.sqrt(A) * Math.sin(w) / 2 * Math.SQRT2
  return type === 'lowshelf'
    ? [A * ((A + 1) - (A - 1) * c + k), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - k), (A + 1) + (A - 1) * c + k, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - k]
    : [A * ((A + 1) + (A - 1) * c + k), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - k), (A + 1) - (A - 1) * c + k, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - k]
}
export function lowpassCoefs(hz, sr) {
  const w = 2 * Math.PI * hz / sr, c = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  return [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha]
}
export function hp25(x, sr) { // rev-samples.mjs level(): one-pole, 25 Hz
  const a = 1 - Math.exp(-2 * Math.PI * 25 / sr), y = new Float64Array(x.length)
  let lp = 0
  for (let i = 0; i < x.length; i++) { lp += (x[i] - lp) * a; y[i] = x[i] - lp }
  return y
}
export const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)) }
export const db = (v) => 20 * Math.log10(v)

