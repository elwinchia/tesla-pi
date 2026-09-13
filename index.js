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
import CarplayNode, {
  MessageHeader, SendBoolean, FileAddress, PhoneType,
  Plugged, BoxInfo, SoftwareVersion, ManufacturerInfo,
  BluetoothDeviceName, BluetoothPIN, WifiDeviceName,
  AudioCommand, decodeTypeMap, SendAudio, SendCommand,
  SendDisconnectPhone, SendCloseDongle,
} from 'node-carplay/node'
import { usb } from 'usb'
import { createRetroarchBridge } from './retroarch-bridge.js'
import { createKaraokeBridge } from './karaoke-bridge.js'
import { installPipelinedReader } from './carplay-reader.js'
import {
  MODELS as FIRMWARE_MODELS, FIRMWARE_REPO, FIRMWARE_COMMIT,
  parseVersion, modelFor, catalogFor, createFirmwareStore, storeWritable,
} from './dongle-firmware.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.join(__dirname, 'static')
const PORT = 8080
const CARLINKIT_VID = 0x1314
const CARPLAY_CMD_DASHBOARD = 3 // iOS "exit CarPlay → host UI" signal (car-icon tap)
// Raw dongle command ids that node-carplay 4.1.0's CommandMapping omits. All
// three were added upstream after our pinned version and never released, so we
// send them through sendCommand() rather than sendKey().
const CARPLAY_CMD_PLAY_OR_PAUSE = 203 // MusicPlayOrPause
const CARPLAY_CMD_UP = 113            // 'Button Up' — the missing half of 'down'
const RAW_MEDIA_KEYS = new Map([
  ['playOrPause', CARPLAY_CMD_PLAY_OR_PAUSE],
  ['up', CARPLAY_CMD_UP],
])
const ALLOWED_MEDIA_KEYS = new Set(['next', 'prev', 'playOrPause', 'siri', 'home'])

// USB read pipeline (carplay-reader.js). On by default; CARPLAY_USB_PIPELINE=off
// hands the read loop back to node-carplay if this ever misbehaves in the car.
const USB_PIPELINE = (process.env.CARPLAY_USB_PIPELINE || 'on').toLowerCase() !== 'off'
const USB_INFLIGHT = Number(process.env.CARPLAY_USB_INFLIGHT ?? 16)
const USB_CHUNK = Number(process.env.CARPLAY_USB_CHUNK ?? 16384)

// Hardware decoders hold onto frames: after a touch the phone may have drawn
// the response already while the last frame is still sitting in a buffer, and
// the screen looks stuck until something else moves. Asking the dongle for a
// frame right after an interaction flushes it. FastCarPlay calls the same trick
// force-redraw and recommends it specifically for Pi hardware decoding.
// 0 disables it.
const FORCE_REDRAW_MS = Number(process.env.CARPLAY_FORCE_REDRAW_MS ?? 140)
// Never more than one request per this window, however fast the taps come.
const FORCE_REDRAW_MIN_GAP_MS = 100
const MAX_START_ATTEMPTS = 20
// Base for an exponential backoff, not a fixed gap. A flat 1s was actively
// harmful: node-carplay's start() resets the dongle, and resetting it again a
// second later is exactly the "repeated rapid resets" that wedge its firmware
// — the wedge the START_TIMEOUT_MS below then exists to survive. Backing off
// lets the dongle finish re-enumerating instead of racing it.
const START_RETRY_MS = 500
const START_BACKOFF_MAX_MS = 8000
const DETACH_SETTLE_MS = 2000
// After start() claims success, how long to wait for the read pipeline to
// deliver an actual message before calling the session up. See readerHealthy().
const START_HEALTH_GRACE_MS = 6000
// How often to re-check a session that is down with the dongle present. Nothing
// used to: pokeAutoconnect's 15s tick returns early unless carplayStarted, so a
// failed start had no periodic recovery at all and waited on process.exit(1).
const WATCHDOG_MS = 30000
// Ceiling on one carplay.start() attempt. A healthy start takes ~3.5s (0.2s find
// + 3.0s post-reset settle + 0.4s init). node-carplay's USB writes have no
// timeout of their own, so a dongle wedged in a bad firmware state leaves
// transferOut pending forever: start() then neither resolves nor throws, the
// retry loop below never runs, and restartInFlight stays true — which makes
// every recovery path (usb_detach, failure) a no-op. Observed in the field
// after repeated rapid resets. Bound it so a wedge costs one attempt.
// NB the timeout does not CANCEL the attempt (nothing can cancel a pending
// libusb transfer, and findDevice() loops on its own): that is why runRestart
// checks donglePresent() first and why carplay.start is gated by startAllowed.
// Without both, each timed-out attempt leaked a background poller.
const START_TIMEOUT_MS = 20000

// ---- CarPlay on demand ----------------------------------------------------
// The dongle is what courts the phone. Once it has been opened over USB it
// advertises BLE, a paired iPhone answers, and the phone is then talked onto
// the dongle's own 5 GHz AP — which drops it off home Wi-Fi and keeps its
// radios awake. Doing that around the clock merely because the Pi has power is
// wrong: walking past the car should not cost the phone its network or its
// battery. The session is therefore demand-gated on someone actually looking
// at the page.
//
// Demand = at least one /control client whose tab is open AND visible. Not the
// CarPlay route specifically: Settings, Monitor and the launcher are all "I am
// in the car using this thing", and gating on the route alone would tear the
// dongle down every time the user opened Settings.
//
// Settings > CarPlay carries the switch. CARPLAY_ON_DEMAND=off only moves the
// shipped default, so a device that has never been configured can still be
// built always-on.
const ON_DEMAND_DEFAULT = (process.env.CARPLAY_ON_DEMAND || 'on').toLowerCase() !== 'off'
// Grace between the last visible client going away and the dongle closing.
// Deliberately unhurried — switching to the Tesla media app and back, or a
// page reload, must not cost a full BLE + Bluetooth + Wi-Fi + RTSP re-pair.
// Grace between the last visible page and handing the phone back.
//
// Was 60 s, raised to 5 min on 2026-08-29 after measuring 18 real hide/return
// episodes on this device: only 2 came back inside 60 s. The rest ran 79 s to
// 14 min, because "I'll just change the wipers" means navigating the car's own
// menus, and the reconnect that follows a release costs a median of 14 s (max
// 70 s) — far more than the dongle costs us by staying open.
//
// The feature still does its job at 5 min: it exists for the car parked on the
// drive with nobody in it, where the absence is hours, not minutes. What this
// costs is that walking away holds the phone off home Wi-Fi for up to 5 min
// instead of 1. Lower it if that matters more than the reconnects.
const IDLE_STOP_MS = Number(process.env.CARPLAY_IDLE_STOP_MS ?? 300000)
// A visible page re-asserts demand every DEMAND_PING (client side); the server
// expires it after this. The TTL is the safety net for the case where the Tesla
// browser never fires `visibilitychange` on being backgrounded: Chromium still
// throttles a hidden tab's timers to roughly one tick a minute, so the
// heartbeat lapses past this TTL on its own.
const DEMAND_TTL_MS = Number(process.env.CARPLAY_DEMAND_TTL_MS ?? 40000)
// How often to notice a lapsed TTL. Nothing else fires when a heartbeat simply
// stops arriving.
const DEMAND_SWEEP_MS = 5000
// A control socket that dies while its lease is still live is not the same
// event as a page that said it was leaving. The Tesla browser freezes a
// backgrounded tab and closes its sockets without warning, and a page that
// crashes or hits a Wi-Fi blip does the same — none of which mean the driver
// walked away. Treating a silent socket death as "nobody is looking" starts
// handing the phone back to someone who is about to swipe straight back. So
// the vote outlives the socket by this much, giving the reconnect time to land.
// Only applies when the lease was live: a page that already said "hidden" has
// no lease left, and that departure was deliberate.
const GHOST_LEASE_MS = Number(process.env.CARPLAY_GHOST_LEASE_MS ?? 15000)
// Off by default — see releaseDongle for what this dongle actually does with it.
const CLOSE_DONGLE = (process.env.CARPLAY_CLOSE_DONGLE || '').toLowerCase() === 'on'

const CERT_PATH = process.env.CERT_PATH

// Settings → WiFi tab. Available whenever wlan1 exists.
const WIFI_IFACE = process.env.WIFI_IFACE || 'wlan1'
const WIFI_HELPER = process.env.WIFI_HELPER || '/usr/local/sbin/tesla-pi-wifi'
// Forgetting a wlan0 NM profile bricks CarPlay AP / home-Wi-Fi modes.
const WIFI_PROTECTED_NAME_RE = /^(netplan-wlan0-|hostapd|wlan0-)/i

// Settings → Hotspot. Manages the Tesla-facing AP (wlan0/hostapd) credentials.
// The helper never returns the passphrase — it reports only the SSID and
// whether the creds are still the shipped defaults, which drives onboarding.
const AP_HELPER = process.env.AP_HELPER || '/usr/local/sbin/tesla-pi-ap'
// hostapd's own limits. Mirrored in the helper so a direct sudo call is bounded
// too, and in the SPA so the user gets feedback before a round trip.
const AP_SSID_MAX = 32
const AP_PSK_MIN = 8
const AP_PSK_MAX = 63

// Settings → System. Restart / shut down the Pi itself. Same contract as the
// hotspot helper: absent binary means "feature not installed", the routes 404,
// and the SPA hides the section rather than offering a button that fails.
const POWER_HELPER = process.env.POWER_HELPER || '/usr/local/sbin/tesla-pi-power'

// Settings → Dongle. The helper is only needed for the last step — writing a
// downloaded image onto a FAT32 stick — so unlike the two above, its absence
// does NOT hide the section: identifying the dongle and fetching firmware work
// without any privilege at all.
const DONGLE_HELPER = process.env.DONGLE_HELPER || '/usr/local/sbin/tesla-pi-dongle'
// Where downloaded images live. Changing this breaks the stick writer: the
// helper hardcodes the same path as the only directory its sudo grant will read
// from, and will refuse a file it cannot see there.
const FIRMWARE_DIR = process.env.FIRMWARE_DIR || '/var/lib/tesla-pi/firmware'

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

// Is there a route to the internet that isn't our own hostapd interface?
// wlan0 carries the Tesla-facing AP, so a default route on it would point at
// the AP subnet, not the internet — every other interface (eth0, a second
// Wi-Fi adapter, a USB tether) counts. Read from /proc rather than shelling
// out to `ip`: no subprocess, no privileges. Returns the interface name, or ''
// when the only way out is the AP itself.
// Cached like certDaysRemaining above, and for the same reason: /healthz
// reports this and is polled every ~2 s. Cables don't move that fast.
let _uplink = ''
let _uplinkReadAt = 0
const UPLINK_CACHE_MS = 5000
function uplinkIface({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && _uplinkReadAt !== 0 && now - _uplinkReadAt < UPLINK_CACHE_MS) return _uplink
  _uplinkReadAt = now
  _uplink = ''
  try {
    for (const line of fsSync.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.split(/\s+/)
      // Iface Destination Gateway … — destination 00000000 is the default route.
      if (f.length > 2 && f[1] === '00000000' && f[0] && f[0] !== 'wlan0') { _uplink = f[0]; break }
    }
  } catch {}
  return _uplink
}

// Does the cert service actually answer? `uplinkIface` only proves a default
// route exists. Any HTTP status counts as reachable — /cert/version 401s
// without the bearer token, and a 401 from the far end is still proof that the
// far end is there. CERT_SYNC_URL comes from /etc/default/tesla-pi, which
// tesla-pi.service loads as an EnvironmentFile; a box without it (dev
// checkouts) is not probed at all rather than being blocked on a guess.
const CERT_SYNC_URL = process.env.CERT_SYNC_URL || ''
async function certServiceReachable() {
  if (!CERT_SYNC_URL) return true
  const r = await execResult(
    'curl', ['-sS', '-o', '/dev/null', '-m', '5', CERT_SYNC_URL + '/cert/version'], 7000)
  return r.ok
}

// ---- Device telemetry -----------------------------------------------------
// Everything here is a read of /proc or /sys, or one statfs. No subprocess, no
// privilege, nothing that needs the car's Bluetooth — which is the point: the
// BLE path is rationed by the car's three-connection limit, so anything that
// can be known without it should be.

// Current and maximum core clock. The Pi idles at 600 MHz and only ramps under
// load, so "600" next to a low load figure is healthy, not throttled.
function cpuFreq() {
  const rd = (f) => { try { return parseInt(fsSync.readFileSync(f, 'utf8'), 10) } catch { return null } }
  const base = '/sys/devices/system/cpu/cpu0/cpufreq/'
  const cur = rd(base + 'scaling_cur_freq')
  const max = rd(base + 'cpuinfo_max_freq')
  return { cur_mhz: cur == null ? null : Math.round(cur / 1000), max_mhz: max == null ? null : Math.round(max / 1000) }
}

// Free space on the card. Cached: /healthz is polled every ~2 s and a full SD
// card is not a fast-moving quantity.
let _disk = null
let _diskAt = 0
function diskInfo() {
  const now = Date.now()
  if (_disk && now - _diskAt < 15000) return _disk
  _diskAt = now
  try {
    const st = fsSync.statfsSync('/')
    _disk = { free_bytes: Number(st.bavail) * Number(st.bsize), total_bytes: Number(st.blocks) * Number(st.bsize) }
  } catch { _disk = null }
  return _disk
}

// Uplink radio quality, straight out of /proc/net/wireless — no `iw`, no root.
// `level` is dBm: about -50 is excellent, -70 is workable, -80 is not.
//
// This driver (RTL8188EUS) intermittently reports the "not available" sentinel
// -256 instead of a reading — measured 2026-08-29, on roughly half of samples
// taken a second apart, interleaved with perfectly good ones. Rendered naively
// that came out as "Very weak (-256 dBm)" on a link that was actually fine.
// So implausible samples are discarded and the last real one is served instead,
// with its age, rather than flickering between a number and nothing.
const WIFI_PLAUSIBLE = (dbm) => dbm != null && dbm <= -20 && dbm >= -110
let _wifiLast = null
function wifiLink(iface = WIFI_IFACE) {
  try {
    for (const line of fsSync.readFileSync('/proc/net/wireless', 'utf8').split('\n')) {
      const t = line.trim()
      if (!t.startsWith(iface + ':')) continue
      const f = t.split(/\s+/)
      const num = (v) => { const n = parseFloat(String(v).replace(/\.$/, '')); return Number.isFinite(n) ? n : null }
      const level = num(f[3])
      if (!WIFI_PLAUSIBLE(level)) break   // sentinel; fall through to the last good reading
      _wifiLast = { iface, link: num(f[2]), level_dbm: level, at: Date.now() }
      return { iface, link: _wifiLast.link, level_dbm: level, age_s: 0 }
    }
  } catch { return null }
  if (!_wifiLast) return null
  return {
    iface: _wifiLast.iface, link: _wifiLast.link, level_dbm: _wifiLast.level_dbm,
    age_s: Math.floor((Date.now() - _wifiLast.at) / 1000),
  }
}

// Who is on the hotspot. In normal use this is exactly one lease — the car —
// so "2" is worth noticing: someone else is on the AP with you, and there is
// no authentication behind it (SECURITY.md).
function apClients() {
  try {
    const rows = fsSync.readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean)
    // expiry mac ip hostname clientid. The MAC is deliberately not reported:
    // the page needs "how many, and on what address", not a device fingerprint.
    return { count: rows.length, ips: rows.map((r) => r.split(/\s+/)[2]).filter(Boolean).slice(0, 8) }
  } catch { return null }
}

// Throughput per interface. Byte counters are cumulative, so the useful number
// is the delta over a known interval — sampled on a timer rather than computed
// per request, so two /healthz polls a second apart cannot divide by ~0.
const NET_IFACES = ['wlan0', 'wlan1', 'eth0']
const NET_SAMPLE_MS = 2000
const netRates = new Map()
let _netPrev = null
function sampleNet() {
  const now = Date.now()
  const cur = new Map()
  try {
    for (const line of fsSync.readFileSync('/proc/net/dev', 'utf8').split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/)
      if (!m) continue
      const name = m[1].trim()
      if (!NET_IFACES.includes(name)) continue
      const f = m[2].trim().split(/\s+/)
      cur.set(name, { rx: Number(f[0]), tx: Number(f[8]) })
    }
  } catch { return }
  if (_netPrev) {
    const dt = (now - _netPrev.at) / 1000
    if (dt > 0.2) {
      for (const [name, v] of cur) {
        const p = _netPrev.v.get(name)
        if (!p) continue
        netRates.set(name, {
          rx_kbps: Math.max(0, Math.round(((v.rx - p.rx) * 8) / dt / 1000)),
          tx_kbps: Math.max(0, Math.round(((v.tx - p.tx) * 8) / dt / 1000)),
          rx_bytes: v.rx, tx_bytes: v.tx,
        })
      }
    }
  }
  _netPrev = { at: now, v: cur }
}
sampleNet()
setInterval(sampleNet, NET_SAMPLE_MS).unref()

const LOG_RING_CAP = 200
const logRing = []
// systemd captures a service's stdout at ONE fixed priority (SyslogLevel=info),
// so every line we wrote landed in the journal as PRIORITY=6 no matter what our
// own `level` field said — verified on the device 2026-09-02. Two consequences,
// both bad on this box:
//
//   * `journalctl -p err -u tesla-pi.service` could never return anything. The
//     priority filter was dead weight on the one tool you reach for first.
//   * journald syncs to disk immediately on an error-priority message, but our
//     errors never looked like errors. With SyncIntervalSec=5m (set by
//     scripts/enable-persistent-journal.sh to spare the SD card) and a device
//     that loses power with the car every night, the last minutes of a failure
//     could be gone before they reached the card — exactly the window you most
//     want after an unclean shutdown.
//
// systemd reads a `<N>` prefix on each stdout line as the syslog priority
// (SyslogLevelPrefix defaults to yes, confirmed on the unit) and strips it
// before storing, so the stored JSON is unchanged. Only prefix when stdout
// really is the journal: systemd sets JOURNAL_STREAM exactly then, so a plain
// `node index.js` in a terminal stays readable.
const SYSLOG_PRI = { error: 3, warn: 4, info: 6, debug: 7 }
const LOG_PRI_PREFIX = !!process.env.JOURNAL_STREAM
const log = (level, evt, fields = {}) => {
  const entry = { ts: new Date().toISOString(), level, evt, ...fields }
  const line = JSON.stringify(entry)
  console.log(LOG_PRI_PREFIX ? `<${SYSLOG_PRI[level] ?? 6}>${line}` : line)
  logRing.push(entry)
  if (logRing.length > LOG_RING_CAP) logRing.splice(0, logRing.length - LOG_RING_CAP)
}

const SETTINGS_FILE = process.env.TESLAPI_SETTINGS_FILE || path.join(__dirname, 'settings.local.json')
const ALLOWED_FPS = new Set([30, 60])
const DEFAULT_FPS = 60
// HandDriveType from node-carplay: 0 = LHD, 1 = RHD. Default to RHD —
// matches the prior hardcoded value so existing Pis don't flip on upgrade.
const ALLOWED_HAND = new Set([0, 1])
const DEFAULT_HAND = 1
// Display aspect: dongle width is always 1920; the mode picks the height it
// negotiates. 'full' ≈ fills the square Tesla browser (original behaviour);
// 'wide' (16:8) shrinks CarPlay to a top band so the client frees a dock below.
// Where CarPlay's audio comes out. 'bluetooth' is the phone's own A2DP link to
// the car, which is how this box has always sounded and needs nothing from us;
// 'browser' streams the dongle's PCM to the page and plays it there. Tri-state
// like androidAuto: absent means never configured, and an untouched box keeps
// the dongle init it had before this setting existed.
const ALLOWED_AUDIO_SOURCE = new Set(['browser', 'bluetooth'])
// Whether this box may talk to the car over BLE at all. Default OFF: the car
// allows only three simultaneous BLE connections and phone keys hold them, so a
// box that reached for one without being asked could be the reason someone's
// phone key fails to unlock the car. Opt in from Settings > Network.
// Off is a hard stop, not a pause — no radio is touched and no slot is taken.
const DEFAULT_BLE_ENABLED = false
const ALLOWED_ASPECT = new Set(['full', 'wide'])
const DEFAULT_ASPECT = 'full'
// 'wide' is not reachable from the UI — the split-screen dock that used it was
// removed 2026-09-03 and every app now takes the whole screen. The aspect is
// kept because it is server-side and cheap, but note before reaching for it:
// measured on this dongle 2026-09-02, over two 30-minute windows on one day,
//
//   wide (840):  3 start_failed, 4 carplay_failure, 8 usb_read_error, 3 restarts
//   full (1496): 0 start_failed, 0 carplay_failure, 0 usb_read_error, 1 clean start
//
// The failures are LIBUSB_TRANSFER_ERROR / LIBUSB_ERROR_NO_DEVICE and
// "carplay.start timed out", i.e. the dongle falling off the bus — not anything
// downstream of it. The session comes up, dies, and comes up again in a loop.
// Whether 840 itself is unacceptable to the firmware or merely marginal was
// never settled, so the height stays settable without a code change. Untried
// candidates, all multiples of 16 (840 is not — 52.5): 848, 880, 960.
const WIDE_HEIGHT = Number(process.env.CARPLAY_WIDE_HEIGHT ?? 840)
const ASPECT_HEIGHT = { full: 1496, wide: WIDE_HEIGHT }

// Env override for the dongle's audio-transfer flag: 'on' | 'off'. Unset means
// the mode decides. Same switch style as LOG_TOUCH/AUDIO_TAP.
const AUDIO_TRANSFER_OVERRIDE = (process.env.CARPLAY_AUDIO_TRANSFER || '').toLowerCase()
function audioTransferFlagFor(source) {
  if (AUDIO_TRANSFER_OVERRIDE === 'on') return true
  if (AUDIO_TRANSFER_OVERRIDE === 'off') return false
  return source !== 'browser'
}

function loadPersistedSettings() {
  const out = { fps: DEFAULT_FPS, hand: DEFAULT_HAND, aspect: DEFAULT_ASPECT, bleEnabled: DEFAULT_BLE_ENABLED }
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
  // Tri-state on purpose, unlike the settings above. Absent means "never
  // configured", and we then send the dongle nothing at all — an untouched box
  // gets a byte-identical init sequence to before this setting existed. Only an
  // explicit boolean is honoured. See applyAndroidAuto for why false matters.
  if (typeof j.androidAuto === 'boolean') out.androidAuto = j.androidAuto
  else if (j.androidAuto !== undefined) log('warn', 'settings_load_failed', { msg: 'androidAuto not a boolean', value: j.androidAuto })
  if (ALLOWED_AUDIO_SOURCE.has(j.audioSource)) out.audioSource = j.audioSource
  else if (j.audioSource !== undefined) log('warn', 'settings_load_failed', { msg: 'audioSource invalid', value: j.audioSource })
  // Plain boolean, not tri-state: there is no dongle to leave untouched here,
  // and "never configured" and "on" mean the same thing to the radio.
  if (typeof j.bleEnabled === 'boolean') out.bleEnabled = j.bleEnabled
  else if (j.bleEnabled !== undefined) log('warn', 'settings_load_failed', { msg: 'bleEnabled not a boolean', value: j.bleEnabled })
  if (typeof j.carplayOnDemand === 'boolean') out.carplayOnDemand = j.carplayOnDemand
  else if (j.carplayOnDemand !== undefined) log('warn', 'settings_load_failed', { msg: 'carplayOnDemand not a boolean', value: j.carplayOnDemand })
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
  // Sent to the box in SendBoxSettings as an A/V sync offset in ms. 300 is
  // node-carplay's default, sized for a head unit whose video path lags; ours
  // is a browser and the audio arrives on the same socket as everything else,
  // so this is 300 ms of latency we may be asking for and not needing. Left at
  // the default until measured — CARPLAY_MEDIA_DELAY changes it without a
  // deploy, so it can be walked down in the car.
  mediaDelay: Number(process.env.CARPLAY_MEDIA_DELAY ?? 300),
  // audioTransferOn/Off on the dongle, and the sense is the opposite of what
  // the name suggests. "Transfer" is the box moving audio onto its OWN output
  // — the Bluetooth link to the car, which is what Carlinkit's AutoKit app
  // calls the Bluetooth "Audio Channel". Turning it ON is therefore what stops
  // PCM coming to us over USB.
  //
  // node-carplay defaults it to false, and that package exists to receive the
  // dongle's PCM on the host; a default that silenced its headline feature
  // would make no sense. This box shipped `true` hardcoded from the start,
  // which is why audio never arrived here: measured 2026-08-21, browser mode
  // received AudioData *commands* (Siri start/stop) with dataLen 0 and not one
  // PCM byte while music played, both at init and after replaying the command
  // post-handshake.
  //
  // So: browser wants it OFF, bluetooth wants it ON. CARPLAY_AUDIO_TRANSFER
  // overrides for testing without another deploy.
  audioTransferMode: audioTransferFlagFor(persisted.audioSource),
  // Android Auto. undefined = never configured, so node-carplay's
  // `if (config.androidWorkMode)` skips the message entirely and the dongle is
  // left exactly as it was. See docs/android-auto-plan.md.
  androidWorkMode: persisted.androidAuto,
}

// Not part of `config` because node-carplay would not know what to do with it:
// the dongle flag above says whether audio is sent to us at all, this says
// whether we forward it to the page. undefined = never configured.
// Live, because Settings > CarPlay can flip it without a restart.
let onDemand = typeof persisted.carplayOnDemand === 'boolean'
  ? persisted.carplayOnDemand
  : ON_DEMAND_DEFAULT
let audioSource = persisted.audioSource
// Not in `config`: node-carplay has no idea what this is. See applyBleEnabled.
let bleEnabled = persisted.bleEnabled

// ── Power supply ───────────────────────────────────────────────────────────
// The Pi's firmware raises a flag when the 5 V rail sags below ~4.63 V, and the
// kernel logs a line on each transition. That flag is worth surfacing because a
// sagging rail does not announce itself as "bad power" — it announces itself as
// peripherals vanishing. Measured in the car on 2026-08-21: the CarPlay dongle
// never enumerated at all while the rail was low, which looks exactly like a
// dead dongle from the app's side.
//
// hwmon exposes it as a plain file, so this is a sync read of one byte rather
// than spawning vcgencmd every poll. The hwmon index is not stable across
// boots, so find it by driver name.
const POWER_POLL_MS = Number(process.env.POWER_POLL_MS ?? 10000)
const power = {
  under: null,      // null = unknown (not a Pi, or the sensor is missing)
  ever: false,      // has it dipped at any point since the app started
  events: 0,        // how many separate dips
  sinceAt: Date.now(),
  // Whether sinceAt means anything. If the very first reading already says the
  // rail is low, we know it is low but not since when — the dip started before
  // we were watching, quite possibly several restarts ago. Claiming "low for
  // 5s" there would be a lie in the direction that matters.
  sinceKnown: false,
  source: null,
}
let powerPath = null

function findPowerSensor() {
  try {
    for (const dir of fsSync.readdirSync('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${dir}`
      let name = ''
      try { name = fsSync.readFileSync(`${base}/name`, 'utf8').trim() } catch { continue }
      if (name !== 'rpi_volt') continue
      const file = `${base}/in0_lcrit_alarm`
      if (fsSync.existsSync(file)) { power.source = name; return file }
    }
  } catch {}
  return null
}

function pollPower() {
  if (!powerPath) {
    powerPath = findPowerSensor()
    if (!powerPath) return
  }
  let raw
  try { raw = fsSync.readFileSync(powerPath, 'utf8') }
  catch { powerPath = null; power.under = null; return }
  const under = raw.trim() === '1'
  if (under === power.under) return
  const first = power.under === null
  power.under = under
  power.sinceAt = Date.now()
  power.sinceKnown = !first
  if (under) {
    power.ever = true
    power.events++
    // Ours as well as the kernel's, so it lands in the log the Status page
    // shows rather than only in the journal.
    log('warn', 'power_undervoltage', { events: power.events, first })
  } else if (!first) {
    log('info', 'power_recovered', { events: power.events })
  }
}
pollPower()
setInterval(pollPower, POWER_POLL_MS).unref()

function powerState() {
  return {
    under: power.under,
    ever: power.ever,
    events: power.events,
    since_s: (power.under === null || !power.sinceKnown)
      ? null
      : Math.floor((Date.now() - power.sinceAt) / 1000),
    source: power.source,
  }
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

// Take over the USB read loop before anything starts it. See carplay-reader.js
// for why: node-carplay reads one message at a time with nothing queued behind
// it, and the gaps are latency we pay on every video frame and audio chunk.
const usbReader = USB_PIPELINE
  ? installPipelinedReader({ driver: carplay.dongleDriver, log, inflight: USB_INFLIGHT, chunk: USB_CHUNK })
  : null
if (!usbReader) log('info', 'usb_pipeline_disabled')
// Is the dongle actually on the bus? node-carplay's findDevice() answers this
// by looping FOREVER with 3s sleeps until one appears, so calling start() with
// no dongle attached costs a full START_TIMEOUT_MS and — because withTimeout
// cannot cancel the underlying work — leaves that loop polling in the
// background. Twenty attempts stacked twenty concurrent pollers. Checking the
// bus ourselves first is what stops an unplugged dongle becoming a restart
// storm. PIDs match DongleDriver.knownDevices.
const CARLINKIT_PIDS = new Set([0x1520, 0x1521])
const isCarlinkit = (d) =>
  d?.deviceDescriptor?.idVendor === CARLINKIT_VID &&
  CARLINKIT_PIDS.has(d.deviceDescriptor.idProduct)
function donglePresent() {
  try { return usb.getDeviceList().some(isCarlinkit) }
  catch (err) { log('warn', 'usb_list_failed', { msg: err.message }); return false }
}

// node-carplay's start() swallows an initialise() failure, logs it, and quietly
// schedules its own `setTimeout(this.start, 2000)` retry. That fires inside our
// retry loop and stacks a second, uncoordinated start on top of ours. Gate the
// method so only restartCarplay can drive it: the self-retry becomes a logged
// no-op, and the loop below — which has backoff and a health check — stays the
// single owner of recovery.
const rawCarplayStart = carplay.start.bind(carplay)
let startAllowed = false
carplay.start = () => {
  if (!startAllowed) {
    log('debug', 'carplay_self_retry_ignored')
    return Promise.resolve()
  }
  return rawCarplayStart()
}

let plugged = false
let carplayStarted = false
let restartInFlight = false
// A restart asked for while one is already running. This used to be dropped on
// the floor (`restart_skipped {why:'in_flight'}` and return), which is the
// worst possible moment to ignore one: the dongle usually detaches BECAUSE
// start() just reset it, so the detach that matters is precisely the one that
// lands mid-restart. The loop then kept retrying against a handle whose device
// was gone, producing runs of identical LIBUSB_ERROR_NOT_FOUND.
let restartPending = null
let nightMode = false
// Set by shutdown(). Every restart path checks it: without this, carplay.stop()
// makes node-carplay's detached readLoop error out, which emits 'failure', which
// kicks off a FULL reconnect (reset → 3s settle → re-pair) inside a process that
// systemd is trying to kill. That reconnect kept the event loop busy until the
// 90s TimeoutStopSec expired and systemd SIGKILLed us.
let shuttingDown = false

// Which phone is on the other end (PhoneType: 3 = CarPlay, 5 = AndroidAuto).
// null whenever nothing is plugged.
let phoneType = null
const phoneLabel = () => (phoneType == null ? null : PhoneType[phoneType] ?? String(phoneType))

// CarplayNode reads Plugged.phoneType and then throws it away, emitting a bare
// {type:'plugged'}, and it never surfaces the dongle's identity/pairing messages
// at all — those only appear as carplay_event_unknown. dongleDriver is a plain
// EventEmitter, so a second listener recovers everything without patching
// node_modules.
//
// prependListener, NOT on: CarplayNode registered its listener in the
// constructor above, and it dispatches 'plugged' to carplay.onmessage
// synchronously. Appending would mean phoneType was still stale by the time the
// 'plugged' handler read it.
// The dongle's identity, kept rather than only logged. Settings → Dongle needs
// it live (which firmware am I on, which model is this), and until now the only
// record was a journal line you had to be on the box to read.
//
// It survives the phone coming and going, because it describes the dongle, not
// the session — the box re-announces all of it on every Open, so the values
// refresh on their own whenever it is re-opened.
const dongle = {
  version: null, versionStamp: null, versionVariant: null,
  uuid: null, mfd: null, boxType: null, productType: null, hwVersion: null,
  oemName: null, hiCar: null, wifiChannel: null,
  btName: null, wifiName: null, manufacturer: null,
  seenAt: null,
  // Live per-session telemetry, refreshed while a phone is attached. Survives
  // the phone leaving so the page can still say who it last spoke to.
  link: { cpuTemp: null, linkType: null, phoneName: null, phoneModel: null, phoneOs: null, at: null },
}
// Strings arrive NUL-padded to a fixed field width; a raw one renders as
// "AutoBox-60bf\0\0..." everywhere it is shown. (Written as escapes on
// purpose: literal NULs here made git and grep treat this whole file as
// binary, so `grep` silently matched nothing and `git diff` showed no lines.)
const dongleStr = (v) => {
  if (typeof v !== 'string') return v ?? null
  const s = v.replace(/\0/g, '').trim()
  return s || null
}

carplay.dongleDriver.prependListener('message', (m) => {
  if (m instanceof Plugged) {
    phoneType = m.phoneType
    log('info', 'phone_type', { type: phoneLabel(), wifi: m.wifi })
  } else if (m instanceof BoxInfo) {
    // boxType / productType / hwVersion are the Phase 0 gate: they say whether
    // this unit's firmware does Android Auto at all.
    log('info', 'dongle_box_info', { settings: m.settings })
    // BoxInfo comes in two flavours on the same message type: the identity
    // block at Open, and a per-session one carrying MDLinkType/cpuTemp while a
    // phone is attached. Only copy fields that are actually present, or the
    // second kind blanks everything the first kind told us.
    const s = m.settings || {}
    const take = (k, dst = k) => { if (s[k] != null) dongle[dst] = typeof s[k] === 'string' ? dongleStr(s[k]) : s[k] }
    take('uuid'); take('MFD', 'mfd'); take('boxType'); take('productType')
    take('hwVersion'); take('OemName', 'oemName'); take('HiCar', 'hiCar')
    take('WiFiChannel', 'wifiChannel')
    if (s.uuid != null) dongle.seenAt = Date.now()
    // The per-session flavour carries live telemetry we were throwing away:
    // the dongle's OWN core temperature, and who it is talking to. Kept in a
    // separate object because `btName` here is the PHONE's Bluetooth name,
    // while dongle.btName (from BluetoothDeviceName) is the dongle's own AP
    // name — same key, different device, and conflating them would be a lie.
    if (s.cpuTemp != null) { dongle.link.cpuTemp = s.cpuTemp; dongle.link.at = Date.now() }
    if (s.MDLinkType != null) dongle.link.linkType = dongleStr(s.MDLinkType)
    if (s.MDModel != null) dongle.link.phoneModel = dongleStr(s.MDModel) || null
    if (s.MDOSVersion != null) dongle.link.phoneOs = dongleStr(s.MDOSVersion) || null
    if (s.btName != null) dongle.link.phoneName = dongleStr(s.btName)
  } else if (m instanceof SoftwareVersion) {
    log('info', 'dongle_version', { version: m.version })
    const v = parseVersion(m.version)
    dongle.version = v.raw
    dongle.versionStamp = v.stamp
    dongle.versionVariant = v.variant
    dongle.seenAt = Date.now()
  } else if (m instanceof ManufacturerInfo) {
    log('info', 'dongle_manufacturer', { a: m.a, b: m.b })
    dongle.manufacturer = { a: m.a, b: m.b }
  } else if (m instanceof BluetoothDeviceName) {
    log('info', 'dongle_bt_name', { name: m.name })
    dongle.btName = dongleStr(m.name)
  } else if (m instanceof WifiDeviceName) {
    log('info', 'dongle_wifi_name', { name: m.name })
    dongle.wifiName = dongleStr(m.name)
  } else if (m instanceof BluetoothPIN) {
    log('info', 'dongle_bt_pin', { pin: m.pin })
  }
})

// The firmware store is created unconditionally; storeWritable() is what the
// page uses to explain a device where /var/lib is read-only or the installer
// never ran, instead of failing at the download.
const firmware = createFirmwareStore({ dir: FIRMWARE_DIR, log })

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

// Ask the dongle to push a fresh frame. Throttled, because a drag fires this
// on every touch that lands and the dongle does not need to hear it 60 times a
// second. The delayed second request is the one that usually matters: the
// phone often has not drawn its reaction yet at the moment the finger lands.
let lastRedrawAt = 0
let redrawTimer = null
function requestRedraw(reason) {
  if (!FORCE_REDRAW_MS || !carplayStarted || !plugged) return
  const now = Date.now()
  if (now - lastRedrawAt < FORCE_REDRAW_MIN_GAP_MS) return
  lastRedrawAt = now
  try { carplay.sendKey('frame') }
  catch (err) { log('warn', 'request_frame_failed', { reason, msg: err.message }) }
  if (redrawTimer) clearTimeout(redrawTimer)
  redrawTimer = setTimeout(() => {
    redrawTimer = null
    if (!carplayStarted || !plugged) return
    try { carplay.sendKey('frame') } catch {}
  }, FORCE_REDRAW_MS)
  redrawTimer.unref?.()
}

// Ask the phone for a picture until one actually arrives.
//
// A page that has just opened /video is staring at its loading card until a
// frame lands, and the card only lifts on the worker's firstFrame message. The
// single sendKey('frame') this used to be is one chance: the ask can reach the
// phone while it has nothing newly drawn, and on a *static* CarPlay screen — a
// paused Now Playing, a map that is not moving, the dashboard at rest — the
// phone volunteers nothing afterwards, so the page waits for the driver to
// touch something. Reported in the car 2026-09-07: returning to CarPlay inside
// a minute, with the dongle still held and the session healthy, was "not
// always instant"; the earlier report of a screen that "didn't show until I
// refresh the page" is the same fault with the reload as the workaround.
//
// So: repeat the ask on a short timer and stop the moment a frame is
// broadcast. Costs nothing in the common case, where the first ask is answered
// and the second timer never fires.
const KEYFRAME_KICK_MS = Number(process.env.CARPLAY_KEYFRAME_KICK_MS ?? 400)
const KEYFRAME_KICK_MAX = Number(process.env.CARPLAY_KEYFRAME_KICK_MAX ?? 8)
let keyframeKickTimer = null
let keyframeKicksLeft = 0

// Called from the video hot path, so it is a null check until there is a kick
// in flight to cancel.
function stopKeyframeKick() {
  if (!keyframeKickTimer) return
  clearTimeout(keyframeKickTimer)
  keyframeKickTimer = null
  keyframeKicksLeft = 0
}

function kickKeyframe(reason) {
  stopKeyframeKick()
  // Not plugged means no phone to ask. Frames start on their own when one
  // arrives, so there is nothing to kick and nothing to warn about.
  if (!carplayStarted || !plugged) return
  keyframeKicksLeft = KEYFRAME_KICK_MAX
  const tick = () => {
    keyframeKickTimer = null
    if (!carplayStarted || !plugged) return
    if (keyframeKicksLeft-- <= 0) {
      log('warn', 'keyframe_kick_exhausted', { reason, ms: KEYFRAME_KICK_MAX * KEYFRAME_KICK_MS })
      return
    }
    try { carplay.sendKey('frame') }
    catch (err) { log('warn', 'request_keyframe_failed', { reason, msg: err.message }) }
    keyframeKickTimer = setTimeout(tick, KEYFRAME_KICK_MS)
    keyframeKickTimer.unref?.()
  }
  tick()
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
  const out = { fps: config.fps, hand: config.hand, aspect: config.aspect }
  // Only persisted once explicitly set, to preserve the "never configured"
  // state — see loadPersistedSettings.
  if (typeof config.androidWorkMode === 'boolean') out.androidAuto = config.androidWorkMode
  if (audioSource) out.audioSource = audioSource
  out.bleEnabled = bleEnabled
  out.carplayOnDemand = onDemand
  const body = JSON.stringify(out) + '\n'
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

async function applyAudioSource(value) {
  if (!ALLOWED_AUDIO_SOURCE.has(value)) {
    log('warn', 'audio_source_rejected', { value })
    return
  }
  if (audioSource === value) return
  audioSource = value
  config.audioTransferMode = audioTransferFlagFor(value)
  try { await persistSettings() }
  catch (err) { log('warn', 'audio_source_persist_failed', { msg: err.message }) }
  broadcast(socketControl, JSON.stringify({ type: 'audioSource', value }), { compress: false })
  log('info', 'audio_source_applied', { value, audioTransferMode: config.audioTransferMode })
  // The transfer flag is only read while the dongle is being initialised, so
  // the session has to come back for it to mean anything — same as fps/hand.
  restartCarplay('audio_source_change')
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
  broadcast(socketControl, JSON.stringify({ type: 'aspect', value, height: config.height }), { compress: false })
  log('info', 'aspect_applied', { value, height: config.height })
  restartCarplay('aspect_change')
}

// node-carplay only pushes ANDROID_WORK_MODE when the value is truthy
// (DongleDriver.start(): `if (config.androidWorkMode)`), so a false never
// reaches the dongle. The dongle persists the flag in /etc/android_work_mode
// across power cycles, which would make enabling it a one-way switch on the
// only dongle we own. Send the boolean ourselves so it can be turned back off.
function sendAndroidWorkMode(value) {
  try {
    carplay.dongleDriver.send(new SendBoolean(value, FileAddress.ANDROID_WORK_MODE))
    log('info', 'android_work_mode_sent', { value })
  } catch (err) {
    log('warn', 'android_work_mode_send_failed', { value, msg: err.message })
  }
}

async function applyBleEnabled(value) {
  const v = !!value
  if (bleEnabled === v) return
  bleEnabled = v
  // Drop what was already read. Leaving cached car state on screen after the
  // radio has been switched off would present stale data as live.
  bleCache.clear()
  try { await persistSettings() }
  catch (err) { log('warn', 'ble_enabled_persist_failed', { msg: err.message }) }
  broadcast(socketControl, JSON.stringify({ type: 'bleEnabled', value: v }), { compress: false })
  log('info', 'ble_enabled_applied', { value: v })
}

// Turning this OFF has to actively start the dongle: demandActive() answers
// "yes" unconditionally from here on, but nothing re-evaluates on its own until
// a client event arrives, and a user who just asked for always-on should not
// wait for one. Turning it ON is the cheap direction — a page is open (they are
// looking at Settings), so demand is already held and the session only lets go
// once that page does.
async function applyCarplayOnDemand(value) {
  const v = !!value
  if (onDemand === v) return
  onDemand = v
  try { await persistSettings() }
  catch (err) { log('warn', 'carplay_on_demand_persist_failed', { msg: err.message }) }
  broadcast(socketControl, JSON.stringify({ type: 'carplayOnDemand', value: v }), { compress: false })
  log('info', 'carplay_on_demand_applied', { value: v })
  if (v) {
    // Enter as if demand were held, so syncDemand sees a real transition and
    // arms the idle release in the one case that needs it: on-demand switched
    // on from a client that is not itself asserting demand.
    demandWas = true
    syncDemand('setting_on')
  } else {
    demandWas = true
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (!carplayStarted && !restartInFlight) restartCarplay('on_demand_off')
  }
}

async function applyAndroidAuto(value) {
  const v = !!value
  if (config.androidWorkMode === v) return
  config.androidWorkMode = v
  try { await persistSettings() }
  catch (err) { log('warn', 'android_auto_persist_failed', { msg: err.message }) }
  // Write to the live dongle BEFORE restarting, so the re-init that follows
  // already comes up in the new mode rather than one restart behind.
  if (carplayStarted) sendAndroidWorkMode(v)
  log('info', 'android_auto_applied', { value: v })
  restartCarplay('android_auto_change')
}

// Kick the dongle to retry phone pairing. Caller-rate-limited because a
// flapping WS keepalive could otherwise stack pokes on top of the 15 s
// periodic tick. See docs/carlink-protocol-notes.md.
const AUTOCONNECT_MIN_GAP_MS = 5000
let lastPokeAt = 0

// Pairing mode. `wifiConnect` means "reconnect to the phone you already know",
// which is the right thing 99% of the time and exactly the wrong thing while
// someone is trying to pair a NEW phone: we send it every 15 s, and each one
// lands in the middle of the handshake the phone is attempting. Observed
// 2026-08-21 09:11 — the dongle reported `deviceFound`, then nothing, while the
// iPhone sat spinning on the Bluetooth entry and never registered.
//
// So during a pairing window the poke sends the pairing commands instead:
// btPairStart (1011, "begin BT pair search") — which this project had never
// sent at all — and wifiPair (1012).
const PAIR_WINDOW_MS = Number(process.env.CARPLAY_PAIR_WINDOW_MS ?? 120000)
const PAIR_KEYS = ['btPairStart', 'wifiPair']
let pairUntil = 0
const pairing = () => Date.now() < pairUntil

function pokeAutoconnect(trigger, keys = ['wifiConnect']) {
  if (plugged || !carplayStarted) return
  // Inside the idle grace window the session is on its way out; courting a
  // phone that is about to be released is exactly backwards.
  if (onDemand && !demandActive()) return
  if (pairing()) keys = PAIR_KEYS
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

// ---- Demand gate ----------------------------------------------------------
// Per-socket rather than one global timestamp: a laptop sitting on Settings and
// the car's browser are independent voters, and one going hidden must not pull
// the dongle out from under the other.
let idleTimer = null
let releasing = false
// Edge state. syncDemand() only acts on transitions, so the 5 s sweep and the
// 15 s client heartbeat are both free when nothing has changed.
let demandWas = !onDemand
// Set when a socket closes with a live lease; see GHOST_LEASE_MS.
let ghostLeaseUntil = 0
// Last absence a page reported on returning, in ms. Reported, not inferred.
let lastAwayMs = null

function demandActive() {
  if (!onDemand) return true
  const now = Date.now()
  if (ghostLeaseUntil > now) return true
  for (const c of socketControl.clients) if (c.demandUntil > now) return true
  return false
}

// Called on anything that could move demand: a client connecting, dropping,
// going hidden or visible, or a heartbeat lapsing.
function syncDemand(reason) {
  const want = demandActive()
  if (want === demandWas) return
  demandWas = want
  if (want) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    log('info', 'carplay_demand', { reason, away_ms: lastAwayMs })
    lastAwayMs = null
    if (carplayStarted) pokeAutoconnect('demand', ['wifiConnect', 'wifiPair'])
    else restartCarplay('demand')
    return
  }
  log('info', 'carplay_idle_arm', { reason, ms: IDLE_STOP_MS })
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (demandActive()) return
    releaseDongle('idle')
  }, IDLE_STOP_MS)
  idleTimer.unref?.()
}

// Hand the phone back.
//
// `SendDisconnectPhone` — node-carplay's own comment: "disconnects phone
// session - dongle is still open and phone can re-connect". This is the one
// that actually returns the phone to home Wi-Fi. Closing the USB handle does
// not: the dongle<->phone link is between those two, and the phone sits on the
// dongle's AP until it works out for itself that nothing is listening.
//
// `SendCloseDongle` is NOT sent, despite reading like the right message
// ("disconnects phone and closes dongle - need to send open command again").
// It buys nothing here. Measured on this dongle (CPC200-CCPA, firmware
// 2024.01.19) on 2026-08-28: once no host holds it open, the dongle
// re-enumerates on the USB bus roughly every 13 s — a detach/attach pair,
// indefinitely, apparently rebooting itself — and it does that whether or not
// CloseDongle was sent. So the message changes no observable behaviour while
// being the one message upstream documents as requiring a re-open afterwards.
// Sending it is pure downside. CARPLAY_CLOSE_DONGLE=on sends it anyway.
//
// The idle re-enumeration itself is not an error and is handled by the demand
// guards on the usb attach/detach handlers, which keep it at debug level.
async function releaseDongle(reason) {
  if (releasing || shuttingDown) return
  // A start is mid-flight. Its own in-loop demand check will abandon it within
  // one attempt; tearing down underneath it would close the device out from
  // under a pending transfer. Come back when it has unwound.
  if (restartInFlight) {
    idleTimer = setTimeout(() => { idleTimer = null; if (!demandActive()) releaseDongle(reason) }, 2000)
    idleTimer.unref?.()
    return
  }
  releasing = true
  try {
    log('info', 'carplay_release', { reason, was_started: carplayStarted })
    if (carplayStarted) {
      try { carplay.dongleDriver.send(new SendDisconnectPhone()) }
      catch (err) { log('warn', 'disconnect_phone_failed', { msg: err.message }) }
      await sleep(250)
      if (CLOSE_DONGLE) {
        try { carplay.dongleDriver.send(new SendCloseDongle()) }
        catch (err) { log('warn', 'close_dongle_failed', { msg: err.message }) }
        await sleep(250)
      }
    }
    const wasStarted = carplayStarted
    carplayStarted = false
    plugged = false
    phoneType = null
    // Only if there was a session to unwind. Closing a device we never opened
    // is a no-op that still costs a 250 ms settle on every idle timeout.
    if (wasStarted) await settleThenStop()
    broadcast(socketControl, JSON.stringify({ type: 'statusReq', data: carplayPhase(), phone: null }), { compress: false })
    log('info', 'carplay_released', { reason })
  } finally {
    releasing = false
  }
}

// One place that answers "what is CarPlay doing", for /healthz and statusReq
// alike. 'standby' is the new fourth state: nothing is wrong, nobody asked.
function carplayPhase() {
  if (plugged) return 'plugged'
  if (carplayStarted) return 'unplugged'
  return onDemand && !demandWas ? 'standby' : 'starting'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Reject if `promise` hasn't settled within ms. The underlying work is NOT
// cancelled (nothing here can cancel a pending libusb transfer) — the point is
// to stop *waiting* on it so the caller's retry/recovery path can run.
function withTimeout(promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

// start() resolving is a claim, not a fact. node-carplay returns normally even
// when initialise() threw, and it can also "succeed" against a dongle that has
// already vanished — on 2026-08-21 a carplay_started was followed in the SAME
// second by usb_read_error NO_DEVICE and usb_pipeline_stopped {messages:0}.
// Require the read pipeline to actually deliver something before we tell the
// car we are up, so a dead session is retried instead of being sat on.
async function readerHealthy(ms) {
  if (!usbReader) return true   // pipeline disabled; nothing to measure
  const before = usbReader.stats().messages
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(250)
    if (usbReader.stats().messages > before) return true
  }
  return false
}

// Stopping while a transferIn is still outstanding is what surfaced
// "close error: Can't close device with a pending request" as an unhandled
// rejection on every restart. Ask the pipeline to stand down and give the
// in-flight transfers a moment to unwind before closing the device. run() sets
// `stopped = false` again, so this costs the next start() nothing.
const STOP_TIMEOUT_MS = 5000
async function settleThenStop() {
  try { carplay.dongleDriver.stopPipelinedRead?.() } catch {}
  await sleep(250)
  // Bound it for the same reason start() is bounded. stop() closes a device
  // that may still have transfers outstanding, and an unbounded await here
  // would wedge the retry loop with restartInFlight stuck true — which is the
  // state that makes every recovery path a no-op. Losing the handle is
  // recoverable; never returning is not.
  try { await withTimeout(carplay.stop(), STOP_TIMEOUT_MS, 'carplay.stop') }
  catch (err) { log('warn', 'stop_failed', { msg: err.message }) }
}

async function restartCarplay(reason) {
  if (shuttingDown) {
    log('debug', 'restart_skipped', { reason, why: 'shutting_down' })
    return
  }
  if (restartInFlight) {
    // Re-arm rather than drop. See restartPending.
    restartPending = reason
    log('debug', 'restart_queued', { reason })
    return
  }
  restartInFlight = true
  try {
    await runRestart(reason)
  } finally {
    restartInFlight = false
  }
  // Something asked for a restart while we were busy; serve it now — unless it
  // was our own device.reset() echoing back off the bus.
  if (restartPending && !shuttingDown) {
    const next = restartPending
    restartPending = null
    // carplay_started is only reached after readerHealthy() has watched real
    // USB messages land on this handle, so a session that is UP is proof the
    // device settled. A usb_attach/usb_detach queued during that start was the
    // re-enumeration start() itself triggered — this dongle re-enumerates on
    // reset — not a reseat. Serving it tears down the session we just proved
    // good, and that teardown resets the dongle again, which queues the next
    // one: a loop that feeds itself. Measured 2026-09-03: four such cycles
    // turned a 12 s cold start into 40 s, and over one week 33 of 72 starts
    // were this. A real reseat still arrives as a 'failure' event (the reader
    // dies with NO_DEVICE), and the watchdog is the backstop for the rest.
    if (carplayStarted && (next === 'usb_attach' || next === 'usb_detach')) {
      log('debug', 'restart_dropped', { reason: next, why: 'session_healthy' })
      return
    }
    return restartCarplay(next)
  }
}

async function runRestart(reason) {
  const wasStarted = carplayStarted
  carplayStarted = false
  plugged = false
  phoneType = null
  log('info', 'restart_begin', { reason })
  if (wasStarted) {
    // Let the USB device settle after stop() — otherwise the first start()'s
    // device.reset() races the not-yet-released handle (LIBUSB_ERROR_NOT_FOUND)
    // and burns several ~5s retries. One clean attempt is faster than 3 failed.
    await settleThenStop()
    await sleep(DETACH_SETTLE_MS)
  }
  // Nobody is looking. Everything above (the stop, the state reset) still had
  // to happen — this is the point where an always-on build would have started
  // courting the phone again, and an on-demand one must not.
  if (onDemand && !demandActive()) {
    log('info', 'start_skipped', { reason, why: 'no_demand' })
    return
  }
  let backoff = START_RETRY_MS
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    // A newer reason arrived (typically a detach). Abandon this run; the
    // caller re-enters with the fresh reason rather than finishing a restart
    // aimed at a device state that no longer exists.
    if (restartPending || shuttingDown) return
    // Demand can also evaporate mid-loop (the user closed the tab while we
    // were retrying). Same rule as the guard above the loop.
    if (onDemand && !demandActive()) {
      log('info', 'start_abandoned', { attempt, reason, why: 'no_demand' })
      return
    }

    // No dongle on the bus: do not call start() at all. This is the single
    // change that removes the 7-minute storm — an absent dongle used to cost
    // 20 x 21s of timeouts, then process.exit(1), then the same again. The
    // 'attach' handler and the watchdog bring us straight back instead.
    if (!donglePresent()) {
      log('warn', 'dongle_absent', { attempt, reason })
      return
    }

    try {
      startAllowed = true
      try {
        await withTimeout(carplay.start(), START_TIMEOUT_MS, 'carplay.start')
      } finally {
        startAllowed = false
      }
      if (!(await readerHealthy(START_HEALTH_GRACE_MS))) {
        throw new Error(`no USB traffic within ${START_HEALTH_GRACE_MS}ms of start`)
      }
      carplayStarted = true
      log('info', 'carplay_started', { attempt })
      return
    } catch (err) {
      log('warn', 'start_failed', { attempt, msg: err.message, backoff })
      await settleThenStop()
      await sleep(backoff)
      backoff = Math.min(backoff * 2, START_BACKOFF_MAX_MS)
    }
  }
  // Twenty real attempts against a dongle that IS present, with backoff, and it
  // still will not come up. Exiting hands libusb state back to a fresh process;
  // systemd (Restart=always) brings us straight back. Note this is now reached
  // only for a genuinely stuck dongle, never for an unplugged one.
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
// Bound per helper so that guarantee is stated once, not per route.
const mkHelperCall = (helperPath) => (args, timeoutMs = 15000) =>
  execResult('sudo', ['-n', helperPath, ...args], timeoutMs)
const callHelper = mkHelperCall(WIFI_HELPER)
const callApHelper = mkHelperCall(AP_HELPER)
const callPowerHelper = mkHelperCall(POWER_HELPER)
const callDongleHelper = mkHelperCall(DONGLE_HELPER)
const dongleHelperPresent = () => fsSync.existsSync(DONGLE_HELPER)
// The helper answers in JSON on both success and refusal, so a non-zero exit
// still carries a reason worth showing. Anything unparseable is the genuinely
// broken case and is reported as such rather than as an empty result.
function parseHelperJson(r) {
  const raw = (r.stdout || '').trim()
  if (!raw) return { ok: false, error: r.stderr || 'no_output' }
  try { return JSON.parse(raw) }
  catch { return { ok: false, error: 'bad_helper_output', stdout: raw.slice(0, 200) } }
}

// `key=value` lines from `tesla-pi-ap status`.
function parseKv(stdout) {
  const out = {}
  for (const line of String(stdout).split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
// Returns the trimmed ssid, or an error string. SSID_RE already encodes
// "printable ASCII, 1–32" — the same rule hostapd enforces — so reuse it
// rather than re-deriving the bounds here.
function validateApBody(body) {
  if (!body || typeof body !== 'object') return { err: 'body must be an object' }
  if (typeof body.ssid !== 'string') return { err: 'ssid must be a string' }
  const ssid = body.ssid.trim()
  if (!SSID_RE.test(ssid)) return { err: `ssid must be 1–${AP_SSID_MAX} printable ASCII characters` }
  if (typeof body.passphrase !== 'string') return { err: 'passphrase must be a string' }
  const pskErr = validatePsk(body.passphrase)
  if (pskErr) return { err: pskErr }
  return { ssid }
}
// Writes a 405 and returns true when the method is wrong. Used directly by
// routes that have no presence check of their own.
function requireMethod(req, res, method) {
  if (req.method === method) return false
  sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: method })
  return true
}
// Shared 404/405 preamble for every /wifi/* handler. Returns true and
// writes the error response when the request can't proceed.
async function wifiGuard(req, res, { method } = {}) {
  if (!(await wifiPresent())) { sendJson(res, 404, { ok: false, error: 'no_wifi_iface', iface: WIFI_IFACE }); return true }
  return method ? requireMethod(req, res, method) : false
}
// Same shape for the helper-backed panes. A missing helper is 404 ("feature not
// installed") so a genuine helper failure can stay a 5xx — the SPA hides a
// section only on 404, and must not hide the Hotspot card (and the security
// banner with it) just because sudo or hostapd_cli broke. Bound per helper like
// mkHelperCall above, so that contract is stated once.
const mkHelperGuard = (helperPath, missingError) => (req, res, { method } = {}) => {
  if (!fsSync.existsSync(helperPath)) {
    sendJson(res, 404, { ok: false, error: missingError })
    return true
  }
  return method ? requireMethod(req, res, method) : false
}
const apGuard = mkHelperGuard(AP_HELPER, 'ap_helper_missing')
// 404 here means scripts/install-power-tab.sh was never run on this device,
// which is how the SPA decides whether to show the System section.
const powerGuard = mkHelperGuard(POWER_HELPER, 'power_helper_missing')

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
// ISO 3166-1 alpha-2, or '00' for the world domain. Mirrors the check in
// scripts/tesla-pi-ap; the helper is the authority, this is the early 400.
const AP_COUNTRY_RE = /^([A-Z]{2}|00)$/
// Returns the normalised country, or an error string. Same shape as
// validateApBody / validateConnectBody so the route bodies stay uniform.
function validateCountryBody(body) {
  const cc = (body && typeof body.country === 'string' ? body.country : '').trim().toUpperCase()
  if (!AP_COUNTRY_RE.test(cc)) return { err: 'country must be a 2-letter ISO 3166-1 code, or 00' }
  return { cc }
}
// The radio half of `tesla-pi-ap status`, shared by /ap/status and /ap/country
// so the SPA sees one shape from both. '00' is the world domain, which is what
// a box whose country was never set — or an unparseable one — reports.
function radioFields(kv) {
  return {
    country: kv.country || '',
    band: kv.band || '',
    channel: Number(kv.channel || 0) || null,
    radio_reason: kv.radio_reason || '',
  }
}
// WPA-PSK bounds, shared by the wifi-client and hotspot paths. Returns an error
// string or null. Printable-ASCII matters for the hotspot in particular: a
// newline would let a caller append directives to hostapd.conf via the helper.
function validatePsk(psk) {
  if (typeof psk !== 'string') return 'password must be a string'
  if (psk.length < AP_PSK_MIN || psk.length > AP_PSK_MAX) return `password must be ${AP_PSK_MIN}–${AP_PSK_MAX} chars`
  if (!/^[\x20-\x7e]+$/.test(psk)) return 'password must be printable ASCII'
  return null
}
function validateConnectBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object'
  if (typeof body.ssid !== 'string' || !SSID_RE.test(body.ssid)) return 'invalid ssid'
  if (body.password != null) return validatePsk(body.password)
  return null
}

const httpServer = http.createServer(async (req, res) => {
  try {
    let p = new URL(req.url, 'http://x').pathname
    if (p === '/healthz') {
      const totalMb = Math.round(os.totalmem() / 1048576)
      const usedMb = Math.round((os.totalmem() - os.freemem()) / 1048576)
      sendJson(res, 200, {
        carplay: carplayPhase(),
        carplay_on_demand: onDemand,
        carplay_demand: demandActive(),
        phone_type: phoneLabel(),
        android_work_mode: config.androidWorkMode ?? null,
        ble_enabled: bleEnabled,
        // Distinct from ble_enabled: a box with no helper configured cannot do
        // this at all, and the UI should say so rather than offer a dead switch.
        ble_configured: !!TESLA_BLE_HELPER,
        audio_source: audioSource || 'bluetooth',
        audio_streams: Object.fromEntries([...audioStreamStats].map(([k, v]) => [
          k, { frames: v.frames, bytes: v.bytes, quiet_s: Math.floor((Date.now() - v.lastAt) / 1000) },
        ])),
        usb: usbReader ? usbReader.stats() : { enabled: false },
        uptime_s: Math.floor(process.uptime()),
        video_clients: socketVideo.clients.size,
        audio_clients: socketAudio.clients.size,
        control_clients: socketControl.clients.size,
        cert_days_remaining: certDaysRemaining(),
        cert_uplink: uplinkIface() || null,
        hostname: os.hostname(),
        cpu_temp_c: cpuTempC(),
        cpu_freq: cpuFreq(),
        disk: diskInfo(),
        wifi_link: wifiLink(),
        ap_clients: apClients(),
        net: Object.fromEntries(netRates),
        proc_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
        // The adapter's own telemetry, which costs no Bluetooth and no polling:
        // it volunteers this on every session heartbeat.
        dongle: {
          version: dongle.versionStamp, variant: dongle.versionVariant,
          product_type: dongle.productType, hw_version: dongle.hwVersion,
          bt_name: dongle.btName, wifi_name: dongle.wifiName,
          wifi_channel: dongle.wifiChannel,
          cpu_temp_c: dongle.link.cpuTemp,
          link_type: dongle.link.linkType,
          phone_name: dongle.link.phoneName,
          phone_model: dongle.link.phoneModel || null,
          phone_os: dongle.link.phoneOs || null,
          seen_s: dongle.link.at ? Math.floor((Date.now() - dongle.link.at) / 1000) : null,
        },
        power: powerState(),
        mem_used_mb: usedMb,
        mem_total_mb: totalMb,
        load_avg: Math.round(os.loadavg()[0] * 100) / 100,
        cpu_count: os.cpus().length,
        retroarch: retroarch.state(),
        karaoke: karaoke.state(),
      })
      return
    }
    if (p.startsWith('/retroarch/')) {
      if (await retroarch.handleHttp(p, req, res)) return
    }
    if (p.startsWith('/karaoke/')) {
      if (await karaoke.handleHttp(p, req, res)) return
    }
    // Put the dongle into "pair a new phone" mode for a couple of minutes, and
    // hold off the reconnect-to-known-phone poke for the same window.
    if (p === '/carplay/pair') {
      if (req.method !== 'POST' && req.method !== 'GET') { requireMethod(req, res, 'POST'); return }
      if (!carplayStarted) { sendJson(res, 409, { ok: false, error: 'carplay_not_started' }); return }
      pairUntil = Date.now() + PAIR_WINDOW_MS
      lastPokeAt = 0            // let the first pairing poke go out immediately
      pokeAutoconnect('pair_request')
      log('info', 'pair_mode_started', { window_ms: PAIR_WINDOW_MS })
      sendJson(res, 200, { ok: true, window_ms: PAIR_WINDOW_MS, keys: PAIR_KEYS })
      return
    }
    if (p === '/carplay/pair/stop') {
      pairUntil = 0
      log('info', 'pair_mode_stopped', {})
      sendJson(res, 200, { ok: true })
      return
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

    // ---- Settings → Hotspot (the Tesla-facing AP on wlan0) -----------------
    // Deliberately never returns the passphrase: it is this appliance's trust
    // boundary (SECURITY.md), so it is write-only from the SPA's perspective.
    if (p === '/ap/status') {
      if (apGuard(req, res)) return
      const r = await callApHelper(['status'], 8000)
      if (!r.ok) { sendJson(res, 500, { ok: false, error: 'helper_failed', stderr: r.stderr }); return }
      const kv = parseKv(r.stdout)
      sendJson(res, 200, {
        ok: true,
        ssid: kv.ssid || '',
        is_default: kv.is_default === '1',
        // Empty means the helper could not read hostapd's control socket (see
        // its sta_count) — report that as unknown, not as an authoritative 0.
        stations: kv.stations ? Number(kv.stations) : null,
        ssid_max: AP_SSID_MAX,
        psk_min: AP_PSK_MIN,
        psk_max: AP_PSK_MAX,
        ...radioFields(kv),
      })
      return
    }
    // Writes the config but does NOT restart — restarting drops every client,
    // including the Tesla making this request. The SPA shows the new
    // credentials first, then calls /ap/restart once the user confirms.
    if (p === '/ap/config') {
      if (apGuard(req, res, { method: 'POST' })) return
      let body; try { body = await readJsonBody(req) } catch (e) { sendJson(res, 400, { ok: false, error: 'invalid_json', detail: String(e.message) }); return }
      const { ssid, err } = validateApBody(body)
      if (err) { sendJson(res, 400, { ok: false, error: err }); return }
      const r = await callApHelper(['set', ssid, body.passphrase], 10000)
      // Log the SSID but never the passphrase.
      log(r.ok ? 'info' : 'warn', 'ap_config', { ok: r.ok, ssid, stderr: r.stderr })
      sendJson(res, r.ok ? 200 : 500, { ok: r.ok, ssid, stderr: r.ok ? '' : r.stderr })
      return
    }
    // Sets the regulatory domain and re-picks the channel under it. Like
    // /ap/config this writes without restarting: the new channel only takes
    // effect on the following /ap/restart, which the SPA fires once the user
    // has been warned the Tesla is about to be dropped.
    if (p === '/ap/country') {
      if (apGuard(req, res, { method: 'POST' })) return
      let body; try { body = await readJsonBody(req) } catch (e) { sendJson(res, 400, { ok: false, error: 'invalid_json', detail: String(e.message) }); return }
      const { cc, err } = validateCountryBody(body)
      if (err) { sendJson(res, 400, { ok: false, error: err }); return }
      const r = await callApHelper(['country', cc], 20000)
      log(r.ok ? 'info' : 'warn', 'ap_country', { ok: r.ok, country: cc, stderr: r.stderr })
      if (!r.ok) { sendJson(res, 500, { ok: false, country: cc, stderr: r.stderr }); return }
      // The helper prints what the radio actually landed on, so there is no
      // second privileged round trip here. It matters because a country whose
      // rules forbid 5 GHz degrades to 2.4 rather than failing.
      sendJson(res, 200, { ok: true, ...radioFields(parseKv(r.stdout)) })
      return
    }
    // Restarts hostapd. This kills the caller's own connection by design, so
    // answer BEFORE the radio goes down — same constraint as /cert/renew.
    if (p === '/ap/restart') {
      if (apGuard(req, res, { method: 'POST' })) return
      log('info', 'ap_restart_requested', {})
      sendJson(res, 202, { ok: true, restarting: true })
      // Give the response time to reach the Tesla before the AP drops.
      setTimeout(() => {
        callApHelper(['restart'], 20000)
          .then((r) => log(r.ok ? 'info' : 'warn', 'ap_restart_done', { ok: r.ok, stderr: r.stderr }))
          .catch((e) => log('warn', 'ap_restart_failed', { msg: String(e && e.message) }))
      }, 1200).unref?.()
      return
    }
    // ---- Settings → System (restart / shut down the device) ---------------
    // Presence probe for the SPA, and the machine's own uptime — process
    // uptime already rides /healthz, but "how long has the Pi been up" is what
    // this section is about.
    if (p === '/power/status') {
      if (powerGuard(req, res)) return
      sendJson(res, 200, { ok: true, uptime_s: Math.floor(os.uptime()) })
      return
    }
    // Both of these end with this process being killed by systemd, so — like
    // /ap/restart — answer BEFORE dispatching, then let the helper run on a
    // short delay so the response has reached the Tesla first. The helper
    // itself uses `systemctl --no-block`, so nothing here waits on a shutdown
    // transaction that is busy stopping us.
    if (p === '/power/reboot' || p === '/power/shutdown') {
      if (powerGuard(req, res, { method: 'POST' })) return
      const verb = p === '/power/reboot' ? 'reboot' : 'poweroff'
      log('info', 'power_requested', { verb })
      sendJson(res, 202, { ok: true, action: verb })
      setTimeout(() => {
        callPowerHelper([verb], 10000)
          .then((r) => log(r.ok ? 'info' : 'warn', 'power_dispatched', { verb, ok: r.ok, stderr: r.stderr }))
          .catch((e) => log('warn', 'power_dispatch_failed', { verb, msg: String(e && e.message) }))
      }, 1200).unref?.()
      return
    }
    // ---- Settings → Dongle (firmware library for the CarPlay adapter) ------
    // Everything the section needs in one poll: who the dongle says it is, the
    // catalogue for that model, what is already downloaded, and the state of
    // any download in flight. One endpoint because the page is a single view
    // and four round trips from a car on a hotspot is three too many.
    if (p === '/dongle/info') {
      const model = modelFor(dongle.productType)
      const [have, free] = await Promise.all([firmware.list(model), firmware.freeBytes()])
      sendJson(res, 200, {
        ok: true,
        dongle: { ...dongle, plugged, phone: phoneLabel() },
        model: model
          ? { productType: model.productType, model: model.model, aka: model.aka, updateName: model.updateName }
          : null,
        catalog: catalogFor(model, dongle.versionStamp),
        source: { repo: FIRMWARE_REPO, commit: FIRMWARE_COMMIT },
        store: { dir: FIRMWARE_DIR, writable: storeWritable(FIRMWARE_DIR), free, files: have },
        job: firmware.job(),
        // The stick writer is the only part that needs the installer. Say which
        // of the two states this device is in so the page can explain itself
        // rather than hiding a button with no reason given.
        usb: { helper: dongleHelperPresent(), path: DONGLE_HELPER },
      })
      return
    }
    // Start a download. The version is a catalogue key, never a URL — see
    // dongle-firmware.js for why that distinction is the whole security model.
    if (p === '/dongle/firmware/fetch') {
      if (requireMethod(req, res, 'POST')) return
      const model = modelFor(dongle.productType)
      if (!model) { sendJson(res, 409, { ok: false, error: 'unknown_model', productType: dongle.productType }); return }
      if (!storeWritable(FIRMWARE_DIR)) { sendJson(res, 409, { ok: false, error: 'store_not_writable', dir: FIRMWARE_DIR }); return }
      const version = new URL(req.url, 'http://x').searchParams.get('v') || ''
      const r = await firmware.fetchBuild(model, version)
      sendJson(res, r.ok ? 202 : 409, r)
      return
    }
    if (p === '/dongle/firmware/cancel') {
      if (requireMethod(req, res, 'POST')) return
      sendJson(res, 200, firmware.cancel())
      return
    }
    if (p === '/dongle/firmware/remove') {
      if (requireMethod(req, res, 'POST')) return
      const model = modelFor(dongle.productType)
      const version = new URL(req.url, 'http://x').searchParams.get('v') || ''
      const r = await firmware.remove(model, version)
      sendJson(res, r.ok ? 200 : 409, r)
      return
    }
    // Removable FAT targets the helper is willing to write to. 404 (not 500)
    // when the helper is absent, matching the convention the other panes use
    // for "this feature was never installed".
    if (p === '/dongle/usb/targets') {
      if (!dongleHelperPresent()) { sendJson(res, 404, { ok: false, error: 'dongle_helper_missing' }); return }
      const r = await callDongleHelper(['targets'], 10000)
      sendJson(res, 200, parseHelperJson(r))
      return
    }
    // Copy one downloaded image onto a stick under the name the dongle's
    // updater looks for. This does NOT flash anything — the stick still has to
    // be moved to the dongle by hand, which is the only path Carlinkit offer.
    if (p === '/dongle/usb/write') {
      if (requireMethod(req, res, 'POST')) return
      if (!dongleHelperPresent()) { sendJson(res, 404, { ok: false, error: 'dongle_helper_missing' }); return }
      const model = modelFor(dongle.productType)
      if (!model) { sendJson(res, 409, { ok: false, error: 'unknown_model' }); return }
      const q = new URL(req.url, 'http://x').searchParams
      const version = q.get('v') || ''
      const device = q.get('device') || ''
      if (!(await firmware.has(model, version))) { sendJson(res, 409, { ok: false, error: 'not_downloaded', version }); return }
      // The image name and destination name both come from the catalogue, not
      // the request; only `device` is caller-supplied, and the helper re-checks
      // that against the kernel before it mounts anything.
      const image = model.prefix + version + '.img'
      log('info', 'firmware_usb_write', { version, device })
      const r = await callDongleHelper(['write', image, device, model.updateName], 120000)
      const out = parseHelperJson(r)
      log(out.ok ? 'info' : 'warn', 'firmware_usb_write_done', { version, device, ok: out.ok, error: out.error })
      sendJson(res, out.ok ? 200 : 409, out)
      return
    }
    // Manual cert-renewal trigger. POST-only, allowed at any time — the sync
    // is a cheap version check against the cert service, and a device that is
    // already current just gets told so. --no-block so systemd returns as soon
    // as the unit is queued. cert-renew-now.sh picks its own path: with an
    // uplink it syncs in place, without one it tears down hostapd to reach the
    // home Wi-Fi — and in that case we MUST answer before the AP dies,
    // otherwise the Tesla never sees the response. `ap_flip` tells the SPA
    // which of the two it is about to live through. Sudoers grants NOPASSWD
    // for this exact invocation only (see tesla-doc.md install steps).
    if (p === '/cert/renew') {
      if (requireMethod(req, res, 'POST')) return
      // Uncached: it must match what cert-renew-now.sh sees a moment from now.
      const uplink = uplinkIface({ fresh: true })
      // The button never dispatches the AP-flip path. Without an uplink
      // cert-renew-now.sh tears hostapd down to reach the home Wi-Fi, which
      // drops the car that just pressed it — and only pays off if that network
      // is in range, which it is not while you are driving. The idle watcher
      // still flips, but only after the Tesla has been gone a while.
      if (!uplink) { sendJson(res, 409, { ok: false, error: 'no_uplink' }); return }
      // A default route is not the internet: the Pi joins captive hotspots and
      // dead APs like anything else. Renewal costs a hostapd reload at the end,
      // so confirm the cert service actually answers before starting one.
      if (!(await certServiceReachable())) {
        log('warn', 'cert_renew_blocked', { reason: 'unreachable', uplink })
        sendJson(res, 409, { ok: false, error: 'no_internet', uplink })
        return
      }
      const r = await execResult('sudo', ['-n', 'systemctl', 'start', '--no-block', 'cert-renew-now.service'], 4000)
      _certReadAt = 0 // force a fresh cert read on the next /healthz
      log(r.ok ? 'info' : 'warn', 'cert_renew_triggered', { ok: r.ok, uplink, stderr: r.stderr })
      sendJson(res, r.ok ? 202 : 500, { ok: r.ok, uplink, stderr: r.stderr })
      return
    }
    // Upload sink for the in-car probe pages: static/mic-probe.html (Tesla
    // 2026.26's browser microphone) and static/webgpu-probe.html (whether the
    // car can host a model). Off unless PROBE_DIR is set, so a normal box has
    // no such route: nothing to reach, nothing to abuse. Even when on, both the
    // probe and the filename come from allowlists rather than the request, and
    // the body is capped, because the writer is a web page in a car and the
    // target is an SD card.
    if (PROBE_UPLOADS[p]) {
      if (!PROBE_DIR) { res.writeHead(404).end(); return }
      if (requireMethod(req, res, 'POST')) return
      // The handler keeps only the pathname, so re-parse for the query.
      const want = new URL(req.url, 'http://x').searchParams.get('f')
      if (!PROBE_UPLOADS[p].includes(want)) {
        sendJson(res, 400, { ok: false, error: 'bad_name' })
        return
      }
      const MAX = 8 * 1024 * 1024
      const chunks = []
      let size = 0
      let aborted = false
      req.on('data', (c) => {
        size += c.length
        if (size > MAX) {
          aborted = true
          sendJson(res, 413, { ok: false, error: 'too_large' })
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', async () => {
        if (aborted) return
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const out = path.join(PROBE_DIR, `${p.slice('/debug/'.length)}-${stamp}-${want}`)
        try {
          await fs.writeFile(out, Buffer.concat(chunks))
          log('info', 'probe_saved', { file: out, bytes: size })
          sendJson(res, 200, { ok: true, file: out, bytes: size })
        } catch (err) {
          log('warn', 'probe_save_failed', { file: out, msg: err.message })
          sendJson(res, 500, { ok: false, error: err.message })
        }
      })
      return
    }
    // ── Vehicle state over BLE ──────────────────────────────────────────
    // Reads only: the signing key is enrolled as `vehicle_monitor`, which
    // cannot unlock or drive. See docs/telemetry-options.md for why that
    // matters on a box whose endpoints are unauthenticated by design.
    //
    // Off unless TESLA_BLE_HELPER names the wrapper script, so a box that was
    // never enrolled has no such route. Same shape as DONGLE_HELPER.
    //
    // Two things this must not do: run more than one BLE operation at a time
    // (concurrent tesla-control invocations fight over hci0), and poll on a
    // timer (the radio shares silicon with the AP, and the AP is the product).
    // Hence the queue and the cache. The page drives this by hand.
    if (p === '/telemetry/ble') {
      if (!TESLA_BLE_HELPER) {
        sendJson(res, 404, { ok: false, error: 'ble_helper_not_configured' })
        return
      }
      if (!bleEnabled) {
        sendJson(res, 403, { ok: false, error: 'ble_disabled' })
        return
      }
      const cat = new URL(req.url, 'http://x').searchParams.get('category') || 'charge'
      if (!BLE_CATEGORIES.has(cat)) {
        sendJson(res, 400, { ok: false, error: 'bad_category' })
        return
      }
      const out = await readBleState(cat)
      sendJson(res, out.ok ? 200 : 502, out)
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
  } catch (err) {
    // This catch is the static-file fallthrough — a missing file is a 404 and
    // that is the common case. But it also swallows anything thrown by the API
    // routes above, and a route that throws then looks exactly like a route
    // that does not exist. That cost real time once: /dongle/info answered 404
    // for weeks because the firmware store could not mkdir under /var/lib, and
    // nothing anywhere said so. Still a 404 on the wire, but never silent.
    if (err && err.code !== 'ENOENT') {
      // Pathname only, capped. NOT req.url: that carries the query string, it is
      // wholly attacker-controlled, and /logs serves this ring to anyone on the
      // hotspot with no authentication. Logging a raw request line into a
      // world-readable buffer is how a diagnostic aid becomes an amplifier.
      let where = 'unparseable'
      try { where = new URL(req.url, 'http://x').pathname.slice(0, 120) } catch {}
      log('warn', 'request_failed', { path: where, msg: err.message, code: err.code })
    }
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
// CarPlay audio for the page. Separate from the video socket because it carries
// a different cadence and, in bluetooth mode, nothing at all.
const socketAudio = new WebSocketServer({ noServer: true, perMessageDeflate: false })

httpServer.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname
  const target =
    p === '/control' || p === '/ws/control' ? socketControl :
    p === '/video'   || p === '/ws/video'   ? socketVideo   :
    p === '/audio'   || p === '/ws/audio'   ? socketAudio   :
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
attachKeepalive(socketAudio)

socketAudio.on('connection', (ws) => {
  log('info', 'audio_connected', { clients: socketAudio.clients.size, source: audioSource || 'bluetooth' })
  // Tell a fresh client what it has walked into, so it can size its player
  // before the first PCM frame rather than guessing.
  ws.send(JSON.stringify({ type: 'micRequest', value: micWanted }))
  ws.send(audioFormatsMsg())
  ws.on('message', (data, isBinary) => { if (isBinary) micFromBrowser(data) })
  ws.on('close', () => {
    log('info', 'audio_disconnected', { clients: socketAudio.clients.size })
    if (!socketAudio.clients.size) micFrameCount = 0
  })
})

// Optional native RetroArch addon — inert unless /usr/local/sbin/tesla-pi-retroarch
// exists (see scripts/install-retroarch-addon.sh and docs/retroarch-addon.md).
const retroarch = createRetroarchBridge({ log, execResult, sendJson, attachKeepalive, broadcast })

// Optional karaoke addon — inert unless /usr/local/sbin/tesla-pi-karaoke exists
// (see scripts/install-karaoke-addon.sh and docs/karaoke-addon.md). Unlike
// RetroArch this bridge only manages the server's lifecycle: the app itself is
// served to the browser by nginx on :8443, not through this process.
const karaoke = createKaraokeBridge({ log, execResult, sendJson })

socketControl.on('connection', (ws) => {
  log('info', 'control_connected', { clients: socketControl.clients.size })
  // Demand starts at zero and is asserted by the client's first carplayWanted,
  // which it sends from onOpen. A socket that never sends one (an old cached
  // page, a script poking the API) therefore never holds the dongle open.
  ws.demandUntil = 0
  pokeAutoconnect('ws_wake', ['wifiConnect', 'wifiPair'])
  ws.send(JSON.stringify({ type: 'frameRate', value: config.fps }))
  ws.send(JSON.stringify({ type: 'hand', value: config.hand }))
  ws.send(JSON.stringify({ type: 'aspect', value: config.aspect, height: config.height }))
  ws.send(JSON.stringify({ type: 'audioSource', value: audioSource || 'bluetooth' }))
  ws.send(JSON.stringify({ type: 'carplayOnDemand', value: onDemand }))
  // Replay the current track so a browser that loaded mid-song isn't blank
  // until the next media message.
  if (nowPlaying) ws.send(nowPlayingMsg())
  if (nowPlayingArt) ws.send(nowPlayingArtMsg())
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'click') {
      const { type, x, y } = msg.data
      if (process.env.LOG_TOUCH) log('debug', 'touch', { t: type, x: +x.toFixed(3), y: +y.toFixed(3) })
      try {
        carplay.sendTouch({ type, x, y })
        // Only the ends of a gesture: a drag's moves already keep the screen
        // updating, and the stale-frame problem is what is left behind after
        // the finger settles or lifts.
        if (type !== 15) requestRedraw('touch')   // 15 = TouchAction.Move
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
        // 2 is the client's "move"; a drag already keeps the screen updating.
        if (arr.some(t => t.action !== 2)) requestRedraw('multitouch')
      } catch (err) {
        log('error', 'send_multitouch_failed', { msg: err.message })
      }
    } else if (msg.type === 'carplayWanted') {
      // The page is open and on screen (true) or hidden/leaving (false). Value
      // is a lease, not a latch: it expires DEMAND_TTL_MS after the last
      // heartbeat, so a tab that is frozen rather than closed still lets go.
      ws.demandUntil = msg.value ? Date.now() + DEMAND_TTL_MS : 0
      // The page's own measure of how long it was off screen. Worth logging
      // because the server's own view of an absence is contaminated by how
      // long the socket took to come back — see docs/carplay-on-demand.md.
      if (msg.value && Number.isFinite(msg.awayMs)) lastAwayMs = Math.round(msg.awayMs)
      syncDemand(msg.value ? 'client_visible' : 'client_hidden')
    } else if (msg.type === 'statusReq') {
      ws.send(JSON.stringify({ type: 'statusReq', data: carplayPhase(), phone: phoneLabel() }))
    } else if (msg.type === 'nightMode') {
      applyNightMode(msg.value, 'client')
    } else if (msg.type === 'frameRate') {
      applyFrameRate(msg.value)
    } else if (msg.type === 'hand') {
      applyHand(msg.value)
    } else if (msg.type === 'aspect') {
      applyAspect(msg.value)
    } else if (msg.type === 'audioSource') {
      applyAudioSource(msg.value)
    } else if (msg.type === 'bleEnabled') {
      applyBleEnabled(msg.value)
    } else if (msg.type === 'androidAuto') {
      applyAndroidAuto(msg.value)
    } else if (msg.type === 'carplayOnDemand') {
      applyCarplayOnDemand(msg.value)
    } else if (msg.type === 'mediaKey') {
      if (ALLOWED_MEDIA_KEYS.has(msg.key)) {
        log('info', 'media_key', { key: msg.key })
        if (carplayStarted && plugged) {
          try {
            // Some ids are absent from node-carplay's CommandMapping, so they
            // go via the raw-command path; the rest are mapped keys.
            const raw = RAW_MEDIA_KEYS.get(msg.key)
            if (raw != null) sendCommand(raw)
            else carplay.sendKey(msg.key)
            requestRedraw('mediaKey')
          } catch (err) { log('error', 'send_media_key_failed', { key: msg.key, msg: err.message }) }
        }
      }
    }
  })
  // The client is already out of socketControl.clients by the time this fires
  // (ws removes it in its own close handler, registered first), so demand-
  // Active() below sees the post-close set.
  ws.on('close', () => {
    // Died mid-view rather than saying goodbye: hold its vote briefly so the
    // page has room to reconnect. A page that went hidden first already zeroed
    // its lease, so this does not extend a deliberate departure.
    const ghost = ws.demandUntil > Date.now()
    if (ghost) ghostLeaseUntil = Date.now() + GHOST_LEASE_MS
    log('info', 'control_disconnected', { clients: socketControl.clients.size, ghost })
    syncDemand('client_gone')
  })
})

socketVideo.on('connection', () => {
  log('info', 'video_connected', { clients: socketVideo.clients.size })
  kickKeyframe('video_connected')
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

// ── CarPlay audio → the page (only when audioSource is 'browser') ──────────
// The dongle does not send one audio stream, it sends several: music at 44.1k
// stereo, navigation prompts, Siri and call audio at 8/16/24k mono, any of
// them starting mid-session without warning. Each message says which format
// (decodeType) and which *kind* (audioType) it belongs to, and the phone also
// sends volume instructions of its own — that is how a real head unit knows to
// duck the music under a turn instruction.
//
// We used to throw all of that away: one player keyed on decodeType, rebuilt
// whenever the format changed, and a nav prompt landing mid-song reset the
// queue for the music too. So the wire protocol now carries the stream
// identity on every frame — a 4-byte prefix, [decodeType, audioType, 0, 0] —
// and the client keeps one player per stream. 4 bytes rather than 2 so the
// PCM behind it stays 2-byte aligned for an Int16Array view.
const AUDIO_FRAME_HEADER = 4
// Set while the phone has asked for a microphone. The page mirrors it, but the
// server keeps its own copy so a client that streams unasked is ignored.
let micWanted = false
let micFrameCount = 0
// Which streams we have already announced in the log this session, so a format
// switch is visible once rather than every 65 ms.
const audioSeenStreams = new Set()
// Per-stream traffic, keyed "decodeType:audioType". The stream announcement in
// the log fires once, on the first frame — which cannot tell "the dongle sent
// us this stream" apart from "the dongle mentioned this stream and then sent
// the audio somewhere else". Bytes can.
const audioStreamStats = new Map()
// Last non-PCM audio message, so a repeated one is not logged twice.
let audioLastEventSig = null

// The decodeType → {hz, channels} table, sent once per client so the page does
// not need its own copy of node-carplay's map.
function audioFormatsMsg() {
  const map = {}
  for (const [k, v] of Object.entries(decodeTypeMap)) {
    map[k] = { hz: v.frequency, channels: v.channel }
  }
  return JSON.stringify({ type: 'formats', map })
}

function audioToBrowser(m) {
  if (audioSource !== 'browser') return
  if (!socketAudio.clients.size) return

  // Volume instructions and stream start/stop announcements. These carry no
  // PCM; they are the phone telling us how the mix should behave.
  if (m.data == null) {
    const ev = {
      type: 'audioEvent',
      command: m.command ?? null,
      decodeType: m.decodeType,
      audioType: m.audioType ?? 0,
      volume: typeof m.volume === 'number' ? m.volume : null,
      volumeDuration: typeof m.volumeDuration === 'number' ? m.volumeDuration : null,
    }
    broadcast(socketAudio, JSON.stringify(ev), { compress: false })
    // Logged because these are the only messages that can silence a stream, and
    // when someone says "I could not hear the meeting" this is the difference
    // between "the phone told us to mute it" and "we lost it ourselves".
    // Deduped against the previous one so a volume ramp cannot flood the ring.
    const sig = `${ev.command}|${ev.decodeType}|${ev.audioType}|${ev.volume}|${ev.volumeDuration}`
    if (sig !== audioLastEventSig) {
      audioLastEventSig = sig
      log('info', 'audio_event', {
        command: ev.command, decodeType: ev.decodeType, audioType: ev.audioType,
        volume: ev.volume, volumeDuration: ev.volumeDuration,
      })
    }
    return
  }

  const key = `${m.decodeType}:${m.audioType ?? 0}`
  let st = audioStreamStats.get(key)
  if (!st) { st = { frames: 0, bytes: 0, lastAt: 0 }; audioStreamStats.set(key, st) }
  st.frames++
  st.bytes += m.data.byteLength
  st.lastAt = Date.now()
  if (!audioSeenStreams.has(key)) {
    audioSeenStreams.add(key)
    const fmt = decodeTypeMap[m.decodeType]
    log('info', 'audio_browser_stream', {
      decodeType: m.decodeType, audioType: m.audioType ?? 0,
      hz: fmt ? fmt.frequency : null, channels: fmt ? fmt.channel : null,
    })
  }
  const pcm = Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength)
  const frame = Buffer.allocUnsafe(AUDIO_FRAME_HEADER + pcm.length)
  frame.writeUInt8(m.decodeType & 0xff, 0)
  frame.writeUInt8((m.audioType ?? 0) & 0xff, 1)
  frame.writeUInt16LE(0, 2)
  pcm.copy(frame, AUDIO_FRAME_HEADER)
  broadcast(socketAudio, frame, { binary: true, compress: false })
}

// Cabin microphone → CarPlay. The page captures the Tesla mic through
// getUserMedia and sends 16 kHz mono S16LE here; SendAudio wraps each chunk in
// the 12-byte header the dongle wants (decodeType 5 — 16 kHz mono — which is
// what the header hardcodes, so the rate is not negotiable).
//
// Measured in the car on 2026-08-21: the cabin mic is real and its permission
// persists, but only `echoCancellation: "remote-only"` keeps our own playback
// out of the capture — see docs/tesla-browser-capabilities.md. With the wrong
// mode the far end hears themselves, which is why the page pins that mode.
function micFromBrowser(buf) {
  if (audioSource !== 'browser' || !micWanted || !plugged) return
  if (!buf || !buf.byteLength || buf.byteLength % 2) return
  // Copy rather than view: SendAudio serialises `data.buffer` whole, so a view
  // into a larger pooled Buffer would ship the neighbouring bytes as audio.
  const i16 = new Int16Array(buf.byteLength / 2)
  for (let i = 0; i < i16.length; i++) i16[i] = buf.readInt16LE(i * 2)
  try {
    carplay.dongleDriver.send(new SendAudio(i16))
    if (micFrameCount === 0) log('info', 'mic_first_frame', { samples: i16.length })
    micFrameCount++
  } catch (err) {
    log('warn', 'mic_send_failed', { msg: err.message })
  }
}

// ── Audio tap (debug, off unless AUDIO_TAP is set) ─────────────────────────
// The dongle sends us the phone's audio already decoded — S16LE PCM, with
// `decodeType` naming the format (44.1k stereo for media, 8/16/24k mono for
// calls and Siri). We drop it on the floor, because in this car the audio rides
// the phone's own Bluetooth link and the Pi is not in the path.
//
// Both of the routes we are considering — into the browser, or out over
// Bluetooth from the Pi — depend on that audio actually arriving, which has
// never been confirmed on this box: the iPhone only sends audio to CarPlay when
// CarPlay is its selected output. Setting AUDIO_TAP=/var/tmp/carplay-audio
// writes each stream to <prefix>-<decodeType>.raw so it can be played back:
//
//   aplay -f S16_LE -r 44100 -c 2 /var/tmp/carplay-audio-1.raw
//
// Same switch style as LOG_TOUCH/LOG_FPS: absent means the code below never
// runs, so a normal boot is byte-for-byte unchanged.
const AUDIO_TAP = process.env.AUDIO_TAP || ''
// Where static/mic-probe.html may drop its report. Unset (the default) means the
// upload route below does not exist at all — the probe page still runs and shows
// everything on screen, it just can't save you reading it off the car's display.
// Probe upload sink. MIC_PROBE_DIR is still honoured because it is what the
// deployed boxes and the env template already say; PROBE_DIR is the name now
// that a second probe page writes here too.
const PROBE_DIR = process.env.PROBE_DIR || process.env.MIC_PROBE_DIR || ''

// ── Vehicle state over BLE ─────────────────────────────────────────────────
// Path to scripts/tesla-pi-ble. Unset disables /telemetry/ble entirely.
const TESLA_BLE_HELPER = process.env.TESLA_BLE_HELPER || ''
// Exactly the categories tesla-control accepts. Not user-extensible: the value
// is passed as an execFile argument, and an allowlist is what keeps it one.
const BLE_CATEGORIES = new Set([
  'charge', 'climate', 'drive', 'location', 'closures', 'tire-pressure',
  'media', 'media-detail', 'charge-schedule', 'precondition-schedule',
  'parental-controls', 'software-update',
])
// A BLE round trip is seconds, not milliseconds, and every one of them costs
// radio time the AP would rather have. Serve repeats from cache.
const BLE_CACHE_MS = 20000
// Failures expire much sooner. A 20 s hold on "no VIN" means someone who fixes
// the VIN and retries still sees the old error and thinks it did not work. Long
// enough to stop a page hammering the radio, short enough to feel responsive.
const BLE_FAIL_CACHE_MS = 5000
// tesla-control connects, negotiates a session and reads. 30 s is generous but
// a hung BLE stack must not hold an HTTP socket open forever.
const BLE_TIMEOUT_MS = 30000
const bleCache = new Map()
// Chain, not a boolean flag: two requests arriving together must queue rather
// than both deciding the radio is free.
let bleQueue = Promise.resolve()
const bleSerial = (fn) => {
  const run = bleQueue.then(fn, fn)
  bleQueue = run.then(() => {}, () => {})
  return run
}

async function readBleState(category) {
  const fresh = (e) => e && Date.now() - e.at < (e.value.ok ? BLE_CACHE_MS : BLE_FAIL_CACHE_MS)
  const hit = bleCache.get(category)
  if (fresh(hit)) return { ...hit.value, cached: true, ageMs: Date.now() - hit.at }
  return bleSerial(async () => {
    // Re-check inside the queue: while we waited our turn, the request ahead of
    // us may have fetched exactly what we wanted.
    const again = bleCache.get(category)
    if (fresh(again)) return { ...again.value, cached: true, ageMs: Date.now() - again.at }
    const t0 = Date.now()
    const r = await execResult(TESLA_BLE_HELPER, ['state', category], BLE_TIMEOUT_MS)
    let value
    if (r.ok) {
      // tesla-control's output format is not contractual, so parse if it is
      // JSON and pass the text through untouched if it is not.
      let parsed = null
      try { parsed = JSON.parse(r.stdout) } catch { parsed = null }
      value = { ok: true, category, data: parsed, raw: parsed ? null : r.stdout }
    } else {
      value = { ok: false, category, error: r.stderr || r.stdout || 'command failed' }
    }
    value.elapsedMs = Date.now() - t0
    bleCache.set(category, { at: Date.now(), value })
    log(value.ok ? 'info' : 'warn', 'ble_state', { category, ok: value.ok, ms: value.elapsedMs })
    return { ...value, cached: false }
  })
}
// Which probe may write which filenames. Both halves are allowlists so nothing
// about the path on disk comes from the request.
const PROBE_UPLOADS = {
  '/debug/mic-probe': ['report.json', 'capture.wav'],
  '/debug/webgpu-probe': ['report.json'],
  '/debug/telemetry-probe': ['report.json'],
}
// The SD card is the thing to protect here; 32 MB is ~3 minutes of 44.1k
// stereo, far more than any diagnostic needs.
const AUDIO_TAP_MAX = Number(process.env.AUDIO_TAP_MAX_BYTES || 32 * 1024 * 1024)
const audioTaps = new Map()   // decodeType -> { stream, bytes, capped }

function audioTapWrite(msg) {
  if (!AUDIO_TAP || !msg.data || !msg.data.byteLength) return
  const type = msg.decodeType
  let tap = audioTaps.get(type)
  if (!tap) {
    const fmt = decodeTypeMap[type]
    const path = `${AUDIO_TAP}-${type}.raw`
    tap = { stream: fsSync.createWriteStream(path), bytes: 0, capped: false }
    tap.stream.on('error', (err) => log('warn', 'audio_tap_failed', { path, msg: err.message }))
    audioTaps.set(type, tap)
    log('info', 'audio_tap_open', {
      path, decodeType: type,
      hz: fmt ? fmt.frequency : null, channels: fmt ? fmt.channel : null,
      audioType: msg.audioType,
    })
  }
  if (tap.capped) return
  if (tap.bytes >= AUDIO_TAP_MAX) {
    tap.capped = true
    tap.stream.end()
    log('info', 'audio_tap_capped', { decodeType: type, bytes: tap.bytes })
    return
  }
  // msg.data is an Int16Array view starting 12 bytes into the USB payload —
  // hand Buffer the view's own offset and length, not the whole backing buffer,
  // or the message header lands in the audio as a click.
  tap.bytes += msg.data.byteLength
  tap.stream.write(Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength))
}

// ── Now playing ────────────────────────────────────────────────────────────
// The dongle ships MediaData in two flavours, as separate messages: a JSON
// track blob (type 1) and a raw cover image (type 3). node-carplay 4.1.0
// decodes both and CarplayNode emits them as {type:'media'} — until now they
// fell through to the default branch and were logged as carplay_event_unknown.
//
// Why the client wants this: CarPlay audio never touches the Pi (it rides the
// phone's Bluetooth link to the car), so music keeps playing while the browser
// sits on the launcher or in RetroArch with nothing on screen to show for it.
//
// Track and cover are broadcast separately: the track blob is small and
// repeats as the play position moves, the cover is tens of KB and only changes
// per song. Both are replayed to a control client on connect, otherwise a
// browser that loads mid-song shows nothing until the next track change.
const MEDIA_TYPE_DATA = 1
const MEDIA_TYPE_ALBUM_COVER = 3
// Base64 characters, so ~3/4 of this in image bytes. Cover art from iOS runs
// well under 100 KB; anything past this is a decode gone wrong, not artwork.
const NOW_PLAYING_ART_MAX = 512 * 1024
let nowPlaying = null     // { title, artist, album, app, duration, elapsed }
let nowPlayingArt = null  // data: URL
let mediaSeen = false
let artMagicWarned = false

const nowPlayingMsg = () => JSON.stringify({ type: 'nowPlaying', track: nowPlaying })
const nowPlayingArtMsg = () => JSON.stringify({ type: 'nowPlayingArt', art: nowPlayingArt })

function trackFromMedia(media) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  return {
    title: str(media.MediaSongName),
    artist: str(media.MediaArtistName),
    album: str(media.MediaAlbumName),
    app: str(media.MediaAPPName),
    duration: num(media.MediaSongDuration),
    elapsed: num(media.MediaSongPlayTime),
  }
}

// iOS sends the cover as bare image bytes with no content type. Sniff the
// magic number rather than guessing: an <img> fed the wrong mime in a data:
// URL is not reliably sniffed by Chromium.
function artDataUrl(b64) {
  if (b64.startsWith('/9j/')) return 'data:image/jpeg;base64,' + b64
  if (b64.startsWith('iVBORw0KGgo')) return 'data:image/png;base64,' + b64
  if (!artMagicWarned) {
    artMagicWarned = true
    log('warn', 'now_playing_art_unknown', { head: b64.slice(0, 12), len: b64.length })
  }
  return null
}

function clearNowPlaying() {
  if (!nowPlaying && !nowPlayingArt) return
  nowPlaying = null
  nowPlayingArt = null
  broadcast(socketControl, nowPlayingMsg(), { compress: false })
  broadcast(socketControl, nowPlayingArtMsg(), { compress: false })
}

function handleMedia(m) {
  // node-carplay leaves payload undefined for media types it doesn't know.
  const p = m && m.payload
  if (!p) return
  if (!mediaSeen) {
    mediaSeen = true
    log('info', 'now_playing_first', { payloadType: p.type })
  }

  if (p.type === MEDIA_TYPE_DATA) {
    const t = trackFromMedia(p.media || {})
    // A payload carrying a title is a whole new track. One without is a
    // position tick or a partial refresh, so merge its non-null fields onto
    // what we already have instead of blanking the strip every second.
    if (t.title) {
      nowPlaying = t
    } else {
      const merged = { ...(nowPlaying || {}) }
      for (const [k, v] of Object.entries(t)) if (v !== null) merged[k] = v
      nowPlaying = merged
    }
    broadcast(socketControl, nowPlayingMsg(), { compress: false })
    return
  }

  if (p.type === MEDIA_TYPE_ALBUM_COVER) {
    const b64 = p.base64Image || ''
    if (b64.length > NOW_PLAYING_ART_MAX) {
      log('warn', 'now_playing_art_oversize', { len: b64.length })
      return
    }
    const url = b64 ? artDataUrl(b64) : null
    if (url === nowPlayingArt) return
    nowPlayingArt = url
    broadcast(socketControl, nowPlayingArtMsg(), { compress: false })
  }
}

carplay.onmessage = (ev) => {
  switch (ev.type) {
    case 'video':
      // A picture arrived, so whatever we were asking for has been answered.
      stopKeyframeKick()
      videoFrameCount++
      videoByteCount += ev.message.data.byteLength
      broadcast(socketVideo, ev.message.data, { binary: true, compress: false })
      break
    case 'audio': {
      const m = ev.message
      // Only PCM counts as a frame. The dongle also sends data-less messages to
      // announce Siri and calls, and logging those as "first frame" made it
      // look like audio was flowing when the payload was empty every time.
      if (audioFrameCount === 0 && m.data && m.data.byteLength) {
        const fmt = decodeTypeMap[m.decodeType]
        log('info', 'audio_first_frame', {
          keys: Object.keys(m),
          dataLen: m.data ? m.data.byteLength : 0,
          // Which format the dongle picked decides everything downstream: 44.1k
          // stereo is media, the mono rates are call/Siri audio.
          decodeType: m.decodeType,
          hz: fmt ? fmt.frequency : null,
          channels: fmt ? fmt.channel : null,
          meta: Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'data')),
        })
      }
      // Siri and calls announce themselves here, and in browser mode that is
      // the cue for the page to open the cabin microphone. Nothing captures
      // until the phone asks: a page holding the mic open for a whole drive is
      // both a privacy problem and a battery one.
      if (m.command === AudioCommand.AudioSiriStart || m.command === AudioCommand.AudioPhonecallStart) {
        log('info', 'audio_mic_requested', { command: m.command, decodeType: m.decodeType })
        micWanted = true
        broadcast(socketControl, JSON.stringify({ type: 'micRequest', value: true, reason: m.command }), { compress: false })
      }
      if (m.command === AudioCommand.AudioSiriStop || m.command === AudioCommand.AudioPhonecallStop) {
        log('info', 'audio_mic_released', { command: m.command })
        micWanted = false
        broadcast(socketControl, JSON.stringify({ type: 'micRequest', value: false, reason: m.command }), { compress: false })
      }
      if (m.data) {
        audioFrameCount++
        audioByteCount += m.data.byteLength
        audioTapWrite(m)
      }
      // Every audio message, not just the ones carrying PCM: the volume and
      // start/stop announcements are what drive ducking on the page.
      audioToBrowser(m)
      break
    }
    case 'media':
      handleMedia(ev.message)
      break
    case 'plugged':
      plugged = true
      broadcast(socketControl, JSON.stringify({ type: 'statusReq', data: 'plugged', phone: phoneLabel() }), { compress: false })
      log('info', 'phone_plugged', { phone: phoneLabel() })
      // Re-apply current night mode — dongle resets to config.nightMode on each
      // session, so we replay the latest client-driven value after handshake.
      if (nightMode) applyNightMode(true, 'plugged')
      // Same reasoning for audio transfer. audioTransferOn goes out once during
      // dongle init, before any phone exists; measured on this box on
      // 2026-08-21, browser mode then received audio *commands* (Siri start and
      // stop) but not one byte of PCM while music played. If the dongle clears
      // the flag per session the way it clears night mode, replaying it here is
      // what makes it stick.
      if (audioSource === 'browser') {
        try {
          carplay.dongleDriver.send(new SendCommand(config.audioTransferMode ? 'audioTransferOn' : 'audioTransferOff'))
          log('info', 'audio_transfer_replayed', { reason: 'plugged', on: config.audioTransferMode })
        } catch (err) {
          log('warn', 'audio_transfer_replay_failed', { msg: err.message })
        }
      }
      break
    case 'unplugged':
      plugged = false
      // Next phone gets its streams announced in the log again.
      audioSeenStreams.clear()
      audioStreamStats.clear()
      audioLastEventSig = null
      log('info', 'phone_unplugged', { phone: phoneLabel() })
      phoneType = null
      clearNowPlaying()
      broadcast(socketControl, JSON.stringify({ type: 'statusReq', data: 'unplugged', phone: null }), { compress: false })
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

// The idle re-enumeration described in the handlers below is a permanent
// condition, not an event: with nobody holding the dongle open it reboots on a
// ~13 s metronome and will do so forever. Logging both halves of every cycle
// cost 1208 of one 2.2 h boot's 1333 journal lines — 91% of the log — on an SD
// card whose journal had reached 282 MB.
//
// The worse cost was the 200-entry logRing the Status page reads: at ~9 lines a
// minute the whole ring turned over every ~22 minutes, so by the time anyone
// looked at the log, everything worth reading had been pushed out by USB noise.
// Count the cycles and emit one line per window instead.
const IDLE_USB_SUMMARY_MS = Number(process.env.CARPLAY_IDLE_USB_SUMMARY_MS ?? 300000)
let idleUsbCycles = 0
let idleUsbWindowAt = 0
function noteIdleUsbCycle() {
  idleUsbCycles++
  const now = Date.now()
  if (!idleUsbWindowAt) { idleUsbWindowAt = now; return }
  if (now - idleUsbWindowAt < IDLE_USB_SUMMARY_MS) return
  log('debug', 'usb_idle_cycles', {
    cycles: idleUsbCycles,
    window_s: Math.round((now - idleUsbWindowAt) / 1000),
  })
  idleUsbCycles = 0
  idleUsbWindowAt = now
}

usb.on('detach', async (device) => {
  if (device.deviceDescriptor.idVendor !== CARLINKIT_VID) return
  // A closed dongle re-enumerates on its own roughly every 13 s (measured
  // 2026-08-28 — it appears to reboot when no host has it open). With nobody
  // asking for CarPlay that is not an event, it is the idle state, and routing
  // it through restartCarplay logged a restart_begin + start_skipped pair every
  // 13 s forever. Say nothing above debug and do nothing.
  // Counted by the attach half so one cycle is one increment; say nothing here.
  if (onDemand && !demandActive()) return
  log('warn', 'usb_detach', { vid: CARLINKIT_VID })
  await sleep(DETACH_SETTLE_MS)
  restartCarplay('usb_detach')
})

// The other half of the detach handler, and the fast path back after a dongle
// brownout or a reseat: restartCarplay bails out cheaply when the bus is empty,
// so something has to notice the dongle returning. Waiting for this event beats
// polling start() at it — it fires the moment the kernel enumerates.
usb.on('attach', (device) => {
  if (!isCarlinkit(device)) return
  if (carplayStarted) return
  // Same idle re-enumeration as the detach handler above.
  if (onDemand && !demandActive()) { noteIdleUsbCycle(); return }
  log('info', 'usb_attach', { vid: CARLINKIT_VID })
  restartCarplay('usb_attach')
})

// Backstop for everything the events miss: a start that failed with the dongle
// present, a session that died without emitting 'failure', a dongle that was
// already attached when we gave up on it. Cheap — one getDeviceList() and a
// couple of booleans unless something is actually wrong.
setInterval(() => {
  if (shuttingDown || carplayStarted || restartInFlight) return
  if (onDemand && !demandActive()) return   // down on purpose, not broken
  if (!donglePresent()) return   // 'attach' will drive it; nothing to do here
  restartCarplay('watchdog')
}, WATCHDOG_MS).unref()

// config now carries node-carplay's merged defaults (incl. a large phoneConfig);
// log only the fields we tune.
log('info', 'boot', { width: config.width, height: config.height, wide_height: WIDE_HEIGHT, aspect: config.aspect, fps: config.fps, dpi: config.dpi, hand: config.hand })
if (onDemand) {
  log('info', 'carplay_on_demand', { idle_stop_ms: IDLE_STOP_MS, demand_ttl_ms: DEMAND_TTL_MS, ghost_lease_ms: GHOST_LEASE_MS })
  // Nothing to notice a heartbeat that simply stopped arriving. Edge-triggered
  // inside syncDemand, so this is two booleans and a set walk when idle.
  setInterval(() => syncDemand('ttl'), DEMAND_SWEEP_MS).unref()
}
// Under on-demand this is a deliberate no-op: runRestart's demand guard turns
// it into a log line, and the first visible page is what actually starts the
// dongle. Left in place so CARPLAY_ON_DEMAND=off still boots straight into a
// session.
restartCarplay('boot')

const AUTOCONNECT_POKE_MS = 15000
setInterval(() => pokeAutoconnect('tick'), AUTOCONNECT_POKE_MS).unref()

// Hard deadline for a clean exit. systemd's TimeoutStopSec is 90s; nothing here
// should ever need more than a couple of seconds, and overrunning it means a
// SIGKILL plus a 90s black screen in the car on every restart.
const SHUTDOWN_DEADLINE_MS = 2000

const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'shutdown')
  // unref'd so it never keeps the process alive on its own, but it still fires
  // while we ARE alive — a backstop if teardown wedges on a USB or WS handle.
  setTimeout(() => {
    log('warn', 'shutdown_forced', { after_ms: SHUTDOWN_DEADLINE_MS })
    process.exit(0)
  }, SHUTDOWN_DEADLINE_MS).unref()

  // Hand the phone back before the handle goes. Without this every deploy and
  // every `systemctl restart` left the phone sitting on the dongle's AP with
  // nothing behind it — the exact state this whole feature exists to avoid.
  // Fire-and-forget: the shutdown deadline is 2 s and this must not eat it.
  if (carplayStarted) {
    try { carplay.dongleDriver.send(new SendDisconnectPhone()) } catch {}
  }
  try { await carplay.stop() } catch {}
  try { await retroarch.stop('shutdown') } catch {}
  try { await karaoke.stop('shutdown') } catch {}

  // http.Server#close() only stops NEW connections — it waits for open ones to
  // end, and a WebSocket never ends on its own. With a single /control client
  // attached (the SPA is always one), the close callback never ran and we sat
  // here until systemd lost patience. Drop the sockets explicitly.
  for (const wss of [socketVideo, socketControl]) {
    for (const ws of wss.clients) { try { ws.terminate() } catch {} }
  }
  httpServer.closeAllConnections?.()
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
