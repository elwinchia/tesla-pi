# Changing the CarPlay output resolution

The CarPlay video stream resolution is set in **three places that all have to match**, otherwise touch coordinates drift, the canvas stretches, or the iPhone re-encodes wastefully:

| File | Field | What it controls |
|---|---|---|
| `tesla-pi/index.js` | `config.width`, `config.height` | What the Pi tells the iPhone to encode at (via the dongle) |
| `tesla-pi/static/index.html` | `const carplayWidth`, `const carplayHeight` | Canvas pixel dimensions on the browser side; touch-coord normalization |
| `tesla-pi/static/index.html` | CSS `canvas { aspect-ratio: W / H }` | Display letterboxing — keeps proportions when window aspect doesn't match |

## Current value

`1920 × 1496` — bench setting on the Pi 4 (5 GHz AP gives the bandwidth headroom). `1180 × 919` was the original Pi Zero 2 W setting, pixel-mapped 1:1 to the Tesla Highland browser viewport.

## What actually controls icon size on the CarPlay home screen

**Empirically verified 2026-05-04, contradicting some online claims that only aspect ratio matters.** Tested on the bench Pi Zero 2 W against a current iPhone (CarPlay home screen), keeping aspect ratio fixed at 1.28:1:

| Canvas | Total pixels | Home-screen grid observed | Icons per page |
|---|---|---|---|
| 1180 × 919 | 1.08 MP | 2 rows × 4 cols | 8 |
| **1440 × 1120** | **1.61 MP** | **3 rows × 4 cols** | **12** |

iOS *does* re-tier into a denser layout when total pixel count crosses some threshold (somewhere between 1.08 MP and 1.61 MP at this aspect). This is the iOS 18.4+ "third row" behaviour — Apple has never published the exact threshold; the older online consensus that *only* aspect ratio drives column count was based on iOS 17 and earlier.

### Things that do NOT shrink icons (verified)

- **`dpi` field on its own.** Tested 100, 140, 160 — visually identical home screens at the same canvas size. The CarPlay protocol's `dpi` appears to influence asset variant / text rendering hints inside apps but not the home-grid layout. The "lower dpi = smaller UI" advice in the protocol field comments is misleading for CarPlay specifically (it *is* accurate for Android Auto).

### Things that do (verified or expected)

- **Higher total pixel count at same aspect** — confirmed: bumps row count when crossing the iOS-internal threshold.
- **Wider aspect ratio** — expected to bump column count (4 → 5) at ratios ≥ ~2:1, matching widescreen OEM head units. Not yet tested on this rig.

### Cost of shrinking icons via higher resolution

H.264 bandwidth scales linearly with pixel count. Measured on `wlan0` outbound (Pi → laptop, 30 fps):

| Canvas | Stream bitrate | Pi Zero 2 W 2.4 GHz headroom |
|---|---|---|
| 1180 × 919 | ~10 Mbps | comfortable |
| 1440 × 1120 | **15.5 Mbps** | near practical ceiling on contested 2.4 GHz; in-car (single-client AP) likely fine |

If lag appears after a resolution bump, the bottleneck is the Pi Zero 2 W's 2.4 GHz radio (single-stream Cypress CYW43438), not Pi CPU (`load_avg ~0.13` even while streaming — frames are forwarded opaquely, no decode on the Pi). On home Wi-Fi the link competes with everything else; in-car the `TeslaCP` AP serves only the Tesla, so practical throughput is materially higher.

## How to change it

### 1. Edit on the Mac

```bash
cd ~/tesla-pi

# index.js — top-level config object
#   width: <NEW_WIDTH>,
#   height: <NEW_HEIGHT>,

# static/index.html — three spots
#   const carplayWidth = <NEW_WIDTH>;
#   const carplayHeight = <NEW_HEIGHT>;
#   canvas { aspect-ratio: <NEW_WIDTH> / <NEW_HEIGHT>; }
```

### 2. Push to the Pi and restart

Pi reachable on home Wi-Fi at `<pi-lan-ip>`.

```bash
rsync -av \
  ~/tesla-pi/ \
  pi@raspberrypi.local:/home/<user>/tesla-pi/ \
  --exclude='.git' --exclude='node_modules' --exclude='package-lock.json'

ssh pi@raspberrypi.local 'sudo systemctl restart tesla-pi'
```

### 3. Reload the Tesla browser tab

Touch the refresh icon, or close + re-open the URL. WebCodecs reinitializes with the new dimensions on connect.

## Choosing a resolution

| Resolution | Aspect | Home grid (observed/expected) | Notes |
|---|---|---|---|
| **1180×919** | 1.28:1 | 2×4 (8) | Pixel-perfect for Tesla Highland browser viewport. ~10 Mbps. |
| **1440×1120** | 1.29:1 | **3×4 (12)** — verified | Same aspect as 1180×919, denser iOS tier kicks in. ~15.5 Mbps; near 2.4 GHz ceiling on contested home Wi-Fi, fine in-car. |
| 1600×1248 / 1760×1368 | 1.28:1 | 3×4 expected | Heavier bandwidth; downscaled by Tesla browser. |
| 1920×1496 | 1.28:1 | 3×4 expected, possibly 3×5 | ~25 Mbps; will lag on 2.4 GHz home Wi-Fi, may still work in-car. |
| 1280×720 | 16:9 | 2×5 expected | Letterboxes top/bottom in Tesla viewport. Wider aspect → more cols. |
| 1920×720 | 2.67:1 | 2×5 expected (Tesla-Android's known-good) | Letterboxes more in Tesla viewport. |
| 800×480 | 5:3 | 2×4 (8) | Very low bandwidth, very pixelated on Tesla. |

### H.264 alignment caveat

H.264 encoders prefer dimensions that are multiples of 16 (or at least 8). 1180 and 919 are neither. The iPhone encoder accepts non-aligned dimensions but pads internally, which costs a couple percent extra bandwidth. If you ever see encode artifacts at non-standard sizes, round up to the next multiple of 8 — e.g. `1184 × 920` — and let the Tesla browser handle the tiny 4-pixel scale.

### Other knobs in the same `config` block

| Field | Effect |
|---|---|
| `fps` | Frames per second. 30 is smooth; 60 doubles bandwidth and CPU on iPhone. 24 saves battery noticeably. |
| `dpi` | **Does not** shrink the CarPlay home-screen icon grid (verified — see above). Appears to affect text rendering / asset variant inside some apps. Keep at 160 (the conventional default real head units report). The "100=small, 160=iPhone, 200=chunky" advice in the field's source comments is true for Android Auto, not CarPlay. |
| `nightMode` | `true` flips the CarPlay UI to dark mode. Tesla doesn't tell us its theme, so this has to be set manually. |
| `hand` | `0` = LHD (steering on left → tabs on right); `1` = RHD (Malaysia). |
| `mediaDelay` | Audio delay buffer in ms. We don't route audio through the Pi; this is informational to CarPlay. |

## Verifying after a change

```bash
ssh pi@raspberrypi.local 'sudo journalctl -u tesla-pi -n 30 --no-pager'
# Look for: "boot" log line with the new config
# Look for: "carplay_started" within ~15 s

# Confirm what the worker received
# In the Tesla / Mac browser console: should see the new canvas pixel dims
```

In the Tesla browser, you can check `chrome://gpu` is not surfaced — but you can right-click the canvas → Inspect (if Tesla DevTools are exposed in your firmware version) to see the runtime dimensions.

If touches end up in the wrong place after a resize, the cause is almost always **`carplayWidth/carplayHeight` in `index.html` not matching `config.width/height` in `index.js`**. The frontend uses those constants to convert pixel coordinates to the 0..1 normalized values that node-carplay expects.
