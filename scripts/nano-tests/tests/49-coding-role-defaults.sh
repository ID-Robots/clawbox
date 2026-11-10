#!/usr/bin/env bash
# timeout: 300
# parallel: probes
# covers: src/lib/coding-role-models.ts src/lib/coding-provider.ts
#
# A coding team's role with nothing stored for it starts on its own default
# model (TASK-2217): the planner on the provider's best model, a worker and a
# reviewer on its middle one; ClawBox AI on its one model for all three.
#
#   * The running server's answer — GET /setup-api/coding-agent/settings, the
#     route the coding_settings_get tool reads — names that model for every
#     role the board left on auto, on the board's own provider.
#   * The board's own checkout, run with its bun, resolves every provider ×
#     role with nothing stored to the same table.
#
# Read-only: nothing on the board is changed. Authenticated with the board's
# MCP bearer, read on the board (lib.sh `api`).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# provider role model — what a role gets with nothing stored.
EXPECTED='anthropic planner claude-fable-5-2
anthropic worker claude-sonnet-5-5
anthropic reviewer claude-opus-5-5
openai planner gpt-6-astra
openai worker gpt-5.6-sol
openai reviewer gpt-5.6-sol
clawbox-ai planner deepseek-v4-flash
clawbox-ai worker deepseek-v4-flash
clawbox-ai reviewer deepseek-v4-flash'
expected_model() { awk -v p="$1" -v r="$2" '$1 == p && $2 == r { print $3 }' <<<"$EXPECTED"; }

RUNTIME=$(board_runtime)
note "runtime: $RUNTIME"

board_api GET /setup-api/coding-agent/settings
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent settings did not answer: $(api_error)"
  finish
fi
for role in planner worker reviewer; do
  # Empty when the answer has no entry for the role: the settings view names
  # every role, so a missing one is a failure, never a stored choice.
  # shellcheck disable=SC2016  # $r is jq's
  stored=$(api_json --arg r "$role" '.roleModels[$r] | objects | select((.provider | type) == "string" and (.model | type) == "string") | "\(.provider)/\(.model)"')
  # shellcheck disable=SC2016
  got=$(api_json --arg r "$role" '.roleModelMap[$r] | objects | select((.provider | type) == "string") | "\(.provider) \(.model) \(.effort)"')
  if [ -z "$stored" ] || [ -z "$got" ]; then
    not_ok "settings API ($RUNTIME): the answer has no $role entry (roleModels: ${stored:-missing}; roleModelMap: ${got:-missing})"
    continue
  fi
  if [ "$stored" != "auto/auto" ]; then
    note "settings API: the board stored $stored for the $role, so it is no default; it runs on $got"
    continue
  fi
  provider=${got%% *}
  want=$(expected_model "$provider" "$role")
  case "$got" in
    "$provider $want "*) ok "settings API ($RUNTIME): the $role on auto runs on $got" ;;
    *) not_ok "settings API ($RUNTIME): the $role on auto runs on $got, expected $provider $want" ;;
  esac
done

# shellcheck disable=SC2016  # JavaScript, not shell
RESOLVE='
(async () => {
  const roles = await import(process.cwd() + "/src/lib/coding-role-models.ts");
  const providers = await import(process.cwd() + "/src/lib/coding-provider.ts");
  for (const p of providers.CODING_PROVIDERS) {
    for (const r of roles.MODEL_ROLES) {
      const run = roles.resolveRoleRun(r, p, providers.defaultModelForProvider(p), "ultracode", {});
      console.log(["@@", p, r, run.model ?? "null", run.tier, run.auto, run.effort].join(" "));
    }
  }
  process.exit(0);
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
'
# shellcheck disable=SC2016  # expanded on the board
RAW=$(board 'cd "$REPO" && exec timeout 120 bun -e "$1"' "$RESOLVE")
LINES=$(printf '%s\n' "$RAW" | sed -n 's/^@@ //p')
if [ "$(printf '%s\n' "$LINES" | grep -c .)" != 9 ]; then
  not_ok "the resolver did not answer for 3 providers × 3 roles on the board: $(printf '%s' "$RAW" | tail -n 3 | tr '\n' ' ' | head -c 300)"
  finish
fi
while read -r provider role model tier auto effort; do
  want=$(expected_model "$provider" "$role")
  if [ "$model" = "$want" ] && [ "$tier" = default ] && [ "$auto" = true ]; then
    ok "resolver on the board ($RUNTIME): $provider $role on auto -> $model at $effort"
  else
    not_ok "resolver on the board ($RUNTIME): $provider $role on auto -> $model ($tier, auto $auto), expected $want"
  fi
done <<<"$LINES"

finish
