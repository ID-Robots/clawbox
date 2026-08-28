#!/usr/bin/env bash

set -euo pipefail

NETWORK_READINESS_LIB="${CLAWBOX_NETWORK_READINESS_LIB:-/usr/local/libexec/clawbox/network-readiness.sh}"
OPENCLAW_BIN="${CLAWBOX_OPENCLAW_BIN:-/home/clawbox/.npm-global/bin/openclaw}"
LOG_TAG="clawbox-channel-recovery"
VERIFY_ATTEMPTS="${CLAWBOX_CHANNEL_RECOVERY_VERIFY_ATTEMPTS:-6}"
VERIFY_DELAY_SECONDS="${CLAWBOX_CHANNEL_RECOVERY_VERIFY_DELAY_SECONDS:-5}"

log() { logger -t "$LOG_TAG" -- "$*"; }

if [ ! -r "$NETWORK_READINESS_LIB" ]; then
  log "Network readiness helper is unavailable; refusing channel recovery"
  exit 1
fi

# shellcheck source=/usr/local/libexec/clawbox/network-readiness.sh
source "$NETWORK_READINESS_LIB"

if ! clawbox_network_ready; then
  log "Public route is not ready; leaving channels stopped for the next bounded retry"
  exit 0
fi

status_json=$($OPENCLAW_BIN channels status --probe --json)
mapfile -t recovery_targets < <(
  python3 -c '
import json, sys
payload = json.load(sys.stdin)
for channel, accounts in (payload.get("channelAccounts") or {}).items():
    for account in accounts or []:
        error = str(account.get("lastError") or "").lower()
        suppressed = "crash-loop breaker" in error or "restart-loop breaker" in error
        probe_ok = (account.get("probe") or {}).get("ok") is True
        if (account.get("enabled") is True and account.get("configured") is True
                and account.get("running") is not True and suppressed and probe_ok):
            account_id = account.get("accountId") or "default"
            print(channel, account_id, sep="\t")
' <<<"$status_json"
)

if [ "${#recovery_targets[@]}" -eq 0 ]; then
  exit 0
fi

for target in "${recovery_targets[@]}"; do
  IFS=$'\t' read -r channel account_id <<<"$target"
  params=$(python3 -c 'import json,sys; print(json.dumps({"channel":sys.argv[1],"accountId":sys.argv[2]}, separators=(",",":")))' "$channel" "$account_id")
  log "Starting breaker-suppressed channel account $channel/$account_id"
  $OPENCLAW_BIN gateway call channels.start --params "$params" --json --timeout 30000 >/dev/null
done

for ((attempt=1; attempt<=VERIFY_ATTEMPTS; attempt++)); do
  status_json=$($OPENCLAW_BIN channels status --json)
  if python3 -c '
import json, sys
targets = {tuple(item.split("\t", 1)) for item in sys.argv[1:]}
payload = json.load(sys.stdin)
current = {}
for channel, accounts in (payload.get("channelAccounts") or {}).items():
    for account in accounts or []:
        current[(channel, account.get("accountId") or "default")] = account
raise SystemExit(0 if all(
    current.get(target, {}).get("running") is True
    and current.get(target, {}).get("connected") is True
    for target in targets
) else 1)
' "${recovery_targets[@]}" <<<"$status_json"; then
    log "Recovered ${#recovery_targets[@]} breaker-suppressed channel account(s)"
    exit 0
  fi
  if [ "$attempt" -lt "$VERIFY_ATTEMPTS" ]; then
    sleep "$VERIFY_DELAY_SECONDS"
  fi
done

log "Channel recovery did not reach running+connected state"
exit 1
