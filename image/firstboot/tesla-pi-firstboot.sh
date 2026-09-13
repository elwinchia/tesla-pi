#!/bin/bash
# tesla-pi-firstboot.sh — one-shot per-device setup, run by
# tesla-pi-firstboot.service on the very first boot of a flashed image.
#
# A distributable image is by definition identical on every card. Three classes
# of thing therefore cannot be baked into it and have to happen here instead:
#
#   1. Per-device identity — SSH host keys and a hotspot name that does not
#      collide with the next Tesla-Pi in the same car park.
#   2. Per-owner choices  — Wi-Fi country, hotspot credentials, home Wi-Fi,
#      SSH. Read from tesla-pi.txt on the boot partition, which the owner edits
#      on any computer before first boot.
#   3. Per-card facts     — growing the root filesystem to fill the SD card.
#
# Ordered before wlan0-ap-up.service and hostapd.service, because it writes the
# hostapd config those consume.
#
# Idempotent and self-disabling: it stamps /var/lib/tesla-pi/.firstboot-done and
# the unit's ConditionPathExists keeps it from running again. Deleting that
# stamp and rebooting re-runs it, which is the supported way to re-apply an
# edited tesla-pi.txt.

set -uo pipefail

STATE_DIR=/var/lib/tesla-pi
STAMP="$STATE_DIR/.firstboot-done"
AP_HELPER=/usr/local/sbin/tesla-pi-ap
RADIO_SELECT=/opt/tesla-pi/scripts/ap-radio-select.sh
HOME_WPA=/etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf

log() { echo "[firstboot] $*"; }
warn() { echo "[firstboot] warning: $*" >&2; }

install -d -m 0755 "$STATE_DIR"

# ------------------------------------------------------------ boot config ---
# Raspberry Pi OS moved the FAT partition to /boot/firmware; DietPi and older
# images keep it at /boot. Accept either rather than guessing.
BOOTDIR=""
for d in /boot/firmware /boot; do
    if [[ -f $d/tesla-pi.txt ]]; then BOOTDIR="$d"; break; fi
done
if [[ -z $BOOTDIR ]]; then
    for d in /boot/firmware /boot; do
        if mountpoint -q "$d"; then BOOTDIR="$d"; break; fi
    done
fi
BOOTCFG="${BOOTDIR:+$BOOTDIR/tesla-pi.txt}"

# Read one key. Deliberately NOT `source` — this file lives on a FAT partition
# that anyone with the card can write, so sourcing it would be arbitrary code
# execution as root before the network is even up. Parse it as plain data.
# Tolerates CRLF, because it is normal for this file to be edited on Windows.
cfg() {
    local key="$1" val=""
    [[ -n $BOOTCFG && -r $BOOTCFG ]] || { printf ''; return 0; }
    val="$(sed -n "s/^[[:space:]]*${key}=//p" "$BOOTCFG" 2>/dev/null | head -1)"
    val="${val%$'\r'}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    printf '%s' "$val"
}

if [[ -n $BOOTCFG && -r $BOOTCFG ]]; then
    log "reading $BOOTCFG"
else
    log "no tesla-pi.txt found — using built-in defaults for everything"
fi

CFG_COUNTRY="$(cfg COUNTRY)"
CFG_SSID="$(cfg AP_SSID)"
CFG_PSK="$(cfg AP_PASSPHRASE)"
CFG_HOME_SSID="$(cfg HOME_WIFI_SSID)"
CFG_HOME_PSK="$(cfg HOME_WIFI_PSK)"
CFG_SSH_PW="$(cfg SSH_PASSWORD)"
CFG_HOSTNAME="$(cfg HOSTNAME)"

# ------------------------------------------------------------- identity -----
# A serial-derived suffix so two boxes in range of each other are telling apart.
# /proc/cpuinfo carries the Pi's 16-hex-digit serial; the device tree is the
# fallback for boards where it does not.
device_suffix() {
    local serial=""
    serial="$(sed -n 's/^Serial[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -1)"
    if [[ -z $serial && -r /proc/device-tree/serial-number ]]; then
        serial="$(tr -d '\0' </proc/device-tree/serial-number 2>/dev/null)"
    fi
    serial="$(tr -cd '0-9a-fA-F' <<<"$serial")"
    if [[ ${#serial} -ge 4 ]]; then
        tr '[:lower:]' '[:upper:]' <<<"${serial: -4}"
    else
        # No usable serial: random, still stable because we only do this once.
        od -An -tx1 -N2 /dev/urandom | tr -cd '0-9a-f' | tr '[:lower:]' '[:upper:]'
    fi
}

SUFFIX="$(device_suffix)"

# ------------------------------------------------------------- hostname -----
NEW_HOSTNAME="${CFG_HOSTNAME:-tesla-pi}"
if [[ $NEW_HOSTNAME =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]]; then
    if [[ "$(hostname)" != "$NEW_HOSTNAME" ]]; then
        log "hostname -> $NEW_HOSTNAME"
        hostnamectl set-hostname "$NEW_HOSTNAME" 2>/dev/null || echo "$NEW_HOSTNAME" >/etc/hostname
        # Keep /etc/hosts consistent so sudo does not stall on name lookup.
        if grep -qE '^127\.0\.1\.1' /etc/hosts; then
            sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
        else
            printf '127.0.1.1\t%s\n' "$NEW_HOSTNAME" >>/etc/hosts
        fi
    fi
else
    warn "HOSTNAME '$NEW_HOSTNAME' is not a valid hostname — ignoring"
fi

# -------------------------------------------------------------- ssh keys ----
# Every card is flashed from the same image, so without this every Tesla-Pi in
# the world would share one set of host keys.
if [[ -d /etc/ssh ]] && compgen -G '/etc/ssh/ssh_host_*' >/dev/null; then
    if [[ ! -f $STATE_DIR/.ssh-keys-regenerated ]]; then
        log "regenerating SSH host keys"
        rm -f /etc/ssh/ssh_host_*
        if ssh-keygen -A >/dev/null 2>&1; then
            touch "$STATE_DIR/.ssh-keys-regenerated"
        else
            warn "ssh-keygen -A failed"
        fi
    fi
fi

# ------------------------------------------------------------------ ssh -----
# Off unless the owner asked for it. The hotspot passphrase is this box's whole
# trust boundary (SECURITY.md); an SSH server behind a shipped default password
# would upgrade "guessed the Wi-Fi" into "owns the machine".
SSH_UNIT=ssh.service
systemctl list-unit-files ssh.service >/dev/null 2>&1 || SSH_UNIT=sshd.service

enable_ssh() {
    systemctl enable --now "$SSH_UNIT" >/dev/null 2>&1 \
        || warn "could not enable $SSH_UNIT"
}

SERVICE_USER="${TESLAPI_SERVICE_USER:-tesla-pi}"
AUTHKEYS_SRC="${BOOTDIR:-/boot}/authorized_keys"

if [[ -s $AUTHKEYS_SRC ]]; then
    log "authorized_keys found — enabling SSH with key auth only"
    home="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
    if [[ -n $home && -d $home ]]; then
        install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$home/.ssh"
        install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" \
            "$AUTHKEYS_SRC" "$home/.ssh/authorized_keys"
        install -d -m 0755 /etc/ssh/sshd_config.d
        cat >/etc/ssh/sshd_config.d/60-tesla-pi.conf <<'EOF'
# Written by tesla-pi-firstboot: a public key was supplied on the boot
# partition, so password login stays off.
PasswordAuthentication no
PermitRootLogin no
EOF
        enable_ssh
    else
        warn "service user $SERVICE_USER has no home directory — skipping SSH keys"
    fi
elif [[ -n $CFG_SSH_PW ]]; then
    if [[ ${#CFG_SSH_PW} -lt 8 ]]; then
        warn "SSH_PASSWORD is shorter than 8 characters — refusing to enable SSH"
    else
        log "SSH_PASSWORD set — enabling SSH with password auth for $SERVICE_USER"
        if chpasswd <<<"$SERVICE_USER:$CFG_SSH_PW" 2>/dev/null; then
            install -d -m 0755 /etc/ssh/sshd_config.d
            cat >/etc/ssh/sshd_config.d/60-tesla-pi.conf <<'EOF'
# Written by tesla-pi-firstboot: password login was requested via
# SSH_PASSWORD in tesla-pi.txt. Prefer dropping an authorized_keys file on
# the boot partition instead, which turns this back off.
PasswordAuthentication yes
PermitRootLogin no
EOF
            enable_ssh
        else
            warn "failed to set password for $SERVICE_USER"
        fi
    fi
else
    log "SSH left disabled (no authorized_keys, no SSH_PASSWORD)"
fi

# ----------------------------------------------------------- radio/country --
# Must run before hostapd starts: it rewrites channel/country in hostapd.conf.
# Persisting AP_COUNTRY is ap-radio-select.sh's job, not ours — it writes the
# country it actually resolved to, which is not always the one asked for.
if [[ -n $CFG_COUNTRY && ! $CFG_COUNTRY =~ ^([A-Za-z]{2}|00)$ ]]; then
    warn "COUNTRY '$CFG_COUNTRY' is not a 2-letter code — ignoring"
    CFG_COUNTRY=""
fi

if [[ -x $RADIO_SELECT ]]; then
    "$RADIO_SELECT" "${CFG_COUNTRY:-}" || warn "radio selection failed; hostapd keeps its shipped channel"
else
    warn "missing $RADIO_SELECT — hostapd keeps its shipped channel"
fi

# --------------------------------------------------------- hotspot creds ----
AP_SSID="${CFG_SSID:-Tesla-Pi-$SUFFIX}"
AP_PSK="${CFG_PSK:-12345678}"

if [[ -n $CFG_PSK && ${#CFG_PSK} -lt 8 ]]; then
    warn "AP_PASSPHRASE is shorter than hostapd's 8-character minimum — keeping the default"
    AP_PSK=12345678
fi

if [[ -x $AP_HELPER ]]; then
    if "$AP_HELPER" set "$AP_SSID" "$AP_PSK" >/dev/null; then
        log "hotspot SSID -> $AP_SSID"
        if [[ $AP_PSK == 12345678 ]]; then
            log "hotspot is using the shipped default password — change it in Settings > Hotspot"
        fi
    else
        warn "$AP_HELPER rejected the hotspot credentials — keeping shipped defaults"
    fi
else
    warn "missing $AP_HELPER — hotspot keeps its shipped SSID"
fi

# ------------------------------------------------------------- home wifi ----
# Consumed by cert-renew-watch.sh when it drops the AP to pull a fresh cert.
if [[ -n $CFG_HOME_SSID ]]; then
    log "home Wi-Fi -> $CFG_HOME_SSID (used only for certificate renewal)"
    install -d -m 0755 /etc/wpa_supplicant
    tmp="$(mktemp)"
    {
        echo "# Written by tesla-pi-firstboot from tesla-pi.txt."
        echo "# Used only by cert-renew-watch.sh, never in the car."
        echo "ctrl_interface=/run/wpa_supplicant"
        echo "country=${CFG_COUNTRY:-00}"
        echo
        if [[ -n $CFG_HOME_PSK ]]; then
            if [[ ${#CFG_HOME_PSK} -ge 8 && ${#CFG_HOME_PSK} -le 63 ]]; then
                # wpa_passphrase stores the derived PSK rather than the plaintext.
                wpa_passphrase "$CFG_HOME_SSID" "$CFG_HOME_PSK" | grep -v '^\s*#psk='
            else
                warn "HOME_WIFI_PSK must be 8-63 characters — writing an open-network entry instead"
                printf 'network={\n\tssid="%s"\n\tkey_mgmt=NONE\n}\n' "$CFG_HOME_SSID"
            fi
        else
            printf 'network={\n\tssid="%s"\n\tkey_mgmt=NONE\n}\n' "$CFG_HOME_SSID"
        fi
    } >"$tmp"
    install -m 0600 -o root -g root "$tmp" "$HOME_WPA"
    rm -f "$tmp"
fi

# ---------------------------------------------------------- expand rootfs ---
# Images are built at the smallest size that holds the install; the card is
# almost always bigger. Grow the last partition into whatever is left.
expand_rootfs() {
    local root_src pk disk part_num
    root_src="$(findmnt -no SOURCE / 2>/dev/null)"
    [[ $root_src == /dev/* ]] || { warn "cannot identify root device — skipping resize"; return; }

    pk="$(lsblk -no PKNAME "$root_src" 2>/dev/null | head -1)"
    [[ -n $pk ]] || { warn "cannot identify parent disk of $root_src — skipping resize"; return; }
    disk="/dev/$pk"
    part_num="$(lsblk -no PARTN "$root_src" 2>/dev/null | head -1)"
    [[ -n $part_num ]] || part_num="${root_src##*[!0-9]}"
    [[ -n $part_num ]] || { warn "cannot identify partition number — skipping resize"; return; }

    # Only bother if there is a meaningful amount of unallocated space left.
    local disk_sectors part_end free
    disk_sectors="$(blockdev --getsz "$disk" 2>/dev/null || echo 0)"
    part_end="$(( $(cat "/sys/class/block/$(basename "$root_src")/start" 2>/dev/null || echo 0) \
                 + $(blockdev --getsz "$root_src" 2>/dev/null || echo 0) ))"
    free=$(( disk_sectors - part_end ))
    if (( free < 65536 )); then          # < 32 MiB spare: already full enough
        log "root filesystem already fills the card"
        return
    fi

    log "growing partition $part_num on $disk into $(( free / 2048 )) MiB of free space"
    if echo ', +' | sfdisk --no-reread --force -N "$part_num" "$disk" >/dev/null 2>&1; then
        partprobe "$disk" >/dev/null 2>&1 || true
        udevadm settle >/dev/null 2>&1 || true
        resize2fs "$root_src" >/dev/null 2>&1 \
            && log "root filesystem expanded" \
            || warn "resize2fs failed — the box still works, it just has less space"
    else
        warn "sfdisk could not grow the partition — skipping"
    fi
}

expand_rootfs

# ------------------------------------------------------- scrub the config ---
# tesla-pi.txt sits on a FAT partition that anyone holding the card can read.
# The passwords in it have now been applied, so blank them out.
if [[ -n $BOOTCFG && -w $BOOTCFG ]]; then
    if [[ -n $CFG_PSK || -n $CFG_HOME_PSK || -n $CFG_SSH_PW ]]; then
        log "clearing applied passwords from $BOOTCFG"
        sed -i -e 's/^\([[:space:]]*AP_PASSPHRASE=\).*/\1/' \
               -e 's/^\([[:space:]]*HOME_WIFI_PSK=\).*/\1/' \
               -e 's/^\([[:space:]]*SSH_PASSWORD=\).*/\1/' "$BOOTCFG" \
            || warn "could not rewrite $BOOTCFG"
        if ! grep -q '^# Applied on first boot' "$BOOTCFG"; then
            cat >>"$BOOTCFG" <<'EOF'

# Applied on first boot. Passwords above were cleared once they took effect —
# this partition is readable by anyone holding the card. To re-apply an edited
# copy of this file, delete /var/lib/tesla-pi/.firstboot-done and reboot.
EOF
        fi
        sync
    fi
fi

# ------------------------------------------------------------------ done ----
date -u +'%Y-%m-%dT%H:%M:%SZ' >"$STAMP"
log "first-boot setup complete"
exit 0
