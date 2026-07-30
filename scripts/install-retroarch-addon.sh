#!/bin/bash
# install-retroarch-addon.sh — installs the native RetroArch addon on the Pi.
#
# Streams a native (NOT Android/Waydroid) RetroArch session to the Tesla browser:
# RetroArch runs in its own headless `cage` compositor, is hardware-encoded to
# H.264, and is driven by a /dev/uinput virtual gamepad. Game audio is captured
# off an ALSA loopback. See docs/retroarch-addon.md.
#
# Everything is OFF by default after install: no unit is enabled, boot time is
# untouched (bar loading snd-aloop), and CarPlay never depends on anything here.
# The Node server starts the stack on demand via /usr/local/sbin/mytesla-retroarch.
#
# Idempotent. Safe to re-run. Requires internet on the Pi for the apt packages.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SERVICE_USER="${MYTESLA_SERVICE_USER:-mytesla}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SRC_DIR")"
USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
USER_UID="$(id -u "$SERVICE_USER")"

HELPER_SRC="$SRC_DIR/mytesla-retroarch"
HELPER_DST=/usr/local/sbin/mytesla-retroarch
SESSION_SRC="$SRC_DIR/mytesla-retroarch-session"
SESSION_DST=/usr/local/bin/mytesla-retroarch-session
SUDOERS_DST=/etc/sudoers.d/mytesla-retroarch
UNIT_SRC="$REPO_DIR/systemd/cage-retroarch.service"
UNIT_DST=/etc/systemd/system/cage-retroarch.service
UDEV_SRC="$REPO_DIR/conf/99-mytesla-uinput.rules"
UDEV_DST=/etc/udev/rules.d/99-mytesla-uinput.rules
MODULES_SRC="$REPO_DIR/conf/retroarch-modules.conf"
MODULES_DST=/etc/modules-load.d/mytesla-retroarch.conf
RA_CFG_SRC="$REPO_DIR/conf/retroarch/retroarch.cfg"
PAD_AUTOCONF_SRC="$REPO_DIR/conf/retroarch/autoconfig/mytesla-pad.cfg"

# install_if_changed <src> <dst> <mode> — install only when content differs.
install_if_changed() {
    local src="$1" dst="$2" mode="$3"
    if [[ ! -s "$dst" ]] || ! cmp -s "$src" "$dst"; then
        install -m "$mode" -o root -g root "$src" "$dst"
        echo "  wrote $dst"
    else
        echo "  $dst already up to date"
    fi
}

echo "=== preflight ==="
[[ "$(uname -m)" == "aarch64" ]] || { echo "need a 64-bit (aarch64) kernel"; exit 1; }
id "$SERVICE_USER" >/dev/null || { echo "service user $SERVICE_USER does not exist"; exit 1; }
[[ -n "$USER_HOME" && -d "$USER_HOME" ]] || { echo "no home dir for $SERVICE_USER"; exit 1; }
echo "  aarch64, user $SERVICE_USER ($USER_HOME) — ok"

echo "=== packages: retroarch, mGBA core, python3-evdev, ffmpeg ==="
# cage + wf-recorder come from the Android addon / base; install only what's new.
# Add more cores here (libretro-snes9x, libretro-genesisplusgx, …) to support
# more systems — the bridge's CORES allowlist gates which are launchable.
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    retroarch libretro-mgba python3-evdev ffmpeg alsa-utils cage wf-recorder

echo "=== groups for $SERVICE_USER (input for /dev/uinput, audio for the loopback) ==="
usermod -aG input,audio,render,video "$SERVICE_USER"

echo "=== linger for $SERVICE_USER ==="
loginctl enable-linger "$SERVICE_USER"

echo "=== /dev/uinput access (udev rule) ==="
install_if_changed "$UDEV_SRC" "$UDEV_DST" 0644
udevadm control --reload-rules
udevadm trigger /dev/uinput 2>/dev/null || true
# static_node only re-applies on module (re)load; fix the live node now too.
[[ -e /dev/uinput ]] && { chgrp input /dev/uinput || true; chmod 0660 /dev/uinput || true; }

echo "=== audio loopback (snd-aloop) ==="
install_if_changed "$MODULES_SRC" "$MODULES_DST" 0644
modprobe snd-aloop 2>/dev/null || true

echo "=== RetroArch config + pad autoconfig (as $SERVICE_USER) ==="
RA_CFG_DIR="$USER_HOME/.config/retroarch"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$RA_CFG_DIR" "$RA_CFG_DIR/autoconfig"
# Substitute __HOME__ → the real home and write the curated config + autoconfig.
sed "s|__HOME__|$USER_HOME|g" "$RA_CFG_SRC" > "$RA_CFG_DIR/retroarch.cfg"
chown "$SERVICE_USER:$SERVICE_USER" "$RA_CFG_DIR/retroarch.cfg"
chmod 0644 "$RA_CFG_DIR/retroarch.cfg"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0644 "$PAD_AUTOCONF_SRC" "$RA_CFG_DIR/autoconfig/mytesla-pad.cfg"
echo "  wrote $RA_CFG_DIR/retroarch.cfg + autoconfig/mytesla-pad.cfg"

echo "=== content directories ==="
for d in roms states saves system; do
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$USER_HOME/retroarch/$d"
done
echo "  $USER_HOME/retroarch/{roms,states,saves,system}"

echo "=== installing $SESSION_DST ==="
install_if_changed "$SESSION_SRC" "$SESSION_DST" 0755

echo "=== installing $UNIT_DST ==="
TMP_UNIT="$(mktemp)"
sed "s|^User=.*|User=$SERVICE_USER|; s|/run/user/1000|/run/user/$USER_UID|" \
    "$UNIT_SRC" > "$TMP_UNIT"
install_if_changed "$TMP_UNIT" "$UNIT_DST" 0644
rm -f "$TMP_UNIT"
systemctl daemon-reload

echo "=== installing $HELPER_DST ==="
install_if_changed "$HELPER_SRC" "$HELPER_DST" 0755

echo "=== installing $SUDOERS_DST ==="
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<EOF
# Managed by scripts/install-retroarch-addon.sh — grants the mytesla service
# user NOPASSWD on exactly the RetroArch lifecycle helper. The helper validates
# verbs, so this entry can't be repurposed for other commands.
$SERVICE_USER ALL=(root) NOPASSWD: $HELPER_DST
EOF
chmod 0440 "$TMP"
visudo -cf "$TMP" >/dev/null
install_if_changed "$TMP" "$SUDOERS_DST" 0440

echo
echo "=== done ==="
cat <<EOF

Native RetroArch addon installed (everything off until the RetroArch tile is
tapped). Drop GBA/GB/GBC ROMs in $USER_HOME/retroarch/roms.

Smoke test:
  sudo mytesla-retroarch start     # headless cage + RetroArch (menu)
  sudo mytesla-retroarch status
  sudo mytesla-retroarch stop

Then restart the Node server so the launcher shows the RetroArch tile:
  sudo systemctl restart mytesla.service

A Bluetooth controller paired to the Pi (bluetoothctl) is read by RetroArch's
udev joypad driver automatically — no extra config. See docs/retroarch-addon.md.
EOF
