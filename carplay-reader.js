// carplay-reader.js — a pipelined replacement for node-carplay's USB read loop.
//
// Why this exists: node-carplay reads the dongle strictly one message at a
// time, and each message costs TWO round trips —
//
//     await transferIn(ep, 16)          // the header
//     await transferIn(ep, header.length)   // the payload
//
// with nothing queued behind them. Every gap between "libusb hands us a
// buffer" and "we submit the next read" is time the dongle spends with data it
// cannot give us, and at 30 fps of video plus 15 audio chunks a second those
// gaps are the pipeline. FastCarPlay (the C++ receiver for the same dongles)
// keeps 32 bulk transfers in flight and says so in its own settings file:
// increase them "if you have issues with audio and video lagging behind", and
// again "if you have malformed message errors on RPI". Both are symptoms we
// have.
//
// So this keeps N reads outstanding at all times and re-frames the resulting
// byte stream itself. Bulk IN transfers are queued by the kernel and complete
// in submission order, so awaiting them in that same order reconstructs the
// stream exactly; the only new work is finding message boundaries, because a
// fixed-size read no longer lines up with them.
//
// It emits the same 'message' events on the same driver, so everything
// downstream (CarplayNode's dispatch, our own prependListener) is unchanged.
// CARPLAY_USB_PIPELINE=off puts node-carplay's original loop back.

import { MessageHeader } from 'node-carplay/node'

const HEADER_LEN = 16
const MAGIC = 0x55aa55aa
// Newer Carlinkit firmware frames with this magic instead and AES-encrypts the
// body. node-carplay predates it and simply throws "Invalid magic number" in a
// loop until the error count trips, which reads like a broken cable. Naming it
// is the whole fix available to us — we cannot decrypt it. See docs.
const MAGIC_ENCRYPTED = 0x55bb55bb
// node-carplay gives up after 5 read errors and emits 'failure'; match it so a
// wedged dongle still reaches our restart path at the same speed it used to.
const MAX_ERROR_COUNT = 5
// A sane ceiling on a declared payload. config.packetMax is 49152, so anything
// past a megabyte means we are reading noise, not a header.
const MAX_MESSAGE_LEN = 4 * 1024 * 1024

// How many reads to keep outstanding, and how big each one is. 16 x 16 KB is
// 256 KB of pending buffers — nothing on a Pi 4 — and 16 KB comfortably holds
// a whole video frame, so the common case is still one transfer per message.
const DEFAULT_INFLIGHT = 16
const DEFAULT_CHUNK = 16384

export function installPipelinedReader({ driver, log, inflight, chunk }) {
  const depth = Math.max(1, Number(inflight) || DEFAULT_INFLIGHT)
  const size = Math.max(512, Number(chunk) || DEFAULT_CHUNK)

  const stats = {
    enabled: true,
    inflight: depth,
    chunk: size,
    messages: 0,
    bytes: 0,
    reads: 0,
    resyncs: 0,
    encrypted: false,
  }

  // The re-framing buffer. Data lives in [start, end); it is compacted rather
  // than reallocated, so steady state costs no allocation at all.
  let buf = Buffer.alloc(size * 4)
  let start = 0
  let end = 0
  // The in-flight run, so a restart can wait for the old loop to let go of the
  // endpoint before the new one starts. node-carplay's start() calls readLoop()
  // without awaiting it, and a restart calls close() then start() — without
  // this handshake the new call could arrive while the old loop was still
  // unwinding a pending transfer, see `running` set, and quietly do nothing,
  // leaving a started session with nobody reading the dongle.
  let currentRun = null
  let stopped = false

  const reset = () => { start = 0; end = 0 }

  const append = (u8) => {
    if (end + u8.length > buf.length) {
      // Slide the live bytes down first; only grow if that was not enough.
      if (start > 0) { buf.copyWithin(0, start, end); end -= start; start = 0 }
      if (end + u8.length > buf.length) {
        const grown = Buffer.alloc(Math.max(buf.length * 2, end + u8.length))
        buf.copy(grown, 0, 0, end)
        buf = grown
      }
    }
    buf.set(u8, end)
    end += u8.length
  }

  // Hunt for the next plausible header after a desync. Without this a single
  // lost byte would poison the rest of the session; node-carplay has no
  // equivalent because its reads were message-aligned by construction.
  const resync = () => {
    stats.resyncs++
    for (let i = start + 1; i + 4 <= end; i++) {
      const magic = buf.readUInt32LE(i)
      if (magic === MAGIC || magic === MAGIC_ENCRYPTED) { start = i; return true }
    }
    // Nothing yet — keep only the tail that could still be the front of a magic.
    start = Math.max(start, end - 3)
    return false
  }

  const drain = () => {
    for (;;) {
      if (end - start < HEADER_LEN) return
      const magic = buf.readUInt32LE(start)
      if (magic !== MAGIC) {
        if (magic === MAGIC_ENCRYPTED && !stats.encrypted) {
          stats.encrypted = true
          log('error', 'dongle_firmware_encrypted', {
            hint: 'This dongle speaks the newer encrypted protocol (magic 0x55bb55bb). '
                + 'The library we use only speaks the older plain one, so CarPlay cannot start. '
                + 'Use a dongle on older firmware — and do not update this one.',
          })
        }
        if (!resync()) return
        continue
      }
      const length = buf.readUInt32LE(start + 4)
      const type = buf.readUInt32LE(start + 8)
      const typeCheck = buf.readUInt32LE(start + 12)
      if (typeCheck !== (((type ^ -1) & 0xffffffff) >>> 0) || length > MAX_MESSAGE_LEN) {
        // Right magic, wrong header: we are reading the middle of something.
        if (!resync()) return
        continue
      }
      if (end - start < HEADER_LEN + length) return   // rest of it is still in flight

      let header
      try {
        header = MessageHeader.fromBuffer(buf.subarray(start, start + HEADER_LEN))
      } catch {
        if (!resync()) return
        continue
      }

      let payload
      if (length) {
        // A standalone ArrayBuffer, not a view into ours. node-carplay builds
        // AudioData as `new Int16Array(data.buffer, 12)` — no length bound —
        // so handing it a slice of a shared buffer would ship whatever comes
        // after the message as extra audio samples.
        const ab = new ArrayBuffer(length)
        new Uint8Array(ab).set(buf.subarray(start + HEADER_LEN, start + HEADER_LEN + length))
        payload = Buffer.from(ab)
      }
      start += HEADER_LEN + length
      stats.messages++

      let message = null
      try { message = header.toMessage(payload) }
      catch (err) { log('warn', 'usb_message_decode_failed', { type, msg: err.message }) }
      if (message) driver.emit('message', message)
    }
  }

  const readLoop = async () => {
    if (currentRun) {
      stopped = true
      try { await currentRun } catch {}
    }
    currentRun = run()
    return currentRun
  }

  const run = async () => {
    stopped = false
    reset()
    let errorCount = 0
    let failed = false

    const device = driver._device
    const ep = driver._inEP?.endpointNumber
    if (!device || ep == null) {
      log('warn', 'usb_pipeline_no_endpoint')
      return
    }

    // Each promise gets a no-op catch so that the ones still queued when we
    // stop cannot surface as unhandled rejections — the awaited copy still
    // throws into the loop below, where it is handled properly.
    const queue = []
    const submit = () => {
      let p
      try { p = device.transferIn(ep, size) }
      catch (err) { p = Promise.reject(err) }
      p.catch(() => {})
      queue.push(p)
    }
    for (let i = 0; i < depth; i++) submit()
    log('info', 'usb_pipeline_started', { inflight: depth, chunk: size })

    while (!stopped && driver._device?.opened) {
      if (!queue.length) break   // cannot happen while we keep the depth topped up
      let res = null
      let err = null
      try { res = await queue.shift() }
      catch (e) { err = e }
      // Top the queue back up before doing anything else, errors included:
      // skipping it on the error path would shrink the pipeline by one read
      // every time a transfer hiccuped, and eventually starve it entirely.
      if (!stopped && driver._device?.opened) submit()
      if (err) {
        errorCount++
        const fatal = /NO_DEVICE|NOT_FOUND|no device/i.test(String(err && err.message))
        log('warn', 'usb_read_error', { msg: String(err && err.message), count: errorCount, fatal })
        if (fatal || errorCount >= MAX_ERROR_COUNT) { failed = true; break }
        continue
      }
      stats.reads++
      if (!res || res.status !== 'ok' || !res.data || !res.data.byteLength) {
        // 'stall'/'babble', or a zero-length read. Empty reads are normal when
        // the dongle has nothing to say; only real statuses count as errors.
        if (res && res.status && res.status !== 'ok') {
          errorCount++
          log('warn', 'usb_read_status', { status: res.status, count: errorCount })
          if (errorCount >= MAX_ERROR_COUNT) { failed = true; break }
        }
        continue
      }
      errorCount = 0
      const view = res.data
      stats.bytes += view.byteLength
      append(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
      try { drain() }
      catch (err) { log('error', 'usb_frame_failed', { msg: err.message }) }
    }

    stopped = true
    log('info', 'usb_pipeline_stopped', { messages: stats.messages, resyncs: stats.resyncs, failed })
    // Same contract as node-carplay's loop: only a read path that gave up
    // emits 'failure' (which is what drives our reconnect). Exiting because
    // the device closed is what a deliberate stop looks like, and shouting
    // 'failure' there would fight our own restart.
    if (!failed) return
    if (driver._device?.opened) {
      try { await driver.close() } catch {}
    }
    driver.emit('failure')
  }

  const original = driver.readLoop
  driver.readLoop = readLoop
  driver.stopPipelinedRead = () => { stopped = true }

  return {
    stats: () => ({ ...stats }),
    restore: () => { driver.readLoop = original },
  }
}
