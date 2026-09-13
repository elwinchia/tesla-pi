# Performance optimizations

Tracks performance work for the Pi → Tesla browser stream and the Pi's boot-to-ready time. Two sections: what's already been applied locally (commit-and-deploy), and what's pending action on the Pi itself. (Measurements below were taken on the original Pi Zero 2 W unless noted; current hardware is a Pi 4, which has more headroom.)

---

## Applied (in this repo)

### 1. Disable WebSocket per-message-deflate
**Where:** `tesla-pi/index.js` (WebSocketServer constructors + `broadcast` callsites)

H.264 NAL units are already entropy-coded; running them through deflate burns Pi CPU at 30 fps for near-zero size gain. Both servers now construct with `perMessageDeflate: false`, and `broadcast()` forwards `{ binary: true, compress: false }` for video frames and `{ compress: false }` for control JSON.

### 2. VideoDecoder low-latency hints
**Where:** `tesla-pi/static/worker.js`

Added `hardwareAcceleration: "prefer-hardware"` and `optimizeForLatency: true` to the `VideoDecoder` config. `optimizeForLatency` tells the decoder to minimise the number of `EncodedVideoChunks` it buffers before emitting a `VideoFrame` — right behaviour for a live stream where each chunk is a complete slice.

**Verify after deploy:** open `chrome://media-internals` in the Tesla browser if accessible; confirm the H.264 path lands on a hardware decoder. If `prefer-hardware` regresses (some pipelines batch hardware frames and add latency), drop it and keep just `optimizeForLatency`.

### 3. OffscreenCanvas postMessage dedup + zero-copy frame transfer
**Where:** `tesla-pi/static/index.html` (video `onMessage`)

Previously the page transferred the (already-detached) `canvas` reference and allocated a fresh empty `ArrayBuffer` every frame — dead/cargo-cult code, GC pressure at 30 fps. Now the OffscreenCanvas is transferred only on the first frame; subsequent frames send only `{data}` and zero-copy transfer the underlying H.264 ArrayBuffer to the worker.

### 4. Drop `network-online.target` from `tesla-pi.service`
**Where:** `tesla-pi/systemd/tesla-pi.service`

CarPlay needs zero internet (only the USB dongle). The old `After=network-online.target` made the unit wait for `NetworkManager-wait-online`, which on a cold boot with eth0 unplugged times out at ~30 s. Replaced with `After=network.target`. **Likely the single biggest boot-time win.**

### 5. Skip no-op `stop()` on first start
**Where:** `tesla-pi/index.js` (`restartCarplay`)

`restartCarplay('boot')` previously awaited `carplay.stop()` before the first `start()`, even though nothing was running. Now gated on `wasStarted`. Small (a few hundred ms) but free.

### 6. Faster start retry interval
**Where:** `tesla-pi/index.js`

`START_RETRY_MS` 3000 → 1000. If the first `carplay.start()` loses a race with USB enumeration, we now retry in 1 s instead of 3 s.

### 7. systemd watchdog
**Where:** `tesla-pi/systemd/tesla-pi.service` + `tesla-pi/index.js`

Unit now uses `Type=notify`, `NotifyAccess=all`, `WatchdogSec=30s`. `index.js` calls `systemd-notify --ready` after `httpServer.listen`, and pings `WATCHDOG=1` every 10 s. If the event loop stalls (USB transfer hang, infinite loop, GC pause >30 s), systemd kills the process and `Restart=always` re-spawns it. Catches the "node alive but not making progress" failure mode that crash-restart alone misses.

`NotifyAccess=all` is required because `systemd-notify` runs as a child process — the default `main` would reject those notifications. No-op when launched outside systemd (`NOTIFY_SOCKET` unset).

### 8. Touch-event coalescing
**Where:** `tesla-pi/static/index.html`

`mousemove`/`touchmove` previously fired one WS message per event — Tesla's touchscreen can deliver 60+/s on a drag, all going through `JSON.stringify` + WS write + Pi-side parse + `carplay.sendTouch`. Now buffered into a single message per `requestAnimationFrame` (~30 fps cap). Click and release stay immediate. ~2-3x reduction in touch WS traffic.

### 9. Cache-Control on static JS
**Where:** `tesla-pi/conf/nginx-carplay.conf`

Added `Cache-Control: public, max-age=86400, must-revalidate` for `worker.js` and `renderer_webgl.js` so the Tesla browser doesn't re-fetch them on every refresh. ETag still gates revalidation, so a deploy invalidates correctly.

### 10. Removed dead renderer code
**Where:** `tesla-pi/static/`

Deleted unused `renderer_2d.js` and `renderer_webgpu.js`. `worker.js` now imports only `renderer_webgl.js` and instantiates `WebGLRenderer` directly. Smaller worker bundle, fewer requests, less to maintain.

### 11. WebSocket keepalive ping/pong
**Where:** `tesla-pi/index.js`

Both WS servers now ping clients every 30 s and `terminate()` any client that misses a pong. Previously a half-open TCP (Tesla browser suspended, FIN/RST not yet delivered) left the client in `server.clients` and `broadcast()` kept pushing video frames into the void. Now those clients drop within ~30 s.

---

## Canvas border-radius (cosmetic)
**Where:** `tesla-pi/static/index.html`

Added `border-radius: 28px` to the `<canvas>` to clip the black corner wedges baked into iOS's CarPlay frames (rounded UI shape, see WWDC23 *Optimize CarPlay for vehicle systems*). Single tunable value — adjust if wedges still poke through (increase) or the iOS UI gets clipped (decrease).

Not a perf change but bundled here because it lives next to the worker pipeline.

---

## Pending — to do on the Pi

These need shell access to the Pi. Only **§1 (Deploy)** is required to activate the changes; the rest are optional measurement / further tuning.

### 1. Deploy (REQUIRED) — ~5 min

Activates items 1–11 above. Without this step the Pi is still running the old code.

```bash
# 1. Pull the new code
cd ~/tesla-pi
git pull

# 2. Reload systemd (unit file changed: After=, Type=notify, WatchdogSec)
sudo systemctl daemon-reload
sudo systemctl restart tesla-pi

# 3. Reload nginx (cache headers added)
sudo nginx -t && sudo systemctl reload nginx
```

**Verify:**

```bash
# Should be Active: active (running) with a "Watchdog: 30s" line
systemctl status tesla-pi

# Should see http_listen, then carplay_started, no notify/watchdog errors
sudo journalctl -u tesla-pi -b 0 | tail -30

# Cache headers actually served? Expect: Cache-Control: public, max-age=86400, must-revalidate
curl -kI https://localhost/worker.js | grep -i cache-control
```

If `systemctl status` shows the unit failed with a notify-related error (`systemd-notify` not on PATH for the service user), revert the unit to `Type=simple` and remove `WatchdogSec=` — the rest of the changes still work without the watchdog.

### 2. Measure where boot time actually goes (optional)
```bash
systemd-analyze
systemd-analyze blame | head -20
systemd-analyze critical-chain
sudo systemd-analyze critical-chain tesla-pi.service
journalctl -u tesla-pi -b 0 -o short-monotonic | grep -E "Started|http_listen|carplay_started"
```

Look for: long `NetworkManager-wait-online`, slow `dhcpcd`/`ifup@*` jobs, anything > 1 s in `blame`.

### 3. Prune services not needed on a CarPlay box (optional, ~1-3 s saved)
Each is independently safe; review before running.

```bash
sudo systemctl disable --now bluetooth hciuart ModemManager triggerhappy
```

- `bluetooth`, `hciuart` — no Bluetooth in this stack (Pi doesn't carry audio).
- `ModemManager` — manages cellular modems; we don't have one.
- `triggerhappy` — handles GPIO buttons; not used.

**Do NOT disable `avahi-daemon` blindly** — it provides mDNS / `.local` resolution. Disabling kills `ssh <user>@<host>.local` on your Mac. Raw-IP SSH (`<pi-lan-ip>`, `192.168.4.254`) is unaffected. Skip if you rely on `.local`.

### 4. Read-only rootfs (optional, reliability)
Cars are ungraceful-power-off machines; SD corruption *will* eventually bite. DietPi exposes overlayfs in `dietpi-config` → Tools → Overlay-FS. Once enabled the rootfs is read-only and writes go to RAM (lost on reboot).

```bash
sudo dietpi-config       # Tools → Overlay-FS → enable, reboot
```

**Before enabling:** decide what genuinely needs to persist and bind-mount it as writable:
- `/etc/letsencrypt` — TLS material; must persist across renewals.
- `/var/log/journal` — if you want logs to survive reboot (otherwise journald is RAM-only).
- The repo working dir — if `git pull` is part of your update path.

DietPi's overlayfs UI takes a `RW_DIRS=` list. Add the above explicitly. Toggle off via the same menu when you need to apply system updates.

### 5. Static IP on eth0 (optional, nice-to-have)
DHCP probe on eth0 takes 5–15 s on cold boot when nothing is plugged in. A static lease on the home router covers normal cases; switching to a static address on the Pi side eliminates the probe entirely. Only worth doing if `systemd-analyze blame` shows DHCP time as a real cost.

### 6. Tune `mediaDelay` (optional, A/V sync feel)
**Where:** `tesla-pi/index.js` `config.mediaDelay`

Currently 300 ms (the dongle's audio output delay). On a Pi Zero 2 W with the WebGL render path adding ~1 frame (~33 ms) plus WS buffering, lowering toward 100–200 ms is reasonable for tighter A/V sync. **Tune in 100 ms steps and listen for audio dropouts/lip-sync drift; revert if either appears.**

### 7. Confirm WebCodecs hardware path on Tesla browser (optional, recommended after deploy)
After deploy, open the Tesla browser dev tools (if exposed) or `chrome://media-internals` and confirm:
- VideoDecoder reports a hardware decoder (e.g. `D3D11VideoDecoder` / `MediaFoundationVideoDecoder` / `V4L2VideoDecoder` — depends on the Tesla MCU's Chromium build).
- No `optimizeForLatency` warning.
If hardware path is unavailable, drop `hardwareAcceleration: "prefer-hardware"` to let Chromium pick (`"no-preference"` default) — sometimes faster on weird builds than forcing hardware.

---

## Speculative / not yet planned

- **Frame-pacing rework in `worker.js`** — current `timestamp = frameCount * frameDuration` derivation drifts from real arrival time. Only worth touching if visible judder appears.
- **Node startup snapshot** (`node --experimental-snapshot`) — could shave the ~4 s ESM module load on the Pi Zero 2 W. Gnarly; defer until everything else is done.
- **Auto-update from home Wi-Fi** — piggyback on `cert-renew-watch`'s "Pi is indoors" detection: while joined to home Wi-Fi, do `git fetch && git diff --quiet HEAD origin/main || (git pull && systemctl restart tesla-pi)`. Saves the manual ssh+pull cycle.
- **Touch endpoint hardening** — `/control` accepts unauthenticated touch events from anyone on the AP. Low practical risk (the AP password gates entry); a one-shared-secret check is ~10 lines if you ever share the SSID.

---

## Reference: what was *not* changed and why

- **CarPlay resolution `1920×1496`** — Tesla profile, gives the most usable layout. Lowering would speed decode but hurt UX.
- **`hand`, `dpi`, `nightMode`, `phoneWorkMode`** — verified (see Apple WWDC23) that none of these change the rounded-corner artifact at the source. Cosmetic-only fix lives in CSS.

## fps bumped 30 → 60 (2026-05-05)

**Where:** `tesla-pi/index.js` `config.fps` and `tesla-pi/static/worker.js` `const fps`.

Tesla Highland's center display vsyncs at 60 Hz; the Tesla browser (Chromium) caps render at 60 Hz. Earlier note that "iOS won't honour higher than 30 over the Carlinkit protocol" was Pi-Zero-2-W-era folklore — **disproved** on Pi 4 + current iOS + CPC200-CCPA. Source-side frame counter measured 26–61 fps with peaks at 58–61 (variable-rate; iOS drops encoded frames when content is static, which is normal H.264 VFR). Bandwidth 5–14 Mbps on the static CarPlay home screen at 1920×1496 — comfortable on home Wi-Fi and trivial on the in-car single-client AP.

**Diagnostic:** `index.js` exposes a 1 Hz video frame/byte counter gated on `LOG_FPS=1`. Set it in `/etc/default/tesla-pi` (`LOG_FPS=1`) and `journalctl -u tesla-pi -f | grep video_rate` to re-measure if anything changes (different iOS version, new dongle firmware, lower-power Pi).
