# Tesla-Pi

A self-contained Raspberry Pi appliance that turns the Tesla in-car browser into a screen for **Apple CarPlay** and **RetroArch retro gaming** — no head unit hacking, no aftermarket screen. Plug a Pi 4 into the car, join its Wi-Fi AP, and the Tesla's own browser does the rest.

**Landing page:** <https://elwinchia.github.io/tesla-pi/> — source in [`site/`](site/), published by [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

Hardware is a Raspberry Pi 4 with a Carlinkit CPC200-CCPA wireless dongle. The Pi runs its own Wi-Fi AP, terminates TLS on a shared project domain, and the Tesla Highland browser loads a single HTTPS page that streams video over WebSocket and forwards touches back to the Pi.

## Features

### CarPlay
- Wireless Apple CarPlay streamed into the Tesla browser over WebSocket (WebGL canvas decoder, offscreen worker) — 1920×1496 @ 60fps by default
- Touch forwarding, with drag events coalesced to one send per `requestAnimationFrame` so the control channel doesn't choke
- Night mode mirrors the Tesla browser's `prefers-color-scheme`, forwarded to the dongle so CarPlay flips with the car's day/night theme
- Status overlay (CarPlay state, WS state, uptime, CPU temp, mem, load, cert days, log tail) shown until the first video frame and restored on disconnect
- Now-playing strip (cover art, track, artist, position) with prev / play-pause / next, shown in the CarPlay dock and on the launcher — the dongle reports what the phone is playing, so the screen still says so once you leave the CarPlay route
- Auto-recovery from CarLinkit USB unplug/replug; runs as a systemd service with a watchdog and bounded restart loop
- **On demand, so your phone keeps its own Wi-Fi.** The adapter has its own 5 GHz AP and a paired iPhone joins it the moment it is in range — which drops the phone off home Wi-Fi and keeps its radios awake for as long as the Pi has power, even parked on the drive with nobody in the car. The dongle is therefore kept closed until a page is open *and* on screen in the car, and is handed back about a minute after you leave it. Settings → CarPlay turns it off if you would rather the phone connect as you walk up

**Siri, call audio, and the microphone work** — but only through the car, not through the Pi. As long as the Tesla's Bluetooth audio is paired to the iPhone (the same phone running CarPlay), calls, Siri, and mic audio ride that Bluetooth link exactly as they would with CarPlay on any other head unit. The Pi is never in the audio path.

**Steering-wheel controls are not supported.** The Tesla's scroll wheels/buttons have no path back to CarPlay through this setup.

See [`docs/carplay-on-demand.md`](docs/carplay-on-demand.md) for how the adapter
is opened and handed back, and what it costs you in time-to-picture.

### RetroArch
- Native RetroArch session (running directly on the Pi, not inside an emulated container) streamed to the Tesla browser over the same H.264-over-WebSocket pipeline as CarPlay
- On-screen touch pad (D-pad, A/B/X/Y, L/R, Select/Start) or pair a Bluetooth controller directly to the Pi for proper analog feel
- Real audio, not silence — RetroArch's output is captured via an ALSA loopback and streamed to the browser as PCM, played through the car speakers via Web Audio
- Off by default: nothing runs at boot, CarPlay never depends on it, and the session starts on demand from the launcher and tears down fully when you exit — see [`docs/retroarch-addon.md`](docs/retroarch-addon.md)

### Karaoke
- [Nightingale](https://github.com/rzru/nightingale) served to the Tesla browser, with live pitch scoring off the cabin microphone — the app runs *in* the browser rather than being streamed, so the audio and the mic take the short path instead of a video pipeline
- Opens on the same hostname over TLS (`:8443`), because the browser only hands out the microphone to a secure origin — the device cert already covers it, and renews itself
- **UltraStar songs, not on-device ML.** Nightingale can generate karaoke tracks from any song with Demucs + WhisperX, but that needs a GPU or a desktop CPU; on a 4 GB Pi it is hours per song and an OOM risk to CarPlay. UltraStar files ship their own timed lyrics and backing tracks and skip the pipeline entirely
- **Twelve real songs included** — Happy Birthday, Twinkle Twinkle, Ode to Joy, Jingle Bells, Silent Night and more. All public domain, and *generated* on the Pi rather than downloaded: `scripts/make-karaoke-songs.py` synthesises the guide vocal, the backing track and the note chart from the melody data, so the recordings are yours and every note lands exactly where the scorer expects it
- Off by default: the server starts on demand from the launcher and stops itself once the singing does — see [`docs/karaoke-addon.md`](docs/karaoke-addon.md)

### Also included
- **Zero-config networking:** every device serves the fixed hostname `device.tesla-pi.humblebees.co`; `dnsmasq` resolves it locally to the Pi in the car, and certificates are issued centrally and pulled automatically — no domain, Cloudflare account, or DNS credential needed on the box. See [`docs/turnkey-shared-domain-plan.md`](docs/turnkey-shared-domain-plan.md).
- **Hotspot settings in the browser:** the AP ships as **`Tesla-Pi-XXXX` / `12345678`**, where the suffix comes from the Pi's own serial so two boxes in one car park don't collide. A fresh flash is reachable with nothing but the car. Settings → Hotspot renames it and sets a real password, with a non-dismissible banner nagging you until you do — change it before you drive anywhere (see [Security model](#security-model)). The same section sets the **Wi-Fi country**, which decides whether the hotspot may use 5 GHz: unset means 2.4 GHz, legal nearly everywhere but slower. Picking the wrong one costs speed and cannot break the hotspot — the Pi asks the kernel which channels the domain actually permits rather than trusting the config.
- **Regulatory-domain aware radio:** the box asks the kernel which channels your country actually permits and picks the fastest available (80 MHz UNII-3 → UNII-1 → any 5 GHz → 2.4 GHz), rather than shipping one hardcoded channel that would leave hostapd refusing to start — and the appliance unreachable — anywhere it isn't legal.
- **Wi-Fi settings in the browser:** Settings → Wi-Fi scans, joins, and forgets upstream networks, so the Pi can reach home Wi-Fi for certificate renewal without a keyboard or SSH.
- **Restart / shut down from the car:** Settings → System reboots the Pi (the page waits out the outage and reloads itself when the device is back) or halts it so power can be cut without corrupting the SD card — no SSH, no reaching behind the dash. Anyone on the hotspot can do this, which is denial of service and nothing more; see [Security model](#security-model).
- **Observability:** `GET /healthz` (JSON status), `GET /logs` (last 200 structured log entries), single-line JSON logs for easy `journalctl | jq` filtering
- **Status page telemetry that needs no Bluetooth.** The car allows only three simultaneous BLE connections and phone keys hold them, so Status → Car leads with everything obtainable *without* it: speed, heading, altitude and position from the browser's own geolocation (on a Tesla that is the car's GPS, and it works offline), the car's day/night preference, and its link to the hotspot. Status → Device adds core clock, temperature, memory, storage, hotspot clients, per-interface throughput and uplink signal — all read from `/proc` and `/sys`, no subprocess or privilege — plus the **CarPlay adapter's own core temperature** and the phone it is talking to, which the dongle volunteers on every session heartbeat and which this project previously logged and discarded

## Architecture (one paragraph)

`node-carplay` decodes the CarLinkit USB protocol; the Node server in `index.js` rebroadcasts the H.264 stream over `/video` (binary WS) and accepts touches + status messages over `/control` (JSON WS). The RetroArch addon reuses the same streaming pipeline through its own bridge. `nginx` terminates TLS on `:443` and reverse-proxies to `:8080`. `hostapd` runs the AP (`Tesla-Pi-XXXX` by default, on the best channel the device's regulatory domain allows); `dnsmasq` serves DHCP + a wildcard DNS A record so any hostname resolves locally; `iptables` DNATs the captive-probe IP to the Pi. **No upstream internet** — the iPhone carries cellular for CarPlay backend traffic, the Tesla carries its own LTE for everything else. See [`docs/plan.md`](docs/plan.md) for the full design rationale and [`docs/setup-guide.md`](docs/setup-guide.md) for the deploy recipe.

## Security model

**All HTTP/WebSocket endpoints are unauthenticated by design** — the trust
boundary is the WPA2 password of the in-car AP. Do **not** expose this box to
the internet. Read **[`SECURITY.md`](SECURITY.md)** before deploying.

Which means: **the shipped default password `12345678` is the whole of your
security until you change it.** It's deliberately trivial so first boot works
before you can type anything, and anyone in Wi-Fi range of an un-onboarded box
gets full control of it — including the ability to change the AP password out
from under you. Set a real one in Settings → Hotspot on first run.

## Get one running

### Option A — flash the image (recommended)

Download the latest `tesla-pi-*.img.xz` from
[Releases](https://github.com/elwinchia/tesla-pi/releases) and write it to a
microSD card with [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
("Use custom"), Balena Etcher, or `dd`.

Before ejecting the card, open **`tesla-pi.txt`** on the boot partition and set
`COUNTRY` to your two-letter country code. That is the only setting worth
filling in — it decides which Wi-Fi channels the box may legally use. Leave it
blank and it still works, just on slower 2.4 GHz. `TESLA-PI-README.txt` next to
it explains the rest.

Then: put the card in the Pi, plug in the Carlinkit dongle, power it up, join
the `Tesla-Pi-XXXX` hotspot from the car (password `12345678`), and browse to
`https://device.tesla-pi.humblebees.co`. **Change the hotspot password first** —
see [Security model](#security-model).

Everything else — hotspot credentials, home Wi-Fi for certificate renewal, SSH —
can be set either in `tesla-pi.txt` before first boot or from the in-car settings
page afterwards.

How the image is built, and how to build your own: **[`docs/image-build.md`](docs/image-build.md)**.

### Option B — build from source

**Prerequisites:** Node ≥ 20 and the native USB build deps (`libusb-1.0-0-dev`,
plus `build-essential` / `python3` for `node-gyp`). Then `npm ci`.

The whole of the manual recipe below is also available as one script —
`sudo image/provision.sh` performs setup-guide steps 2–12 on a live Pi, and is
idempotent.

> The systemd units ship with `__TESLAPI_USER__` / `__TESLAPI_DIR__`
> placeholders. The addon installers substitute them automatically; for the main
> `systemd/tesla-pi.service` fill them in first, e.g.
> `sudo sed -i "s|__TESLAPI_USER__|$USER|; s|__TESLAPI_DIR__|$PWD|" systemd/tesla-pi.service`.

Full step-by-step (DietPi flash → AP up → Tesla validation) lives in **[`docs/setup-guide.md`](docs/setup-guide.md)**. The short version once you've followed it:

```bash
sudo systemctl start tesla-pi
sudo systemctl status tesla-pi
sudo journalctl -u tesla-pi -f       # follow structured JSON logs
curl -k https://localhost/healthz    # JSON health
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
carplay-reader.js        Pipelined USB read loop for the dongle
dongle-firmware.js       Firmware library behind Settings → Dongle
retroarch-bridge.js      Optional native RetroArch addon: video + audio + gamepad
karaoke-bridge.js        Optional karaoke addon: on-demand Nightingale lifecycle
static/                  Browser client (HTML + WebGL worker)
conf/                    hostapd, dnsmasq, nginx, iptables, env templates
systemd/                 tesla-pi.service, cert-renew-watch.service, wlan0-ap-up.service
scripts/                 ap-mode.sh, dev-mode.sh, cert-renew-watch.sh, cert-sync.sh,
                         ap-radio-select.sh (regulatory-domain channel picker),
                         tesla-pi-ap / -wifi / -power / -dongle / -karaoke
                         (privileged helpers behind the Settings rail) + their
                         install-*.sh installers; deploy-to-pi.sh for dev pushes
image/                   flashable-image build: build-image.sh, provision.sh,
                         firstboot/, and the tesla-pi.txt the owner edits
infra/cert-service/      Cloudflare Worker + KV that serves the shared certificate
site/                    Landing page, published to GitHub Pages
.github/workflows/       renew-cert.yml — central cert issuance (holds the DNS token)
                         build-image.yml — tag → flashable image on Releases
                         pages.yml — publishes site/
docs/                    plan, setup, perf tuning, troubleshooting,
                         tesla-browser-capabilities.md (what the in-car browser can do)
```

## Configuration knobs

`/etc/default/tesla-pi` (from `conf/tesla-pi.env.template`) — **mode 0600**, it holds a token:
- `CARPLAY_DOMAIN` — the hostname nginx serves (default `device.tesla-pi.humblebees.co`)
- `CERT_PATH` — certificate path for `cert_days_remaining` reporting
- `CERT_SYNC_URL` / `CERT_SYNC_TOKEN` — cert service endpoint + bearer token
- `CERT_SYNC_BACKOFF_S` — min seconds between AP-down sync attempts (default 6 h)
- `LOG_TOUCH=1` — per-touch debug logs
- `LOG_FPS=1` — per-second video bitrate logs
- `CARPLAY_ON_DEMAND` — shipped default for "connect only while the page is open" (default `on`; the Settings switch persists a choice that wins over it)
- `CARPLAY_IDLE_STOP_MS` — grace before the dongle is closed after the last page goes away (default 300000)
- `CARPLAY_DEMAND_TTL_MS` — how long a page's "I am on screen" lasts without a refresh (default 40000)

CarPlay config (in `index.js`): defaults to 1920×1496 @ 60fps, DPI 160, `boxName=nodePlay`, audio transfer mode on.

## Limitations you should know before building one

- **Steering-wheel controls aren't wired up.** No AVRCP path from the wheel back to CarPlay.
- **The box is not offline-forever.** Its TLS certificate expires (~90 days). Day-to-day
  in-car use needs no internet, but the Pi has to see home Wi-Fi occasionally to pull a
  fresh certificate, or the Tesla browser will eventually refuse the page. The UI warns
  in advance.
- **The certificate and its key are shared** across all devices using the project domain.
  Each Pi is an isolated single-client AP, which bounds the exposure, but it is a
  deliberate trade — see [`SECURITY.md`](SECURITY.md) and the design doc.
- **No authentication.** See the security model above.
- **The car can switch the browser off entirely.** Tesla 2026.20 added
  Controls → Safety → Parental Controls, which blocks Browser, Theater and
  Arcade. With Browser blocked there is no route to this device at all and
  nothing on the Pi can tell — check that setting before debugging anything.

## Hardware

- Raspberry Pi 4 (4 GB; 5 GHz AP capable)
- Carlinkit CPC200-CCPA (USB ID `1314:152*`)
- 12 V → 5 V/3 A buck regulator (in-car)
- iPhone with iOS 16+

A turnkey alternative exists if you'd rather not solder anything: **Carlinkit's own Tesla module** (~$60). This project is only worth building if you already have a Pi and dongle on the shelf, or if you want full control of the box (custom domain, observability, your own renewal cadence, retro gaming).

## Credits

This project is a fork of [marcraft2/tesla-carplay](https://github.com/marcraft2/tesla-carplay) — itself built on [rhysmorgan134/node-carplay](https://github.com/rhysmorgan134/node-CarPlay). Most of the hard CarPlay-protocol work belongs to those two projects; this fork is the in-car deployment, the RetroArch addon, and the surrounding networking/observability/reliability work built around them.

- [rhysmorgan134/node-carplay](https://github.com/rhysmorgan134/node-CarPlay) — the CarPlay USB protocol decoder this is built on
- [marcraft2/tesla-carplay](https://github.com/marcraft2/tesla-carplay) — the Pi-in-a-Tesla idea, original web client, original systemd packaging
- [darreal44](https://github.com/darreal44) — canvas-based render path (replaced jmuxer in upstream v0.4)

## License

BSD 3-Clause — see [`LICENSE`](LICENSE). Retains the upstream copyright
(Marc Dubois, 2022) alongside this fork's.
