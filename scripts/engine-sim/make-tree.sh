#!/bin/sh
# make-tree.sh <engine-sim clone> <tree out>
#
# Copy the upstream engine-sim sources (github.com/ange-yaghi/engine-sim,
# MIT) into <tree out> and apply the six changes clang on macOS needs. The
# clone itself is never modified. Upstream builds only with MSVC on Windows;
# every change below is about that, none changes what the simulation does.
set -e
U=$1; T=$2
[ -d "$U/src" ] && [ -n "$T" ] || { echo "usage: make-tree.sh <engine-sim clone> <tree out>" >&2; exit 2; }
rm -rf "$T" && mkdir -p "$T/dependencies/submodules"
cp -R "$U/src" "$U/include" "$U/scripting" "$T/"
for d in piranha simple-2d-constraint-solver csv-io; do cp -R "$U/dependencies/submodules/$d" "$T/dependencies/submodules/"; done
cd "$T"

# 1. The synthesizer includes the Windows UI engine (delta-studio) but uses nothing from it.
sed -i '' 's|^#include "../include/delta.h"|/* headless: delta-studio include removed (unused) */|' src/synthesizer.cpp
# 2. Two files include with Windows path separators.
sed -i '' '1s|\\|/|g' src/connecting_rod.cpp src/engine.cpp
# 3. clang rejects a nested struct's default member initializers used as a
#    default argument inside the enclosing class (C++ core issue 1397);
#    the same defaults, as a constructor.
python3 - <<'PY'
p = 'include/gas_system.h'
s = open(p).read()
a = """        struct Mix {
            double p_fuel = 0.0;
            double p_inert = 1.0;
            double p_o2 = 0.0;
        };"""
b = """        struct Mix {
            Mix() : p_fuel(0.0), p_inert(1.0), p_o2(0.0) {}
            Mix(double f, double i, double o) : p_fuel(f), p_inert(i), p_o2(o) {}
            double p_fuel;
            double p_inert;
            double p_o2;
        };"""
assert a in s
open(p, 'w').write(s.replace(a, b))
PY
# 4. Boost 1.85 removed path::is_complete(); is_absolute() is its replacement.
sed -i '' 's/is_complete()/is_absolute()/' dependencies/submodules/piranha/src/path.cpp
# 5. A member template reuses its class template's parameter name (MSVC allows it).
python3 - <<'PY'
p = 'scripting/include/object_reference_node.h'
s = open(p).read()
a = """        template <typename Type>
        void overrideType() {
            m_output.overrideType(LookupChannelType<Type>());
        }"""
b = """        template <typename OverrideType>
        void overrideType() {
            m_output.overrideType(LookupChannelType<OverrideType>());
        }"""
assert a in s
open(p, 'w').write(s.replace(a, b))
PY
# 6. Header constants declared "extern constexpr" (MSVC folds them; clang
#    defines them in every file). C++17 "inline constexpr" is the same value.
for f in $(grep -rl "extern constexpr" include scripting src); do
    sed -i '' 's/extern constexpr/inline constexpr/' "$f"
done
echo "patched tree ready: $T"
