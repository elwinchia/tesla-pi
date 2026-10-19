#!/bin/bash
# link-watch.sh — one journal line per interval about the car's Wi-Fi link.
#
# Exists to answer one question after the fact: when the car says "DNS address
# could not be found", did its packets stop reaching the Pi, or did the car stop
# sending them to us? The logs we already had cannot tell:
#
#   - hostapd on brcmfmac (FullMAC) only logs "disassociated" when the Pi shuts
#     down, so its log never shows the car leaving or going quiet.
#   - dnsmasq's log-queries stays off (conf/dnsmasq.conf: 37k lines in 4.75 h
#     evicted the CarPlay logs), so a lookup that never arrived leaves no trace.
#
# So instead of logging every query, this counts. A private nftables table
# counts DNS packets arriving on wlan0 (it only counts — the chain accepts and
# the iptables-nft rules in the ip filter/nat tables are untouched), and the
# station dump supplies the radio's own view: how long since the car sent
# anything, packet counters, signal, and connected time (which resets if the car
# silently re-associates).
#
# Each line also carries the kernel's own counters for the interface
# (if_rx/if_tx/if_drop, deltas since the previous line). rx_pkts/tx_pkts come
# from the radio firmware; if_* are what actually crossed into Linux. In
# one outage the firmware kept counting ~4 frames/s from the car while
# DNS fell to 0 — and without if_* that cannot separate "the chip stopped
# handing frames up" from "the car only sends null/keepalive frames".
#
# Reading a line:
#   rx_pkts rising + if_rx ~0 + dns 0          → the Pi's radio stopped passing data up
#   rx_pkts and if_rx both tiny + dns 0        → the car moved its traffic elsewhere (LTE)
#   inactive_ms large + rx_pkts flat + dns 0  → the car stopped sending to us
#   tx_failed climbing while inactive_ms small → the car hears us poorly
#   connected_s reset with no hostapd line     → a silent re-association
#
# ~2,900 lines/day with the car present, 288 with nobody associated — small next
# to the ~25k/day the journal already carries (enable-persistent-journal.sh).
set -uo pipefail

IFACE="${LINKWATCH_IFACE:-wlan0}"
INTERVAL="${LINKWATCH_INTERVAL:-30}"
# With nobody associated there is nothing to watch; one line every IDLE_EVERY
# intervals still proves the watcher itself was alive.
IDLE_EVERY="${LINKWATCH_IDLE_EVERY:-10}"
IW=/usr/sbin/iw
NFT=/usr/sbin/nft
HOSTAPD_CLI=/usr/sbin/hostapd_cli
ARPING=/usr/bin/arping
LEASES=/var/lib/misc/dnsmasq.leases
TABLE=tesla_pi_linkwatch

# Stall handling. Every outage seen in testing had one shape: the
# car stays associated and the radio keeps counting ~4 frames/s from it, but
# nothing reaches Linux (if_rx 0), so the car's 10-min connectivity check
# fails, it shows the orange Wi-Fi "!", and its DNS moves to LTE — where the
# device name does not exist, hence "DNS address could not be found". Each one
# lasted 10-15 min. A healthy car, even idle with the page closed, never sent
# Linux fewer than ~65 packets per 30 s in 2,318 samples; the rule below fired
# only inside one of those outages when replayed against them.
#
# On a stall: probe the link once (arping, a QoS-null poll, the radio's tx and
# tx_failed before/after, hostapd's view of the station) so the log says which
# side is deaf, then deauthenticate the car so it rejoins with fresh keys and a
# fresh lease. Set LINKWATCH_KICK=0 to keep the probe and skip the kick.
STALL_RX_MAX="${LINKWATCH_STALL_RX_MAX:-30}"       # if_rx per interval at or below this…
STALL_SAMPLES="${LINKWATCH_STALL_SAMPLES:-2}"      # …for this many intervals in a row
STALL_MIN_CONNECTED="${LINKWATCH_STALL_MIN_CONNECTED:-120}"  # s; a fresh join is quiet
KICK="${LINKWATCH_KICK:-1}"
KICK_COOLDOWN="${LINKWATCH_KICK_COOLDOWN:-600}"    # s between kicks

log() { echo "$*"; }

setup_counters() {
    # Recreated from scratch on every start so a stale definition never lingers.
    "$NFT" delete table inet "$TABLE" 2>/dev/null || true
    "$NFT" -f - <<EOF
table inet $TABLE {
    counter dns_in {}
    chain input {
        type filter hook input priority -5; policy accept;
        iifname "$IFACE" meta l4proto { udp, tcp } th dport 53 counter name dns_in
    }
}
EOF
}

cleanup() { "$NFT" delete table inet "$TABLE" 2>/dev/null || true; exit 0; }
trap cleanup TERM INT

dns_packets() {
    "$NFT" list counter inet "$TABLE" dns_in 2>/dev/null \
        | awk '/packets/ { for (i = 1; i <= NF; i++) if ($i == "packets") { print $(i+1); exit } }'
}

if ! setup_counters; then
    log "evt=linkwatch_nft_failed iface=$IFACE (dns counts will read -)"
fi
log "evt=linkwatch_start iface=$IFACE interval_s=$INTERVAL power_save=$("$IW" dev "$IFACE" get power_save 2>/dev/null | awk '{print $NF}')"

# Kernel-side counters for the whole interface, as "rx tx rx_dropped".
if_counters() {
    local d=/sys/class/net/$IFACE/statistics
    echo "$(cat "$d/rx_packets" 2>/dev/null || echo -) $(cat "$d/tx_packets" 2>/dev/null || echo -) $(cat "$d/rx_dropped" 2>/dev/null || echo -)"
}
delta() { [[ "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9]+$ ]] && echo $(($1 - $2)) || echo -; }

# "<rx_pkts> <tx_pkts> <tx_failed>" for one station, from the radio.
sta_counters() {
    "$IW" dev "$IFACE" station get "$1" 2>/dev/null | awk '
        /rx packets:/ { rx = $3 } /tx packets:/ { tx = $3 } /tx failed:/ { tf = $3 }
        END { printf "%s %s %s\n", (rx == "" ? "-" : rx), (tx == "" ? "-" : tx), (tf == "" ? "-" : tf) }'
}

handle_stall() {
    local mac=$1 ip arp_rx poll sta fw0_rx fw0_tx fw0_tf fw1_rx fw1_tx fw1_tf k0_rx k0_tx k1_rx k1_tx
    ip="$(awk -v m="$mac" 'tolower($2) == tolower(m) { print $3; exit }' "$LEASES" 2>/dev/null)"
    read -r fw0_rx fw0_tx fw0_tf <<<"$(sta_counters "$mac")"
    k0_rx=$(cat /sys/class/net/$IFACE/statistics/rx_packets 2>/dev/null)
    k0_tx=$(cat /sys/class/net/$IFACE/statistics/tx_packets 2>/dev/null)
    if [[ -n "$ip" ]]; then
        arp_rx="$("$ARPING" -c 3 -w 4 -I "$IFACE" "$ip" 2>/dev/null | grep -c -i "reply from\|bytes from")"
    else
        arp_rx=-
    fi
    poll="$("$HOSTAPD_CLI" -i "$IFACE" poll_sta "$mac" 2>/dev/null | tr -d '\n')"
    sleep 1
    read -r fw1_rx fw1_tx fw1_tf <<<"$(sta_counters "$mac")"
    k1_rx=$(cat /sys/class/net/$IFACE/statistics/rx_packets 2>/dev/null)
    k1_tx=$(cat /sys/class/net/$IFACE/statistics/tx_packets 2>/dev/null)
    sta="$("$HOSTAPD_CLI" -i "$IFACE" sta "$mac" 2>/dev/null | grep -E '^(flags|aid|rx_packets|tx_packets|inactive_msec|connected_time)=' | tr '\n' ' ')"
    # Reading it: arp_replies>0 → both directions work and the car is simply not
    # sending (its side). radio_tx rising with radio_tx_failed flat but no reply
    # → the car's radio ACKs yet nothing answers above it. kernel_tx rising but
    # radio_tx flat → frames die between Linux and the chip (the Pi's side).
    log "evt=linkwatch_stall_probe sta=$mac ip=${ip:--} arp_replies=$arp_rx poll=${poll:--} kernel_tx=+$(delta "$k1_tx" "$k0_tx") kernel_rx=+$(delta "$k1_rx" "$k0_rx") radio_tx=+$(delta "$fw1_tx" "$fw0_tx") radio_tx_failed=+$(delta "$fw1_tf" "$fw0_tf") radio_rx=+$(delta "$fw1_rx" "$fw0_rx") hostapd: $sta"

    local now; now=$(date +%s)
    if [[ "$KICK" != 1 ]]; then
        log "evt=linkwatch_kick_skipped sta=$mac reason=disabled"
    elif (( now - last_kick < KICK_COOLDOWN )); then
        log "evt=linkwatch_kick_skipped sta=$mac reason=cooldown since_last_s=$((now - last_kick))"
    else
        last_kick=$now
        log "evt=linkwatch_kick sta=$mac result=$("$HOSTAPD_CLI" -i "$IFACE" deauthenticate "$mac" 2>&1 | tr -d '\n')"
    fi
}

prev_dns="$(dns_packets)"
read -r prev_if_rx prev_if_tx prev_if_drop <<<"$(if_counters)"
idle_ticks=0
stall_count=0
last_kick=0
while sleep "$INTERVAL"; do
    dns="$(dns_packets)"
    if [[ -n "$dns" && -n "$prev_dns" ]]; then dns_delta=$((dns - prev_dns)); else dns_delta=-; fi
    prev_dns="$dns"
    read -r if_rx if_tx if_drop <<<"$(if_counters)"
    rx_now=$(delta "$if_rx" "$prev_if_rx")
    ifd="if_rx=$rx_now if_tx=$(delta "$if_tx" "$prev_if_tx") if_drop=$(delta "$if_drop" "$prev_if_drop")"
    prev_if_rx=$if_rx prev_if_tx=$if_tx prev_if_drop=$if_drop

    # One output line per station. Fields are absent on drivers that do not
    # report them, which prints as "-" rather than shifting the columns.
    stations="$("$IW" dev "$IFACE" station dump 2>/dev/null | awk -v dns="$dns_delta" -v ifd="$ifd" '
        function flush() {
            if (mac == "") return
            printf "evt=linkwatch sta=%s inactive_ms=%s rx_pkts=%s tx_pkts=%s tx_retries=%s tx_failed=%s signal=%s connected_s=%s dns_in=%s %s\n",
                mac, v["inactive"], v["rx_pkts"], v["tx_pkts"], v["tx_retries"], v["tx_failed"], v["signal"], v["connected"], dns, ifd
        }
        /^Station/ { flush(); mac = $2; split("", v)
                     v["inactive"] = v["rx_pkts"] = v["tx_pkts"] = v["tx_retries"] = v["tx_failed"] = v["signal"] = v["connected"] = "-"; next }
        /inactive time:/ { v["inactive"] = $3 }
        /rx packets:/    { v["rx_pkts"] = $3 }
        /tx packets:/    { v["tx_pkts"] = $3 }
        /tx retries:/    { v["tx_retries"] = $3 }
        /tx failed:/     { v["tx_failed"] = $3 }
        /^[ \t]*signal:/ { v["signal"] = $2 }
        /connected time:/ { v["connected"] = $3 }
        END { flush() }')"

    if [[ -n "$stations" ]]; then
        log "$stations"
        idle_ticks=0
        # if_* are per interface, so the rule only means something with one car on it.
        if [[ $(wc -l <<<"$stations") -eq 1 ]]; then
            conn=$(sed -n 's/.* connected_s=\([0-9]*\).*/\1/p' <<<"$stations")
            if [[ "$rx_now" =~ ^[0-9]+$ && "$conn" =~ ^[0-9]+$ ]] \
               && (( rx_now <= STALL_RX_MAX && conn >= STALL_MIN_CONNECTED )); then
                stall_count=$((stall_count + 1))
            else
                stall_count=0
            fi
            if (( stall_count >= STALL_SAMPLES )); then
                handle_stall "$(sed -n 's/.*sta=\([0-9a-f:]*\).*/\1/p' <<<"$stations")"
                stall_count=0
            fi
        else
            stall_count=0
        fi
    else
        stall_count=0
        idle_ticks=$((idle_ticks + 1))
        if (( idle_ticks >= IDLE_EVERY )); then
            log "evt=linkwatch sta=none dns_in=$dns_delta $ifd"
            idle_ticks=0
        fi
    fi
done
