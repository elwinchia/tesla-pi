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

## History: the removed cars

The first version offered eight cars. Seven were synthesised from numbers by
a source–filter model (cross-plane V8, V12, flat-6, inline-6, rotary, turbo 4,
V10 and flat-4). Three of them also played Freesound recordings. The owner
found all of them fake and asked for them to be removed; only the engine-sim
V8 remains. What the recordings were, and the research behind choosing them,
is kept below for reference.

### The recordings that were used (removed)

The owner asked whether the sounds could come from TesRev or other engine
sound projects. Not TesRev's: they are its own and come with no licence to
reuse. But real recordings under a licence that allows reuse in this public
repository can, and three cars now use them.

**The bar.** A recording is used only if all of these hold:

- the person who uploaded it recorded it themselves;
- it is CC0 or CC BY (never NC, ND, Sampling+ or unclear, never from a game,
  app, video or commercial product);
- its page or tags identify the engine, or its harmonics do;
- it has steady stretches at **two or more rpm** of one engine: idle alone
  cannot be pitched convincingly across a rev range;
- the engine is not buried under crowds, other engines or wind.

**Where the files come from.** Freesound's own page for each sound. Without a
login Freesound serves a 128 kbit/s MP3 preview of every sound (the original
file needs an account), and that preview is what was fetched, on 2026-11-23,
from the address recorded in each credit. `scripts/rev-samples.mjs` fetches
from exactly those addresses and nothing else.

| Car | Recording | Author | Licence | Loops (rpm) |
|---|---|---|---|---|
| V12, Italian GT | [Lambo idle and rev.mp3](https://freesound.org/people/cheesepuff/sounds/112075/): a Murciélago LP 670-4 SuperVeloce at a dealer | cheesepuff | CC0 1.0 | 1,184 (fast idle), 2,904 |
| Turbo 4, hot hatch | [Car Engine Contact Recording-Mini Cooper S 2019.wav](https://freesound.org/people/TheLittleCrow/sounds/669618/): contact mics on the engine block, driven in sport mode | TheLittleCrow | CC0 1.0 | 900, 2,988, 3,744, 4,842, 5,541 |
| V10, supercar | [Audi R8 Idling Reving Backfire.wav](https://freesound.org/people/Jonas_Jocys/sounds/457733/): idle and holds at several rpm | Jonas_Jocys | **CC BY 4.0** | 806, 1,930, 2,777, 4,070 |

The CC BY recording is credited on its card in the picker, in the credits
line under it, and in `static/sounds/CREDITS.md`.

**How each loop was cut.** Each recording's spectrum was read at high
resolution (2.7 Hz per bin) to find stretches where the engine holds a speed
within a few percent. Its rpm comes from the spacing of its harmonics and
the engine's firing order: the 3rd order (one bank) of the V12, the 2nd
order (the firing rate) of the four, and the 2.5th order (one bank) of the
V10. The R8 page does not say whether it is the V8 or the V10. In every hold,
the strongest lines are the 2.5th and 5th orders, the pattern of a V10 (a V8
fires on the 4th), so it is filed as the V10. Each stretch is made to loop by
crossfading its end into its start, levelled (louder with revs), and padded
with 20 ms of its own wrap-around so the codec's edges never fall in the
seam. Every seam was checked after encoding: no step at a seam is larger
than the loop's largest ordinary step.

**How it plays.** The player follows the same rpm as the synthesiser (GPS,
Test drive or the finger). Between two recorded rpm points it crossfades;
past the last one it pitches the top loop up, at most 3.2×. The V12's top
loop is 2,904 rpm, so its top end is the most stretched. All loops are
"under load or idle" (single layer): none of the recordings has a long enough
lift-off at a steady rpm for an off-load layer. **Recorded sounds** in the
Sound card switches every car back to the synthesiser; if the files cannot
be loaded, the synthesiser plays and the page says so.

**What was rejected, and why.**

| Source | Why not |
|---|---|
| TesRev | Its own sounds, published with no licence to reuse. |
| [engine-sim](https://github.com/ange-yaghi/engine-sim) (MIT) | Its `sound-library` holds impulse responses for its convolution stage, not recordings of engines. |
| OpenGameArt engine loops | "Racing car engine sound loops" has its licence questioned in its own comments; the CC0 alternatives are synthesised or made with a mouth. |
| Freesound, Sampling+ (a retired licence, not CC0 or CC BY) | djbono's Ferrari 456 V12 and Porsche 911T, Fuser10's rotary engine. |
| Freesound, NC | FritzSounds' Porsche 911 GT3 Cup (CC BY-NC). |
| Freesound, licence fine, recording not | Hot-rod V8 at Summernats (Ears68, CC BY 3.0): festival ambience, other engines running under it. Parade of open-header V8s (holderall, CC0): several cars and a crowd. "Classic Car Idle", a 350 Rocket V8 (jackthemurray, CC0): idle only. Ford 460 V8 (Henaway, CC0): one 3.7 s blip. Subaru WRX (ulose2piranha, CC0): a clean idle, but the revs are blips with no hold. VW Golf GTI (EverydaySounds, CC0): drive-aways past the mic. BMW M6 (Kinoton, CC0): a V10 or V8, not an inline-6, and driving away. The Murciélago's 5 s clip (cheesepuff, CC0): one blip. Lamborghini start-up (florianreichelt, CC0), "Porsche idle" (victormalloy, CC0), "Supercar rev" (richwise, CC0), Lotus (wikusv, CC BY 4.0): the engine is not identified. 2012 Civic (thepodcastdoctor, CC0): not turbocharged. Drag cars (lonemonk, CC BY 4.0): several cars at once. |

**Cars with no usable recording:** **V8** (no recording of one V8 with
steady stretches at two rpm; it now uses engine-sim, below), **Flat-6** (the
911 recordings are Sampling+ or NC), **Inline-6** (none found), **Rotary**
(the only rotary is Sampling+) and **Flat-4** (the WRX has only its idle
steady). The bar was not lowered for them.

