// android-bridge.js — streams the Waydroid UI to the Tesla browser as H.264.
//
// The whole Android stack is off by default. POST /android/start runs
// `sudo mytesla-android start` (Waydroid container + a headless `cage` wlroots
// compositor that hosts the Android UI). We then:
//   - capture the cage output with `wf-recorder`, hardware-encoding it to H.264
//     on the Pi's V4L2 M2M encoder (/dev/video11), and broadcast each access
//     unit over /android/h264 (binary WS). The SPA decodes it with the same
//     WebCodecs worker the CarPlay path uses — smooth, low-CPU, unlike VNC.
//   - translate SPA touches on /android/input into `adb shell input` events
//     (injected straight into Android, bypassing the compositor).
//   - feed the Tesla browser's geolocation (POST /android/gps) into Android as
//     a mock GPS location so Waze/Maps navigate.
//
// Why H.264-from-cage and not scrcpy: scrcpy's in-Android SurfaceControl
// capture emits no frames on this Waydroid image (a known bug). Capturing the
// cage compositor with the Pi's hardware encoder avoids Android's codec stack
// entirely. See docs/android-addon.md.
//
// With no /android/h264 client for IDLE_STOP_MS the stack is torn down (~1.5 GB).

import net from 'net'
import fsSync from 'fs'
import { spawn } from 'child_process'
import { WebSocketServer } from 'ws'

const ANDROID_HELPER = process.env.ANDROID_HELPER || '/usr/local/sbin/mytesla-android'
const ADB_ADDR = process.env.WAYDROID_ADB_ADDR || '192.168.240.112:5555'
// Android input coordinate space (the pinned Waydroid resolution). The browser
// sends normalised touches; we scale to these. Pinned ultrawide (1408×480,
// 2.93:1) to fit the Tesla viewport's wide band without stretch.
const ANDROID_W = Number(process.env.ANDROID_W || 1408)
const ANDROID_H = Number(process.env.ANDROID_H || 480)
// mytesla.service runs as the cage session user but as a *system* unit, so
// XDG_RUNTIME_DIR is usually unset — derive it from the uid.
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`
const CAGE_OUTPUT = process.env.CAGE_OUTPUT || 'HEADLESS-1'
const VIDEO_BITRATE = process.env.ANDROID_BIT_RATE || '6000000'
// Cap the capture/encode framerate by pinning the cage output's REFRESH RATE
// (see setCageResolution). The dock streams continuously while you're on the
// 16:8 CarPlay screen; with `--no-damage` wf-recorder copies+encodes on every
// compositor frame, so at the default ~60 Hz it burns ~1.5 cores for a mostly-
// static map. Capping the headless output to 20 Hz throttles both cage's
// compositing and wf-recorder's capture. 20 is smooth enough for a route map.
// (wf-recorder's own `-r` does NOT throttle when `--no-damage` is set — the
// output refresh is the only effective lever.) Set this BEFORE the recorder
// starts; changing it under a live recorder kills the screencopy.
const ANDROID_FPS = Number(process.env.ANDROID_FPS || 20)
// The app foregrounded when a viewer starts streaming. The runtime stays warm
// on the Android home screen between sessions; this is brought up on tap.
const ANDROID_APP = process.env.ANDROID_APP || 'com.waze'
// Apps the launcher may foreground, by short key. Allowlisted so the
// /android/launch endpoint can never be coerced into starting an arbitrary
// component.
const ANDROID_APPS = {
  waze: 'com.waze',
}
const HELPER_START_TIMEOUT_MS = 150000
const CAGE_WAIT_TIMEOUT_MS = 120000
// How long with no viewer before we stop streaming. Now cheap (it only kills
// the encoder and backgrounds the app — the container stays warm), so we can
// reclaim the encode CPU/heat quickly rather than holding it for 10 min.
const IDLE_STOP_MS = Number(process.env.ANDROID_IDLE_STOP_MS || 2 * 60 * 1000)

export function createAndroidBridge({ log, execResult, sendJson, attachKeepalive, broadcast }) {
  const socketH264 = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const socketInput = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  attachKeepalive(socketH264)
  attachKeepalive(socketInput)

  let state = 'stopped' // stopped | starting | running | stopping
  let lastError = null
  let recProc = null
  let lastKeyframe = null  // cached SPS+PPS+IDR access unit for late joiners
  let lastClientAt = Date.now()

  const installed = () => fsSync.existsSync(ANDROID_HELPER)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const adb = (args, timeoutMs = 8000) => execResult('adb', ['-s', ADB_ADDR, ...args], timeoutMs)

  // Bring an app to the foreground. `monkey` launches most apps but silently
  // bounces some straight back to the launcher, so resolve the app's launcher
  // activity and `am start` it explicitly; fall back to monkey.
  async function foregroundApp(pkg) {
    try {
      const r = await adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief',
        '-c', 'android.intent.category.LAUNCHER', pkg], 6000)
      const comp = (r.stdout || '').split('\n').map((l) => l.trim())
        .find((l) => l.startsWith(pkg + '/'))
      if (comp) { await adb(['shell', 'am', 'start', '-n', comp], 8000); return }
    } catch (e) { log('debug', 'foreground_resolve_failed', { pkg, msg: e.message }) }
    adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']).catch(() => {})
  }

  // cage names its Wayland socket wayland-N (it ignores the WAYLAND_DISPLAY we
  // pass in the unit file), so discover the actual socket in the runtime dir.
  function findCageDisplay() {
    let names
    try { names = fsSync.readdirSync(RUNTIME_DIR) } catch { return null }
    return names.find((n) => /^wayland-\d+$/.test(n)) || null
  }
  async function waitForCage(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const d = findCageDisplay()
      if (d) return d
      await sleep(1000)
    }
    throw new Error('cage Wayland socket never appeared in ' + RUNTIME_DIR)
  }

  // cage's headless wlroots output defaults to 1280x720 (16:9). Resize it to
  // the Android render resolution (ANDROID_W×ANDROID_H, 1.28:1) so the whole
  // screen is captured — not just the top — and the video fills the Tesla
  // viewport without letterboxing.
  function setCageResolution(display) {
    return new Promise((resolve) => {
      const p = spawn('wlr-randr', ['--output', CAGE_OUTPUT, '--custom-mode', `${ANDROID_W}x${ANDROID_H}@${ANDROID_FPS}`],
        { env: { ...process.env, XDG_RUNTIME_DIR: RUNTIME_DIR, WAYLAND_DISPLAY: display } })
      p.stderr.on('data', (d) => log('debug', 'wlr_randr', { err: d.toString().trim().slice(0, 120) }))
      p.on('exit', () => resolve())
      p.on('error', () => resolve())
    })
  }

  // ---- H.264 producer ---------------------------------------------------
  // wf-recorder captures the cage output via wlr-screencopy and hardware-
  // encodes it to a raw Annex-B H.264 stream on stdout. We split that byte
  // stream into access units (one frame each) and broadcast them.
  function spawnRecorder(display) {
    const proc = spawn('wf-recorder', [
      '-y',                          // don't prompt to "overwrite" the output
      '--no-damage',                 // emit every frame (steady fps) — a static
                                     // screen otherwise stalls the AU splitter,
                                     // which only flushes a frame at the next one.
                                     // The frame rate is bounded by the cage
                                     // output's refresh (set in setCageResolution).
      '-c', 'h264_v4l2m2m',          // Pi hardware H.264 encoder
      '-m', 'h264',                  // raw Annex-B, no container (streamable)
      '-x', 'yuv420p',
      '-p', `b=${VIDEO_BITRATE}`,
      '-f', 'pipe:1',                // libav pipe protocol → our stdout (fd 1)
    ], { env: { ...process.env, XDG_RUNTIME_DIR: RUNTIME_DIR, WAYLAND_DISPLAY: display } })
    proc.stdout.on('data', feedAnnexB)
    proc.stderr.on('data', (d) => log('debug', 'wf_recorder', { err: d.toString().trim().slice(0, 200) }))
    proc.on('exit', (code) => {
      log(state === 'stopping' ? 'info' : 'warn', 'wf_recorder_exit', { code, state })
      if (state === 'running') stop('recorder_exit')
    })
    return proc
  }

  // Annex-B access-unit splitter. NALs are start-code delimited; a frame's
  // VCL NAL (type 1/5) is preceded by its SPS/PPS/SEI. We flush one access
  // unit (the non-VCL prefix + the VCL NAL) per frame.
  let nalBuf = Buffer.alloc(0)
  let auPrefix = []          // non-VCL NALs (SPS/PPS/SEI) awaiting a VCL NAL
  function feedAnnexB(chunk) {
    nalBuf = nalBuf.length ? Buffer.concat([nalBuf, chunk]) : chunk
    // Find 3-byte start codes (0x000001); 4-byte ones are a 0x00 + 3-byte.
    let starts = []
    for (let i = 0; i + 2 < nalBuf.length; i++) {
      if (nalBuf[i] === 0 && nalBuf[i + 1] === 0 && nalBuf[i + 2] === 1) { starts.push(i); i += 2 }
    }
    if (starts.length < 2) return // need at least one complete NAL after a start
    // Process complete NALs (between consecutive start codes); keep the tail.
    for (let s = 0; s < starts.length - 1; s++) {
      const start = starts[s]
      const end = starts[s + 1]
      // NAL incl. its leading start code, trimming a preceding 0x00 (4-byte sc).
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

  // Start streaming. The Android runtime (container + cage) is pre-warmed at
  // boot by mytesla-android-warm.service and kept up, so the helper-start here
  // is normally a fast idempotent no-op — it also self-heals if the container
  // died. We then foreground the app and spin up the encoder. From a warm
  // runtime this is ~1-2s (vs ~10-30s from cold).
  async function doStart() {
    if (state === 'running' || state === 'starting') return
    lastError = null
    state = 'starting'
    log('info', 'android_start_begin')
    try {
      const helper = await execResult('sudo', ['-n', ANDROID_HELPER, 'start'], HELPER_START_TIMEOUT_MS)
      if (!helper.ok) throw new Error('helper start failed: ' + (helper.stderr || helper.stdout))
      const display = await waitForCage(CAGE_WAIT_TIMEOUT_MS)
      log('info', 'android_cage_ready', { display })
      await setCageResolution(display)
      // Foreground the app so the stream shows it, not the idle home screen.
      foregroundApp(ANDROID_APP).catch(() => {})
      lastKeyframe = null
      nalBuf = Buffer.alloc(0); auPrefix = []
      recProc = spawnRecorder(display)
      state = 'running'
      lastClientAt = Date.now()
      log('info', 'android_started', { display })
      setupMockGps().catch((e) => log('warn', 'android_mock_gps_failed', { msg: e.message }))
    } catch (err) {
      lastError = err.message
      log('error', 'android_start_failed', { msg: err.message })
      // A hard start failure leaves the runtime in an unknown state — tear it
      // down fully so the next attempt (or the warm unit) rebuilds it clean.
      await teardown('start_failed')
      throw err
    }
  }

  // Stop the H.264 stream and return Android to its idle home screen, but leave
  // the container + cage WARM (boot pre-warms them; we never tear them down on
  // idle). Killing the encoder reclaims its ~half-core; backgrounding the app
  // stops it rendering the map while nobody is watching. The next tap
  // re-foregrounds it in ~1-2s. This is also what runs on mytesla restart, so
  // a bridge reload doesn't disturb a warm Android.
  function stop(reason) {
    if (state === 'stopped' || state === 'stopping') return
    state = 'stopping'
    log('info', 'android_stream_stop', { reason })
    for (const ws of socketH264.clients) { try { ws.close() } catch {} }
    try { recProc?.kill('SIGINT') } catch {}
    recProc = null
    lastKeyframe = null
    adb(['shell', 'input', 'keyevent', '3']).catch(() => {}) // HOME — background the app
    state = 'stopped'
    log('info', 'android_stream_stopped', { reason })
  }

  // Full teardown: stop the stream AND the warm container (frees ~1.5-2 GB).
  // Reserved for hard failures; normal idle keeps Android warm via stop().
  async function teardown(reason) {
    log('info', 'android_teardown_begin', { reason })
    for (const ws of socketH264.clients) { try { ws.close() } catch {} }
    try { recProc?.kill('SIGINT') } catch {}
    recProc = null
    lastKeyframe = null
    mockGpsReady = false
    state = 'stopped'
    const r = await execResult('sudo', ['-n', ANDROID_HELPER, 'stop'], 60000)
    if (!r.ok) log('warn', 'android_helper_stop_failed', { stderr: r.stderr })
    log('info', 'android_teardown_done', { reason })
  }

  // ---- Mock GPS ---------------------------------------------------------
  // Waydroid has no GNSS. Register a test "gps" provider over adb and push the
  // browser's fixes into it; Play Services' fused provider (Waze/Maps' source)
  // surfaces them as the device location. Pure adb, no in-Android app.
  let mockGpsReady = false
  async function setupMockGps() {
    mockGpsReady = false
    await execResult('adb', ['connect', ADB_ADDR], 5000)
    for (let i = 0; i < 30; i++) {
      const r = await adb(['shell', 'getprop', 'sys.boot_completed'], 5000)
      if (r.stdout.trim() === '1') break
      await sleep(2000)
    }
    await adb(['shell', 'appops', 'set', 'com.android.shell', 'android:mock_location', 'allow'])
    await adb(['shell', 'cmd', 'location', 'providers', 'add-test-provider', 'gps'])
    await adb(['shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', 'gps', 'true'])
    mockGpsReady = true
    log('info', 'android_mock_gps_ready')
  }
  async function pushGps({ lat, lon, accuracy }) {
    if (!mockGpsReady) return
    const args = ['shell', 'cmd', 'location', 'providers',
      'set-test-provider-location', 'gps', '--location', `${lat},${lon}`]
    if (typeof accuracy === 'number' && isFinite(accuracy)) args.push('--accuracy', String(Math.max(1, Math.round(accuracy))))
    await adb(args, 5000)
  }

  // ---- Touch input ------------------------------------------------------
  // Browser sends normalised coords; we inject into Android via `adb shell
  // input`. A press→release at ~the same point is a tap; a drag becomes a
  // swipe (Android has no streaming touch over `input`, so a drag is sent as
  // one swipe on release). Coords scale to the Android resolution.
  const px = (x) => Math.round(Math.min(1, Math.max(0, x)) * ANDROID_W)
  const py = (y) => Math.round(Math.min(1, Math.max(0, y)) * ANDROID_H)
  function handleInput(msg) {
    if (msg.type === 'tap') {
      adb(['shell', 'input', 'tap', String(px(msg.x)), String(py(msg.y))]).catch(() => {})
    } else if (msg.type === 'swipe') {
      const dur = String(Math.max(50, Math.min(2000, msg.ms || 200)))
      adb(['shell', 'input', 'swipe', String(px(msg.x1)), String(py(msg.y1)), String(px(msg.x2)), String(py(msg.y2)), dur]).catch(() => {})
    } else if (msg.type === 'key') {
      const KEY = { back: '4', home: '3', recents: '187' }
      if (KEY[msg.key]) adb(['shell', 'input', 'keyevent', KEY[msg.key]]).catch(() => {})
    }
  }

  // ---- Sockets ----------------------------------------------------------
  socketH264.on('connection', (ws) => {
    lastClientAt = Date.now()
    log('info', 'android_h264_connected', { clients: socketH264.clients.size })
    // Late joiner: replay the last keyframe so its decoder can start before the
    // next GOP boundary.
    if (lastKeyframe) { try { ws.send(lastKeyframe, { binary: true, compress: false }) } catch {} }
  })
  socketInput.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
      handleInput(msg)
    })
  })

  // Stop encoding (and background the app) when nobody is watching — the
  // container stays warm, so this reclaims CPU/heat, not RAM.
  setInterval(() => {
    if (state !== 'running') return
    if (socketH264.clients.size > 0) { lastClientAt = Date.now(); return }
    if (Date.now() - lastClientAt > IDLE_STOP_MS) stop('idle')
  }, 30000).unref()

  async function handleHttp(p, req, res) {
    if (p === '/android/status') {
      sendJson(res, 200, {
        ok: true, installed: installed(), state,
        clients: socketH264.clients.size, gps: mockGpsReady, last_error: lastError,
      })
      return true
    }
    if (p === '/android/start') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      if (!installed()) { sendJson(res, 404, { ok: false, error: 'addon_not_installed' }); return true }
      if (state === 'stopped') doStart().catch(() => {})
      sendJson(res, 202, { ok: true, state })
      return true
    }
    if (p === '/android/stop') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      await stop('http')
      sendJson(res, 200, { ok: true, state })
      return true
    }
    if (p === '/android/gps') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      let body = ''
      try { for await (const chunk of req) body += chunk } catch { /* aborted */ }
      let pos; try { pos = JSON.parse(body) } catch { sendJson(res, 400, { ok: false, error: 'bad_json' }); return true }
      if (typeof pos?.lat === 'number' && typeof pos?.lon === 'number') {
        pushGps(pos).catch((e) => log('warn', 'android_gps_push_failed', { msg: e.message }))
      }
      sendJson(res, 200, { ok: true, ready: mockGpsReady })
      return true
    }
    if (p === '/android/launch') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      let body = ''
      try { for await (const chunk of req) body += chunk } catch { /* aborted */ }
      let j; try { j = JSON.parse(body) } catch { sendJson(res, 400, { ok: false, error: 'bad_json' }); return true }
      const pkg = ANDROID_APPS[j?.app]
      if (!pkg) { sendJson(res, 400, { ok: false, error: 'unknown_app' }); return true }
      if (state !== 'running') { sendJson(res, 409, { ok: false, error: 'not_running', state }); return true }
      foregroundApp(pkg).catch((e) => log('warn', 'android_launch_failed', { app: j.app, msg: e.message }))
      sendJson(res, 200, { ok: true, app: j.app })
      return true
    }
    return false
  }

  return { socketH264, socketInput, handleHttp, stop, state: () => state }
}
