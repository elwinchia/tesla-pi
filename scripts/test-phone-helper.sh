#!/bin/bash
# test-phone-helper.sh — offline test for tesla-pi-phone.
#
# Two things matter. The argument filter is the safety story: sudo lets the
# service user run this helper with any argument, so the helper alone decides
# what reaches hcitool. And the radio must always be handed back: Bluetooth is
# soft-blocked on purpose on this device (it shares silicon with the AP), so a
# probe that leaves it unblocked is a bug even when the probe itself worked.
#
# Runs anywhere: rfkill, hciconfig, hcitool and l2ping are stubs, so nothing
# here needs root or a Bluetooth adapter.
#
# Run: bash scripts/test-phone-helper.sh

set -uo pipefail

HELPER="$(cd "$(dirname "$0")" && pwd)/tesla-pi-phone"
[[ -r "$HELPER" ]] || { echo "missing $HELPER"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1));
       else echo "  FAIL $1"; echo "        want: $3"; echo "        got:  $2"; fail=$((fail+1)); fi; }

mkdir -p "$TMP/bin"
# rfkill keeps its soft-block state in a file so the test can check it is restored.
cat > "$TMP/bin/rfkill" <<'STUB'
#!/bin/bash
case "$1" in
    list) echo "0: hci0: Bluetooth"; echo "	Soft blocked: $(cat "$RF_STATE")"; echo "	Hard blocked: no" ;;
    block) echo yes > "$RF_STATE" ;;
    unblock) echo no > "$RF_STATE" ;;
esac
STUB
cat > "$TMP/bin/hciconfig" <<'STUB'
#!/bin/bash
echo "$*" >> "$HCI_LOG"
STUB
# hcitool: `name` answers PHONE_NAME (empty = phone absent); `rssi` answers RSSI_VALUES in turn.
cat > "$TMP/bin/hcitool" <<'STUB'
#!/bin/bash
[[ "$1" == "-i" ]] && shift 2
case "$1" in
    name) echo "$2" >> "$NAME_LOG"; [[ -n "${PHONE_NAME:-}" ]] && echo "$PHONE_NAME" ;;
    rssi)
        n=$(cat "$RSSI_IDX" 2>/dev/null || echo 0)
        read -ra vals <<<"${RSSI_VALUES:-}"
        if (( n < ${#vals[@]} )); then echo "RSSI return value: ${vals[$n]}"; else echo "Not connected." >&2; fi
        echo $((n + 1)) > "$RSSI_IDX" ;;
esac
STUB
cat > "$TMP/bin/l2ping" <<'STUB'
#!/bin/bash
sleep 5
STUB
chmod +x "$TMP/bin/"*

run() {
    echo yes > "$TMP/rf"; : > "$TMP/hci"; : > "$TMP/names"; rm -f "$TMP/idx"
    RF_STATE="$TMP/rf" HCI_LOG="$TMP/hci" NAME_LOG="$TMP/names" RSSI_IDX="$TMP/idx" \
    TESLAPI_RFKILL="$TMP/bin/rfkill" TESLAPI_HCICONFIG="$TMP/bin/hciconfig" \
    TESLAPI_HCITOOL="$TMP/bin/hcitool" TESLAPI_L2PING="$TMP/bin/l2ping" \
    TESLAPI_BT_LOCK="$TMP/lock" TESLAPI_RSSI_TRIES=3 \
    bash "$HELPER" "$@"
}

echo "argument filter"
for bad in "" "nope" "AA:BB:CC:DD:EE" "AA:BB:CC:DD:EE:FF:00" "AA-BB-CC-DD-EE-FF" "AA:BB:CC:DD:EE:FG" '$(id)' "AA:BB:CC:DD:EE:FF;id"; do
    out="$(run probe "$bad")"; rc=$?
    ok "refuses '$bad'" "$rc:$out" '2:{"ok":false,"error":"bad_mac"}'
    ok "  never paged for '$bad'" "$(cat "$TMP/names")" ""
done
out="$(run frobnicate AA:BB:CC:DD:EE:FF 2>/dev/null)"; ok "unknown verb exits 2" "$?" "2"

echo "phone absent"
out="$(PHONE_NAME= run probe aa:bb:cc:dd:ee:ff)"
ok "reports not present" "$(echo "$out" | sed -E 's/"ms":[0-9]+/"ms":N/')" '{"ok":true,"present":false,"rssi":null,"samples":[],"ms":N}'
ok "pages the upper-cased address" "$(cat "$TMP/names")" "AA:BB:CC:DD:EE:FF"
ok "shortens the page timeout" "$(grep -c 'pageto 3200' "$TMP/hci")" "1"
ok "re-blocks Bluetooth afterwards" "$(cat "$TMP/rf")" "yes"

echo "phone present"
out="$(PHONE_NAME='Test iPhone' RSSI_VALUES='-2 0 -5' run probe AA:BB:CC:DD:EE:FF)"
ok "reports present with the median RSSI" "$(echo "$out" | sed -E 's/"ms":[0-9]+/"ms":N/')" \
   '{"ok":true,"present":true,"name":"Test iPhone","rssi":-2,"samples":[-2,0,-5],"ms":N}'
ok "re-blocks Bluetooth afterwards" "$(cat "$TMP/rf")" "yes"

echo "present but no RSSI"
out="$(PHONE_NAME='Test iPhone' RSSI_VALUES='' run probe AA:BB:CC:DD:EE:FF)"
ok "rssi is null, not a guess" "$(echo "$out" | sed -E 's/"ms":[0-9]+/"ms":N/')" \
   '{"ok":true,"present":true,"name":"Test iPhone","rssi":null,"samples":[],"ms":N}'

echo "hostile phone name"
out="$(PHONE_NAME='a"b\c}{' RSSI_VALUES='-1' run probe AA:BB:CC:DD:EE:FF)"
ok "name stripped to valid JSON" "$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')" "abc}{"

echo "already unblocked stays unblocked"
echo no > "$TMP/rf"
RF_STATE="$TMP/rf" HCI_LOG="$TMP/hci" NAME_LOG="$TMP/names" RSSI_IDX="$TMP/idx" \
  TESLAPI_RFKILL="$TMP/bin/rfkill" TESLAPI_HCICONFIG="$TMP/bin/hciconfig" \
  TESLAPI_HCITOOL="$TMP/bin/hcitool" TESLAPI_L2PING="$TMP/bin/l2ping" \
  TESLAPI_BT_LOCK="$TMP/lock" PHONE_NAME= bash "$HELPER" probe AA:BB:CC:DD:EE:FF >/dev/null
ok "leaves a borrowed-by-someone-else radio alone" "$(cat "$TMP/rf")" "no"

echo
echo "$pass passed, $fail failed"
(( fail == 0 ))
