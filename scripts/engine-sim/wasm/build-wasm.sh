#!/bin/sh
# build-wasm.sh: engine-sim (github.com/ange-yaghi/engine-sim, MIT, pinned to
# the commit the loops came from) compiled to WebAssembly for live engine-sim
# in the car's browser (static/rev-live.js). Writes static/live/:
#   engine-sim.js, engine-sim.wasm    the module (single-threaded, no Boost)
#   engine-sim-data.json              the 4 engine scripts and only the
#                                     engine-sim files they import
#   ir-engine.wav, ir-exhaust.wav     the two impulse responses the loops use
#   LICENSE-engine-sim.txt            engine-sim's MIT licence
#
# Toolchain: Emscripten from the official emsdk
# (github.com/emscripten-core/emsdk, the route on emscripten.org's
# "Download and install" page), pinned below, in .cache/emsdk (git-ignored).
# Host tools as for the native build (build.sh): flex (system), bison
# (Homebrew), python3, node. Takes ~2 min from clean.
set -eu
EMSDK_REPO=https://github.com/emscripten-core/emsdk
EMSDK_VERSION=6.0.13   # released 2026-10-19
REPO=https://github.com/ange-yaghi/engine-sim
COMMIT=85f7c3b
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
C="$ROOT/.cache/engine-sim"
mkdir -p "$C"

# Emscripten, pinned.
E="$ROOT/.cache/emsdk"
if [ ! -d "$E/.git" ]; then git clone "$EMSDK_REPO" "$E"; fi
[ "$(git -C "$E" remote get-url origin)" = "$EMSDK_REPO" ] || { echo "$E is not $EMSDK_REPO" >&2; exit 1; }
if ! "$E/emsdk" list 2>/dev/null | grep -q "$EMSDK_VERSION.*INSTALLED"; then "$E/emsdk" install "$EMSDK_VERSION"; fi
"$E/emsdk" activate "$EMSDK_VERSION" >/dev/null
# shellcheck disable=SC1091
. "$E/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1

# The official engine-sim clone, as build.sh makes it.
if [ ! -d "$C/src/.git" ]; then git clone --recurse-submodules "$REPO" "$C/src"; fi
[ "$(git -C "$C/src" remote get-url origin)" = "$REPO" ] || { echo "$C/src is not $REPO" >&2; exit 1; }
git -C "$C/src" checkout -q "$COMMIT"
git -C "$C/src" submodule update --init --recursive -q

# A separate copy: make-tree.sh's clang patches, then the WASM ones.
"$ROOT/scripts/engine-sim/make-tree.sh" "$C/src" "$C/tree-wasm"
python3 "$HERE/patch-tree.py" "$C/tree-wasm"

# The script compiler's scanner and parser, generated on the host (as the
# native build does), with the FlexLexer.h that matches the host flex.
B="$C/build-wasm"; G="$B/gen"; S="$B/shim"
mkdir -p "$G" "$S"
cp /Library/Developer/CommandLineTools/usr/include/FlexLexer.h "$S/"
P="$C/tree-wasm/dependencies/submodules/piranha/flex-bison"
flex -o "$G/scanner.auto.cpp" --header-file="$G/scanner.auto.h" "$P/scanner.l"
"$(brew --prefix bison)/bin/bison" -d -o "$G/parser.auto.cpp" --defines="$G/parser.auto.h" "$P/specification.y"

# ES_CFLAGS: -msimd128 lets clang vectorise loops with WebAssembly SIMD
# (Chromium 91+, Node 16+).
emcmake cmake -S "$HERE" -B "$B" -DES_TREE="$C/tree-wasm" -DES_SHIM="$S" -DES_GEN="$G" \
    -DES_CFLAGS="${ES_CFLAGS:--msimd128}" -Wno-dev >/dev/null
cmake --build "$B" -j 8

OUT="$ROOT/static/live"
mkdir -p "$OUT"
cp "$B/engine-sim.js" "$B/engine-sim.wasm" "$OUT/"
{ echo "engine-sim, $REPO, commit $COMMIT: MIT licence. static/live/ ships it compiled"; echo "(engine-sim.js, engine-sim.wasm), with its engine scripts and impulse responses."; echo; cat "$C/src/LICENSE"; } > "$OUT/LICENSE-engine-sim.txt"
node "$HERE/make-bundle.mjs" "$C/src" "$OUT"
ls -l "$OUT"
