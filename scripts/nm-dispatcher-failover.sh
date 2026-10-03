#!/usr/bin/env bash
# NetworkManager dispatcher: when Ethernet drops, free the WiFi radio from the
# captive-portal AP and bring up a saved WiFi profile so the box keeps internet.
#
# Installed at /etc/NetworkManager/dispatcher.d/90-clawbox-failover by install.sh.
# Args: $1 = interface, $2 = action (up, down, pre-up, etc.)

set -u

IFACE="${1:-}"
ACTION="${2:-}"
# NetworkManager passes no NETWORK_INTERFACE to a dispatcher, and the radio is
# not always wlP1p1s0 — install.sh auto-detects it and persists the real name
# here precisely because of that, and documents an operator override. Sourced
# the way scripts/clawbox-firewall.sh sources it: the file is ROOT-owned, so
# unlike the clawbox-writable data/*.env it is safe to source as root.
if [ -r /etc/clawbox/network.env ]; then
  # shellcheck disable=SC1091
  . /etc/clawbox/network.env
fi
WIFI_IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
AP_PROFILE="ClawBox-Setup"
LOG_TAG="clawbox-failover"
# Root-owned, root-installed: NetworkManager runs this as root, and the
# checkout is clawbox-owned and group-writable. See the waiter's own header and
# install.sh's ROOT_LIBEXEC_DIR block (TASK-445).
WAITER="${CLAWBOX_ONLINE_WAITER:-/usr/local/libexec/clawbox/gateway-restart-when-online.sh}"
# Root-owned tmpfs, the same directory the waiter takes its lock in, and cleared
# on boot — which is what a "what did we see last time" marker wants anyway.
RUN_DIR="${CLAWBOX_RUN_DIR:-/run/clawbox}"

log() { logger -t "$LOG_TAG" -- "$*"; }

# Hand the gateway restart to the waiter, DETACHED.
#
# The restart is never immediate any more (GH #529): a gateway bounced into a
# network with no route loses its Telegram accounts to OpenClaw's account
# supervisor, which gives up after its restart budget. The waiter defers the
# restart until a public route is proven. See the waiter's own header for what
# OpenClaw's channel health monitor already recovers on its own, and for the
# part of GH #529 that is still unexplained.
#
# Detached because NetworkManager runs dispatcher scripts serially and kills a
# slow one: this script must return at once, and the waiting must not happen in
# it. Several events arriving for one recovery — `up`, `dhcp4-change` and
# `connectivity-change` inside a second is the measured shape — are safe to
# dispatch: the waiter's lock keeps their waits from overlapping, and its
# record of the route it last asked a restart for collapses the rest of the
# burst into that one restart.
#
# The launch is REPORTED, not fire-and-forget into /dev/null: NM runs
# dispatchers with a minimal PATH (the reason 99-clawbox-avahi-reload resolves
# avahi-daemon absolutely), so a missing setsid or a fork failure would
# otherwise leave no trace anywhere of a restart that never happened.
restart_gateway_when_online() {
  if [ ! -x "$WAITER" ]; then
    log "WARN: $WAITER missing or not executable — gateway not restarted for: $1"
    return
  fi
  # PATH first so a test harness can stand in for it, then the absolute paths,
  # because a dispatcher's PATH is NM's and not a login shell's.
  local setsid_bin="" candidate
  setsid_bin="$(command -v setsid 2>/dev/null || true)"
  if [ -z "$setsid_bin" ]; then
    for candidate in /usr/bin/setsid /bin/setsid; do
      [ -x "$candidate" ] && setsid_bin="$candidate" && break
    done
  fi
  if [ -n "$setsid_bin" ]; then
    "$setsid_bin" "$WAITER" "$1" </dev/null >/dev/null 2>&1 &
  else
    # Still detached from this shell, but inside the dispatcher's process
    # group, so NetworkManager's own timeout can take it with it. Said out
    # loud: a restart that silently never happened is what GH #529 was.
    log "WARN: setsid not found — the deferred restart may be killed with the dispatcher"
    "$WAITER" "$1" </dev/null >/dev/null 2>&1 &
  fi
  log "Deferred restart dispatched: $1"
}

# The AP is not a network this box got onto — it is the one it is offering.
# start-ap.sh brings up a `shared` profile with no default route, and
# ap-watchdog.sh re-raises it every ~20 s while setup is incomplete, so without
# this every one of those would start a full wait, hold the lock, and drop a
# genuine Ethernet request in the meantime.
if [ -n "${CONNECTION_UUID:-}" ] &&
   [ "$(nmcli -g 802-11-wireless.mode connection show uuid "$CONNECTION_UUID" 2>/dev/null)" = ap ]; then
  exit 0
fi

# React to ethernet up/down, to the WiFi radio coming up, and — the harness's
# own answer to the question this script asks — to NetworkManager's
# connectivity and DHCP events.
#
# `connectivity-change` carries CONNECTIVITY_STATE and is what NM emits when an
# upstream router reboots with the box's carrier intact: the most common real
# shape of "the accounts got suppressed and never came back", and one that
# produces no up/down at all. `dhcp4-change` is the lease landing a second
# after an association, which the up event is too early for. This repo already
# subscribes to both actions in config/99-clawbox-avahi-reload.
case "$ACTION" in
  connectivity-change)
    # `FULL` and nothing less — and this is NOT the waiter's rule inverted. The
    # waiter is lenient about NM's verdict because it decides whether a restart
    # can SUCCEED, and a LAN that hijacks connectivity-check.ubuntu.com would
    # otherwise veto every restart for ever. This arm decides whether an event
    # is worth ASKING about, and `full` is NM's only positive statement:
    # `portal`, `limited` and `unknown` mean "not decided".
    #
    # Stated honestly, this HALVES the noise rather than removing it — a check
    # that flaps still dispatches on each return to `full`. What it buys is that
    # a LAN permanently parked at `portal`/`limited` cannot ask for a restart on
    # every transition it makes, and a box that never reaches `full` still has
    # the arms that do not depend on NM's opinion at all: `up`, and the DHCP
    # lease below.
    if [ "${CONNECTIVITY_STATE:-}" = "FULL" ]; then
      restart_gateway_when_online "NetworkManager reports full connectivity"
    fi
    exit 0
    ;;
  dhcp4-change)
    # A RENEWAL is not a network change, and this arm must not treat it as one.
    # NM emits dhcp4-change on every T1 renew and T2 rebind: the office LAN
    # hands out `dhcp_lease_time = 86400`, so twice a day, and the one- to
    # two-hour leases consumer routers, guest WiFi and hotel networks give make
    # it 24-48 times a day. A renewal that keeps the same address moves no
    # route and drops no socket, so a restart there buys nothing and costs an
    # in-flight conversation plus a cold-Jetson `gateway-pre-start.sh` — the
    # exact harm the rest of this script exists to avoid. Beta restarted only on
    # Ethernet carrier up/down, which is rare; turning that into a routine event
    # would be a worse bug than the one being fixed.
    #
    # So only a lease that actually MOVED the box counts. The address and
    # gateway are remembered per interface and compared.
    case "$IFACE" in
      eth*|en*|"$WIFI_IFACE") ;;
      *) exit 0 ;;
    esac
    lease="${IP4_ADDRESS_0:-}|${IP4_GATEWAY:-}"
    seen="$RUN_DIR/last-lease.${IFACE//[^A-Za-z0-9._-]/_}"
    mkdir -p "$RUN_DIR" 2>/dev/null || true
    [ "$(cat "$seen" 2>/dev/null || true)" = "$lease" ] && exit 0
    printf '%s' "$lease" > "$seen" 2>/dev/null || true
    restart_gateway_when_online "DHCP lease on '$IFACE' changed"
    exit 0
    ;;
esac

# The carrier really went. Whatever comes back next is a NEW recovery, even on
# the identical lease, so the waiter's "already asked for this recovery" record
# must not outlive it: a cable pulled and replugged inside the coalescing window
# would otherwise be stood down, and that swallowed restart is GH #529 itself.
# The waiter notices an absence it waits through on its own; this covers the
# flap that is over before a waiter even runs, which only the event knows about.
#
# ABOVE the interface case below, and for EVERY uplink this box routes through:
# that case returns for the radio on anything but `up`, and a box joined to the
# customer's WiFi through its own setup AP has no Ethernet arm at all, so a
# clear only Ethernet reached left exactly that box standing down on the restart
# its re-association owes. It over-clears by design — a radio dropping while
# Ethernet still carries the traffic costs one extra restart on the next event,
# which is bounded by a real `down`, where narrowing it to the interface the
# record names would cost a swallowed restart the moment the two names disagree.
if [ "$ACTION" = "down" ]; then
  case "$IFACE" in
    eth*|en*|"$WIFI_IFACE")
      rm -f "$RUN_DIR/gateway-online-restart.stamp" 2>/dev/null || true
      ;;
  esac
fi

# The WiFi arm is the recovery half: after a failover the box's route comes back
# on the wireless interface, and with only the ethernet arm nothing ever asked
# for the restart that revives the channel accounts.
case "$IFACE" in
  eth*|en*) ;;
  "$WIFI_IFACE")
    if [ "$ACTION" = "up" ]; then
      restart_gateway_when_online "WiFi '$IFACE' up"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac

# On ethernet UP, restart the gateway so it rebinds to the now-preferred
# interface. Existing sockets bound to the WiFi IP would otherwise be sent
# down Eth as asymmetric traffic and silently fail.
if [ "$ACTION" = "up" ]; then
  # Carrier is not a route: at `up` the interface may still be waiting on DHCP,
  # and a restart there is the same mistake as the one below.
  restart_gateway_when_online "Ethernet '$IFACE' up"
  exit 0
fi

# Below: handle ethernet DOWN — failover to WiFi and clear stale sockets. The
# record was already cleared above, before this arm could return.
[ "$ACTION" = "down" ] || exit 0

# Confirm there is no other ethernet still up before failing over.
if nmcli -t -f TYPE,STATE device status | grep -q '^ethernet:connected$'; then
  exit 0
fi

log "Ethernet '$IFACE' down — attempting WiFi failover"

# Kill TCP sockets the OpenClaw gateway holds bound to the now-dead interface
# IPs. HTTP/2 keep-alives to OpenAI/Anthropic/Telegram look ESTABLISHED but
# silently blackhole until TCP times out (~120s). A service restart drops them
# and forces fresh connections on the surviving interface.
#
# Requested here and performed only once a route exists. Those sockets are
# already dead either way, so nothing is lost by waiting — while restarting
# into a dead network costs both Telegram accounts until someone notices.
restart_gateway_when_online "Ethernet '$IFACE' down"

# UUIDs are machine identity; connection.id can contain colons, newlines,
# duplicate names or another profile's UUID. Never use it as a selector.
is_uuid() {
  local u="$1" hex
  [ "${#u}" -eq 36 ] || return 1
  [ "${u:8:1}${u:13:1}${u:18:1}${u:23:1}" = "----" ] || return 1
  hex="${u//-/}"
  [ "${#hex}" -eq 32 ] && [[ "$hex" =~ ^[0-9A-Fa-f]+$ ]]
}

# Sets radio_kind and radio_uuid. Unknown/transitioning means DEFER, never
# permission to activate something over a connection we failed to identify.
read_radio() {
  local state rows uuid type device mode
  radio_kind=unknown; radio_uuid=""
  state="$(nmcli -g GENERAL.STATE device show "$WIFI_IFACE" 2>/dev/null)" || return
  case "${state%% *}" in
    30|120) radio_kind=idle; return ;;
    100) ;;
    *) return ;;
  esac
  rows="$(nmcli -t -f UUID,TYPE,DEVICE connection show --active 2>/dev/null)" || return
  while IFS=: read -r uuid type device; do
    [ "$device" = "$WIFI_IFACE" ] || continue
    is_uuid "$uuid" || continue
    case "$type" in wifi|802-11-wireless) ;; *) continue ;; esac
    mode="$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" </dev/null 2>/dev/null)" || return
    radio_uuid="$uuid"
    case "$mode" in
      ap) radio_kind=ap ;;
      infrastructure|"") radio_kind=client ;;
    esac
    return
  done <<< "$rows"
}
keep_client_or_defer() {
  read_radio
  case "$radio_kind" in
    client) log "Already on WiFi UUID $radio_uuid — no failover needed"; exit 0 ;;
    unknown) log "WiFi identity/state uncertain — deferring failover"; exit 1 ;;
  esac
}

keep_client_or_defer
# Only the AP actually on this radio, addressed unambiguously. No blanket down.
if [ "$radio_kind" = ap ]; then
  if [ "$(nmcli -g connection.id connection show uuid "$radio_uuid" 2>/dev/null)" != "$AP_PROFILE" ]; then
    log "Unrelated or unidentified AP on the radio — deferring failover"
    exit 1
  fi
  log "Bringing down active AP UUID $radio_uuid to free radio"
  nmcli --wait 10 connection down uuid "$radio_uuid" >/dev/null 2>&1 || exit 1
fi

# Names are deliberately absent from these rows. Stable numeric sort preserves
# listing order for ties. An unset mode is NM's default infrastructure mode.
mapfile -t profiles < <(
  nmcli -t -f UUID,TYPE,AUTOCONNECT-PRIORITY,TIMESTAMP connection show |
    while IFS=: read -r uuid type priority timestamp; do
      is_uuid "$uuid" || continue
      case "$type" in wifi|802-11-wireless) ;; *) continue ;; esac
      mode="$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" </dev/null 2>/dev/null)" || continue
      case "$mode" in infrastructure|"") ;; *) continue ;; esac
      [[ "$priority" =~ ^-?[0-9]+$ ]] || priority=0
      [[ "$timestamp" =~ ^[0-9]+$ ]] || timestamp=0
      printf '%s:%s:%s\n' "$priority" "$timestamp" "$uuid"
    done | LC_ALL=C sort -s -t: -k1,1nr -k2,2nr | cut -d: -f3
)

# One traversal, a positive per-attempt wait and a total attempt budget. NM may
# continue an activation after a timeout: re-observe before any next action.
deadline=$((SECONDS + 120))
for uuid in "${profiles[@]}"; do
  keep_client_or_defer
  remaining=$((deadline - SECONDS))
  [ "$remaining" -gt 0 ] || break
  wait_s=45; [ "$remaining" -lt "$wait_s" ] && wait_s="$remaining"
  log "Trying WiFi UUID $uuid"
  nmcli --wait "$wait_s" connection up uuid "$uuid" ifname "$WIFI_IFACE" >/dev/null 2>&1 || true
  keep_client_or_defer
done
keep_client_or_defer

log "Failover failed — no saved WiFi profile would connect; starting hotspot as recovery"

# Stranded recovery: no saved WiFi reachable, so bring the captive-portal
# hotspot back up. start-ap.sh honours the user's configured SSID/password
# and falls back to ClawBox-Setup if none is set.
#
# The ROOT-OWNED copy, exactly as $WAITER above: this hook runs as root from
# NetworkManager's dispatcher.d, and the tree under $CLAWBOX_ROOT is
# clawbox-writable, so running scripts/start-ap.sh from there was root
# executing whatever clawbox had put in it. The override is for the tests that
# stand a witness in for the copy. A box whose libexec copy is missing (an
# install_root_libexec that has not run yet) gets the WARN below rather than
# the tree copy. Security scan #21.
START_AP="${CLAWBOX_START_AP:-/usr/local/libexec/clawbox/start-ap.sh}"
if [ -x "$START_AP" ]; then
  bash "$START_AP" >/dev/null 2>&1 &
  log "Recovery AP launch dispatched"
else
  log "WARN: $START_AP missing or not executable — recovery hotspot not started"
fi
exit 0
