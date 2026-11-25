#!/bin/sh
# render-extras.sh [car] [--force]
#
# Render what the recorded mix's options need (static/rev-samples.js:
# denseRpm, partThrottle, oneShots, longLoops) for one car (a key of
# SAMPLE_SETS: v8, lfa, f136, gt3) or all of them, the three ways each
# (engine and exhaust impulse responses, and dry for the sub layer), into
# .cache/engine-sim/out/<name>/ beside the car's own renders. It runs one
# es-render per core. What it renders, and why, is in
# scripts/rev-samples.mjs (--render-extras); the order of the whole job is in
# scripts/engine-sim/README.md ("The options' renders").
#   scripts/engine-sim/render-extras.sh v8
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/../rev-samples.mjs" --render-extras "$@"
