#!/bin/bash
# deploy-to-pi.sh — push this checkout to the device and restart the app.
#
# Two destinations, because the device has two copies and forgetting the second
# has cost a debugging session already:
#
#   /home/<user>/tesla-pi   the app itself — tesla-pi.service runs index.js here
#   /opt/tesla-pi/scripts   the root-owned helpers — the cert and netshare units
#                           run these by absolute path, so a script edited only
#                           in the checkout is an edit that never took effect
#
# Usage:
#   ./scripts/deploy-to-pi.sh              # find the device, sync, restart
#   ./scripts/deploy-to-pi.sh 10.0.0.42    # skip the search
#   PI=10.0.0.42 ./scripts/deploy-to-pi.sh  # same, via the environment
#   DRY=1 ./scripts/deploy-to-pi.sh        # show what would change, touch nothing

set -euo pipefail

USER_AT="${PI_USER:-tesla-pi}"
APP_DIR="${PI_APP_DIR:-/home/$USER_AT/tesla-pi}"
OPT_DIR=/opt/tesla-pi/scripts
# The address you gave, then the hostname from tesla-pi.txt on the home LAN,
# then the car AP. Set PI= (or PI_HOSTS=, space-separated) for a box that
# answers on something else.
read -r -a CANDIDATES <<<"${1:-} ${PI:-} ${PI_HOSTS:-tesla-pi.local 192.168.4.254}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

host=""
for h in "${CANDIDATES[@]}"; do
    [[ -n "$h" ]] || continue
    if ssh -o ConnectTimeout=4 -o BatchMode=yes "$USER_AT@$h" true 2>/dev/null; then
        host="$h"; break
    fi
done
if [[ -z "$host" ]]; then
    echo "No device answered on: ${CANDIDATES[*]}" >&2
    echo "It is probably asleep in the car. Wake it and run this again." >&2
    exit 1
fi
echo "=== device: $USER_AT@$host ==="

# ${dry[@]+...} rather than "${dry[@]}": under `set -u`, bash 3.2 — which is
# what macOS still ships — treats an empty array expansion as an unbound
# variable and aborts.
dry=()
[[ -n "${DRY:-}" ]] && dry=(--dry-run)

# --no-perms because the device's own ownership must win, which is also why the
# exec bits are restored explicitly below rather than carried across.
# No --delete of any kind. In particular NOT --delete-excluded, which would
# read the exclude list as "remove these from the device" and take node_modules
# and settings.local.json with it. A stale file left behind is harmless; a
# deleted dependency tree is the app not starting.
# -v rather than --info=NAME1: the rsync macOS ships is 2.6.9 and has neither.
rsync -a --no-perms -v ${dry[@]+"${dry[@]}"} \
    --exclude='.git' --exclude='node_modules' --exclude='logs/' \
    --exclude='*.local.json' \
    --exclude='out/' --exclude='*.img' --exclude='*.img.xz' \
    "$SRC/" "$USER_AT@$host:$APP_DIR/"

if [[ -n "${DRY:-}" ]]; then
    echo "=== dry run: nothing changed, nothing restarted ==="
    exit 0
fi

ssh "$USER_AT@$host" "bash -s" <<REMOTE
set -euo pipefail
chmod +x "$APP_DIR"/scripts/*.sh "$APP_DIR"/scripts/tesla-pi-* 2>/dev/null || true
# The root-owned copy the systemd units actually execute.
if [ -d "$OPT_DIR" ]; then
    sudo rsync -a --no-perms "$APP_DIR/scripts/" "$OPT_DIR/"
    sudo chmod +x "$OPT_DIR"/*.sh "$OPT_DIR"/tesla-pi-* 2>/dev/null || true
    echo "synced $OPT_DIR"
fi
sudo systemctl restart tesla-pi
sleep 2
systemctl is-active tesla-pi
REMOTE

echo "=== health ==="
curl -s -m 5 "http://$host:8080/healthz" | python3 -m json.tool 2>/dev/null || echo "(no answer yet — check: journalctl -u tesla-pi -n 50)"
