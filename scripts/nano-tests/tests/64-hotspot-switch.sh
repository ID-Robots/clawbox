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
#      says off. Then the boot-time decision is asked again as root (the
#      restart_ap root step restarts clawbox-ap.service, so start-ap.sh reads
#      the switch exactly as at boot): it skips, and still no AP.
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
#
# nano-lab boards carry /etc/clawbox/lab-hotspot-off (lab policy: no setup
# hotspot in the lab; a drop-in keeps clawbox-ap from ever starting). There the
# AP cannot come up whatever the switch says, so: the switch, Settings and the
# reboot are checked as above; the boot gate is the installed start-ap.sh run
# unprivileged against this board's data with its radio tools stubbed (it must
# skip AP mode and touch nothing); "on" must leave Settings at enabled:true
# active:false (on, truthfully not broadcasting); the AP coming back is a SKIP.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
note "runtime: $RUNTIME"
# Where the board's own hotspot settings are kept while the test runs. A fixed
# name, not a per-run one: a run that was killed before it put them back
# leaves them here, and the next run restores them before it looks.
SAVE_DIR_NAME=hotspot-switch-saved

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

# GET /setup-api/system/hotspot as the owner; sets HS to "<enabled> <active>"
# ("" and status 1 when it did not answer 200) and leaves API_BODY for the
# caller. Not called in $(…): API_BODY would stay in the subshell.
HS=""
hotspot_state() {
  HS=""
  API_MAX_TIME=30 board_owner_api GET /setup-api/system/hotspot
  [ "$API_STATUS" = 200 ] || return 1
  HS="$(api_json '.enabled') $(api_json '.active')"
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

# wired_same PROBE_LINE STEP [device] — the wired default route is the one the
# test started with: device and address, or (after the reboot, where DHCP may
# hand out another lease) the device, with an address change noted.
wired_same() {
  local now
  now=$(field "$1" wired)
  if [ "$now" = "$WIRED0" ]; then
    ok "$2: the wired uplink is untouched ($now)"
  elif [ "${3:-}" = device ] && [ "${now%%/*}" = "${WIRED0%%/*}" ] && [ "${now#*/}" != none ]; then
    ok "$2: the wired uplink is still ${now%%/*}"
    note "$2: its address changed across the reboot: $WIRED0 -> $now"
  else
    not_ok "$2: the wired uplink changed: $WIRED0 -> ${now:-?}"
  fi
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
hotspot_state || { not_ok "GET /setup-api/system/hotspot answered $API_STATUS before the test"; finish; }
STATE0=$HS
SSID=$(api_json '.ssid')
INIT_UP=no
ap_up "$P0" && INIT_UP=yes
note "found: switch enabled=${STATE0% *} active=${STATE0#* }, AP up=$INIT_UP, stored $(stored)"
LAB_OFF=$(board '[ -e /etc/clawbox/lab-hotspot-off ] && echo yes || echo no' | tail -n 1)
if [ "$LAB_OFF" = yes ]; then
  note "nano-lab policy (/etc/clawbox/lab-hotspot-off): clawbox-ap never starts on this board, so the AP itself cannot come up here"
fi

# Put the board's hotspot back from the kept copy: the radio first, through
# the route (switch_hotspot), to the AP state that was found, then
# data/hotspot.env and config's hotspot_* keys byte for byte. $2 is "drop"
# once the radio is back as found, or "keep": the copy then stays for the next
# run to retry. Prints one line: "restored <found AP up: yes|no>" (copy
# dropped), or why not.
# shellcheck disable=SC2016  # expanded on the board
PUT_BACK='
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
  up=$(cat "$d/ap-up" 2>/dev/null)
  if [ "$2" != drop ]; then
    echo "settings put back, the radio is not as found (AP up=${up:-unknown}): copy kept for the next run"
    exit 1
  fi
  rm -rf -- "$d"
  echo "restored ${up:-unknown}"
'
# radio_is WANT_UP — the AP up (yes) or down (no) within 2 min: a start takes
# the AP unit its time.
radio_is() {
  local p=""
  for _ in $(seq 1 24); do
    p=$(probe)
    if [ "$1" = yes ]; then ap_up "$p" && return 0; else ap_down "$p" && return 0; fi
    sleep 5
  done
  note "restore: the AP is not up=$1 after 2 min: $p"
  return 1
}
# put_back WANT_UP — the radio to WANT_UP (yes|no) through the route, then the
# kept bytes; the copy is dropped only when the radio reads back as WANT_UP.
# Sets PUT_BACK_LINE.
PUT_BACK_LINE=""
put_back() {
  local p copy=drop
  p=$(probe)
  if [ "$1" = yes ] && ! ap_up "$p"; then
    switch_hotspot true || true
    note "restore: switched back on (${AP_ACTION:-no answer})"
    radio_is yes || copy=keep
  elif [ "$1" = no ] && ! ap_down "$p"; then
    switch_hotspot false || true
    note "restore: switched back off (${AP_ACTION:-no answer})"
    radio_is no || copy=keep
  fi
  PUT_BACK_LINE=$(board "$PUT_BACK" "$SAVE_DIR_NAME" "$copy" | tail -n 1)
}

# An earlier run killed before it put the board back left its copy: that copy,
# not today's state, is what the board had. Its ap-up marker is written last,
# after which the first toggle runs: a copy without a yes/no marker was cut off
# while it was being taken, before anything was switched, so the board is
# still as it was found and the copy is only replaced (below).
# shellcheck disable=SC2016  # expanded on the board
LEFT=$(board '
  d="$HOME/.cache/clawbox-nano-tests/$1"
  [ -d "$d" ] || exit 0
  up=$(cat "$d/ap-up" 2>/dev/null)
  case "$up" in yes|no) echo "$up" ;; *) echo incomplete ;; esac
' "$SAVE_DIR_NAME" | tail -n 1)
if [ "$LEFT" = incomplete ]; then
  note "an earlier run was stopped while it kept the board's hotspot settings aside, before it switched anything: that partial copy is replaced, nothing is put back"
elif [ -n "$LEFT" ]; then
  note "an earlier run left the board's hotspot settings kept aside (AP up then: $LEFT): putting them back first"
  put_back "$LEFT"
  note "earlier copy: $PUT_BACK_LINE; now $(probe)"
  case "$PUT_BACK_LINE" in restored*) ;; *) not_ok "could not put back what an earlier run kept aside: not touching the hotspot"; finish ;; esac
  P0=$(probe)
  hotspot_state || { not_ok "GET /setup-api/system/hotspot answered $API_STATUS"; finish; }
  STATE0=$HS
  SSID=$(api_json '.ssid')
  INIT_UP=no
  ap_up "$P0" && INIT_UP=yes
fi

# Keep what the board has: data/hotspot.env and config's hotspot_* keys and
# whether the AP is up, in a 0700 directory of the clawbox home (it holds the
# WPA key; never printed). A symlinked env file is not ours to replace: skip.
# shellcheck disable=SC2016  # expanded on the board
SAVED=$(board '
  d="$HOME/.cache/clawbox-nano-tests/$1"
  if [ -L "$REPO/data/hotspot.env" ]; then echo symlink; exit 0; fi
  rm -rf -- "$d" && mkdir -p "$d" && chmod 700 "$d" || exit 1
  if [ -f "$REPO/data/hotspot.env" ]; then
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
  printf "%s\n" "$2" > "$d/ap-up" || exit 1
  echo saved
' "$SAVE_DIR_NAME" "$INIT_UP" | tail -n 1)
if [ "$SAVED" = symlink ]; then
  skip "data/hotspot.env is a symlink on this board: not replacing it"
  finish
fi
if [ "$SAVED" != saved ]; then
  not_ok "could not keep a copy of the board's hotspot settings: not touching them"
  finish
fi

RESTORED=0
restore() {
  [ "$RESTORED" = 0 ] || return 0
  RESTORED=1
  local p
  put_back "$INIT_UP"
  p=$(probe)
  note "after restore: $p, stored $(stored)"
  case "$PUT_BACK_LINE" in
    restored*) ok "data/hotspot.env and config's hotspot keys are back as found" ;;
    *) not_ok "the hotspot is not back as found (${PUT_BACK_LINE:-no answer}); the next run retries from the kept copy" ;;
  esac
  if { [ "$INIT_UP" = yes ] && ap_up "$p"; } || { [ "$INIT_UP" = no ] && ap_down "$p"; }; then
    ok "the hotspot is left as found (AP up=$INIT_UP)"
  else
    not_ok "the hotspot is not as found (AP up=$INIT_UP before): $p"
  fi
}
trap restore EXIT
# run.sh ends a test past its deadline with TERM: exit through the EXIT trap.
trap 'exit 143' TERM INT HUP

# ---- 1. off -----------------------------------------------------------------------
switch_hotspot false || { not_ok "switching the hotspot off failed"; finish; }
if [ "$AP_ACTION" = stopped ]; then
  ok "off: the route stopped the AP (apAction stopped)"
elif [ "$LAB_OFF" = yes ]; then
  # stop-ap.sh (unprivileged) takes the radio lock in /run/clawbox-radio. The
  # tmpfiles entry (config/clawbox-radio-tmpfiles.conf) creates it at boot, and
  # with no AP to stop stop-ap.sh needs no lock at all, so a lab board answers
  # `stopped` now; a board still on an older install, whose AP unit never ran,
  # has no such directory.
  note "off: apAction ${AP_ACTION:-?} (stop-ap.sh has no radio lock directory on a board whose AP unit never ran and that lacks the tmpfiles entry: lab policy)"
else
  not_ok "off: apAction ${AP_ACTION:-?}, not stopped"
fi
P1=$(probe)
note "after off: $P1"
if ap_down "$P1"; then ok "off: no AP on $IFACE (nmcli no active ClawBox-Setup, iw type $(field "$P1" iw))"; else not_ok "off: the AP is still up: $P1"; fi
hotspot_state; S1=$HS
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
  hotspot_state && { S2=$HS; break; }
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
if [ "$LAB_OFF" = yes ]; then
  # The unit is skipped by the lab condition, so ask the installed script
  # itself: unprivileged, its radio lock in a temp dir, nmcli/iw/iptables/
  # sysctl/systemctl replaced by recorders that fail. It reads this board's
  # real data/ and must skip AP mode before touching any of them.
  # shellcheck disable=SC2016  # expanded on the board
  GATE=$(board '
    t=$(mktemp -d) || exit 1
    mkdir "$t/bin" "$t/radio"
    for x in nmcli iw iptables sysctl systemctl; do
      printf "#!/bin/sh\necho \"\$0 \$*\" >> %s/calls\nexit 1\n" "$t" > "$t/bin/$x"; chmod +x "$t/bin/$x"
    done
    printf "#!/bin/sh\nexit 0\n" > "$t/bin/ip"; chmod +x "$t/bin/ip"
    out=$(PATH="$t/bin:$PATH" CLAWBOX_ROOT="$REPO" CLAWBOX_RADIO_RUN_DIR="$t/radio" NM_READY_TIMEOUT=1 IFACE_TIMEOUT=1 PRE_AP_SCAN_TIMEOUT=0 \
      timeout 60 bash /usr/local/libexec/clawbox/start-ap.sh 2>&1)
    rc=$?
    said=0; grep -q "Hotspot disabled in settings" <<<"$out" && said=1
    calls=0; [ -f "$t/calls" ] && calls=$(wc -l < "$t/calls")
    rm -rf -- "$t"
    echo "$rc $said $calls"
  ' | tail -n 1)
  read -r G_RC G_SAID G_CALLS <<<"$GATE"
  if [ "${G_RC:-}" = 0 ] && [ "${G_SAID:-}" = 1 ] && [ "${G_CALLS:-}" = 0 ]; then
    ok "boot decision: the installed start-ap.sh, run unprivileged against this board's data with its radio tools stubbed, skips AP mode ('Hotspot disabled in settings') and calls none of them"
  else
    not_ok "boot decision: start-ap.sh against this board's data: exit ${G_RC:-?}, skip line ${G_SAID:-?}, radio-tool calls ${G_CALLS:-?}"
  fi
else
  # The boot-time decision itself, asked again now: the AP unit restarted as root
  # through the restart_ap root step (the launcher Settings uses), so
  # start-ap.sh reads the switch exactly as at boot. A board whose
  # clawbox-ap.service is not enabled at boot (some lab boards) would otherwise
  # never have asked it.
  # shellcheck disable=SC2016  # expanded on the board
  GATE=$(board '
    since=$(date +%s)
    timeout 300 sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh restart_ap >/dev/null 2>&1
    rc=$?
    n=$(journalctl -u clawbox-ap.service --since "@$since" -o cat --no-pager 2>/dev/null | grep -c "Hotspot disabled in settings")
    echo "$rc ${n:-0}"
  ' | tail -n 1)
  if [ "${GATE%% *}" = 0 ]; then ok "boot decision: clawbox-ap.service restarted as root (restart_ap root step)"; else not_ok "boot decision: the restart_ap root step failed (exit ${GATE%% *})"; fi
  if [ "${GATE#* }" -ge 1 ] 2>/dev/null; then ok "boot decision: start-ap.sh said 'Hotspot disabled in settings'"; else note "start-ap.sh's 'Hotspot disabled in settings' line not seen in the journal (${GATE#* }); the radio below decides"; fi
fi
sleep 30
P2=$(probe)
note "after reboot: $P2"
if ap_down "$P2"; then ok "reboot: still no AP on $IFACE"; else not_ok "reboot: the AP came back: $P2"; fi
hotspot_state; S2=$HS
if [ "$S2" = "false false" ]; then ok "reboot: Settings still reads enabled:false active:false"; else not_ok "reboot: Settings reads '${S2:-no answer}' (enabled active)"; fi
wired_same "$P2" "reboot" device
# The address the reboot handed out (same device, accepted above) is the one
# the "on" step must leave alone.
W2=$(field "$P2" wired)
if [ "${W2%%/*}" = "${WIRED0%%/*}" ] && [ "${W2#*/}" != none ]; then WIRED0=$W2; fi

# ---- 3. on ------------------------------------------------------------------------
switch_hotspot true || { not_ok "switching the hotspot on failed"; finish; }
if [ "$LAB_OFF" = yes ]; then
  note "on: apAction ${AP_ACTION:-?} (the unit's restart is skipped by the lab condition)"
  sleep 15
  P3=$(probe)
  note "after on: $P3"
  if ap_down "$P3"; then ok "on: still no AP on this lab board (lab policy keeps clawbox-ap from starting)"; else not_ok "on: an AP is up on a nano-lab board: $P3"; fi
  skip "on: the AP coming back cannot be shown on a nano-lab board (setup hotspot disabled by lab policy)"
  hotspot_state; S3=$HS
  if [ "$S3" = "true false" ]; then ok "on: Settings reads enabled:true active:false (switched on, and truthfully not broadcasting)"; else not_ok "on: Settings reads '${S3:-no answer}' (enabled active), expected 'true false' here"; fi
else
  if [ "$AP_ACTION" = restarted ]; then ok "on: the route restarted the AP (apAction restarted)"; else not_ok "on: apAction ${AP_ACTION:-?}, not restarted"; fi
  P3=""
  for _ in $(seq 1 24); do
    P3=$(probe)
    ap_up "$P3" && break
    sleep 5
  done
  note "after on: $P3"
  if ap_up "$P3"; then ok "on: the AP is back on $IFACE (nmcli active ClawBox-Setup, iw type AP)"; else not_ok "on: no AP 2 min after switching on: $P3"; fi
  hotspot_state; S3=$HS
  if [ "$S3" = "true true" ]; then ok "on: Settings reads enabled:true active:true"; else not_ok "on: Settings reads '${S3:-no answer}' (enabled active)"; fi
fi
ST3=$(stored)
if [ "$ST3" = "- True" ]; then ok "on: no HOTSPOT_DISABLED in data/hotspot.env, hotspot_enabled true in config"; else not_ok "on: stored '$ST3' (env flag, config), expected '- True'"; fi
wired_same "$P3" "on"

restore
finish
