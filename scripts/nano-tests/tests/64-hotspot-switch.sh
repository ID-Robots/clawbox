#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/hotspot-env.ts src/app/setup-api/system/hotspot/* src/app/setup-api/wifi/connect/*
# covers: scripts/start-ap.sh scripts/stop-ap.sh scripts/ap-watchdog.sh scripts/wifi-failover.sh scripts/wifi-radio.sh
#
# The Settings hotspot switch is the one the radio obeys (GitHub #1517). The
# switch used to live in config.json for Settings and in data/hotspot.env for
# the AP scripts, and the two drifted: Settings said "off" over a live AP.
# Driven the way the owner drives it (POST /setup-api/system/hotspot, owner
# session), read back from the radio itself, across a REAL reboot:
#
#   1. Off: the route answers `stopped`, nmcli shows no active ClawBox-Setup
#      on the WiFi interface, `iw dev <iface> info` is not `type AP`, GET says
#      enabled:false active:false, and data/hotspot.env carries
#      HOTSPOT_DISABLED=1 with config's hotspot_enabled false beside it. Still
#      down 30 s later, after the AP watchdog's 20 s timer has had its look.
#   2. Reboot (`sudo -n systemctl reboot`, as 75-full-reboot): back with a new
#      boot id, and once clawbox-ap.service has run, still no AP and GET still
#      says off.
#   3. On: the route answers `restarted`, the AP comes back (nmcli and iw),
#      GET says enabled:true active:true, and the flag is gone.
#
# Every step checks the wired default route (device and address) is the one
# the test started with: the board is reached over it, and the hotspot must
# never touch it. The board's hotspot is left as it was found: the radio
# through the same route, then data/hotspot.env and config's hotspot_* keys
# byte for byte, also when a step fails.
#
# Skips (does not fail) on a board with no WiFi radio, one whose setup is not
# complete, or one whose radio is a WiFi client right now (switching the
# hotspot on is then deferred by design, and would take the radio off that
# network).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
note "runtime: $RUNTIME"
TAG="hotspot-$(printf '%s' "$NANO_RUN_ID" | tr -c 'A-Za-z0-9._-' '-')"

# One line about the radio and the wired uplink, from the board:
#   iface=<wifi iface> nm_ap=<yes|no> iw=<type|none> client=<yes|no> wired=<dev>/<addr>
# shellcheck disable=SC2016  # expanded on the board
PROBE='
iface=$(sed -n "s/^NETWORK_INTERFACE=//p" "$REPO/data/network.env" /etc/clawbox/network.env 2>/dev/null | head -n1 | tr -d "[:space:]\"")
iface=${iface:-wlP1p1s0}
rows=$(nmcli -t -f NAME,TYPE,DEVICE connection show --active 2>/dev/null)
nm_ap=no
grep -qx "ClawBox-Setup:802-11-wireless:$iface" <<<"$rows" && nm_ap=yes
client=no
awk -F: -v i="$iface" "\$2==\"802-11-wireless\" && \$3==i && \$1!=\"ClawBox-Setup\" {f=1} END {exit !f}" <<<"$rows" && client=yes
info=$(iw dev "$iface" info 2>/dev/null)
type=$(awk "\$1==\"type\" {print \$2; exit}" <<<"$info")
wired=$(ip -4 route show default 2>/dev/null | awk "{for (i = 1; i < NF; i++) if (\$i == \"dev\") {print \$(i + 1); exit}}")
addr=$(ip -4 -o addr show dev "${wired:-lo}" 2>/dev/null | awk "{print \$4; exit}")
echo "iface=$iface nm_ap=$nm_ap iw=${type:-none} client=$client wired=${wired:-none}/${addr:-none}"
'
probe() { board "$PROBE" | tail -n 1; }
# field LINE KEY
field() { local kv; for kv in $1; do case "$kv" in "$2"=*) printf '%s' "${kv#*=}"; return ;; esac; done; }
ap_up() { [ "$(field "$1" nm_ap)" = yes ] && [ "$(field "$1" iw)" = AP ]; }
ap_down() { [ "$(field "$1" nm_ap)" = no ] && [ "$(field "$1" iw)" != AP ]; }

# "<HOTSPOT_DISABLED value or -> <config hotspot_enabled>", read on the board.
# shellcheck disable=SC2016  # expanded on the board
STORED='
flag=$(sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?HOTSPOT_DISABLED=//p" "$REPO/data/hotspot.env" 2>/dev/null | head -n1 | tr -d "[:space:]\"'"'"'")
cfg=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"hotspot_enabled\", \"unset\"))" "$REPO/data/config.json" 2>/dev/null)
echo "${flag:--} ${cfg:-?}"
'
stored() { board "$STORED" | tail -n 1; }

# GET /setup-api/system/hotspot as the owner -> "<enabled> <active>"; "" when it did not answer 200.
hotspot_state() {
  API_MAX_TIME=30 board_owner_api GET /setup-api/system/hotspot
  [ "$API_STATUS" = 200 ] || return 1
  printf '%s %s' "$(api_json '.enabled')" "$(api_json '.active')"
}

# POST the switch as Settings does ({ssid, enabled}); sets AP_ACTION to the
# route's apAction. Not called in $(…), so its note reaches the log.
AP_ACTION=""
switch_hotspot() {
  local body
  AP_ACTION=""
  body=$(jq -nc --arg ssid "$SSID" --argjson on "$1" '{ssid: $ssid, enabled: $on}')
  # The route waits on the AP unit itself; a healthy stop or start takes well
  # under a minute, and 5 min keeps the test inside its deadline.
  API_MAX_TIME=300 board_owner_api POST /setup-api/system/hotspot "$body"
  if [ "$API_STATUS" != 200 ]; then
    note "POST /setup-api/system/hotspot enabled=$1 answered $API_STATUS: $(api_error)"
    return 1
  fi
  AP_ACTION=$(api_json '.apAction')
}

wired_same() {
  local now
  now=$(field "$1" wired)
  if [ "$now" = "$WIRED0" ]; then ok "$2: the wired uplink is untouched ($now)"; else not_ok "$2: the wired uplink changed: $WIRED0 -> ${now:-?}"; fi
}

# ---- preconditions --------------------------------------------------------------
# shellcheck disable=SC2016  # expanded on the board
SETUP=$(board 'python3 -I -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get(\"setup_complete\"), c.get(\"password_configured\"))" "$REPO/data/config.json" 2>&1' | tail -n 1)
note "config.json setup_complete, password_configured: ${SETUP:-unreadable}"
P0=$(probe)
note "before: $P0"
if [ "${SETUP%% *}" != True ]; then
  skip "setup is not complete on this board: the hotspot switch is the wizard's until then"
  finish
fi
IFACE=$(field "$P0" iface)
WIRED0=$(field "$P0" wired)
if [ "$(field "$P0" iw)" = none ]; then
  skip "no WiFi radio answers as $IFACE on this board"
  finish
fi
if [ "$(field "$P0" client)" = yes ]; then
  skip "the radio is a WiFi client right now: switching the hotspot on would be deferred (and would drop that network)"
  finish
fi
case "$WIRED0" in none/*|*/none)
  not_ok "no wired default route with an address: refusing to touch the radio of a board reached over the network"
  finish ;;
esac
STATE0=$(hotspot_state) || { not_ok "GET /setup-api/system/hotspot answered $API_STATUS before the test"; finish; }
SSID=$(api_json '.ssid')
INIT_UP=no
ap_up "$P0" && INIT_UP=yes
note "found: switch enabled=${STATE0% *} active=${STATE0#* }, AP up=$INIT_UP, stored $(stored)"

# Keep what the board had: data/hotspot.env and config's hotspot_* keys, in a
# 0700 directory of the clawbox home (it holds the WPA key; never printed).
# shellcheck disable=SC2016  # expanded on the board
SAVED=$(board '
  d="$HOME/.cache/clawbox-nano-tests/$1"
  rm -rf -- "$d" && mkdir -p "$d" && chmod 700 "$d" || exit 1
  if [ -f "$REPO/data/hotspot.env" ] && [ ! -L "$REPO/data/hotspot.env" ]; then
    cp -p "$REPO/data/hotspot.env" "$d/hotspot.env" || exit 1
  fi
  python3 -I - "$REPO/data/config.json" "$d/config-keys.json" <<"PY" || exit 1
import json, os, sys
cfg = json.load(open(sys.argv[1]))
keys = {k: cfg[k] for k in ("hotspot_enabled", "hotspot_ssid", "hotspot_password") if k in cfg}
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(keys, f)
PY
  echo saved
' "$TAG" | tail -n 1)
if [ "$SAVED" != saved ]; then
  not_ok "could not keep a copy of the board's hotspot settings: not touching them"
  finish
fi

RESTORED=0
restore() {
  [ "$RESTORED" = 0 ] || return 0
  RESTORED=1
  local p back
  p=$(probe)
  if [ "$INIT_UP" = yes ] && ! ap_up "$p"; then
    switch_hotspot true || true
    note "restore: switched back on (${AP_ACTION:-no answer})"
  elif [ "$INIT_UP" = no ] && ! ap_down "$p"; then
    switch_hotspot false || true
    note "restore: switched back off (${AP_ACTION:-no answer})"
  fi
  # shellcheck disable=SC2016  # expanded on the board
  back=$(board '
    d="$HOME/.cache/clawbox-nano-tests/$1"
    [ -f "$d/config-keys.json" ] || { echo "nothing kept"; exit 1; }
    if [ -f "$d/hotspot.env" ]; then
      cp -p "$d/hotspot.env" "$REPO/data/hotspot.env.nano-restore" && mv -f "$REPO/data/hotspot.env.nano-restore" "$REPO/data/hotspot.env" || exit 1
    else
      rm -f -- "$REPO/data/hotspot.env"
    fi
    python3 -I - "$REPO/data/config.json" "$d/config-keys.json" <<"PY" || exit 1
import json, os, sys
path = sys.argv[1]
cfg = json.load(open(path))
kept = json.load(open(sys.argv[2]))
changed = False
for k in ("hotspot_enabled", "hotspot_ssid", "hotspot_password"):
    if k in kept:
        if cfg.get(k) != kept[k]:
            cfg[k] = kept[k]; changed = True
    elif k in cfg:
        del cfg[k]; changed = True
if changed:
    tmp = path + ".nano-restore"
    st = os.stat(path)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, st.st_mode & 0o777)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)
PY
    rm -rf -- "$d"
    echo restored
  ' "$TAG" | tail -n 1)
  p=$(probe)
  note "after restore: $p, stored $(stored)"
  if [ "$back" = restored ]; then ok "data/hotspot.env and config's hotspot keys are back as found"; else not_ok "could not put the hotspot settings back (${back:-no answer})"; fi
  if { [ "$INIT_UP" = yes ] && ap_up "$p"; } || { [ "$INIT_UP" = no ] && ap_down "$p"; }; then
    ok "the hotspot is left as found (AP up=$INIT_UP)"
  else
    not_ok "the hotspot is not as found (AP up=$INIT_UP before): $p"
  fi
}
trap restore EXIT

# ---- 1. off -----------------------------------------------------------------------
switch_hotspot false || { not_ok "switching the hotspot off failed"; finish; }
if [ "$AP_ACTION" = stopped ]; then ok "off: the route stopped the AP (apAction stopped)"; else not_ok "off: apAction ${AP_ACTION:-?}, not stopped"; fi
P1=$(probe)
note "after off: $P1"
if ap_down "$P1"; then ok "off: no AP on $IFACE (nmcli no active ClawBox-Setup, iw type $(field "$P1" iw))"; else not_ok "off: the AP is still up: $P1"; fi
S1=$(hotspot_state)
if [ "$S1" = "false false" ]; then ok "off: Settings reads enabled:false active:false"; else not_ok "off: Settings reads '${S1:-no answer}' (enabled active)"; fi
ST1=$(stored)
if [ "$ST1" = "1 False" ]; then ok "off: HOTSPOT_DISABLED=1 in data/hotspot.env, hotspot_enabled false in config"; else not_ok "off: stored '$ST1' (env flag, config), expected '1 False'"; fi
wired_same "$P1" "off"
sleep 30
P1b=$(probe)
if ap_down "$P1b"; then ok "off: still no AP 30 s later (the AP watchdog left it off)"; else not_ok "off: the AP came back within 30 s: $P1b"; fi

# ---- 2. reboot --------------------------------------------------------------------
# shellcheck disable=SC2016  # expanded on the board
BOOT0=$(board 'cat /proc/sys/kernel/random/boot_id' | tail -n 1 | tr -d '[:space:]')
START=$(date +%s)
# Detached, so the ssh session returns before the box tears it down.
# shellcheck disable=SC2016  # expanded on the board
if board 'nohup bash -c "sleep 2; sudo -n /usr/bin/systemctl reboot" >/dev/null 2>&1 & echo dispatched' | grep -q dispatched; then
  ok "reboot dispatched (sudo -n systemctl reboot)"
else
  not_ok "could not dispatch the reboot"
  finish
fi
BOOT1=""
while [ $(( $(date +%s) - START )) -lt 360 ]; do
  sleep 5
  BOOT1=$(board 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null | tail -n 1 | tr -d '[:space:]')
  [ -n "$BOOT1" ] && [ -n "$BOOT0" ] && [ "$BOOT1" != "$BOOT0" ] && break
  BOOT1=""
done
if [ -z "$BOOT1" ]; then
  not_ok "the board did not come back with a new boot id within 6 min"
  finish
fi
ok "board back after a real reboot ($(( $(date +%s) - START ))s)"
# The web server, then clawbox-ap.service having made its boot-time decision.
S2=""
until [ $(( $(date +%s) - START )) -ge 480 ]; do
  S2=$(hotspot_state) && break
  S2=""
  sleep 5
done
[ -n "$S2" ] || { not_ok "Settings did not answer within 8 min of the reboot"; finish; }
AP_UNIT=""
until [ $(( $(date +%s) - START )) -ge 540 ]; do
  # shellcheck disable=SC2016  # expanded on the board
  AP_UNIT=$(board 'systemctl show clawbox-ap.service -p ActiveState --value 2>/dev/null' | tail -n 1)
  case "$AP_UNIT" in activating|reloading|"") sleep 5 ;; *) break ;; esac
done
# shellcheck disable=SC2016  # expanded on the board
SAID=$(board 'journalctl -b -u clawbox-ap.service -o cat --no-pager 2>/dev/null | grep -c "Hotspot disabled in settings"' | tail -n 1)
note "clawbox-ap.service after boot: ${AP_UNIT:-?}; 'Hotspot disabled in settings' lines this boot: ${SAID:-unreadable}"
sleep 30
P2=$(probe)
note "after reboot: $P2"
if ap_down "$P2"; then ok "reboot: still no AP on $IFACE"; else not_ok "reboot: the AP came back: $P2"; fi
S2=$(hotspot_state)
if [ "$S2" = "false false" ]; then ok "reboot: Settings still reads enabled:false active:false"; else not_ok "reboot: Settings reads '${S2:-no answer}' (enabled active)"; fi
wired_same "$P2" "reboot"

# ---- 3. on ------------------------------------------------------------------------
switch_hotspot true || { not_ok "switching the hotspot on failed"; finish; }
if [ "$AP_ACTION" = restarted ]; then ok "on: the route restarted the AP (apAction restarted)"; else not_ok "on: apAction ${AP_ACTION:-?}, not restarted"; fi
P3=""
for _ in $(seq 1 24); do
  P3=$(probe)
  ap_up "$P3" && break
  sleep 5
done
note "after on: $P3"
if ap_up "$P3"; then ok "on: the AP is back on $IFACE (nmcli active ClawBox-Setup, iw type AP)"; else not_ok "on: no AP 2 min after switching on: $P3"; fi
S3=$(hotspot_state)
if [ "$S3" = "true true" ]; then ok "on: Settings reads enabled:true active:true"; else not_ok "on: Settings reads '${S3:-no answer}' (enabled active)"; fi
ST3=$(stored)
if [ "$ST3" = "- True" ]; then ok "on: no HOTSPOT_DISABLED in data/hotspot.env, hotspot_enabled true in config"; else not_ok "on: stored '$ST3' (env flag, config), expected '- True'"; fi
wired_same "$P3" "on"

restore
finish
