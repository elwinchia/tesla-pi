// karaoke-bridge.js — on-demand lifecycle for the Nightingale karaoke server.
//
// Deliberately much thinner than retroarch-bridge.js, because karaoke needs
// none of the streaming machinery. RetroArch is a native GL app, so we run a
// compositor, screen-capture it, hardware-encode H.264 and ship frames over a
// WebSocket. Nightingale's self-hosted mode is already a WEB app: the Tesla's
// own browser renders it, plays the backing track through the car speakers and
// captures the cabin mic for pitch scoring. Pushing that through our video
// pipeline would mean re-encoding a web page and would break the mic entirely.
//
// So the Pi just serves files, and this module only decides WHEN the server
// runs. Everything else is nginx (conf/nginx-karaoke.conf) terminating TLS on
// :8443 with the CarPlay-domain cert — the app has to be a secure context or
// the browser will not hand it a microphone, and without a mic there is no
// scoring.
//
// The app is NOT reachable through this Node server. It is a separate origin
// (same host, port 8443) because the Nightingale SPA is served from the origin
// root with absolute asset paths and cannot be mounted under a subpath. The
// launcher therefore navigates the browser there rather than proxying it.

import fsSync from 'fs'
import net from 'net'

const KARAOKE_HELPER = process.env.KARAOKE_HELPER || '/usr/local/sbin/tesla-pi-karaoke'
// Loopback port the server binds (systemd/nightingale.service pins the same
// value). 8088 because this Node server already owns 8080.
const BACKEND_PORT = Number(process.env.KARAOKE_BACKEND_PORT || 8088)
// Public TLS port nginx listens on. Reported to the client so the launcher can
// build the URL without hardcoding it in two places.
const PUBLIC_PORT = Number(process.env.KARAOKE_PUBLIC_PORT || 8443)

const HELPER_TIMEOUT_MS = 30000
// Cold start is a binary exec plus a library scan; the scan is what takes the
// time and grows with the song count.
const READY_TIMEOUT_MS = Number(process.env.KARAOKE_READY_TIMEOUT_MS || 45000)
// The server is idle-cheap (~9 MB RSS with an empty library, more once songs
// are scanned) but not free, and unlike
// RetroArch we get no route-exit signal — the browser is on another origin, so
// leaving the app never tells us. Established connections to the backend are
// the honest liveness signal instead: the SPA holds a /ws socket open the whole
// time it is on screen, so "no connections for a while" really does mean the
// singing stopped. Generous by default: reaping mid-song would be far worse
// than holding the memory a few extra minutes.
const IDLE_STOP_MS = Number(process.env.KARAOKE_IDLE_STOP_MS || 10 * 60 * 1000)
const IDLE_POLL_MS = 30000

export function createKaraokeBridge({ log, execResult, sendJson }) {
  let state = 'stopped' // stopped | starting | running | stopping
  let lastError = null
  let idleTimer = null
  let idleSince = null

  const installed = () => fsSync.existsSync(KARAOKE_HELPER)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ---- backend readiness ---------------------------------------------------
  // A plain TCP connect, not an HTTP probe: axum binds the listener before it
  // finishes wiring routes, and any answer at all means the socket is live.
  function portOpen(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port })
      const done = (ok) => { try { sock.destroy() } catch {} ; resolve(ok) }
      sock.setTimeout(1500)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    })
  }

  async function waitForBackend(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await portOpen(BACKEND_PORT)) return true
      await sleep(400)
    }
    return false
  }

  // ---- idle reaping --------------------------------------------------------
  // `ss` filter tokens are passed as separate argv entries so there is no shell
  // to quote them for. A failure here is non-fatal: we simply skip this tick
  // rather than risk tearing down a live session on a bad reading.
  async function backendConnections() {
    const r = await execResult('ss', ['-Htn', 'state', 'established', 'sport', '=', `:${BACKEND_PORT}`], 5000)
    if (!r || !r.ok) return null
    return String(r.stdout || '').split('\n').filter((l) => l.trim()).length
  }

  async function idleTick() {
    if (state !== 'running') return
    const n = await backendConnections()
    if (n === null) return
    if (n > 0) { idleSince = null; return }
    if (idleSince === null) { idleSince = Date.now(); return }
    if (Date.now() - idleSince >= IDLE_STOP_MS) {
      log('info', 'karaoke_idle_stop', { idle_ms: Date.now() - idleSince })
      await stop('idle')
    }
  }

  function startIdleWatch() {
    stopIdleWatch()
    idleSince = null
    idleTimer = setInterval(() => { idleTick().catch(() => {}) }, IDLE_POLL_MS)
    if (idleTimer.unref) idleTimer.unref()
  }
  function stopIdleWatch() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null }
    idleSince = null
  }

  // ---- lifecycle -----------------------------------------------------------
  async function doStart() {
    if (state === 'running' || state === 'starting') return
    state = 'starting'
    lastError = null
    try {
      const helper = await execResult('sudo', ['-n', KARAOKE_HELPER, 'start'], HELPER_TIMEOUT_MS)
      if (!helper || !helper.ok) {
        throw new Error(`helper start failed: ${helper?.stderr || 'sudo/helper unavailable'}`)
      }
      if (!(await waitForBackend(READY_TIMEOUT_MS))) {
        throw new Error(`backend did not listen on :${BACKEND_PORT} within ${READY_TIMEOUT_MS}ms`)
      }
      state = 'running'
      startIdleWatch()
      log('info', 'karaoke_started', { port: BACKEND_PORT })
    } catch (e) {
      lastError = e.message
      state = 'stopped'
      log('warn', 'karaoke_start_failed', { msg: e.message })
      // Leave nothing half-up: a unit that started but never listened would
      // otherwise sit there holding memory with no way for the UI to reach it.
      try { await execResult('sudo', ['-n', KARAOKE_HELPER, 'stop'], HELPER_TIMEOUT_MS) } catch {}
    }
  }

  async function stop(reason) {
    if (state === 'stopped' || state === 'stopping') return
    state = 'stopping'
    stopIdleWatch()
    try {
      await execResult('sudo', ['-n', KARAOKE_HELPER, 'stop'], HELPER_TIMEOUT_MS)
      log('info', 'karaoke_stopped', { reason })
    } catch (e) {
      log('warn', 'karaoke_stop_failed', { msg: e.message })
    }
    state = 'stopped'
  }

  // ---- state reconciliation ------------------------------------------------
  // Our `state` lives in memory, but the thing it describes is a systemd unit
  // that outlives this process. Restart the Node server — a deploy does exactly
  // that — and we would report "stopped" at a server that is still up and
  // serving: the tile reads Off, and nothing ever reaps the idle session.
  //
  // A loopback connect is enough to notice, and costs nothing next to asking
  // sudo/systemd on every poll. Only ever used to adopt a running server we
  // lost track of; it never contradicts a start or stop in flight.
  async function reconcile() {
    if (state !== 'stopped') return
    if (!installed()) return
    if (!(await portOpen(BACKEND_PORT))) return
    state = 'running'
    startIdleWatch()
    log('info', 'karaoke_adopted', { port: BACKEND_PORT })
  }

  // ---- HTTP ----------------------------------------------------------------
  async function handleHttp(p, req, res) {
    if (p === '/karaoke/status') {
      await reconcile()
      sendJson(res, 200, {
        ok: true,
        installed: installed(),
        state,
        // The client builds the URL from its own location.hostname + this port,
        // so the domain lives in exactly one place (the cert) and never has to
        // be threaded through the app.
        public_port: PUBLIC_PORT,
        last_error: lastError,
      })
      return true
    }
    if (p === '/karaoke/start') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      if (!installed()) { sendJson(res, 404, { ok: false, error: 'addon_not_installed' }); return true }
      // Fire and forget: the client polls /karaoke/status and navigates once
      // the state turns "running", so a slow library scan never blocks the tap.
      if (state === 'stopped') doStart().catch(() => {})
      sendJson(res, 202, { ok: true, state })
      return true
    }
    if (p === '/karaoke/stop') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' }); return true }
      await stop('http')
      sendJson(res, 200, { ok: true, state })
      return true
    }
    return false
  }

  return { handleHttp, stop, state: () => state, installed }
}
