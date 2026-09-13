# A local LLM driving companion — the options

Status: **the gating probe has been run, and Option B is dead.**

Measured in the car 2026-08-27, Chromium 148, report in
[`results-webgpu-probe-2026-08-27.json`](results-webgpu-probe-2026-08-27.json):

| Question | Answer |
|---|---|
| `navigator.gpu` exists | yes |
| **`requestAdapter()`** | **null under all three power preferences** |
| Same in a Worker | null there too |
| `navigator.bluetooth` | **absent** |
| `navigator.deviceMemory` | **2 GB** |
| Storage quota | 7.0 GB, persistence already granted, 64 MB round-trip in 293 ms |

`navigator.gpu` present with a null adapter is precisely the signature
[`retroarch-webgpu-plan.md §6`](retroarch-webgpu-plan.md) predicted for a
blocklisted driver. WebGL2 works — the product streams video through it — so the
GPU is fine; it is simply not exposed to WebGPU on this build.

**So the car cannot host the model, and §4's architecture does not survive.**
The live recommendation is §2 Option C, or nothing. Everything below is kept as
written because the reasoning still holds; only the conclusion moved.

Two smaller results worth carrying forward. `deviceMemory: 2 GB` would have made
a 1.5 GB model marginal even with a working adapter, so had the GPU answered,
Qwen3.5-0.8B — not Gemma 4 e2b — was the honest target. And storage was the one
green light: 7 GB of quota with `persisted` already true, meaning weights would
have survived between drives. That is worth remembering if a future Tesla
release turns WebGPU on, because it makes the retest cheap: re-run the probe,
and only the adapter row has to change.

The idea is modest: a chat companion, on screen over CarPlay, that runs without
an internet connection. This document is about where the model actually runs,
because that is the only interesting question — the overlay is a `<div>`, and
this project already draws two of them (the status overlay and the now-playing
strip).

## 1. The constraint that decides everything

The Pi 4 cannot do this. That is not a hunch; it is measured. A survey of LLM
inference across single-board computers found that on a Pi 4, **any model of 1B
parameters or more (q4_k_m) fell below 5 tok/s with "unreliable operation"**,
and only models of 360M or less cleared 5–15 tok/s. The same study puts the Pi 5
at 5–15 tok/s for 1.5B and 2–5 tok/s for 3B, so this is a Pi 4 problem
specifically, not an ARM problem.

Those numbers are for an **idle** board. Ours is running `hostapd`, `nginx`, the
Node server and the CarPlay rebroadcast, in a dashboard that
[`pi4-migration-plan.md`](pi4-migration-plan.md) already flags for thermal
margin — it idles ~50 °C with less headroom than the Zero it replaced.

A 360M model is not a companion. So the Pi's CPU is out, and the question
becomes *whose* silicon does the work.

Note the shape of that question, because this project has already answered it
once. [`retroarch-webgpu-plan.md §1`](retroarch-webgpu-plan.md) says of the
upscaler:

> Every pixel we ask the Pi to convert and encode costs CPU we do not have,
> while the car's Ryzen GPU sits idle behind a single textured quad. The work is
> on the wrong side of the WiFi link.

The identical argument applies here, more strongly. Inference is *all* compute
and no I/O; there is nothing tying it to the Pi except habit.

## 2. The four options

| | Where inference runs | Speed (~1–2B q4) | Pi CPU cost | Hardware change | Blocker |
|---|---|---|---|---|---|
| **A** llama.cpp on the Pi | Pi 4 CPU | <5 tok/s, unreliable | 3–4 cores | none | dead on arrival |
| **B** WebLLM over WebGPU | **the car's GPU** | ~80% of native | ~zero | none | is WebGPU exposed? |
| **C** Pi 5 + AI HAT+ 2 | Hailo-10H NPU | 30–50 tok/s @ 1B | ~zero | Pi 5 + HAT | migration cost |
| **D** cloud model | someone else's GPU | fast | ~zero | tether | not local; breaks the no-WAN design |

### A — llama.cpp on the Pi 4

Rejected, per §1. Worth stating the failure concretely so nobody re-proposes it:
at 5 tok/s a two-sentence reply takes about ten seconds *after* prompt
processing, and that is before speech recognition and synthesis get their turn.
RAM is the second wall — 4 GB total with Node, nginx and the video path already
resident.

### B — the model runs in the car's browser

> **Measured 2026-08-27: not available.** `requestAdapter()` returns null. Keep
> this section for the day a Tesla release flips WebGPU on — the probe is cheap
> to re-run and everything below still applies.

WebLLM is the mature in-browser engine: MLC/TVM compiles model-specific kernels
ahead of time and runs them through WebGPU, retaining **up to 80% of native
inference performance** on the same hardware.

Two properties make it fit this project unusually well:

- **`model_url` and `model_lib_url` are configurable.** Weights do not have to
  come from a CDN. **The Pi serves them as static files** — which is a thing it
  already does for everything under `static/` — so the appliance keeps its
  defining property of needing no upstream internet.
- **After the first load it reads from the Cache API, not the network.** So the
  Pi only serves the weights once per car, and can ship them pre-seeded in the
  SD image so even the first run is offline.

The Pi's contribution to inference becomes zero bytes of CPU. It goes back to
being what it already is: a file server and a websocket broker.

Candidate models at 4-bit, in ascending order of ambition: Qwen3.5-0.8B
(~0.6 GB), Gemma 4 e2b (~1.5 GB at Q4_K_M, explicitly aimed at 4 GB+ devices),
LFM2.5 2.6B (~1.8 GB, built for on-device tool use). Be honest about the
ceiling — the 2026 consensus is that sub-2B output is fine for conversation and
not for work. For a companion that is the correct trade, but it does mean not
promising more than chat.

### C — Pi 5 with the AI HAT+ 2

**Now the recommendation, not the fallback** — §7 came back negative. The Hailo-10H (40 TOPS,
**8 GB of its own RAM**, so it does not eat the Pi's) runs Llama 3.2 1B at
**30–50 tok/s** and 1.5B-class models at 20–35 — roughly 10–25× the Pi 5 CPU,
at low power and with much better time-to-first-token.

The costs are real: a Pi 5 migration immediately after finishing the
Zero → Pi 4 one, more heat and current draw in a dashboard that is already the
thermal risk in the risk table, an M.2 HAT making the box physically bulkier,
and a model catalogue limited to what Hailo compiles to `.hef`.

Independent testing also notes the Pi 5's own CPU is "within striking distance"
on pure decode throughput for some prompts — so if you are migrating to a Pi 5
anyway, try it bare before buying the HAT.

### D — a cloud model over a tether

Best quality by an enormous margin, and the option that abandons the premise.

It also fights the hardware. The iPhone's Wi-Fi radio is occupied by the
Carlinkit dongle, so Personal Hotspot has to arrive over USB (cabling the phone,
which defeats wireless CarPlay) or Bluetooth PAN (whose radio the Pi shares with
the `wlan0` AP — and that AP is load-bearing). Either way every user needs a
per-device pairing step, and the box stops being self-contained.

Keep it in mind as an *optional* upgrade for a parked car on home Wi-Fi, where
`wlan1` already has an uplink for certificate renewal. Do not build the product
on it.

## 3. What is already solved

It is worth being clear about how much of this is not new work.

| Piece | Status |
|---|---|
| Drawing UI over CarPlay | Done twice — the status overlay and the now-playing strip |
| A JSON control channel to the browser | Done — `/control` WS |
| Streaming PCM to the browser and playing it | Done — the RetroArch addon's ALSA-loopback path |
| Serving arbitrary large files to the car | Done — the `static/` handler |
| Capturing the driver's voice | **Measured working** — see §5 |

The genuinely new parts are the model host, the speech pair, and the car-data
source.

## 4. Recommended split

Assuming §7 comes back green:

```
Tesla browser                          Pi 4
─────────────                          ────
WebLLM on the car's GPU  ◀── weights ── static/ file server
  ↑ prompt / ↓ reply     ◀──  JSON  ──▶ Node orchestrator
cabin mic → PCM          ────────────▶ whisper.cpp tiny
speaker  ← PCM           ◀──────────── Piper TTS
                                       ▲
                                  car state (§6)
```

The division is not arbitrary. Inference is continuous and parallel, so it goes
where the GPU is. Speech recognition and synthesis are **bursty** — they run per
utterance, not per frame — which is exactly the workload a Pi 4 can absorb
without disturbing the video path, and both already have proven transports.

## 5. Voice — the part that is genuinely ours

This is where the project has an advantage nobody else building on the Tesla
browser has bothered to earn, because the measurement work is already done.

From the in-car probe run on 2026-08-21 with `static/mic-probe.html`, on
Chromium 148:

- `Tesla Microphone` and `Tesla Speakers` are exposed. The permission
  **persists** — already `granted` before the page asked, `getUserMedia`
  resolved in 84 ms with no prompt.
- Stream is 48 kHz stereo, 10 ms latency, NS and AGC on. Speech recorded at
  −21.5 dBFS.
- `echoCancellation` accepts `[true, false, "remote-only", "all"]` and the car
  honours each. **`"remote-only"` is the only mode that both rejects our own
  page audio (−0.8 dB leak, versus +25.9 dB for `"all"`) and still hears the
  driver.** Ask for `echoCancellation: { exact: "remote-only" }` and expect mono
  with a ~15 dB higher noise floor.
- `echoCancellation: false` returns a silent stream — there is no raw capture
  path.

**The mic works in Drive** (confirmed 2026-08-23). That was the single unknown
the whole idea rested on: the camera is documented as parked-only and the
microphone is not, and had it turned out to be park-gated too, a *driving*
companion would have been text-only and therefore pointless. It is not. Voice is
the primary interface.

Both legs of the speech pair are within the Pi's budget:

- **STT** — whisper.cpp `tiny` runs at a real-time factor of 2–3× on a Pi 4 at
  ~273 MB resident, 60–80% of one core *while actively transcribing*.
- **TTS** — Piper synthesizes in ~100–300 ms on ARM64 and is the standard
  partner to whisper.cpp on this class of hardware.

Budget roughly **850–1360 ms of non-LLM latency** for a full round trip
(capture buffering ~500 ms, recognition 200–400 ms, synthesis 100–300 ms,
playback 50–100 ms) before the model has said a word. That is the number to
design the interaction around — it argues for streaming the reply's first
sentence rather than waiting for the whole thing.

### The audio wart

We cannot duck CarPlay. Music rides the Tesla's own Bluetooth link from the
phone; our speech comes out of the browser tab. The car mixes two independent
sources and gives us no fader over the other one. Either accept the companion
talking over music, or ask the user to lower the media volume, or push the
CarPlay audio through the Pi — which is a much larger change than this feature
justifies. See the `audioTransferMode` note in
[`carlink-protocol-notes.md`](carlink-protocol-notes.md) before assuming the
last one is easy.

## 6. Car data — what makes it a *driving* companion

Without vehicle state this is a generic chatbot that happens to be in a car.
With it, it can say "range is tight for where you're pointed" and "you've been
driving two hours". There are two ways in, and they are not close in cost.

### Bluetooth (start here)

Tesla's vehicle-command protocol works over BLE with **no internet and no Fleet
API**. The Pi enrols as a virtual key and talks to the car directly; this is
proven on Pi 3 and later, with no rate limit and a working range of about 3 m —
and we are *inside the car*.

You get state: charge level, charging status, climate, doors, lock state. You do
not get CAN-rate driving telemetry. No wiring, no trim removal, and the failure
mode is "the companion doesn't know the battery level", not "the car is on a
lift".

The one caveat: the Pi's onboard Bluetooth shares silicon with the `wlan0` radio
running the AP, and the AP is the product. Measure coexistence before shipping
it.

**Could the browser do it instead?** **No — measured 2026-08-27:**
`navigator.bluetooth` is absent on the car's Chromium 148, exactly as the Linux
implementation status predicted. The probe's two scan buttons stay disabled
because there is no API to scan with. Pi-side BLE is the only path; the rest of
this subsection is kept for the record.

It would have been a real simplification — no
BlueZ, no Pi-side daemon, no radio contention with the AP, and the key pair
lives where the UI already is. But **expect no**: Web Bluetooth is only
partially implemented on Chromium for Linux and needs
`chrome://flags/#enable-experimental-web-platform-features`, which we cannot set
on a car. §9 of the probe answers it anyway, because a cheap no is worth having
and the alternative is guessing.

Note what a yes would and would not buy. `requestDevice()` requires a user
gesture and a native chooser the car may not even render, and clearing that bar
only proves the **transport** exists — reading state still needs a key pair
enrolled in the car and signed commands. The probe deliberately stops at
enumerating the GATT service.

### CAN (only if you need live telemetry)

**Tesla has no standard OBD-II port**, and Highland moved the connector — it now
sits behind the **passenger A-pillar**, not where earlier Model 3s had it. You
need a Highland-specific harness that inserts between existing connectors
(OHP and Xenonkungen both sell one), and installation means de-energising the
car and pulling trim.

From there a ~$10 MCP2515 CAN HAT on the Pi's SPI plus SocketCAN gives real
telemetry — speed, SOC, pack voltage and current, temperatures, gear — and the
Scan My Tesla community's DBC work is the reference for decoding it. Prior art
for exactly this appliance shape exists: a Pi acting as the car's Wi-Fi AP,
serving a page that receives CAN data over WebSockets.

Two rules: **sniff read-only, never write to that bus**, and expect signal IDs
to drift across Tesla firmware releases, so the decode table is maintenance you
are signing up for.

### Why it is worth doing either

Beyond the conversational content, knowing the gear lets the companion gate
itself: voice-only in Drive, full UI in Park. That turns the safety question
from a warning banner into a designed behaviour.

## 7. The gating probe

Run [`static/webgpu-probe.html`](../static/webgpu-probe.html) on the car. It
lands at `https://<device>/webgpu-probe.html` — the `static/` handler serves it
by path, so there is no route to add and nothing to enable.

It answers, in order:

1. **Is there an adapter at all?** `retroarch-webgpu-plan.md §6` is right that
   `navigator.gpu` existing is not the answer — a blocklisted driver presents as
   `requestAdapter()` returning `null`. The probe also catches the two further
   failure modes: an adapter that refuses `requestDevice()`, and a device whose
   shader compiler rejects everything.
2. **Do the limits fit a model?** `maxStorageBufferBindingSize` is the one that
   bites; at the 128 MB spec floor weights must be split into many more shards
   and some MLC builds refuse outright.
3. **Does a compute shader produce correct results?** Dispatched and verified,
   not assumed.
4. **Does `shader-f16` compile?** Without it the model runs f32 and both memory
   and bandwidth roughly double.
5. **How fast, really?** Decode is bandwidth-bound — every token reads the whole
   model once — so the probe streams a 64 MB storage buffer and reports GB/s,
   then divides by each candidate model's size for a tok/s ceiling.
6. **Does WebGPU work in a Worker with `OffscreenCanvas`?** That is where
   `static/worker.js` renders from. A main-thread-only WebGPU blocks the
   RetroArch upscaler but *not* the LLM, which needs no canvas — so this
   question has two different answers depending on which plan is asking.
7. **Will the browser cache 1.5 GB?** The quieter way this plan dies. WebLLM
   keeps the weights in the Cache API; if the car's quota is small, or eviction
   wipes it between drives, the Pi re-serves a gigabyte every trip. The probe
   reports quota, requests persistence, and round-trips 64 MB.
8. **Is there Web Bluetooth?** Orthogonal to the GPU question and folded in
   because it is free to ask while someone is already sitting in the car with
   the page open. See §6 — expect no.

The BLE scan buttons sit outside "run everything" deliberately: `requestDevice()`
needs the user gesture from its own tap, and an await chain spends it. The
filtered and unfiltered scans are separate for the same reason a control is:
"nothing found" and "the API is broken" both raise `NotFoundError`, and only the
unfiltered scan tells them apart.

The page was verified end-to-end against a real WebGPU implementation before
being committed — every section runs and returns sane numbers, including the BLE
success and failure paths, which were exercised against a stubbed adapter rather
than left to first contact with the car. What it has not seen is the car.

## 8. Risks worth naming before starting

- **The LLM shares a renderer process with CarPlay.** A ~1.5 GB model competing
  with the WebCodecs decoder means an out-of-memory tab kill takes down the
  *primary product*, not just the companion. Mitigations: load the model lazily
  and only on the companion route, unload on leaving it, prefer the 0.6 GB model
  over the 1.5 GB one, and treat the video path as the thing that must survive.
- **Quality.** A sub-2B model will be confidently wrong. Do not let it answer
  questions about the car's actual state from its own weights — feed it §6 data
  and have it read numbers out, not recall them.
- **Driver attention.** A screen that invites reading while driving is a
  different product from one that talks. Gate on gear (§6) and treat text as the
  parked affordance.
- **Two renderer paths.** If the upscaler and the LLM both adopt WebGPU, a car
  that returns no adapter must still do everything it does today. That is a real
  maintenance cost, and `retroarch-webgpu-plan.md §7` already makes the same
  point about the WebGL2 fallback.

## 9. Order of work

1. Run the WebGPU probe on the car. It unblocks this **and**
   `retroarch-webgpu-plan.md` Phase 3.
2. If green: stand up WebLLM against a Pi-served model, on its own route, with
   text input only. No mic, no car data — prove the model runs and the weights
   cache.
3. Add Piper on the Pi and speak the replies over the existing PCM path.
4. Add whisper.cpp and the cabin mic with `echoCancellation: "remote-only"`.
5. Add car state over BLE — on the Pi unless §9 of the probe surprises us.
   Re-open the CAN question only if step 5 proves too coarse.

Steps 1 and 2 are the ones that decide whether the rest is real.

## 10. Sources

- [An Evaluation of LLMs Inference on Popular Single-board Computers](https://arxiv.org/html/2511.07425v1) — the Pi 4 / Pi 5 numbers in §1
- [WebLLM: A High-Performance In-Browser LLM Inference Engine](https://arxiv.org/html/2412.15803v2)
- [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) and [Build an offline-capable chatbot with WebLLM](https://web.dev/articles/ai-chatbot-webllm) — custom `model_url`, Cache API offline behaviour
- [Raspberry Pi AI HAT+ 2 review](https://www.cnx-software.com/2026/01/20/raspberry-pi-ai-hat-2-review-a-40-tops-ai-accelerator-tested-with-computer-vision-llm-and-vlm-workloads/) and [Hailo-10H LLM benchmarks](https://www.codesota.com/embedded-ai/hailo-10h-llms)
- [The best open-source small language models](https://www.bentoml.com/blog/the-best-open-source-small-language-models)
- [whisper.cpp real-time on Pi 4](https://github.com/ggml-org/whisper.cpp/discussions/166) and [whisper.cpp + Piper on ARM64](https://turingpi.com/whisper-cpp-piper-tts-arm64-turing-pi-rk3588/)
- [Highland OBD2 harness](https://ohptools.com/products/tesla-model-y-3-highland-gen-3-front-installation-connector-harness-obd2-adapter-for-live-data-monitoring-diagnostics) and [tm3-can-logger](https://github.com/k-korn/tm3-can-logger)
- [tesla_ble_mqtt_docker](https://github.com/tesla-local-control/tesla_ble_mqtt_docker) — BLE state without the Fleet API
- [teslamotors/vehicle-command protocol.md](https://github.com/teslamotors/vehicle-command/blob/main/pkg/protocol/protocol.md) — the BLE service/characteristic UUIDs and the `S…C` advertised-name format used in probe §9
- [Web Bluetooth implementation status](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md) — why the Linux answer is expected to be no
