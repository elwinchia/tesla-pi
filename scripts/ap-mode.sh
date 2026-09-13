#!/bin/bash
# Flip Pi to AP mode (hostapd SSID @ 192.168.4.254 on 5 GHz ch36).
# eth0 stays under NetworkManager — only wlan0 is touched.
# Reversible without reboot via dev-mode.sh.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

echo "=== marking wlan0 unmanaged in NetworkManager ==="
mkdir -p /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/unmanaged-wlan0.conf <<'EOF'
[keyfile]
unmanaged-devices=interface-name:wlan0
EOF
# Drop whatever NetworkManager currently holds on wlan0. The connection name
# is per-host (it is usually the SSID it last joined), so discover it rather
# than naming one.
nmcli -t -f NAME,DEVICE con show --active 2>/dev/null \
    | awk -F: '$2 == "wlan0" { print $1 }' \
    | while read -r con; do nmcli con down "$con" 2>/dev/null || true; done
systemctl reload NetworkManager
sleep 1

echo "=== bringing wlan0 up at 192.168.4.254/24 ==="
rfkill unblock wifi
ip link set wlan0 up
ip addr flush dev wlan0
ip addr add 192.168.4.254/24 dev wlan0

echo "=== applying iptables NAT rules ==="
iptables-restore < /etc/iptables/rules.v4

echo "=== starting hostapd + dnsmasq + cert-renew-watch ==="
systemctl unmask hostapd 2>/dev/null || true
systemctl enable wlan0-ap-up.service hostapd dnsmasq cert-renew-watch
systemctl start hostapd
sleep 2
systemctl restart dnsmasq
systemctl start cert-renew-watch

echo "=== state ==="
systemctl is-active hostapd dnsmasq cert-renew-watch
ip -4 addr show wlan0 | grep inet
echo
SSID="$(sed -n 's/^ssid=//p' /etc/hostapd/hostapd.conf 2>/dev/null | head -1)"
CHAN="$(sed -n 's/^channel=//p' /etc/hostapd/hostapd.conf 2>/dev/null | head -1)"
BAND="$(sed -n 's/^hw_mode=//p' /etc/hostapd/hostapd.conf 2>/dev/null | head -1)"
[[ $BAND == a ]] && BAND="5 GHz" || BAND="2.4 GHz"
echo "Pi is now AP ${SSID:-<hostapd ssid>} at 192.168.4.254 (${BAND} ch${CHAN:-?})."
echo "Mac: networksetup -setairportnetwork en0 ${SSID:-<ssid>} '<your-ap-passphrase>'"
echo "SSH via the AP: ssh <user>@192.168.4.254"
echo "SSH via eth0 (still up): ssh <user>@<eth0-ip>"
