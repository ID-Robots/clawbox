#!/usr/bin/env bash
# timeout: 300
#
# The box's services are up after the rebuild.
#
#   * clawbox-gateway.service and clawbox-setup.service are active (system
#     units — config/*.service; given 60 s, the gateway restarts twice after a
#     rebuild). clawbox-vnc.service must be active too when the board defines
#     AND enables it; a board set to headless disables it on purpose.
#   * Health: `nano-ci health` (the lab's own definition), and
#     /setup-api/gateway/health answering 200 with available:true. The
#     dashboard has no public /health: a bare /health is session-gated and
#     proxied to the gateway, and the MCP bearer opens /setup-api/* only
#     (src/middleware.ts) — so this documented route is the health answer
#     the dashboard gives without a login.
#   * The dashboard serves its login page (public) with 200.
#   * The `openclaw` CLI is where the product runs it from
#     (~/.npm-global/bin/openclaw — install-x64.sh OPENCLAW_BIN, the gateway
#     unit's ExecStart) and answers --version as the clawbox user.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# One line per unit, "<unit> <defined|undefined> <is-enabled> <is-active>",
# read after giving an enabled unit up to 60 s to become active.
# shellcheck disable=SC2016  # expanded on the board
UNITS=$(board '
  for unit in clawbox-gateway.service clawbox-setup.service clawbox-vnc.service; do
    if [ -z "$(systemctl list-unit-files "$unit" --no-legend 2>/dev/null)" ]; then
      echo "$unit undefined - -"; continue
    fi
    enabled=$(systemctl is-enabled "$unit" 2>/dev/null)
    for _ in $(seq 1 12); do
      [ "$(systemctl is-active "$unit" 2>/dev/null)" = active ] && break
      case "$enabled" in enabled|static|alias) sleep 5 ;; *) break ;; esac
    done
    echo "$unit defined ${enabled:-unknown} $(systemctl is-active "$unit" 2>/dev/null)"
  done
')
if [ -z "$UNITS" ]; then
  not_ok "could not read the board's systemd units over nano-ci ssh"
fi
while read -r unit defined enabled active; do
  [ -n "$unit" ] || continue
  case "$unit" in
    clawbox-vnc.service)
      if [ "$defined" = undefined ]; then
        note "clawbox-vnc.service is not defined on this board: not required"
      elif [ "$active" = active ]; then
        ok "clawbox-vnc.service is active"
      elif [ "$enabled" != enabled ]; then
        note "clawbox-vnc.service is defined but $enabled ($active): the board runs headless, not required"
      else
        not_ok "clawbox-vnc.service is enabled but $active"
      fi
      ;;
    *)
      if [ "$active" = active ]; then ok "$unit is active"; else not_ok "$unit is $active ($defined, $enabled)"; fi
      ;;
  esac
done <<<"$UNITS"

HEALTH=$("$NANO_CI" health "$NANO_SERIAL" 2>&1)
rc=$?
while IFS= read -r line; do [ -z "$line" ] || note "nano-ci health: $line"; done <<<"$HEALTH"
if [ "$rc" -eq 0 ]; then
  ok "nano-ci health passes"
else
  not_ok "nano-ci health fails (exit $rc)"
fi

if wait_gateway_health 60; then
  ok "/setup-api/gateway/health answers 200 available:true (${WAITED}s)"
else
  not_ok "/setup-api/gateway/health: $(api_error), available=$(api_json '.available') after ${WAITED}s"
fi

# shellcheck disable=SC2016  # expanded on the board
LOGIN=$(board 'curl -sS -o /dev/null -w "%{http_code}" --max-time 30 "$DASHBOARD/login"')
if [ "$LOGIN" = 200 ]; then
  ok "the dashboard serves /login with 200"
else
  not_ok "the dashboard answered /login with ${LOGIN:-nothing}"
fi

# shellcheck disable=SC2016  # expanded on the board
CLI=$(board '
  echo "login-shell: $(bash -lc "command -v openclaw" 2>/dev/null || echo none)"
  [ -x "$1" ] || { echo "missing"; exit 3; }
  timeout 60 "$1" --version 2>&1 | tail -n 1
' "$OPENCLAW_BIN")
rc=$?
note "openclaw on the login PATH: $(head -n 1 <<<"$CLI" | sed 's/^login-shell: //')"
case "$rc" in
  0) ok "openclaw resolves at $OPENCLAW_BIN: $(tail -n 1 <<<"$CLI")" ;;
  3) not_ok "openclaw is not installed at $OPENCLAW_BIN" ;;
  *) not_ok "$OPENCLAW_BIN --version failed (exit $rc): $(tail -n 1 <<<"$CLI")" ;;
esac

finish
