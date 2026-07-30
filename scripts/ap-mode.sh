#!/bin/bash
# Flip Pi to AP mode (TeslaCP @ 192.168.4.254 on 5 GHz ch36).
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
nmcli con down netplan-wlan0-Ariel 2>/dev/null || true
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
echo "Pi is now AP TeslaCP at 192.168.4.254 (5 GHz ch36)."
echo "Mac: networksetup -setairportnetwork en0 TeslaCP '<your-ap-passphrase>'"
echo "SSH via TeslaCP: ssh <user>@192.168.4.254"
echo "SSH via eth0 (still up): ssh <user>@<eth0-ip>"
