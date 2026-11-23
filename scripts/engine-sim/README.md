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
scripts/engine-sim/render-set.sh scripts/engine-sim/ls_v8.mr ls-v8 1200 1800 2500 3200 4000 4800 5600 6300
node scripts/rev-samples.mjs --car v8                # cut, loop, level, encode into static/sounds/
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
- **`idle <s> [warmup]`**: free-running, closed throttle, no dyno.
- **`rev <s>`**: idle, two blips and a sweep into the limiter, for listening.

It drives engine-sim's synthesizer thread the way the app does: one block
of simulation per frame, then wait until the synthesizer has turned it into
audio. Nothing is dropped and nothing is padded.

- **Levels:** `ES_GAIN` sets a fixed gain instead of engine-sim's automatic
  leveller, so on-load and overrun keep their natural difference in loudness.
  At closed throttle the engine is 15–30× quieter than at full load, so idle
  needs care. `rev-samples.js` stores each loop's level relative to the
  loudest on-load loop.
- **Pinning the gain:** the leveller's min and max are read only at start-up,
  but its target is read every sample. An unreachable target therefore holds
  it at its maximum gain, and `ES_VOLUME` / `ES_GAIN` scale that.

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

It has no flat-6 (one would have to be written) and no rotary (engine-sim
models piston engines only).

To add one:

1. Write a two-line wrapper like `ls_v8.mr`.
2. Render with `render-set.sh`.
3. Add a set to `static/rev-samples.js` like `v8`: compute the levels the
   same way, as the square root of each loop's RMS over the loudest on-load
   loop, with idle at 0.6 × the lowest on-load loop.
4. Build with `node scripts/rev-samples.mjs --car <key>`.
