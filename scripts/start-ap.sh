#!/usr/bin/env bash
set -euo pipefail

# Installed root services source only their root-owned sibling. Web callers
# request restart_ap through the root-step launcher, never execute this as root.
. "$(dirname "${BASH_SOURCE[0]}")/wifi-radio.sh"
wifi_lock
# Budgets start AFTER the (separately bounded 180s) ownership wait. Every NM
# subprocess is capped by the current phase, including profile enumeration.
# Keep fallback and restoration reserves separate from candidate traversal.
bounded_budget() {
  local value="$1" maximum="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "${#value}" -gt 3 ]; then value="$maximum"; fi
  value=$((10#$value))
  if [ "$value" -lt 1 ] || [ "$value" -gt "$maximum" ]; then value="$maximum"; fi
  printf '%s' "$value"
}
phase_deadline=$((SECONDS + 60))
phase_command() {
  local remaining=$((phase_deadline - SECONDS)) wait="$1"
  shift
  [ "$remaining" -gt 0 ] || return 124
  [ "$wait" -le "$remaining" ] || wait="$remaining"
  # A hung command must not consume the recovery reserve. Kill its whole
  # timeout process group, including children which inherited the radio lock.
  timeout --signal=KILL "$wait" "$@"
}
nmcli() {
  local wait=10
  if [ "${1:-}" = --wait ]; then wait="$2"; fi
  phase_command "$wait" nmcli "$@"
}
iw() { phase_command 5 iw "$@"; }
ip() { phase_command 5 ip "$@"; }
iptables() { phase_command 5 iptables "$@"; }
sysctl() { phase_command 5 sysctl "$@"; }
wifi_recover || exit 1
IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
DEFAULT_AP_IP="10.42.0.1"
ALT_AP_IP="10.43.0.1"
AP_IP="$DEFAULT_AP_IP"
IFACE_TIMEOUT="$(bounded_budget "${IFACE_TIMEOUT:-10}" 10)"

# Detect collision with the upstream subnet. If any non-AP interface is on
# 10.42.0.0/24, switch the AP to 10.43.0.0/24 so the captive portal,
# masquerade, and DHCP don't fight the home network.
detect_subnet_collision() {
  local upstream
  while IFS= read -r upstream; do
    case "$upstream" in
      10.42.0.*) AP_IP="$ALT_AP_IP"; return ;;
    esac
  done < <(ip -4 -o addr show 2>/dev/null | awk -v ap="$IFACE" '$2!=ap && $2!="lo" {split($4,a,"/"); print a[1]}')
}
detect_subnet_collision
AP_SUBNET="${AP_IP%.*}.0/24"
echo "[AP] Selected AP IP $AP_IP (subnet $AP_SUBNET)"
# $ROOT names the data files this script reads (parsed, never sourced) and the
# caches it writes — never anything it executes. It is the seam ap-watchdog.sh
# already has, here so the tests can run this script against a fake root. On a
# box it is unset: clawbox-ap.service loads only the root-owned
# /etc/clawbox/network.env, which does not set it, so the paths stay the
# /home/clawbox/clawbox/data ones the web server reads (src/lib/network.ts
# resolves the scan cache through the same CLAWBOX_ROOT).
ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
CONFIG_FILE="$ROOT/data/config.json"
DNSMASQ_SHARED="/etc/NetworkManager/dnsmasq-shared.d"
CAPTIVE_CONF="$DNSMASQ_SHARED/captive-portal.conf"

# Read one KEY=VALUE out of a file this script must not trust with `source`.
#
# This script runs as ROOT — clawbox-ap.service and clawbox-ap-watchdog.service
# have no User=, and install.sh's granted
# clawbox-root-update@restart_ap.service restarts them — while
# /home/clawbox/clawbox/data is written by the web server as the clawbox user.
# `source`ing that file was therefore arbitrary root code execution for anything
# with clawbox-level code execution: the web server, the in-UI terminal, the
# agent's shell. Parse it instead; the values below are only ever passed to
# nmcli as arguments, never evaluated. TASK-445.
read_env_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 0
  [ -L "$file" ] && return 0
  line="$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null)" || return 0
  value="${line#*=}"
  # A CRLF-terminated file leaves the CR on the value, and it would travel into
  # the SSID or the PSK as an argv byte — an AP nothing can associate with.
  value="${value%$'\r'}"
  # Strip one layer of matching quotes; a WiFi PSK may legitimately contain
  # almost anything else, so nothing further is filtered here.
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

HOTSPOT_ENV="$ROOT/data/hotspot.env"
HOTSPOT_SSID="$(read_env_value "$HOTSPOT_ENV" HOTSPOT_SSID)"
HOTSPOT_PASSWORD="$(read_env_value "$HOTSPOT_ENV" HOTSPOT_PASSWORD)"
HOTSPOT_DISABLED="$(read_env_value "$HOTSPOT_ENV" HOTSPOT_DISABLED)"
SSID="${HOTSPOT_SSID:-ClawBox-Setup}"
CON_NAME="ClawBox-Setup"

# Check if setup is complete (phone should get internet, not captive portal)
setup_complete=false
if [ -f "$CONFIG_FILE" ]; then
  if grep -E -q '"setup_complete":[[:space:]]*true' "$CONFIG_FILE" 2>/dev/null; then
    setup_complete=true
  fi
fi

# If hotspot is explicitly disabled (post-setup), skip AP mode entirely
if [ "$setup_complete" = true ] && [ "${HOTSPOT_DISABLED:-}" = "1" ]; then
  echo "[AP] Hotspot disabled in settings — skipping AP mode"
  exit 0
fi

# NetworkManager being "started" (the unit's After=) does NOT mean it has
# finished bringing the radio under management. At boot the wifi device can
# still be initialising, and bringing the AP up against an unready NM fails —
# which is exactly why the hotspot would only appear after a manual
# `systemctl restart` once NM had settled. Wait for NM to report ready first.
wait_for_nm() {
  local elapsed=0
  local timeout="$(bounded_budget "${NM_READY_TIMEOUT:-30}" 30)"
  while [ "$elapsed" -lt "$timeout" ] && [ "$SECONDS" -lt "$phase_deadline" ]; do
    if [ "$(nmcli -t -f RUNNING general status 2>/dev/null)" = "running" ]; then
      echo "[AP] NetworkManager is ready (after ${elapsed}s)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[AP] Warning: NetworkManager not ready after ${timeout}s; proceeding anyway"
  return 1
}
wait_for_nm || true

# Single WiFi radio: it can host the AP or join a WiFi network, but not both. If
# a wired (Ethernet) uplink is present the device already has connectivity, so we
# keep the radio for the hotspot instead of joining saved WiFi. This is what lets
# "just plug in Ethernet" bring the hotspot up — no need to forget the network.
ethernet_connected() {
  nmcli -t -f TYPE,STATE device status 2>/dev/null | grep -q '^ethernet:connected'
}

# ─── Saved WiFi client profiles ──────────────────────────────────────────────
# Profiles are chosen and acted on by UUID, never by name. In terse output the
# TYPE of a WiFi profile is "802-11-wireless" (the selector here used to grep
# for "wifi", which matched only profiles whose NAME happened to contain it, so
# a box whose network was called anything else went straight to the hotspot and
# tore its own LAN connection down). nmcli also escapes ':' and '\' inside
# values, two profiles may share a name, and a name may look like a UUID — so a
# name is neither safe to split on ':' nor to hand back to `nmcli connection
# up`. UUID, TYPE, DEVICE and the numeric columns never contain ':', so every
# query below puts NAME LAST and a row is cut on its first separators; the name
# that is left is unescaped for comparisons and log lines only.
HEX_RE='^[0-9A-Fa-f]+$'

# A canonical UUID, 8-4-4-4-12 hex digits. The lengths are checked with
# ${#..} rather than regex bounds, which glibc expands into memory bash never
# hands back (src/tests/unit/shell-regex-hygiene.test.ts).
is_uuid() {
  local u="$1" hex
  [ "${#u}" -eq 36 ] || return 1
  [ "${u:8:1}${u:13:1}${u:18:1}${u:23:1}" = "----" ] || return 1
  hex="${u//-/}"
  [ "${#hex}" -eq 32 ] && [[ "$hex" =~ $HEX_RE ]]
}

# Undo nmcli's terse escaping: `\:` -> `:`, `\\` -> `\`.
nm_unescape() {
  local s="$1" out="" c
  while [ -n "$s" ]; do
    c="${s:0:1}"; s="${s:1}"
    if [ "$c" = "\\" ] && [ -n "$s" ]; then c="${s:0:1}"; s="${s:1}"; fi
    out+="$c"
  done
  printf '%s' "$out"
}

# Split one terse row of N fields whose last one is NAME into ROW[0..N-1],
# NAME unescaped. Returns 1 for a row that is short or does not start with a
# UUID (a name with a newline in it spills onto a line of its own; that
# fragment is dropped here rather than misread).
split_row() {
  local line="$1" n="$2" i
  ROW=()
  for ((i = 1; i < n; i++)); do
    case "$line" in *:*) ;; *) return 1 ;; esac
    ROW+=("${line%%:*}")
    line="${line#*:}"
  done
  ROW+=("$(nm_unescape "$line")")
  is_uuid "${ROW[0]}"
}

is_wifi_type() {
  # "wifi" is what an older nmcli printed for the same type.
  case "$1" in 802-11-wireless|wifi) return 0 ;; esac
  return 1
}

# A profile name fit for a log line: control characters (a name can carry an
# escape sequence) replaced, and length capped. Names only — no PSK or other
# secret is ever read by this script (no --show-secrets anywhere).
log_name() {
  local s="${1//[[:cntrl:]]/?}"
  printf '%s' "${s:0:64}"
}

# Client identity comes from mode, never display name: even ClawBox-Setup
# may be an infrastructure profile. Unknown modes are not activated blindly.
is_client_profile() {
  local uuid="$1" name="$2" mode
  # </dev/null: callers run this inside `while read` loops fed by nmcli, and
  # nothing here may consume their input.
  mode="$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" </dev/null 2>/dev/null)" || return 1
  case "$mode" in infrastructure|"") return 0 ;; *) return 1 ;; esac
}

# NetworkManager's numeric device state for the radio (100 = connected): the
# number, not the "(connected)" text after it, which is translated under a
# non-C locale. Prints nothing when nmcli cannot say.
iface_state() {
  local raw
  raw="$(nmcli -g GENERAL.STATE device show "$IFACE" 2>/dev/null)" || raw=""
  raw="${raw%% *}"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then printf '%s' "$raw"; fi
}

# The saved client the radio is connected to right now, as "<uuid><TAB><name>":
# device state 100 AND the connection active on $IFACE is a WiFi client by the
# rules above (the hotspot itself being up does not count). Returns 1 if none.
active_client() {
  local line
  [ "$(iface_state)" = 100 ] || return 1
  while IFS= read -r line; do
    split_row "$line" 4 || continue
    [ "${ROW[2]}" = "$IFACE" ] || continue
    is_wifi_type "${ROW[1]}" || continue
    is_client_profile "${ROW[0]}" "${ROW[3]}" || continue
    printf '%s\t%s\n' "${ROW[0]}" "${ROW[3]}"
    return 0
  done < <(nmcli -t -f UUID,TYPE,DEVICE,NAME connection show --active 2>/dev/null || true)
  return 1
}

# Saved client profiles, most preferred first: AUTOCONNECT-PRIORITY, then most
# recently used (TIMESTAMP), then nmcli's own listing order — the order
# NetworkManager's autoconnect itself prefers. One "<uuid><TAB><name>" per line.
saved_clients() {
  local line prio ts
  nmcli -t -f UUID,TYPE,AUTOCONNECT-PRIORITY,TIMESTAMP,NAME connection show 2>/dev/null |
    while IFS= read -r line; do
      [ "$SECONDS" -lt "$phase_deadline" ] || break
      split_row "$line" 5 || continue
      is_wifi_type "${ROW[1]}" || continue
      is_client_profile "${ROW[0]}" "${ROW[4]}" || continue
      prio="${ROW[2]}"; [[ "$prio" =~ ^-?[0-9]+$ ]] || prio=0
      ts="${ROW[3]}"; [[ "$ts" =~ ^[0-9]+$ ]] || ts=0
      printf '%s\t%s\t%s\t%s\n' "$prio" "$ts" "${ROW[0]}" "${ROW[4]}"
    done | LC_ALL=C sort -s -t "$(printf '\t')" -k1,1nr -k2,2nr | cut -f3-
}

# Leave the radio on the client active_client reported, and stop here.
stay_on_client() {
  local tab=$'\t'
  echo "[AP] WiFi connected to '$(log_name "${1#*"$tab"}")' (${1%%"$tab"*})${2:+ $2} — skipping AP mode"
  exit 0
}

# How long one saved profile may take to come up before the next is tried
# (nmcli's own default is 90 s).
CLIENT_UP_WAIT="${CLIENT_UP_WAIT:-45}"
[[ "$CLIENT_UP_WAIT" =~ ^[0-9]+$ ]] || CLIENT_UP_WAIT=45
if [ "${#CLIENT_UP_WAIT}" -gt 2 ] || [ "$CLIENT_UP_WAIT" -lt 1 ] || [ "$CLIENT_UP_WAIT" -gt 45 ]; then CLIENT_UP_WAIT=45; fi

# Recovery state lives outside this process. EXIT handles ordinary errors;
# systemd ExecStopPost handles SIGKILL/timeout after killing the worker cgroup.
restoration_started=false
restore_device_policy() {
  if [ "$restoration_started" = false ]; then
    phase_deadline=$((SECONDS + 30))
    restoration_started=true
  fi
  wifi_recover
}
restore_autoconnect() {
  local rc=$?
  trap - EXIT
  restore_device_policy || rc=1
  exit "$rc"
}

# Admit only a positively idle radio (or an AP). A failed identity query on a
# connected device is UNKNOWN, not permission to replace a possible client.
# A radio NetworkManager has not finished bringing up (10 unmanaged, 20
# unavailable — its road to 30 at boot) or whose state could not be read gets
# the same bounded look as an activation in flight. Post-setup nothing retries
# this unit (ap-watchdog.sh stands down), so failing on the first look stranded
# a box with no Ethernet. Still never admitted: unsettled after the bound, defer.
client_or_idle() {
  local state client elapsed=0
  while :; do
    [ "$SECONDS" -lt "$phase_deadline" ] || return 1
    state="$(iface_state)"
    case "$state" in
      30|120) return 0 ;;
      100)
        if client="$(active_client)"; then stay_on_client "$client" "during admission"; fi
        if iw dev "$IFACE" info 2>/dev/null | grep -q "type AP"; then return 0; fi
        echo "[AP] Unknown connected WiFi identity — deferring" >&2
        return 1 ;;
      ""|10|20|40|50|60|70|80|90|110)
        if [ "$elapsed" -ge 15 ]; then
          case "$state" in
            ""|10|20) echo "[AP] WiFi state '${state:-unreadable}' did not settle — deferring" >&2 ;;
            *) echo "[AP] WiFi still transitioning — deferring" >&2 ;;
          esac
          return 1
        fi
        sleep 1; elapsed=$((elapsed + 1)) ;;
      *) echo "[AP] Unknown/unavailable WiFi state — deferring" >&2; return 1 ;;
    esac
  done
}

# Explicit connection activation may re-enable device autoconnect. Reassert
# inhibition before each competing action, retaining the ORIGINAL snapshot.
ensure_inhibited() {
  wifi_inhibit || return 1
  client_or_idle
}

# wifi_inhibit must read the policy it snapshots, and at boot the radio may not
# exist yet (driver or firmware still loading) or NM may not answer for it: that
# read failed the unit before client_or_idle's look could run. Read-only and
# bounded the same way; still unreadable after it, wifi_inhibit fails closed.
await_radio_policy() {
  local elapsed=0 policy
  while [ "$SECONDS" -lt "$phase_deadline" ]; do
    policy="$(nmcli -g GENERAL.AUTOCONNECT device show "$RADIO_IFACE" 2>/dev/null)" || policy=""
    case "$policy" in yes|no) return 0 ;; esac
    [ "$elapsed" -lt 15 ] || break
    sleep 1; elapsed=$((elapsed + 1))
  done
  echo "[AP] WiFi device policy unreadable after ${elapsed}s" >&2
}

inhibit_autoconnect() {
  trap restore_autoconnect EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  await_radio_policy
  ensure_inhibited
}

# After setup is complete, prefer joining saved WiFi over starting the AP — UNLESS
# an Ethernet cable provides the uplink, in which case host the hotspot and let
# release_wifi_for_ap() (below) drop the active WiFi client to free the radio.
prefer_saved_wifi=false
if [ "$setup_complete" = true ] && ethernet_connected; then
  echo "[AP] Ethernet uplink present — keeping the radio for the hotspot (not joining saved WiFi)"
elif [ "$setup_complete" = true ]; then
  prefer_saved_wifi=true
  # NetworkManager usually autoconnects the saved network on its own at boot —
  # the ordinary reboot after an update. Then there is nothing to do, and
  # touching the radio would only cost the box its LAN connection.
  if client="$(active_client)"; then
    stay_on_client "$client" "already"
  fi
  inhibit_autoconnect
  phase_deadline=$((SECONDS + $(bounded_budget "${CLIENT_TOTAL_BUDGET:-120}" 120)))
  tried=0
  while IFS=$'\t' read -r uuid name; do
    [ "$SECONDS" -lt "$phase_deadline" ] || break
    [ -n "$uuid" ] || continue
    ensure_inhibited || {
      [ "$SECONDS" -lt "$phase_deadline" ] || break
      exit 1
    }
    remaining=$((phase_deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    client_wait="$CLIENT_UP_WAIT"
    [ "$client_wait" -le "$remaining" ] || client_wait="$remaining"
    tried=$((tried + 1))
    echo "[AP] Setup complete — trying saved WiFi: '$(log_name "$name")' ($uuid)"
    if nmcli --wait "$client_wait" connection up uuid "$uuid" ifname "$IFACE" </dev/null 2>/dev/null; then
      if client="$(active_client)"; then
        name="${client#*$'\t'}"
        echo "[AP] WiFi connected to '$(log_name "$name")' — skipping AP mode"
        exit 0
      fi
      echo "[AP] '$(log_name "$name")' returned success but interface not connected, trying next"
    else
      echo "[AP] '$(log_name "$name")' connection failed, trying next"
    fi
    [ "$SECONDS" -lt "$phase_deadline" ] || break
    # NetworkManager's autoconnect may have got a saved network up while that
    # attempt failed; keep it rather than knock it down with the next one.
    if client="$(active_client)"; then
      stay_on_client "$client" "by autoconnect"
    fi
  done < <(saved_clients)
  if [ "$SECONDS" -ge "$phase_deadline" ]; then
    echo "[AP] Saved candidate budget exhausted — reserving recovery AP time"
  fi
  if [ "$tried" -eq 0 ]; then
    echo "[AP] No saved WiFi client profiles, falling back to AP mode"
  else
    echo "[AP] No saved WiFi profiles connected, falling back to AP mode"
  fi
fi

phase_deadline=$((SECONDS + 45))

# The radio can join a saved network AFTER the pass above: NetworkManager's own
# autoconnect often lands while the pre-AP scan below runs (that scan alone
# polls for up to PRE_AP_SCAN_TIMEOUT seconds). Raising the hotspot then tears
# that connection down — the same lost LAN by a later road. So while saved WiFi
# is the policy (setup complete, no Ethernet uplink), look again right before
# every step that would take the radio from a client, under runtime inhibition.
# Checks alone cannot serialize NM. Pre-setup and with an Ethernet uplink the
# hotspot intentionally owns the radio, without this preservation veto.
keep_late_client() {
  local client
  [ "$prefer_saved_wifi" = true ] || return 0
  if client="$(active_client)"; then
    stay_on_client "$client" "$1"
  fi
}

wait_for_interface() {
  local elapsed=0
  while [ "$elapsed" -lt "$IFACE_TIMEOUT" ] && [ "$SECONDS" -lt "$phase_deadline" ]; do
    if [ -e "/sys/class/net/$IFACE/operstate" ]; then
      local state
      state=$(cat "/sys/class/net/$IFACE/operstate")
      if [ "$state" = "up" ] || [ "$state" = "unknown" ]; then
        echo "[AP] Interface $IFACE is ready (state=$state)"
        return 0
      fi
      echo "[AP] Interface $IFACE state=$state (elapsed=${elapsed}s)"
    else
      echo "[AP] Interface $IFACE operstate file not found (elapsed=${elapsed}s)"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[AP] Warning: Interface $IFACE not ready after ${IFACE_TIMEOUT}s timeout"
  return 1
}

# Free the radio so the AP can own it. Any wifi *client* profile that
# auto-connected at boot (e.g. a network saved during a failed/aborted setup
# attempt) holds $IFACE in station mode, making `nmcli connection up
# ClawBox-Setup` fail with "device busy" — the classic "AP only appears after a
# manual restart" boot race. We tear those down before claiming the radio.
#
# Rows are read with the parser above and acted on by UUID (`IFS=: read` cut a
# name containing ':' in two and silently skipped that profile). Only verified
# client profiles are modified; other AP profiles are not ours to rewrite.
release_wifi_for_ap() {
  local line
  while IFS= read -r line; do
    [ "$SECONDS" -lt "$phase_deadline" ] || return 1
    split_row "$line" 3 || continue
    is_wifi_type "${ROW[1]}" || continue
    # Skip APs by mode, not display name (a client can be ClawBox-Setup).
    is_client_profile "${ROW[0]}" "${ROW[2]}" || continue
    # Stop these client profiles auto-grabbing the radio back from the AP. We do
    # this pre-setup (the radio must be dedicated to the AP), and also post-setup
    # when an Ethernet uplink means we've deliberately chosen the hotspot over
    # WiFi. Either way it's safe: the saved-WiFi block reconnects them via an
    # explicit `nmcli connection up`, which doesn't depend on autoconnect.
    if [ "$setup_complete" != true ] || ethernet_connected; then
      nmcli connection modify uuid "${ROW[0]}" connection.autoconnect no </dev/null 2>/dev/null || true
    fi
    nmcli connection down uuid "${ROW[0]}" </dev/null 2>/dev/null || true
  done < <(nmcli -t -f UUID,TYPE,NAME connection show 2>/dev/null || true)
  # Make sure the device itself isn't mid-association before we re-up the AP.
  nmcli device disconnect "$IFACE" 2>/dev/null || true
}

# ─── Pre-AP WiFi scan ────────────────────────────────────────────────────────
# The interface is free right now (not in AP mode), so scan for nearby networks
# and cache the results. The setup wizard uses this cached list so users can
# pick their network from a list instead of typing the SSID manually.
SCAN_CACHE="$ROOT/data/wifi-scan-cache.json"
# SKIP_PRESCAN=1 (set when restoring the AP after a failed client connect) skips
# the ~20s scan poll and keeps the existing cache — the radio was just in use
# and we only need the hotspot back up fast so the wizard can report the result.
if [ "${SKIP_PRESCAN:-}" = "1" ]; then
  echo "[AP] SKIP_PRESCAN=1 — fast AP restore, keeping existing scan cache"
else
echo "[AP] Scanning for nearby WiFi networks before starting AP..."
# Make sure the interface is actually up before scanning — early in boot it may
# still be initializing, and scanning a down interface returns nothing.
wait_for_interface || echo "[AP] Continuing pre-scan despite interface timeout"
# nmcli populates scan results asynchronously after a rescan, so a fixed short
# sleep often reads an empty list (the radio was also just used for the saved-WiFi
# connect attempts above and needs a moment to settle). Re-trigger the rescan and
# poll the list until real networks appear, up to PRE_AP_SCAN_TIMEOUT seconds.
SCAN_OUTPUT=""
PRE_AP_SCAN_TIMEOUT="${PRE_AP_SCAN_TIMEOUT:-20}"
# Validate before arithmetic: a non-numeric override would make the $((...))
# below a syntax error and abort the whole script under `set -euo pipefail`,
# which would stop the AP from coming up at all.
if ! [[ "$PRE_AP_SCAN_TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "[AP] Invalid PRE_AP_SCAN_TIMEOUT='$PRE_AP_SCAN_TIMEOUT'; defaulting to 20"
  PRE_AP_SCAN_TIMEOUT=20
fi
[ "${#PRE_AP_SCAN_TIMEOUT}" -le 2 ] && [ "$PRE_AP_SCAN_TIMEOUT" -le 20 ] || PRE_AP_SCAN_TIMEOUT=20
scan_deadline=$((SECONDS + 10#$PRE_AP_SCAN_TIMEOUT))
scan_attempt=0
while :; do
  scan_attempt=$((scan_attempt + 1))
  # rescan can fail if one ran very recently ("scanning not allowed"); ignore —
  # the list still reflects the most recent completed scan.
  nmcli device wifi rescan ifname "$IFACE" 2>/dev/null || true
  sleep 3
  SCAN_OUTPUT=$(nmcli -t -f SSID,SIGNAL,SECURITY,FREQ device wifi list ifname "$IFACE" 2>/dev/null || true)
  # Count entries with a non-empty SSID that isn't our own AP. ($1 is an
  # approximation when an SSID contains ':', but it's good enough to decide
  # "did we see anything real yet".)
  found=$(printf '%s\n' "$SCAN_OUTPUT" | awk -F: -v our="$SSID" 'NF>=4 && $1!="" && $1!=our {c++} END {print c+0}')
  if [ "$found" -gt 0 ]; then
    echo "[AP] Pre-scan found $found network(s) on attempt $scan_attempt"
    break
  fi
  if [ "$SECONDS" -ge "$scan_deadline" ]; then
    echo "[AP] Pre-scan found no networks after ${PRE_AP_SCAN_TIMEOUT}s ($scan_attempt attempts)"
    break
  fi
  echo "[AP] Pre-scan attempt $scan_attempt empty, retrying..."
done
if [ -n "$SCAN_OUTPUT" ]; then
  # Parse nmcli terse output into JSON array
  echo "$SCAN_OUTPUT" | awk -F: -v our_ssid="$SSID" '
    BEGIN { printf "[" }
    {
      # Fields from right: FREQ, SECURITY, SIGNAL, rest is SSID
      n = split($0, a, ":")
      if (n < 4) next
      freq = a[n]
      sec = a[n-1]
      sig = a[n-2]
      ssid = a[1]
      for (i = 2; i <= n-3; i++) ssid = ssid ":" a[i]
      if (ssid == "" || ssid == our_ssid) next
      if (sig+0 != sig) next
      if (count++) printf ","
      # Escape JSON special chars in SSID — backslash, quote, control chars
      gsub(/\\/, "\\\\", ssid)
      gsub(/"/, "\\\"", ssid)
      gsub(/\n/, "\\n", ssid)
      gsub(/\r/, "\\r", ssid)
      gsub(/\t/, "\\t", ssid)
      printf "{\"ssid\":\"%s\",\"signal\":%s,\"security\":\"%s\",\"freq\":\"%s\"}", ssid, sig, sec, freq
    }
    END { print "]" }
  ' > "$SCAN_CACHE"
  # grep returns 1 when there are no matches, and `pipefail` propagates that
  # through `| wc -l`, which combined with `set -e` aborts the script before
  # the AP creation steps run. Catch the non-zero pipeline exit with a
  # post-substitution `||` so an empty cache yields NETWORK_COUNT=0 rather
  # than killing the AP startup.
  NETWORK_COUNT=$(grep -o '"ssid"' "$SCAN_CACHE" 2>/dev/null | wc -l) || NETWORK_COUNT=0
  echo "[AP] Cached $NETWORK_COUNT networks to $SCAN_CACHE"
else
  echo "[]" > "$SCAN_CACHE"
  echo "[AP] No networks found during pre-scan"
fi
fi  # end SKIP_PRESCAN guard

phase_deadline=$((SECONDS + $(bounded_budget "${AP_TOTAL_BUDGET:-150}" 150)))
keep_late_client "before the hotspot was set up"
if [ "$prefer_saved_wifi" = true ]; then ensure_inhibited; fi

echo "[AP] Cleaning up any previous AP connection..."
wifi_stop_ap

# NM 1.36 rejects connection.uuid on add. Let NM assign it, then accept only
# its single C-locale success record and an exact UUID-selected readback.
# Never resolve a newly created AP by name: a client can have the same name.
echo "[AP] Creating WiFi access point: $SSID"
AP_CREATED="$(LC_ALL=C nmcli connection add \
  type wifi \
  ifname "$IFACE" \
  con-name "$CON_NAME" \
  ssid "$SSID" \
  autoconnect no \
  wifi.mode ap \
  wifi.band bg \
  wifi.channel 6 \
  ipv4.method shared \
  ipv4.addresses "${AP_IP}/24")"
AP_UUID="${AP_CREATED#"Connection '$CON_NAME' ("}"
AP_UUID="${AP_UUID%") successfully added."}"
if ! is_uuid "$AP_UUID" || [ "$AP_CREATED" != "Connection '$CON_NAME' ($AP_UUID) successfully added." ]; then
  echo '[AP] Invalid AP creation identity; refusing mutation' >&2
  exit 1
fi
AP_IDENTITY="$(LC_ALL=C nmcli -e no -g connection.uuid,connection.id,connection.interface-name,802-11-wireless.mode,802-11-wireless.ssid connection show uuid "$AP_UUID")"
if [ "$AP_IDENTITY" != "$AP_UUID"$'\n'"$CON_NAME"$'\n'"$IFACE"$'\n'ap$'\n'"$SSID" ]; then
  echo '[AP] Created AP identity mismatch; refusing mutation' >&2
  exit 1
fi

# Configure security: WPA-PSK if password set, open network otherwise
if [ -n "${HOTSPOT_PASSWORD:-}" ]; then
  nmcli connection modify uuid "$AP_UUID" \
    802-11-wireless-security.key-mgmt wpa-psk \
    802-11-wireless-security.psk "$HOTSPOT_PASSWORD"
  echo "[AP] WPA-PSK security enabled"
else
  nmcli connection modify uuid "$AP_UUID" remove 802-11-wireless-security 2>/dev/null || true
  echo "[AP] Open network (no password)"
fi

# Configure dnsmasq upstream DNS before activating AP
# (NetworkManager's shared mode starts dnsmasq which reads this config)
rm -f "$CAPTIVE_CONF" 2>/dev/null || true
if [ -w "$DNSMASQ_SHARED" ]; then
  cat > "$DNSMASQ_SHARED/upstream-dns.conf" <<DNSEOF
# Forward DNS queries to public resolvers
server=8.8.8.8
server=8.8.4.4
server=1.1.1.1
# Resolve clawbox.local to AP IP (mDNS doesn't work on hotspot)
address=/clawbox.local/${AP_IP}
DNSEOF
  echo "[AP] Upstream DNS forwarding configured"
else
  echo "[AP] Note: dnsmasq config not writable (run install.sh to fix DNS)"
fi

echo "[AP] Activating access point..."
# Retry the bring-up: at boot the first attempt can lose a race with NM (radio
# still settling, or a client profile briefly holding the device). A oneshot
# service can't restart itself, so the resilience has to live here — free the
# radio and retry a few times, confirming the interface actually entered AP mode
# rather than trusting nmcli's exit code alone.
AP_UP_RETRIES="${AP_UP_RETRIES:-5}"
case "$AP_UP_RETRIES" in [1-5]) ;; *) AP_UP_RETRIES=5 ;; esac
ap_up_ok=false
for ap_attempt in $(seq 1 "$AP_UP_RETRIES"); do
  [ "$SECONDS" -lt "$phase_deadline" ] || break
  # Each attempt takes the radio from whatever holds it, and the client
  # NetworkManager autoconnects in a failed attempt's wake is exactly what a
  # "radio busy" failure looks like — so this is checked every time.
  keep_late_client "before AP attempt $ap_attempt"
  if [ "$prefer_saved_wifi" = true ]; then
    ensure_inhibited
  else
    release_wifi_for_ap
  fi
  if nmcli --wait 30 connection up uuid "$AP_UUID" ifname "$IFACE" 2>&1; then
    wait_for_interface || true
    if iw dev "$IFACE" info 2>/dev/null | grep -q "type AP"; then
      echo "[AP] Access point active (attempt $ap_attempt)"
      ap_up_ok=true
      break
    fi
    echo "[AP] 'up' succeeded but $IFACE not in AP mode yet (attempt $ap_attempt)"
  else
    echo "[AP] Activation attempt $ap_attempt failed (radio may be busy with a client connection)"
  fi
  [ "$SECONDS" -lt "$phase_deadline" ] || break
  [ "$ap_attempt" -lt "$AP_UP_RETRIES" ] && sleep 3
done

if [ "$ap_up_ok" != true ]; then
  echo "[AP] ERROR: access point did not come up after ${AP_UP_RETRIES} attempts" >&2
  exit 1
fi

# Restore before publishing success. EXIT still retries a failed restoration.
restore_device_policy || exit 1

# Remove any leftover captive portal iptables redirect
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80 ! -d "$AP_IP" -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null || true

# Enable IP forwarding and NAT masquerade for internet sharing
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# Find the WAN interface (first connected ethernet)
WAN_IFACE=$(nmcli -t -f DEVICE,TYPE,STATE device status | awk -F: '/ethernet:connected/{print $1; exit}')
if [ -n "$WAN_IFACE" ]; then
  # Ensure MASQUERADE rule exists for hotspot -> internet NAT
  if ! iptables -t nat -C POSTROUTING -o "$WAN_IFACE" -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -o "$WAN_IFACE" -j MASQUERADE
  fi
  # Allow forwarding between hotspot and WAN
  if ! iptables -C FORWARD -i "$IFACE" -o "$WAN_IFACE" -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -i "$IFACE" -o "$WAN_IFACE" -j ACCEPT
  fi
  if ! iptables -C FORWARD -i "$WAN_IFACE" -o "$IFACE" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -i "$WAN_IFACE" -o "$IFACE" -m state --state RELATED,ESTABLISHED -j ACCEPT
  fi
  echo "[AP] NAT masquerade enabled ($IFACE -> $WAN_IFACE)"
else
  echo "[AP] Warning: no WAN interface found, internet sharing unavailable"
fi

echo "[AP] Internet sharing active — access setup at http://${AP_IP}/setup"

echo "[AP] WiFi access point '$SSID' is running on $IFACE ($AP_IP)"

# Publish the live AP address so the Next.js middleware and other services
# can redirect captive-portal probes to whichever subnet was selected.
RUNTIME_FILE="$ROOT/data/ap-runtime.env"
mkdir -p "$(dirname "$RUNTIME_FILE")"
cat > "$RUNTIME_FILE" <<RUNTIME_EOF
AP_IP="$AP_IP"
AP_SUBNET="$AP_SUBNET"
RUNTIME_EOF
chmod 644 "$RUNTIME_FILE"
