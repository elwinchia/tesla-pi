#!/usr/bin/env bash
# uninstall-android-addon.sh — reverse scripts/install-android-addon.sh.
#
# Run as root. Idempotent: safe to re-run, no-ops cleanly on a host where
# the addon was never installed. CarPlay is unaffected throughout — nothing
# Android-related is in mytesla's startup path.

set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

SERVICE_USER="${MYTESLA_SERVICE_USER:-mytesla}"

echo "=== stopping the Android stack (if running) ==="
if [[ -x /usr/local/sbin/mytesla-android ]]; then
    /usr/local/sbin/mytesla-android stop || true
fi
systemctl stop    cage-headless.service waydroid-container.service 2>/dev/null || true
systemctl disable cage-headless.service waydroid-container.service 2>/dev/null || true

echo "=== removing unit, helper, sudoers, scrcpy-server ==="
rm -f /etc/systemd/system/cage-headless.service \
      /usr/local/sbin/mytesla-android \
      /etc/sudoers.d/mytesla-android \
      /usr/local/share/mytesla/scrcpy-server.jar
rmdir /usr/local/share/mytesla 2>/dev/null || true
systemctl daemon-reload

echo "=== purging waydroid + compositor packages ==="
# adb is general-purpose; left in place. zram-tools left in place — extra
# swap headroom doesn't hurt the CarPlay-only stack.
DEBIAN_FRONTEND=noninteractive apt-get purge -y waydroid cage wayvnc 2>/dev/null || true

echo "=== removing waydroid images + per-user data ==="
rm -rf /var/lib/waydroid \
       "/home/$SERVICE_USER/.local/share/waydroid" \
       "/home/$SERVICE_USER/.share/waydroid" \
       /etc/modules-load.d/waydroid.conf

echo "=== removing waydroid apt repo + key ==="
rm -f /etc/apt/sources.list.d/waydroid.list \
      /usr/share/keyrings/waydroid.gpg
apt-get update -qq || true

cat <<'EOF'

=== uninstall complete ===

Left in place on purpose:
  - psi=1 in the kernel cmdline (harmless; remove by hand if you care)
  - zram swap (general headroom)
  - adb (general-purpose tool)
  - linger for the service user (loginctl disable-linger <user> to revert)

Remember to:  sudo systemctl restart mytesla.service
EOF
