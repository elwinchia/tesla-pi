// retroarch-bridge.js — streams a NATIVE RetroArch session to the Tesla browser.
//
// Emulating RetroArch inside an Android container was tried and rejected — far
// too laggy for a game. RetroArch has a native Linux/Wayland build, so we run it
// directly in its own headless `cage` wlroots compositor and reuse the same
// H.264-over-WebSocket streaming pipeline CarPlay uses:
//   - POST /retroarch/start runs `sudo tesla-pi-retroarch start`, which starts
//     cage-retroarch.service (`cage -- tesla-pi-retroarch-session`). The session
//     launcher pins the cage output to 1024x768 BEFORE RetroArch starts (so
//     RetroArch sizes its GL surface correctly) then execs RetroArch fullscreen.
//   - We capture that cage output with `wf-recorder` → Pi hardware H.264
//     (/dev/video11) → /retroarch/h264 (binary WS), decoded by the same
//     WebCodecs worker.js the CarPlay path uses.
//   - Game AUDIO: RetroArch plays to an ALSA loopback (snd-aloop, hw:Loopback,0,0);
//     we capture the mirror (hw:Loopback,1,0) with ffmpeg as raw S16LE PCM and
//     broadcast it on /retroarch/audio. The browser plays it via an AudioWorklet
//     ring buffer (no codec → maximally compatible, lowest decode latency; local
//     bandwidth is free next to the video).
//   - INPUT: a /dev/uinput virtual gamepad (scripts/uinput-pad.py). The browser's
//     on-screen overlay (and any BT pad paired to the Pi) drive RetroArch through
//     its `udev` joypad driver; an autoconfig binds our pad to RetroPad on sight.
//
// RetroArch is NOT kept warm: it runs the core at 60 fps even unwatched, so
// leaving the route tears the whole session down. Cold start ~2s.
//
// We identify OUR cage socket by diffing the wayland-* set across our helper
// start, rather than assuming wayland-0 — the service user's runtime dir may
// already hold sockets from other sessions.

import fsSync from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RA_HELPER = process.env.RETROARCH_HELPER || '/usr/local/sbin/tesla-pi-retroarch'
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`
const CAGE_OUTPUT = process.env.CAGE_OUTPUT || 'HEADLESS-1'
// Encode size = the cage output the session launcher pins (must match
// RETROARCH_MODE in scripts/tesla-pi-retroarch-session). 4:3; cores letterbox
// to their own aspect within it (GBA is 3:2). Full-screen with no concurrent
// CarPlay, so we can afford 60 fps and a fatter bitrate than CarPlay itself.
// 720x480 = exactly 3x the GBA's native 240x160 (3:2, no letterbox) and ~56% of
// 1024x768's pixels — wf-recorder's per-frame RGB→yuv420p convert is the CPU
// hog, so fewer pixels is the biggest lever. The browser upscales to fill the
// screen (pixel-art, so crisp). Tunable via env; written to the mode file the
// session launcher reads (so resolution changes never need a privileged update).
const RA_W = Number(process.env.RETROARCH_W || 720)
const RA_H = Number(process.env.RETROARCH_H || 480)
const VIDEO_BITRATE = process.env.RETROARCH_BIT_RATE || '8000000'
// Cap the cage output REFRESH (capture/encode framerate). `--no-damage` makes
// wf-recorder copy + colour-convert every compositor frame, so at 60 Hz it burns
// ~1.4 cores (+ cage ~0.5) for a GBA game. 30 Hz halves that and is smooth for
// 2D games; bump RETROARCH_FPS for fast action at higher CPU/heat. The session
// launcher pins the resolution before RetroArch starts; we re-assert it here at
// the target refresh, before the recorder spawns (changing it under a live
// recorder kills the screencopy).
const RA_FPS = Number(process.env.RETROARCH_FPS || 30)
// Raw PCM audio format the loopback is captured at; the browser worklet must agree.
const AUDIO_RATE = 48000
const AUDIO_CH = 2

const CMD_FILE = path.join(RUNTIME_DIR, 'tesla-pi-retroarch.cmd')
const MODE_FILE = path.join(RUNTIME_DIR, 'tesla-pi-retroarch.mode')
const PAD_SCRIPT = path.join(__dirname, 'scripts', 'uinput-pad.py')

// Cores we allow /retroarch/launch to load, by short key → .so filename. mGBA
// covers GBA + GB/GBC, so all three keys point at it for now. Adding a core is
// one apt package + one line here.
const CORE_DIR = [
  '/usr/lib/aarch64-linux-gnu/libretro',
  '/usr/lib/arm-linux-gnueabihf/libretro',
  '/usr/lib/libretro',
].find((d) => { try { return fsSync.statSync(d).isDirectory() } catch { return false } }) || '/usr/lib/aarch64-linux-gnu/libretro'
const CORES = {
  gba: 'mgba_libretro.so',
  gb: 'mgba_libretro.so',
  gbc: 'mgba_libretro.so',
}
const ROMS_DIR = path.join(process.env.HOME || '/home/tesla-pi', 'retroarch', 'roms')
const ROM_EXT = new Set(['.gba', '.gb', '.gbc', '.zip', '.7z'])

// Allowlisted overlay/RetroPad buttons (must match uinput-pad.py).
const BUTTONS = new Set(['a', 'b', 'x', 'y', 'l', 'r', 'l2', 'r2', 'l3', 'r3',
  'select', 'start', 'menu', 'up', 'down', 'left', 'right'])

const HELPER_START_TIMEOUT_MS = 30000
const CAGE_WAIT_TIMEOUT_MS = 30000
const MODE_WAIT_TIMEOUT_MS = 15000
const IDLE_STOP_MS = Number(process.env.RETROARCH_IDLE_STOP_MS || 2 * 60 * 1000)

export function createRetroarchBridge({ log, execResult, sendJson, attachKeepalive, broadcast }) {
  const socketH264 = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const socketAudio = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const socketInput = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  attachKeepalive(socketH264)
  attachKeepalive(socketAudio)
  attachKeepalive(socketInput)

  let state = 'stopped' // stopped | starting | running | stopping
  let lastError = null
  let recProc = null
  let audioProc = null
  let padProc = null
  let lastKeyframe = null
  let lastClientAt = Date.now()
  let current = { core: null, rom: null } // what's booted

  const installed = () => fsSync.existsSync(RA_HELPER)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ---- cage socket discovery (diff-based; never assumes wayland-0) ---------
  const listSockets = () => {
    try { return fsSync.readdirSync(RUNTIME_DIR).filter((n) => /^wayland-\d+$/.test(n)) }
    catch { return [] }
  }
  async function waitForNewCage(before, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    const had = new Set(before)
    while (Date.now() < deadline) {
      const fresh = listSockets().find((n) => !had.has(n))
      if (fresh) return fresh
      await sleep(500)
    }
    throw new Error('RetroArch cage Wayland socket never appeared')
  }
  // The session launcher resizes the output to RA_WxRA_H before RetroArch starts;
  // wait until that has happened before spawning the recorder, otherwise the
  // mode change lands under a live wf-recorder and kills its screencopy.
  function cageEnv(display) {
    return { ...process.env, XDG_RUNTIME_DIR: RUNTIME_DIR, WAYLAND_DISPLAY: display }
  }
  function readMode(display) {
    return new Promise((resolve) => {
      let out = ''
      const p = spawn('wlr-randr', ['--output', CAGE_OUTPUT], { env: cageEnv(display) })
      p.stdout.on('data', (d) => { out += d })
      p.on('exit', () => resolve(out))
      p.on('error', () => resolve(''))
    })
  }
  async function waitForCageMode(display, timeoutMs) {
    const want = `${RA_W}x${RA_H}`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const out = await readMode(display)
      // wlr-randr prints e.g. "    1024x768 px (current)"
      if (out.split('\n').some((l) => l.includes(want) && l.includes('current'))) return
      await sleep(400)
    }
    log('warn', 'retroarch_mode_wait_timeout', { want })
  }
  // Re-assert the output at the target REFRESH (the launcher set it at whatever it
  // defaults to). Same resolution, so RetroArch's fullscreen surface doesn't
  // resize; this just throttles cage compositing + the recorder to RA_FPS. Must
  // run before the recorder spawns. Returns when wlr-randr exits.
  function setCageRefresh(display) {
    return new Promise((resolve) => {
      const p = spawn('wlr-randr', ['--output', CAGE_OUTPUT, '--custom-mode', `${RA_W}x${RA_H}@${RA_FPS}`],
        { env: cageEnv(display) })
      p.stderr.on('data', (d) => log('debug', 'retroarch_wlr_randr', { err: d.toString().trim().slice(0, 120) }))
      p.on('exit', () => resolve())
      p.on('error', () => resolve())
    })
  }

  // ---- H.264 producer -------------------------------------------------------
  function spawnRecorder(display) {
    const proc = spawn('wf-recorder', [
      '-y',
      '--no-damage',
      '-c', 'h264_v4l2m2m',
      '-m', 'h264',
      '-x', 'yuv420p',
      '-p', `b=${VIDEO_BITRATE}`,
      '-f', 'pipe:1',
    ], { env: cageEnv(display) })
    proc.stdout.on('data', feedAnnexB)
    proc.stderr.on('data', (d) => log('debug', 'wf_recorder', { err: d.toString().trim().slice(0, 200) }))
    proc.on('exit', (code) => {
      log(state === 'stopping' ? 'info' : 'warn', 'retroarch_recorder_exit', { code, state })
      if (state === 'running') stop('recorder_exit')
    })
    return proc
  }

  let nalBuf = Buffer.alloc(0)
  let auPrefix = []
  function feedAnnexB(chunk) {
    nalBuf = nalBuf.length ? Buffer.concat([nalBuf, chunk]) : chunk
    const starts = []
    for (let i = 0; i + 2 < nalBuf.length; i++) {
      if (nalBuf[i] === 0 && nalBuf[i + 1] === 0 && nalBuf[i + 2] === 1) { starts.push(i); i += 2 }
    }
    if (starts.length < 2) return
    for (let s = 0; s < starts.length - 1; s++) {
      const start = starts[s]
      const end = starts[s + 1]
      const scLen = (start > 0 && nalBuf[start - 1] === 0) ? 4 : 3
      const nal = nalBuf.subarray(start - (scLen - 3), end)
      const type = nalBuf[start + 3] & 0x1f
      if (type === 1 || type === 5) {
        const au = Buffer.concat([...auPrefix, nal])
        auPrefix = []
        emitAccessUnit(au, type === 5)
      } else {
        auPrefix.push(nal)
      }
    }
    nalBuf = nalBuf.subarray(starts[starts.length - 1])
  }
  function emitAccessUnit(au, isKeyframe) {
    if (isKeyframe) lastKeyframe = au
    lastClientAt = socketH264.clients.size ? Date.now() : lastClientAt
    broadcast(socketH264, au, { binary: true, compress: false })
  }

  // ---- Audio producer: capture the loopback as raw S16LE PCM ----------------
  // ffmpeg negotiates RetroArch's actual ALSA format on the capture side and
  // emits interleaved S16LE @ 48k stereo on stdout; we frame it onto the WS.
  function spawnAudio() {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'alsa', '-i', 'hw:Loopback,1,0',
      '-ac', String(AUDIO_CH), '-ar', String(AUDIO_RATE),
      '-f', 's16le', '-flush_packets', '1', 'pipe:1',
    ])
    proc.stdout.on('data', (chunk) => {
      if (socketAudio.clients.size) broadcast(socketAudio, chunk, { binary: true, compress: false })
    })
    proc.stderr.on('data', (d) => log('debug', 'retroarch_audio', { err: d.toString().trim().slice(0, 200) }))
    proc.on('exit', (code) => log(state === 'stopping' ? 'debug' : 'warn', 'retroarch_audio_exit', { code }))
    return proc
  }

  // ---- Input: the uinput virtual gamepad daemon ----------------------------
  // Resolves once the daemon prints PAD_READY (the uinput device exists), so the
  // caller can guarantee the pad is present BEFORE RetroArch enumerates joypads
  // at startup — otherwise RetroArch may not autoconfig-bind it and ignores input.
  function spawnPad() {
    return new Promise((resolve) => {
      const proc = spawn('python3', [PAD_SCRIPT], { stdio: ['pipe', 'ignore', 'pipe'] })
      let done = false
      const ready = () => { if (!done) { done = true; resolve(proc) } }
      proc.stderr.on('data', (d) => {
        const s = d.toString()
        if (s.includes('PAD_READY')) ready()
        log('debug', 'retroarch_pad', { msg: s.trim().slice(0, 120) })
      })
      proc.on('exit', (code) => log(state === 'stopping' ? 'debug' : 'warn', 'retroarch_pad_exit', { code }))
      proc.on('error', (e) => { log('warn', 'retroarch_pad_spawn_failed', { msg: e.message }); ready() })
      setTimeout(ready, 3000) // never hang the start on a stuck daemon
    })
  }
  function handleInput(msg) {
    if (!padProc || !padProc.stdin.writable) return
    if (msg.type !== 'button' || !BUTTONS.has(msg.button)) return
    const action = msg.action === 'down' ? 'down' : 'up'
    try { padProc.stdin.write(JSON.stringify({ btn: msg.button, action }) + '\n') } catch {}
  }

  // ---- Lifecycle ------------------------------------------------------------
  function writeCmd(core, rom) {
    // Two lines the session launcher reads: core .so path, ROM path (blank = menu).
    try { fsSync.writeFileSync(CMD_FILE, `${core || ''}\n${rom || ''}\n`, { mode: 0o644 }) }
    catch (e) { log('warn', 'retroarch_cmd_write_failed', { msg: e.message }) }
    // The launcher reads this to pin the cage output BEFORE RetroArch starts, so
    // resolution/fps is bridge-controlled (no privileged file edits to retune).
    try { fsSync.writeFileSync(MODE_FILE, `${RA_W}x${RA_H}@${RA_FPS}\n`, { mode: 0o644 }) }
    catch (e) { log('warn', 'retroarch_mode_write_failed', { msg: e.message }) }
  }

  async function doStart(core, rom) {
    if (state === 'running' || state === 'starting') return
    lastError = null
    state = 'starting'
    current = { core: core || null, rom: rom || null }
    log('info', 'retroarch_start_begin', { core: core || null, rom: rom || null })
    try {
      writeCmd(core, rom)
      // Pad first AND wait for it to be ready, so the uinput device exists before
      // RetroArch enumerates joypads at startup (else it won't bind → no input).
      padProc = await spawnPad()
      const before = listSockets()
      const helper = await execResult('sudo', ['-n', RA_HELPER, 'start'], HELPER_START_TIMEOUT_MS)
      if (!helper.ok) throw new Error('helper start failed: ' + (helper.stderr || helper.stdout))
      const display = await waitForNewCage(before, CAGE_WAIT_TIMEOUT_MS)
      log('info', 'retroarch_cage_ready', { display })
      await waitForCageMode(display, MODE_WAIT_TIMEOUT_MS)
      await setCageRefresh(display)   // throttle to RA_FPS before the recorder starts
      lastKeyframe = null
      nalBuf = Buffer.alloc(0); auPrefix = []
      recProc = spawnRecorder(display)
      audioProc = spawnAudio()
      state = 'running'
      lastClientAt = Date.now()
      log('info', 'retroarch_started', { display })
    } catch (err) {
      lastError = err.message
      log('error', 'retroarch_start_failed', { msg: err.message })
      await teardown('start_failed')
      throw err
    }
  }

  function killProcs() {
    for (const ws of socketH264.clients) { try { ws.close() } catch {} }
    try { recProc?.kill('SIGINT') } catch {}
    try { audioProc?.kill('SIGINT') } catch {}
    try { padProc?.kill('SIGTERM') } catch {}
    recProc = null; audioProc = null; padProc = null
    lastKeyframe = null
  }

  // Full teardown — stop the encoder/audio/pad AND the cage unit (frees the
  // emulation CPU). This is the only stop RetroArch has; no warm-keep.
  async function teardown(reason) {
    if (state === 'stopped' || state === 'stopping') { killProcs(); state = 'stopped'; return }
    state = 'stopping'
    log('info', 'retroarch_teardown_begin', { reason })
    killProcs()
    const r = await execResult('sudo', ['-n', RA_HELPER, 'stop'], 30000)
    if (!r.ok) log('warn', 'retroarch_helper_stop_failed', { stderr: r.stderr })
    current = { core: null, rom: null }
    state = 'stopped'
    log('info', 'retroarch_teardown_done', { reason })
  }
  const stop = (reason) => teardown(reason)

  // ---- Sockets --------------------------------------------------------------
  socketH264.on('connection', (ws) => {
    lastClientAt = Date.now()
    log('info', 'retroarch_h264_connected', { clients: socketH264.clients.size })
    if (lastKeyframe) { try { ws.send(lastKeyframe, { binary: true, compress: false }) } catch {} }
  })
  socketInput.on('connection', (ws) => {
    log('info', 'retroarch_input_connected', { clients: socketInput.clients.size })
    let seen = 0 // per-connection, so each browser session logs its first inputs
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
      if (seen < 12) { seen++; log('info', 'retroarch_input', { msg, pad: !!padProc }) }
      handleInput(msg)
    })
  })

  // Idle stop: nobody watching the video for IDLE_STOP_MS → tear down.
  setInterval(() => {
    if (state !== 'running') return
    if (socketH264.clients.size > 0) { lastClientAt = Date.now(); return }
    if (Date.now() - lastClientAt > IDLE_STOP_MS) stop('idle')
  }, 30000).unref()

  // ---- ROM listing ----------------------------------------------------------
  function listRoms() {
    let names
    try { names = fsSync.readdirSync(ROMS_DIR) } catch { return [] }
    return names
      .filter((n) => ROM_EXT.has(path.extname(n).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((n) => ({ name: n }))
  }
  function resolveRom(name) {
    if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\0')) return null
    const full = path.join(ROMS_DIR, name)
    if (!full.startsWith(ROMS_DIR + path.sep)) return null
    if (!ROM_EXT.has(path.extname(full).toLowerCase())) return null
    try { if (!fsSync.statSync(full).isFile()) return null } catch { return null }
    return full
  }
  function resolveCore(key) {
    const so = CORES[key]
    if (!so) return null
    const full = path.join(CORE_DIR, so)
    return fsSync.existsSync(full) ? full : null
  }

  async function readBody(req) {
    let body = ''
    try { for await (const chunk of req) body += chunk } catch { /* aborted */ }
    try { return JSON.parse(body) } catch { return null }
  }

  async function handleHttp(p, req, res) {
    if (p === '/retroarch/status') {
      sendJson(res, 200, {
        ok: true, installed: installed(), state,
        clients: socketH264.clients.size, audio_clients: socketAudio.clients.size,
        input_clients: socketInput.clients.size,
        core: current.core, rom: current.rom, last_error: lastError,
      })
      return true
    }
    if (p === '/retroarch/roms') {
      sendJson(res, 200, { ok: true, roms: listRoms(), cores: Object.keys(CORES) })
      return true
    }
    if (p === '/retroarch/start') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      if (!installed()) { sendJson(res, 404, { ok: false, error: 'addon_not_installed' }); return true }
      if (state === 'stopped') doStart().catch(() => {})
      sendJson(res, 202, { ok: true, state })
      return true
    }
    if (p === '/retroarch/stop') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      await stop('http')
      sendJson(res, 200, { ok: true, state })
      return true
    }
    if (p === '/retroarch/launch') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      if (!installed()) { sendJson(res, 404, { ok: false, error: 'addon_not_installed' }); return true }
      const j = await readBody(req)
      if (!j) { sendJson(res, 400, { ok: false, error: 'bad_json' }); return true }
      const core = resolveCore(j.core)
      if (!core) { sendJson(res, 400, { ok: false, error: 'unknown_core' }); return true }
      const rom = resolveRom(j.rom)
      if (!rom) { sendJson(res, 400, { ok: false, error: 'unknown_rom' }); return true }
      // Boot the game by (re)starting the session with the core+ROM in the cmd
      // file. RetroArch reads content only at startup, so swapping a game means a
      // session restart (~2s).
      ;(async () => {
        try { await stop('relaunch') } catch {}
        await doStart(core, rom)
      })().catch((e) => log('warn', 'retroarch_launch_failed', { msg: e.message }))
      sendJson(res, 202, { ok: true, core: j.core, rom: j.rom })
      return true
    }
    return false
  }

  return { socketH264, socketAudio, socketInput, handleHttp, stop, state: () => state }
}
