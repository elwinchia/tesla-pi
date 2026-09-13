#!/bin/bash
# Shared helpers for the two cert-renewal entry points:
#
#   scripts/cert-renew-watch.sh  long-running watcher (cert-renew-watch.service)
#   scripts/cert-renew-now.sh    on-demand oneshot behind the SPA's "Renew now"
#
# Sourced, never executed. Both entry points are installed side by side in
# /opt/tesla-pi/scripts and have to agree on the lock file, the pending-reload
# marker, what counts as an uplink and when nginx may be reloaded — keeping one
# copy of that is what this file is for. Set LOG_TAG before sourcing.

: "${CARPLAY_DOMAIN:?CARPLAY_DOMAIN must be set in /etc/default/tesla-pi}"

HOME_WPA="/etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf"
CERT_SYNC="${CERT_SYNC:-/opt/tesla-pi/scripts/cert-sync.sh}"
AP_IP="192.168.4.254/24"
WPA_TIMEOUT=30
DHCP_TIMEOUT=30
LOCK_FILE="/var/lock/tesla-pi-cert-flip"   # serializes the two entry points
DEPLOYED_FLAG="/run/cert-renew.deployed"   # cert-sync.sh touches this; = reload pending
HEALTH_URL="${CERT_HEALTH_URL:-http://127.0.0.1:8080/healthz}"
# A pending reload waits for the screen to go idle — but not forever. The old
# cert keeps being served until the reload, so waiting is safe up to a point.
RELOAD_DEFER_MAX_S="${CERT_RELOAD_DEFER_MAX_S:-86400}"   # 24 h

log() { logger -t "${LOG_TAG:-cert-renew}" -- "$*"; printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }

# Default route on anything other than wlan0. wlan0 is hostapd's interface, so
# a route there points at the AP subnet rather than the internet. Empty output
# means the only way out is our own AP, i.e. no internet.
uplink_iface() {
  ip -4 route show default 2>/dev/null \
    | awk '{ for (i = 1; i < NF; i++) if ($i == "dev" && $(i+1) != "wlan0") { print $(i+1); exit } }'
}

# cert-sync.sh: 0 = installed a newer cert, 2 = already current, 1 = failed.
# It touches DEPLOYED_FLAG on success; reload_nginx_if_deployed acts on that.
run_sync() {
  log "syncing certificate from the cert service"
  "$CERT_SYNC"
  local rc=$?
  case "$rc" in
    0) log "cert updated" ;;
    2) log "cert already current" ;;
    *) log "cert sync failed (rc=$rc)" ;;
  esac
  return "$rc"
}

# Is the Tesla actually watching something right now? nginx reloads gracefully
# (old workers keep established connections until they close, and no
# worker_shutdown_timeout is configured), so a live CarPlay stream survives a
# reload — but only by riding an old worker, and any distro that does set
# worker_shutdown_timeout would cut it. Cheaper to just not reload mid-stream.
# App unreachable → 0: there is nothing to protect.
streaming() {
  local n
  n=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null \
      | sed -n 's/.*"video_clients"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p')
  [ -n "$n" ] && [ "$n" -gt 0 ]
}

# 0 = nothing pending, or reloaded. 3 = deferred, flag left in place for a later
# tick (the watcher retries every POLL_INTERVAL). Never deletes the flag without
# reloading: the flag IS the pending state, and its mtime is how long we waited.
reload_nginx_if_deployed() {
  [ -f "$DEPLOYED_FLAG" ] || return 0
  if streaming; then
    local age=$(( $(date +%s) - $(stat -c %Y "$DEPLOYED_FLAG" 2>/dev/null || echo 0) ))
    [ "$age" -lt "$RELOAD_DEFER_MAX_S" ] && return 3
    log "cert has been waiting ${age}s and the screen is still streaming; reloading anyway"
  fi
  rm -f "$DEPLOYED_FLAG"
  log "reloading nginx"
  nginx -s reload || log "nginx reload failed"
  return 0
}

# Start a unit and prove it took.
#
# `systemctl start` succeeding means "systemd ran the ExecStart", not "the
# daemon is up", and both units below used to be started blind. That is how the
# AP comes back looking healthy while DNS is dead: dnsmasq is configured
# bind-interfaces + listen-address=192.168.4.254 (conf/dnsmasq.conf), so it
# binds that exact address at startup and exits if wlan0 is not carrying it
# yet — and the address is re-added one line earlier, in the same breath as an
# interface bounce.
#
# The failure is silent and permanent. Debian's dnsmasq unit sets no Restart=,
# and net-share.sh only ever restarts a dnsmasq that is *already* running
# (`systemctl is-active --quiet dnsmasq`), so nothing in the system brings it
# back. Meanwhile hostapd is fine, the SSID is there, and the car still holds a
# valid 24 h DHCP lease naming 192.168.4.254 as its resolver — so it associates
# happily and then fails every lookup. From the driver's seat that is "the app
# won't load, something about DNS", with a healthy-looking Wi-Fi icon.
#
# Retried rather than diagnosed: the race resolves itself in well under a
# second, and restore_ap's whole job is to put the AP back.
start_verified() {   # $1 = unit
  local i
  for i in 1 2 3 4 5; do
    systemctl start "$1" 2>/dev/null
    systemctl is-active --quiet "$1" && return 0
    log "$1 did not come up (attempt ${i}/5); retrying"
    sleep 1
  done
  log "FAILED to bring $1 back up after the AP flip — AP clients have no ${1}"
  return 1
}

restore_ap() {
  # This is the last word on the AP, so drop the safety net attempt_renewal
  # installed; otherwise a normal return would run the whole thing twice.
  trap - EXIT INT TERM
  log "restoring AP"
  pkill -x dhclient 2>/dev/null || true
  pkill -x wpa_supplicant 2>/dev/null || true
  ip addr flush dev wlan0 2>/dev/null || true
  ip link set wlan0 down 2>/dev/null || true
  ip link set wlan0 up
  ip addr add "$AP_IP" dev wlan0 || log "could not re-add $AP_IP to wlan0"
  # dnsmasq before hostapd, deliberately: dnsmasq is the DHCP server as well as
  # the resolver, so a car that associates before it is listening gets neither
  # a lease nor a nameserver.
  start_verified dnsmasq
  start_verified hostapd
}

# The expensive path: drop the AP, join the home Wi-Fi, sync. Only worth it when
# uplink_iface came back empty. The caller must restore_ap afterwards, whatever
# the outcome. Returns run_sync's code, or 1 if we never got online.
attempt_renewal() {
  # From here until restore_ap runs, the car has no SSID, no DHCP and no DNS.
  # Both callers already call restore_ap on every return path, but neither
  # survives being killed mid-flip — a systemd stop, a reboot, or the ignition
  # going off — and what gets left behind is an AP that never comes back until
  # the next boot. The trap covers exactly that gap; restore_ap clears it.
  trap 'restore_ap' EXIT
  trap 'restore_ap; exit 1' INT TERM
  log "tearing down AP for renewal"
  systemctl stop hostapd
  systemctl stop dnsmasq
  ip addr flush dev wlan0
  ip link set wlan0 down
  ip link set wlan0 up

  log "associating to home Wi-Fi"
  if ! timeout "$WPA_TIMEOUT" wpa_supplicant -B -i wlan0 -c "$HOME_WPA" -D nl80211 >/dev/null 2>&1; then
    log "wpa_supplicant failed to start"
    return 1
  fi
  # wpa_supplicant -B forks; give it a moment to associate.
  sleep 5

  if ! timeout "$DHCP_TIMEOUT" dhclient -1 wlan0 >/dev/null 2>&1; then
    log "dhcp failed (home Wi-Fi unreachable?)"
    return 1
  fi

  run_sync
}
