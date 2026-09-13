#!/bin/bash
# ap-radio-select.sh — pick a hostapd radio config the local regulatory
# domain actually permits, and write it into hostapd.conf.
#
# Why this exists: conf/hostapd.conf.template ships a 5 GHz UNII-3 channel
# (149). That is fine in MY/US and forbidden across most of the EU. hostapd
# does not degrade when handed a channel its regdomain rejects — it exits.
# On an appliance with no screen, no keyboard and (by default) no SSH, a
# hostapd that exits is a brick: the only way in is the AP it just failed to
# start. So instead of shipping one channel and hoping, we set the regulatory
# domain, ask the kernel which channels it will actually let us beacon on, and
# choose from that list.
#
# Only radio fields are touched: country_code, hw_mode, channel, ieee80211n/ac,
# ht_capab, vht_*. `ssid` and `wpa_passphrase` are never read or written —
# those belong to the owner and to scripts/tesla-pi-ap.
#
# Usage:  ap-radio-select.sh [COUNTRY]
#   COUNTRY  ISO 3166-1 alpha-2 (e.g. GB, US, DE), or 00 for the world
#            domain. Falls back to AP_COUNTRY in /etc/default/tesla-pi, then
#            to the country_code already in hostapd.conf, then to 00.
#
# Re-runnable: safe to call again after the owner changes country.
#
# Owns three side effects, so that no caller has to remember them:
#   1. hostapd.conf radio fields, plus a .bak that `tesla-pi-ap restart` needs
#      to roll back to if the new channel does not come up,
#   2. AP_COUNTRY in /etc/default/tesla-pi — the resolved value, not the
#      requested one,
#   3. $STATE_DIR/radio.env, reporting what was chosen and why.

set -euo pipefail

HOSTAPD_CONF="${HOSTAPD_CONF:-/etc/hostapd/hostapd.conf}"
ENV_FILE="${ENV_FILE:-/etc/default/tesla-pi}"
STATE_DIR="${STATE_DIR:-/var/lib/tesla-pi}"
IFACE="${AP_IFACE:-wlan0}"

log() { echo "[ap-radio] $*"; }
die() { echo "[ap-radio] error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f $HOSTAPD_CONF ]] || die "missing $HOSTAPD_CONF"

# ---------------------------------------------------------------- country ---
country="${1:-}"
if [[ -z $country && -r $ENV_FILE ]]; then
    country="$(sed -n 's/^[[:space:]]*AP_COUNTRY=//p' "$ENV_FILE" | tr -d '"'"'" | head -1)"
fi
if [[ -z $country ]]; then
    country="$(sed -n 's/^country_code=//p' "$HOSTAPD_CONF" | head -1)"
fi
country="${country:-00}"
country="$(tr '[:lower:]' '[:upper:]' <<<"$country")"

if [[ ! $country =~ ^([A-Z]{2}|00)$ ]]; then
    log "'$country' is not a 2-letter country code — falling back to world (00)"
    country=00
fi

# ------------------------------------------------------------- capability ---
# Ask the kernel what this radio may beacon on under $country. `iw reg set` is
# not persistent across reboots, but it does not need to be: hostapd re-applies
# the domain itself from country_code + ieee80211d=1 every time it starts. We
# only need it set *now*, so the channel survey below tells the truth.
if command -v iw >/dev/null 2>&1; then
    iw reg set "$country" 2>/dev/null || log "warning: 'iw reg set $country' failed"
    sleep 1
else
    die "'iw' is not installed — cannot survey the radio"
fi

# AP_PHY exists so this can be exercised against a stubbed `iw` in tests, and
# for the rare board where wlan0 is not backed by the expected phy.
phy="${AP_PHY:-}"
if [[ -z $phy && -e /sys/class/net/$IFACE/phy80211/name ]]; then
    phy="$(cat "/sys/class/net/$IFACE/phy80211/name")"
fi
[[ -n $phy ]] || die "no phy for $IFACE — is the Wi-Fi adapter present?"

iw_info="$(iw phy "$phy" info 2>/dev/null || true)"
[[ -n $iw_info ]] || die "'iw phy $phy info' returned nothing"

# A channel is usable for an AP only if the kernel lists it and marks it
# neither disabled nor no-IR (no initiate radiation, i.e. listen-only). We also
# refuse DFS channels: hostapd can use them, but the mandatory channel-
# availability check stalls the AP for 60+ seconds on every start, and a radar
# event bounces the car off the hotspot mid-drive.
chan_ok() {
    local ch="$1" line
    # iw 5.x prints "* 5745 MHz [149]", iw 6.x prints "* 5745.0 MHz [149]".
    # Matching only the integer form makes EVERY channel look unavailable on a
    # current iw, which is not a visible failure — it silently drops a working
    # 5 GHz AP to 2.4 GHz channel 6 with reason=fallback. Verified against
    # iw 6.9 on a Pi 4 (Bookworm), which is what the image ships.
    line="$(grep -E "\* [0-9]+(\.[0-9]+)? MHz \[$ch\]" <<<"$iw_info" | head -1)"
    if [[ -z $line ]]; then return 1; fi
    if [[ $line == *disabled* ]]; then return 1; fi
    if [[ $line == *"no IR"* ]]; then return 1; fi
    if [[ $line == *"passive scan"* ]]; then return 1; fi
    if [[ $line == *"radar detection"* ]]; then return 1; fi
    return 0
}

all_ok() {
    local ch
    for ch in "$@"; do
        if ! chan_ok "$ch"; then return 1; fi
    done
    return 0
}

# ------------------------------------------------------------------ pick ----
# Preference order, best first:
#   1. 80 MHz on UNII-3 (149). Deliberately far from the Carlinkit dongle,
#      which serves the phone on channel 36 — see conf/hostapd.conf.template
#      for why sharing that block halves throughput for what is really the
#      same video stream carried twice.
#   2. 80 MHz on UNII-1 (36). Same block as the dongle, but still 5 GHz.
#   3. Any single 20 MHz 5 GHz channel.
#   4. 2.4 GHz. Slower and noisier, but legal essentially everywhere — this is
#      what an unset COUNTRY lands on, and it is why a mis-set country
#      degrades the picture instead of bricking the box.
mode=g; chan=6; seg0=""; chwidth=""; band="2.4 GHz"; reason="fallback"

if all_ok 149 153 157 161; then
    mode=a; chan=149; seg0=155; chwidth=1; band="5 GHz"; reason="UNII-3, 80 MHz"
elif all_ok 36 40 44 48; then
    mode=a; chan=36;  seg0=42;  chwidth=1; band="5 GHz"; reason="UNII-1, 80 MHz"
else
    for c in 149 153 157 161 36 40 44 48 165; do
        if chan_ok "$c"; then
            mode=a; chan="$c"; seg0="$c"; chwidth=0; band="5 GHz"; reason="20 MHz only"
            break
        fi
    done
fi

if [[ $mode == g ]]; then
    for c in 6 1 11; do
        if chan_ok "$c"; then chan="$c"; reason="2.4 GHz only"; break; fi
    done
fi

# ----------------------------------------------------------------- write ----
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cp "$HOSTAPD_CONF" "$tmp"

set_kv() {
    local key="$1" val="$2"
    if grep -qE "^[#[:space:]]*${key}=" "$tmp"; then
        sed -i "s|^[#[:space:]]*${key}=.*|${key}=${val}|" "$tmp"
    else
        printf '%s=%s\n' "$key" "$val" >>"$tmp"
    fi
}

del_kv() {
    local key="$1"
    sed -i "/^[[:space:]]*${key}=/d" "$tmp"
}

# '00' is a valid regulatory domain for the kernel but NOT a valid
# country_code for hostapd, which rejects the config outright:
#   Line 4: Invalid country_code '00'
#   Cannot enable IEEE 802.11d without setting the country_code
# Verified on hostapd 2.10 (Bookworm). `restart` rolls back, so the symptom is
# a country change that silently does nothing rather than a dead AP — but the
# owner picked "Not listed" and deserves better than a no-op. For the world
# domain we therefore drop country_code entirely and turn 802.11d off; the
# channel choice above has already been constrained to what 00 permits.
if [[ $country == 00 ]]; then
    del_kv country_code
    set_kv ieee80211d 0
else
    set_kv country_code "$country"
    set_kv ieee80211d 1
fi
set_kv hw_mode "$mode"
set_kv channel "$chan"
set_kv ieee80211n 1

if [[ $mode == a ]]; then
    set_kv ieee80211ac 1
    set_kv vht_capab '[SHORT-GI-80]'
    set_kv vht_oper_chwidth "$chwidth"
    set_kv vht_oper_centr_freq_seg0_idx "$seg0"
    # HT40+ is only valid when the channel is the lower half of its pair.
    # 149/36 both are; a single-channel fallback may not be, so drop to HT20.
    if [[ $chwidth == 1 ]]; then
        set_kv ht_capab '[HT40+]'
    else
        del_kv ht_capab
    fi
else
    # 2.4 GHz: no VHT at all (hostapd rejects ieee80211ac with hw_mode=g), and
    # HT20 rather than HT40 — 40 MHz on 2.4 is antisocial and often disallowed.
    set_kv ieee80211ac 0
    del_kv vht_capab
    del_kv vht_oper_chwidth
    del_kv vht_oper_centr_freq_seg0_idx
    del_kv ht_capab
fi

# Snapshot before overwriting. tesla-pi-ap's `restart` rolls back to this file
# when hostapd fails to come up, and that is the difference between a bad
# channel and an appliance with no radio at all. It belongs here rather than in
# each caller: this is the only place hostapd.conf's radio fields are written,
# so putting it anywhere else means the next caller has to remember.
cp -f "$HOSTAPD_CONF" "$HOSTAPD_CONF.bak" 2>/dev/null || true

install -m 0600 -o root -g root "$tmp" "$HOSTAPD_CONF"

# Persist the *resolved* country — after validation and the fallback to 00 — so
# a re-run with no argument, and Settings → Hotspot, agree with what actually
# took effect. Callers used to each do this themselves and had drifted apart on
# whether '00' was legal and whether to create the file.
if [[ -n $ENV_FILE ]]; then
    if [[ ! -e $ENV_FILE ]]; then
        # 0600 from the start: this file also carries CERT_SYNC_TOKEN, and a
        # bare >> redirect would create it world-readable.
        install -m 0600 -o root -g root /dev/null "$ENV_FILE" \
            || log "warning: cannot create $ENV_FILE — country not persisted"
    fi
    if [[ -w $ENV_FILE ]]; then
        if grep -q '^AP_COUNTRY=' "$ENV_FILE"; then
            sed -i "s/^AP_COUNTRY=.*/AP_COUNTRY=$country/" "$ENV_FILE"
        else
            printf 'AP_COUNTRY=%s\n' "$country" >>"$ENV_FILE"
        fi
    fi
fi

# key=value, the format every other shell/Node boundary in this project speaks
# (hostapd.conf, /etc/default/tesla-pi, tesla-pi-ap's own stdout). It was JSON,
# which meant the one consumer scraped it back out with a regex.
install -d -m 0755 "$STATE_DIR"
printf 'country=%s\nband=%s\nhw_mode=%s\nchannel=%s\nreason=%s\n' \
    "$country" "$band" "$mode" "$chan" "$reason" >"$STATE_DIR/radio.env"

log "country=$country -> $band channel $chan ($reason)"
