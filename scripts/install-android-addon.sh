#!/bin/bash
# install-android-addon.sh — installs the Waydroid Android addon on the Pi.
#
# Everything is OFF by default after install: no unit is enabled, boot time
# is untouched, and CarPlay never depends on anything installed here. The
# stack is started on demand via /usr/local/sbin/mytesla-android (which the
# Node server calls from the launcher's Android tile).
#
# Idempotent. Safe to re-run. Requires internet on the Pi (dev-mode.sh or
# wlan1 client mode) for apt + the ~1 GB Waydroid GAPPS image download.
#
# See docs/android-addon.md for the full recipe, RAM/thermal budget and
# rollback.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SERVICE_USER="${MYTESLA_SERVICE_USER:-mytesla}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SRC_DIR")"

HELPER_SRC="$SRC_DIR/mytesla-android"
HELPER_DST=/usr/local/sbin/mytesla-android
SUDOERS_DST=/etc/sudoers.d/mytesla-android
UNIT_SRC="$REPO_DIR/systemd/cage-headless.service"
UNIT_DST=/etc/systemd/system/cage-headless.service
# Boot pre-warm: brings the Android runtime up in the background (after CarPlay)
# so tapping "Android" streams in ~1-2s instead of cold-booting Waydroid.
WARM_UNIT_SRC="$REPO_DIR/systemd/mytesla-android-warm.service"
WARM_UNIT_DST=/etc/systemd/system/mytesla-android-warm.service

# scrcpy-server runs inside the Waydroid container and produces the H.264
# stream the Node bridge muxes to the Tesla browser. Pinned + checksummed —
# the protocol the bridge speaks (android-bridge.js) is version-specific.
SCRCPY_VERSION=4.0
SCRCPY_SERVER_SHA256=84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a
SCRCPY_SERVER_URL="https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}"
SCRCPY_SERVER_DST=/usr/local/share/mytesla/scrcpy-server.jar

# Android render resolution. Ultrawide 1408x480 (2.93:1, ~0.68 MP) to fit the
# wide band of the 1180x919 Tesla viewport without stretch. Modest pixel count
# keeps the Pi 4 rendering, GPU-compositing (cage gles2) and HW-encoding H.264
# concurrently without starving a core, and keeps app UI legible at 480px tall.
ANDROID_W=1408
ANDROID_H=480
ANDROID_DENSITY=200

REBOOT_NEEDED=0

# install_if_changed <src> <dst> <mode> — install only when content differs
# (keeps mtime stable so integrity tools don't flag no-op reinstalls). A real
# install failure aborts via set -e; "unchanged" is a normal no-op.
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
[[ "$(uname -m)" == "aarch64" ]] || { echo "need a 64-bit (aarch64) kernel; reflash with the 64-bit DietPi image"; exit 1; }
mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
if (( mem_kb < 3500000 )); then
    echo "need >= 4 GB RAM (found $((mem_kb / 1024)) MB) — Waydroid is not viable below that"
    exit 1
fi
id "$SERVICE_USER" >/dev/null || { echo "service user $SERVICE_USER does not exist"; exit 1; }
echo "  aarch64, $((mem_kb / 1024)) MB RAM, user $SERVICE_USER — ok"

echo "=== kernel cmdline (psi + memory cgroup) ==="
# Two boot params the Waydroid LXC container needs, both only settable at boot:
#   psi=1                — pressure-stall info for Android's low-memory killer
#   cgroup_enable=memory — the memory cgroup controller. Raspberry Pi kernels
#     ship with the memory controller OFF (the firmware injects
#     cgroup_disable=memory into /chosen/bootargs ahead of cmdline.txt), so the
#     container's "OSError: container failed to start". cmdline.txt is appended
#     last, so cgroup_enable=memory is parsed after the firmware's disable and
#     wins. cgroup_memory=1 is the cgroup-v1 spelling; harmless under v2.
CMDLINE=""
for c in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    [[ -f "$c" ]] && { CMDLINE="$c"; break; }
done
[[ -n "$CMDLINE" ]] || { echo "cannot find cmdline.txt"; exit 1; }
for flag in 'psi=1' 'cgroup_enable=memory' 'cgroup_memory=1'; do
    if grep -qw -- "$flag" "$CMDLINE"; then
        echo "  $flag already in $CMDLINE"
    else
        sed -i "1 s|\$| $flag|" "$CMDLINE"
        echo "  appended $flag to $CMDLINE"
        REBOOT_NEEDED=1
    fi
done

echo "=== kernel: binder ==="
# Newer RPi kernels build binder in (binderfs); older ones ship it as a
# module. Either way /dev/binderfs must be mountable.
if [[ -d /dev/binderfs ]] || grep -qw binder /proc/filesystems; then
    echo "  binder built-in — ok"
elif modprobe binder_linux 2>/dev/null; then
    echo "binder_linux" > /etc/modules-load.d/waydroid.conf
    echo "  binder_linux module loaded + persisted (/etc/modules-load.d/waydroid.conf)"
else
    echo "  WARNING: no binder support in this kernel. Run 'sudo apt full-upgrade'"
    echo "  to get a current RPi kernel, reboot, then re-run this script."
    exit 1
fi

echo "=== zram swap ==="
# Android 13 + GAPPS is heavy; 2 GB of zram keeps the 4 GB Pi out of
# OOM territory while CarPlay streams alongside.
if ! dpkg -s zram-tools >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y zram-tools
fi
if ! grep -q '^SIZE=2048' /etc/default/zramswap 2>/dev/null; then
    cat > /etc/default/zramswap <<'EOF'
# Managed by scripts/install-android-addon.sh
ALGO=zstd
SIZE=2048
PRIORITY=100
EOF
    systemctl restart zramswap.service 2>/dev/null || true
    echo "  zram 2048 MB (zstd) configured"
else
    echo "  zram already configured"
fi

echo "=== packages: waydroid, cage, adb, wayvnc ==="
if ! command -v waydroid >/dev/null; then
    # Official Waydroid repo setup script: it auto-detects the distro codename
    # from /etc/os-release (trixie is supported) and adds the apt source + key.
    # A positional arg is treated as a codename override, NOT a command — so
    # passing "install" makes it reject an unknown distro. It only sets up the
    # repo; the waydroid package itself is installed by the apt-get line below.
    curl -fsSL https://repo.waydro.id | bash
else
    echo "  waydroid already installed"
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y waydroid cage adb wayvnc
# Nothing Android-related may start at boot.
systemctl disable waydroid-container.service 2>/dev/null || true

echo "=== scrcpy-server v${SCRCPY_VERSION} ==="
install -d -m 0755 /usr/local/share/mytesla
if [[ -f "$SCRCPY_SERVER_DST" ]] && \
   echo "$SCRCPY_SERVER_SHA256  $SCRCPY_SERVER_DST" | sha256sum -c --quiet 2>/dev/null; then
    echo "  $SCRCPY_SERVER_DST already present + verified"
else
    curl -fsSL -o "$SCRCPY_SERVER_DST.tmp" "$SCRCPY_SERVER_URL"
    echo "$SCRCPY_SERVER_SHA256  $SCRCPY_SERVER_DST.tmp" | sha256sum -c --quiet
    mv "$SCRCPY_SERVER_DST.tmp" "$SCRCPY_SERVER_DST"
    chmod 0644 "$SCRCPY_SERVER_DST"
    echo "  downloaded + verified $SCRCPY_SERVER_DST"
fi

echo "=== linger for $SERVICE_USER ==="
# cage-headless.service runs as $SERVICE_USER with no login session;
# lingering keeps /run/user/<uid> alive for the Wayland socket.
loginctl enable-linger "$SERVICE_USER"

echo "=== GPU access for $SERVICE_USER ==="
# cage composites on the V3D GPU (WLR_RENDERER=gles2 in cage-headless.service),
# so the service user needs the DRM render node + legacy KMS device. Without
# these groups cage falls back / fails to start on the headless GPU path.
usermod -aG render,video "$SERVICE_USER"

echo "=== waydroid init (GAPPS image) ==="
if [[ -f /var/lib/waydroid/waydroid.cfg ]]; then
    echo "  already initialized — skipping (re-init with: sudo waydroid init -f -s GAPPS)"
else
    echo "  downloading the Android 13 GAPPS image (~1 GB) — needs internet"
    waydroid init -s GAPPS
fi

echo "=== waydroid props (resolution + window mode) ==="
PROP_FILE=/var/lib/waydroid/waydroid_base.prop
if [[ -f "$PROP_FILE" ]]; then
    for kv in "persist.waydroid.width=$ANDROID_W" \
              "persist.waydroid.height=$ANDROID_H" \
              "ro.sf.lcd_density=$ANDROID_DENSITY" \
              "persist.waydroid.multi_windows=false"; do
        key="${kv%%=*}"
        if grep -q "^$key=" "$PROP_FILE"; then
            sed -i "s|^$key=.*|$kv|" "$PROP_FILE"
        else
            echo "$kv" >> "$PROP_FILE"
        fi
    done
    echo "  pinned ${ANDROID_W}x${ANDROID_H} @ ${ANDROID_DENSITY}dpi, single-window"
else
    echo "  WARNING: $PROP_FILE missing — waydroid init may have failed"
fi

echo "=== installing $UNIT_DST ==="
TMP_UNIT="$(mktemp)"
sed "s|^User=.*|User=$SERVICE_USER|; s|/run/user/1000|/run/user/$(id -u "$SERVICE_USER")|" \
    "$UNIT_SRC" > "$TMP_UNIT"
install_if_changed "$TMP_UNIT" "$UNIT_DST" 0644
rm -f "$TMP_UNIT"

echo "=== installing $WARM_UNIT_DST (boot pre-warm — OPT-IN, disabled) ==="
install_if_changed "$WARM_UNIT_SRC" "$WARM_UNIT_DST" 0644
systemctl daemon-reload
# Android must NOT start at boot — it only comes up when the user taps the
# (settings-gated) Android tile, which calls /android/start. So the warm pre-load
# is installed but DISABLED. Opt in for ~1-2s taps with:
#   systemctl enable mytesla-android-warm.service
systemctl disable mytesla-android-warm.service >/dev/null 2>&1 || true

echo "=== installing $HELPER_DST ==="
install_if_changed "$HELPER_SRC" "$HELPER_DST" 0755

echo "=== installing $SUDOERS_DST ==="
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<EOF
# Managed by scripts/install-android-addon.sh — grants the mytesla service
# user NOPASSWD on exactly the Android lifecycle helper. The helper itself
# validates verbs, so this entry can't be repurposed for other commands.
$SERVICE_USER ALL=(root) NOPASSWD: $HELPER_DST
EOF
chmod 0440 "$TMP"
visudo -cf "$TMP" >/dev/null
install_if_changed "$TMP" "$SUDOERS_DST" 0440

echo
echo "=== done ==="
cat <<EOF

Android does NOT start at boot. It comes up only when the user enables it in
Settings and taps the Android tile (cold boot ~30-45s). Smoke test:

  sudo mytesla-android start     # container + headless cage, waits for RUNNING
  sudo mytesla-android status
  sudo mytesla-android stop       # frees the ~1.5-2 GB the container holds

  systemctl enable mytesla-android-warm.service  # OPT IN to boot pre-warm (~1-2s taps)
  systemctl disable mytesla-android-warm.service # default (no pre-warm)

Then restart the Node server so the launcher shows the Android tile:

  sudo systemctl restart mytesla.service

One-time provisioning (Play certification, Widevine, apps) is in
docs/android-addon.md.

To uninstall:  sudo scripts/uninstall-android-addon.sh
EOF

if (( REBOOT_NEEDED )); then
    echo
    echo ">>> REBOOT REQUIRED (psi=1 added to kernel cmdline) before first start. <<<"
fi
