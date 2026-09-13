# Phase 1 — Bench POC: setup notes & learnings

> **Historical** — measurements taken on the Pi Zero 2 W; current hardware is a Pi 4. See `README.md` for current state.

Status: **Phase 1 complete.** All validation gates green on bench (Pi Zero 2 W ↔ laptop Chrome, no Tesla yet).

---

## Current setup

### Hardware

- **Pi Zero 2 W**, powered via PWR micro-USB, networked over home Wi-Fi.
- **CarLinkit dongle** (USB ID `1314:1521`, "Magic Communication Tec. Auto Box", `bcdDevice=4.09`) plugged into the inner micro-USB (data) port via a micro-USB → USB-A OTG cable. Direct, no powered hub yet.
- **iPhone** wirelessly paired to the dongle (carried over from prior Tesla-Android setup, no re-pairing needed when the dongle moved hosts).

### OS / runtime

- **DietPi** on Debian 13 (trixie), kernel `6.12.75+rpt-rpi-v8`, aarch64.
- **Node 20.19.2** + npm 9.2.0, installed via Debian apt (`apt install nodejs npm`). NodeSource was attempted but DNS resolution to `deb.nodesource.com` failed at the time; Debian's packaged Node 20 LTS turned out to match the plan's recommendation, so no follow-up was needed.
- Hostname `tesla-pi`, accessed at `<pi-lan-ip>` over LAN SSH with key auth.

### Installed apt packages (relevant)

- `git`, `build-essential`, `python3`, `pkg-config` (for `node-gyp`)
- `libusb-1.0-0-dev`, `libudev-dev` (native deps for `usb` / `node-microphone`)
- `nodejs`, `npm`

### udev rule

`/etc/udev/rules.d/52-nodecarplay.rules`:

```
SUBSYSTEM=="usb", ATTR{idVendor}=="1314", MODE="0660", GROUP="plugdev"
```

`dietpi` user added to `plugdev` (gid 46). Vendor-only match (no `idProduct` glob — udev `ATTR{}` does not support globs).

### Application

Repo: `~/tesla-pi/` on the Pi. Forked from `marcraft2/tesla-pi` and rewritten against `node-carplay@4.x`.

- `package.json` — ESM (`"type": "module"`), Node ≥20. Deps: `node-carplay@^4.1.0`, `ws@^8.18.0`. **`bluez` removed** (see *Audio routing* below).
- `index.js` — full ESM rewrite using `CarplayNode` v4 API (`onmessage` event sink + `sendTouch({type, x, y})`); also serves `static/` over plain HTTP and proxies WS upgrades for both `/control`+`/video` and `/ws/control`+`/ws/video` (the latter for the original nginx-fronted layout, kept for forward compatibility).
- `static/index.html` — patched: WebSocket URL auto-picks `ws://` vs `wss://` from `window.location.protocol`; `getPosition()` divides by `getBoundingClientRect().width/height` (was using stale globals); canvas CSS locks `aspect-ratio: 900 / 685` so display geometry matches CarPlay coordinate space.

### Configuration in `index.js`

```js
const config = {
  width: 900, height: 685, fps: 30, dpi: 100,
  nightMode: false, hand: 0, boxName: 'nodePlay', mediaDelay: 300,
}
```

`CarplayNode` ships `DEFAULT_CONFIG` for everything else (codec format, packet sizes, etc.). Touch coordinates are floats `0..1`; `node-carplay` clamps and multiplies to the dongle's 0..10000 protocol scale internally.

### Run

```bash
cd ~/tesla-pi && npm start          # foreground
# Browser: http://<pi-lan-ip>:8080/
```

No systemd unit yet. Started by hand each session. No auto-restart.

### Browser (laptop) requirement

The static frontend uses **WebCodecs (`VideoDecoder`)** in a Worker. WebCodecs is only available in **secure contexts**. `localhost` is exempt; LAN IPs are not. For bench testing the Chrome flag `chrome://flags/#unsafely-treat-insecure-origin-as-secure` was set to allowlist `http://<pi-lan-ip>:8080`. **For the Tesla in-car browser this won't work** — Phase 3 will need real TLS (self-signed + manual trust on Tesla, or a local CA — to be designed).

---

## Validation gates achieved (Phase 1)

| Gate | Result |
|---|---|
| CarLinkit USB enumerates | ✅ `1314:1521` |
| `node-carplay` connects without errors | ✅ (after retry, see below) |
| iPhone pairs (BT + Wi-Fi handshake) | ✅ |
| Video stream visible in laptop Chrome | ✅ |
| Single-finger click forwards to iPhone | ✅ |
| CPU on Pi Zero 2 W <30% steady state | ✅ ~0%, load avg 0.10 |
| Thermal | ✅ 44 °C idle (no fan) |
| Memory | ✅ 113 MB / 463 MB used |

---

## Learnings

### CarLinkit dongle has a 12 s self-reset watchdog

Even with no driver running on the host, `dmesg` shows the dongle disconnecting and re-enumerating on `dwc_otg` every ~11–15 s. This is the dongle's own firmware watchdog: if the host driver does not complete the full open handshake (Open → BoxSettings → SendOpen heartbeat) within ~12 s, it hard-resets itself.

On Pi Zero 2 W, Node + ESM cold start + `usb.reset()` inside `node-carplay`'s `initialise()` consumes 3–5 s of that window. About 1 in 5 attempts wins the race; otherwise libusb returns `LIBUSB_ERROR_NOT_FOUND` from `reset()` (because the device disconnected mid-init).

**Workaround in place**: `index.js` wraps `carplay.start()` in an unbounded retry loop with 3 s backoff. Empirically lands by attempt 3–5 (~10–15 s extra at boot).

**Firmware status (2026-05-04)**: confirmed running the latest CarLinkit firmware. The 12 s self-reset cycle is the dongle's protocol-watchdog behaviour even on current firmware, not pre-Sept-2022 flakiness. The retry loop is therefore the permanent answer, not a workaround. To shave the boot penalty further, the only remaining lever is a `node-carplay`-side fix to win the watchdog race more reliably (e.g. preserve the open USB handle across `start()` retries, or send the `Open → BoxSettings → SendOpen` sequence faster).

The dongle does NOT brown out — `dmesg` shows no `over-current`/`under-voltage` events, and no powered hub is needed for bench. The cycling is purely the dongle's protocol watchdog.

### `node-carplay@2.x` (the upstream fork's pin) is dead on modern Node

`tesla-pi` (marcraft2 fork) pinned `node-carplay@^2.0.9` and a transitive `usb@1.7.2`. The latter does not compile against any Node ≥18 V8 headers — `std::string_view` and `Template::Set` API drift. Confirmed by hitting it on Node 25 *and* the build chain stayed broken until we bumped to `node-carplay@4.1.0`.

The plan's "alternative path" (mine the handler from `react-carplay`) was avoided — the v4 API is clean enough that a direct rewrite of `marcraft2`'s `index.js` against `CarplayNode` was ~130 lines and worked the same evening. Approximate cost: 30 minutes once the API was understood (vs the plan's 4–8 h budget).

### `node-carplay@4` API is ESM-only and small

```js
import CarplayNode from 'node-carplay/node'
const carplay = new CarplayNode(partialDongleConfig)
carplay.onmessage = (ev) => { /* type: 'video'|'audio'|'plugged'|'unplugged'|'failure'|'media'|'command' */ }
await carplay.start()
carplay.sendTouch({ type: 14|15|16, x: 0..1, y: 0..1 })  // 14=Down, 15=Move, 16=Up
carplay.sendKey(commandValue)
await carplay.stop()
```

Forced our `package.json` to `"type": "module"` and `index.js` to ESM imports. No CommonJS shim used.

### `node-carplay@4` does not auto-recover from mid-stream USB disconnect

When the dongle drops mid-session, `DongleDriver.readLoop` keeps issuing transfers against a dead handle and the process spams `LIBUSB_ERROR_NO_DEVICE` indefinitely. The retry loop only covers initial `start()`; it does not catch this state. **Will need explicit detect-disconnect → tear-down → re-`start()` logic** for Phase 2 resilience. (Possibly via subscribing to `usb` library `detach` events on the open device.)

### Tesla-Android frontend assumed nginx + TLS

The static frontend was hardcoded to `wss://` and `/ws/...` paths because the original deployment had nginx in front (Letsencrypt cert for the dongle's `carplay.ml` domain, terminating TLS and rewriting `/ws/*` → `:8080/`). For the bench POC, the frontend was patched to:

- Pick `ws://` or `wss://` from `window.location.protocol` (so same code works with or without nginx).
- The Node server accepts both `/control` and `/ws/control` (and same for `/video`) so either reverse-proxied or direct works.

For the Tesla browser path, nginx + TLS will need to come back in Phase 3 — different cert strategy though, since `letsencrypt` won't work on a private LAN with no public DNS.

### Audio routing is dongle-side, Pi never touches audio

Confirmed: setting the CarLinkit to "phone audio / phone mic" mode in its own NV (carry-over from prior Tesla-Android setup) means audio routes from CarPlay → iPhone → existing iPhone↔Tesla Bluetooth pairing. No host-side audio. **Cuts a full weekend of Phase 2 work** (BlueZ A2DP source pairing) and removes the highest-uncertainty risk in the project (Pi Wi-Fi + BT antenna contention).

`bluez` and `bluetooth-socket` deps were dropped from `package.json`. The original fork's `index.js` had a Bluetooth-gate that delayed `_INIT_SERVER()` until a BT device connected — that was deleted; server now starts CarPlay unconditionally.

### Frontend bugs found and fixed

1. **`getPosition()` was dividing by stale globals.** `width` / `height` were captured at page load (`window.innerWidth` and a hardcoded aspect derived from `carplayWidth/Height = 900/685`), but the canvas can be CSS-sized to anything else, so visible click positions normalized to wrong values — sometimes producing `y > 1.0` (out-of-range, clamped to bottom edge by `node-carplay`).
   - Fix: divide by `c.width` / `c.height` from `getBoundingClientRect()`.
2. **Canvas display didn't preserve CarPlay aspect ratio.** With `width: 100%` and no height constraint, the canvas's CSS height defaulted to its intrinsic resolution (set by the worker per video frame), causing horizontal stretch when window aspect didn't match CarPlay's 900:685.
   - Fix: `canvas { aspect-ratio: 900 / 685; max-width: 100vw; max-height: 100vh; display: block; margin: 0 auto; }` — letterbox/pillarbox instead of stretch.

### Boot/run quality observations

- CPU sit at <1% on a Pi Zero 2 W during a live CarPlay video session at 900×685@30fps — the H.264 frames are forwarded as opaque bytes; no decode happens on the Pi. All decode is in the browser via WebCodecs.
- Idle thermal 44 °C, no thermal headroom concerns at room temp on bench. In-car hot-day test still TBD (Phase 4).
- `vcgencmd` is not installed by default on this DietPi image; thermals were read from `/sys/class/thermal/thermal_zone0/temp` instead.

---

## Open items / TODO before Phase 4 in-car install

1. ~~**Update CarLinkit firmware** to eliminate the 12 s self-reset cycle.~~ *(2026-05-04: confirmed already on latest firmware. The self-reset is inherent to current firmware, not a fixable bug.)*
2. Detect-disconnect → reconnect loop in `index.js` (replaces today's spam-and-die failure mode).
3. systemd unit for auto-start.
4. TLS strategy for the Tesla browser (no laptop Chrome flag available there).
5. Phase 3: hostapd + dnsmasq for Tesla's Wi-Fi association; phone tether for upstream internet.
