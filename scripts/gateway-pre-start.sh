#!/usr/bin/env bash
# Ensure gateway config is valid before OpenClaw gateway starts.
#
# Previous versions of this script invoked `openclaw config set` once per
# key (7 keys × ~10 s CLI startup on Jetson = ~70 s of dead time between
# systemd "starting" and the gateway actually listening on LAN). During
# that window, the desktop's OpenClaw iframe polls gateway endpoints,
# gets refused, and renders a "Reload gateway" prompt. Clicking it
# worked because the delay had elapsed by then — user-hostile but
# functional.
#
# Now we do a single read-modify-write on openclaw.json in Python.
# Values that already match what the gateway expects don't get touched
# (so `meta.lastTouchedAt` doesn't flap on every restart), and the
# whole script completes in < 1 s. This shaves ~70 s off every gateway
# restart — not just first boot, but skill install/uninstall, Telegram
# reconfigure, AI-provider change, Local-only toggle, chat model
# switch, and crash-triggered restart.
set -euo pipefail

OPENCLAW_BIN="/home/clawbox/.npm-global/bin/openclaw"
OPENCLAW_CONFIG="/home/clawbox/.openclaw/openclaw.json"
HOSTNAME_ENV="/home/clawbox/clawbox/data/hostname.env"

if [ ! -x "$OPENCLAW_BIN" ]; then
  exit 0
fi

# Resolve configured mDNS hostname (defaults to "clawbox" if unset/invalid)
CONFIGURED_HOSTNAME="clawbox"
if [ -f "$HOSTNAME_ENV" ]; then
  # Parse HOSTNAME=... without executing the file (avoid arbitrary code execution).
  _h=$(sed -n 's/^[[:space:]]*HOSTNAME[[:space:]]*=[[:space:]]*//p' "$HOSTNAME_ENV" | head -n1)
  _h="${_h%\"}"; _h="${_h#\"}"
  _h="${_h%\'}"; _h="${_h#\'}"
  if [[ "$_h" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
    CONFIGURED_HOSTNAME="$_h"
  fi
fi

# Build the dynamic part of the allowedOrigins list — one entry per IPv4
# currently assigned to a real network interface on this host so any
# client hitting us via the device's LAN IP (http://192.168.x.y,
# http://10.0.x.y, etc.) is accepted. Without this, Windows clients
# hitting the IP directly — because `clawbox.local` resolution is still
# warming up — get an "origin not allowed" gateway rejection, the
# Control UI silently falls back to the secondary (cloud) model, and
# local chat with Gemma quietly stops working.
LAN_IPS=()
if command -v ip >/dev/null 2>&1; then
  while read -r ip4; do
    case "$ip4" in
      127.*|169.254.*|"") continue ;;
    esac
    LAN_IPS+=("http://${ip4}")
  done < <(ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
fi

# One Python pass: read → update only the fields that differ → atomic
# rename. Skips every `openclaw config set` call if the file on disk
# already matches the target state. The CLI calls below (gateway
# restart + MCP server) are guarded by their own idempotency checks.
export CLAWBOX_HOSTNAME="$CONFIGURED_HOSTNAME"
# Serialize the LAN_IPS bash array into an env var Python can parse —
# newline-separated is bash-safe (IPv4s contain no newlines).
if [ ${#LAN_IPS[@]} -gt 0 ]; then
  printf -v CLAWBOX_LAN_IPS '%s\n' "${LAN_IPS[@]}"
else
  CLAWBOX_LAN_IPS=""
fi
export CLAWBOX_LAN_IPS

python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, sys, tempfile

cfg_path = sys.argv[1]
hostname = os.environ.get("CLAWBOX_HOSTNAME", "clawbox")
lan_ips = [line for line in os.environ.get("CLAWBOX_LAN_IPS", "").split("\n") if line]

allowed_origins = [
    f"http://{hostname}.local",
    "http://localhost",
    "http://127.0.0.1",
    "http://10.42.0.1",
    "http://10.43.0.1",
    *lan_ips,
]

try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except json.JSONDecodeError:
    # Corrupt file — start from an empty object and let the gateway
    # re-seed on first write; the alternative is refusing to boot.
    cfg = {}

changed = False

# Strip invalid agent keys that prevent gateway from starting.
agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})
for k in ("tools", "systemPromptSuffix"):
    if k in agents_defaults:
        del agents_defaults[k]
        changed = True

gateway = cfg.setdefault("gateway", {})
control_ui = gateway.setdefault("controlUi", {})
auth = gateway.setdefault("auth", {})

def set_if(obj, key, value):
    global changed
    if obj.get(key) != value:
        obj[key] = value
        changed = True

set_if(control_ui, "allowInsecureAuth", True)
set_if(control_ui, "dangerouslyDisableDeviceAuth", True)
# Compare allowedOrigins as sets since ordering shouldn't force a
# rewrite — the gateway doesn't care about the order, and the LAN IP
# enumeration can reorder entries between boots.
if set(control_ui.get("allowedOrigins", []) or []) != set(allowed_origins):
    control_ui["allowedOrigins"] = allowed_origins
    changed = True

# Normalize bind to "lan" if missing or set to something the gateway
# would reject (e.g. an invalid value the user hand-edited in).
valid_binds = ("auto", "lan", "loopback", "custom", "tailnet")
if gateway.get("bind") not in valid_binds:
    gateway["bind"] = "lan"
    changed = True

set_if(gateway, "mode", "local")
set_if(auth, "mode", "token")
set_if(auth, "token", "clawbox")

if changed:
    # Atomic write so a crash mid-rewrite can't leave a half-written
    # file where the gateway would refuse to boot.
    tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(cfg_path), prefix=".openclaw.", suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp_path, cfg_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise
    print("  Updated gateway config")
else:
    print("  Gateway config already correct, skipping write")
PY

# Register ClawBox MCP server (only if not already set). Kept as a CLI
# call because MCP config has richer schema validation in the CLI path
# and we only hit this branch on fresh installs / factory resets.
if ! python3 -c "import json; c=json.load(open('$OPENCLAW_CONFIG')); assert c.get('mcp',{}).get('servers',{}).get('clawbox',{}).get('command')" 2>/dev/null; then
  "$OPENCLAW_BIN" config set mcp.servers.clawbox '{"command":"/home/clawbox/.bun/bin/bun","args":["run","/home/clawbox/clawbox/mcp/clawbox-mcp.ts"],"env":{"CLAWBOX_API_BASE":"http://127.0.0.1:80"}}' --json 2>/dev/null || true
fi

# Seed CLAWBOX.md in the OpenClaw workspace so the agent's session-start
# context includes ClawBox-specific guidance (where user-installed skills
# actually live, how to control the desktop Chromium via the browser_*
# MCP tools, how to install/uninstall skills through the App Store
# instead of manipulating the filesystem directly). Without this, the
# base OpenClaw agent defaults don't know any of those conventions and
# falls back to guessing paths — which has misled it before (e.g.
# checking .npm-global/.../openclaw/skills for user skills and finding
# "nothing", even though the skill is installed at
# ~/.openclaw/workspace/skills/).
#
# Idempotent: only writes when the shipped template differs from the
# on-disk copy, so a later edit from the agent / user doesn't get
# clobbered on every gateway restart.
CLAWBOX_WORKSPACE="/home/clawbox/.openclaw/workspace"
CLAWBOX_GUIDE_SRC="/home/clawbox/clawbox/config/clawbox-workspace-guide.md"
CLAWBOX_GUIDE_DST="$CLAWBOX_WORKSPACE/CLAWBOX.md"
if [ -d "$CLAWBOX_WORKSPACE" ] && [ -f "$CLAWBOX_GUIDE_SRC" ]; then
  if [ ! -f "$CLAWBOX_GUIDE_DST" ] || ! cmp -s "$CLAWBOX_GUIDE_SRC" "$CLAWBOX_GUIDE_DST"; then
    install -m 644 "$CLAWBOX_GUIDE_SRC" "$CLAWBOX_GUIDE_DST"
    echo "  Seeded CLAWBOX.md in OpenClaw workspace"
  fi

  # Append a one-liner reference to AGENTS.md if it exists and doesn't
  # already mention CLAWBOX.md, so the agent loads our guide as part of
  # its session-start context without us having to overwrite AGENTS.md
  # (which the agent may have personalized).
  CLAWBOX_AGENTS_MD="$CLAWBOX_WORKSPACE/AGENTS.md"
  if [ -f "$CLAWBOX_AGENTS_MD" ] && ! grep -qF "CLAWBOX.md" "$CLAWBOX_AGENTS_MD"; then
    printf '\n\n## ClawBox integration\n\nSee `CLAWBOX.md` for device-specific conventions: where user-installed skills live, how to control the desktop Chromium via `browser_*` tools, and how to install/uninstall skills through the App Store.\n' >> "$CLAWBOX_AGENTS_MD"
    echo "  Appended CLAWBOX.md reference to AGENTS.md"
  fi
fi
