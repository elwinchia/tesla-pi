#!/bin/bash
# Bluetooth feasibility probe: can this Pi be the Tesla's "phone"?
#
# The question this answers is not "does Bluetooth work" but a specific chain:
#
#   1. Does the onboard controller route SCO (voice) packets over HCI at all?
#      Without it a SCO link comes up and delivers digital silence, because the
#      chip is shipping the audio out its PCM/I2S pins instead.
#   2. Will the Tesla pair with, and stay connected to, a Linux box that is
#      advertising itself as a phone rather than a headset?
#   3. Does A2DP from the Pi actually reach the speakers, and does the car make
#      it the active media source?
#   4. Does the car send AVRCP when the steering wheel is used? (That is the
#      path to the media controls the README currently says are impossible.)
#   5. **The one that matters**: will the car open a SCO link and hand us its
#      cabin microphone? That mic is the whole reason to prefer Bluetooth over
#      streaming audio into the browser — CarPlay expects the head unit to
#      supply a microphone, and this Pi has none.
#
# Nothing here is a product feature. It is a measurement rig: every phase
# captures an HCI trace alongside its own logs, so a failure can be diagnosed
# from the bundle rather than from another trip to the car. `undo` puts the box
# back the way it was.
#
# Run as root, one phase at a time, over SSH with the car awake and in range:
#
#   sudo scripts/bt-probe.sh env       # read-only; safe any time
#   sudo scripts/bt-probe.sh deps      # apt install what's missing
#   sudo scripts/bt-probe.sh enable    # power on + SCO routing + identity
#   sudo scripts/bt-probe.sh pair      # then pair from the car's screen
#   sudo scripts/bt-probe.sh a2dp      # tone should come out of the speakers
#   sudo scripts/bt-probe.sh watch     # press the wheel / voice button
#   sudo scripts/bt-probe.sh sco       # the mic test
#   sudo scripts/bt-probe.sh bundle    # tarball to hand back
#   sudo scripts/bt-probe.sh undo      # restore
#
# Safety: it never touches hostapd, tesla-pi.service, or wlan0/wlan1. It does
# stop a running bluealsa.service (and restarts it on undo) because the packaged
# one does not enable the HFP gateway role we need.

set -uo pipefail

HERE="$(dirname "$(readlink -f "$0")")"
UTIL="$HERE/bt-probe-util.py"
# Overridable so scripts/bt-probe-mock-test.sh can drive the whole thing
# against stub binaries without touching anything real.
ROOT="${BT_PROBE_ROOT:-/var/tmp/tesla-pi-bt-probe}"
LATEST="$ROOT/latest"
ADAPTER="${BT_PROBE_ADAPTER:-hci0}"
# Advertised name and class. The class matters more than it looks: BlueZ
# defaults to major class "Computer", and a car scanning for a phone may not
# offer it the phone profiles at all. 0x00020c is major 2 (Phone), minor 3
# (Smartphone); the service bits are derived by BlueZ from the profiles that are
# actually registered, so bluealsa must be running before this means anything.
BT_NAME="${BT_PROBE_NAME:-Tesla-Pi}"
BT_CLASS="${BT_PROBE_CLASS:-0x00020c}"
MAIN_CONF="${BT_PROBE_MAIN_CONF:-/etc/bluetooth/main.conf}"
# Set by session_attach/session_new; the EXIT trap fires even on paths that
# never open a session (--help, bad phase name), so it must exist up front.
SESSION=""

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

need_root() {
    [ "$(id -u)" = "0" ] || die "must run as root (try: sudo $0 $*)"
}

# ── session -----------------------------------------------------------------
# Every phase writes into one directory so `bundle` can hand over the whole
# story at once. Phases after the first attach to it rather than starting over.

session_new() {
    SESSION="$ROOT/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$SESSION" || die "cannot create $SESSION"
    ln -sfn "$SESSION" "$LATEST"
    : > "$SESSION/state"
    say "session: $SESSION"
}

session_attach() {
    if [ -n "${BT_PROBE_SESSION:-}" ]; then
        SESSION="$BT_PROBE_SESSION"
    elif [ -L "$LATEST" ] && [ -d "$LATEST" ]; then
        SESSION="$(readlink -f "$LATEST")"
    else
        session_new
        return
    fi
    mkdir -p "$SESSION"
    say "session: $SESSION"
}

state_get() {
    local key="$1"
    [ -f "$SESSION/state" ] || return 1
    sed -n "s/^${key}=//p" "$SESSION/state" | tail -1
}

state_set() {
    local key="$1" val="$2" tmp="$SESSION/.state.tmp"
    touch "$SESSION/state"
    grep -v "^${key}=" "$SESSION/state" > "$tmp" 2>/dev/null
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    mv "$tmp" "$SESSION/state"
}

# ── HCI trace ---------------------------------------------------------------
# btmon is the single most useful artifact here. It decodes the HFP service
# level negotiation, the codec choice (CVSD vs mSBC), AVRCP passthrough, and
# critically the *reason* a SCO setup was rejected — none of which surfaces in
# any tool's stdout.

mon_start() {
    local name="$1"
    [ -n "$SESSION" ] || return 0
    command -v btmon >/dev/null 2>&1 || { warn "btmon missing; no HCI trace for $name"; return 0; }
    btmon -T -w "$SESSION/$name.btsnoop" > "$SESSION/$name.btmon.txt" 2>&1 &
    echo $! > "$SESSION/.btmon.pid"
    sleep 0.4   # let it attach before the phase generates traffic
}

mon_stop() {
    local pid
    [ -n "$SESSION" ] || return 0
    [ -f "$SESSION/.btmon.pid" ] || return 0
    pid="$(cat "$SESSION/.btmon.pid")"
    sleep 0.4   # let the tail of the exchange land in the file
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rm -f "$SESSION/.btmon.pid"
}

# dbus-monitor catches what btmon can't interpret for us: BlueZ's own view of
# players, transports and profile connections.
dbus_start() {
    local name="$1"
    [ -n "$SESSION" ] || return 0
    command -v dbus-monitor >/dev/null 2>&1 || return 0
    dbus-monitor --system "sender='org.bluez'" > "$SESSION/$name.dbus.txt" 2>&1 &
    echo $! > "$SESSION/.dbus.pid"
}

dbus_stop() {
    local pid
    [ -n "$SESSION" ] || return 0
    [ -f "$SESSION/.dbus.pid" ] || return 0
    pid="$(cat "$SESSION/.dbus.pid")"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rm -f "$SESSION/.dbus.pid"
}

cleanup() { mon_stop; dbus_stop; }
trap cleanup EXIT

# ── tool discovery ----------------------------------------------------------
# Debian ships bluealsa 4.0 as `bluealsa`; newer upstream renamed the daemon to
# `bluealsad` and the CLI from `bluealsa-cli` to `bluealsactl`. Resolve both
# rather than pinning a version we cannot check from here.

find_bin() {
    local b
    for b in "$@"; do
        if command -v "$b" >/dev/null 2>&1; then printf '%s' "$b"; return 0; fi
        if [ -x "/usr/sbin/$b" ]; then printf '/usr/sbin/%s' "$b"; return 0; fi
        if [ -x "/usr/bin/$b" ]; then printf '/usr/bin/%s' "$b"; return 0; fi
    done
    return 1
}

BLUEALSA_BIN=""
BLUEALSA_CLI=""
resolve_bluealsa() {
    BLUEALSA_BIN="$(find_bin bluealsad bluealsa)" || BLUEALSA_BIN=""
    BLUEALSA_CLI="$(find_bin bluealsactl bluealsa-cli)" || BLUEALSA_CLI=""
}

# ── device address ----------------------------------------------------------

tesla_mac() {
    local mac
    mac="$(state_get TESLA_MAC)"
    [ -n "$mac" ] || die "no paired car recorded yet — run 'pair', or 'use <MAC>'"
    printf '%s' "$mac"
}

# ── phases ------------------------------------------------------------------

phase_env() {
    session_new
    exec > >(tee -a "$SESSION/env.txt") 2>&1
    say "session: $SESSION"
    resolve_bluealsa

    step "host"
    say "date:    $(date -Is)"
    say "model:   $(tr -d '\0' < /proc/device-tree/model 2>/dev/null)"
    say "os:      $(sed -n 's/^PRETTY_NAME="\(.*\)"/\1/p' /etc/os-release 2>/dev/null)"
    say "kernel:  $(uname -r)"

    step "radio config"
    local cfg found=0
    for cfg in /boot/firmware/config.txt /boot/config.txt; do
        [ -f "$cfg" ] || continue
        found=1
        say "config:  $cfg"
        if grep -qE '^\s*dtoverlay=disable-bt' "$cfg"; then
            say "  FAIL onboard Bluetooth is disabled by 'dtoverlay=disable-bt'"
            say "       remove that line and reboot, then re-run env"
        else
            say "  ok   no disable-bt overlay"
        fi
        grep -nE '^\s*(dtparam=krnbt|dtoverlay=.*bt)' "$cfg" | sed 's/^/  /'
    done
    [ "$found" = 1 ] || warn "no config.txt found in the usual places"

    say "rfkill:"
    (rfkill list bluetooth 2>/dev/null || say "  (rfkill unavailable)") | sed 's/^/  /'

    step "adapter"
    if command -v hciconfig >/dev/null 2>&1; then
        hciconfig -a 2>/dev/null | sed 's/^/  /'
    fi
    if command -v bluetoothctl >/dev/null 2>&1; then
        say "bluetoothctl list:"
        bluetoothctl list 2>/dev/null | sed 's/^/  /'
        say "bluetoothctl show:"
        bluetoothctl show 2>/dev/null | sed 's/^/  /'
    fi
    say "kernel bluetooth messages:"
    dmesg 2>/dev/null | grep -iE 'bluetooth|hci_uart|BCM' | tail -12 | sed 's/^/  /'

    step "services"
    local s
    for s in bluetooth hciuart bluealsa; do
        say "$(printf '%-10s' "$s") enabled=$(systemctl is-enabled "$s" 2>&1) active=$(systemctl is-active "$s" 2>&1)"
    done
    if pgrep -x pipewire >/dev/null 2>&1 || pgrep -x pulseaudio >/dev/null 2>&1; then
        say "  WARN pipewire/pulseaudio is running — it will claim BlueZ's media"
        say "       endpoints and bluealsa will fail to register. Stop it, or"
        say "       drive this probe through PipeWire instead."
    else
        say "  ok   no pipewire/pulseaudio competing for the media endpoints"
    fi

    step "tools"
    local t missing=""
    for t in bluetoothctl btmon bluealsa/bluealsad aplay arecord dbus-monitor python3; do
        case "$t" in
            bluealsa/bluealsad)
                if [ -n "$BLUEALSA_BIN" ]; then say "  ok   bluealsa daemon: $BLUEALSA_BIN"
                else say "  MISSING bluealsa daemon"; missing="$missing bluez-alsa-utils"; fi
                continue;;
        esac
        if command -v "$t" >/dev/null 2>&1; then
            say "  ok   $t"
        else
            say "  MISSING $t"
            case "$t" in
                bluetoothctl|btmon) missing="$missing bluez";;
                aplay|arecord)      missing="$missing alsa-utils";;
                dbus-monitor)       missing="$missing dbus";;
            esac
        fi
    done
    [ -n "$BLUEALSA_CLI" ] && say "  ok   bluealsa cli: $BLUEALSA_CLI" || say "  note bluealsa cli not found (optional)"
    if command -v aplay >/dev/null 2>&1 && aplay -L 2>/dev/null | grep -q '^bluealsa'; then
        say "  ok   ALSA bluealsa plugin present"
    else
        say "  MISSING ALSA bluealsa plugin"
        missing="$missing libasound2-plugin-bluez"
    fi
    if [ -n "$missing" ]; then
        say ""
        say "install with:  sudo $0 deps"
        say "  (apt-get install -y$(printf '%s' "$missing" | tr ' ' '\n' | sort -u | tr '\n' ' '))"
        state_set MISSING "$(printf '%s' "$missing" | tr ' ' '\n' | sort -u | tr '\n' ' ')"
    fi

    step "SCO routing (read-only)"
    if [ -e "/sys/class/bluetooth/$ADAPTER" ]; then
        python3 "$UTIL" sco-route --dev "$ADAPTER" --read-only 2>&1 | sed 's/^/  /'
        say "  (a failure here is expected on many builds — the write is what counts)"
    else
        say "  skipped: /sys/class/bluetooth/$ADAPTER does not exist"
    fi

    step "CarPlay health before we touch anything"
    curl -s --max-time 4 localhost:8080/healthz 2>/dev/null | tee "$SESSION/healthz-before.json" | head -c 400
    say ""

    step "next"
    say "if anything above says MISSING:  sudo $0 deps"
    say "otherwise:                       sudo $0 enable"
}

phase_deps() {
    session_attach
    local pkgs="bluez bluez-alsa-utils libasound2-plugin-bluez alsa-utils dbus"
    step "installing: $pkgs"
    say "(needs the Pi to have an uplink — wlan1 on home Wi-Fi, or eth0)"
    apt-get update 2>&1 | tail -3
    # shellcheck disable=SC2086
    apt-get install -y $pkgs 2>&1 | tail -20
    local rc=${PIPESTATUS[0]}
    resolve_bluealsa
    say ""
    say "bluealsa daemon: ${BLUEALSA_BIN:-still missing}"
    say "bluealsa cli:    ${BLUEALSA_CLI:-not found}"
    if [ -n "$BLUEALSA_BIN" ]; then
        say ""
        step "daemon options (recorded so flags can be matched to this version)"
        "$BLUEALSA_BIN" --help 2>&1 | tee "$SESSION/bluealsa-help.txt" | head -40
    fi
    return $rc
}

phase_enable() {
    session_attach
    exec > >(tee -a "$SESSION/enable.txt") 2>&1
    mon_start enable

    step "adapter up"
    systemctl start bluetooth 2>&1 | sed 's/^/  /'
    rfkill unblock bluetooth 2>/dev/null
    bluetoothctl power on 2>&1 | sed 's/^/  /'
    sleep 1

    step "SCO over HCI"
    # Must be re-applied after every adapter reset, so this phase is idempotent
    # and cheap to repeat. Losing it is silent: SCO links still establish.
    python3 "$UTIL" sco-route --dev "$ADAPTER" --verify 2>&1 | sed 's/^/  /'
    local rc=${PIPESTATUS[0]}
    if [ "$rc" != 0 ]; then
        say "  the mic test cannot succeed without this. A2DP (music) is unaffected."
        state_set SCO_ROUTE failed
    else
        state_set SCO_ROUTE ok
    fi

    step "identity"
    # Backed up on first change only, so repeated runs don't overwrite the
    # backup with our own edit.
    if [ ! -f "$SESSION/main.conf.orig" ] && [ -f "$MAIN_CONF" ]; then
        cp -a "$MAIN_CONF" "$SESSION/main.conf.orig"
        state_set MAIN_CONF_BACKUP "$SESSION/main.conf.orig"
    fi
    if [ -f "$MAIN_CONF" ]; then
        python3 "$UTIL" set-class --file "$MAIN_CONF" --class "$BT_CLASS" 2>&1 | sed 's/^/  /'
        say "  (0x00020c = major 2 Phone, minor 3 Smartphone)"
        systemctl restart bluetooth
        sleep 2
        bluetoothctl power on >/dev/null 2>&1
        # A restart resets the controller, which drops the SCO routing we just
        # set. Re-apply rather than leaving a trap for the sco phase.
        python3 "$UTIL" sco-route --dev "$ADAPTER" 2>&1 | sed 's/^/  /'
    else
        warn "$MAIN_CONF absent; leaving device class at BlueZ's default (Computer)"
    fi
    bluetoothctl system-alias "$BT_NAME" 2>&1 | sed 's/^/  /'

    step "state"
    bluetoothctl show 2>&1 | sed 's/^/  /'
    mon_stop
    say ""
    say "next: sudo $0 pair    (then add the device from the car's screen)"
}

# bluealsa has to be running *before* the car scans: BlueZ derives the
# advertised service class bits, and answers the car's SDP queries, from the
# profiles that are actually registered. Pairing a box that offers nothing is
# how you end up with a device the car lists but will not play through.
start_bluealsa() {
    resolve_bluealsa
    [ -n "$BLUEALSA_BIN" ] || die "bluealsa daemon not installed — run: sudo $0 deps"

    local pid
    pid="$(state_get BLUEALSA_PID)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        say "bluealsa already running (pid $pid)"
        return 0
    fi

    if systemctl is-active bluealsa >/dev/null 2>&1; then
        # The packaged unit runs sink+source only. We need the HFP gateway role,
        # and two daemons cannot both own the endpoints.
        say "stopping packaged bluealsa.service (restored by 'undo')"
        systemctl stop bluealsa
        state_set BLUEALSA_SERVICE_WAS active
    fi

    # --io-rt-priority is recommended upstream for mSBC: the kernel does no
    # buffering for the mSBC SCO socket, so a late read is dropped audio. Older
    # builds don't have the flag, so fall back rather than refusing to start.
    local args="-p a2dp-source -p hfp-ag -p hsp-ag"
    local try
    for try in "--io-rt-priority=90 $args" "$args"; do
        # shellcheck disable=SC2086
        nohup "$BLUEALSA_BIN" $try >> "$SESSION/bluealsa.log" 2>&1 &
        pid=$!
        sleep 1.5
        if kill -0 "$pid" 2>/dev/null; then
            state_set BLUEALSA_PID "$pid"
            state_set BLUEALSA_ARGS "$try"
            say "bluealsa: $BLUEALSA_BIN $try (pid $pid)"
            return 0
        fi
        say "bluealsa refused '$try' — see $SESSION/bluealsa.log"
    done
    die "bluealsa would not start with any argument set"
}

phase_pair() {
    local secs="${1:-180}"
    session_attach
    exec > >(tee -a "$SESSION/pair.txt") 2>&1
    start_bluealsa
    mon_start pair
    dbus_start pair

    bluetoothctl paired-devices 2>/dev/null | awk '{print $2}' | sort > "$SESSION/paired-before.txt"

    step "discoverable as '$BT_NAME' for ${secs}s"
    say "On the car: Controls -> Bluetooth -> Add New Device, pick '$BT_NAME'."
    say "Accepting automatically on this end; nothing to press here."
    say ""

    # bluetoothctl's agent only lives as long as the process, so it is held open
    # for the whole window. The 'yes' stream answers the car's per-service
    # authorisation prompts — an unknown device cannot be pre-trusted, and
    # between prompts the extra input is just an unknown command in the log.
    {
        printf 'power on\n'
        printf 'agent NoInputNoOutput\n'
        printf 'default-agent\n'
        printf 'pairable on\n'
        printf 'discoverable-timeout 0\n'
        printf 'discoverable on\n'
        local i=0
        while [ "$i" -lt "$secs" ]; do
            sleep 2
            printf 'yes\n'
            i=$((i + 2))
        done
        printf 'quit\n'
    } | bluetoothctl >> "$SESSION/pair-bluetoothctl.log" 2>&1

    bluetoothctl paired-devices 2>/dev/null | awk '{print $2}' | sort > "$SESSION/paired-after.txt"
    mon_stop; dbus_stop

    step "result"
    local new
    new="$(comm -13 "$SESSION/paired-before.txt" "$SESSION/paired-after.txt")"
    if [ -z "$new" ]; then
        say "no new pairing. Things worth checking, in order:"
        say "  * did '$BT_NAME' appear in the car's list at all?"
        say "    if not, the device class or the missing profiles kept it hidden"
        say "  * grep -i 'connect\\|pair' $SESSION/pair.btmon.txt"
        say "  * bluetoothctl devices  (the car may be paired but not connected)"
        return 1
    fi
    say "newly paired:"
    printf '%s\n' "$new" | sed 's/^/  /'
    local count
    count="$(printf '%s\n' "$new" | wc -l | tr -d ' ')"
    if [ "$count" = "1" ]; then
        state_set TESLA_MAC "$new"
        bluetoothctl trust "$new" 2>&1 | sed 's/^/  /'
        say "recorded as the car: $new"
        say ""
        say "next: sudo $0 a2dp"
    else
        say "more than one new device — pick the car and run: sudo $0 use <MAC>"
    fi
}

phase_use() {
    session_attach
    [ $# -ge 1 ] || die "usage: $0 use <MAC>"
    state_set TESLA_MAC "$1"
    bluetoothctl trust "$1" 2>&1 | sed 's/^/  /'
    say "recorded as the car: $1"
}

phase_info() {
    session_attach
    exec > >(tee -a "$SESSION/info.txt") 2>&1
    resolve_bluealsa
    local mac; mac="$(tesla_mac)" || exit 1

    step "device"
    bluetoothctl info "$mac" 2>&1 | sed 's/^/  /'
    say ""
    say "What to look for in the UUID list above:"
    say "  Handsfree              (0000111e) — the car's HF role: the mic path"
    say "  Audio Sink             (0000110b) — it can receive our A2DP"
    say "  A/V Remote Control     (0000110e/110f) — steering-wheel controls"

    step "bluealsa PCMs"
    if [ -n "$BLUEALSA_CLI" ]; then
        "$BLUEALSA_CLI" list-pcms 2>&1 | sed 's/^/  /'
        local p
        for p in $("$BLUEALSA_CLI" list-pcms 2>/dev/null); do
            say "  --- $p"
            "$BLUEALSA_CLI" info "$p" 2>&1 | sed 's/^/      /'
        done
    else
        say "  (no bluealsa cli; falling back to the ALSA device list)"
        aplay -L 2>/dev/null | grep -A2 '^bluealsa' | sed 's/^/  /'
    fi
}

phase_a2dp() {
    session_attach
    exec > >(tee -a "$SESSION/a2dp.txt") 2>&1
    local mac; mac="$(tesla_mac)" || exit 1
    start_bluealsa
    mon_start a2dp
    dbus_start a2dp

    step "connect"
    local i
    for i in 1 2 3; do
        bluetoothctl connect "$mac" 2>&1 | sed 's/^/  /'
        sleep 3
        if bluetoothctl info "$mac" 2>/dev/null | grep -q 'Connected: yes'; then
            say "  connected"
            break
        fi
        say "  attempt $i did not connect; retrying"
    done

    step "tone"
    local wav="$SESSION/tone-a2dp.wav"
    python3 "$UTIL" tone --profile a2dp --out "$wav" 2>&1 | sed 's/^/  /'
    say "Playing 5s: tone both channels, then LEFT only, then RIGHT only, then both."
    say "On the car, the media source should switch to Bluetooth / $BT_NAME."
    say ""
    aplay -D "bluealsa:DEV=$mac,PROFILE=a2dp" "$wav" 2>&1 | sed 's/^/  /'
    local rc=${PIPESTATUS[0]}
    mon_stop; dbus_stop

    step "result"
    if [ "$rc" = 0 ]; then
        say "aplay returned cleanly. The question is what you heard:"
        say "  * nothing            → the stream opened but the car isn't rendering it"
        say "                         (check the car's media source)"
        say "  * both tones on both sides → mono downmix somewhere"
        say "  * correct left/right → A2DP is fully working"
    else
        say "aplay failed (rc=$rc). Common causes:"
        say "  * 'No such device'      → the car never connected its A2DP sink"
        say "  * 'Device or resource busy' → something else owns the PCM"
        say "  see $SESSION/a2dp.btmon.txt and $SESSION/bluealsa.log"
    fi
    say ""
    say "next: sudo $0 watch    (steering-wheel and voice-button test)"
}

phase_watch() {
    local secs="${1:-45}"
    session_attach
    exec > >(tee -a "$SESSION/watch.txt") 2>&1
    mon_start watch
    dbus_start watch

    step "capturing for ${secs}s — do these on the car, pausing between each"
    say "  1. press next-track on the steering wheel   (AVRCP passthrough)"
    say "  2. press previous-track"
    say "  3. press play/pause"
    say "  4. press and hold the voice-command button  (this is the one that"
    say "     may make the car send AT+BVRA and open a SCO link on its own)"
    say ""
    local left="$secs"
    while [ "$left" -gt 0 ]; do
        printf '\r  %ds remaining   ' "$left"
        sleep 5
        left=$((left - 5))
    done
    printf '\r                     \r'
    mon_stop; dbus_stop

    step "what landed in the trace"
    if [ -f "$SESSION/watch.btmon.txt" ]; then
        say "AVRCP / passthrough:"
        grep -icE 'avrcp|passthrough' "$SESSION/watch.btmon.txt" | sed 's/^/  matches: /'
        grep -iE 'passthrough|AVRCP' "$SESSION/watch.btmon.txt" | head -20 | sed 's/^/  /'
        say "AT commands (HFP):"
        grep -iE 'AT\+|\+BVRA|\+BRSF|\+CIND|RFCOMM' "$SESSION/watch.btmon.txt" | head -30 | sed 's/^/  /'
        say "SCO setup:"
        grep -iE 'Synchronous Connection|SCO' "$SESSION/watch.btmon.txt" | head -20 | sed 's/^/  /'
    fi
    say ""
    say "next: sudo $0 sco    (the microphone test)"
}

phase_sco() {
    local secs="${1:-8}"
    session_attach
    exec > >(tee -a "$SESSION/sco.txt") 2>&1
    local mac; mac="$(tesla_mac)" || exit 1
    start_bluealsa
    mon_start sco

    if [ "$(state_get SCO_ROUTE)" = "failed" ]; then
        warn "the SCO-over-HCI vendor command failed earlier — expect silence"
    fi

    step "capture"
    say "Talk continuously for ${secs}s once recording starts — normal voice,"
    say "sitting in the driver's seat. Silence is a valid result but we want to"
    say "be sure it isn't just an empty cabin."
    say ""
    local rate got=""
    # mSBC negotiates 16 kHz, CVSD 8 kHz. Which one the car chose is not knowable
    # up front, so try wideband first and fall back.
    for rate in 16000 8000; do
        local out="$SESSION/mic-${rate}.wav"
        say "  trying ${rate} Hz..."
        arecord -D "bluealsa:DEV=$mac,PROFILE=sco" -f S16_LE -c 1 -r "$rate" \
                -d "$secs" "$out" 2>&1 | sed 's/^/    /'
        if [ "${PIPESTATUS[0]}" = 0 ] && [ -s "$out" ]; then
            got="$out"
            state_set SCO_RATE "$rate"
            break
        fi
        rm -f "$out"
    done

    step "result"
    if [ -z "$got" ]; then
        say "no SCO capture at any rate. This is the answer that matters, so the"
        say "trace is worth reading carefully:"
        say "  grep -iE 'Synchronous|SCO|AT\\+' $SESSION/sco.btmon.txt"
        say ""
        say "The two distinguishable failures:"
        say "  * no SCO setup attempted at all → bluealsa never asked, or the car"
        say "    refused the service level connection"
        say "  * setup attempted and rejected  → the car will not open voice audio"
        say "    without a call in progress. That means an AT-level call state"
        say "    machine, not just a PCM open."
        mon_stop
        return 1
    fi
    python3 "$UTIL" level "$got" 2>&1 | sed 's/^/  /'
    local lrc=${PIPESTATUS[0]}
    say "  file: $got"
    if [ "$lrc" != 0 ]; then
        say ""
        say "SCO connected but carried no audio. That is the signature of the"
        say "vendor SCO-routing command not being in effect — the controller is"
        say "sending voice out its PCM pins. Re-run 'enable' and try again; if it"
        say "keeps happening the chip is ignoring the command."
    fi

    step "downlink"
    say "Playing a warble into the SCO link — it should come out of the car's"
    say "speakers the way call audio does."
    local rate_used; rate_used="$(state_get SCO_RATE)"
    local twav="$SESSION/tone-sco.wav"
    python3 "$UTIL" tone --profile sco --out "$twav" --rate "$rate_used" 2>&1 | sed 's/^/  /'
    aplay -D "bluealsa:DEV=$mac,PROFILE=sco" "$twav" 2>&1 | sed 's/^/  /'
    mon_stop
    say ""
    say "next: sudo $0 bundle"
}

phase_bundle() {
    session_attach
    curl -s --max-time 4 localhost:8080/healthz > "$SESSION/healthz-after.json" 2>/dev/null
    cp -f "$SESSION/state" "$SESSION/state.txt" 2>/dev/null
    local out="$ROOT/bt-probe-$(basename "$SESSION").tgz"
    tar czf "$out" -C "$(dirname "$SESSION")" "$(basename "$SESSION")" 2>/dev/null
    say "bundle: $out ($(du -h "$out" | cut -f1))"
    say ""
    say "pull it with:"
    say "  scp $(whoami)@\$PI:$out ."
}

phase_undo() {
    session_attach
    step "stopping our bluealsa"
    local pid; pid="$(state_get BLUEALSA_PID)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" && say "  killed pid $pid"
    else
        say "  not running"
    fi
    if [ "$(state_get BLUEALSA_SERVICE_WAS)" = "active" ]; then
        systemctl start bluealsa && say "  restarted packaged bluealsa.service"
    fi

    step "restoring bluetooth identity"
    local backup; backup="$(state_get MAIN_CONF_BACKUP)"
    if [ -n "$backup" ] && [ -f "$backup" ]; then
        cp -a "$backup" "$MAIN_CONF" && say "  restored $MAIN_CONF"
        systemctl restart bluetooth
    else
        say "  no backup recorded; leaving $MAIN_CONF alone"
    fi
    bluetoothctl discoverable off 2>&1 | sed 's/^/  /'
    bluetoothctl pairable off 2>&1 | sed 's/^/  /'

    local mac; mac="$(state_get TESLA_MAC)"
    if [ -n "$mac" ]; then
        say ""
        say "The pairing with $mac is left in place — remove it from both ends with:"
        say "  bluetoothctl remove $mac      (and 'Forget' on the car's screen)"
    fi
    say ""
    say "Untouched throughout: hostapd, tesla-pi.service, wlan0, wlan1."
}

usage() {
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
    local cmd="${1:-}"
    shift 2>/dev/null
    case "$cmd" in
        env)    need_root env;    phase_env "$@";;
        deps)   need_root deps;   phase_deps "$@";;
        enable) need_root enable; phase_enable "$@";;
        pair)   need_root pair;   phase_pair "$@";;
        use)    need_root use;    phase_use "$@";;
        info)   need_root info;   phase_info "$@";;
        a2dp)   need_root a2dp;   phase_a2dp "$@";;
        watch)  need_root watch;  phase_watch "$@";;
        sco)    need_root sco;    phase_sco "$@";;
        bundle) need_root bundle; phase_bundle "$@";;
        undo)   need_root undo;   phase_undo "$@";;
        ""|-h|--help|help) usage;;
        *) die "unknown phase '$cmd' (try: $0 --help)";;
    esac
}

# Sourced by tests/bt-probe-mock-test.sh, which exercises the phases against
# stub binaries; anything else runs a phase.
if [ "${BT_PROBE_LIB:-0}" != "1" ]; then
    main "$@"
fi
