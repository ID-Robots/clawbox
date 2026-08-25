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
# Shared with setup-hermes-dashboard-auth.sh: BOTH scripts read-modify-write
# ~/.hermes/config.yaml, and at install time they run seconds apart
# (production-server.js fire-and-forgets this script on the clawbox-setup
# restart in step_start_services; setup-hermes-edition.sh runs the auth script
# right after). Without a shared lock, whichever one snapshotted the file first
# and wrote last silently erased the other's block — the auth script's dashboard
# block vanished and its verify failed, blaming credentials that were correct.
# Same path derivation on both sides (HERMES_CONFIG + ".lock") so they collide.
CONFIG_LOCK="${HERMES_CONFIG}.lock"

log() { echo "[register-mcp] $*"; }

# Take the exclusive config lock for the rest of the run (fd 9, released on
# exit). Covers BOTH the PyYAML reconcile below AND the `hermes tools disable`
# call — the Hermes CLI does its own wide load→save_config on the same file, so
# it has to be inside the same critical section. Best-effort: proceed without
# the lock rather than skip registering the device's tools if flock is missing.
acquire_config_lock() {
  command -v flock >/dev/null 2>&1 || {
    log "flock unavailable — proceeding without the config lock"
    return 0
  }
  mkdir -p "$(dirname "$CONFIG_LOCK")" 2>/dev/null || true
  # Probe writability in a scoped subshell before opening fd 9; keep the `exec`
  # redirect CLEAN (a `2>/dev/null` on it would silence the whole script,
  # because redirections on exec are permanent).
  if ! ( : > "$CONFIG_LOCK" ) 2>/dev/null; then
    log "could not create $CONFIG_LOCK — proceeding without the config lock"
    return 0
  fi
  exec 9>"$CONFIG_LOCK"
  flock -w 120 9 || log "could not acquire $CONFIG_LOCK within 120s — proceeding without it"
}

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
#
# Everything from here to the end of the script touches config.yaml, so take the
# shared lock now and hold it until exit.
acquire_config_lock

export CLAWBOX_MCP_HERMES_CONFIG="$HERMES_CONFIG"
export CLAWBOX_MCP_BUN_BIN="$BUN_BIN"
export CLAWBOX_MCP_ENTRY="$MCP_ENTRY"
export CLAWBOX_MCP_API_BASE="$API_BASE"

python3 - <<'PY'
import ast, os, sys, tempfile

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

changed = False
if servers.get("clawbox") != desired:
    servers["clawbox"] = desired
    changed = True

# ── Retire the bundled email-skill distractors. ─────────────────────────────
# Hermes seeds a bundled skills library into ~/.hermes/skills, and its `email`
# category (the `himalaya` CLI skill plus `email-inbox-triage`, which routes to
# it) teaches the agent to drive a mailbox from the terminal. On a ClawBox that
# is the wrong tool in exactly the way the built-in browser toolset was (§4):
# the himalaya CLI is not configured on this image, and the device's actual
# email capability is the ClawBox MCP tools — email_send / email_list /
# email_read — wired to the account the owner connected in Settings (#424).
#
# Observed on a live Hermes device: "Can you read my last 5 emails?" went
# skill_view(himalaya) → two failing himalaya terminal calls → a clarify
# question no dashboard turn can deliver an answer to → a wedged turn — with
# email_list registered and working in the very same tool list. The skills
# index entry ("sending, receiving, searching, and managing email") outbids the
# MCP tool descriptions for any mailbox request, so the trap re-arms on every
# reseed.
#
# `skills.disabled` in config.yaml IS the supported surface here, unlike §4's
# toolsets: agent/skill_utils.py get_disabled_skill_names() reads this exact
# key (globally, unioned with skills.platform_disabled per platform), there is
# no `hermes skills disable` CLI to prefer, and a disabled skill drops out of
# the prompt's skills index and skills_list. Global rather than per-platform,
# because himalaya is unprovisioned for every platform of this device.
#
# APPEND, never overwrite: an owner's own disabled entries survive, and hermes'
# own JSON-string list form ('["a","b"]', how `hermes config set` stores lists)
# is parsed the same way skill_utils.parse_config_string_list does. A `skills`
# key that is not a mapping is left alone — repairing it is not this script's
# call — and the MCP registration above must still land.
# google-workspace joined the list after the second live incident: with
# himalaya hidden, the index still advertised "Gmail, Calendar, Drive ... via
# gws CLI", and the same mailbox question went skill_view(google-workspace) ->
# its setup.py -> a clarify question nothing could answer. Same shape of trap:
# a connector CLI that is not provisioned on this image, outbidding the
# device's own email tools.
DISTRACTOR_SKILLS = ["himalaya", "email-inbox-triage", "google-workspace"]
skills_cfg = cfg.get("skills")
if skills_cfg is None:
    skills_cfg = {}
    cfg["skills"] = skills_cfg
if isinstance(skills_cfg, dict):
    raw_disabled = skills_cfg.get("disabled")
    if isinstance(raw_disabled, str):
        parsed = None
        stripped = raw_disabled.strip()
        if stripped.startswith("["):
            try:
                parsed = ast.literal_eval(stripped)
            except (ValueError, SyntaxError):
                parsed = None
        if isinstance(parsed, list):
            names = [str(item) for item in parsed]
        else:
            names = [raw_disabled] if raw_disabled else []
    elif isinstance(raw_disabled, (list, tuple)):
        names = [str(item) for item in raw_disabled]
    else:
        names = []
    missing = [name for name in DISTRACTOR_SKILLS if name not in names]
    if missing:
        skills_cfg["disabled"] = names + missing
        changed = True
        print("[register-mcp] disabled bundled email skills: " + ", ".join(missing)
              + " — mailbox requests go through the ClawBox email_* tools")
else:
    print("[register-mcp] WARNING: skills is not a mapping; "
          "leaving the bundled email skills enabled.", file=sys.stderr)

# ── Retire the clarify tool where nobody can answer it. ───────────────────────
# hermes' clarify tool parks the turn until a human answers the question — on
# this device that answer can never arrive on the dashboard transport, so a
# clarify call is a guaranteed hang (observed live: two turns pinned for the
# tool's full 3600 s timeout). Without the tool the model asks its question as
# PLAIN TEXT in the reply and ends the turn, which streams fine and the owner
# answers in the next message.
#
# platform_toolsets.<platform> is the supported per-platform surface
# (hermes_cli/tools_config.py _get_platform_tools): an explicit list of
# configurable toolset keys enables exactly those built-ins for that platform.
# Verified on-device that the list below resolves to the platform's current
# toolsets minus clarify — browser stays retired (§4), and MCP servers are
# merged separately, so the ClawBox device tools are untouched.
#
# The dashboard platform gets an explicit list; an owner who later edits it is
# respected as long as clarify stays out. The web app's non-streaming fallback
# runs on platform "cli": there only an EXISTING explicit list is edited —
# without one the platform default applies, and the interactive terminal,
# where a human really can answer a prompt, keeps its clarify.
CHAT_PLATFORM = "clawbox-chat"
CHAT_TOOLSETS = [
    "web", "terminal", "file", "code_execution", "vision", "image_gen",
    "bfl", "tts", "skills", "todo", "memory", "session_search",
    "delegation", "cronjob", "computer_use",
]
pts = cfg.get("platform_toolsets")
if pts is None:
    pts = {}
    cfg["platform_toolsets"] = pts
if isinstance(pts, dict):
    chat = pts.get(CHAT_PLATFORM)
    if not isinstance(chat, list):
        pts[CHAT_PLATFORM] = list(CHAT_TOOLSETS)
        changed = True
        print(f"[register-mcp] set {CHAT_PLATFORM} toolsets without clarify — "
              "dashboard turns cannot answer interactive prompts")
    elif "clarify" in chat:
        pts[CHAT_PLATFORM] = [ts for ts in chat if str(ts) != "clarify"]
        changed = True
        print(f"[register-mcp] removed clarify from {CHAT_PLATFORM} toolsets")
    cli_ts = pts.get("cli")
    if isinstance(cli_ts, list) and "clarify" in cli_ts:
        pts["cli"] = [ts for ts in cli_ts if str(ts) != "clarify"]
        changed = True
        print("[register-mcp] removed clarify from the explicit cli toolset list")
else:
    print("[register-mcp] WARNING: platform_toolsets is not a mapping; "
          "leaving clarify as it is.", file=sys.stderr)

if not changed:
    print("[register-mcp] Hermes MCP registration already current, skipping write")
    sys.exit(0)

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

# ── 4. Retire the harness's own browser toolset. ────────────────────────────
# Hermes ships a built-in `browser` toolset, and on a ClawBox it is the wrong
# tool twice over:
#
#   1. It drives its OWN browser, not the Chromium on the device's desktop. The
#      customer asks the agent to open a page, watches the screen, and nothing
#      happens there — the page opened somewhere they cannot see. Our
#      browser_open/browser_navigate drive the real window.
#   2. Its engine (agent-browser) is not provisioned on this image, so an agent
#      that reaches for it spends minutes on timeouts and "install --with-deps"
#      advice before giving up. Observed on a Hermes device: 145-182s per turn,
#      ending in failure, with the working MCP tools sitting right next to it.
#
# Point 1 is why we do not simply install the engine: that would convert a
# visible failure into a silent one, which is worse.
#
# VERIFIED on-device that this is precise rather than blunt: after
# `hermes tools disable browser`, `hermes tools list` reports the built-in
# toolset disabled while the clawbox MCP server still reports "all tools
# enabled", and browser_open/navigate/screenshot/close are still registered.
# Deliberately NOT written as a config key: `hermes tools disable` is the
# supported surface, and the state does NOT live under agent.disabled_toolsets
# (that key still reads [] afterwards), so hand-writing config would be a guess.
#
# Reconciled on every boot, exactly like the MCP registration above, rather
# than once behind a marker file.
#
# A marker was the first shape of this and it was wrong: the marker would live
# in ClawBox's data/ while the state it stands for lives in Hermes' own store,
# so the two can drift. Anything that resets ~/.hermes without wiping data/ —
# reinstalling the agent on an existing device — would leave the marker set and
# the toolset re-enabled PERMANENTLY, reproducing the 145-182s dead turns with
# no way for the owner to notice or fix it. Converging every boot cannot get
# stuck that way.
#
# It costs one CLI invocation per boot, and `production-server.js` runs this
# script fire-and-forget, so it never delays the web server coming up. Nothing
# in the product re-enables a toolset (no UI, no MCP tool, no script), so this
# is not overriding a choice anyone can currently express; if that changes, the
# intent belongs in a ClawBox preference this step can read, not in the absence
# of a file.
#
# Never fatal: a device with its device tools registered but this step failed is
# strictly better than a boot that aborted here.
if "$HERMES_BIN" tools disable browser >/dev/null 2>&1; then
  log "built-in browser toolset off; browsing goes through the ClawBox browser_* tools"
else
  log "could not disable the built-in browser toolset — continuing"
fi
