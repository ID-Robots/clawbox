#!/usr/bin/env bash

# Bounded proof that the host has a usable public route before ClawBox restarts
# network-dependent services. Callers may override the commands and target for
# synthetic tests; the installed NetworkManager dispatcher clears those
# overrides before calling this helper as root.

clawbox_network_ready() {
  local ip_bin="${CLAWBOX_IP_BIN:-ip}"
  local curl_bin="${CLAWBOX_CURL_BIN:-curl}"
  local probe_ip="${CLAWBOX_NETWORK_PROBE_IP:-1.1.1.1}"
  local probe_url="${CLAWBOX_NETWORK_PROBE_URL:-https://1.1.1.1/cdn-cgi/trace}"
  local http_code

  "$ip_bin" -4 route get "$probe_ip" >/dev/null 2>&1 || return 1
  http_code=$("$curl_bin" --silent --show-error --output /dev/null \
    --connect-timeout 3 --max-time 5 --write-out '%{http_code}' "$probe_url" 2>/dev/null) || return 1
  case "$http_code" in
    2??|3??|4??) return 0 ;;
    *) return 1 ;;
  esac
}
