#!/usr/bin/env bash
# timeout: 780
#
# The assistant survives a restart of its gateway. `sudo -n reboot` is not
# available to the clawbox user, so this restarts the gateway the way the box
# itself does — restartGateway() in src/lib/openclaw-config.ts:
# `sudo -n systemctl reset-failed` + `restart clawbox-gateway.service`, the
# grants in config/clawbox-sudoers — or, where the gateway is a legacy USER
# unit, `systemctl --user restart`. Then:
#
#   * the gateway comes back as a NEW process and /setup-api/gateway/health
#     answers available:true within 120 s of the restart, and
#   * the chat turn of 30-chat-turn passes again (chat_turn in lib.sh).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# Answer: "<system|user> <MainPID before>", or "none".
# shellcheck disable=SC2016  # expanded on the board
BEFORE=$(board '
  if [ -n "$(systemctl list-unit-files clawbox-gateway.service --no-legend 2>/dev/null)" ]; then
    echo "system $(systemctl show clawbox-gateway.service -p MainPID --value)"
  elif [ -n "$(systemctl --user list-unit-files openclaw-gateway.service --no-legend 2>/dev/null)" ]; then
    echo "user $(systemctl --user show openclaw-gateway.service -p MainPID --value)"
  else
    echo "none"
  fi
')
read -r SCOPE OLD_PID <<<"$BEFORE"
case "${SCOPE:-}" in
  system) UNIT=clawbox-gateway.service ;;
  user) UNIT=openclaw-gateway.service ;;
  *) not_ok "no gateway unit on this board (answer: '${BEFORE:-nothing}')"; finish ;;
esac
note "gateway: $SCOPE unit $UNIT, MainPID $OLD_PID"

START=$(date +%s)
# shellcheck disable=SC2016  # expanded on the board
if board '
  if [ "$1" = system ]; then
    sudo -n /usr/bin/systemctl reset-failed clawbox-gateway.service 2>/dev/null || true
    sudo -n /usr/bin/systemctl restart clawbox-gateway.service
  else
    systemctl --user restart openclaw-gateway.service
  fi
' "$SCOPE"; then
  ok "restarted $UNIT"
else
  not_ok "could not restart $UNIT"
  finish
fi

# Back within 120 s of the restart: a new MainPID, active, and healthy.
DEADLINE=$((START + 120))
NEW_PID=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # shellcheck disable=SC2016  # expanded on the board
  STATE=$(board '
    if [ "$1" = system ]; then c=(systemctl); else c=(systemctl --user); fi
    echo "$("${c[@]}" is-active "$2") $("${c[@]}" show "$2" -p MainPID --value)"
  ' "$SCOPE" "$UNIT")
  read -r ACTIVE NEW_PID <<<"$STATE"
  if [ "$ACTIVE" = active ] && [ -n "$NEW_PID" ] && [ "$NEW_PID" != 0 ] && [ "$NEW_PID" != "$OLD_PID" ]; then
    break
  fi
  NEW_PID=""
  sleep 3
done
if [ -z "$NEW_PID" ]; then
  not_ok "$UNIT was not active as a new process within 120 s (last: ${STATE:-no answer})"
  finish
fi
LEFT=$((DEADLINE - $(date +%s)))
[ "$LEFT" -gt 0 ] || LEFT=1
if wait_gateway_health "$LEFT"; then
  ok "gateway back as PID $NEW_PID and healthy $(( $(date +%s) - START ))s after the restart"
else
  not_ok "/setup-api/gateway/health not available within 120 s of the restart: $(api_error)"
  finish
fi

chat_turn
finish
