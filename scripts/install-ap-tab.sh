#!/bin/bash
# install-ap-tab.sh — installs the Settings → Hotspot plumbing.
#
# Places /usr/local/sbin/tesla-pi-ap (the privileged hostapd wrapper) and
# /etc/sudoers.d/tesla-pi-ap (NOPASSWD for the service user). Idempotent.
#
# The helper validates its own verbs and hard-codes /etc/hostapd/hostapd.conf,
# so the sudo grant cannot be repurposed to run other commands.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# The account the app runs as on THIS device, which is not always the
# image-built default. See scripts/service-user-lib.sh.
. "$SRC_DIR/service-user-lib.sh"
SERVICE_USER="$(resolve_service_user)"
HELPER_SRC="$SRC_DIR/tesla-pi-ap"
HELPER_DST=/usr/local/sbin/tesla-pi-ap
SUDOERS_DST=/etc/sudoers.d/tesla-pi-ap
HOSTAPD_CONF=/etc/hostapd/hostapd.conf
TEMPLATE="$SRC_DIR/../conf/hostapd.conf.template"
# The `country` verb shells out to this. The image build already stages it here
# (image/provision.sh), but a hand-followed setup-guide install has no such
# step, so put it in place from here too — same absolute path either way,
# because the helper runs under sudo and cannot be told a different one.
RADIO_SRC="$SRC_DIR/ap-radio-select.sh"
RADIO_DST=/opt/tesla-pi/scripts/ap-radio-select.sh

[[ -r "$HELPER_SRC" ]] || { echo "missing source: $HELPER_SRC"; exit 1; }
[[ -r "$RADIO_SRC" ]] || { echo "missing source: $RADIO_SRC"; exit 1; }
id "$SERVICE_USER" >/dev/null || { echo "service user $SERVICE_USER does not exist"; exit 1; }

echo "=== installing $HELPER_DST ==="
if [[ ! -s "$HELPER_DST" ]] || ! cmp -s "$HELPER_SRC" "$HELPER_DST"; then
    install -m 0755 -o root -g root "$HELPER_SRC" "$HELPER_DST"
    echo "  wrote $HELPER_DST"
else
    echo "  $HELPER_DST already up to date"
fi

echo "=== installing $RADIO_DST ==="
install -d -m 0755 "$(dirname "$RADIO_DST")"
if [[ ! -s "$RADIO_DST" ]] || ! cmp -s "$RADIO_SRC" "$RADIO_DST"; then
    install -m 0755 -o root -g root "$RADIO_SRC" "$RADIO_DST"
    echo "  wrote $RADIO_DST"
else
    echo "  $RADIO_DST already up to date"
fi

echo "=== installing $SUDOERS_DST ==="
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<EOF
# Managed by scripts/install-ap-tab.sh — grants the tesla-pi service user
# NOPASSWD on exactly the hotspot helper. The helper validates verbs and
# hard-codes the hostapd config path, so this entry can't be repurposed.
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

# This file becomes runtime-owned: the helper rewrites it whenever the user
# changes the hotspot credentials. Two things follow.
#
# 1. It must not be a symlink into the git checkout (older setup guides did
#    that "so updates flow through git"). Writing through the link would either
#    replace it — silently detaching the repo copy — or land the live
#    passphrase in the working tree, which SECURITY.md forbids.
# 2. It holds the passphrase, i.e. this appliance's whole trust boundary, so it
#    must not be world-readable. Older installs shipped it 0644.
echo "=== $HOSTAPD_CONF ==="
if [[ -L "$HOSTAPD_CONF" ]]; then
    echo "  replacing symlink -> $(readlink "$HOSTAPD_CONF") with a real file"
    cp --remove-destination "$(readlink -f "$HOSTAPD_CONF")" "$HOSTAPD_CONF"
elif [[ ! -f "$HOSTAPD_CONF" ]]; then
    echo "  seeding from $TEMPLATE"
    [[ -r "$TEMPLATE" ]] || { echo "missing template: $TEMPLATE"; exit 1; }
    install -m 0600 -o root -g root "$TEMPLATE" "$HOSTAPD_CONF"
fi
before="$(stat -c '%a' "$HOSTAPD_CONF")"
chown root:root "$HOSTAPD_CONF"
chmod 600 "$HOSTAPD_CONF"
echo "  mode $before -> 600, root-owned, runtime-writable"

# 3. It needs a control socket. Configs written before this change have no
#    ctrl_interface, so hostapd_cli cannot attach: the SPA showed "0 devices"
#    with the Tesla plainly connected, and cert-renew-watch.sh read that same 0
#    as "the car has left" and tore the AP down. Append it if absent — but do
#    NOT restart hostapd here, because whoever is running this install may well
#    be on the AP it would drop.
HOSTAPD_RESTART_NEEDED=0
if ! grep -q '^ctrl_interface=' "$HOSTAPD_CONF"; then
    printf '%s\n' 'ctrl_interface=/var/run/hostapd' 'ctrl_interface_group=0' >> "$HOSTAPD_CONF"
    echo "  added ctrl_interface — station counts stay broken until hostapd restarts"
    HOSTAPD_RESTART_NEEDED=1
fi

echo
echo "=== done ==="
if [[ "$HOSTAPD_RESTART_NEEDED" -eq 1 ]]; then
    cat <<'EOF'

NOTE: hostapd.conf gained a ctrl_interface line. Until hostapd restarts, the
connected-device count stays wrong (and the cert watcher keeps the AP up rather
than trusting it). Restart when nobody is relying on the hotspot — it drops
every client, the car included:

  sudo systemctl restart hostapd.service

EOF
fi
cat <<EOF

The Settings → Hotspot card appears once tesla-pi.service has reloaded:

  sudo systemctl restart tesla-pi.service

While the shipped default SSID/password are still in place, the SPA shows a
persistent banner prompting the user to change them.

To uninstall:
  sudo rm -f $HELPER_DST $SUDOERS_DST

EOF
