#!/usr/bin/env bash
set -euo pipefail

IFACE="wlP1p1s0"
CON_NAME="ClawBox-Setup"
SSID="ClawBox-Setup"
AP_IP="10.42.0.1"

echo "[AP] Cleaning up any previous AP connection..."
nmcli connection down "$CON_NAME" 2>/dev/null || true
nmcli connection delete "$CON_NAME" 2>/dev/null || true

echo "[AP] Creating WiFi access point: $SSID"
nmcli connection add \
  type wifi \
  ifname "$IFACE" \
  con-name "$CON_NAME" \
  ssid "$SSID" \
  autoconnect no \
  wifi.mode ap \
  wifi.band bg \
  wifi.channel 6 \
  ipv4.method shared \
  ipv4.addresses "${AP_IP}/24"

# Remove any security settings to make it an open network
nmcli connection modify "$CON_NAME" remove 802-11-wireless-security 2>/dev/null || true

echo "[AP] Activating access point..."
nmcli connection up "$CON_NAME"

# Wait for interface to come up
sleep 2

# DNS hijack is handled by NM's built-in dnsmasq via
# /etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf
# which resolves all queries to 10.42.0.1

echo "[AP] Setting up iptables captive portal rules..."
# Redirect HTTP traffic not destined for us to our server (captive portal trigger)
iptables -t nat -A PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80"

echo "[AP] WiFi access point '$SSID' is running on $IFACE ($AP_IP)"
