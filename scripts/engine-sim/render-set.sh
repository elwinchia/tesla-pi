#!/bin/sh
# render-set.sh <engine script> <name> <rpm...>
#
# Render one engine's loop set with es-render (build.sh): a free-running
# idle (10 s, long enough to cut a ~5-7 s idle loop from: --fit-idle in
# scripts/rev-samples.mjs), then dyno holds at each rpm at full throttle (on-<rpm>.wav, on-load)
# and closed throttle (off-<rpm>.wav, overrun). Into .cache/engine-sim/out/<name>/.
# The V8 in static/rev-samples.js:
#   scripts/engine-sim/render-set.sh scripts/engine-sim/ls_v8.mr ls-v8 1200 1800 2500 3200 4000 4800 5600 6300
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
C="$(cd "$HERE/../../.cache/engine-sim" && pwd)"
script=$1; name=$2; shift 2
out="$C/out/$name"; mkdir -p "$out"
# Engine scripts import from engine-sim's own folders, so the wrapper is
# placed among them and the renderer runs from the source root.
cp "$script" "$C/src/assets/headless_$(basename "$script")"
s="assets/headless_$(basename "$script")"
cd "$C/src"
# A fixed gain, not engine-sim's automatic leveller, so on-load and overrun
# keep their natural difference in loudness; low enough not to clip.
export ES_GAIN="${ES_GAIN:-0.0006}"
"$C/build/es-render" "$s" "$out/idle.wav" idle 10 4 2>/dev/null
for r in "$@"; do
    "$C/build/es-render" "$s" "$out/on-$r.wav" hold "$r" 1 3 3 2>/dev/null
    "$C/build/es-render" "$s" "$out/off-$r.wav" hold "$r" 0 3 3 2>/dev/null
done
ls "$out"
