#!/bin/bash
# Drives scripts/bt-probe.sh end to end against stub binaries.
#
# The probe only ever runs in a car, with a Pi, once the hardware is in front of
# us. That is the worst possible place to discover an unbound variable or a
# phase that exits before writing its artifacts. This harness fakes bluetoothctl,
# bluealsa, aplay/arecord, btmon and friends, then walks every phase and checks
# what landed on disk — so the shape of the thing is proven before it matters.
#
# It cannot tell us whether the Tesla will pair, whether SCO comes up, or
# whether the vendor command works. Only the car can answer those. What it does
# tell us is that when the answer arrives, the probe will record it.
#
# Runs anywhere with bash and python3, including macOS. No root, no Bluetooth.
#
#   scripts/bt-probe-mock-test.sh

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/bt-probe.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/bt-probe-mock.XXXXXX")"
BIN="$TMP/bin"
mkdir -p "$BIN"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
has()  { if [ -e "$2" ]; then ok "$1"; else bad "$1 — missing $2"; fi; }
grep_ok() { if grep -qE "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1 — no /$2/ in $3"; fi; }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ── stubs ───────────────────────────────────────────────────────────────────
# Each records its arguments so the test can assert on what the probe asked for,
# not merely on whether it survived.

stub() {
    local name="$1"; shift
    { echo '#!/bin/bash'
      echo "printf '%s\\n' \"$name \$*\" >> \"$TMP/calls.log\""
      printf '%s\n' "$@"
    } > "$BIN/$name"
    chmod +x "$BIN/$name"
}

MOCK_MAC="AA:BB:CC:DD:EE:FF"

stub id 'if [ "${1:-}" = "-u" ]; then echo 0; else echo "uid=0(root)"; fi'
stub systemctl 'case "${1:-}" in is-active) echo inactive;; is-enabled) echo enabled;; esac; exit 0'
stub rfkill 'echo "0: hci0: Bluetooth  Soft blocked: no  Hard blocked: no"'
stub hciconfig 'echo "hci0:	Type: Primary  Bus: UART"; echo "	BD Address: B8:27:EB:00:00:01"'
stub dmesg 'echo "[    5.1] Bluetooth: hci0: BCM4345C0 firmware loaded"'
stub btmon 'out=""; while [ $# -gt 0 ]; do [ "$1" = "-w" ] && out="$2"; shift; done
[ -n "$out" ] && printf "btsnoop\n" > "$out"
echo "= Note: mock btmon"
echo "< HCI Command: Setup Synchronous Connection"
echo "> HCI Event: Synchronous Connect Complete (status 0x00)"
echo "AT+BRSF=756"
echo "AVRCP: Passthrough pressed: FORWARD"
sleep 600'
stub dbus-monitor 'echo "signal org.bluez mock"; sleep 600'
stub curl 'echo "{\"carplay\":\"plugged\"}"'
stub apt-get 'echo "mock apt-get $*"; exit 0'
stub aplay 'if [ "${1:-}" = "-L" ]; then echo "bluealsa"; echo "    Bluetooth Audio"; exit 0; fi; exit 0'

# bluealsa: refuses the first (--io-rt-priority) argument set so the fallback
# path in start_bluealsa is exercised, then stays alive like the real daemon.
stub bluealsa 'case "$*" in
  *--help*) echo "Usage: bluealsa [OPTION]..."; exit 0;;
  *io-rt-priority*) echo "bluealsa: unrecognised option --io-rt-priority" >&2; exit 1;;
esac
sleep 600'
stub bluealsactl 'if [ "${1:-}" = "list-pcms" ]; then
  echo "/org/bluealsa/hci0/dev_AA_BB_CC_DD_EE_FF/a2dpsrc/sink"
  echo "/org/bluealsa/hci0/dev_AA_BB_CC_DD_EE_FF/hfpag/source"
else
  echo "Transport: SCO"; echo "Codec: mSBC"; echo "Sampling: 16000 Hz"
fi'

# arecord: succeeds only at 16 kHz, proving the rate-fallback loop tries
# wideband first and stops when it works.
cat > "$BIN/arecord" <<EOF
#!/bin/bash
printf '%s\n' "arecord \$*" >> "$TMP/calls.log"
rate=""; out=""
while [ \$# -gt 0 ]; do
  case "\$1" in -r) rate="\$2"; shift;; -*) ;; *) out="\$1";; esac
  shift
done
[ "\$rate" = "16000" ] || { echo "arecord: rate \$rate not available" >&2; exit 1; }
python3 "$HERE/bt-probe-util.py" tone --profile sco --out "\$out" --rate 16000 >/dev/null
EOF
chmod +x "$BIN/arecord"

# bluetoothctl: the stateful one. Reports the car as paired only after the pair
# phase has run, which is what lets us test the before/after diff.
cat > "$BIN/bluetoothctl" <<EOF
#!/bin/bash
printf '%s\n' "bluetoothctl \$*" >> "$TMP/calls.log"
PAIRED_FLAG="$TMP/paired"
case "\${1:-}" in
  paired-devices) [ -f "\$PAIRED_FLAG" ] && echo "Device $MOCK_MAC Model 3"; exit 0;;
  devices) echo "Device $MOCK_MAC Model 3"; exit 0;;
  info) echo "Device $MOCK_MAC (public)"
        echo "	Name: Model 3"
        echo "	Connected: yes"
        echo "	UUID: Handsfree                (0000111e-0000-1000-8000-00805f9b34fb)"
        echo "	UUID: Audio Sink               (0000110b-0000-1000-8000-00805f9b34fb)"
        echo "	UUID: A/V Remote Control       (0000110e-0000-1000-8000-00805f9b34fb)"
        exit 0;;
  show) echo "Controller B8:27:EB:00:00:01"; echo "	Powered: yes"; echo "	Discoverable: yes"; exit 0;;
  list) echo "Controller B8:27:EB:00:00:01 mock [default]"; exit 0;;
  "") # interactive: the pair phase pipes commands in
      touch "\$PAIRED_FLAG"
      cat > /dev/null
      echo "[NEW] Device $MOCK_MAC Model 3"
      exit 0;;
esac
exit 0
EOF
chmod +x "$BIN/bluetoothctl"

export PATH="$BIN:$PATH"
export BT_PROBE_SESSION=""
ROOTDIR="$TMP/probe-root"

# The probe writes to /var/tmp; point it somewhere writable and disposable.
run_probe() {
    BT_PROBE_ROOT="$ROOTDIR" BT_PROBE_MAIN_CONF="$TMP/main.conf" "$PROBE" "$@"
}

printf '\n=== bt-probe mock run (%s) ===\n' "$TMP"

printf '\n-- help --\n'
out="$(run_probe --help 2>&1)"; rc=$?
check "help exits 0" "$rc" "0"
if printf '%s' "$out" | grep -q "cabin microphone"; then ok "help explains the point"; else bad "help text missing"; fi

printf '\n-- env --\n'
run_probe env > "$TMP/env.out" 2>&1
SESSION="$(readlink "$ROOTDIR/latest" 2>/dev/null || readlink -f "$ROOTDIR/latest")"
[ -d "$SESSION" ] || SESSION="$(ls -d "$ROOTDIR"/2* 2>/dev/null | tail -1)"
has "session created" "$SESSION"
has "env.txt written" "$SESSION/env.txt"
grep_ok "records the adapter" "BD Address" "$SESSION/env.txt"
grep_ok "records CarPlay health" "carplay" "$SESSION/healthz-before.json"
grep_ok "notices the ALSA plugin" "ALSA bluealsa plugin present" "$SESSION/env.txt"
grep_ok "reports SCO routing readback" "SCO routing" "$SESSION/env.txt"

printf '\n-- enable --\n'
printf '[General]\n#Class = 0x000100\n' > "$TMP/main.conf"
run_probe enable > "$TMP/enable.out" 2>&1
grep_ok "enable logged" "SCO over HCI" "$SESSION/enable.txt"
grep_ok "sco-route failure is survivable" "the mic test cannot succeed" "$SESSION/enable.txt"
check "records the sco-route outcome" "$(sed -n 's/^SCO_ROUTE=//p' "$SESSION/state" | tail -1)" "failed"
grep_ok "device class set to phone" "^Class = 0x00020c" "$TMP/main.conf"

printf '\n-- pair --\n'
run_probe pair 4 > "$TMP/pair.out" 2>&1
check "car recorded" "$(sed -n 's/^TESLA_MAC=//p' "$SESSION/state" | tail -1)" "$MOCK_MAC"
grep_ok "trusted the car" "bluetoothctl trust $MOCK_MAC" "$TMP/calls.log"
grep_ok "bluealsa started with the gateway role" "bluealsa .*-p hfp-ag" "$TMP/calls.log"
grep_ok "fell back past the unsupported flag" "^BLUEALSA_ARGS=-p a2dp-source" "$SESSION/state"

printf '\n-- info --\n'
run_probe info > "$TMP/info.out" 2>&1
grep_ok "surfaces the Handsfree UUID" "Handsfree" "$SESSION/info.txt"
grep_ok "lists bluealsa PCMs" "hfpag" "$SESSION/info.txt"

printf '\n-- a2dp --\n'
run_probe a2dp > "$TMP/a2dp.out" 2>&1
has "stereo tone generated" "$SESSION/tone-a2dp.wav"
grep_ok "played to the car's A2DP PCM" "aplay -D bluealsa:DEV=$MOCK_MAC,PROFILE=a2dp" "$TMP/calls.log"
grep_ok "explains what to listen for" "correct left/right" "$SESSION/a2dp.txt"

printf '\n-- watch --\n'
run_probe watch 5 > "$TMP/watch.out" 2>&1
grep_ok "watch captured AVRCP" "Passthrough" "$SESSION/watch.txt"
grep_ok "watch captured AT commands" "AT\+BRSF" "$SESSION/watch.txt"

printf '\n-- sco --\n'
run_probe sco 2 > "$TMP/sco.out" 2>&1
check "recorded the negotiated rate" "$(sed -n 's/^SCO_RATE=//p' "$SESSION/state" | tail -1)" "16000"
has "mic capture kept" "$SESSION/mic-16000.wav"
grep_ok "analysed the capture" "level: AUDIO" "$SESSION/sco.txt"
grep_ok "tried wideband before narrowband" "trying 16000 Hz" "$SESSION/sco.txt"
grep_ok "played the downlink tone" "aplay -D bluealsa:DEV=$MOCK_MAC,PROFILE=sco" "$TMP/calls.log"

printf '\n-- silence is reported as silence --\n'
python3 - "$SESSION/silent.wav" <<'PY'
import sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"\x00\x00" * 16000)
PY
sil="$(python3 "$HERE/bt-probe-util.py" level "$SESSION/silent.wav" 2>&1)"
if printf '%s' "$sil" | grep -q "SILENT"; then ok "digital silence flagged, not passed as audio"; else bad "silence misreported: $sil"; fi

printf '\n-- bundle --\n'
run_probe bundle > "$TMP/bundle.out" 2>&1
bundle="$(ls "$ROOTDIR"/bt-probe-*.tgz 2>/dev/null | tail -1)"
has "bundle written" "$bundle"
if tar tzf "$bundle" 2>/dev/null | grep -q "mic-16000.wav"; then ok "bundle carries the evidence"; else bad "bundle missing artifacts"; fi

printf '\n-- undo --\n'
run_probe undo > "$TMP/undo.out" 2>&1
grep_ok "undo leaves the car pairing decision to us" "Forget" "$TMP/undo.out"
grep_ok "undo states what it never touched" "hostapd" "$TMP/undo.out"
if pgrep -f "bluealsa -p a2dp-source" >/dev/null 2>&1; then bad "bluealsa stub still running after undo"; else ok "bluealsa stopped"; fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
