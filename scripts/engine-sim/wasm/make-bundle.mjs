// make-bundle.mjs <engine-sim clone> <out dir>
//
// What live engine-sim needs besides the module (build-wasm.sh):
//   engine-sim-data.json  the four cars' engine scripts and every
//                         engine-sim script file they import, and nothing
//                         else: { files: { path: text }, scripts: { car: path } }
//   ir-engine.wav,        the two impulse responses the recorded loops use
//   ir-exhaust.wav        (static/rev-samples.js `ir`), cut as engine-sim
//                         cuts them: up to the last sample louder than 100
//                         (of 32767), at most 10,000 samples, first channel.
// All of it is engine-sim's (MIT) except our flat-6 script.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SETS } from '../../../static/rev-samples.js'

const [src, out] = process.argv.slice(2)
if (!src || !out) { console.error('usage: make-bundle.mjs <engine-sim clone> <out dir>'); process.exit(2) }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// The wrappers go in assets/, where render-set.sh puts them, so their
// imports resolve the same way: next to the importing file first, then on
// the compiler's search path (es/, from the source root).
const files = {}, scripts = {}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
function add(rel, text) {
  if (Object.hasOwn(files, rel)) return
  files[rel] = text
  for (const [, imp] of strip(text).matchAll(/\bimport\s+"([^"]+)"/g)) {
    const name = imp.endsWith('.mr') ? imp : imp + '.mr'
    const candidates = [path.posix.join(path.posix.dirname(rel), name), name, path.posix.join('es', name)]
    const hit = candidates.find((c) => fs.existsSync(path.join(src, c)))
    if (!hit) throw new Error(`${rel}: cannot resolve import ${imp}`)
    add(hit, fs.readFileSync(path.join(src, hit), 'utf8'))
  }
}
for (const [car, set] of Object.entries(SAMPLE_SETS)) {
  const rel = 'assets/' + path.basename(set.script)
  add(rel, fs.readFileSync(path.join(ROOT, set.script), 'utf8'))
  scripts[car] = rel
}
const json = JSON.stringify({ files, scripts })
fs.writeFileSync(path.join(out, 'engine-sim-data.json'), json)
console.log(`engine-sim-data.json: ${Object.keys(files).length} files, ${(json.length / 1024).toFixed(1)} kB`)

function readWav16(file) {
  const b = fs.readFileSync(file)
  let o = 12, channels = 1, bits = 16, rate = 44100
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4)
    if (id === 'fmt ') { channels = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22) }
    if (id === 'data') {
      if (bits !== 16) throw new Error(`${file} is ${bits}-bit`)
      const n = Math.floor(size / 2 / channels), x = new Int16Array(n)
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2 * channels)
      return { x, rate }
    }
    o += 8 + size + (size & 1)
  }
  throw new Error(`${file}: no data`)
}
function writeWav16(file, x, rate) {
  const h = Buffer.alloc(44), pcm = Buffer.from(x.buffer, x.byteOffset, x.byteLength)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, pcm]))
}
const irs = new Set(Object.values(SAMPLE_SETS).map((s) => JSON.stringify(s.ir)))
if (irs.size !== 1) throw new Error('the cars use different impulse responses; ship each')
for (const [group, rel] of Object.entries(JSON.parse([...irs][0]))) {
  const { x, rate } = readWav16(path.join(src, rel)) // rel: es/sound-library/...
  let len = 0
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 100) len = i + 1
  len = Math.min(10000, len)
  const f = path.join(out, `ir-${group}.wav`)
  writeWav16(f, x.slice(0, len), rate)
  console.log(`ir-${group}.wav: ${rel}, ${x.length} -> ${len} samples at ${rate} Hz`)
}
