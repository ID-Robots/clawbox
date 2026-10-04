#!/usr/bin/env bash
# timeout: 900
#
# The box survives a REAL reboot — power menu "Restart", which is
# `sudo -n systemctl reboot` (power-approval.ts, the grant in
# config/clawbox-sudoers) — and comes back ready on its own.
# (70-reboot-survival only restarts the gateway.)
#
#   * The board goes down and comes back with a new boot id within 6 min.
#   * A file in /tmp is gone (it really rebooted) and a file in the clawbox
#     home survived.
#   * clawbox-gateway and clawbox-setup come up by themselves, enabled and
#     active; no clawbox-* unit is left failed.
#   * Boot-time readiness: right after boot the gateway reports its event loop
#     degraded (`cpu`) while it warms up. That is waited out, not reported —
#     the gateway must be started AND settled within 5 min of the board
#     answering again (wait_gateway_settled in lib.sh). How long the box took
#     from `reboot` to answering, to the dashboard, and to settled is noted.
#   * Still on the same commit, the dashboard serves /login, and a real chat
#     turn answers (chat_turn in lib.sh).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

MARK="nano-ci-reboot-$NANO_RUN_ID"
# shellcheck disable=SC2016  # expanded on the board
BEFORE=$(board '
  echo kept > "$HOME/.$1" && echo gone > "/tmp/$1"
  echo "$(cat /proc/sys/kernel/random/boot_id) $(git -C "$REPO" rev-parse HEAD)"
' "$MARK" | tail -n 1)
read -r BOOT0 HEAD0 <<<"$BEFORE"
if [ -z "${HEAD0:-}" ]; then
  not_ok "could not read the board's boot id and commit before the reboot"
  finish
fi

START=$(date +%s)
# Detached, so the ssh session returns before the box tears it down.
# shellcheck disable=SC2016  # expanded on the board
if board 'nohup bash -c "sleep 2; sudo -n /usr/bin/systemctl reboot" >/dev/null 2>&1 & echo dispatched' | grep -q dispatched; then
  ok "reboot dispatched (sudo -n systemctl reboot)"
else
  not_ok "could not dispatch the reboot"
  finish
fi

# Wait for it to go away, then to come back with another boot id.
BOOT1=""
while [ $(( $(date +%s) - START )) -lt 360 ]; do
  sleep 10
  BOOT1=$(board 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null | tail -n 1 | tr -d '[:space:]')
  [ -n "$BOOT1" ] && [ "$BOOT1" != "$BOOT0" ] && break
  BOOT1=""
done
if [ -z "$BOOT1" ]; then
  not_ok "the board did not come back with a new boot id within 6 min"
  finish
fi
UP=$(( $(date +%s) - START ))
ok "board back after a real reboot (${UP}s to answer ssh)"
UPTIME=$(board 'cut -d. -f1 /proc/uptime' | tail -n 1)
note "board uptime when first reached: ${UPTIME:-?}s"

# First probe as early as the box answers: this is where `degraded: cpu` shows.
gateway_probe /readyz
note "first /readyz after boot: HTTP $PROBE_STATUS $(printf '%s' "$PROBE_BODY" | jq -c '{ready, degraded: .eventLoop.degraded, reasons: .eventLoop.reasons, uptimeMs}' 2>/dev/null)"

if wait_gateway_settled 300; then
  ok "gateway started and settled ${SETTLE_WAITED}s after the board answered ($(( $(date +%s) - START ))s after reboot)"
  [ -z "$SETTLE_SEEN" ] || note "boot-time states waited out: $SETTLE_SEEN"
else
  not_ok "gateway not settled 300 s after boot: ${SETTLE_STATE:-unknown} (seen: ${SETTLE_SEEN:-nothing})"
fi

# shellcheck disable=SC2016  # expanded on the board
AFTER=$(board '
  for u in clawbox-gateway.service clawbox-setup.service; do
    for _ in $(seq 1 24); do [ "$(systemctl is-active "$u")" = active ] && break; sleep 5; done
    echo "unit $u $(systemctl is-enabled "$u" 2>/dev/null) $(systemctl is-active "$u")"
  done
  echo "failed $(systemctl list-units --state=failed --no-legend --plain "clawbox*" 2>/dev/null | awk "{print \$1}" | tr "\n" " ")"
  echo "files $([ -f "$HOME/.$1" ] && echo kept || echo lost) $([ -f "/tmp/$1" ] && echo stayed || echo gone)"
  rm -f "$HOME/.$1" "/tmp/$1"
  echo "head $(git -C "$REPO" rev-parse HEAD)"
  echo "login $(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 "$DASHBOARD/login")"
' "$MARK")
while read -r kind a b c; do
  case "$kind" in
    unit)
      if [ "$b" = enabled ] && [ "$c" = active ]; then ok "$a came back by itself"; else not_ok "$a after reboot: $b, $c"; fi ;;
    failed)
      if [ -z "$a" ]; then ok "no clawbox unit failed during boot"; else not_ok "failed after boot: $a $b $c"; fi ;;
    files)
      if [ "$a" = kept ]; then ok "files in the clawbox home survive a reboot"; else not_ok "a file in the clawbox home was lost across the reboot"; fi
      if [ "$b" = gone ]; then ok "/tmp was cleared: a real reboot"; else not_ok "/tmp kept its file: the board did not really reboot"; fi ;;
    head)
      if [ "$a" = "$HEAD0" ]; then ok "same commit after reboot"; else not_ok "commit changed across the reboot: ${HEAD0:0:12} -> ${a:0:12}"; fi ;;
    login)
      if [ "$a" = 200 ]; then ok "dashboard serves /login after reboot"; else not_ok "dashboard answered /login with ${a:-nothing} after reboot"; fi ;;
  esac
done <<<"$AFTER"

chat_turn
note "reboot to chat answer: $(( $(date +%s) - START ))s"
finish
