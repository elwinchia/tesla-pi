#!/bin/bash
# install-phone-near.sh — installs the Settings → CarPlay → "Start when my
# iPhone is in the car" plumbing.
#
# Places /usr/local/sbin/tesla-pi-phone (the privileged Bluetooth probe) and
# /etc/sudoers.d/tesla-pi-phone (NOPASSWD for the service user). Idempotent.
#
# The helper has one verb, `probe`, whose single argument must be a Bluetooth
# address, so the sudo grant cannot be repurposed to run other commands.
#
# Without this the switch never appears: the Node app hides it when the helper
# is absent, and never touches Bluetooth for it.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# The account the app runs as on THIS device, which is not always the
# image-built default. See scripts/service-user-lib.sh.
. "$SRC_DIR/service-user-lib.sh"
SERVICE_USER="$(resolve_service_user)"
HELPER_SRC="$SRC_DIR/tesla-pi-phone"
HELPER_DST=/usr/local/sbin/tesla-pi-phone
SUDOERS_DST=/etc/sudoers.d/tesla-pi-phone

[[ -r "$HELPER_SRC" ]] || { echo "missing source: $HELPER_SRC"; exit 1; }
id "$SERVICE_USER" >/dev/null || { echo "service user $SERVICE_USER does not exist"; exit 1; }
for bin in /usr/bin/hcitool /usr/bin/l2ping /usr/bin/hciconfig; do
    [[ -x "$bin" ]] || echo "  warning: $bin missing (apt install bluez) — probes will fail"
done

echo "=== installing $HELPER_DST ==="
if [[ ! -s "$HELPER_DST" ]] || ! cmp -s "$HELPER_SRC" "$HELPER_DST"; then
    install -m 0755 -o root -g root "$HELPER_SRC" "$HELPER_DST"
    echo "  wrote $HELPER_DST"
else
    echo "  $HELPER_DST already up to date"
fi

echo "=== installing $SUDOERS_DST ==="
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<SUDOERS
# Managed by scripts/install-phone-near.sh — grants the tesla-pi service user
# NOPASSWD on exactly the phone probe. Its one verb takes one argument that the
# helper itself validates as a Bluetooth address, so this entry can't be
# repurposed.
$SERVICE_USER ALL=(root) NOPASSWD: $HELPER_DST
SUDOERS
chmod 0440 "$TMP"
visudo -cf "$TMP" >/dev/null

if [[ ! -s "$SUDOERS_DST" ]] || ! cmp -s "$TMP" "$SUDOERS_DST"; then
    install -m 0440 -o root -g root "$TMP" "$SUDOERS_DST"
    echo "  wrote $SUDOERS_DST"
else
    echo "  $SUDOERS_DST already up to date"
fi

echo
echo "=== done ==="
cat <<DONE

The switch appears under Settings → CarPlay once tesla-pi.service has reloaded:

  sudo systemctl restart tesla-pi.service

It stays off until turned on, and needs CarPlay to have connected once so the
app has learned the phone's Bluetooth address from the adapter.

To uninstall:
  sudo rm -f $HELPER_DST $SUDOERS_DST

DONE
