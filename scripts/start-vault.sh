#!/usr/bin/env bash
# Starts ClawBox Vault (vault/src/server/main.ts) for clawbox-vault.service.
#
# The service runs under Bun, like the MCP server: it bundles its desktop app
# and the browser extension itself when it starts. Bun is the box user's own
# install (~/.bun/bin/bun, where install.sh puts it); a PC install may have it
# on PATH instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BUN="${CLAWBOX_BUN_BIN:-}"
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  BUN=""
  for candidate in "${HOME:-/home/clawbox}/.bun/bin/bun" "$(command -v bun 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      BUN="$candidate"
      break
    fi
  done
fi
if [ -z "$BUN" ]; then
  echo "clawbox-vault: bun was not found (looked in ~/.bun/bin and on PATH)" >&2
  exit 1
fi

# Loopback, whatever the environment says. The service refuses anything else
# by itself; this keeps a stray variable from stopping it instead.
export CLAWBOX_VAULT_HOST=127.0.0.1

cd "$ROOT/vault"
exec "$BUN" run src/server/main.ts
