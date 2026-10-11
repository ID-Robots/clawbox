#!/usr/bin/env bash
# timeout: 180
#
# The VNC desktop comes up on its first start of the boot and stays up. On the
# boot after an update, clawbox-vnc.service used to log
#   clawbox-vnc.service: Main process exited, code=exited, status=2/INVALIDARGUMENT
# a moment after it started: every update runs vnc_install, which arms the
# first-boot marker, and clawbox-firstboot-vnc.service then restarted the unit
# that was already up (x11vnc exits 2 on the SIGTERM).
#
# Runs after 75-full-reboot, so "this boot" is the one that test made. Run on
# its own, it reads whatever boot the board is in: reboot it first.
#
#   * clawbox-vnc.service is active (given 60 s, as in 20-services).
#   * In this boot's journal, systemd (PID 1) logged no
#     "clawbox-vnc.service: Main process exited" line and started the unit
#     exactly once. The journal is read as clawbox, who reads the system
#     journal through `adm`; a journal that shows no start of the unit at all
#     is reported, never passed.
#   * Whether clawbox-firstboot-vnc.service ran this boot is noted: that boot
#     is the one that exercises the restart this guards against.
#
# Skips when the board does not define the unit, or disables it (headless).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

UNIT=clawbox-vnc.service

# "state <defined|undefined> <is-enabled> <is-active> <NRestarts>", "uptime N",
# "firstboot <ExecMainStartTimestampMonotonic>", then one "pid1 <message>" per
# line systemd logged about the unit in this boot.
# shellcheck disable=SC2016  # expanded on the board
ANSWER=$(board '
  unit=$1
  if [ -z "$(systemctl list-unit-files "$unit" --no-legend 2>/dev/null)" ]; then
    echo "state undefined - - -"; exit 0
  fi
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null)
  for _ in $(seq 1 12); do
    [ "$(systemctl is-active "$unit" 2>/dev/null)" = active ] && break
    case "$enabled" in enabled|static|alias) sleep 5 ;; *) break ;; esac
  done
  echo "state defined ${enabled:-unknown} $(systemctl is-active "$unit" 2>/dev/null) $(systemctl show "$unit" -p NRestarts --value 2>/dev/null)"
  echo "uptime $(cut -d. -f1 /proc/uptime)"
  echo "firstboot $(systemctl show clawbox-firstboot-vnc.service -p ExecMainStartTimestampMonotonic --value 2>/dev/null)"
  journalctl -b --no-pager -o cat _PID=1 "UNIT=$unit" 2>/dev/null | sed "s/^/pid1 /"
' "$UNIT")
STATE=$(grep -m1 '^state ' <<<"$ANSWER")
if [ -z "$STATE" ]; then
  # No state line is a hop that failed (board prints what it got instead):
  # a failure, never the headless skip below.
  not_ok "could not read $UNIT on the board over nano-ci ssh: $(head -n 1 <<<"$ANSWER" | head -c 200)"
  finish
fi

read -r _ DEFINED ENABLED ACTIVE NRESTARTS <<<"$STATE"
UPTIME=$(sed -n 's/^uptime //p' <<<"$ANSWER" | head -n 1)
FIRSTBOOT=$(sed -n 's/^firstboot //p' <<<"$ANSWER" | head -n 1)
PID1=$(sed -n 's/^pid1 //p' <<<"$ANSWER")

if [ "${DEFINED:-}" = undefined ]; then
  skip "$UNIT is not defined on this board"
  finish
fi
if [ "${ACTIVE:-}" != active ] && [ "${ENABLED:-}" != enabled ]; then
  skip "$UNIT is ${ENABLED:-unknown} (${ACTIVE:-unknown}): the board runs headless"
  finish
fi

note "board up ${UPTIME:-?}s; $UNIT NRestarts=${NRESTARTS:-?}"
case "${FIRSTBOOT:-}" in
  "" | 0) note "clawbox-firstboot-vnc.service did not run this boot (no first-boot marker)" ;;
  *[!0-9]*) note "clawbox-firstboot-vnc.service: unreadable start time '$FIRSTBOOT'" ;;
  *) note "clawbox-firstboot-vnc.service ran this boot, $((FIRSTBOOT / 1000000))s after boot" ;;
esac
while IFS= read -r line; do [ -z "$line" ] || note "systemd: $line"; done <<<"$PID1"

if [ "$ACTIVE" = active ]; then
  ok "$UNIT is active"
else
  not_ok "$UNIT is enabled but ${ACTIVE:-unknown}"
fi

STARTS=$(grep -c '^Started ' <<<"$PID1")
EXITED=$(grep -F "$UNIT: Main process exited" <<<"$PID1" | head -n 1)
if [ "$STARTS" -eq 0 ]; then
  not_ok "this boot's journal shows no start of $UNIT: the clawbox user cannot read the system journal (not in adm?), so the boot is unproven"
  finish
fi
if [ -n "$EXITED" ]; then
  not_ok "this boot's journal has \"$EXITED\""
else
  ok "no \"$UNIT: Main process exited\" line in this boot's journal"
fi
if [ "$STARTS" -eq 1 ]; then
  ok "$UNIT started once this boot"
else
  not_ok "$UNIT started $STARTS times this boot, not once"
fi

finish
