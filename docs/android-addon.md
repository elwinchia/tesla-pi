# Android addon — Waydroid in the Tesla browser

Run Android apps (YouTube, maps, messaging) on the Pi and stream them into
the same SPA the CarPlay feed uses. Optional addon: nothing here is in
mytesla's startup path, boot time is untouched, and CarPlay works identically
whether this is installed or not.

> Status: **deployment recipe**, like `setup-guide.md`. Read the
> Expectations section before installing — DRM video apps are SD-only at
> best, and turn-by-turn navigation is out of scope (no GPS source yet).

---

## How it works (one paragraph)

Waydroid runs Android 13 (LineageOS-based, GAPPS image) in an LXC container,
rendering into a headless Wayland compositor (`cage`) — no display attached,
same as the rest of the box. `scrcpy-server` runs inside the container
(reached over ADB at `192.168.240.112:5555`) and software-encodes the screen
to H.264. `android-bridge.js` in the Node server muxes that onto
`/android/video` (binary WS) and translates SPA touches from
`/android/control` into scrcpy input events — the exact architecture of the
CarPlay path, with scrcpy in place of the CarLinkit dongle. The launcher's
Android tile starts the stack on demand (`sudo mytesla-android start`, ~60 s);
ten minutes with no viewer and the bridge tears it down again, reclaiming
~1.5–2 GB of RAM.

## Requirements

- Raspberry Pi 4 with **4 GB+ RAM** (hard requirement — this is why the
  addon was impossible on the Pi Zero 2 W)
- 64-bit DietPi/Debian (`uname -m` → `aarch64`)
- ≥ 8 GB free on the SD card (Android image + apps); 32 GB card recommended
- Internet on the Pi during install only (`scripts/dev-mode.sh` or the
  Settings → WiFi tab / wlan1) — the GAPPS image is a ~1 GB download
- A heatsink or fan on the Pi 4 — software H.264 encode at 30 fps is the
  hottest thing this box does (see Thermals below)

## 1. Install

```bash
cd ~/mytesla
sudo scripts/install-android-addon.sh
```

The installer is idempotent and does, in order: preflight (aarch64, ≥4 GB),
`psi=1` kernel cmdline, binder module/binderfs check, 2 GB zram (zstd),
Waydroid from the official `repo.waydro.id` apt repo, `cage` + `adb` +
`wayvnc`, the pinned `scrcpy-server` v4.0 jar (SHA-256 verified),
`waydroid init -s GAPPS`, pins the Android surface to **1280×1000** via
`persist.waydroid.width/height`, installs `cage-headless.service`
(disabled), the `mytesla-android` helper and its sudoers entry.

If it appended `psi=1`, **reboot before first start**.

## 2. Smoke test (SSH)

```bash
sudo mytesla-android start      # container + compositor; waits for RUNNING (~30–60 s)
sudo mytesla-android status     # container=active session=RUNNING ip=192.168.240.112
sudo mytesla-android stop
sudo systemctl restart mytesla.service   # Node picks up the addon → tile appears
```

Then open the SPA (laptop Chrome on the bench first): the launcher now shows
an **Android** tile. Tap it — the route opens with a "Starting Android…"
chip, and the home screen appears when the first frames flow. The right-hand
bar is Back / Home / Recents / ✕ (stop & return to launcher).

First start after boot also runs an encoder probe (`list_encoders`) and logs
the chosen software encoder (`android_encoder_probe` in `/logs`). Waydroid
has no hardware encoder; the bridge picks `c2.android.avc.encoder` /
`OMX.google.h264.encoder` explicitly because scrcpy's auto-pick is known to
select broken ones (MediaCodec err=-38).

## 3. One-time Android provisioning

**Google Play certification** — first launch shows "device isn't Play
Protect certified". Self-certify:

```bash
sudo waydroid shell
ANDROID_RUNTIME_ROOT=/apex/com.android.runtime ANDROID_DATA=/data \
ANDROID_TZDATA_ROOT=/apex/com.android.tzdata ANDROID_I18N_ROOT=/apex/com.android.i18n \
sqlite3 /data/data/com.google.android.gsf/databases/gservices.db \
  "select * from main where name = \"android_id\";"
```

Register the printed ID at <https://www.google.com/android/uncertified>,
wait ~10 minutes, then `sudo mytesla-android stop && sudo mytesla-android
start`. (Procedure per docs.waydro.id/faq/google-play-certification.)

**Widevine L3 (DRM video)** — optional, best-effort. Follow the arm64 recipe
in [waydroid discussion #1276](https://github.com/waydroid/waydroid/discussions/1276)
and verify with the *DRM Info* app. L3 means **SD resolution** on Netflix /
Disney+ / Prime; there is no path to L1 (hardware TEE) in a container.
YouTube needs none of this.

**Maps** — Google Maps installs from the Play Store but Waydroid has no GPS.
A mock-location app pinned to a fixed point is fine for browsing and traffic;
live turn-by-turn would need a USB GPS dongle + gpsd→Android sensor bridge
(future work, not in v1).

**Installing apps**: Play Store once certified, or
`sudo waydroid app install /path/to.apk`. The Pi is arm64 — native ARM apps,
no translation layer involved.

## Knobs

Environment variables read by `android-bridge.js` (set in
`/etc/default/mytesla`):

| Var | Default | Meaning |
|---|---|---|
| `ANDROID_W` / `ANDROID_H` | 1280 / 1000 | must match `persist.waydroid.width/height` |
| `ANDROID_BIT_RATE` | 6000000 | scrcpy H.264 bitrate (bps) |
| `ANDROID_IDLE_STOP_MS` | 600000 | teardown after this long with no viewer |
| `WAYDROID_ADB_ADDR` | 192.168.240.112:5555 | Waydroid's ADB endpoint |

Don't chase CarPlay's 1920×1496 here: the dongle hands us pre-encoded video,
but Android frames are encoded *on the Pi's CPU*. 1280×1000@30 ≈ the Pi 4's
comfortable ceiling.

## Budget: RAM & thermals

| State | RAM in use (approx) |
|---|---|
| CarPlay only (addon stopped) | ~0.5 GB — unchanged from before |
| + Waydroid running | +1.5–2 GB (Android 13 + GAPPS) |
| Headroom on 4 GB + 2 GB zram | OK, but don't also run heavyweight debug tooling |

While streaming Android, watch `cpu_temp_c` in `/healthz` (also on the
Monitor route). Sustained software encode pushes the Pi 4 toward its 80 °C
throttle point in a hot car — if you see throttling, drop `ANDROID_BIT_RATE`
or the resolution props first.

## Verification checklist (bench, then car)

1. Bench (laptop Chrome via dev-mode): tile → stream renders, touch
   round-trips, Back/Home/Recents work.
2. Both streams at once: open CarPlay in one tab, Android in another;
   `/healthz` → `load_avg` sane, `cpu_temp_c` < 80, `mem_used_mb` < 3200.
3. Boot regression: reboot with the addon installed but stopped —
   `systemd-analyze` and time-to-CarPlay unchanged.
4. In-car: confirm the Tesla browser decodes the second WebCodecs stream
   (the CarPlay decoder stays alive in the background when you switch
   routes). If the MCU refuses two decoders, report it — the fallback is
   freezing the CarPlay canvas while on the Android route.

## Troubleshooting

- **`android_start_failed: no h264 encoder`** — the GAPPS image shipped
  without a usable software encoder. Fallback path: `wayvnc` (installed by
  the addon) against the cage session + a noVNC iframe; file an issue/note
  before building that out.
- **`scrcpy_server` logs MediaCodec err=-38** — the probed encoder is broken
  in this image version; check `/logs` for `android_encoder_probe` and try
  the other candidate via adb shell, or re-init with a newer image.
- **`adb not ready` timeout** — the container booted slowly (first boot
  after image download is the worst). Just start again; subsequent boots
  are much faster.
- **Stream is black but state=running** — the session may be at the Android
  lock screen; `sudo mytesla-android stop && start` resets it.
- **Tile missing in the launcher** — the SPA only shows it when
  `/usr/local/sbin/mytesla-android` exists; re-run the installer and
  restart `mytesla.service`.

## Uninstall

```bash
sudo scripts/uninstall-android-addon.sh
sudo systemctl restart mytesla.service
```

Removes Waydroid (images included), cage, wayvnc, the helper, unit and
sudoers entry. Leaves `psi=1`, zram and adb in place (all harmless) — the
script prints how to revert those by hand.
