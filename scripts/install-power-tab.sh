#!/bin/bash
# install-power-tab.sh — installs the Settings → System plumbing.
#
# Places /usr/local/sbin/tesla-pi-power (the privileged restart/shutdown
# wrapper) and /etc/sudoers.d/tesla-pi-power (NOPASSWD for the service user).
# Idempotent.
#
# The helper takes a closed set of no-argument verbs (reboot, poweroff), so the
# sudo grant cannot be repurposed to run other commands.
#
# Without this the Settings → System section never appears: the Node app hides
# it when the helper is absent, so a device that never ran this installer just
# offers no power controls.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# The account the app runs as on THIS device, which is not always the
# image-built default. See scripts/service-user-lib.sh.
. "$SRC_DIR/service-user-lib.sh"
SERVICE_USER="$(resolve_service_user)"
HELPER_SRC="$SRC_DIR/tesla-pi-power"
HELPER_DST=/usr/local/sbin/tesla-pi-power
SUDOERS_DST=/etc/sudoers.d/tesla-pi-power

[[ -r "$HELPER_SRC" ]] || { echo "missing source: $HELPER_SRC"; exit 1; }
id "$SERVICE_USER" >/dev/null || { echo "service user $SERVICE_USER does not exist"; exit 1; }

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
cat > "$TMP" <<EOF
# Managed by scripts/install-power-tab.sh — grants the tesla-pi service user
# NOPASSWD on exactly the power helper. The helper's verbs are a closed list
# and take no arguments, so this entry can't be repurposed.
$SERVICE_USER ALL=(root) NOPASSWD: $HELPER_DST
EOF
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
cat <<EOF

The Settings → System section appears once tesla-pi.service has reloaded:

  sudo systemctl restart tesla-pi.service

Anyone on the hotspot can then restart or shut the device down — that is the
same trust boundary every other endpoint already sits behind (SECURITY.md), so
the hotspot password remains the thing protecting it.

To uninstall:
  sudo rm -f $HELPER_DST $SUDOERS_DST

EOF
