// Offline exercise of the re-framing in carplay-reader.js: feed it a byte
// stream split at hostile boundaries and check the messages come back whole.
import EventEmitter from 'events'
import { MessageHeader } from 'node-carplay/node'
import { installPipelinedReader } from '../carplay-reader.js'

const msg = (type, payload = Buffer.alloc(0)) =>
  Buffer.concat([MessageHeader.asBuffer(type, payload.length), payload])

// AudioData: decodeType u32, volume f32, audioType u32, then S16LE PCM.
function audio(decodeType, audioType, samples) {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(decodeType, 0)
  head.writeFloatLE(1, 4)
  head.writeUInt32LE(audioType, 8)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE((i % 1000) - 500, i * 2)
  return msg(7, Buffer.concat([head, pcm]))
}
const command = (id) => { const b = Buffer.alloc(4); b.writeUInt32LE(id); return msg(8, b) }
const unplugged = () => msg(4)

function fakeDriver(stream, chunkPlan) {
  const driver = new EventEmitter()
  let pos = 0, i = 0, drained = 0
  driver._inEP = { endpointNumber: 1 }
  driver._device = {
    opened: true,
    // Async for real: a transfer that resolved synchronously would let the
    // whole stream complete before the read loop ran even once, which is not
    // how libusb behaves and would test nothing.
    async transferIn() {
      await new Promise(r => setImmediate(r))
      if (pos >= stream.length) {
        // Empty reads for a while, so everything already queued gets drained,
        // then the "device went away".
        if (++drained > 8) driver._device.opened = false
        return { status: 'ok', data: undefined }
      }
      const n = Math.min(chunkPlan[i++ % chunkPlan.length], stream.length - pos)
      const copy = new Uint8Array(stream.subarray(pos, pos + n))
      pos += n
      return { status: 'ok', data: new DataView(copy.buffer) }
    },
  }
  driver.close = async () => { driver._device.opened = false }
  return driver
}

async function run(name, stream, chunkPlan, expect) {
  const seen = []
  const driver = fakeDriver(stream, chunkPlan)
  const logs = []
  const reader = installPipelinedReader({
    driver, log: (lvl, ev, d) => logs.push([lvl, ev, d]), inflight: 4, chunk: 4096,
  })
  driver.on('message', (m) => seen.push(m))
  await driver.readLoop()
  const ok = expect(seen, reader.stats(), logs)
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name
    + '   (' + seen.length + ' messages, ' + reader.stats().resyncs + ' resyncs)')
  if (!ok) { console.log(seen.map(m => m.constructor.name)); console.log(logs); process.exitCode = 1 }
}

const pcmSamples = 2048
const stream = Buffer.concat([
  command(3), audio(1, 0, pcmSamples), unplugged(), audio(5, 2, 160), command(203),
])

const checkAll = (seen) => {
  if (seen.length !== 5) return false
  const a = seen[1]
  if (a.constructor.name !== 'AudioData') return false
  if (a.decodeType !== 1 || a.audioType !== 0) return false
  if (a.data.length !== pcmSamples) return false
  for (let i = 0; i < pcmSamples; i++) if (a.data[i] !== (i % 1000) - 500) return false
  const b = seen[3]
  if (b.decodeType !== 5 || b.audioType !== 2 || b.data.length !== 160) return false
  if (seen[2].constructor.name !== 'Unplugged') return false
  return true
}

// 1. one read per message-ish
await run('whole messages', stream, [10000], checkAll)
// 2. pathological: 1 byte at a time
await run('single bytes', stream, [1], checkAll)
// 3. boundaries that split headers
await run('split headers', stream, [3, 17, 5, 1024, 7], checkAll)
// 4. garbage in front, and between two messages
const noise = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0xaa])
await run('resyncs past garbage',
  Buffer.concat([noise, command(3), noise, audio(1, 0, 64), command(1)]), [5, 64, 3],
  (seen, stats) => seen.length === 3 && stats.resyncs >= 2)
// 5. encrypted firmware is named, not just "invalid magic"
const enc = Buffer.alloc(16)
enc.writeUInt32LE(0x55bb55bb, 0)
await run('encrypted firmware detected', Buffer.concat([enc, command(3)]), [8],
  (seen, stats, logs) => stats.encrypted && logs.some(l => l[1] === 'dongle_firmware_encrypted'))
