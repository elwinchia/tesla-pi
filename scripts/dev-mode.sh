#!/bin/bash
# Flip Pi back to home Wi-Fi client mode. eth0 untouched.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

echo "=== stopping AP services ==="
systemctl stop cert-renew-watch dnsmasq hostapd 2>/dev/null || true
systemctl disable wlan0-ap-up.service hostapd dnsmasq cert-renew-watch 2>/dev/null || true

echo "=== flushing wlan0 ==="
ip addr flush dev wlan0
ip link set wlan0 down

echo "=== returning wlan0 to NetworkManager ==="
rm -f /etc/NetworkManager/conf.d/unmanaged-wlan0.conf
systemctl reload NetworkManager
sleep 1

echo "=== rejoining home Wi-Fi (Ariel) ==="
nmcli con up netplan-wlan0-Ariel || echo "(connection auto-activated; check nmcli con show --active)"

echo "=== state ==="
nmcli -t -f NAME,DEVICE c show --active
ip -4 addr show wlan0 | grep inet || echo "(wlan0 still associating)"
