#!/bin/bash
# enable-persistent-journal.sh — keep the systemd journal across reboots, 7 days.
#
# Why this exists: the app's own /logs ring is 200 entries in RAM and dies with
# the process — and the failure worth chasing (CarPlay not starting until the
# dongle is reseated) can restart the process itself, since start_giving_up
# exits and the unit is Restart=always. The journal is the only record that
# outlives that, and out of the box on DietPi it does not outlive a reboot.
#
# DietPi ships DietPi-RAMlog: /var/log is a tmpfs, cleared hourly. A journal
# written there is neither persistent nor safe from the hourly clear, so this
# script takes /var/log off the tmpfs (DietPi's own "none/custom" log mode,
# AUTO_SETUP_LOGGING_INDEX=0) and lets journald own the directory instead.
# Nothing else writes to /var/log on this image — no rsyslog, no logrotate —
# so the caps below are the whole story for SD-card wear.
#
# Idempotent. Run as root on the device:
#     sudo ./scripts/enable-persistent-journal.sh
#
# Undo:
#     sudo rm /etc/systemd/journald.conf.d/tesla-pi.conf
#     sudo systemctl restart systemd-journald
#   (and re-enable dietpi-ramlog.service + its fstab line if you want RAMlog back;
#    this script leaves the fstab line in place, commented, tagged tesla-pi.)

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

DROPIN_DIR=/etc/systemd/journald.conf.d
DROPIN="$DROPIN_DIR/tesla-pi.conf"
FSTAB=/etc/fstab
RETENTION_DAYS="${JOURNAL_RETENTION_DAYS:-7}"
# Belt and braces against a runaway log filling the card: whichever limit is
# hit first wins, so a quiet week keeps 7 days and a noisy one keeps less.
#
# 64M was the original value and it silently defeated the whole point: the cap,
# not MaxRetentionSec, is what actually evicted — the box was keeping well under
# a day, so a CarPlay fault from the previous drive was already gone. With
# dnsmasq's log-queries off (see conf/dnsmasq.conf) the real rate is ~25k
# lines/day, a few MB compressed, so 512M leaves 7 days a wide margin and still
# bounds a runaway. Raising the cap costs no extra SD writes — writes are
# whatever gets logged; the cap only decides how much is kept.
MAX_USE="${JOURNAL_MAX_USE:-512M}"

need_reboot=0

echo "=== current state ==="
findmnt -no SOURCE,FSTYPE,SIZE /var/log 2>/dev/null | sed 's/^/  \/var\/log: /' \
    || echo "  /var/log: not a mount point (already on disk)"
echo "  journald storage: $(journalctl --disk-usage 2>/dev/null || echo unknown)"

# ── 1. get /var/log off the RAM disk ──────────────────────────────────────────
# The tmpfs comes from an fstab line; dietpi-ramlog.service only does the
# hourly clear/save on top of it. Both have to go, in that order.
if [[ "$(findmnt -no FSTYPE /var/log 2>/dev/null || true)" == "tmpfs" ]]; then
    echo "=== /var/log is a RAM disk — moving it to the SD card ==="
    if grep -qE '^[^#].*[[:space:]]/var/log[[:space:]]' "$FSTAB"; then
        cp -a "$FSTAB" "$FSTAB.tesla-pi.bak"
        sed -i -E 's|^([^#].*[[:space:]]/var/log[[:space:]].*)$|# disabled by tesla-pi (persistent journal): \1|' "$FSTAB"
        echo "  commented the /var/log tmpfs line in $FSTAB (backup: $FSTAB.tesla-pi.bak)"
    else
        echo "  no /var/log line in $FSTAB — nothing to comment"
    fi
    if systemctl list-unit-files dietpi-ramlog.service >/dev/null 2>&1; then
        systemctl disable --now dietpi-ramlog.service >/dev/null 2>&1 || true
        echo "  disabled dietpi-ramlog.service"
    fi

    # RAMlog recreates /var/log's subdirectories on every boot; the copy on the
    # card underneath is whatever the image was built with. nginx is the one
    # that bites — Debian's default config logs to /var/log/nginx and the
    # daemon refuses to start if that directory is missing, which would take
    # the HTTPS front door down with it. A bind mount of / exposes the real
    # directory (bind mounts don't carry submounts), so the structure can be
    # replicated before the tmpfs goes away.
    under_root="$(mktemp -d)"
    if mount --bind / "$under_root" 2>/dev/null; then
        # Directories only — the log *contents* in RAM are this boot's and not
        # worth keeping. tar carries mode and ownership across; mkdir would not.
        ( cd /var/log && find . -type d -print0 \
            | tar --null --no-recursion -cf - -T - ) \
            | tar -xf - -C "$under_root/var/log" 2>/dev/null || true
        install -d -m 0755 -o root -g adm "$under_root/var/log/nginx" 2>/dev/null \
            || install -d -m 0755 "$under_root/var/log/nginx"
        echo "  replicated /var/log's directory tree onto the card"
        umount "$under_root"
    else
        echo "  WARNING: could not inspect the on-disk /var/log."
        echo "  After the reboot, if nginx is down: sudo mkdir -p /var/log/nginx && sudo systemctl restart nginx"
    fi
    rmdir "$under_root" 2>/dev/null || true

    # Whatever is in RAM right now is this boot's logs only; there is no value
    # in preserving it, but unmounting while journald holds files open is a
    # fight not worth having. Let the reboot do it.
    need_reboot=1
else
    echo "=== /var/log already on disk ==="
fi

# ── 2. journald: persistent, 7 days, capped ───────────────────────────────────
install -d -m 0755 "$DROPIN_DIR"
cat > "$DROPIN" <<EOF
# Written by scripts/enable-persistent-journal.sh — do not hand-edit.
# Keeps ${RETENTION_DAYS} days of logs on the SD card so a fault that only shows up
# after a reboot can still be read afterwards.
[Journal]
Storage=persistent
Compress=yes
MaxRetentionSec=${RETENTION_DAYS}day
# Roll a file a day, so retention can actually drop whole days: journald only
# ever deletes complete files, never lines inside the one it is writing.
MaxFileSec=1day
SystemMaxUse=${MAX_USE}
SystemMaxFileSize=8M
# Batch writes instead of hitting the card on every line. The cost is losing
# the last few minutes on a hard power cut; errors are still synced at once.
SyncIntervalSec=5m
RuntimeMaxUse=16M
EOF
echo "=== wrote $DROPIN ==="
sed 's/^/  /' "$DROPIN"

# Storage=persistent creates /var/log/journal itself, but only once /var/log is
# the real directory — which, on the RAMlog path above, is after the reboot.
if (( ! need_reboot )); then
    install -d -m 2755 -o root -g systemd-journal /var/log/journal
    systemctl restart systemd-journald
    # journald keeps writing to /run until something asks it to migrate; at boot
    # systemd-journal-flush does that, but a mid-session switch has to ask, or
    # /var/log/journal stays empty and this looks like it did not work.
    journalctl --flush || true
    journalctl --vacuum-time="${RETENTION_DAYS}d" >/dev/null 2>&1 || true
fi

echo
echo "=== result ==="
if (( need_reboot )); then
    echo "  /var/log is still the RAM disk for this boot."
    echo "  REBOOT to finish:  sudo reboot"
    echo "  After the reboot, check it took:"
else
    echo "  persistent journal is live. Check it took:"
fi
cat <<'EOF'
    findmnt -no FSTYPE /var/log        # expect: nothing (plain directory)
    journalctl --disk-usage            # expect: archived and active journals take ...
    ls /var/log/journal                # expect: a machine-id directory

  Then, after the NEXT reboot, the previous boot is readable:
    journalctl --list-boots
    journalctl -u tesla-pi -b -1 --no-pager | tail -200
    journalctl -k -b -1 --no-pager | grep -i usb
EOF
