#!/bin/bash
# Long-running watcher with two ways to pick up a fresh shared cert from the
# cert service (scripts/cert-sync.sh):
#
#   1. Whenever the device has an uplink that isn't its own AP — eth0, a second
#      Wi-Fi adapter, a USB tether — sync in place. Nothing is torn down, so
#      this runs on every transition to online (and again every backoff window
#      while it stays online). This is the normal path for a Pi that is docked,
#      plugged in, or otherwise on a network.
#   2. Otherwise, when no STA has been associated for IDLE_THRESHOLD seconds,
#      flip wlan0 from AP to client mode, join home Wi-Fi, sync, restore the AP.
#      Triggered by physically moving the Pi indoors and powering it on; in the
#      car the Tesla associates within minutes so the idle timer never reaches
#      threshold.
#
# The device holds no Cloudflare credential — issuance happens centrally
# (.github/workflows/renew-cert.yml). See docs/turnkey-shared-domain-plan.md.

set -uo pipefail

LOG_TAG=cert-renew-watch
. "$(dirname "$(readlink -f "$0")")/cert-renew-lib.sh"

CERT="/etc/letsencrypt/live/${CARPLAY_DOMAIN}/fullchain.pem"
IDLE_THRESHOLD=600                  # 10 min
POLL_INTERVAL=60
# How long to wait after a sync attempt before trying again. Unlike the old
# certbot path we no longer gate on cert file age: the service decides when a
# new version exists, so an offline-for-months device picks one up on its first
# idle window instead of waiting out an age threshold.
RETRY_BACKOFF_S="${CERT_SYNC_BACKOFF_S:-21600}"   # 6 h
# Shorter retry for the in-place path when a sync fails while a route exists
# (captive portal, DNS not up yet). Nothing is torn down, so retrying is cheap.
ONLINE_RETRY_S="${CERT_SYNC_ONLINE_RETRY_S:-600}" # 10 min

cert_days_remaining() {
  [ -f "$CERT" ] || { echo -1; return; }
  local end epoch
  end=$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2) || { echo -1; return; }
  epoch=$(date -d "$end" +%s 2>/dev/null) || { echo -1; return; }
  echo $(( (epoch - $(date +%s)) / 86400 ))
}

# Prints a bare integer, or NOTHING when hostapd_cli cannot attach (missing
# ctrl_interface, socket gone, hostapd down). The caller must treat empty as
# "assume the car is here": this gate is the only thing standing between a
# connected Tesla and the AP being torn out from under it.
HOSTAPD_CLI="$(command -v hostapd_cli 2>/dev/null || echo /usr/sbin/hostapd_cli)"
sta_count() {
  local out
  out="$("$HOSTAPD_CLI" -i wlan0 list_sta 2>/dev/null)" || return 0
  printf '%s' "$out" | grep -cE '^[0-9a-f]{2}:'
}

# ---------- main loop ----------

log "watcher started; idle_threshold=${IDLE_THRESHOLD}s sync_backoff=${RETRY_BACKOFF_S}s online_retry=${ONLINE_RETRY_S}s"

idle=0
last_attempt=0
last_online_sync=0
online_wait=$RETRY_BACKOFF_S   # how long to wait before the next in-place sync
was_online=0
defer_logged=0
unknown_sta_logged=0
while true; do
  sleep "$POLL_INTERVAL"

  # ---- pending reload: retry every tick so a new cert goes live the moment
  # the screen stops streaming. Costs one loopback GET while the flag exists.
  if [ -f "$DEPLOYED_FLAG" ]; then
    ( flock -n 9 || exit 9; reload_nginx_if_deployed ) 9>"$LOCK_FILE"
    case "$?" in
      3) [ "$defer_logged" -eq 0 ] && { log "new cert staged; holding the nginx reload while the screen is streaming"; defer_logged=1; } ;;
      *) defer_logged=0 ;;
    esac
  fi

  # ---- path 1: an uplink is up, so sync without touching the AP ----
  # Every transition offline→online gets an immediate attempt (that is what
  # "renews whenever it connects to the internet" means), then at most once per
  # RETRY_BACKOFF_S while the link stays up. Costs nothing visible: hostapd,
  # dnsmasq and the Tesla's association are all untouched.
  uplink="$(uplink_iface)"
  if [ -n "$uplink" ]; then
    now=$(date +%s)
    if [ "$was_online" -eq 0 ] || [ $(( now - last_online_sync )) -ge "$online_wait" ]; then
      [ "$was_online" -eq 0 ] && log "uplink up on ${uplink}; cert has $(cert_days_remaining)d remaining"
      was_online=1
      last_online_sync=$now
      # Same lock as the AP-flip path: both write the cert files and reload
      # nginx. -n so a manual renewal in flight just defers us.
      (
        flock -n 9 || { log "another renewal in flight; skipping online sync"; exit 9; }
        run_sync
        src=$?
        [ "$src" -eq 0 ] && reload_nginx_if_deployed
        exit "$src"
      ) 9>"$LOCK_FILE"
      src=$?
      # A route is not proof of reachability (captive portal, DNS still coming
      # up, service down). Don't sit out a full backoff window on a failure.
      if [ "$src" -eq 0 ] || [ "$src" -eq 2 ]; then
        online_wait=$RETRY_BACKOFF_S
      else
        online_wait=$ONLINE_RETRY_S
      fi
    fi
    # An uplink makes the AP flip pointless — the cert is reachable already.
    idle=0
    continue
  fi
  if [ "$was_online" -eq 1 ]; then
    log "uplink lost; falling back to the idle AP-flip path"
    was_online=0
  fi

  # ---- path 2: no uplink — flip the AP once the Tesla has been gone a while ----
  sta="$(sta_count)"
  if [ -z "$sta" ]; then
    # Unknown, not zero. Never flip the AP on a number we could not read.
    if [ "$unknown_sta_logged" -eq 0 ]; then
      log "cannot read hostapd station count; holding the AP up (check ctrl_interface in hostapd.conf)"
      unknown_sta_logged=1
    fi
    idle=0
    continue
  fi
  unknown_sta_logged=0
  if [ "$sta" -gt 0 ]; then
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
    [ "$arc" -eq 0 ] && reload_nginx_if_deployed
    exit "$arc"
  ) 9>"$LOCK_FILE"
  idle=0
done
