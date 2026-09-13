#!/bin/bash
# install-dongle-tab.sh — installs the USB-stick half of Settings → Dongle.
#
# Places /usr/local/sbin/tesla-pi-dongle (the privileged mount/copy wrapper),
# /etc/sudoers.d/tesla-pi-dongle (NOPASSWD for the service user), and the
# firmware store the app downloads into. Idempotent.
#
# The Dongle section itself does NOT depend on this: without the helper the page
# still identifies the dongle, lists the firmware catalogue and downloads images
# — it just cannot write one to a stick, and says so in place of the button.
# Run this only if you want that last step done from the car.
#
# The helper takes two verbs with a closed argument grammar (see its header), so
# the sudo grant cannot be repurposed into an arbitrary write.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# The account the app runs as on THIS device, which is not always the
# image-built default. See scripts/service-user-lib.sh.
. "$SRC_DIR/service-user-lib.sh"
SERVICE_USER="$(resolve_service_user)"
HELPER_SRC="$SRC_DIR/tesla-pi-dongle"
HELPER_DST=/usr/local/sbin/tesla-pi-dongle
SUDOERS_DST=/etc/sudoers.d/tesla-pi-dongle
# Must match FIRMWARE_DIR in the Node app AND SRC_DIR in the helper. All three
# are hardcoded to the same path on purpose: it is the only directory the sudo
# grant will read from, so it must not be a moving target.
FIRMWARE_DIR=/var/lib/tesla-pi/firmware

[[ -r "$HELPER_SRC" ]] || { echo "missing source: $HELPER_SRC"; exit 1; }
id "$SERVICE_USER" >/dev/null || { echo "service user $SERVICE_USER does not exist"; exit 1; }
command -v lsblk   >/dev/null || { echo "lsblk not found (install util-linux)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found"; exit 1; }

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
# Managed by scripts/install-dongle-tab.sh — grants the tesla-pi service user
# NOPASSWD on exactly the dongle helper. The helper accepts two verbs; its
# source directory is hardcoded, its device argument must be a removable FAT
# partition that is not the boot disk, and its filenames are bare names, so this
# entry cannot be turned into an arbitrary write.
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

echo "=== firmware store $FIRMWARE_DIR ==="
# Owned by the service user because the app writes downloads here; the helper
# only ever reads from it.
install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$FIRMWARE_DIR"
echo "  ready"

echo
echo "=== done ==="
cat <<EOF

Restart the app so the section picks the helper up:

  sudo systemctl restart tesla-pi.service

Then: Settings → Dongle. Plug a FAT32 stick into the Pi, download the build you
want, write it to the stick, move the stick to the dongle.

Anyone on the hotspot can then download firmware onto this device and write it
to an attached stick — the same trust boundary every other endpoint already sits
behind (SECURITY.md). Nothing here can flash the dongle; that stays a physical
step, on purpose.

To uninstall:
  sudo rm -f $HELPER_DST $SUDOERS_DST
  sudo rm -rf $FIRMWARE_DIR

EOF
