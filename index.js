import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs/promises'
import fsSync from 'fs'
import { fileURLToPath } from 'url'
import { spawn, execFile } from 'child_process'
import { WebSocketServer } from 'ws'
import CarplayNode, { MessageHeader } from 'node-carplay/node'
import { usb } from 'usb'
import { createAndroidBridge } from './android-bridge.js'
import { createRetroarchBridge } from './retroarch-bridge.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.join(__dirname, 'static')
const PORT = 8080
const CARLINKIT_VID = 0x1314
const CARPLAY_CMD_DASHBOARD = 3 // iOS "exit CarPlay → host UI" signal (car-icon tap)
const CARPLAY_CMD_PLAY_OR_PAUSE = 203 // MusicPlayOrPause — absent from node-carplay 4.1.0's CommandMapping
const ALLOWED_MEDIA_KEYS = new Set(['next', 'prev', 'playOrPause', 'siri', 'home'])
const MAX_START_ATTEMPTS = 20
const START_RETRY_MS = 1000
const DETACH_SETTLE_MS = 2000
const CERT_PATH = process.env.CERT_PATH

// Settings → WiFi tab. Available whenever wlan1 exists.
const WIFI_IFACE = process.env.WIFI_IFACE || 'wlan1'
const WIFI_HELPER = process.env.WIFI_HELPER || '/usr/local/sbin/mytesla-wifi'
// Forgetting a wlan0 NM profile bricks CarPlay AP / home-Wi-Fi modes.
const WIFI_PROTECTED_NAME_RE = /^(netplan-wlan0-|hostapd|wlan0-)/i

// /healthz is polled every ~2 s by the client; re-reading and parsing the
// X.509 cert on every hit is wasteful. Cache the parsed expiry and recompute
// the day count from the clock, refreshing the file read at most hourly.
let _certValidToMs = null
let _certReadAt = 0
const CERT_CACHE_MS = 3600000
function certDaysRemaining() {
  if (!CERT_PATH) return null
  const now = Date.now()
  if (_certReadAt === 0 || now - _certReadAt > CERT_CACHE_MS) {
    _certReadAt = now
    try {
      const cert = new crypto.X509Certificate(fsSync.readFileSync(CERT_PATH, 'utf8'))
      _certValidToMs = new Date(cert.validTo).getTime()
    } catch {
      _certValidToMs = null
    }
  }
  if (_certValidToMs == null) return null
  return Math.floor((_certValidToMs - now) / 86400000)
}

const LOG_RING_CAP = 200
const logRing = []
const log = (level, evt, fields = {}) => {
  const entry = { ts: new Date().toISOString(), level, evt, ...fields }
  console.log(JSON.stringify(entry))
  logRing.push(entry)
  if (logRing.length > LOG_RING_CAP) logRing.splice(0, logRing.length - LOG_RING_CAP)
}

const SETTINGS_FILE = process.env.MYTESLA_SETTINGS_FILE || path.join(__dirname, 'settings.local.json')
const ALLOWED_FPS = new Set([30, 60])
const DEFAULT_FPS = 60
// HandDriveType from node-carplay: 0 = LHD, 1 = RHD. Default to RHD —
// matches the prior hardcoded value so existing Pis don't flip on upgrade.
const ALLOWED_HAND = new Set([0, 1])
const DEFAULT_HAND = 1
// Display aspect: dongle width is always 1920; the mode picks the height it
// negotiates. 'full' ≈ fills the square Tesla browser (original behaviour);
// 'wide' (16:8) shrinks CarPlay to a top band so the client frees a dock below.
const ALLOWED_ASPECT = new Set(['full', 'wide'])
const DEFAULT_ASPECT = 'wide'
const ASPECT_HEIGHT = { full: 1496, wide: 840 } // wide = 16:7 CarPlay (1920×840); dock takes the rest

function loadPersistedSettings() {
  const out = { fps: DEFAULT_FPS, hand: DEFAULT_HAND, aspect: DEFAULT_ASPECT }
  let raw
  try { raw = fsSync.readFileSync(SETTINGS_FILE, 'utf8') }
  catch (e) {
    if (e.code !== 'ENOENT') log('warn', 'settings_load_failed', { msg: e.message })
    return out
  }
  let j
  try { j = JSON.parse(raw) }
  catch (e) {
    log('warn', 'settings_load_failed', { msg: 'invalid JSON: ' + e.message })
    return out
  }
  if (ALLOWED_FPS.has(j.fps)) out.fps = j.fps
  else if (j.fps !== undefined) log('warn', 'settings_load_failed', { msg: 'fps out of range', value: j.fps })
  if (ALLOWED_HAND.has(j.hand)) out.hand = j.hand
  else if (j.hand !== undefined) log('warn', 'settings_load_failed', { msg: 'hand out of range', value: j.hand })
  if (ALLOWED_ASPECT.has(j.aspect)) out.aspect = j.aspect
  else if (j.aspect !== undefined) log('warn', 'settings_load_failed', { msg: 'aspect invalid', value: j.aspect })
  return out
}

const persisted = loadPersistedSettings()

const config = {
  width: 1920,
  height: ASPECT_HEIGHT[persisted.aspect],
  aspect: persisted.aspect,
  fps: persisted.fps,
  dpi: 160,
  nightMode: false,
  hand: persisted.hand,
  boxName: 'nodePlay',
  mediaDelay: 300,
  audioTransferMode: true,
}

function cpuTempC() {
  try {
    const raw = fsSync.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')
    return Math.round(parseInt(raw, 10) / 100) / 10
  } catch {
    return null
  }
}

const carplay = new CarplayNode(config)
// node-carplay copies the config at construction (`this._config = Object.assign(
// {}, DEFAULT_CONFIG, config)`), so later mutations to our `config` (aspect/fps/
// hand changes) never reached start() — the dongle always re-negotiated at the
// boot resolution. Pull the driver's merged config (which adds DEFAULT_CONFIG
// fields we omit, e.g. phoneConfig) back into our object, then share the single
// reference so a restart re-negotiates with live values.
Object.assign(config, carplay._config)
carplay._config = config
let plugged = false
let carplayStarted = false
let restartInFlight = false
let nightMode = false

// node-carplay 4.1.0's CommandMapping is incomplete (e.g. it omits 203,
// MusicPlayOrPause), so sendKey() can't reach every dongle command. Send a
// raw SendCommand frame (USB msg type 0x08, 4-byte LE command id) directly —
// the same dongleDriver.send technique the multitouch path uses for 0x17.
function sendCommand(id) {
  const wire = Buffer.allocUnsafe(20)
  MessageHeader.asBuffer(0x08, 4).copy(wire, 0)
  wire.writeUInt32LE(id, 16)
  carplay.dongleDriver.send({ serialise: () => wire })
}

function applyNightMode(value, reason) {
  nightMode = !!value
  if (!plugged) return
  try {
    carplay.sendKey(nightMode ? 'enableNightMode' : 'disableNightMode')
    log('info', 'night_mode_applied', { value: nightMode, reason })
  } catch (err) {
    log('warn', 'night_mode_failed', { msg: err.message })
  }
}

async function persistSettings() {
  const tmp = SETTINGS_FILE + '.tmp'
  const body = JSON.stringify({ fps: config.fps, hand: config.hand, aspect: config.aspect }) + '\n'
  await fs.writeFile(tmp, body, { mode: 0o644 })
  await fs.rename(tmp, SETTINGS_FILE)
}

async function applyFrameRate(value) {
  if (!ALLOWED_FPS.has(value)) {
    log('warn', 'frame_rate_rejected', { value })
    return
  }
  if (config.fps === value) return
  config.fps = value
  try { await persistSettings() }
  catch (err) { log('warn', 'frame_rate_persist_failed', { msg: err.message }) }
  broadcast(socketControl, JSON.stringify({ type: 'frameRate', value }), { compress: false })
  log('info', 'frame_rate_applied', { value })
  restartCarplay('fps_change')
}

async function applyHand(value) {
  const v = Number(value)
  if (!ALLOWED_HAND.has(v)) {
    log('warn', 'hand_rejected', { value })
    return
  }
  if (config.hand === v) return
  config.hand = v
  try { await persistSettings() }
  catch (err) { log('warn', 'hand_persist_failed', { msg: err.message }) }
  broadcast(socketControl, JSON.stringify({ type: 'hand', value: v }), { compress: false })
  log('info', 'hand_applied', { value: v })
  restartCarplay('hand_change')
}

async function applyAspect(value) {
  if (!ALLOWED_ASPECT.has(value)) {
    log('warn', 'aspect_rejected', { value })
    return
  }
  if (config.aspect === value) return
  config.aspect = value
  config.height = ASPECT_HEIGHT[value]
  try { await persistSettings() }
  catch (err) { log('warn', 'aspect_persist_failed', { msg: err.message }) }
  broadcast(socketControl, JSON.stringify({ type: 'aspect', value }), { compress: false })
  log('info', 'aspect_applied', { value, height: config.height })
  restartCarplay('aspect_change')
}

// Kick the dongle to retry phone pairing. Caller-rate-limited because a
// flapping WS keepalive could otherwise stack pokes on top of the 15 s
// periodic tick. See docs/carlink-protocol-notes.md.
const AUTOCONNECT_MIN_GAP_MS = 5000
let lastPokeAt = 0
function pokeAutoconnect(trigger, keys = ['wifiConnect']) {
  if (plugged || !carplayStarted) return
  const now = Date.now()
  if (now - lastPokeAt < AUTOCONNECT_MIN_GAP_MS) return
  lastPokeAt = now
  try {
    for (const k of keys) carplay.sendKey(k)
    log(trigger === 'tick' ? 'debug' : 'info', 'autoconnect_poke', { trigger, keys })
  } catch (err) {
    log('warn', 'autoconnect_poke_failed', { msg: err.message, trigger })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function restartCarplay(reason) {
  if (restartInFlight) {
    log('debug', 'restart_skipped', { reason, why: 'in_flight' })
    return
  }
  restartInFlight = true
  const wasStarted = carplayStarted
  carplayStarted = false
  plugged = false
  log('info', 'restart_begin', { reason })
  if (wasStarted) {
    try { await carplay.stop() } catch {}
    // Let the USB device settle after stop() — otherwise the first start()'s
    // device.reset() races the not-yet-released handle (LIBUSB_ERROR_NOT_FOUND)
    // and burns several ~5s retries. One clean attempt is faster than 3 failed.
    await sleep(DETACH_SETTLE_MS)
  }
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    try {
      await carplay.start()
      carplayStarted = true
      restartInFlight = false
      log('info', 'carplay_started', { attempt })
      return
    } catch (err) {
      log('warn', 'start_failed', { attempt, msg: err.message })
      try { await carplay.stop() } catch {}
      await sleep(START_RETRY_MS)
    }
  }
  log('error', 'start_giving_up', { attempts: MAX_START_ATTEMPTS })
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, body, extraHeaders) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...(extraHeaders || {}) })
  res.end(JSON.stringify(body))
}

const execResult = (cmd, args, timeoutMs = 1500) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
    resolve({
      ok: !err,
      stdout: (stdout || '').toString().trim(),
      stderr: (stderr || '').toString().trim(),
    })
  })
})

async function readJsonBody(req, maxBytes = 4 * 1024) {
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function wifiPresent() {
  try { await fs.access('/sys/class/net/' + WIFI_IFACE); return true }
  catch { return false }
}
// execFile (not shell) — SSIDs and passwords pass through as argv only.
function callHelper(args, timeoutMs = 15000) {
  return execResult('sudo', ['-n', WIFI_HELPER, ...args], timeoutMs)
}
// Shared 404/405 preamble for every /wifi/* handler. Returns true and
// writes the error response when the request can't proceed.
async function wifiGuard(req, res, { method } = {}) {
  if (!(await wifiPresent())) { sendJson(res, 404, { ok: false, error: 'no_wifi_iface', iface: WIFI_IFACE }); return true }
  if (method && req.method !== method) { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: method }); return true }
  return false
}

// nmcli -t emits colon-separated rows with ':' inside fields escaped as
// '\:' and '\\' for backslash — naive split('\:') corrupts SSIDs.
function parseNmcliRow(line) {
  const out = []
  let buf = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) { buf += line[i + 1]; i++; continue }
    if (c === ':') { out.push(buf); buf = ''; continue }
    buf += c
  }
  out.push(buf)
  return out
}

function parseStatus(stdout) {
  const out = { state: null, connection: null, ip: null }
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const fields = parseNmcliRow(line)
    const key = fields[0] || ''
    const val = fields.slice(1).join(':')
    if (key === 'GENERAL.STATE') out.state = val
    else if (key === 'GENERAL.CONNECTION') out.connection = val && val !== '--' ? val : null
    else if (key.startsWith('IP4.ADDRESS') && !out.ip && val) out.ip = val.split('/')[0]
  }
  return out
}

// Columns: IN-USE:BSSID:SSID:SIGNAL:SECURITY:FREQ
function parseScan(stdout) {
  const rows = []
  const seen = new Map()
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const f = parseNmcliRow(line)
    if (f.length < 6) continue
    const ssid = f[2]
    if (!ssid) continue   // hidden SSIDs are not actionable from a list
    const row = {
      in_use: f[0] === '*',
      bssid: f[1],
      ssid,
      signal: Number(f[3]) || 0,
      security: f[4] || '',
      freq: Number(f[5]) || 0,
    }
    const key = ssid + '\0' + row.security
    if (seen.has(key)) {
      const prev = rows[seen.get(key)]
      if (row.signal > prev.signal) rows[seen.get(key)] = row
    } else {
      seen.set(key, rows.length)
      rows.push(row)
    }
  }
  rows.sort((a, b) => b.signal - a.signal)
  return rows
}

// Columns: NAME:TYPE:AUTOCONNECT:DEVICE — helper pre-filters to wifi.
function parseSaved(stdout) {
  const out = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const f = parseNmcliRow(line)
    out.push({
      name: f[0],
      autoconnect: f[2] === 'yes',
      active_on: f[3] && f[3] !== '--' ? f[3] : null,
    })
  }
  return out
}

const SSID_RE = /^[\x20-\x7e]{1,32}$/  // printable ASCII; rules out NUL injection
function validateConnectBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object'
  if (typeof body.ssid !== 'string' || !SSID_RE.test(body.ssid)) return 'invalid ssid'
  if (body.password != null) {
    if (typeof body.password !== 'string') return 'password must be a string'
    if (body.password.length < 8 || body.password.length > 63) return 'password must be 8–63 chars'
  }
  return null
}

const httpServer = http.createServer(async (req, res) => {
  try {
    let p = new URL(req.url, 'http://x').pathname
    if (p === '/healthz') {
      const totalMb = Math.round(os.totalmem() / 1048576)
      const usedMb = Math.round((os.totalmem() - os.freemem()) / 1048576)
      sendJson(res, 200, {
        carplay: plugged ? 'plugged' : carplayStarted ? 'unplugged' : 'starting',
        uptime_s: Math.floor(process.uptime()),
        video_clients: socketVideo.clients.size,
        control_clients: socketControl.clients.size,
        cert_days_remaining: certDaysRemaining(),
        hostname: os.hostname(),
        cpu_temp_c: cpuTempC(),
        mem_used_mb: usedMb,
        mem_total_mb: totalMb,
        load_avg: Math.round(os.loadavg()[0] * 100) / 100,
        cpu_count: os.cpus().length,
        android: android.state(),
        retroarch: retroarch.state(),
      })
      return
    }
    if (p.startsWith('/android/')) {
      if (await android.handleHttp(p, req, res)) return
    }
    if (p.startsWith('/retroarch/')) {
      if (await retroarch.handleHttp(p, req, res)) return
    }
    if (p === '/logs') {
      sendJson(res, 200, { entries: logRing })
      return
    }
    if (p === '/wifi/status') {
      if (await wifiGuard(req, res)) return
      const statusRes = await callHelper(['status'])
      const s = statusRes.ok ? parseStatus(statusRes.stdout) : { state: null, connection: null, ip: null }
      const managed = !!s.state && !s.state.includes('unmanaged')
      sendJson(res, 200, {
        ok: true,
        iface: WIFI_IFACE,
        state: s.state,
        connected: s.connection ? { ssid: s.connection, ip: s.ip } : null,
        managed,
        helper_ok: statusRes.ok,
        stderr: statusRes.ok ? '' : statusRes.stderr,
      })
      return
    }
    if (p === '/wifi/scan') {
      if (await wifiGuard(req, res)) return
      const en = await callHelper(['enable'], 4000)
      if (!en.ok) { sendJson(res, 500, { ok: false, error: 'helper_enable_failed', stderr: en.stderr }); return }
      const sc = await callHelper(['scan'], 20000)
      if (!sc.ok) { sendJson(res, 500, { ok: false, error: 'scan_failed', stderr: sc.stderr }); return }
      sendJson(res, 200, { ok: true, networks: parseScan(sc.stdout) })
      return
    }
    if (p === '/wifi/saved') {
      if (await wifiGuard(req, res)) return
      const r = await callHelper(['list-saved'])
      if (!r.ok) { sendJson(res, 500, { ok: false, error: 'list_failed', stderr: r.stderr }); return }
      sendJson(res, 200, { ok: true, profiles: parseSaved(r.stdout) })
      return
    }
    if (p === '/wifi/connect') {
      if (await wifiGuard(req, res, { method: 'POST' })) return
      let body; try { body = await readJsonBody(req) } catch (e) { sendJson(res, 400, { ok: false, error: 'invalid_json', detail: String(e.message) }); return }
      const verr = validateConnectBody(body)
      if (verr) { sendJson(res, 400, { ok: false, error: verr }); return }
      const en = await callHelper(['enable'], 4000)
      if (!en.ok) { sendJson(res, 500, { ok: false, error: 'helper_enable_failed', stderr: en.stderr }); return }
      const args = ['connect', body.ssid]
      if (body.password) args.push(body.password)
      const r = await callHelper(args, 45000)
      log(r.ok ? 'info' : 'warn', 'wifi_connect', { ok: r.ok, ssid: body.ssid, stderr: r.stderr })
      sendJson(res, r.ok ? 200 : 500, { ok: r.ok, stderr: r.stderr, stdout: r.stdout })
      return
    }
    if (p === '/wifi/disconnect') {
      if (await wifiGuard(req, res, { method: 'POST' })) return
      const r = await callHelper(['disconnect'], 10000)
      log(r.ok ? 'info' : 'warn', 'wifi_disconnect', { ok: r.ok, stderr: r.stderr })
      sendJson(res, r.ok ? 200 : 500, { ok: r.ok, stderr: r.stderr })
      return
    }
    if (p === '/wifi/forget') {
      if (await wifiGuard(req, res, { method: 'POST' })) return
      let body; try { body = await readJsonBody(req) } catch (e) { sendJson(res, 400, { ok: false, error: 'invalid_json', detail: String(e.message) }); return }
      const name = body && typeof body.name === 'string' ? body.name : null
      if (!name) { sendJson(res, 400, { ok: false, error: 'name_required' }); return }
      if (WIFI_PROTECTED_NAME_RE.test(name)) { sendJson(res, 403, { ok: false, error: 'protected_profile', name }); return }
      const r = await callHelper(['forget', name], 10000)
      log(r.ok ? 'info' : 'warn', 'wifi_forget', { ok: r.ok, name, stderr: r.stderr })
      sendJson(res, r.ok ? 200 : 500, { ok: r.ok, stderr: r.stderr })
      return
    }
    // Manual cert-renewal trigger. POST-only. --no-block so systemd returns
    // as soon as the unit is queued; the oneshot then tears down hostapd,
    // so we MUST answer this HTTP request before the AP dies — otherwise
    // the Tesla never sees the response. Sudoers grants NOPASSWD for this
    // exact invocation only (see tesla-doc.md install steps).
    if (p === '/cert/renew') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return }
      const r = await execResult('sudo', ['-n', 'systemctl', 'start', '--no-block', 'cert-renew-now.service'], 4000)
      _certReadAt = 0 // force a fresh cert read on the next /healthz
      log(r.ok ? 'info' : 'warn', 'cert_renew_triggered', { ok: r.ok, stderr: r.stderr })
      sendJson(res, r.ok ? 202 : 500, { ok: r.ok, stderr: r.stderr })
      return
    }
    if (p === '/') p = '/index.html'
    const file = path.normalize(path.join(STATIC_DIR, p))
    if (!file.startsWith(STATIC_DIR)) {
      res.writeHead(403).end()
      return
    }
    const data = await fs.readFile(file)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // Tesla's browser heuristically caches index.html/worker.js, serving stale
      // UI after a deploy. no-store forces a fresh fetch every reload.
      'Cache-Control': 'no-store',
    })
    res.end(data)
  } catch {
    res.writeHead(404).end('Not found')
  }
})
httpServer.listen(PORT, '0.0.0.0', () => {
  log('info', 'http_listen', { port: PORT })
  sdNotify('--ready')
})

// systemd integration: signal readiness once the HTTP listener is up,
// and ping the watchdog every 10 s (unit ships WatchdogSec=30, so we
// have 3x headroom). Only active when launched under systemd
// (NOTIFY_SOCKET set); a no-op for `node index.js` from the shell.
function sdNotify(arg) {
  if (!process.env.NOTIFY_SOCKET) return
  spawn('systemd-notify', [arg], { stdio: 'ignore' }).unref()
}
setInterval(() => sdNotify('WATCHDOG=1'), 10000).unref()

const socketVideo = new WebSocketServer({ noServer: true, perMessageDeflate: false })
const socketControl = new WebSocketServer({ noServer: true, perMessageDeflate: false })

httpServer.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname
  const target =
    p === '/control' || p === '/ws/control' ? socketControl :
    p === '/video'   || p === '/ws/video'   ? socketVideo   :
    p === '/android/h264'    ? android.socketH264    :
    p === '/android/input'   ? android.socketInput   :
    p === '/retroarch/h264'  ? retroarch.socketH264  :
    p === '/retroarch/audio' ? retroarch.socketAudio :
    p === '/retroarch/input' ? retroarch.socketInput :
    null
  if (!target) {
    socket.destroy()
    return
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws))
})

// Drop frames for a client whose send buffer is backed up (suspended Tesla
// browser whose TCP hasn't RST yet). Without this cap, encoded video/audio
// accumulates in the ws send buffer at 6-8 Mbit/s until the 30 s keepalive
// reaps the socket — a memory-exhaustion risk. Dropping is safe: CarPlay
// emits every chunk as a keyframe, so a lagging client recovers on the next.
const WS_MAX_BUFFERED = 4 * 1024 * 1024 // 4 MB high-water mark
const broadcast = (server, payload, opts) => {
  for (const c of server.clients) {
    if (c.readyState !== 1) continue
    if (c.bufferedAmount > WS_MAX_BUFFERED) continue
    c.send(payload, opts)
  }
}

// WS keepalive: ping every 30 s, drop clients that miss a pong. Without
// this, a half-open TCP (Tesla browser suspended, RST never delivered)
// keeps clients in `server.clients` and broadcast() pushes video into
// the void.
const WS_PING_MS = 30000
function attachKeepalive(server) {
  server.on('connection', (ws) => {
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
  })
  setInterval(() => {
    for (const ws of server.clients) {
      if (ws.isAlive === false) { try { ws.terminate() } catch {} ; continue }
      ws.isAlive = false
      try { ws.ping() } catch {}
    }
  }, WS_PING_MS).unref()
}
attachKeepalive(socketVideo)
attachKeepalive(socketControl)

// Optional Waydroid addon — inert unless /usr/local/sbin/mytesla-android
// exists (see scripts/install-android-addon.sh and docs/android-addon.md).
const android = createAndroidBridge({ log, execResult, sendJson, attachKeepalive, broadcast })

// Optional native RetroArch addon — inert unless /usr/local/sbin/mytesla-retroarch
// exists (see scripts/install-retroarch-addon.sh and docs/retroarch-addon.md).
const retroarch = createRetroarchBridge({ log, execResult, sendJson, attachKeepalive, broadcast })

socketControl.on('connection', (ws) => {
  log('info', 'control_connected', { clients: socketControl.clients.size })
  pokeAutoconnect('ws_wake', ['wifiConnect', 'wifiPair'])
  ws.send(JSON.stringify({ type: 'frameRate', value: config.fps }))
  ws.send(JSON.stringify({ type: 'hand', value: config.hand }))
  ws.send(JSON.stringify({ type: 'aspect', value: config.aspect }))
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'click') {
      const { type, x, y } = msg.data
      if (process.env.LOG_TOUCH) log('debug', 'touch', { t: type, x: +x.toFixed(3), y: +y.toFixed(3) })
      try {
        carplay.sendTouch({ type, x, y })
      } catch (err) {
        log('error', 'send_touch_failed', { msg: err.message })
      }
    } else if (msg.type === 'multitouch') {
      // node-carplay 4.1.0 doesn't ship SendMultiTouch (added upstream after
      // our pin), so we inline the wire format: msg type 0x17, per-touch
      // 16-byte body (x_floatLE, y_floatLE, action_u32LE, id_u32LE). id is
      // bound to array index — the frontend must ship slots in slot-order
      // (slot 0 first), else iOS's gesture tracker desyncs silently.
      const arr = msg.data
      if (!Array.isArray(arr) || arr.length === 0 || arr.length > 2) return
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].slot !== i) {
          log('warn', 'multitouch_slot_misorder', { got: arr.map(t => t.slot) })
          return
        }
      }
      if (process.env.LOG_TOUCH) log('debug', 'multitouch', { n: arr.length, t: arr.map(t => t.action) })
      try {
        const wire = Buffer.allocUnsafe(16 + arr.length * 16)
        MessageHeader.asBuffer(0x17, arr.length * 16).copy(wire, 0)
        for (let i = 0; i < arr.length; i++) {
          const off = 16 + i * 16
          wire.writeFloatLE(arr[i].x, off)
          wire.writeFloatLE(arr[i].y, off + 4)
          wire.writeUInt32LE(arr[i].action, off + 8)
          wire.writeUInt32LE(i, off + 12)
        }
        carplay.dongleDriver.send({ serialise: () => wire })
      } catch (err) {
        log('error', 'send_multitouch_failed', { msg: err.message })
      }
    } else if (msg.type === 'statusReq') {
      ws.send(JSON.stringify({ type: 'statusReq', data: plugged ? 'plugged' : 'unplugged' }))
    } else if (msg.type === 'nightMode') {
      applyNightMode(msg.value, 'client')
    } else if (msg.type === 'frameRate') {
      applyFrameRate(msg.value)
    } else if (msg.type === 'hand') {
      applyHand(msg.value)
    } else if (msg.type === 'aspect') {
      applyAspect(msg.value)
    } else if (msg.type === 'mediaKey') {
      if (ALLOWED_MEDIA_KEYS.has(msg.key)) {
        log('info', 'media_key', { key: msg.key })
        if (carplayStarted && plugged) {
          try {
            // playOrPause (203) is absent from node-carplay's CommandMapping,
            // so it goes via the raw-command path; the rest are mapped keys.
            if (msg.key === 'playOrPause') sendCommand(CARPLAY_CMD_PLAY_OR_PAUSE)
            else carplay.sendKey(msg.key)
          } catch (err) { log('error', 'send_media_key_failed', { key: msg.key, msg: err.message }) }
        }
      }
    }
  })
})

socketVideo.on('connection', () => {
  log('info', 'video_connected', { clients: socketVideo.clients.size })
  if (plugged) {
    try { carplay.sendKey('frame') }
    catch (err) { log('warn', 'request_keyframe_failed', { msg: err.message }) }
  }
})

let videoFrameCount = 0
let videoByteCount = 0
let audioFrameCount = 0
let audioByteCount = 0
if (process.env.LOG_FPS) {
  setInterval(() => {
    log('info', 'video_rate', { fps: videoFrameCount, kbps: Math.round(videoByteCount * 8 / 1000) })
    log('info', 'audio_rate', { fps: audioFrameCount, kbps: Math.round(audioByteCount * 8 / 1000) })
    videoFrameCount = 0
    videoByteCount = 0
    audioFrameCount = 0
    audioByteCount = 0
  }, 1000).unref()
}

carplay.onmessage = (ev) => {
  switch (ev.type) {
    case 'video':
      videoFrameCount++
      videoByteCount += ev.message.data.byteLength
      broadcast(socketVideo, ev.message.data, { binary: true, compress: false })
      break
    case 'audio':
      if (audioFrameCount === 0) {
        log('info', 'audio_first_frame', {
          keys: Object.keys(ev.message),
          dataLen: ev.message.data.byteLength,
          meta: Object.fromEntries(Object.entries(ev.message).filter(([k]) => k !== 'data')),
        })
      }
      audioFrameCount++
      audioByteCount += ev.message.data.byteLength
      break
    case 'plugged':
      plugged = true
      broadcast(socketControl, JSON.stringify({ type: 'statusReq', data: 'plugged' }), { compress: false })
      log('info', 'phone_plugged')
      // Re-apply current night mode — dongle resets to config.nightMode on each
      // session, so we replay the latest client-driven value after handshake.
      if (nightMode) applyNightMode(true, 'plugged')
      break
    case 'unplugged':
      plugged = false
      broadcast(socketControl, JSON.stringify({ type: 'statusReq', data: 'unplugged' }), { compress: false })
      log('info', 'phone_unplugged')
      break
    case 'failure':
      log('error', 'carplay_failure')
      restartCarplay('failure_event')
      break
    case 'command': {
      const value = ev.message.value
      if (value === CARPLAY_CMD_DASHBOARD) {
        log('info', 'carplay_dashboard_request')
        broadcast(socketControl, JSON.stringify({ type: 'goRoute', route: 'launcher' }), { compress: false })
      } else {
        log('debug', 'carplay_command', { value })
      }
      break
    }
    default: {
      const m = ev.message
      log('debug', 'carplay_event_unknown', {
        type: ev.type,
        keys: m && typeof m === 'object' ? Object.keys(m) : null,
      })
    }
  }
}

usb.on('detach', async (device) => {
  if (device.deviceDescriptor.idVendor !== CARLINKIT_VID) return
  log('warn', 'usb_detach', { vid: CARLINKIT_VID })
  await sleep(DETACH_SETTLE_MS)
  restartCarplay('usb_detach')
})

// config now carries node-carplay's merged defaults (incl. a large phoneConfig);
// log only the fields we tune.
log('info', 'boot', { width: config.width, height: config.height, aspect: config.aspect, fps: config.fps, dpi: config.dpi, hand: config.hand })
restartCarplay('boot')

const AUTOCONNECT_POKE_MS = 15000
setInterval(() => pokeAutoconnect('tick'), AUTOCONNECT_POKE_MS).unref()

const shutdown = async () => {
  log('info', 'shutdown')
  try { await carplay.stop() } catch {}
  try { await android.stop('shutdown') } catch {}
  try { await retroarch.stop('shutdown') } catch {}
  httpServer.close(() => process.exit(0))
}
// node-carplay's detached readLoop (and libusb) emit stray errors during a
// dongle restart — "close error: Can't close device with a pending request",
// LIBUSB_TRANSFER_NO_DEVICE — as unhandled rejections/exceptions. The try/catch
// around carplay.stop() can't catch them (the loop is fire-and-forget), so they
// were killing the process on every restart (→ 502s + ~20s reconnect). restart-
// Carplay already self-heals, so log and keep the kiosk up instead of crashing.
process.on('unhandledRejection', (reason) => {
  log('warn', 'unhandled_rejection', { msg: reason && reason.message ? reason.message : String(reason) })
})
process.on('uncaughtException', (err) => {
  log('error', 'uncaught_exception', { msg: err && err.message ? err.message : String(err) })
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
