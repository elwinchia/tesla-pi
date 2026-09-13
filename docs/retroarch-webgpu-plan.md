# Moving RetroArch's upscale into the car's GPU

Status: **plan, nothing implemented.** The gating question in §6 has not been
answered on a real car, and everything past Phase 1 depends on it.

## 1. What actually constrains this pipeline

The Pi is the scarce machine, and `retroarch-bridge.js` already says why:

> `--no-damage` makes wf-recorder copy + colour-convert every compositor frame,
> so at 60 Hz it burns ~1.4 cores (+ cage ~0.5) for a GBA game.

So the encode resolution and framerate were both chosen defensively —
720x480 at 30 fps (`RA_W`/`RA_H`/`RA_FPS`), where 720x480 is exactly 3x the
GBA's native 240x160, and the comment notes that "fewer pixels is the biggest
lever". The browser then "upscales to fill the screen (pixel-art, so crisp)".

That last parenthesis is the opening. Every pixel we ask the Pi to convert and
encode costs CPU we do not have, while the car's Ryzen GPU sits idle behind a
single textured quad. The work is on the wrong side of the WiFi link.

## 2. What the browser does with those pixels today

`static/renderer_webgl.js` is a minimal blit, and it is worth being precise
about where sharpness is won and lost:

- The texture is sampled `NEAREST` (lines 72-73). Good — that part is already
  right.
- `draw()` sets `canvas.width`/`canvas.height` to the frame size on **every
  frame**. Historically, assigning those attributes resets the drawing buffer
  even when the value is unchanged; Chromium has since optimised the same-value
  case, so this may cost nothing on 140. Worth confirming rather than assuming
  either way — but assigning only on an actual size change is free to do and
  removes the question.
- The canvas backing store is therefore 720x480, and `#ra-player` in
  `static/index.html:1518` stretches it with `width:100%; height:100%;
  object-fit:contain` and **no `image-rendering` declaration**.

That last point is the one that matters: the final 720x480 → full-screen
upscale is done by the browser's default CSS filtering, which is smooth. The
NEAREST sampling in the shader is undone one step later. The pipeline is not
delivering the crisp pixel-art result its own comments claim.

## 3. The shape of the change

Send the Pi's output closer to native resolution, and reconstruct it in the car:

```
today   RetroArch 240x160 → cage 720x480 → yuv420p → H.264 → NEAREST blit → CSS bilinear → screen
target  RetroArch 240x160 → cage 480x320 → yuv420p → H.264 → GPU upscale + shader        → screen
```

Fewer pixels through the documented CPU hog, and the reconstruction happens
where there is GPU to spare. The prize is not prettier pixels for their own
sake — it is Pi CPU headroom, which converts directly into `RETROARCH_FPS=60`.

## 4. Phases

Deliberately ordered so the cheap wins land first and none of them are blocked
on the WebGPU question.

### Phase 0 — one CSS line, no WebGPU

Add `image-rendering: pixelated` to `#ra-player`. This alone restores the crisp
upscale the pipeline was supposed to have. Zero cost, instantly visible,
trivially revertible. **Do this first and look at it before planning anything
else** — it may turn out to be most of the perceived win.

### Phase 1 — fix the renderer, still WebGL2

1. Stop reassigning `canvas.width`/`height` per frame; set them only when the
   frame size actually changes.
2. Size the backing store to the *display* rectangle rather than the video, and
   do the scale in the fragment shader. That takes the final resampling away
   from CSS and puts it under our control, which is the precondition for
   Phase 2.
3. Sharp-bilinear sampling (nearest within a texel, linear only across the
   boundary) so non-integer scale factors do not shimmer.

Still no new API. Keep `renderer_webgl.js` as the CarPlay path's renderer
untouched — see §7.

### Phase 2 — a shader chain for RetroArch only, WebGL2 or WebGPU

Scanline / LCD-grid / CRT-mask passes, RetroArch only. WebGL2 can do this with
FBO ping-pong; it is not the reason to adopt WebGPU.

### Phase 3 — the actual WebGPU proposal

A multi-pass compute upscaler of the xBR / ScaleFX class, running on the car's
GPU, fed by a **lower** Pi-side resolution:

- drop `RETROARCH_W/H` toward native (480x320, possibly 240x160)
- raise `RETROARCH_FPS` to 60 with the CPU that frees up
- reconstruct to full screen in the car

This is the phase that pays for itself, and the first one where WebGPU earns
its place: compute passes over storage textures, a real multi-pass graph
without FBO gymnastics, and enough headroom to run a heavy reconstruction at
60 fps on hardware that is doing nothing else.

## 5. Why not just do all of it in WebGL2

Honestly: most of Phases 0-2 *should* be WebGL2, and pretending otherwise would
waste effort. WebGL2 gives us sharp-bilinear, scanlines and CRT masks today,
with no capability risk and no fallback path to maintain.

WebGPU is worth the migration only if we commit to Phase 3. If we stop at
Phase 2, the correct outcome of this document is "we improved the WebGL
renderer and closed the WebGPU question as not-needed".

## 6. The gating unknown

> **Answered 2026-08-27: no.** `static/webgpu-probe.html` on the car (Chromium
> 148) reports `navigator.gpu` present but `requestAdapter()` returning **null**
> under `high-performance`, `low-power` and the default — and null in a Worker
> too. That is the blocklisted-driver signature this section predicted. Report:
> [`results-webgpu-probe-2026-08-27.json`](results-webgpu-probe-2026-08-27.json).
>
> Per §5, the correct outcome is therefore the one that document already named:
> **improve the WebGL2 renderer and close the WebGPU question as not-needed.**
> Phases 0–2 are unaffected and still worth doing. **Phase 3 is dead** until a
> Tesla release changes the answer, and re-running the probe is the cheap way to
> find out that it has.

**Does the Tesla browser expose WebGPU at all?** Unverified. Chromium 140
(shipped in Tesla 2026.14) is new enough that WebGPU is plausible on the AMD
Ryzen MCU, and Tesla's own note for that release cites "improves WebGPU
performance", which strongly implies it is present — but that is a release note,
not this car, and vendors routinely blocklist GPU features per driver.

Probe on the car before any Phase 3 work:

```js
const gpu = navigator.gpu;
const adapter = gpu && await gpu.requestAdapter();
// report: !!gpu, !!adapter, adapter?.info, adapter?.limits.maxComputeWorkgroupSizeX
```

`navigator.gpu` merely existing is not the answer — `requestAdapter()` returning
`null` is exactly how a blocklisted driver presents itself. This belongs
alongside the existing capability checks; `static/mic-probe.html` is the working
example of how these pages are built and reported.

> **The probe now exists.** `static/webgpu-probe.html` answers everything in this
> section and more — it also dispatches a real compute shader and checks the
> results, since an adapter that refuses `requestDevice()` and a device that
> compiles nothing are two further ways to fail. Open `/webgpu-probe.html` on the
> car. It was written for `docs/llm-companion-options.md`, which is blocked on
> the same question, so running it once unblocks both plans.

Also worth capturing in the same run: whether WebGPU works **inside a Worker**
with `OffscreenCanvas`, since that is where `static/worker.js` renders from. A
WebGPU that only works on the main thread is not usable here without
restructuring.

## 7. What must not change

- **CarPlay keeps the plain blit.** It is not pixel art; scanlines or an xBR
  pass on a phone UI would be actively wrong. If the renderer becomes
  configurable, CarPlay's configuration is "none".
- **The WebGL2 renderer stays as the fallback.** Whatever Phase 3 becomes, a
  car that returns no WebGPU adapter must still play games. That means two
  renderer implementations behind one interface, which is a real maintenance
  cost and should be weighed before starting.
- **The wire format does not change.** H.264 Annex-B over the existing binary
  WebSocket, decoded by WebCodecs. Nothing in this plan touches the transport,
  the encoder, or `feedAnnexB`.

## 8. How we would know it worked

Record before and after, on the car, same game, same scene:

| Measure | How |
| --- | --- |
| Pi CPU | `top -b -n1` for `wf-recorder` + `cage` + RetroArch during play |
| Achievable framerate | raise `RETROARCH_FPS` until CPU saturates |
| Bitrate | bytes/sec over `/retroarch/h264` |
| Glass-to-glass latency | unchanged is the requirement, not improved |
| Appearance | screenshots at each phase, compared side by side |

Phase 3 justifies itself only if Pi CPU drops enough to hold 60 fps. If it does
not, stop at Phase 2 and keep WebGL2.

## 9. Files this would touch

| File | Change |
| --- | --- |
| `static/index.html` | Phase 0 CSS; renderer selection for `#ra-player` |
| `static/renderer_webgl.js` | Phase 1 fixes; becomes the fallback path |
| `static/worker.js` | picks a renderer instead of hardcoding `WebGLRenderer` |
| `static/renderer_webgpu.js` | new, Phase 3 only |
| `retroarch-bridge.js` | `RA_W`/`RA_H`/`RA_FPS` defaults, Phase 3 only |
| `conf/tesla-pi.env.template` | the retuned defaults |

Nothing here is a code change yet. Phase 0 and Phase 1 are safe to start
without answering §6; Phase 3 is not.
