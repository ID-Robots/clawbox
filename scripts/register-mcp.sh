#!/usr/bin/env bash
# Register the ClawBox MCP server with the Hermes harness.
#
# WHY THIS FILE EXISTS
# --------------------
# The ClawBox MCP server (mcp/clawbox-mcp.ts) is how the on-device agent
# actually operates the device: open an app, read the system stats, take a
# screenshot, install a skill. It only reaches the agent if the harness has it
# in its config.
#
# On the OpenClaw harness that wiring lives in scripts/gateway-pre-start.sh,
# which reconciles `mcp.servers.clawbox` in ~/.openclaw/openclaw.json. That
# script is an ExecStartPre of clawbox-gateway.service — and on the Hermes SKU
# that unit is stopped, disabled and masked (see setup-hermes-edition.sh §4b).
# So on Hermes nothing registered the MCP at all: `hermes mcp list` answered
# "No MCP servers configured." and the agent had no device tools whatsoever.
# This script is the Hermes counterpart.
#
# It is deliberately NOT a second implementation of the OpenClaw path: that one
# is already correct and owned by gateway-pre-start.sh. A `dual` device runs
# both, each writing its own harness's config.
#
# WHERE IT RUNS FROM
# ------------------
#   1. production-server.js, at every web-server boot. clawbox-setup.service is
#      the one unit that is active on every edition, and a `systemctl restart
#      clawbox-setup` is what both a deploy and an in-app update end with — so
#      this is what makes the registration survive a restart and an update.
#   2. scripts/setup-hermes-edition.sh, so a fresh flash is provisioned before
#      the web server ever starts.
# Both paths are idempotent and cheap; running twice is a no-op.
#
# Runs as the `clawbox` user (NOT root): ~/.hermes/config.yaml is 0600 and owned
# by that user, and a root-written file there would lock Hermes out of its own
# config.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
HOME_DIR="${HOME:-/home/clawbox}"
HERMES_BIN="${HERMES_BIN:-$HOME_DIR/.local/bin/hermes}"
HERMES_CONFIG="${HERMES_CONFIG:-$HOME_DIR/.hermes/config.yaml}"
BUN_BIN="${BUN_BIN:-$HOME_DIR/.bun/bin/bun}"
MCP_ENTRY="$PROJECT_DIR/mcp/clawbox-mcp.ts"
MCP_TOKEN_FILE="$PROJECT_DIR/data/.mcp-token"
EDITION_FILE="${CLAWBOX_EDITION_FILE:-/etc/clawbox/edition.env}"
API_BASE="${CLAWBOX_API_BASE:-http://127.0.0.1:80}"

log() { echo "[register-mcp] $*"; }

# ── 1. Which edition is this? ───────────────────────────────────────────────
# Root-owned lock first, environment second, "openclaw" last — the same order
# and the same reasons as src/lib/edition-source.ts. Reading the file rather
# than trusting the environment is the whole point of the lock: this script's
# caller (production-server.js) inherits an environment that
# clawbox-setup.service builds partly from a user-writable .env.
EDITION=""
if [ -f "$EDITION_FILE" ]; then
  EDITION="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?CLAWBOX_EDITION[[:space:]]*=[[:space:]]*//p' \
    "$EDITION_FILE" 2>/dev/null | tail -n 1 | tr -d '"'\'' ')"
fi
[ -z "$EDITION" ] && EDITION="${CLAWBOX_EDITION:-}"
EDITION="$(printf '%s' "${EDITION:-openclaw}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

case "$EDITION" in
  hermes|dual) ;;
  *)
    # OpenClaw-only device: gateway-pre-start.sh owns the registration.
    exit 0
    ;;
esac

if [ ! -x "$HERMES_BIN" ]; then
  log "Hermes is not installed at $HERMES_BIN — nothing to register."
  exit 0
fi

if [ ! -f "$MCP_ENTRY" ]; then
  log "ERROR: MCP entry point missing: $MCP_ENTRY"
  exit 1
fi

if [ ! -x "$BUN_BIN" ]; then
  log "ERROR: bun not found at $BUN_BIN — the MCP server cannot be launched."
  exit 1
fi

# ── 2. The bearer the MCP authenticates back to /setup-api/* with. ──────────
# Same file, same semantics as src/lib/mcp-token.ts and gateway-pre-start.sh.
# Minted here too so a Hermes box — which has no gateway pre-start hook — is
# never left without one.
if [ ! -s "$MCP_TOKEN_FILE" ] || [ "$(wc -c < "$MCP_TOKEN_FILE" 2>/dev/null || echo 0)" -lt 32 ]; then
  mkdir -p "$(dirname "$MCP_TOKEN_FILE")"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$MCP_TOKEN_FILE"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$MCP_TOKEN_FILE"
  fi
  log "minted $MCP_TOKEN_FILE"
fi
chmod 600 "$MCP_TOKEN_FILE" 2>/dev/null || true

# The entry carries NO secret. mcp/lib/api.ts falls back to reading
# data/.mcp-token itself, so rotating the token is not a config-sync problem and
# ~/.hermes/config.yaml — which several /setup-api/hermes/* routes rewrite —
# never holds a second copy of it.

# ── 3. Reconcile mcp_servers.clawbox in ~/.hermes/config.yaml. ──────────────
# Done in Python/PyYAML for the same reason gateway-pre-start.sh does its
# openclaw.json pass in Python: read-modify-write with an atomic rename, and a
# cheap no-op when the file already says what we want.
#
# NOT via `hermes mcp add`: that command performs live tool discovery and
# rewrites the whole config through Hermes' own save_config(), which is a much
# wider blast radius for a boot-time provisioning step, and it is slow.
export CLAWBOX_MCP_HERMES_CONFIG="$HERMES_CONFIG"
export CLAWBOX_MCP_BUN_BIN="$BUN_BIN"
export CLAWBOX_MCP_ENTRY="$MCP_ENTRY"
export CLAWBOX_MCP_API_BASE="$API_BASE"

python3 - <<'PY'
import os, sys, tempfile

try:
    import yaml
except ImportError:
    print("[register-mcp] ERROR: python3 PyYAML is unavailable; cannot write the Hermes config.",
          file=sys.stderr)
    sys.exit(1)

cfg_path = os.environ["CLAWBOX_MCP_HERMES_CONFIG"]

desired = {
    # Must be a real executable, never a shell. Hermes' mcp_security.py rejects
    # a shell interpreter with an inline script both when the entry is saved and
    # again when the server is spawned.
    "command": os.environ["CLAWBOX_MCP_BUN_BIN"],
    "args": ["run", os.environ["CLAWBOX_MCP_ENTRY"]],
    "env": {"CLAWBOX_API_BASE": os.environ["CLAWBOX_MCP_API_BASE"]},
    "enabled": True,
    # Cold start measured well under a second; 30s is slack for a loaded Jetson.
    "connect_timeout": 30,
    "timeout": 300,
    # The appliance agent runs head-less and one-shot (`hermes chat -q`), so an
    # approval prompt has nobody to answer it and would hang the turn. The
    # containment that does apply is inside the MCP server: it registers only
    # the tools this edition can use, and its write tools are individually
    # guarded.
    "trust": "full",
}

try:
    with open(cfg_path) as f:
        cfg = yaml.safe_load(f) or {}
except FileNotFoundError:
    # Hermes has not been onboarded yet. A config carrying only mcp_servers is
    # valid — Hermes merges its own defaults over it — so register now rather
    # than leave the device tool-less until someone finishes onboarding.
    cfg = {}
except yaml.YAMLError as exc:
    print(f"[register-mcp] ERROR: {cfg_path} is not valid YAML ({type(exc).__name__}); "
          "refusing to overwrite it.", file=sys.stderr)
    sys.exit(1)

if not isinstance(cfg, dict):
    print(f"[register-mcp] ERROR: {cfg_path} does not contain a mapping; refusing to overwrite it.",
          file=sys.stderr)
    sys.exit(1)

servers = cfg.get("mcp_servers")
if not isinstance(servers, dict):
    servers = {}
    cfg["mcp_servers"] = servers

if servers.get("clawbox") == desired:
    print("[register-mcp] Hermes MCP registration already current, skipping write")
    sys.exit(0)

servers["clawbox"] = desired

directory = os.path.dirname(cfg_path) or "."
os.makedirs(directory, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".config.", suffix=".tmp")
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
    os.replace(tmp, cfg_path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
print("[register-mcp] registered the ClawBox MCP server with Hermes")
PY
