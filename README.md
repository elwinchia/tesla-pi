# myTesla — Pi 4 Tesla CarPlay box

A self-contained CarPlay-in-the-Tesla-browser appliance. Hardware is a Raspberry Pi 4 with a Carlinkit CPC200-CCPA wireless dongle; software is this repo. (The project originally ran on a Pi Zero 2 W — historical docs reference it.) The Pi is its own Wi-Fi AP, terminates TLS on a shared project domain, and the Tesla Highland browser loads a single HTTPS page that streams CarPlay video over WebSocket and forwards touches.

**You don't need a domain of your own.** Every device serves the fixed hostname `device.mytesla.humblebees.co`, which `dnsmasq` resolves locally to the Pi in the car. Certificates are issued centrally and the device pulls them — no Cloudflare account, no certbot, no DNS credential on the box. See [`docs/turnkey-shared-domain-plan.md`](docs/turnkey-shared-domain-plan.md).

This is a fork of [marcraft2/tesla-carplay](https://github.com/marcraft2/tesla-carplay) — itself built on [rhysmorgan134/node-carplay](https://github.com/rhysmorgan134/node-CarPlay). Most of the hard CarPlay-protocol work belongs to those two projects; this fork is the in-car deployment around them.

## What this fork adds over upstream

**Networking / deployment**
- AP-mode networking with `hostapd` + `dnsmasq` + `iptables` (the Pi *is* the SSID the Tesla joins)
- `nginx` TLS termination on the shared project domain (Let's Encrypt, issued in CI)
- Captive-portal shim so Tesla doesn't drop the SSID after a few seconds
- Auto cert-sync: when the Pi sits idle indoors for ≥10 min it flips to home Wi-Fi, pulls the current certificate from the project's cert service, and restores the AP — see `scripts/cert-renew-watch.sh` and `scripts/cert-sync.sh`. The device carries no DNS credential.
- `dev-mode.sh` / `ap-mode.sh` for switching between bench-debugging and in-car modes

**Runtime / reliability**
- Runs as a systemd service with `WatchdogSec=30` and `Restart=always`
- Auto-recovery from CarLinkit USB unplug/replug via `usb` library `detach` events
- Bounded restart loop: after 20 consecutive failed `start()` attempts the process exits and lets systemd respawn it
- WebSocket keepalive (ping/pong every 30 s) so half-open Tesla-browser connections don't keep the broadcast pipe wedged

**UI / UX**
- Status overlay in the page (CarPlay state, WS state, uptime, CPU temp, mem, load, cert days, structured log tail) — visible until the first video frame, restored on disconnect/unplug
- Cert-expiry warning banner (≤10 days remaining)
- Night mode mirrored from `prefers-color-scheme` — the Tesla browser flips with the car's day/night theme; we forward that to the dongle via `enableNightMode`/`disableNightMode`
- Touch coalescing — drag events collapse to one WS send per `requestAnimationFrame`, instead of 60+/sec saturating the WS/JSON path
- WebGL canvas decoder running in a worker (offscreen canvas)
- iOS-style squircle corner clip on the canvas (CSS `border-radius` doesn't match)

**Android apps (optional addon)**
- Waydroid (Android 13 + GAPPS) running headless on the Pi, streamed into the same browser SPA over WebSocket H.264 — launcher tile, touch forwarding, Back/Home/Recents bar
- Off by default, started on demand from the launcher; zero impact on boot time or CarPlay when stopped — see `docs/android-addon.md`

**Observability**
- `GET /healthz` — JSON: `{ carplay, uptime_s, video_clients, control_clients, cert_days_remaining, hostname, cpu_temp_c, mem_used_mb, mem_total_mb, load_avg }`
- `GET /logs` — last 200 structured log entries (in-memory ring)
- All server-side logs are single-line JSON for easy `journalctl | jq` filtering
- `LOG_TOUCH=1` for per-touch debug logging; `LOG_FPS=1` for per-second video bitrate

## Architecture (one paragraph)

`node-carplay` decodes the CarLinkit USB protocol; the Node server in `index.js` rebroadcasts the H.264 stream over `/video` (binary WS) and accepts touches + status messages over `/control` (JSON WS). `nginx` terminates TLS on `:443` and reverse-proxies to `:8080`. `hostapd` runs the AP (`TeslaCP` by default, channel 36, country MY); `dnsmasq` serves DHCP + a wildcard DNS A record so any hostname resolves locally; `iptables` DNATs the captive-probe IP to the Pi. **No upstream internet** — the iPhone carries cellular for CarPlay backend traffic, the Tesla carries its own LTE for everything else. See `docs/plan.md` for the full design rationale and `docs/setup-guide.md` for the deploy recipe.

## Security model

**All HTTP/WebSocket endpoints are unauthenticated by design** — the trust
boundary is the WPA2 password of the in-car AP. Do **not** expose this box to
the internet. Read **[`SECURITY.md`](SECURITY.md)** before deploying.

## Quick start

**Prerequisites:** Node ≥ 20 and the native USB build deps (`libusb-1.0-0-dev`,
plus `build-essential` / `python3` for `node-gyp`). Then `npm ci`.

> The systemd units ship with `__MYTESLA_USER__` / `__MYTESLA_DIR__`
> placeholders. The addon installers substitute them automatically; for the main
> `systemd/mytesla.service` fill them in first, e.g.
> `sudo sed -i "s|__MYTESLA_USER__|$USER|; s|__MYTESLA_DIR__|$PWD|" systemd/mytesla.service`.

Full step-by-step (DietPi flash → AP up → Tesla validation) lives in **[`docs/setup-guide.md`](docs/setup-guide.md)**. The short version once you've followed it:

```bash
sudo systemctl start mytesla
sudo systemctl status mytesla
sudo journalctl -u mytesla -f       # follow structured JSON logs
curl -k https://localhost/healthz   # JSON health
```

To bench-debug without the AP / TLS stack:

```bash
sudo scripts/dev-mode.sh            # joins home Wi-Fi, leaves AP down
node index.js                       # http://<pi-lan-ip>:8080
sudo scripts/ap-mode.sh             # back to in-car mode
```

## Repo layout

```
index.js                 Node server: HTTP + WS + node-carplay + USB recovery
android-bridge.js        Optional Waydroid addon: cage capture → WS mux + lifecycle
retroarch-bridge.js      Optional native RetroArch addon: video + audio + gamepad
static/                  Browser client (HTML + WebGL worker)
conf/                    hostapd, dnsmasq, nginx, iptables, env templates
systemd/                 mytesla.service, cert-renew-watch.service, wlan0-ap-up.service
scripts/                 ap-mode.sh, dev-mode.sh, cert-renew-watch.sh, cert-sync.sh
infra/cert-service/      Cloudflare Worker + R2 that serves the shared certificate
.github/workflows/       renew-cert.yml — central cert issuance (holds the DNS token)
docs/                    plan, setup, perf tuning, troubleshooting
```

## Configuration knobs

`/etc/default/mytesla` (from `conf/mytesla.env.template`) — **mode 0600**, it holds a token:
- `CARPLAY_DOMAIN` — the hostname nginx serves (default `device.mytesla.humblebees.co`)
- `CERT_PATH` — certificate path for `cert_days_remaining` reporting
- `CERT_SYNC_URL` / `CERT_SYNC_TOKEN` — cert service endpoint + bearer token
- `CERT_SYNC_BACKOFF_S` — min seconds between AP-down sync attempts (default 6 h)
- `LOG_TOUCH=1` — per-touch debug logs
- `LOG_FPS=1` — per-second video bitrate logs

CarPlay config (in `index.js`): defaults to 1920×1496 @ 60fps, DPI 160, `boxName=nodePlay`, audio transfer mode on. Audio still rides Bluetooth from iPhone → Tesla speakers (the Pi is not in the audio path).

## What still doesn't work (inherited from upstream)

- Siri
- Call audio + microphone
- Steering-wheel control (AVRCP)

## Limitations you should know before building one

- **The box is not offline-forever.** Its TLS certificate expires (~90 days). Day-to-day
  in-car use needs no internet, but the Pi has to see home Wi-Fi occasionally to pull a
  fresh certificate, or the Tesla browser will eventually refuse the page. The UI warns
  in advance.
- **The certificate and its key are shared** across all devices using the project domain.
  Each Pi is an isolated single-client AP, which bounds the exposure, but it is a
  deliberate trade — see [`SECURITY.md`](SECURITY.md) and the design doc.
- **No authentication.** See the security model below.

## Hardware

- Raspberry Pi 4 (4 GB; 5 GHz AP capable)
- Carlinkit CPC200-CCPA (USB ID `1314:152*`)
- 12 V → 5 V/3 A buck regulator (in-car)
- iPhone with iOS 16+

A turnkey alternative exists if you'd rather not solder anything: **Carlinkit's own Tesla module** (~$60). This project is only worth building if you already have a Pi and dongle on the shelf, or if you want full control of the box (custom domain, observability, your own renewal cadence).

## Credits

- [rhysmorgan134/node-carplay](https://github.com/rhysmorgan134/node-CarPlay) — the CarPlay USB protocol decoder this is built on
- [marcraft2/tesla-carplay](https://github.com/marcraft2/tesla-carplay) — the Pi-in-a-Tesla idea, original web client, original systemd packaging
- [darreal44](https://github.com/darreal44) — canvas-based render path (replaced jmuxer in upstream v0.4)

## License

BSD 3-Clause — see [`LICENSE`](LICENSE). Retains the upstream copyright
(Marc Dubois, 2022) alongside this fork's.
