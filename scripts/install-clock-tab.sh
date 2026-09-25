#!/bin/bash
# install-clock-tab.sh — installs the Settings → System → Date & time plumbing.
#
# Places /usr/local/sbin/tesla-pi-clock (the privileged clock-set wrapper) and
# /etc/sudoers.d/tesla-pi-clock (NOPASSWD for the service user). Idempotent.
#
# The helper has one verb, `set`, whose single argument must be a 13-digit
# Unix time in milliseconds between 2024 and 2100, so the sudo grant cannot be
# repurposed to run other commands or park the clock somewhere absurd.
#
# Without this the Date & time group never appears: the Node app hides it when
# the helper is absent, and never tries to set the clock. A device that never
# ran this installer keeps whatever time it booted with until it next reaches
# NTP over home Wi-Fi. See docs/clock-sync.md.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# The account the app runs as on THIS device, which is not always the
# image-built default. See scripts/service-user-lib.sh.
. "$SRC_DIR/service-user-lib.sh"
SERVICE_USER="$(resolve_service_user)"
HELPER_SRC="$SRC_DIR/tesla-pi-clock"
HELPER_DST=/usr/local/sbin/tesla-pi-clock
SUDOERS_DST=/etc/sudoers.d/tesla-pi-clock

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
cat > "$TMP" <<SUDOERS
# Managed by scripts/install-clock-tab.sh — grants the tesla-pi service user
# NOPASSWD on exactly the clock helper. Its one verb takes one argument that
# the helper itself range-checks, so this entry can't be repurposed.
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

The Date & time group under Settings → System appears once tesla-pi.service
has reloaded:

  sudo systemctl restart tesla-pi.service

From then on the app sets the clock from the car's browser whenever the device
has not yet reached NTP since it started. Anyone on the hotspot can also set
it by hand, within 2024–2100 — the same trust boundary every other endpoint
already sits behind (SECURITY.md).

To uninstall:
  sudo rm -f $HELPER_DST $SUDOERS_DST

DONE
