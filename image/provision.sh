#!/bin/bash
# provision.sh — turn a stock DietPi rootfs into a Tesla-Pi appliance.
#
# This is docs/setup-guide.md steps 2 through 12, executed rather than typed.
# It runs in two places and must behave identically in both:
#
#   * inside the build chroot (image/build-image.sh), where there is no running
#     systemd, no udev and no real hardware, and
#   * on a live Pi, as a one-shot installer or to re-provision after changes.
#
# Idempotent: re-running it is a supported way to pick up repo changes.
#
# Everything the owner must choose for themselves — Wi-Fi country, hotspot
# credentials, home Wi-Fi, SSH — is deliberately NOT decided here. That belongs
# to image/firstboot/tesla-pi-firstboot.sh, which runs once on the real device.
#
# Inputs (all optional, sensible defaults):
#   TESLAPI_SERVICE_USER   account that owns the checkout and runs the service
#   TESLAPI_APP_DIR        where the checkout lives on the device
#   TESLAPI_WITH_RETROARCH 1 to include the native RetroArch addon
#   TESLAPI_NODE_MAJOR     Node major version to install from NodeSource
#   CERT_SYNC_TOKEN        bearer token for the cert service (baked, mode 0600)
#   CERT_BUNDLE_DIR        dir holding fullchain.pem / privkey.pem / chain.pem

set -euo pipefail

SERVICE_USER="${TESLAPI_SERVICE_USER:-tesla-pi}"
APP_DIR="${TESLAPI_APP_DIR:-/opt/tesla-pi/app}"
SCRIPTS_DIR=/opt/tesla-pi/scripts
WITH_RETROARCH="${TESLAPI_WITH_RETROARCH:-1}"
NODE_MAJOR="${TESLAPI_NODE_MAJOR:-22}"
CERT_SYNC_TOKEN="${CERT_SYNC_TOKEN:-}"
CERT_BUNDLE_DIR="${CERT_BUNDLE_DIR:-}"

# Where this script's own repo lives while it runs. In the chroot the build
# script bind-mounts/copies the checkout to $APP_DIR, so these coincide.
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
note() { echo "  $*"; }
warn() { echo "  warning: $*" >&2; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

# systemd is not running inside the build chroot. `systemctl enable` still works
# there (it only manipulates symlinks); `start`/`restart` are no-ops we skip.
IN_CHROOT=0
if [[ ! -d /run/systemd/system ]]; then
    IN_CHROOT=1
fi

sctl_enable() { systemctl enable "$@" >/dev/null 2>&1 || warn "could not enable $*"; }
sctl_disable() { systemctl disable "$@" >/dev/null 2>&1 || true; }
sctl_start() {
    if (( IN_CHROOT )); then
        note "chroot: not starting $*"
    else
        systemctl restart "$@" || warn "could not start $*"
    fi
}

say "provisioning as user=$SERVICE_USER app=$APP_DIR retroarch=$WITH_RETROARCH chroot=$IN_CHROOT"

# ───────────────────────────────────────────────────────────────── packages ──
say "APT packages"
export DEBIAN_FRONTEND=noninteractive

# Stop maintainer scripts starting daemons while we are still assembling the
# system (and, in the chroot, where starting anything is meaningless).
cat >/usr/sbin/policy-rc.d <<'EOF'
#!/bin/sh
exit 101
EOF
chmod 0755 /usr/sbin/policy-rc.d

# iptables-persistent otherwise stops to ask whether to save current rules.
# We ship our own /etc/iptables/rules.v4, so the answer is no.
echo 'iptables-persistent iptables-persistent/autosave_v4 boolean false' | debconf-set-selections
echo 'iptables-persistent iptables-persistent/autosave_v6 boolean false' | debconf-set-selections

apt-get update -qq

# A stock DietPi image carries none of this: no NetworkManager (it uses
# ifupdown), no nginx/hostapd/dnsmasq, and no Node.
apt-get install -y --no-install-recommends \
    ca-certificates curl openssl git rsync \
    build-essential python3 pkg-config libusb-1.0-0-dev libudev-dev \
    network-manager hostapd dnsmasq nginx \
    iptables iptables-persistent wpasupplicant iw rfkill \
    openssh-server jq

# scripts/ap-mode.sh and scripts/tesla-pi-wifi are written entirely against
# nmcli, but stock DietPi manages interfaces with ifupdown. Without this the AP
# scripts fail on a freshly built image even though they work on a hand-built
# box where NetworkManager happened to be installed.
say "NetworkManager takes over from ifupdown"
sctl_enable NetworkManager.service
sctl_disable networking.service
# Leave only loopback to ifupdown so the two do not both claim eth0.
if [[ -f /etc/network/interfaces ]]; then
    cp -f /etc/network/interfaces /etc/network/interfaces.dietpi.bak
    cat >/etc/network/interfaces <<'EOF'
# Reduced by Tesla-Pi provisioning: NetworkManager owns eth0/wlan1, and
# wlan0 is held by hostapd. The original DietPi file is kept alongside as
# interfaces.dietpi.bak.
source /etc/network/interfaces.d/*

auto lo
iface lo inet loopback
EOF
fi
rm -f /etc/network/interfaces.d/* 2>/dev/null || true

# wlan0 is the Tesla-facing AP and must never be touched by NetworkManager.
# ap-mode.sh writes this at runtime; baking it means the AP survives a cold
# boot without anyone running ap-mode.sh first.
install -d -m 0755 /etc/NetworkManager/conf.d
cat >/etc/NetworkManager/conf.d/unmanaged-wlan0.conf <<'EOF'
[keyfile]
unmanaged-devices=interface-name:wlan0
EOF

say "Node.js ${NODE_MAJOR}.x"
# Debian bookworm ships Node 18; package.json requires >= 20.
if ! command -v node >/dev/null 2>&1 || \
   [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    rm -f /tmp/nodesource_setup.sh
    apt-get install -y nodejs
fi
note "node $(node --version), npm $(npm --version)"

# DietPi ships dropbear enabled with a documented default password. Behind an
# AP whose shipped password is 12345678, that turns "guessed the Wi-Fi" into
# "root on the box". OpenSSH replaces it and stays disabled until the owner
# opts in via tesla-pi.txt (see image/firstboot/tesla-pi-firstboot.sh).
say "SSH: drop dropbear, install OpenSSH disabled"
sctl_disable dropbear.service
apt-get purge -y dropbear dropbear-run 2>/dev/null || true
sctl_disable ssh.service
sctl_disable ssh.socket

# ────────────────────────────────────────────────────────────── service user ─
say "service user $SERVICE_USER"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash --user-group "$SERVICE_USER"
    note "created $SERVICE_USER"
fi
# plugdev is what the Carlinkit udev rule grants the dongle to.
usermod -aG plugdev "$SERVICE_USER"
passwd -l "$SERVICE_USER" >/dev/null 2>&1 || true

# ──────────────────────────────────────────────────────────────── the app ────
say "application -> $APP_DIR"
install -d -m 0755 "$(dirname "$APP_DIR")"
if [[ "$(readlink -f "$SRC_DIR")" != "$(readlink -f "$APP_DIR")" ]]; then
    install -d -m 0755 "$APP_DIR"
    # --delete keeps a re-provision from leaving files behind that the repo
    # has since removed. node_modules is rebuilt below, logs never ship.
    rsync -a --delete \
        --exclude '.git' --exclude 'node_modules' --exclude 'logs' \
        --exclude 'settings.local.json' --exclude 'retroarch-test' \
        "$SRC_DIR"/ "$APP_DIR"/
fi

say "npm dependencies (native USB build)"
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund )
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ap-radio-select.sh is deliberately absent here: install-ap-tab.sh (run below)
# owns it, because tesla-pi-ap is what invokes it and a hand-followed install
# has no other step that would place it. Two installers, one path, was a silent
# half-migration waiting to happen.
install -d -m 0755 "$SCRIPTS_DIR"
install -m 0755 "$APP_DIR/scripts/cert-sync.sh" \
                "$APP_DIR/scripts/cert-renew-watch.sh" \
                "$APP_DIR/scripts/cert-renew-now.sh" \
                "$APP_DIR/scripts/net-share.sh" \
                "$SCRIPTS_DIR/"
# Sourced by the cert-renew entry points and by net-share.sh, so it has to sit
# beside them.
install -m 0644 "$APP_DIR/scripts/cert-renew-lib.sh" "$SCRIPTS_DIR/"

# ───────────────────────────────────────────────────────────── udev: dongle ──
say "Carlinkit udev rule"
cat >/etc/udev/rules.d/52-nodecarplay.rules <<'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="1314", ATTR{idProduct}=="152*", MODE="0660", GROUP="plugdev"
EOF
if (( ! IN_CHROOT )); then
    udevadm control --reload-rules || true
    udevadm trigger || true
fi

# ─────────────────────────────────────────────────────────────── env file ────
say "/etc/default/tesla-pi"
# Seed only when absent. On a re-provision this file is the owner's — it holds
# their token and any overrides — so clobbering it from the template would undo
# their configuration every time they re-ran this script.
if [[ ! -f /etc/default/tesla-pi ]]; then
    install -m 0600 -o root -g root "$APP_DIR/conf/tesla-pi.env.template" /etc/default/tesla-pi
    note "seeded from template"
else
    chown root:root /etc/default/tesla-pi
    chmod 0600 /etc/default/tesla-pi
    note "already present — left alone (mode enforced 0600)"
fi
if [[ -n $CERT_SYNC_TOKEN ]]; then
    # Never echo the token; sed it in place.
    sed -i "s|^CERT_SYNC_TOKEN=.*|CERT_SYNC_TOKEN=${CERT_SYNC_TOKEN}|" /etc/default/tesla-pi
    note "CERT_SYNC_TOKEN baked in"
else
    warn "no CERT_SYNC_TOKEN supplied — certificate sync will not work on this image"
fi
# Consumed by scripts/ap-radio-select.sh; firstboot overwrites it from tesla-pi.txt.
grep -q '^AP_COUNTRY=' /etc/default/tesla-pi || printf '\n# Wi-Fi regulatory domain, set on first boot from tesla-pi.txt\nAP_COUNTRY=00\n' >>/etc/default/tesla-pi

CARPLAY_DOMAIN="$(sed -n 's/^CARPLAY_DOMAIN=//p' /etc/default/tesla-pi | head -1)"
CARPLAY_DOMAIN="${CARPLAY_DOMAIN:-device.tesla-pi.humblebees.co}"
note "domain: $CARPLAY_DOMAIN"

# ────────────────────────────────────────────────────────────── certificate ──
say "TLS certificate for $CARPLAY_DOMAIN"
CERT_LIVE="/etc/letsencrypt/live/$CARPLAY_DOMAIN"
install -d -m 0755 /etc/letsencrypt /etc/letsencrypt/live
install -d -m 0750 "$CERT_LIVE"

if [[ -n $CERT_BUNDLE_DIR && -s "$CERT_BUNDLE_DIR/fullchain.pem" && -s "$CERT_BUNDLE_DIR/privkey.pem" ]]; then
    install -m 0644 "$CERT_BUNDLE_DIR/fullchain.pem" "$CERT_LIVE/fullchain.pem"
    install -m 0600 "$CERT_BUNDLE_DIR/privkey.pem"   "$CERT_LIVE/privkey.pem"
    if [[ -s "$CERT_BUNDLE_DIR/chain.pem" ]]; then
        install -m 0644 "$CERT_BUNDLE_DIR/chain.pem" "$CERT_LIVE/chain.pem"
    else
        install -m 0644 "$CERT_BUNDLE_DIR/fullchain.pem" "$CERT_LIVE/chain.pem"
    fi
    [[ -s "$CERT_BUNDLE_DIR/version" ]] && install -m 0644 "$CERT_BUNDLE_DIR/version" "$CERT_LIVE/version"
    note "baked the real certificate bundle"
elif [[ -s "$CERT_LIVE/fullchain.pem" ]]; then
    note "certificate already present — left alone"
else
    # nginx refuses to start without a certificate, and an nginx that will not
    # start is an appliance that serves nothing at all. A self-signed stand-in
    # keeps the box bootable and debuggable; the Tesla browser will refuse it
    # until cert-sync.sh pulls the real one.
    warn "no certificate bundle supplied — generating a SELF-SIGNED placeholder"
    warn "the Tesla browser will NOT accept it; run cert-sync.sh on a networked Pi"
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout "$CERT_LIVE/privkey.pem" -out "$CERT_LIVE/fullchain.pem" \
        -subj "/CN=$CARPLAY_DOMAIN" \
        -addext "subjectAltName=DNS:$CARPLAY_DOMAIN" >/dev/null 2>&1
    cp "$CERT_LIVE/fullchain.pem" "$CERT_LIVE/chain.pem"
    chmod 0600 "$CERT_LIVE/privkey.pem"
    echo 0 >"$CERT_LIVE/version"
fi

# ───────────────────────────────────────────────────────────────── systemd ───
say "systemd units"
# Symlinked, not copied, so `git pull` in $APP_DIR updates the unit definitions
# — same contract as docs/setup-guide.md.
sed -e "s|__TESLAPI_USER__|$SERVICE_USER|g" -e "s|__TESLAPI_DIR__|$APP_DIR|g" \
    "$APP_DIR/systemd/tesla-pi.service" >/etc/systemd/system/tesla-pi.service
chmod 0644 /etc/systemd/system/tesla-pi.service

ln -sf "$APP_DIR/systemd/wlan0-ap-up.service"      /etc/systemd/system/wlan0-ap-up.service
ln -sf "$APP_DIR/systemd/cert-renew-watch.service" /etc/systemd/system/cert-renew-watch.service
ln -sf "$APP_DIR/systemd/cert-renew-now.service"   /etc/systemd/system/cert-renew-now.service
ln -sf "$APP_DIR/systemd/tesla-pi-netshare.service" /etc/systemd/system/tesla-pi-netshare.service

install -d -m 0755 /etc/systemd/system/hostapd.service.d
ln -sf "$APP_DIR/systemd/hostapd.service.d/wait-wlan0.conf" \
       /etc/systemd/system/hostapd.service.d/wait-wlan0.conf

# First-boot personalisation. Ordered ahead of the radio because it writes the
# hostapd config that hostapd is about to read.
install -m 0755 "$APP_DIR/image/firstboot/tesla-pi-firstboot.sh" \
                "$SCRIPTS_DIR/tesla-pi-firstboot.sh"
cat >/etc/systemd/system/tesla-pi-firstboot.service <<EOF
[Unit]
Description=Tesla-Pi first-boot setup (per-device identity and owner config)
DefaultDependencies=no
After=local-fs.target systemd-udev-settle.service
Before=network-pre.target wlan0-ap-up.service hostapd.service tesla-pi.service
ConditionPathExists=!/var/lib/tesla-pi/.firstboot-done

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=TESLAPI_SERVICE_USER=$SERVICE_USER
ExecStart=$SCRIPTS_DIR/tesla-pi-firstboot.sh
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF

# ────────────────────────────────────────────────────── AP-mode networking ───
say "hostapd / dnsmasq / iptables / sysctl"
# hostapd.conf is a real root-owned 0600 file, never a symlink into the repo:
# Settings > Hotspot rewrites it at runtime and it holds the passphrase.
#
# Seed only when absent. Re-installing the template on a live Pi would silently
# reset the owner's hotspot name and password back to the shipped defaults —
# i.e. reopen the box to anyone in range. install-ap-tab.sh below enforces
# ownership and mode either way.
install -d -m 0755 /etc/hostapd
if [[ ! -f /etc/hostapd/hostapd.conf ]]; then
    install -m 0600 -o root -g root "$APP_DIR/conf/hostapd.conf.template" /etc/hostapd/hostapd.conf
    note "seeded hostapd.conf from template"
else
    note "hostapd.conf already present — credentials left alone"
fi
sed -i 's|^#*DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd
systemctl unmask hostapd >/dev/null 2>&1 || true

ln -sf "$APP_DIR/conf/dnsmasq.conf" /etc/dnsmasq.conf
ln -sf "$APP_DIR/conf/sysctl-ip-forward.conf" /etc/sysctl.d/99-ip-forward.conf
# Older builds shipped the opposite setting under a different name. Both files
# would be read and the last one wins — "no" sorts after "ip" — so leaving it
# behind is a silent way to switch sharing back off.
rm -f /etc/sysctl.d/99-no-forward.conf
install -d -m 0755 /etc/iptables
install -m 0644 "$APP_DIR/conf/iptables.ipv4.nat" /etc/iptables/rules.v4

# nginx config is templated (CARPLAY_DOMAIN), so it is a copy rather than a
# symlink — sed -i on a symlink would replace the link and dirty the checkout.
install -m 0644 "$APP_DIR/conf/nginx-carplay.conf" /etc/nginx/sites-available/carplay
sed -i "s|CARPLAY_DOMAIN|$CARPLAY_DOMAIN|g" /etc/nginx/sites-available/carplay
ln -sf /etc/nginx/sites-available/carplay /etc/nginx/sites-enabled/carplay
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>/dev/null || warn "nginx -t failed — check /etc/nginx/sites-available/carplay"

# ───────────────────────────────────────────────────────── settings helpers ──
say "Settings tabs (Hotspot, WiFi, System)"
TESLAPI_SERVICE_USER="$SERVICE_USER" bash "$APP_DIR/scripts/install-ap-tab.sh"
TESLAPI_SERVICE_USER="$SERVICE_USER" bash "$APP_DIR/scripts/install-wifi-tab.sh"
TESLAPI_SERVICE_USER="$SERVICE_USER" bash "$APP_DIR/scripts/install-power-tab.sh"
# No RTC and no NTP in the car: the clock is set from the car's browser.
TESLAPI_SERVICE_USER="$SERVICE_USER" bash "$APP_DIR/scripts/install-clock-tab.sh"

# ──────────────────────────────────────────────────────────────── RetroArch ──
if [[ $WITH_RETROARCH == 1 ]]; then
    say "native RetroArch addon"
    # cage/wlroots needs a DRM node. DietPi's config.txt has no vc4-kms-v3d
    # overlay, so without this the compositor has no device to open.
    BOOTCFG=/boot/firmware/config.txt
    [[ -f $BOOTCFG ]] || BOOTCFG=/boot/config.txt
    if [[ -f $BOOTCFG ]] && ! grep -q '^dtoverlay=vc4-kms-v3d' "$BOOTCFG"; then
        printf '\n# Tesla-Pi: RetroArch runs under cage/wlroots, which needs a DRM device.\ndtoverlay=vc4-kms-v3d\nmax_framebuffers=2\n' >>"$BOOTCFG"
        note "enabled vc4-kms-v3d in $BOOTCFG"
    fi
    TESLAPI_SERVICE_USER="$SERVICE_USER" bash "$APP_DIR/scripts/install-retroarch-addon.sh"
else
    say "RetroArch addon skipped (TESLAPI_WITH_RETROARCH=$WITH_RETROARCH)"
fi

# ───────────────────────────────────────────────────────── enable services ───
say "enabling services"
sctl_enable tesla-pi-firstboot.service
sctl_enable wlan0-ap-up.service
sctl_enable hostapd.service
sctl_enable dnsmasq.service
sctl_enable nginx.service
sctl_enable cert-renew-watch.service
sctl_enable tesla-pi-netshare.service
sctl_enable tesla-pi.service
sctl_enable netfilter-persistent.service

# ────────────────────────────────────────────────────────── DietPi handoff ───
say "standing DietPi's first-run setup down"
# -1 is "image has never booted", which makes dietpi-firstboot run the full
# interactive installer. This image is already installed, so say so (2) and
# take that unit out of the boot path.
if [[ -d /boot/dietpi ]]; then
    echo 2 >/boot/dietpi/.install_stage
    note ".install_stage -> 2 (installed)"
fi
sctl_disable dietpi-firstboot.service
# DietPi's own resize is pulled in by firstboot; tesla-pi-firstboot.sh grows
# the filesystem itself so that removal costs nothing.
sctl_disable dietpi-fs_partition_resize.service

if [[ -f /boot/firmware/dietpi.txt ]]; then
    sed -i 's|^AUTO_SETUP_AUTOMATED=.*|AUTO_SETUP_AUTOMATED=1|' /boot/firmware/dietpi.txt
    sed -i 's|^SURVEY_OPTED_IN=.*|SURVEY_OPTED_IN=0|' /boot/firmware/dietpi.txt
fi

# ───────────────────────────────────────────────────────────────── cleanup ───
say "cleanup"
rm -f /usr/sbin/policy-rc.d
apt-get -y autoremove --purge
apt-get clean
rm -rf /var/lib/apt/lists/*

if (( ! IN_CHROOT )); then
    systemctl daemon-reload
fi

say "provisioning complete"
cat <<EOF

  application   $APP_DIR   (service user: $SERVICE_USER)
  helpers       $SCRIPTS_DIR
  domain        $CARPLAY_DOMAIN
  RetroArch     $([[ $WITH_RETROARCH == 1 ]] && echo included || echo skipped)

  Per-device setup (hotspot name, Wi-Fi country, home Wi-Fi, SSH) happens on
  the first real boot, from tesla-pi.txt on the boot partition.

EOF
