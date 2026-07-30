#!/bin/bash
# Long-running watcher: when no STA is associated for IDLE_THRESHOLD seconds,
# flip wlan0 from AP to client mode, join home Wi-Fi, pull a fresh shared cert
# from the cert service (scripts/cert-sync.sh), then restore the AP. Triggered
# by physically moving the Pi indoors and powering it on; in the car the Tesla
# associates within minutes so the idle timer never reaches threshold.
#
# The device holds no Cloudflare credential — issuance happens centrally
# (.github/workflows/renew-cert.yml). See docs/turnkey-shared-domain-plan.md.

set -uo pipefail

: "${CARPLAY_DOMAIN:?CARPLAY_DOMAIN must be set in /etc/default/mytesla}"

CERT="/etc/letsencrypt/live/${CARPLAY_DOMAIN}/fullchain.pem"
HOME_WPA="/etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf"
CERT_SYNC="${CERT_SYNC:-/opt/mytesla/scripts/cert-sync.sh}"
AP_IP="192.168.4.254/24"
IDLE_THRESHOLD=600                  # 10 min
POLL_INTERVAL=60
# How long to wait after a sync attempt before flipping again. Unlike the old
# certbot path we no longer gate on cert file age: the service decides when a
# new version exists, so an offline-for-months device picks one up on its first
# idle window instead of waiting out an age threshold.
RETRY_BACKOFF_S="${CERT_SYNC_BACKOFF_S:-21600}"   # 6 h
WPA_TIMEOUT=30
DHCP_TIMEOUT=30
LOCK_FILE="/var/lock/mytesla-cert-flip"  # shared with scripts/cert-renew-now.sh

log() { logger -t cert-renew-watch -- "$*"; printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }

cert_days_remaining() {
  [ -f "$CERT" ] || { echo -1; return; }
  local end epoch
  end=$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2) || { echo -1; return; }
  epoch=$(date -d "$end" +%s 2>/dev/null) || { echo -1; return; }
  echo $(( (epoch - $(date +%s)) / 86400 ))
}

sta_count() {
  hostapd_cli -i wlan0 list_sta 2>/dev/null | grep -cE '^[0-9a-f]{2}:' || true
}

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
  # wpa_supplicant -B forks; give it a moment to associate.
  sleep 5

  if ! timeout "$DHCP_TIMEOUT" dhclient -1 wlan0 >/dev/null 2>&1; then
    log "dhcp failed (home Wi-Fi unreachable?)"
    return 1
  fi

  log "syncing certificate from the cert service"
  # cert-sync.sh: 0 = installed a newer cert, 2 = already current, 1 = failed.
  # It touches /run/cert-renew.deployed on success; the caller reloads nginx.
  "$CERT_SYNC"
  local rc=$?
  case "$rc" in
    0) log "cert updated" ;;
    2) log "cert already current" ;;
    *) log "cert sync failed (rc=$rc)" ;;
  esac
  return "$rc"
}

# ---------- main loop ----------

log "watcher started; idle_threshold=${IDLE_THRESHOLD}s sync_backoff=${RETRY_BACKOFF_S}s"

idle=0
last_attempt=0
while true; do
  sleep "$POLL_INTERVAL"

  if [ "$(sta_count)" -gt 0 ]; then
    if [ "$idle" -gt 0 ]; then
      log "STA reconnected; idle counter reset"
    fi
    idle=0
    continue
  fi

  idle=$(( idle + POLL_INTERVAL ))

  if [ "$idle" -lt "$IDLE_THRESHOLD" ]; then
    continue
  fi

  # Whether a new version exists is the service's call, not ours — but flipping
  # the AP down costs the user connectivity, so don't do it more often than
  # RETRY_BACKOFF_S. The version check itself is cheap once we're online.
  now=$(date +%s)
  if [ "$last_attempt" -ne 0 ] && [ $(( now - last_attempt )) -lt "$RETRY_BACKOFF_S" ]; then
    idle=0
    continue
  fi

  log "10min idle; cert has $(cert_days_remaining)d remaining; attempting sync"
  last_attempt=$now
  # Serialize with cert-renew-now.sh (manual button). flock -n: if the
  # user just clicked Renew, skip this tick rather than queue a second
  # teardown — they'll retry on the next 10-min idle cycle.
  (
    flock -n 9 || { log "manual renewal in flight; skipping auto attempt"; exit 9; }
    attempt_renewal
    arc=$?
    restore_ap
    if [ "$arc" -eq 0 ] && [ -f /run/cert-renew.deployed ]; then
      rm -f /run/cert-renew.deployed
      log "reloading nginx"
      nginx -s reload || log "nginx reload failed"
    fi
    exit "$arc"
  ) 9>"$LOCK_FILE"
  idle=0
done
