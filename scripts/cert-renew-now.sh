#!/bin/bash
# On-demand single-shot cert sync. Triggered by the SPA's "Renew now"
# button via systemd unit cert-renew-now.service (POST /cert/renew →
# sudo systemctl start --no-block). Same teardown→home-Wi-Fi→sync→
# restore-AP flow as cert-renew-watch.sh's attempt_renewal, but bypasses
# the 10-min idle gate and the sync backoff.
#
# Serialized with the watcher via flock on /var/lock/mytesla-cert-flip
# so the two can't double-tear-down the AP if the user clicks Renew
# while the watcher is already mid-flip.

set -uo pipefail

: "${CARPLAY_DOMAIN:?CARPLAY_DOMAIN must be set in /etc/default/mytesla}"

HOME_WPA="/etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf"
CERT_SYNC="${CERT_SYNC:-/opt/mytesla/scripts/cert-sync.sh}"
AP_IP="192.168.4.254/24"
WPA_TIMEOUT=30
DHCP_TIMEOUT=30
LOCK_FILE="/var/lock/mytesla-cert-flip"

log() { logger -t cert-renew-now -- "$*"; printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }

restore_ap() {
  log "restoring AP"
  pkill -x dhclient 2>/dev/null || true
  pkill -x wpa_supplicant 2>/dev/null || true
  ip addr flush dev wlan0 2>/dev/null || true
  ip link set wlan0 down 2>/dev/null || true
  ip link set wlan0 up
  ip addr add "$AP_IP" dev wlan0
  systemctl start dnsmasq
  systemctl start hostapd
}

attempt_renewal() {
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
  sleep 5

  if ! timeout "$DHCP_TIMEOUT" dhclient -1 wlan0 >/dev/null 2>&1; then
    log "dhcp failed (home Wi-Fi unreachable?)"
    return 1
  fi

  log "syncing certificate from the cert service"
  # 0 = installed a newer cert, 2 = already current, 1 = failed.
  "$CERT_SYNC"
  local rc=$?
  case "$rc" in
    0) log "cert updated" ;;
    2) log "cert already current" ;;
    *) log "cert sync failed (rc=$rc)" ;;
  esac
  return "$rc"
}

# Non-blocking lock: if the watcher (or a previous manual click) is mid-flip,
# bail rather than queue up a second teardown.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another renewal in flight; refusing to start"
  exit 1
fi

log "manual renewal triggered"
attempt_renewal
rc=$?
restore_ap
if [ "$rc" -eq 0 ] && [ -f /run/cert-renew.deployed ]; then
  rm -f /run/cert-renew.deployed
  log "reloading nginx"
  nginx -s reload || log "nginx reload failed"
fi
# "already current" (2) is a successful outcome for the user pressing Renew —
# don't leave cert-renew-now.service sitting in a failed state for it.
[ "$rc" -eq 2 ] && exit 0
exit "$rc"
