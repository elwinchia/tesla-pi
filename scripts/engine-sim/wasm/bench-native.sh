#!/bin/sh
# bench-native.sh: live.cpp built natively (clang, -O3, NDEBUG as CMake Release, single-threaded:
# ES_SINGLE_THREAD), to compare WebAssembly with native speed on this
# machine. Uses build-wasm.sh's patched tree and generated parser. Prints
# simulated seconds per second for every car and quality.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
C="$HERE/../../../.cache/engine-sim"
T="$C/tree-wasm"; G="$C/build-wasm/gen"; B="$C/bench-native"
mkdir -p "$B"
S=$T/dependencies/submodules
if [ ! -x "$B/bench" ]; then
  # The same sources as CMakeLists.txt: the core list, piranha, the solver, csv-io, the scripting.
  CORE=$(sed -n '/^set(CORE/,/)/p' "$HERE/CMakeLists.txt" | tr -d '()' | sed 's/^setCORE//; s/^set CORE//' | tr -s ' \n' ' ')
  { for c in $CORE; do echo "$T/src/$c.cpp"; done
    ls $S/piranha/src/*.cpp $S/simple-2d-constraint-solver/src/*.cpp $T/scripting/src/*.cpp
    echo $S/csv-io/src/csv_data.cpp; echo $S/csv-io/src/information.cpp; echo $G/parser.auto.cpp; echo $G/scanner.auto.cpp; } > "$B/sources"
  clang++ -std=c++17 -O3 -fdelayed-template-parsing -w -D__forceinline=inline '-D__int64=long long' -DES_SINGLE_THREAD -DNDEBUG \
    -DATG_ENGINE_SIM_PIRANHA_ENABLED -I"$HERE/native-shim" -I"$HERE/../shim" -I"$C/build-wasm/shim" -I"$G" -I"$S/piranha/include" -I"$S" -I"$T" \
    $(cat "$B/sources") "$HERE/live.cpp" "$HERE/bench-native.cpp" -o "$B/bench"
fi
cd "$C/src"
for s in headless_ls_v8 headless_lfa_v10 headless_f136_v8 headless_flat6_gt3; do
  for q in 1 0.75 0.5; do "$B/bench" "assets/$s.mr" "$q"; done
done
