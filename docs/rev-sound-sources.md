# Engine sound: why it sounded fake, and where better sound can come from

Research from 2026-11-23. The engine-sim option was adopted for the V8
(`scripts/engine-sim/`, `docs/rev-sound.md`); the rest is kept for later choices.

## 1. Why it sounds fake

Most likely causes, in order:

1. **The recorded cars have too few rev points, pitched too far.**
   - Each car has only 2 to 5 loops. Convincing game engines use 6 to 12, and keep each loop within about ±15 % of its own pitch.
   - Ours stretch much further:

     | Car | Worst stretch | Where |
     |---|---|---|
     | V12 | 3.0× | at its redline |
     | V10 | 2.1× | at its redline |
     | Turbo 4 | 1.8× | between idle and 3,000 rpm |

   - Stretching a recording that far moves its resonances along with its pitch: the tape-at-the-wrong-speed, chipmunk sound.
2. **No overrun sound.**
   - Real engines sound completely different when you lift off: the engine-sim render shows overrun 15–30× quieter than full load, with a different timbre.
   - Our recorded loops have a single layer, so lifting off just plays the same loop quieter.
   - Game engines always ship separate on-load and off-load loops at every rev point.
3. **Weak source recordings.**
   - The V12 was filmed on a phone in a showroom.
   - The Turbo 4 is a contact microphone on the engine block, which is not an exhaust sound.
   - All three are 128 kbit/s previews, cut into 0.9–2 s loops.
4. **The synthesised cars are a simple source–filter model.**
   - Every firing is the same pulse into fixed resonators, plus a little noise.
   - There's no gas dynamics, no valve or mechanical noise, and no real intake or exhaust behaviour, so it reads as a synth.
5. **The input is slow (true for any sound).**
   - The engine follows the car's GPS speed about once a second, so the note lags the pedal by 0.5–1.5 s and moves in steps.
   - On/off load is guessed from acceleration.
   - Even perfect samples will feel detached from the pedal while driving. Parked, in simulation mode, sound quality is all that matters.

## 2. Free, licence-clean options

### a. engine-sim: prototyped, works on this Mac, output is ours to ship

- **Source:** `ange-yaghi/engine-sim` (MIT).
  - The README says Windows only, but that only applies to the UI. The simulation core builds headless on Apple Silicon from the official source with six small portability patches. No Windows VM is needed.
  - Its successor, `Engine-Simulator/engine-sim-community-edition`, is binaries only with no licence, so it isn't usable here.
- **Rendering:** a small driver (`scripts/engine-sim/`) holds the engine on its dynamometer at any rpm:
  - full throttle gives the on-load sound;
  - closed throttle with the dyno turning the engine gives overrun;
  - a free-running idle is rendered separately.
- **V8 prototype (the bundled GM LS V8):**

  | | |
  |---|---|
  | Rev points | idle + 8 (700 to 6,300 rpm), each with on-load and overrun loops |
  | Loops | 17, 192 kB as Opus 64 kbit/s |
  | Render time | about 90 s on this Mac |
  | Worst stretch | 1.31× (around idle), about 1.2× elsewhere |

  - **Firing rate matches:** 214 Hz at 3,200 rpm, 420 Hz at 6,300.
  - **On-load and overrun differ** as they should.
- **Bundled engines:**
  - V8: GM LS, Ferrari F136 (flat-plane), Chevy 454
  - V10: Lexus LFA
  - Inline-6: Toyota 2JZ, BMW M52
  - Flat-4: Subaru EJ25
  - V12: Ferrari 412 T2 (an F1 engine), Rolls-Royce Merlin (an aircraft engine)
  - Others: Audi I5, Honda VTEC I4
- **Gaps:**
  - **No flat-6:** a flat-6 can be written as an engine script.
  - **No rotary:** engine-sim models piston engines only.
- **Licence:** MIT. Rendered audio is ours to commit to the public repo; we'd credit engine-sim in `CREDITS.md`.
- **How it would sound:** physically modelled and consistent. Pitch, load and overrun behave like an engine, but it is still a simulation, and some people hear it as slightly "digital". Judge it by ear from the demo.

### b. Sonniss GDC Game Audio Bundles (free)

- **Content:** high quality, but each year's bundle differs by vendor, and I could not confirm any game-ready engine rpm loop set in them.
- **Licence:** v2.0, read on sonniss.com.
  - Use inside your own project is allowed.
  - Distributing or publishing the sounds as sound effects, modified or not, is forbidden.
  - The licence also excludes "supplying the sound effects themselves, whether as files or as the output of a device or service".
- **So:** private to the owner's Pi only, never in the public repo or the public SD image. Even private use is borderline, because the product here *is* the sound. Not recommended.

### c. Freesound originals instead of the previews

- **Needs:** the owner's free Freesound login.
- **Gain:** lossless WAVs instead of 128 kbit/s MP3, so a cleaner top end and no MP3 smearing.
- **But:** it fixes none of causes 1–3 above (too few rev points, no overrun, weak recordings). Low value.

## 3. Paid game-ready packs (not bought)

| Pack | Price | Covers | Structure | Licence |
|---|---|---|---|---|
| Skril Studio (slaczky) **V8 Engine Sounds**, GameDev Market | $60 | 6 V8s (American Classic, American Modern ×2, Formula, Italian ×2) | idle, 7 rpm bands each on- and off-throttle, limiter, start/stop, interior and exterior; 44.1 kHz WAV | GameDev Market Pro: use inside your product; no redistribution outside it, and users may not extract the files |
| Skril Studio **Exotic Cars Engine Sounds** | $100 | V8 ×3, **V10** (Italian 5.2), **V12** ×4, W16, **flat-6** (German 4.0) | same | same |
| Same author, single-engine packs | i4 $40, Japanese i6 $20, V12 $20, German V8 $40, Rally $30; Rotary (6 engines) on Fab, priced once a licence is chosen | | same | same / Fab Standard |
| Magic Sound Effects **Car Engines Vol. 1**, itch.io | $25 | 14 generic cars (city, sports, diesel, off-road) | 5 rpm loops each, no on/off split; acceleration and deceleration clips | personal use and one commercial project; no standalone redistribution |
| Pole Position Production (pole.se) | about $149–249 per car | real cars recorded on a dyno, engine, exhaust and interior microphones | professional library | professional licence, no redistribution |

- **Coverage:** Skril's Exotic plus V8 packs ($160) cover our V8, V10, V12 and flat-6. Adding the i4, i6 and rotary packs (about $90 more) covers all eight cars for about $250.
- **Unknown:** whether Skril's loops are recordings or designed sound. Listen to the demo videos linked from each listing before buying.
- **Distribution:** all paid packs (and Sonniss) must stay **out of git and off the public image**. The design for that:
  - a git-ignored `static/sounds-private/` holding the loops plus a `manifest.json` in the same shape as `SAMPLE_SETS`;
  - the page fetches `/sounds-private/manifest.json` and, if it exists, prefers those cars, otherwise it uses the public ones;
  - the deploy syncs only that folder to the owner's Pi (no restart needed);
  - credits for private sounds stay in that manifest, not in the public `CREDITS.md`.

## Recommendation

1. **Do now, free:** replace the synthesised cars with engine-sim renders.
   - V8 (LS), V10 (LFA), inline-6 (2JZ), flat-4 (EJ25), turbo 4 (VTEC I4, plus our turbo whistle), and V12 if the F1 412 T2 suits.
   - About 9 rev points × on/off per car, roughly 1.5 MB for all.
   - It ships in the public repo and gives the biggest jump for no money.
   - Rotary stays synthesised, and the flat-6 needs a written engine script.
   - Retire the weak recorded V12 at the same time, and probably the V10 and Turbo 4 too.
2. **If the owner wants real-car realism and accepts private-only files:** buy Skril's Exotic ($100) and V8 ($60) packs after listening to their demos. I'd add the `sounds-private/` route above.
3. **Skip:** Sonniss (licence, and no confirmed engine loops) and Freesound originals (small gain).

Whatever the source, the 1 Hz GPS lag will keep driving sound slightly detached from the pedal. Parked, in simulation mode, the new sound would be heard at its best.
