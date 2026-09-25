#!/bin/bash
# test-clock-helper.sh — offline test for tesla-pi-clock's argument filter.
#
# The filter is the whole safety story: sudo lets the service user run this
# helper with any argument, so the helper alone decides what the system clock
# can be set to. This runs it against everything it must refuse — empty,
# non-numeric, wrong length, a leading zero, before the floor, after the
# ceiling — and the two things it must do on a good value: call `date -s` with
# the right instant, and stamp systemd's boot-time clock file only when that
# file already exists.
#
# Runs anywhere: `date` and `touch` are stubbed, so nothing here needs root or
# GNU coreutils, and no clock is ever touched.
#
# Run: bash scripts/test-clock-helper.sh

set -uo pipefail

HELPER="$(cd "$(dirname "$0")" && pwd)/tesla-pi-clock"
[[ -r "$HELPER" ]] || { echo "missing $HELPER"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1));
       else echo "  FAIL $1"; echo "        want: $3"; echo "        got:  $2"; fail=$((fail+1)); fi; }

mkdir -p "$TMP/bin"
# `date +%s%3N` answers a fixed instant; `date -u -s <arg>` records the arg and
# succeeds unless DATE_FAIL is set. Anything else is a bug in the helper.
cat > "$TMP/bin/date" <<'STUB'
#!/bin/bash
case "$1" in
    +%s%3N) echo 1758764000123 ;;
    -u) [[ "$2" == "-s" ]] || { echo "unexpected date args: $*" >&2; exit 99; }
        echo "$3" >> "$DATE_LOG"
        [[ -n "${DATE_FAIL:-}" ]] && exit 1
        exit 0 ;;
    *) echo "unexpected date args: $*" >&2; exit 99 ;;
esac
STUB
cat > "$TMP/bin/touch" <<'STUB'
#!/bin/bash
echo "$*" >> "$TOUCH_LOG"
STUB
chmod +x "$TMP/bin/date" "$TMP/bin/touch"
export PATH="$TMP/bin:$PATH"
export DATE_LOG="$TMP/date.log" TOUCH_LOG="$TMP/touch.log"

run() {  # run <clock_file> <args...> → "<exit> <stdout>"
    local cf="$1"; shift
    : > "$DATE_LOG"; : > "$TOUCH_LOG"
    local out
    out="$(TESLAPI_TIMESYNC_CLOCK="$cf" bash "$HELPER" "$@" 2>/dev/null)"
    echo "$? $out"
}
error_of() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("error"))' "$1"; }

MISSING="$TMP/no-such-clock"
PRESENT="$TMP/clock"; : > "$PRESENT"
GOOD=1790296934107   # 2026-09-25T00:42:14.107Z

echo "refusals (nothing may reach date -s)"
for c in "no verb::" "unknown verb:status:" "empty:set:" "not a number:set:tomorrow" \
         "seconds not ms:set:1790296934" "14 digits:set:17902969341070" "signed:set:+790296934107" \
         "decimal:set:1790296934.10" "below floor (2023):set:1700000000000" \
         "leading zero:set:0790296934107" "above ceiling (2100):set:4102444800001"; do
    IFS=: read -r name verb arg <<<"$c"
    args=(); [[ -n "$verb" ]] && args+=("$verb"); [[ -n "$arg" ]] && args+=("$arg")
    # ${args[@]+...}: under set -u, bash 3.2 (macOS) calls an empty array unbound.
    r="$(run "$MISSING" ${args[@]+"${args[@]}"})"
    ok "$name → exit 2" "${r%% *}" "2"
    ok "$name → date -s never called" "$(wc -l < "$DATE_LOG" | tr -d ' ')" "0"
done

echo "boundaries"
r="$(run "$MISSING" set 1704067200000)"; ok "floor itself is accepted" "${r%% *}" "0"
r="$(run "$MISSING" set 4102444800000)"; ok "ceiling itself is accepted" "${r%% *}" "0"

echo "a good value"
r="$(run "$MISSING" set "$GOOD")"
ok "exit 0" "${r%% *}" "0"
ok "date -s gets the instant, seconds.millis" "$(cat "$DATE_LOG")" "@1790296934.107"
ok "reports ok with before/now" "${r#* }" '{"ok":true,"before_ms":1758764000123,"now_ms":1758764000123}'
ok "no clock file → nothing stamped" "$(wc -l < "$TOUCH_LOG" | tr -d ' ')" "0"

r="$(run "$PRESENT" set "$GOOD")"
ok "clock file present → stamped with the new second" "$(cat "$TOUCH_LOG")" "-m -d @1790296934 $PRESENT"

r="$(run "$MISSING" set 1790296934000)"
ok "zero millis are padded" "$(cat "$DATE_LOG")" "@1790296934.000"

echo "date -s failing"
r="$(DATE_FAIL=1 run "$PRESENT" set "$GOOD")"
ok "exit 1" "${r%% *}" "1"
ok "reports date_failed" "$(error_of "${r#* }")" "date_failed"
ok "clock file left alone" "$(wc -l < "$TOUCH_LOG" | tr -d ' ')" "0"

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
