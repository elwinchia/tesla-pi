#!/bin/bash
# On-demand single-shot cert sync. Triggered by the SPA's "Renew now"
# button via systemd unit cert-renew-now.service (POST /cert/renew →
# sudo systemctl start --no-block). Available at any time: the sync is a
# version check against the cert service, and a device that is already
# current simply learns so (rc=2).
#
# Two paths, both from cert-renew-lib.sh, same as cert-renew-watch.sh:
#   * an uplink that is not our own AP is already up (eth0, a second Wi-Fi
#     adapter, a USB tether) → sync in place, nothing is interrupted;
#   * no uplink → tear the AP down, join the home Wi-Fi, sync, restore.
#     This costs the admin Wi-Fi for a few minutes and only works within
#     range of the network in wpa_supplicant-wlan0-home.conf.
#
# Serialized with the watcher via flock on /var/lock/tesla-pi-cert-flip
# so the two can't double-tear-down the AP if the user clicks Renew
# while the watcher is already mid-flip.

set -uo pipefail

LOG_TAG=cert-renew-now
. "$(dirname "$(readlink -f "$0")")/cert-renew-lib.sh"

# Non-blocking lock: if the watcher (or a previous manual click) is mid-flip,
# bail rather than queue up a second teardown. Held for the in-place path too —
# both paths write the same cert files and reload the same nginx.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another renewal in flight; refusing to start"
  exit 1
fi

uplink="$(uplink_iface)"
if [ -n "$uplink" ]; then
  log "manual renewal triggered; syncing over ${uplink} (AP stays up)"
  run_sync
  rc=$?
else
  log "manual renewal triggered; no uplink, flipping the AP to home Wi-Fi"
  attempt_renewal
  rc=$?
  restore_ap
fi
if [ "$rc" -eq 0 ]; then
  reload_nginx_if_deployed
  [ "$?" -eq 3 ] && log "cert installed; nginx reload held until the screen stops streaming (the watcher picks it up)"
fi
# "already current" (2) is a successful outcome for the user pressing Renew —
# don't leave cert-renew-now.service sitting in a failed state for it.
[ "$rc" -eq 2 ] && exit 0
exit "$rc"
