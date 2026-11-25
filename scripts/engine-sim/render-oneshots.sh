#!/bin/sh
# render-oneshots.sh <engine script> <name>
#
# Render one engine's start and stop with es-render (build.sh), into
# .cache/engine-sim/out/<name>/ beside its loops (render-set.sh), for
# `node scripts/rev-samples.mjs --oneshots`:
#   start.wav     from rest: cranking, the catch, a flare, idle (6 s)
#   start-hi.wav  the same run 33x louder: engine-sim's cranking is 35-40 dB
#                 under its idle, below what 16 bits hold at the normal gain,
#                 so the cranking is taken from this one
#   stop.wav      idling, the ignition cut, the run-down to rest (1.6 s)
# The simulation does not depend on the gain, so both start renders run
# exactly the same way and can be spliced. Same ES_IR / ES_CONV /
# ES_IDLE_THROTTLE as render-set.sh; the gain is 10x the loops' (their idle
# is barely above the 16-bit floor) and the clips are levelled to the loops
# later anyway.
#   scripts/engine-sim/render-oneshots.sh scripts/engine-sim/ls_v8.mr ls-v8
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
C="$(cd "$HERE/../../.cache/engine-sim" && pwd)"
script=$1; name=$2
out="$C/out/$name"; mkdir -p "$out"
cp "$script" "$C/src/assets/headless_$(basename "$script")"
s="assets/headless_$(basename "$script")"
cd "$C/src"
ES_GAIN=0.006 "$C/build/es-render" "$s" "$out/start.wav" start 6 2>/dev/null
ES_GAIN=0.2 "$C/build/es-render" "$s" "$out/start-hi.wav" start 6 2>/dev/null
ES_GAIN=0.006 "$C/build/es-render" "$s" "$out/stop.wav" stop 1.6 4 2>/dev/null
ls "$out"/start.wav "$out"/start-hi.wav "$out"/stop.wav
