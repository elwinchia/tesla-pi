# engine-sim, headless, for rendering engine loops

[engine-sim](https://github.com/ange-yaghi/engine-sim) by AngeTheGreat (MIT)
is a physically modelled combustion engine that produces audio. Its own
README says it builds only on Windows. That's true of its UI, but its
simulation core builds on macOS (Apple Silicon included) with clang, after
six small portability patches. This folder builds it with no window and no
audio device, as `es-render`, and renders the loops that `static/sounds/v8-es-*`
are cut from. The renders are our own output; engine-sim is credited in
`static/sounds/CREDITS.md`.

Nothing here runs on the Pi or in the car. Only the finished `.ogg` loops ship.

## Build and render

```bash
brew install cmake boost bison                      # names from engine-sim's README
scripts/engine-sim/build.sh                         # clone (pinned), patch a copy, build: ~1 min
# The V8: through engine-sim's "real engine" exhaust impulse response...
ES_IR=es/sound-library/archive/test_engine_14_eq_adjusted_16.wav \
  scripts/engine-sim/render-set.sh scripts/engine-sim/ls_v8.mr ls-v8 1200 1800 2500 3200 4000 4800 5600 6300
# ...through its "minimal muffling" response, for the exhaust group...
ES_IR=es/sound-library/new/minimal_muffling_01.wav \
  scripts/engine-sim/render-set.sh scripts/engine-sim/ls_v8.mr ls-v8-exhaust 1200 1800 2500 3200 4000 4800 5600 6300
# ...and dry (no impulse response), for the low sub layer under both
ES_CONV=0 scripts/engine-sim/render-set.sh scripts/engine-sim/ls_v8.mr ls-v8-dry 1200 1800 2500 3200 4000 4800 5600 6300
node scripts/rev-samples.mjs --fit-idle v8           # the idle's real rpm and loop lengths (its `idle`)
node scripts/rev-samples.mjs --print-levels v8       # the levels static/rev-samples.js holds
node scripts/rev-samples.mjs --car v8                # cut, loop, EQ, mix the sub, level, encode into static/sounds/

# The other cars, the same three ways each (run in sh: zsh does not split $P):
#   lfa_v10.mr -> lfa-v10, f136_v8.mr -> f136-v8   P="1300 2000 2800 3700 4600 5600 6700 7800 8800"
#   flat6_gt3.mr -> flat6-gt3                      P="1400 2100 2900 3800 4800 5800 6800 7800 8800"
# The F136 stalls at a closed throttle: re-render its three idle.wav files with
# ES_IDLE_THROTTLE=0.02 (es-render ... idle 10 4).
```

The engine starting and stopping, the same three ways (`ES_IR` as above for the
engine and exhaust groups, `ES_CONV=0` for the sub; the F136 with
`ES_IDLE_THROTTLE=0.02`), then the clips:

```bash
ES_IR=es/sound-library/archive/test_engine_14_eq_adjusted_16.wav scripts/engine-sim/render-oneshots.sh scripts/engine-sim/ls_v8.mr ls-v8
ES_IR=es/sound-library/new/minimal_muffling_01.wav scripts/engine-sim/render-oneshots.sh scripts/engine-sim/ls_v8.mr ls-v8-exhaust
ES_CONV=0 scripts/engine-sim/render-oneshots.sh scripts/engine-sim/ls_v8.mr ls-v8-dry
node scripts/rev-samples.mjs --oneshots v8      # static/sounds/v8-e[sx]-{start,stop}.ogg
```

Everything lands in the git-ignored `.cache/engine-sim/`:

| Path | What |
|---|---|
| `src/` | the official clone, commit `85f7c3b`, with submodules. `build.sh` refuses any other origin. |
| `tree/` | a patched copy of it (`make-tree.sh`); the clone itself is never modified |
| `build/es-render` | the renderer |
| `out/<name>/` | renders: `idle.wav`, `on-<rpm>.wav`, `off-<rpm>.wav` |

A set of idle plus 8 rpm points renders in about 90 s. The same commands
give the same files: the committed loops were checked against a fresh
build and render.

## What `es-render` does

`render.cpp` is the driver. It compiles an engine script, starts the engine
(ignition, then 1.5 s on the starter), and then:

- **`hold <rpm> <throttle> <s> [warmup]`**: the dynamometer holds the engine
  at `rpm`. Throttle 1 is full load (the on-load loop). Throttle 0 means the
  dyno drives a closed-throttle engine (the overrun loop).
- **`idle <s> [warmup]`**: free-running, closed throttle, no dyno. Rendered
  10 s long: the idle loop is cut from it by `--fit-idle` (below).
- **`rev <s>`**: idle, two blips and a sweep into the limiter, for listening.
- **`start <s>`**: from rest: a moment of silence, the starter cranking with the
  ignition off (`ES_CRANK`, 0.5 s), then the ignition on with the throttle
  cracked open until it catches (revs well past the starter's own speed), a
  0.3 s flare (`ES_FLARE`, 0.25) and idle. Recorded from the start.
- **`stop <s> [warmup]`**: idle, then the ignition cut at 0.4 s and the run
  down to rest.

## The start and stop clips

engine-sim models combustion and the exhaust, not the starter motor: its
cranking is 35-40 dB under its idle, below what 16 bits hold at the loops'
gain. `render-oneshots.sh` renders the start twice, at 10x and at 330x the
loops' gain. The simulation does not depend on the gain, so the two runs are
the same and can be spliced. `--oneshots` then:

1. Takes the cranking from the loud run, up to the catch (the first 50 ms
   louder than the idle), set to 0.3x the idle, so engine-sim's own
   compression chuffs are heard.
2. Synthesises a starter motor over it: the solenoid's clunk in and out, a
   ~380 Hz whine that spins up and labours once per compression, and a little
   gear grind.
3. Holds the flare under 2.6x the idle and lifts the fall after it to at least
   0.6x. The loops' levels are square-rooted, so an untouched flare would be
   ten times louder than anything else the engine does, and the
   closed-throttle fall as quiet as its overrun.
4. Levels the clip so its idle is exactly the idle loop's level, with the same
   EQ and sub layer as the loops. The player hands over to the loops in the
   clip's last 0.6 s.

The stop needs none of this: the ignition cuts, the last firings gasp, and
it is silent within half a second, as a real one is.

It drives engine-sim's synthesizer thread the way the app does: one block
of simulation per frame, then wait until the synthesizer has turned it into
audio. Nothing is dropped and nothing is padded.

- **Levels:** `ES_GAIN` sets a fixed gain instead of engine-sim's automatic
  leveller, so on-load and overrun keep their natural difference in loudness.
  At closed throttle the engine is 15–30× quieter than at full load, so idle
  needs care. `rev-samples.js` stores each loop's level relative to the
  loudest on-load loop.
- **Idle throttle:** `ES_IDLE_THROTTLE` opens the throttle a little in
  `idle` mode, for engines that stall shut (the F136, at 0.02).
- **Impulse response:** `ES_IR` swaps the exhaust impulse response for every
  exhaust (a 16-bit WAV, relative to the source root), and `ES_CONV` sets how
  much of it is mixed in (0 = dry).
  - The LS V8 script's own `smooth_39` is centred on 320–640 Hz and left the V8
    thin. engine-sim's "real engine" response (`archive/test_engine_14_eq_adjusted_16.wav`,
    its `real_engine_0`) has the body at 80–160 Hz.
  - Both responses strip the lowest octave. That is why `rev-samples.js` mixes a
    low-passed dry render under the main one (`sub`), and lifts the bottom
    octave with a shelf (`eq`).
- **Pinning the gain:** the leveller's min and max are read only at start-up,
  but its target is read every sample. An unreachable target therefore holds
  it at its maximum gain, and `ES_VOLUME` / `ES_GAIN` scale that.

## The idle loop

A free-running idle is not a steady tone. It never runs at exactly the rpm
asked for (the LS V8 idles at ~690, not 700), it wanders a few percent, and
the LS lopes. The rev points are cut to whole cycles at their rpm, which
works because the dyno holds them there. Cut the same way, a 1.5 s idle
loop wrapped 25-50 % of a firing out of step at every lap, and the seam's
crossfade blended two out-of-step firings: a stumble every 1.5 s.

`node scripts/rev-samples.mjs --fit-idle <car>` fixes that. It measures the
idle's real rpm (the 720° cycle, by autocorrelation of the dry render) and,
for each group, finds the loop length (around 5.5 s) where both that group's
render and the dry sub layer repeat best over the crossfade. The set's
`idle: { rpm, start, seconds: { engine, exhaust } }` holds the result, the
loop is played at exactly that length (`exact`), and the car's profile idles
at the same rpm, so the idle plays at its own pitch. Seam match (correlation
over the crossfade, 1 = perfect) went from -0.44 to +0.25 for the old loops
to 0.63-0.97 for the fitted ones.

## The six patches (`make-tree.sh`)

All are about MSVC versus clang; none changes what the simulation does.

1. **`src/synthesizer.cpp`:** drop `#include "../include/delta.h"`. It pulls in
   delta-studio, the Windows/DirectX UI engine, and nothing from it is used.
2. **`src/connecting_rod.cpp`, `src/engine.cpp`:** their first `#include` uses
   Windows `\` separators.
3. **`include/gas_system.h`:** `GasSystem::Mix`'s default member initialisers
   become a constructor with the same values. clang rejects them where the
   struct is a default argument inside its enclosing class (C++ core issue 1397).
4. **piranha `src/path.cpp`:** Boost 1.85 removed `path::is_complete()`; it
   becomes `is_absolute()`, its replacement.
5. **`scripting/include/object_reference_node.h`:** a member template reused
   its class template's parameter name; it is renamed.
6. **`include/units.h`, `include/constants.h`:** `extern constexpr` constants
   in headers become C++17 `inline constexpr`. MSVC folds them; clang defines
   them in every file.

Build-file settings that do the rest, with no source changes:

- `__forceinline` and `__int64` are defined for clang.
- `-fdelayed-template-parsing` is on.
- `shim/malloc.h` stands in for the header macOS doesn't have.
- `FlexLexer.h` is taken from the Command Line Tools, to match the system
  flex, instead of piranha's bundled Windows copy.
- googletest and the dependencies' test builds are left out.

## Adding an engine

engine-sim bundles these engine scripts (`assets/engines/`):

- **V8:** GM LS, Ferrari F136 (flat-plane), Chevy 454
- **V10:** Lexus LFA
- **Inline-6:** Toyota 2JZ, BMW M52
- **Flat-4:** Subaru EJ25
- **V12:** Ferrari 412 T2 (F1), Rolls-Royce Merlin (aircraft)
- **Other:** Audi I5, Honda VTEC I4, and more

It has no flat-6, so `flat6_gt3.mr` is ours: a 4.0 L, 9,000 rpm boxer six
written on the pattern of the Subaru EJ25 script, with its crank and firing
geometry worked out in its header. There is no rotary (engine-sim models
piston engines only).

To add one:

1. Write a two-line wrapper like `ls_v8.mr`.
2. Render with `render-set.sh`.
3. Add a set to `static/rev-samples.js` like `v8`, with its `ir`, `eq` and
   `sub` if wanted. Fill in the levels from
   `node scripts/rev-samples.mjs --print-levels <key>`: the square root of each
   loop's RMS over the loudest on-load loop's, with idle at 0.6 × the lowest
   on-load loop.
4. Build with `node scripts/rev-samples.mjs --car <key>`.
