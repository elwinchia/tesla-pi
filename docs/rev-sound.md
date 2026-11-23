# Engine sound

Status: **built and tested off the car; never heard in the car.** Off by
default. Nothing on the Pi changes: the sound is made and played by the car's
browser, and the Pi only serves four more static files.

A synthesised engine that revs and shifts as you drive, through the car's own
speakers. It is modelled on [TesRev](https://tesrev.com/). None of TesRev's
code or sounds are used. Its site publishes no source code, and every sound
here is synthesised from numbers in `static/rev-profiles.js`.

## 1. How TesRev works

Read from tesrev.com (home, `/about/`, `/guides/`, `/legal/`) on 2026-11-23.

| | TesRev |
|---|---|
| What | A web page that synthesises an engine (11 engines: V8, inline-6, V10, V12, flat-plane V8, rotary, a turbine…) that revs and shifts with your driving. Free while it is in testing, with no app and no account. |
| Where it plays | **Inside the car only.** Either the phone plays it over Bluetooth into the car, or the Tesla's own browser plays it. Its Boombox guide draws the line: "The Boombox plays sounds outside the car, when parked. TesRev plays an engine inside the car, while you drive." |
| What drives it | **Sensors only, "never through the car's systems".** It does not use the Fleet API, BLE, CAN or OBD. The phone's accelerometer gives acceleration and its GPS gives speed. With no phone, "the Tesla screen follows the Tesla's own GPS speed, a little later and less finely." It turns acceleration into engine load with "your Tesla model's mass, power and drag". |
| Latency | Phone over Bluetooth adds about 0.2 s. A phone relaying to the Tesla screen adds "a few hundredths of a second". Tesla GPS alone has no figure, only "a little later". There is a "Delay compensation" setting. |
| Gearbox | Comfort, Normal and Sport set where it shifts. A Rev button plays the engine while parked. |
| Legal | The driver stays responsible. Keep the volume low enough to "hear horns, sirens and other road users". The sound "does not reflect the car's real state or speed". Not affiliated with Tesla. |

TesRev's best mode needs a phone in a holder, sending its accelerometer to the
car's screen over the internet. Its fallback is the car's GPS speed alone.

## 2. What this Pi can know about the car, and how fast

From [`telemetry-options.md`](telemetry-options.md):

| Source | Gives | Rate | Usable for an engine? |
|---|---|---|---|
| Browser geolocation (the car's GPS) | speed, heading | about 1 Hz expected while moving. **The Drive run is still not done.** Parked it measured 0.1 Hz, because the car fires only on change. | **Yes.** This is the only real-time source we have. |
| BLE (`tesla-control`, monitor key) | `drive.speed`, `power`, `shiftState` | **~2.9 s per read**, and each read takes one of the car's **three** BLE slots | No. It is too slow, and the docs forbid polling it. |
| Fleet API / HA `tesla_fleet` | the same, from the cloud | ~10 min, and frozen while asleep | No. Cloud values freeze at their last reading while the car sleeps, and a stale speed is worse than none. |
| CAN (Tier 3) | real pedal position, torque, rpm | 10–100 Hz | It would be ideal, but it needs a harness, trim removal and a DBC to maintain. Not now. |
| `DeviceMotionEvent` in the car's browser | acceleration, if any | — | **Not measured.** No motion sensor is documented for the car's browser, and WebGPU and Web Bluetooth were both missing when measured ([`tesla-browser-capabilities.md`](tesla-browser-capabilities.md)). It would be worth one line in a probe page. |

The audio path is settled. The car's browser already plays Web Audio through
the cabin speakers: RetroArch's audio and CarPlay's "Browser" audio mode both do
it. The Pi has **no** audio path into the car of its own, which is why the
RetroArch addon captures its audio on the Pi and streams it to the browser.

## 3. What was chosen, and why

**Synthesis in the car's browser, driven by the car's GPS speed.** This is
TesRev's "Tesla only" mode.

- **The browser is where the speakers are.** Making the sound on the Pi would
  mean streaming PCM over the hotspot and adding a jitter buffer, so the
  latency would get worse, not better. It would also put audio work on the
  CPU that CarPlay needs.
- **Synthesis rather than samples.** We have no recordings we may ship, and a
  sample set needs looping, crossfades and pitch-shifting artefacts to cover
  the rpm range. A synthesised engine is a few kB of numbers. Its pitch is
  exact at every rpm, and load changes the timbre rather than just the
  volume.
- **GPS speed with a physics load model.** Speed is the one signal we have in
  real time. Load comes from how fast it changes, the way TesRev uses mass,
  power and drag: (mass × accel + drag + rolling) ÷ the force available at
  that speed. Negative load is overrun.
- **Nothing on the Pi.** `index.js` is untouched. A bug here cannot hurt CarPlay,
  the hotspot or the cert service. The worst case is a silent page.

### The cost: the engine lags the pedal

With fixes about once a second, the engine hears about a pull **0.5–1.5 s
after the pedal**. A launch from rest is the worst case, because the first
non-zero speed is what tells the engine the car is moving. Between fixes the
engine keeps going at the last acceleration, so a pull sounds continuous
rather than stepped. Acceleration is weighted toward the newest step, so a
lift-off is heard at the next fix. The demo renders and the simulator use a
1 Hz fix rate on purpose, so what you hear at a desk is what the car will do.

Ways to close the gap later, in order of effort:

1. **Measure the Drive fix rate.** Status → Car → This trip shows it. If the
   car does 5–10 Hz while moving, most of the lag goes away for free.
2. **Phone relay**, as TesRev does: a page on the iPhone sends
   `DeviceMotionEvent` to the car's page. The catch is that the iPhone is on the
   CarPlay dongle's Wi-Fi, not the Pi's hotspot, so it has no route to the Pi
   today.
3. **CAN**: real pedal position. This needs hardware (Tier 3).

## 4. How it is built

```
car GPS ─► SpeedTracker ─► v, a ─► loadFromMotion ─► load ─┐
 (or the simulator's pedal)   │                            ▼
                              └──────────────────────► Gearbox / FreeRev ─► rpm, gear, load
                                                                        │ 50 Hz, postMessage
                                                                        ▼
                                                  AudioWorklet: EngineVoice ─► car speakers
```

| File | What |
|---|---|
| `static/rev-model.js` | Pure model: `SpeedTracker` (fixes timed on arrival, never `pos.timestamp`, which the car does not keep as epoch time), `loadFromMotion`, `Gearbox` (a virtual automatic with load-dependent shift points, a kickdown, a short torque cut on upshift, and clutch slip at launch), `FreeRev` (parked revving with a bouncing limiter), and `SimCar`. |
| `static/rev-profiles.js` | Four engines: cross-plane V8 (uneven bank firing, so it burbles), inline-6, V10 and flat-4 (unequal-length headers, so it rumbles). Each one sets its firing pattern, pipe resonances, gearing, redline and pop rate. |
| `static/rev-worklet.js` | The synthesiser, an AudioWorklet. Every cylinder fires once per 720° and sends an exhaust pulse into its bank's resonators. A load-dependent tone filter, induction noise, overrun pops, saturation and a DC blocker follow. It allocates nothing on the audio thread. |
| `static/rev-sound.js` | The controller: AudioContext, worklet, GPS watch, 50 Hz tick, settings (in `localStorage`), and pause when the tab is hidden. |
| `static/rev.html` | The page for settings, gauges and the simulator: `https://<device>/rev.html`. |
| `static/index.html` | Settings → CarPlay → **Engine sound** (Experimental, off). When on, the main page loads the module and starts the engine at the first tap, so it plays under CarPlay. |
| `scripts/rev-render.mjs` | Renders a simulated 45 s drive to a WAV through the same code. |
| `test/rev-*.test.mjs` | 41 tests: tracker, load, gearbox (including no gear hunting), free rev, sim car, firing rate per engine, loudness under load, periodicity, pops only on overrun, determinism, settings. |

### Safety rails

- **Off by default.** The switch is in Settings → CarPlay, or "Play while
  driving" on `rev.html`.
- **Inside the car only.** It plays only through the browser's normal audio
  output. Nothing here touches the Boombox / external speaker, and nothing
  should. Pedestrian-warning sound rules are about the exterior, and this
  does not go there.
- **Rev works only when stopped** (below about 4 km/h). The model ignores it at
  speed, and the page greys it out.
- **No GPS, no engine.** A hidden tab stops the GPS watch and suspends the
  audio. If fixes stop, the engine settles rather than guessing.
- The volume control is squared, so the bottom half of its travel is quiet.
  The page says to keep it low enough to hear horns and sirens.

## 5. Try it

At a desk, with no car and no Pi:

```bash
npm test                                         # 41 tests
node scripts/rev-render.mjs --profile v8         # writes rev-v8.wav, then: open rev-v8.wav
node scripts/rev-render.mjs --profile flat4 --mode sport --fix-ms 100
python3 -m http.server 8000 -d static            # then open http://localhost:8000/rev.html
```

On `rev.html`, pick **Simulator**, press **Start**, then hold **Accelerator** and
**Brake**. "Speed readings" sets the simulated GPS rate. **Rev** blips the engine
while stopped. `localhost` counts as a secure context, so the AudioWorklet loads
just as it does on the car's HTTPS page.

In the car (after deployment): open `https://<device>/rev.html`, choose **Car
GPS**, and turn on **Play while driving**. Or open Settings → CarPlay → Engine
sound on the main page.

## 6. Not yet known, and how to find out

1. **Whether browser audio mixes with Bluetooth music or takes it over.** If
   the car treats the browser as a media source, starting the engine could
   pause Spotify on the phone. RetroArch never had to answer this. Test it
   parked: play music over Bluetooth, then press Rev on `rev.html`.
2. **The GPS fix rate in Drive.** This sets the lag (§3). Read it from Status →
   Car → This trip, or from the "speed readings per second" gauge on
   `rev.html`.
3. **Whether the car's browser keeps playing** when the screen shows the map
   full-screen or another app. `visibilitychange` would pause it, which is the
   right behaviour, but it means no engine unless the browser is on screen.
4. **The sound itself.** The four engines were tuned by numbers and offline
   renders, not by ear in a cabin. The car's speakers and EQ will change them.
   The profiles are plain data, so tuning them is easy.
