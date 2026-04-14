#!/usr/bin/env bash
# Ensure gateway config is valid before OpenClaw starts.
set -euo pipefail

CLAWBOX_HOME="${CLAWBOX_HOME:-${HOME:-/home/clawbox}}"
if [ "$CLAWBOX_HOME" = "/root" ]; then
  CLAWBOX_HOME="/home/clawbox"
fi
CLAWBOX_ROOT="${CLAWBOX_ROOT:-$CLAWBOX_HOME/clawbox}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$CLAWBOX_HOME/.openclaw}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$CLAWBOX_HOME/.npm-global/bin/openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$OPENCLAW_HOME/openclaw.json}"
HOSTNAME_ENV="${HOSTNAME_ENV:-$CLAWBOX_ROOT/data/hostname.env}"
BUN_BIN="${BUN_BIN:-$CLAWBOX_HOME/.bun/bin/bun}"
GATEWAY_BIND="${CLAWBOX_GATEWAY_BIND:-lan}"

if [ ! -x "$OPENCLAW_BIN" ]; then
  exit 0
fi

CONFIGURED_HOSTNAME="clawbox"
if [ -f "$HOSTNAME_ENV" ]; then
  _h=$(sed -n 's/^[[:space:]]*HOSTNAME[[:space:]]*=[[:space:]]*//p' "$HOSTNAME_ENV" | head -n1)
  _h="${_h%\"}"; _h="${_h#\"}"
  _h="${_h%\'}"; _h="${_h#\'}"
  if [[ "$_h" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
    CONFIGURED_HOSTNAME="$_h"
  fi
fi

if [ -f "$OPENCLAW_CONFIG" ]; then
  python3 -c "
import json
with open('$OPENCLAW_CONFIG') as f:
    c = json.load(f)
changed = False
d = c.get('agents', {}).get('defaults', {})
for k in ['tools', 'systemPromptSuffix']:
    if k in d:
        del d[k]
        changed = True
g = c.get('gateway', {})
if g.get('bind') not in (None, 'auto', 'lan', 'loopback', 'custom', 'tailnet'):
    g['bind'] = 'lan'
    changed = True
if changed:
    with open('$OPENCLAW_CONFIG', 'w') as f:
        json.dump(c, f, indent=2)
    print('  Fixed invalid OpenClaw config keys')
" 2>/dev/null || true
fi

"$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.controlUi.dangerouslyDisableDeviceAuth true --json 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.controlUi.allowedOrigins "[\"http://${CONFIGURED_HOSTNAME}.local\",\"http://clawbox.local\",\"http://localhost\",\"http://127.0.0.1\"]" --json 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.bind "$GATEWAY_BIND" 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.mode local 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.auth.mode token 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.auth.token clawbox 2>/dev/null || true

if ! python3 -c "import json; c=json.load(open('$OPENCLAW_CONFIG')); assert c.get('mcp',{}).get('servers',{}).get('clawbox',{}).get('command')" 2>/dev/null; then
  python3 - "$OPENCLAW_BIN" "$BUN_BIN" "$CLAWBOX_ROOT" <<'PY'
import json
import subprocess
import sys

openclaw_bin, bun_bin, clawbox_root = sys.argv[1:]
payload = json.dumps({
    "command": bun_bin,
    "args": ["run", f"{clawbox_root}/mcp/clawbox-mcp.ts"],
    "env": {
        "CLAWBOX_API_BASE": "http://127.0.0.1:80",
        "CLAWBOX_ROOT": clawbox_root,
    },
})
subprocess.run(
    [openclaw_bin, "config", "set", "mcp.servers.clawbox", payload, "--json"],
    check=False,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
PY
fi
