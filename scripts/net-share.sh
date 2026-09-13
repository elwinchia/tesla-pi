#!/bin/bash
# Internet sharing for AP clients, and the DNS policy that has to move with it.
#
# The packet path is static: conf/sysctl-ip-forward.conf turns forwarding on and
# conf/iptables.ipv4.nat masquerades 192.168.4.0/24 out of any interface that
# isn't wlan0. With no uplink those rules simply never match, so nothing here
# needs to touch them.
#
# DNS is the part that cannot be static, because the two states want opposite
# things:
#
#   uplink up  → forward real queries upstream, so the Tesla actually reaches
#                the internet through us.
#   no uplink  → answer every name with 240.3.3.4 (the walled garden). Without
#                this the car's connectivity probe fails and it drops the SSID,
#                taking CarPlay down with it.
#
# So this watcher tracks the uplink and regenerates one dnsmasq snippet. It is
# the only writer of MODE_FILE; conf/dnsmasq.conf deliberately contains no
# resolver policy of its own.
set -uo pipefail

LOG_TAG=net-share
# CARPLAY_DOMAIN comes from here, and the lib below insists on it. The unit also
# sets EnvironmentFile, so this is belt and braces for a hand-run.
[ -r /etc/default/tesla-pi ] && . /etc/default/tesla-pi
# Sourced for log() and uplink_iface(). The file is named for the cert scripts
# that gave rise to it, but "what counts as an uplink" is exactly the question
# being asked here, and two answers that could drift is how this project got a
# shared lib in the first place.
. "$(dirname "$(readlink -f "$0")")/cert-renew-lib.sh"

MODE_FILE=/etc/dnsmasq.d/10-tesla-pi-mode.conf
POLL_INTERVAL="${NETSHARE_POLL_INTERVAL:-20}"
# Named explicitly rather than inherited from the uplink's DHCP: a hotel or
# tethered network often hands out a resolver that only answers for its own
# clients, and dnsmasq would then forward the car's queries into a black hole.
# The uplink's own resolver is appended after these, not instead of them —
# see upstream_servers().
UPSTREAM_DNS="${NETSHARE_UPSTREAM_DNS:-1.1.1.1 8.8.8.8}"
AP_IP=192.168.4.254
# The walled garden's stand-in address. Not routable and not ours: the DNAT
# rules in conf/iptables.ipv4.nat pull :80/:443 for it back to nginx on the Pi.
# The Tesla probe is answered with THIS in both modes, never with AP_IP — see
# render_mode() for what happens when it isn't.
GARDEN_IP=240.3.3.4

# Health probe. Resolving a real name through the upstream resolvers is the
# closest cheap stand-in for "will the car's own lookups be answered", which is
# the only thing shared mode actually promises.
HEALTH_NAME="${NETSHARE_HEALTH_NAME:-www.google.com}"
HEALTH_TIMEOUT="${NETSHARE_HEALTH_TIMEOUT:-3}"
# Consecutive results needed to change mode, and deliberately asymmetric. One
# successful probe is enough to start sharing, because a probe that answered is
# already strong evidence — unlike a bare default route, which is what this
# watcher used to trust. Giving sharing up costs a dnsmasq restart, so it takes
# a sustained failure rather than one blip.
UP_STREAK="${NETSHARE_UP_STREAK:-1}"
DOWN_STREAK="${NETSHARE_DOWN_STREAK:-3}"

# The resolver the uplink's own DHCP handed us. Appended after the public
# servers rather than replacing them: a network that blackholes 1.1.1.1 and
# 8.8.8.8 — increasingly common with a filtering router — almost always still
# runs one of its own, and without this the car simply has no DNS there.
dhcp_resolver() {   # $1 = iface
  [ -n "$1" ] || return 0
  timeout 3 nmcli -g IP4.DNS device show "$1" 2>/dev/null \
    | tr '|' '\n' \
    | grep -E '^[0-9]+(\.[0-9]+){3}$' \
    | grep -vx "$AP_IP" \
    | head -2
}

# Every resolver dnsmasq should forward to, in preference order. One per line.
upstream_servers() {   # $1 = iface
  printf '%s\n' $UPSTREAM_DNS
  dhcp_resolver "$1"
}

# busybox is the only DNS client on the image (no dig, no nslookup, no host).
# If a future image drops it there is no way to ask the question, and the safe
# answer is the old behaviour — trust the route — rather than being pinned
# offline forever by a probe that can never pass.
if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx nslookup; then
  HAVE_PROBE=1
else
  HAVE_PROBE=0
  log "no busybox nslookup on this image; falling back to route-only uplink detection"
fi

# Does the uplink actually resolve? A default route is not the same as a working
# path: after a reboot wlan1 can hold a route for minutes while the link is
# still unusable. Shared mode entered on that promise stops answering the car's
# probe hosts locally, so the car fails its join-time internet check and refuses
# to join at all — taking CarPlay with it, not just internet. Walled mode has no
# such dependency, so when the answer is unclear we stay there.
probe_ok() {   # $1 = iface
  [ "$HAVE_PROBE" = 1 ] || return 0
  local s
  for s in $(upstream_servers "$1"); do
    if timeout "$HEALTH_TIMEOUT" busybox nslookup "$HEALTH_NAME" "$s" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# Emit the snippet for one mode on stdout.
render_mode() {   # $1 = shared | walled, $2 = uplink name (may be empty)
  echo "# Generated by net-share.sh — regenerated on every uplink change."
  echo "# Edits here are lost. Mode: $1"
  if [ "$1" = shared ]; then
    # Two names must not go upstream even with real DNS available:
    #
    #   CARPLAY_DOMAIN has no public A record, so an upstream lookup returns
    #   NXDOMAIN and the car can no longer load the app at all.
    #
    #   The Tesla connectivity probe stays local so that keeping the SSID never
    #   depends on the uplink being healthy — which is the whole point of the
    #   bypass in nginx-carplay.conf. It also means the car sees one consistent
    #   answer across a mode flip instead of a probe that changes character.
    #
    # The probe answer is GARDEN_IP, not AP_IP, and that distinction is not
    # cosmetic. Measured in the car on 2026-08-21: with the probe resolving to
    # AP_IP the MCU associated, completed the WPA handshake, took a DHCP lease,
    # asked for connman.vn.tesla.services exactly once — and then disassociated
    # without opening a single TCP connection, in a loop. Handing a client its
    # own gateway and resolver back as the probe target is what a spoofing
    # captive portal looks like, and the car treats it as one. GARDEN_IP reaches
    # the same nginx server block through the DNAT rules and is accepted.
    #
    # Each name is also declared local=, which is what stops dnsmasq forwarding
    # the query types address= does not answer. Chromium asks for the HTTPS
    # (SVCB, type 65) record beside every A record; without local= that one
    # query goes upstream, CARPLAY_DOMAIN has no public record, and the
    # NXDOMAIN that comes back is enough for the browser to give up on a name
    # whose A record we answered correctly one line earlier. Measured in the
    # car on 2026-08-21: the A query resolved to AP_IP, the HTTPS query was
    # forwarded, and nginx never saw a connection. local= makes dnsmasq
    # authoritative, so those types come back NODATA from here.
    echo "local=/${CARPLAY_DOMAIN}/"
    echo "address=/${CARPLAY_DOMAIN}/${AP_IP}"
    echo "local=/connman.vn.tesla.services/"
    echo "address=/connman.vn.tesla.services/${GARDEN_IP}"
    echo "local=/connman.vn.cloud.tesla.cn/"
    echo "address=/connman.vn.cloud.tesla.cn/${GARDEN_IP}"
    upstream_servers "$2" | while read -r s; do echo "server=$s"; done
  else
    # One wildcard for everything — the walled garden — plus one exception that
    # is not about where the name points but about how other query types are
    # answered. A wildcard address= leaves dnsmasq REFUSING the HTTPS/SVCB
    # (type 65) record Chromium asks for beside every A record, and a REFUSED
    # can sink the whole lookup in the browser. local= makes dnsmasq
    # authoritative for our name so that query comes back NODATA instead.
    # The address stays GARDEN_IP: the DNAT rules carry :80/:443 to nginx, which
    # is the behaviour this mode has always had.
    echo "local=/${CARPLAY_DOMAIN}/"
    echo "address=/${CARPLAY_DOMAIN}/${GARDEN_IP}"
    echo "address=/#/${GARDEN_IP}"
  fi
}

# Write only on change: an unchanged file means no dnsmasq restart, and dnsmasq
# does not re-read its config on SIGHUP, so a restart is the only way to apply
# one — brief, but it drops DHCP service for a moment.
apply_mode() {   # $1 = shared | walled, $2 = uplink name (may be empty)
  local tmp
  tmp="$(mktemp)" || return 1
  render_mode "$1" "$2" >"$tmp"
  if cmp -s "$tmp" "$MODE_FILE"; then
    rm -f "$tmp"
    return 0
  fi
  install -m 0644 "$tmp" "$MODE_FILE"
  rm -f "$tmp"
  if [ "$1" = shared ]; then
    log "uplink up on ${2}; sharing internet with AP clients (DNS → $(upstream_servers "$2" | tr '\n' ' '))"
  else
    log "no usable uplink; AP falls back to the offline walled garden"
  fi
  # Only if it is already running. The cert renewer's AP-flip path stops dnsmasq
  # on purpose while it borrows wlan0, and starting it back up underneath that
  # would fight it; the flip restores dnsmasq itself, with this file already
  # correct for whatever state it lands in.
  if systemctl is-active --quiet dnsmasq; then
    systemctl restart dnsmasq || log "dnsmasq restart failed"
  fi
}

# ---- dnsmasq watchdog ------------------------------------------------------
# apply_mode above will not start a stopped dnsmasq, only restart a running
# one, so that it can never fight the cert renewer — which stops dnsmasq on
# purpose while it borrows wlan0 for the home Wi-Fi. That is the right call and
# it leaves exactly one gap: a renewal that went down without restoring, from a
# kill, a reboot mid-flip, or a start that lost the race with wlan0's address.
# Nothing else in the system recovers from it. Debian's dnsmasq unit sets no
# Restart=, so the daemon simply stays dead, while hostapd is untouched: the
# SSID is there, the car still holds a 24 h lease naming 192.168.4.254 as its
# resolver, it associates without complaint — and every name fails. From the
# driver's seat, "the app won't load, something about DNS".
#
# Telling the two apart needs no new state, because the flip already has a
# lock. Held → a renewal really is in flight and dnsmasq is down deliberately.
# Free → nobody is flipping. The down-streak on top of that is belt and braces
# for a flip that outlives its usual ~40 s: two independent reasons to wait,
# and the cost of waiting is one more poll.
FLIP_LOCK=/var/lock/tesla-pi-cert-flip
DNS_DOWN_STREAK="${NETSHARE_DNS_DOWN_STREAK:-3}"
dns_down=0
heal_dnsmasq() {
  if systemctl is-active --quiet dnsmasq; then
    dns_down=0
    return 0
  fi
  dns_down=$((dns_down + 1))
  [ "$dns_down" -ge "$DNS_DOWN_STREAK" ] || return 0
  # Probe the lock without holding it: acquire-and-release in one shot, so the
  # worst a collision can cost is one renewal tick logging "another renewal in
  # flight" and trying again.
  if ! flock -n "$FLIP_LOCK" true 2>/dev/null; then
    log "dnsmasq is down but a renewal holds the flip lock; leaving it alone"
    return 0
  fi
  log "dnsmasq has been down for $((dns_down * POLL_INTERVAL))s with no renewal in flight; starting it"
  if systemctl start dnsmasq; then
    dns_down=0
  else
    log "dnsmasq start failed; AP clients still have no DNS or DHCP"
  fi
}

# Advance the mode by one sample. Deliberately mutates `mode` and the streak
# counters rather than echoing a result: `$(...)` would run this in a subshell
# and every streak would be discarded the moment it was counted.
mode=walled
up_hits=0
down_hits=0
advance_mode() {   # $1 = iface (may be empty)
  if [ -z "$1" ]; then
    up_hits=0
    down_hits=0
    mode=walled
    return
  fi
  if probe_ok "$1"; then
    up_hits=$((up_hits + 1)); down_hits=0
  else
    down_hits=$((down_hits + 1)); up_hits=0
  fi
  if [ "$mode" = shared ]; then
    [ "$down_hits" -ge "$DOWN_STREAK" ] && mode=walled
  else
    [ "$up_hits" -ge "$UP_STREAK" ] && mode=shared
  fi
  return 0   # the tests above are conditions, not the function's verdict
}

uplink="$(uplink_iface)"
advance_mode "$uplink"
log "watcher started; poll=${POLL_INTERVAL}s uplink=${uplink:-none} mode=${mode}"
# Unconditionally on start, so a boot into either state converges without
# waiting for a transition that may never come.
apply_mode "$mode" "$uplink"

while true; do
  sleep "$POLL_INTERVAL"
  uplink="$(uplink_iface)"
  advance_mode "$uplink"
  apply_mode "$mode" "$uplink"
  # After apply_mode, so a mode change that wanted a restart has already had its
  # chance and this only ever sees a dnsmasq that is genuinely not coming back.
  heal_dnsmasq
done
