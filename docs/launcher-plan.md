# Launcher + RetroArch + Pi-side audio: Project Plan

**Status**: not committed. Planning doc for extending the CarPlay-only
appliance into a multi-app launcher (CarPlay + RetroArch initially) and
investigating whether to move audio out of the iPhone-BT path.

**Goal**: When the Tesla browser loads the Pi's URL, default to CarPlay
(no behavior change for cold start). A "home" affordance backgrounds
CarPlay and surfaces a launcher where CarPlay is one tile and other
apps (RetroArch first, more later) are siblings. Optionally, route
audio out via the Pi instead of the iPhone-BT pairing so the launcher
can mute/duck CarPlay when another app starts media.

**Hardware reality**: Pi 4 4GB (per `pi4-migration-plan.md`), Tesla
Highland browser as the only renderer, no display attached to the Pi.
Architectural implication: every "app" must render in the Tesla
browser as web content. There is no kiosk, no X11, no native
desktop apps.

---

## Architecture overview

```
[iPhone] --wifi/BT--> [CarLinkit dongle] --USB--> [Pi 4]
                                                    |
                                                    +-- node-carplay (USB protocol)
                                                    +-- Node WS+HTTP server :8080
                                                    |     ├── /control  WS  (touch, status, nightMode)
                                                    |     ├── /video    WS  (H.264 frames, binary)
                                                    |     ├── /audio    WS  (NEW - fMP4/FLAC fragments) ← option 2/3
                                                    |     ├── /mic      WS  (NEW - 16k Int16 PCM)       ← option 3 only
                                                    |     ├── /healthz, /logs (unchanged)
                                                    |     └── static/ SPA (router-shaped index.html)
                                                    +-- nginx :443 TLS (unchanged)
                                                    +-- RetroArch tile = static /retroarch/ (Emscripten)
                                                    |
[Tesla Highland browser] --wss--> SPA shell
                                  ├── /carplay   route → canvas + worker (current UI)
                                  ├── /launcher  route → tile grid
                                  ├── /retroarch route → iframe to /retroarch/
                                  └── /settings  route → status overlay + night-mode toggle
```

The CarPlay video pipeline (worker + offscreen canvas + WS) keeps
running while the user is on the launcher; only `display: none` toggles.
Returning to CarPlay is instant, no handshake. This is the single
biggest UX decision and it's load-bearing — see Phase 1 below.

---

## Phase 0 — Decisions to lock first

| Decision | Choice | Why |
|---|---|---|
| SPA vs. multi-page | **SPA**, hash-based routes | CarPlay video pipeline must survive view changes. Re-handshake on every navigation is unacceptable. |
| Background CarPlay video while launcher is open? | **Yes** — `display:none` on canvas, leave WS + worker running | Pi 4 has the RAM/CPU. Instant return is the whole point. |
| Default route on cold load | **`/carplay`** | "Boot to CarPlay" requirement. Bookmark unchanged. |
| Home affordance to invoke launcher | **Persistent overlay button (top-left, semi-transparent) + 3-finger swipe-up gesture as redundancy** | Visible button is discoverable; gesture is symmetric with existing 3-finger-down (night-mode override). |
| Apps included in v1 | **CarPlay, RetroArch, Settings.** Plex deferred indefinitely. YouTube / Spotify Web as new-tab links if trivial. | RetroArch is fully Pi-hostable; Plex's iframe-blocking + license complexity not worth the v1 effort. |
| Audio routing | **Decide after the cheap probe in Phase 4** | Don't commit to MSE/fMP4 plumbing until we confirm the dongle is actually shipping audio frames. |
| Mic input | **Out of scope for v1.** Cabin mic unreachable from Tesla browser; only fix is a USB mic on the Pi. | Documented in `project_audio_routing_options.md` (memory). Revisit if Siri matters. |

---

## Phase 1 — SPA refactor + boot-to-CarPlay

**Status**: ✅ shipped (commit `9ac7e7d`).

**Effort**: 1 evening · **Goal**: existing UI works exactly as before, but the HTML is now router-shaped.

### Tasks

1. Restructure `static/index.html` into an SPA shell:
   - `<div id="route-carplay">` (current canvas + handlers)
   - `<div id="route-launcher" hidden>` (empty placeholder)
   - `<div id="route-settings" hidden>` (move `#status-overlay` content here)
   - Tiny router: `goRoute(name)` toggles `hidden` on the four divs based on `location.hash`.
2. Default route: hash empty → CarPlay. Bookmark URL unchanged → cold boot loads CarPlay first paint, no regression.
3. CarPlay's WS connections (`/control`, `/video`) live at top-level scope, not inside the route — they outlive route changes.
4. Verify: existing 3-finger-down gesture still cycles night override; cert banner still surfaces; status overlay still pops on disconnect.

### Acceptance

- `git diff` is mostly mechanical wrapping; no functional change to CarPlay behavior.
- Bench test: load page → CarPlay video appears within current expected latency.
- Toggle hash to `#/launcher` manually → blank div appears, canvas hidden, WS still connected (`/healthz` shows `video_clients: 1`).
- Toggle back to `#/carplay` → canvas re-shown, video continues without re-handshake.

### Risks

- The offscreen canvas transfer (`player.transferControlToOffscreen()` at `index.html:174`) is one-shot per element. Hiding/showing the canvas via `display:none` is fine; reparenting or re-creating the `<canvas>` element will break the worker. Keep the element identity stable.
- `#status-overlay`'s `showOverlay()` / `hideOverlay()` lifecycle currently doubles as both startup splash AND error reconnect UI. After the Settings route absorbs it, the error-reconnect role still needs to live somewhere — keep the overlay as an error-only fixed element, separate from the Settings route content.

---

## Phase 2 — Launcher view + home affordance

**Status**: ✅ shipped. Status overlay also re-scoped to `/carplay` only (precursor: the splash used to trap users when CarPlay was unplugged; now the home button sits at z-index 700 above it, and CSS suppresses the overlay entirely on `/launcher` and `/settings`).

**Effort**: 1–2 evenings · **Goal**: the user can navigate.

### Tasks

1. **Home overlay button** on `/carplay` route: 48×48 px, semi-transparent, top-left, fixed-position. SVG car/grid icon. Tap → `goRoute('launcher')`. Hidden on other routes.
2. **3-finger swipe-up gesture**: clone the swipe-down logic from `index.html:514–545` (gesture state machine, `GESTURE_MIN_FINGERS=3`, deltaY threshold). Up direction → launcher; down direction → night-mode override (existing). Both gestures must coexist without latching.
3. **Launcher view**: 2×2 or 2×3 tile grid, each tile ~250×250 px on the 1920-wide canvas. Tile config object:
   ```js
   const TILES = [
     { id: 'carplay',   label: 'CarPlay',   icon: 'car.svg',   action: () => goRoute('carplay') },
     { id: 'retroarch', label: 'RetroArch', icon: 'retro.svg', action: () => goRoute('retroarch') },
     { id: 'settings',  label: 'Settings',  icon: 'cog.svg',   action: () => goRoute('settings') },
   ]
   ```
4. **Settings route**: lift `#status-grid` and `#log-pane` content out of `#status-overlay`. Add a row for night-mode override (Day / Night / Auto buttons matching the gesture cycle). Add a "Back to CarPlay" button.
5. Wire navigation: tile tap → `goRoute(tile.id)`; route change → push to `location.hash` (so Tesla browser back-button does something sensible if it exists).

### Acceptance

- Tap home button on CarPlay → launcher appears, tiles laid out, CarPlay canvas hidden but WS still alive (`/healthz` shows video_clients: 1, no reconnect log entry).
- Tap CarPlay tile → returns to CarPlay route, video frames continue painting (no black screen, no handshake).
- Tap Settings tile → grid + log tail, Day/Night/Auto buttons cycle override identically to the existing 3-finger-down gesture.
- 3-finger swipe-up from CarPlay → launcher. 3-finger swipe-down still triggers night override.

### Risks

- Touch handling routes through `handleTouchStart/End/Move` which currently assumes the canvas is the tap target. Off-canvas taps on launcher tiles need their own touch handlers — make sure `mouseDown` / `gestureActive` state from canvas handlers can't leak into launcher handlers (route guard).
- 3-finger swipe-up could conflict with 3-finger-down's existing `gestureStartY` logic if a user wobbles. Treat the threshold as absolute Y delta with a sign check; don't let an aborted upward swipe latch into night-toggle.

---

## Phase 3 — RetroArch tile

**Status**: 🟡 pending external input — the launcher already has a disabled RetroArch tile placeholder. To light it up, fetch/build a RetroArch.js bundle, drop into `static/retroarch/`, and choose cores + ROMs. None of that is on the critical path; revisit when you have a wet weekend.

**Effort**: 1 weekend · **Goal**: ROM-playable game inside the Tesla browser.

The Pi serves [RetroArch.js](https://github.com/libretro/RetroArch) (the Emscripten WebAssembly build of RetroArch) as a static asset under `/retroarch/`. The Tesla browser iframes it. Cores and ROMs live on the Pi's SD card or USB SSD.

### Tasks

1. **Build / fetch a RetroArch.js bundle**: pull from upstream releases or build from source. Cores to start: `nestopia` (NES), `gambatte` (GameBoy), `snes9x` (SNES). All three are tiny WASM blobs, well under Tesla MCU's memory headroom.
2. **Static hosting**: drop bundle at `mytesla/static/retroarch/` (built artifacts ignored via `.gitignore`). Update nginx if necessary for `.wasm` mime-type; node's static handler in `index.js:144-153` needs `.wasm: 'application/wasm'` in the MIME map.
3. **ROM storage**: `/home/<user>/mytesla/roms/` (or USB SSD mount, see Phase 5). Static `/roms/` HTTP route, optional dir listing in launcher.
4. **Touch overlay**: RetroArch.js has built-in on-screen controls; tune size/position for the Tesla aspect ratio.
5. **Audio**: HTML5 audio inside the Tesla browser plays through Tesla speakers natively. CarPlay audio meanwhile rides the existing iPhone-BT path. **Both can play simultaneously** — UX rule: when entering the RetroArch route, send `{type: 'mute', value: true}` on `/control` to silence CarPlay (or just trust the user).
6. **Iframe sandboxing**: serve RetroArch on the same origin (no CORS dance). Sandbox the iframe with `allow="autoplay; fullscreen; gamepad"` minimal set.

### Acceptance

- `/retroarch/` loads in Chrome on bench, ROM boots, audio + input work.
- Loaded inside the SPA via launcher → RetroArch tile, runs at acceptable framerate on the Tesla browser. (Tesla MCU is a real Chromium with WebGL; expect NES/GB to be fine, SNES to be marginal.)
- Returning from RetroArch to CarPlay via home button → CarPlay video resumes instantly (Phase 1 invariant).
- No crashes when CarPlay disconnects/reconnects while RetroArch tab is active.

### Risks

- Tesla MCU's Chromium version is not publicly documented. Some WASM features (SharedArrayBuffer, Atomics) require COOP/COEP headers that nginx must serve correctly. If the browser is too old to support threaded RetroArch, fall back to single-threaded build.
- ROM legality: this is your problem. Ship the bundle without ROMs in git; ROMs go on the Pi out-of-band.
- Storage on SD card: NES ROMs are tiny, but a SNES library + saves is GB-scale. See Phase 5 for USB SSD plan if it grows.

---

## Phase 4 — Audio probe + decision (cheap before any wiring)

**Status**: ✅ shipped (commit `9ac7e7d`); awaiting one drive's worth of journalctl data to make the call.

**Effort**: 30 minutes · **Goal**: know whether option 2/3 is even possible before designing them.

The current `index.js:42` config sets `audioTransferMode: true`. That command tells the dongle to ship PCM audio frames over USB to the Pi. But the dongle's NV memory is also set (carryover from prior tesla-android setup) to "phone audio / phone mic" mode, and which one wins is undocumented. node-carplay's `onmessage` switch in `index.js:253-278` has no `case 'audio'` — frames may already be arriving and being silently dropped.

### Tasks

1. Add a probe to `carplay.onmessage`:
   ```js
   case 'audio':
     audioFrameCount++
     audioByteCount += ev.message.data.byteLength
     break
   ```
2. Add audio rate to the existing `LOG_FPS` interval logger:
   ```js
   log('info', 'audio_rate', { fps: audioFrameCount, kbps: ... })
   ```
3. Run with `LOG_FPS=1` for one drive. Expected outcomes:
   - **Audio frames > 0**: dongle is in host-audio mode. Option 2 is reachable purely in software. Proceed to Phase 6 if you want it.
   - **Audio frames = 0**: dongle is in phone-audio mode (NV setting wins over per-session command). Option 2 requires flipping NV memory on the dongle — non-reversible without the CarLinkit Tool, and a CarLinkit firmware risk you must own. Decision deferred.

### Acceptance

- One drive's worth of `audio_rate` log lines in `journalctl -u mytesla`.

### Risks

- None. This is a 5-line, read-only probe.

---

## Phase 5 — USB SSD for ROMs (optional, only if RetroArch library grows)

**Effort**: 1 evening · **Goal**: ROM library lives on durable, fast storage.

Pi 4 has USB 3.0. A small USB-3.0 SATA enclosure + 256GB SSD removes both the SD-card wear concern (RetroArch saves are write-heavy) and the size ceiling.

### Tasks

1. Format SSD as ext4, mount at `/mnt/roms` via `/etc/fstab` with `nofail` flag (so a missing SSD doesn't block boot).
2. `mytesla/static/retroarch/roms/` → symlink to `/mnt/roms/`.
3. Document in `setup-guide.md`.

Skip until RetroArch usage proves out.

---

## Phase 6 — Pi-side audio (option 2 only, if Phase 4 confirms feasibility)

**Status**: 🟡 blocked on Phase 4 result. Don't start until you've seen `audio_first_frame` in the logs (or proven its absence and decided to flip dongle NV).

**Effort**: 1 weekend · **Goal**: audio plays through Pi-managed pipeline; launcher can mute/duck on tile change.

Reusing tesla-android's pipeline almost verbatim (see `project_audio_routing_options.md`):

```
node-carplay 'audio' event → PCM Int16 (16k or 48k, depending on stream)
  → resample to 48k stereo (if needed, ffmpeg/libsoxr or sox)
  → FLAC encode
  → mux to fragmented MP4 (~40ms fragments) — tesla-android's ta_audio_mux.c reusable
  → broadcast on new /audio WS
  → MSE SourceBuffer in Tesla browser → hidden <audio> element
```

### Tasks

1. **Server side**: new module `audio-broadcast.js`. Buffers PCM from `'audio'` events. Pipes through ffmpeg child process (`-f s16le -ar 48000 -ac 2 -i - -c:a flac -movflags frag_every_frame -f mp4 pipe:1`) or port `ta_audio_mux.c` to Node addon. Broadcasts fMP4 fragments on a new WebSocket at `/audio`.
2. **Client side**: new `audio-worker.js` — WebSocket client running in a Web Worker, `binaryType='arraybuffer'`, exponential-backoff reconnect (clone `connect()` from `index.html`). Posts each fragment to main thread via `postMessage`.
3. **Hidden `<audio>` element**: `audio.src = MediaSource_URL`, `SourceBuffer.appendBuffer(fragment)` for each WS message. `audio.play()` on user-gesture (the route change to /carplay counts).
4. **Mute/duck on route change**: `goRoute('retroarch')` → set `<audio>` element volume to 0 OR send `{type: 'audioMute', value: true}` to server, server stops broadcasting.
5. **Dongle NV mode flip** (if Phase 4 showed audio frames are NOT arriving): document the CarLinkit Tool procedure separately. This is a dongle-firmware operation, irreversible without the tool, do it on a bench with the rollback Tesla-Android setup as fallback.

### Acceptance

- CarPlay music plays through Tesla speakers via the Pi pipeline (no iPhone BT).
- Latency drift between video canvas and audio is bounded — measure with a clapper test on bench.
- Switching to RetroArch tile mutes CarPlay audio cleanly; switching back resumes within ~1 second.
- Drop a single audio WS frame → no audible glitch (MSE buffer absorbs it). Drop the whole connection → audio stops, reconnects on next message.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Dongle NV mode flip bricks the dongle | Low | Bench-only — buy a second dongle before flipping if you can't risk being CarPlay-less | CarLinkit Tool has documented mode set; community confirms reversibility |
| A/V sync drift between video WS and audio WS clocks | Medium | Lipsync visible on phone calls / Siri | tesla-android's `mediaDelay` config knob (currently 300ms) was for this; tune empirically |
| ffmpeg child process saturates Pi 4 CPU | Low | Stream chokes | FLAC encode is cheap; if it's a problem, drop to PCM-in-fMP4 (larger frames, no encode) |
| Tesla browser's MSE refuses FLAC-in-fMP4 | Medium | Pipeline stalls silently | tesla-android proves this works on at least some Tesla MCU revs; bench-test with `MediaSource.isTypeSupported('audio/mp4; codecs="flac"')` before committing |
| BT iPhone↔Tesla pairing now has nothing to play | None | Confusing UX — "why is the iPhone silent?" | Document. Phone calls from iPhone still ring, but routing them is a separate problem (option 3). |

### What this does **not** fix

Siri, phone-call audio, mic input. Those need option 3 (USB mic on Pi). Option 3 is a separate, larger project — defer.

---

## Out of scope for this plan

- **Plex tile**: dropped per user direction (2026-05-08). Pi 4 *can* run Plex Media Server, but the Tesla browser's iframe-blocking and Plex's account auth make the UX flaky. Revisit only if user changes their mind, and consider Jellyfin instead (more iframe-friendly).
- **Mic input / Siri / phone calls**: option 3 in `project_audio_routing_options.md`. Requires a USB mic on the Pi, cabin placement, echo cancellation. Significant hardware + firmware work. Standalone project if and when the user wants it.
- **Tesla browser auto-launch on car-on**: a Tesla feature, not a Pi feature.
- **Native Linux apps via X11/Wayland**: the Pi has no display. Not happening in this architecture.

---

## Migration / rollback

Each phase is independently revertable:

- Phase 1: SPA refactor. Roll back = `git revert` the index.html change. No server-side changes.
- Phase 2: launcher. Roll back = same.
- Phase 3: RetroArch. Roll back = remove `static/retroarch/` and the tile entry. ROMs stay on disk.
- Phase 4: probe. Pure additive log; no rollback needed.
- Phase 5: SSD. Unmount + remove fstab line.
- Phase 6: audio pipeline. Roll back = stop the audio WS broadcast, re-set dongle NV to phone-audio mode (separate physical step). Audio reverts to iPhone BT path.

The `mytesla.service` watchdog and restart logic (`index.js:82-108`, `WatchdogSec=30`) cover none of these new components automatically — make sure any new long-running pipeline (Phase 6 ffmpeg) feeds the watchdog ping path or is supervised by node so a stuck encoder doesn't keep `mytesla` looking healthy.

---

## Sources / related docs

- `docs/plan.md` — original Pi Zero 2 W plan (audio decisions, captive-portal logic)
- `docs/pi4-migration-plan.md` — current hardware target rationale
- `docs/perf-optimizations.md:159` — `mediaDelay` tuning (relevant for Phase 6 A/V sync)
- Memory: `project_audio_routing_options.md` — three audio paths summarized
- [tesla-android/android-external-tesla-android-audio-relay](https://github.com/tesla-android/android-external-tesla-android-audio-relay) — `tesla-android-audio-relay.c`, `ta_audio_mux.c` (reusable for Phase 6)
- [tesla-android/frontend `js/audio/`](https://github.com/tesla-android/frontend/tree/main/js/audio) — MSE SourceBuffer client (reusable)
- [rhysmorgan134/node-CarPlay](https://github.com/rhysmorgan134/node-CarPlay) — `src/modules/DongleDriver.ts` (audioTransferMode), `src/modules/messages/sendable.ts` (SendAudio), `src/web/WebMicrophone.ts` (mic input format)
