#!/usr/bin/env bash
# timeout: 300
# parallel: probes
# covers: src/lib/openclaw-db-maintenance.ts src/lib/x64-integration.ts scripts/openclaw-db-maintenance.py src/app/setup-api/gateway/db-maintenance/*
#
# Settings → System → Agent databases reads the same core the board has, and
# the web server finds it where it always has on the appliance. READ-ONLY: one
# owner GET of the status route and the helper's own `status --json`, which
# opens every database mode=ro. Nothing is compacted, nothing is stopped.
#
#   * The board keeps the core's package.json beside the binary's npm prefix
#     (`~/.npm-global/bin/../lib/node_modules/openclaw/package.json`), the
#     layout the web server's --core-pkg was always derived from.
#   * The helper's `status --json` with exactly that --core-pkg (the argument
#     every earlier build passed) names the package's version: the baseline.
#   * OpenClaw: GET /setup-api/gateway/db-maintenance (the web server's own
#     args, at the commit under test) reports available, the same core and the
#     same `supported` as that baseline.
#   * Hermes: the route answers available:false without asking the helper,
#     as it always has on a box with no OpenClaw gateway.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
note "runtime: $RUNTIME"

# "<package version or -> <baseline JSON or -> <desktop integration: yes|no>",
# from the board.
# shellcheck disable=SC2016  # expanded on the board
BASE=$(board '
  : "${HOME:?HOME is not set on the board}" "${REPO:?REPO is not set on the board}"
  integration=no
  [ -e /etc/clawbox/x64-integration.env ] && integration=yes
  bin=$HOME/.npm-global/bin/openclaw
  pkg=$(dirname "$bin")/../lib/node_modules/openclaw/package.json
  version=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"version\") or \"\")" "$pkg" 2>/dev/null)
  report=$(python3 -I "$REPO/scripts/openclaw-db-maintenance.py" status --json \
      --data-dir "$REPO/data" --openclaw-bin "$bin" --core-pkg "$pkg" 2>/dev/null \
    | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({\"core\": d.get(\"core\"), \"supported\": d.get(\"supported\")}, separators=(\",\", \":\")))" 2>/dev/null)
  echo "${version:--} ${report:--} $integration"
')
read -r PKG_VERSION BASELINE INTEGRATION <<<"$BASE"
note "core package beside the binary: ${PKG_VERSION:--}; helper status with that --core-pkg: ${BASELINE:--}; desktop integration: ${INTEGRATION:-unknown}"

if [ "${PKG_VERSION:--}" = - ] && [ "${INTEGRATION:-}" = yes ]; then
  # The x86 desktop integration's core lives under the NPM_PREFIX its host file
  # names, not beside the binary: the unit tests cover that layout, and this
  # test's baseline is the appliance's.
  skip "this board runs the x86 desktop integration, whose core is not beside the binary; this test checks the appliance layout"
  finish
fi

if [ "${PKG_VERSION:--}" != - ]; then
  ok "the core's package.json is beside the binary's npm prefix (OpenClaw $PKG_VERSION)"
elif [ "$RUNTIME" = openclaw ]; then
  not_ok "no readable core package.json at ~/.npm-global/lib/node_modules/openclaw on an OpenClaw board"
else
  note "no OpenClaw core package on this Hermes board"
fi

BASE_CORE=$(printf '%s' "${BASELINE:-}" | jq -r '.core // "null"' 2>/dev/null)
BASE_SUPPORTED=$(printf '%s' "${BASELINE:-}" | jq -r '.supported | tostring' 2>/dev/null)
if [ "${PKG_VERSION:--}" != - ]; then
  if [ "$BASE_CORE" = "$PKG_VERSION" ]; then
    ok "the helper's status --json with the appliance's --core-pkg names core $BASE_CORE (supported: $BASE_SUPPORTED)"
  else
    not_ok "the helper's status --json with the appliance's --core-pkg named core '${BASE_CORE:-nothing}', the package says $PKG_VERSION"
  fi
fi

board_owner_api GET /setup-api/gateway/db-maintenance
if [ "$API_STATUS" != 200 ]; then
  not_ok "the db-maintenance status route did not answer: $(api_error)"
  finish
fi
note "route: $(api_json -c '{available, core, supported, databases: (.databases | length), running}')"

if [ "$RUNTIME" = hermes ]; then
  if [ "$(api_json '.available | tostring')" = false ]; then
    ok "on the Hermes runtime the route answers available:false, as before"
  else
    not_ok "on the Hermes runtime the route answered available:$(api_json '.available | tostring'), expected false"
  fi
  finish
fi

ROUTE_CORE=$(api_json '.core // "null"')
ROUTE_SUPPORTED=$(api_json '.supported | tostring')
if [ "$(api_json '.available | tostring')" = true ]; then ok "the route reports the databases available"; else not_ok "the route reports available:$(api_json '.available | tostring')"; fi
if [ "$ROUTE_CORE" = "$BASE_CORE" ]; then
  ok "the route names the same core as the baseline ($ROUTE_CORE)"
else
  not_ok "the route names core '$ROUTE_CORE', the baseline '${BASE_CORE:-nothing}'"
fi
if [ "$ROUTE_SUPPORTED" = "$BASE_SUPPORTED" ]; then
  ok "the route's supported is the baseline's ($ROUTE_SUPPORTED)"
else
  not_ok "the route's supported is '$ROUTE_SUPPORTED', the baseline's '${BASE_SUPPORTED:-nothing}'"
fi
finish
