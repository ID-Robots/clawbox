#!/usr/bin/env bash
# Ensure gateway config is valid before OpenClaw gateway starts.
set -euo pipefail

OPENCLAW_BIN="/home/clawbox/.npm-global/bin/openclaw"
OPENCLAW_CONFIG="/home/clawbox/.openclaw/openclaw.json"

if [ ! -x "$OPENCLAW_BIN" ]; then
  exit 0
fi

# Fix invalid config keys that prevent gateway from starting
if [ -f "$OPENCLAW_CONFIG" ]; then
  python3 -c "
import json, sys
with open('$OPENCLAW_CONFIG') as f:
    c = json.load(f)
changed = False
d = c.get('agents',{}).get('defaults',{})
for k in ['tools','systemPromptSuffix']:
    if k in d:
        del d[k]
        changed = True
g = c.get('gateway',{})
if g.get('bind') not in (None,'auto','lan','loopback','custom','tailnet'):
    g['bind'] = 'lan'
    changed = True
if changed:
    with open('$OPENCLAW_CONFIG','w') as f:
        json.dump(c, f, indent=2)
    print('  Fixed invalid OpenClaw config keys')
" 2>/dev/null || true
fi

"$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.controlUi.dangerouslyDisableDeviceAuth true --json 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.controlUi.allowedOrigins '["http://clawbox.local","http://localhost","http://127.0.0.1","http://10.42.0.1"]' --json 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.bind lan 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.auth.mode token 2>/dev/null || true
"$OPENCLAW_BIN" config set gateway.auth.token clawbox 2>/dev/null || true
