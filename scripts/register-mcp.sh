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
# `{ ...; } 2>/dev/null` rather than `wc ... 2>/dev/null`: a failed INPUT
# redirect is reported by the shell, not by wc, so the narrower form prints a
# bare "Permission denied" for a token this uid cannot read. Same correction as
# gateway-pre-start.sh's copy of this line.
if [ ! -s "$MCP_TOKEN_FILE" ] || [ "$( { wc -c < "$MCP_TOKEN_FILE"; } 2>/dev/null || echo 0 )" -lt 32 ]; then
  # Guarded like its sibling in gateway-pre-start.sh: in plain command position a
  # `data/` that cannot be CREATED (a read-only $PROJECT_DIR, ENOSPC) exits
  # non-zero and `set -e` kills the run before the reconcile — which is the same
  # "no device tools at all on the hermes SKU" outcome the mint guard below
  # exists to prevent, one line earlier. TASK-657.
  mkdir -p "$(dirname "$MCP_TOKEN_FILE")" 2>/dev/null || true
  # `umask 077` in the subshell, not a chmod afterwards: a bare redirect creates
  # the file at the umask's mode — 0644 under root's — and the chmod below only
  # closes that window AFTER the secret is already on disk and world-readable.
  # It also cannot close it at all when the chmod fails (a file this uid does
  # not own), which is the state gateway-pre-start.sh's `mcp_write_token` was
  # written for. TASK-657.
  # Guarded, because REGISTERING the MCP server is this script's job and minting
  # the bearer is a convenience it does on the way past. In plain command
  # position a failed redirect (a root-owned token, a read-only data/) exits the
  # subshell 1 and `set -e` kills the run — and on the hermes SKU nothing else
  # writes mcp_servers.clawbox, so `hermes mcp list` stays "No MCP servers
  # configured" and the agent has NO device tools at all, on every web-server
  # boot. The token is not lost by carrying on: production-server.js seeds the
  # same file at every clawbox-setup boot, and mcp/lib/api.ts reads it directly.
  # TASK-657.
  if command -v openssl >/dev/null 2>&1; then
    ( umask 077; openssl rand -hex 32 > "$MCP_TOKEN_FILE" ) 2>/dev/null || MCP_TOKEN_MINTED=no
  else
    ( umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$MCP_TOKEN_FILE" ) 2>/dev/null || MCP_TOKEN_MINTED=no
  fi
  if [ "${MCP_TOKEN_MINTED:-yes}" = no ]; then
    # State what is true, not a repair that cannot happen. production-server.js
    # seeds the same path as the same uid, so every state that fails this mint
    # fails that one too, and on the hermes SKU clawbox-gateway.service is masked
    # so gateway-pre-start.sh's replacement never runs either. The registration
    # is still worth writing — it is what puts the tools in `hermes mcp list` —
    # but they will 401 until the directory is writable.
    log "WARN: could not write $MCP_TOKEN_FILE — registering the MCP server anyway, but it has no bearer: /setup-api/* tool calls will answer 401 until $(dirname "$MCP_TOKEN_FILE") is writable"
  else
    log "minted $MCP_TOKEN_FILE"
  fi
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
except OSError as err:
    # The file is THERE and cannot be read (permissions, a truncated mount).
    # Deliberately NOT the `cfg = {}` above: that arm's premise is "no config
    # exists yet", and taking it here would write a file holding only
    # mcp_servers over a config whose contents we never saw. Same verdict as
    # invalid YAML below — refuse, and say why, instead of the traceback this
    # top-level `python3` under `set -euo pipefail` produced. TASK-657.
    # The full path, matching the YAML arm two lines down rather than the
    # basename: there is no secret in a config path and the operator has to know
    # WHICH file to fix.
    print(f"[register-mcp] ERROR: {cfg_path} could not be read "
          f"({err.strerror or type(err).__name__}); refusing to overwrite it.", file=sys.stderr)
    sys.exit(1)
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
    elif raw_disabled is None:
        names = []
    else:
        # A mapping, a bool, a number: a shape this script does not understand,
        # left alone for the same reason a non-mapping `skills` key is. Reading
        # it as "nothing is disabled" and writing the distractors over it would
        # discard whatever the owner meant by it, and the MCP registration
        # above still has to land.
        names = None
        print("[register-mcp] WARNING: skills.disabled is not a list or a string; "
              "leaving the bundled email skills enabled.", file=sys.stderr)
    missing = [] if names is None else [n for n in DISTRACTOR_SKILLS if n not in names]
    if missing:
        skills_cfg["disabled"] = names + missing
        changed = True
        print("[register-mcp] disabled bundled email skills: " + ", ".join(missing)
              + " — mailbox requests go through the ClawBox email_* tools")
else:
    print("[register-mcp] WARNING: skills is not a mapping; "
          "leaving the bundled email skills enabled.", file=sys.stderr)

# ── The clarify window this appliance ships with. ──────────────────────────
# When the agent stops to ask the customer a question it parks its own worker
# thread on `Event.wait(...)` (tui_gateway/server.py:3513) for the number of
# seconds hermes resolves from config. Verified read-only on the Hermes box
# (hermes-agent 0.20.5): tools/clarify_gateway.py:531 `resolve_clarify_timeout`
# takes the legacy `clarify.timeout` first, then `agent.clarify_timeout`, then
# 3600; it is coerced with `int()` (:549), and <= 0 is passed through as
# unlimited — `ev.wait(None)`, which is Python's word for FOREVER. The key is
# hermes' own, shipped in its defaults table under the `agent:` block
# (hermes_cli/config_defaults.py:278), and is ABSENT from a ClawBox config.yaml,
# so a box runs on the 3600 default today.
#
# On an appliance that hour is a session nobody can use for anything else
# because one question went unanswered — a message typed meanwhile is QUEUED
# behind the parked worker (server.py:8233 `_handle_busy_submit`) and nothing
# there releases the Event. Five minutes is the window a person actually
# answers a chat question inside, and it is hermes' own emergency fallback for
# this same number (server.py:3578).
#
# A BACKSTOP, not the fix: a message arriving on a parked session is now
# delivered as the ANSWER (src/lib/hermes-dashboard-turn.ts), so this only
# decides how long a session that hears nothing at all stays parked.
#
# SEEDED, NOT PINNED: written only when the owner has set neither key, so a
# window they chose — under either name — is left exactly as it is. Written
# here, with the rest of this device's rendered Hermes config, because `hermes
# config set` stores a scalar as a STRING ("storing as string" on stderr) and
# this is a number; the same reason the MCP entry above is written in PyYAML.
CLARIFY_TIMEOUT_SECONDS = 300
legacy_clarify = cfg.get("clarify")
legacy_timeout_set = isinstance(legacy_clarify, dict) and legacy_clarify.get("timeout") is not None
agent_cfg = cfg.get("agent")
if agent_cfg is None and not legacy_timeout_set:
    agent_cfg = {}
    cfg["agent"] = agent_cfg
if legacy_timeout_set:
    # The legacy key WINS in hermes' own resolver, so writing ours beside it
    # would leave the file saying 300 while the box waits the owner's window.
    print("[register-mcp] clarify.timeout is set; leaving the clarify window to it")
elif isinstance(agent_cfg, dict):
    if "clarify_timeout" not in agent_cfg:
        agent_cfg["clarify_timeout"] = CLARIFY_TIMEOUT_SECONDS
        changed = True
        print(f"[register-mcp] agent.clarify_timeout set to {CLARIFY_TIMEOUT_SECONDS}s "
              "— an unanswered question parks the session for that long, not an hour")
else:
    # A shape this script does not understand, left alone for the same reason a
    # non-mapping `skills` key is: repairing it is not this script's call, and
    # the MCP registration above must still land.
    print("[register-mcp] WARNING: agent is not a mapping; "
          "leaving the clarify timeout at hermes' own default.", file=sys.stderr)

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
