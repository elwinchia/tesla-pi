# RetroArch addon (native)

Streams a **native** RetroArch session to the Tesla browser — games run directly
on the Pi's V3D GPU + CPU, **not** inside Waydroid/Android (which was too laggy
for real-time play). It reuses the same H.264-over-WebSocket pipeline as the
CarPlay and Android paths, minus the entire Android stack.

Everything is **off by default**: nothing runs at boot (bar loading the
`snd-aloop` audio loopback), CarPlay never depends on it, and the session is
started on demand by the Node server and torn down fully when you leave the route.

## Architecture

```
RetroArch tile → POST /retroarch/start (or /launch) → sudo mytesla-retroarch start
  → systemctl start cage-retroarch.service
      = cage -- /usr/local/bin/mytesla-retroarch-session
          → wlr-randr pins the output to 1024x768@60 (BEFORE RetroArch, so it
            sizes its GL surface right), then execs `retroarch -f [-L core rom]`
  → bridge waits for the NEW wayland-N socket (diffed across the start, so it
    coexists with the Android cage on wayland-0)
  → wf-recorder captures the cage output → Pi HW H.264 (/dev/video11)
      → /retroarch/h264 (binary WS) → browser WebCodecs (static/worker.js)
  → ffmpeg captures the ALSA loopback (RetroArch plays to hw:Loopback,0,0;
    we read hw:Loopback,1,0) as raw S16LE PCM → /retroarch/audio (binary WS)
      → browser AudioWorklet ring buffer → car speakers
  → scripts/uinput-pad.py creates a /dev/uinput virtual gamepad; the browser
    overlay (and any BT pad paired to the Pi) drive it via /retroarch/input (WS)
      → RetroArch udev joypad driver, bound to RetroPad by mytesla-pad.cfg
```

Unlike the Android addon, RetroArch is **not kept warm** — it runs the core at
60 fps even unwatched, so `stop` (idle, Exit, or relaunch) tears the cage down.
Cold start is ~2 s.

## Components

| Path | Role |
|---|---|
| `retroarch-bridge.js` | Node bridge: session lifecycle, AU splitter, audio, input, HTTP/WS |
| `scripts/uinput-pad.py` | python3-evdev virtual gamepad (run from the repo by the bridge) |
| `scripts/mytesla-retroarch-session` → `/usr/local/bin/` | cage's command: pins the mode, execs RetroArch |
| `scripts/mytesla-retroarch` → `/usr/local/sbin/` | privileged start/stop/status helper (sudoers NOPASSWD) |
| `systemd/cage-retroarch.service` | on-demand headless cage unit (no `WantedBy`) |
| `conf/retroarch/retroarch.cfg` | curated config (`__HOME__` substituted on install) |
| `conf/retroarch/autoconfig/mytesla-pad.cfg` | binds the virtual pad → RetroPad automatically |
| `conf/99-mytesla-uinput.rules` | grants group `input` access to `/dev/uinput` |
| `conf/retroarch-modules.conf` | loads `snd-aloop` at boot |
| `static/retroarch-audio-worklet.js` | browser PCM ring-buffer player |

HTTP/WS endpoints (all under `/retroarch/`): `status`, `start`, `stop`,
`launch {core,rom}`, `roms` (HTTP); `h264`, `audio`, `input` (WS).

## Install

```
sudo scripts/install-retroarch-addon.sh
sudo systemctl restart mytesla.service     # so the launcher shows the tile
```

Idempotent. Drop GBA/GB/GBC ROMs in `~/retroarch/roms`. Add more cores by
`apt install libretro-<core>` and extending the `CORES` map in
`retroarch-bridge.js`.

## Use

Tap **RetroArch** in the launcher → pick a ROM (or "Open RetroArch menu"). The
on-screen pad: analog D-pad (one finger, 8-way), A/B/X/Y, L/R, Select/Start, a
**Menu** button (RetroArch menu toggle), **♪** (audio test tone), **Exit**.

### Bluetooth controller (optional, best feel)

Pair a pad to the **Pi** (not the car); RetroArch's udev driver reads it with no
extra config:

```
bluetoothctl
  power on
  agent on
  scan on            # find your controller, note its MAC
  pair <MAC>
  trust <MAC>
  connect <MAC>
```

## Audio notes

- The Tesla browser (Chromium ≥102) plays Web Audio to the car speakers, but
  autoplay policy needs a user gesture — the AudioContext is unlocked on the tile
  tap. The **♪** button plays a test tone to confirm sound reaches the speakers
  (the one device behaviour that couldn't be pre-confirmed).
- Audio is parked-only (Tesla mutes the browser in motion) — expected for gaming.
- v1 uses raw S16LE PCM (no codec) for lowest latency + maximum compatibility;
  local bandwidth (~1.5 Mbps) is free next to the ~8 Mbps video. If a future
  browser can't output Web Audio at all, the fallback is MSE fragmented-AAC.

## Tuning

- Resolution/framerate: `RETROARCH_MODE` in `mytesla-retroarch-session` and
  `RETROARCH_W/H`, `RETROARCH_BIT_RATE` env in the bridge. 1024×768@60 is the
  default (full-screen, no concurrent CarPlay, so the encoder has the whole Pi).
- The cage output mode is set by the session launcher **before** RetroArch starts
  — do not move it after, or RetroArch sizes to cage's 1280×720 default.

## Rollback

```
sudo systemctl stop cage-retroarch.service
sudo rm -f /etc/systemd/system/cage-retroarch.service \
           /usr/local/sbin/mytesla-retroarch /usr/local/bin/mytesla-retroarch-session \
           /etc/sudoers.d/mytesla-retroarch /etc/udev/rules.d/99-mytesla-uinput.rules \
           /etc/modules-load.d/mytesla-retroarch.conf
sudo systemctl daemon-reload
```
The Node bridge goes inert once `/usr/local/sbin/mytesla-retroarch` is gone.
