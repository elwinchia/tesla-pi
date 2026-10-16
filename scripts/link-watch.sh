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
TABLE=tesla_pi_linkwatch

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

prev_dns="$(dns_packets)"
read -r prev_if_rx prev_if_tx prev_if_drop <<<"$(if_counters)"
idle_ticks=0
while sleep "$INTERVAL"; do
    dns="$(dns_packets)"
    if [[ -n "$dns" && -n "$prev_dns" ]]; then dns_delta=$((dns - prev_dns)); else dns_delta=-; fi
    prev_dns="$dns"
    read -r if_rx if_tx if_drop <<<"$(if_counters)"
    ifd="if_rx=$(delta "$if_rx" "$prev_if_rx") if_tx=$(delta "$if_tx" "$prev_if_tx") if_drop=$(delta "$if_drop" "$prev_if_drop")"
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
    else
        idle_ticks=$((idle_ticks + 1))
        if (( idle_ticks >= IDLE_EVERY )); then
            log "evt=linkwatch sta=none dns_in=$dns_delta $ifd"
            idle_ticks=0
        fi
    fi
done
