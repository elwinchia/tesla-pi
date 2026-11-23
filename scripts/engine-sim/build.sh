#!/bin/sh
# build.sh — build es-render, a headless offline renderer for engine-sim.
#
# Everything goes in .cache/engine-sim/ (git-ignored): the official source
# (github.com/ange-yaghi/engine-sim, MIT, pinned below), a patched copy of
# it (make-tree.sh), and the build. Needs: cmake, boost, bison (Homebrew;
# the names come from engine-sim's README), the system flex and clang.
set -eu
REPO=https://github.com/ange-yaghi/engine-sim
COMMIT=85f7c3b
HERE="$(cd "$(dirname "$0")" && pwd)"
C="$HERE/../../.cache/engine-sim"
mkdir -p "$C"
C="$(cd "$C" && pwd)"

if [ ! -d "$C/src/.git" ]; then
    git clone --recurse-submodules "$REPO" "$C/src"
fi
# Only ever the official repository, at the commit the loops came from.
[ "$(git -C "$C/src" remote get-url origin)" = "$REPO" ] || { echo "$C/src is not $REPO" >&2; exit 1; }
git -C "$C/src" checkout -q "$COMMIT"
git -C "$C/src" submodule update --init --recursive -q

"$HERE/make-tree.sh" "$C/src" "$C/tree"
# FlexLexer.h must match the flex that generates the scanner: the system
# one ships with the Command Line Tools, not with piranha's Windows copy.
mkdir -p "$C/shim"
cp /Library/Developer/CommandLineTools/usr/include/FlexLexer.h "$C/shim/"

BISON=$(brew --prefix bison)/bin/bison
cmake -S "$HERE" -B "$C/build" -DES_TREE="$C/tree" -DES_SHIM="$C/shim" -DBISON_EXECUTABLE="$BISON" -Wno-dev >/dev/null
cmake --build "$C/build" -j 8
echo "built $C/build/es-render"
