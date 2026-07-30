#!/bin/bash
# install-wifi-tab.sh — installs the Settings → WiFi tab plumbing.
#
# Places /usr/local/sbin/mytesla-wifi (the privileged nmcli wrapper) and
# /etc/sudoers.d/mytesla-wifi (NOPASSWD for the service user).
# Idempotent. Safe to re-run.
#
# The WiFi tab only needs wlan1 to exist. Run this once on any Pi where a
# second WiFi adapter is wired in. The tab auto-hides in the SPA when
# /sys/class/net/wlan1 is absent.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SERVICE_USER="${MYTESLA_SERVICE_USER:-mytesla}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_SRC="$SRC_DIR/mytesla-wifi"
HELPER_DST=/usr/local/sbin/mytesla-wifi
SUDOERS_DST=/etc/sudoers.d/mytesla-wifi

[[ -r "$HELPER_SRC" ]] || { echo "missing source: $HELPER_SRC"; exit 1; }

echo "=== installing $HELPER_DST ==="
# Only rewrite when content actually changed — keeps mtime stable so file
# integrity tools don't flag a no-op reinstall.
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
# Managed by scripts/install-wifi-tab.sh — grants the mytesla service user
# NOPASSWD on exactly the wlan1 helper. The helper itself validates verbs
# and hard-codes the interface, so this entry can't be repurposed to run
# other nmcli/system commands.
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

The Settings → WiFi tab will appear once mytesla.service has reloaded and
the SPA detects /sys/class/net/wlan1 on this host:

  sudo systemctl restart mytesla.service

If wlan1 is currently pinned unmanaged in NetworkManager, the helper
flips it back to managed at runtime when the user opens the tab — no
NetworkManager reload needed.

To uninstall:
  sudo rm -f $HELPER_DST $SUDOERS_DST

EOF
