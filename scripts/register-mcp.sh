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
# The ceiling on every `hermes` call this script makes. `production-server.js`
# launches this script, so an unbounded CLI is a helper and its child left
# running for as long as the box is up. 45 s is the budget the OpenClaw twin
# gives its own `plugins inspect` (gateway-pre-start.sh) — well past a loaded
# Jetson's CLI start, well short of forever.
#
# Overridable like every other tunable here, and for one reason: a test can turn
# it down and prove the ceiling actually FIRES, which asserting the command line
# does not. Both call sites also pass `-k 5`, because plain `timeout` only sends
# SIGTERM: a `hermes` that ignores it keeps running after `timeout` has returned
# 124, and both calls are inside the `acquire_config_lock` critical section, so
# a survivor inherits fd 9 and holds ~/.hermes/config.yaml.lock after this
# script exits — leaving setup-hermes-dashboard-auth.sh to burn its 120 s wait
# and then write unlocked, which is the config-clobber that lock exists to stop.
HERMES_CLI_TIMEOUT="${HERMES_CLI_TIMEOUT:-45}"
# `${:-}` substitutes on unset and empty but NOT on "0" — and `timeout 0` means
# NO timeout, so a bare `HERMES_CLI_TIMEOUT=0` would silently undo the bound
# this variable exists to impose. A non-numeric value is worse: `timeout` exits
# 125 without running the CLI at all, which at the `tools disable` call below is
# a permanent "could not disable the built-in browser toolset" with the toolset
# left ON — a false failure with a functional regression behind it. This value
# arrives in an environment clawbox-setup.service builds partly from a
# user-writable .env (the same reason EDITION is read from a root-owned file
# below), so validate it rather than trust it.
# The glob rejects a value that is not a run of digits; the arithmetic test then
# rejects the ones that ARE — "0", but also "00" and "000", which no `|0)` glob
# catches and which `timeout` reads as zero just the same. `[` fails rather than
# compares on a value too large for an integer, and a 22-digit ceiling is no
# ceiling either, so that path coerces too.
case "$HERMES_CLI_TIMEOUT" in
  ''|*[!0-9]*) HERMES_CLI_TIMEOUT=45 ;;
esac
[ "$HERMES_CLI_TIMEOUT" -gt 0 ] 2>/dev/null || HERMES_CLI_TIMEOUT=45
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

# ── 2b. Install the outbound EMAIL:-directive hook plugin. ──────────────────
# `EMAIL:4471` is how the agent tells a ClawBox CHAT that its reply points at a
# message the owner can open; the chat lifts the line out and shows a card. A
# channel has no cards, so there the line is an internal id printed at the owner
# (TASK-679). PR #605 stopped the tools ASKING for it on a channel — a sentence
# a model can misread — and this is the guarantee behind the sentence: Hermes'
# own `transform_llm_output` hook, which fires once per turn before delivery and
# before speech, takes the line out whatever the model wrote.
#
# HERE, not in the ClawBox-AI link path where the image backend is installed
# (src/lib/hermes-image-plugin.ts). That one is a paid capability and only a
# linked box needs it; this one has to be on EVERY Hermes box, and a factory
# reset wipes ~/.hermes bar `hermes-agent` and `bin` (setup/reset/route.ts).
# This script runs from production-server.js at every web-server boot, so a
# reset box re-provisions itself without anyone asking.
#
# Copied rather than symlinked, and overwritten unconditionally: the files are
# OURS, versioned with the app, and an update that ships a fixed plugin must
# actually deliver it. The stale `__pycache__` goes with them, because Python
# will happily import a `.pyc` whose source no longer exists.
EMAIL_HOOK_PLUGIN="clawbox_email_directives"
# The one hook this plugin registers, and — since the manifest now DECLARES it —
# the name `hermes plugins doctor` compares against what register() actually
# added. That comparison is the Hermes equivalent of the OpenClaw twin's
# `"reply_payload_sending" in names` check (gateway-pre-start.sh), and it is why
# the verdict below is a name test rather than a count.
EMAIL_HOOK_NAME="transform_llm_output"
# The inbound twin: Hermes' own pre_gateway_dispatch, which is how the owner's
# "send <code>" reply to a queued email reaches ClawBox with no second Telegram
# bot (scripts/hermes-plugins/clawbox_email_directives/approvals.py). Declared
# in plugin.yaml beside the outbound one, so the doctor compares BOTH by name.
EMAIL_HOOK_INBOUND_NAME="pre_gateway_dispatch"
EMAIL_HOOK_SRC="$PROJECT_DIR/scripts/hermes-plugins/$EMAIL_HOOK_PLUGIN"
# `HERMES_HOME` first, exactly like Hermes' own `get_hermes_home()` and like
# `hermesHome()` in src/lib/hermes-env.ts — NOT `dirname $HERMES_CONFIG`. With
# HERMES_HOME set and HERMES_CONFIG left at its default the two disagree, the
# copy lands where Hermes will never look, and the box logs a "did not register
# its hook" warning on every boot with the plugin sitting right there.
HERMES_PLUGINS_DIR="${HERMES_PLUGINS_DIR:-${HERMES_HOME:-$HOME_DIR/.hermes}/plugins}"
EMAIL_HOOK_DST="$HERMES_PLUGINS_DIR/$EMAIL_HOOK_PLUGIN"
EMAIL_HOOK_INSTALLED=0

if [ -f "$EMAIL_HOOK_SRC/__init__.py" ] && [ -f "$EMAIL_HOOK_SRC/plugin.yaml" ] \
  && [ -f "$EMAIL_HOOK_SRC/email_directives.py" ] && [ -f "$EMAIL_HOOK_SRC/approvals.py" ]; then
  # THE SOURCES ARE READ BEFORE ANYTHING ON DISK IS TOUCHED, exactly as the
  # OpenClaw twin does it (gateway-pre-start.sh). `cp` opens its source first
  # and leaves the destination alone when that open fails, so a source-side
  # problem — a checkout still being written by the updater, a permission slip —
  # must NOT be treated the same as a copy that died half-way. Answering that
  # question here is what lets the failure branch below know which state the box
  # is in.
  if ! cat "$EMAIL_HOOK_SRC/__init__.py" "$EMAIL_HOOK_SRC/plugin.yaml" \
           "$EMAIL_HOOK_SRC/email_directives.py" "$EMAIL_HOOK_SRC/approvals.py" >/dev/null 2>&1; then
    # The installed copy, if there is one, is untouched and still the last one
    # that worked. Leaving it alone is strictly better than removing it.
    log "WARNING: could not read the $EMAIL_HOOK_PLUGIN plugin sources in $EMAIL_HOOK_SRC — leaving whatever is already installed in place"
  elif mkdir -p "$EMAIL_HOOK_DST" 2>/dev/null \
    && cp -f "$EMAIL_HOOK_SRC/__init__.py" "$EMAIL_HOOK_SRC/plugin.yaml" \
             "$EMAIL_HOOK_SRC/email_directives.py" "$EMAIL_HOOK_SRC/approvals.py" \
             "$EMAIL_HOOK_DST/" 2>/dev/null; then
    rm -rf "$EMAIL_HOOK_DST/__pycache__" 2>/dev/null || true
    EMAIL_HOOK_INSTALLED=1
  else
    # Never fatal. A box with its device tools registered but this plugin not
    # copied still works; it only shows the directive on a channel, which is
    # exactly where it stood before this existed.
    #
    # BUT THE HALF-WRITTEN COPY GOES. The sources read cleanly a moment ago, so
    # a failure here is on the WRITE side — ENOSPC, an I/O error, a target that
    # is not a file any more — and `cp -f` truncates each target before it
    # writes it. What is in the destination now is a mixture of new, truncated
    # and stale files, while `plugins.enabled` can still name the plugin from an
    # earlier boot (the enable below only gates the write of a NEW entry, not
    # the removal of one already there), so Hermes would import it. Removing it
    # leaves ONE state — no plugin, no strip, and a line that says so — instead
    # of a module that may raise half-way through parsing. Where the removal
    # cannot work either — a read-only filesystem, or a destination directory
    # whose mode lets `cp` truncate the files already in it but does not let
    # `rm` unlink them — the removal is REPORTED as not done. Claiming a
    # cleanup that did not happen is the false success this whole step exists
    # to avoid, and it is the difference between "nothing loads" and "Hermes
    # imports a package that is missing a file".
    if rm -rf "$EMAIL_HOOK_DST" 2>/dev/null; then
      log "WARNING: could not install the $EMAIL_HOOK_PLUGIN plugin into $EMAIL_HOOK_DST — anything partial there has been removed rather than left for Hermes to import, so EMAIL: directives will reach channels until the next boot repairs it"
    else
      log "WARNING: could not install the $EMAIL_HOOK_PLUGIN plugin into $EMAIL_HOOK_DST AND could not remove what is there — Hermes may import a partial copy. EMAIL: directives will reach channels; the next boot repairs it only if that path becomes writable"
    fi
  fi
else
  log "WARNING: $EMAIL_HOOK_SRC is not a complete plugin — skipping the EMAIL: directive hook"
fi

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
# Empty unless the plugin's files are on disk, so the enable below can never
# name a plugin that is not there — "enabled in config, nothing loaded" is the
# false success this whole step exists to avoid.
export CLAWBOX_EMAIL_HOOK_PLUGIN=""
[ "$EMAIL_HOOK_INSTALLED" = "1" ] && export CLAWBOX_EMAIL_HOOK_PLUGIN="$EMAIL_HOOK_PLUGIN"
# The ClawAI image backend, for the re-arm below. Its files are written by the
# LINK path (src/lib/hermes-image-plugin.ts), not by this script — this is only
# where they would be if the box has ever been linked.
export CLAWBOX_IMAGE_PLUGIN="clawai"
# The plugin's CANONICAL registry key — its second spelling, and the one
# `hermes plugins disable clawai` writes into `plugins.disabled`
# (`cmd_disable` -> `_resolve_plugin_key`, hermes_cli/plugins_cmd.py:1710-1739
# and :1337-1362, read on the pinned 0.20.5 build). Hermes' own
# `_plugin_status` tests both spellings; so must the re-arm's deny-list check.
# Mirrors HERMES_IMAGE_PLUGIN_KEY in src/lib/hermes-image-plugin.ts.
export CLAWBOX_IMAGE_PLUGIN_KEY="image_gen/clawai"
export CLAWBOX_IMAGE_PLUGIN_ENTRY="$HERMES_PLUGINS_DIR/image_gen/clawai/__init__.py"
# The protected-path table (TASK-605). The same file the OpenClaw hook plugin
# reads; see the block that renders approvals.deny from it below.
export CLAWBOX_PROTECTED_PATHS="$PROJECT_DIR/config/protected-paths.json"

python3 - <<'PY'
import ast, json, os, sys, tempfile

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

# ── The protected-path deny rule (TASK-605). ────────────────────────────────
# On 2026-09-02 a turn asked to "delete the largest of those files" ran rm on a
# 3.2 GB Gemma GGUF, mid-turn, with no confirmation of any kind. The owner's
# ruling of 2026-09-04 is a hard deny on the local-model folder and the ClawBox
# tree and NO prompt anywhere else — "narrower, but silent when it bites".
#
# HERMES' OWN MECHANISM, not ours. `approvals.deny` is a user-defined list of
# fnmatch globs that block a command unconditionally, and a match fires BEFORE
# the --yolo / /yolo / approvals.mode=off bypass — "the user-editable
# counterpart to the code-shipped hardline blocklist". Read on the pinned 0.20.5
# build on the Hermes box: tools/approval.py `_match_user_deny_rule` (:623) and
# `_user_deny_block_result` (:655), applied in `check_dangerous_command` (:3751)
# and `check_all_command_guards` (:4384), which tools/terminal_tool.py (:351) is
# the caller of. The refusal text it hands the agent names the rule and tells it
# not to retry — which is what makes a silent deny something the agent can still
# explain to the owner.
#
# NOT tirith, which the brief offered as the alternative: tirith on 0.20.5 is an
# external binary that scans command CONTENT for homograph URLs, pipe-to-
# interpreter and terminal injection (tools/tirith_security.py), and its config
# surface is four keys — enabled, path, timeout, fail_open. It has no
# user-authored rule file and cannot express a path.
#
# The globs are rendered from config/protected-paths.json, the same table the
# OpenClaw edition's before_tool_call hook reads, and
# src/tests/unit/protected-paths.test.ts runs one case table through both.
#
# ADD-ONLY. Anything already in the list stays: an owner's own deny rule is not
# ours to drop, and neither is a glob left behind by an older version of the
# table. The failure that leaves is a deny slightly wider than the current
# table, which is the safe direction; the failure it prevents is this script
# silently deleting a rule someone added on purpose.
try:
    with open(os.environ["CLAWBOX_PROTECTED_PATHS"]) as f:
        protected = json.load(f)
    roots = [str(r) for r in protected["pathRoots"]]
    terminators = str(protected["pathTerminators"])
    boundary = str(protected["tokenBoundary"])
    verb_first = [str(t) for t in protected["verbFirstTokens"]]
    path_first = [str(t) for t in protected["pathFirstTokens"]]
    redirections = [str(p) for p in protected["redirectionPrefixes"]]
except (OSError, ValueError, KeyError, TypeError) as err:
    # Never fatal: the MCP registration above is what most of this script is
    # for, and a box with tools and no deny rule is strictly better than a box
    # with neither. Loud, because the deny is a safety rule and its absence must
    # not be silent.
    print(f"[register-mcp] WARNING: could not read the protected-path table "
          f"({type(err).__name__}); the model folder and the ClawBox tree are "
          f"NOT deny-listed this boot.", file=sys.stderr)
else:
    # fnmatch matches the WHOLE string, so every glob is `*`-wrapped. The class
    # is what makes a root end a path segment: `~/clawbox` and `~/clawbox/data`
    # are the tree, `~/clawbox-backup` is not. A root at the very end of the
    # command line gets its own glob, because there is no character there to put
    # in a class — that is the `rm -rf ~/clawbox` spelling.
    #
    # The class carries TAB, NEWLINE and CR as literal characters. Both halves
    # of that survive: fnmatch.translate copies a class through and a regex
    # class holds a literal control character, and PyYAML writes the glob as a
    # double-quoted scalar with \t \n \r escapes that safe_load reads back
    # identically. Changing this class changes every rendered glob, and the
    # merge below is add-only by design (an owner's own rule must survive), so
    # a box updated across such a change keeps the superseded globs alongside
    # the new ones — harmless, since a deny only ever adds refusals, and the
    # alternative is a script that deletes rules it did not write.
    term_class = "[" + terminators + "]"
    # The LEFT boundary of a token, so `rm ` is not found inside `confirm ` or
    # `xterm `. fnmatch's negated class, and the reason `tokenBoundary` is
    # stored in fnmatch's own syntax: the JavaScript side translates the `!`,
    # this side splices it in verbatim. Two variants per token, because a
    # command that STARTS with the verb has no character in front of it and
    # `fnmatch` matches the whole string.
    bound_class = "[" + boundary + "]"
    desired_deny = []
    for root in roots:
        for token in verb_first:
            for head in (f"{token}", f"*{bound_class}{token}"):
                desired_deny.append(f"{head}*{root}")
                desired_deny.append(f"{head}*{root}{term_class}*")
        for token in path_first:
            # No end-anchored variant: a root at the end of the line has no
            # token after it, and no start-anchored one: the root is in front.
            desired_deny.append(f"*{root}{term_class}*{bound_class}{token}*")
        for prefix in redirections:
            desired_deny.append(f"*{prefix}{root}")
            desired_deny.append(f"*{prefix}{root}{term_class}*")

    approvals_cfg = cfg.get("approvals")
    if approvals_cfg is None:
        approvals_cfg = {}
        cfg["approvals"] = approvals_cfg
    if not isinstance(approvals_cfg, dict):
        print("[register-mcp] WARNING: approvals is not a mapping; the model folder "
              "and the ClawBox tree are NOT deny-listed.", file=sys.stderr)
    else:
        existing = approvals_cfg.get("deny")
        # Hermes itself reads a non-list `deny` as denying nothing
        # (`_match_user_deny_rule` iterates it and keeps only stripped strings),
        # so a shape this script does not understand is not a rule that would be
        # lost by replacing it — but it IS something somebody typed, so say so
        # rather than overwrite it.
        if existing is None:
            current = []
        elif isinstance(existing, list):
            current = [str(item) for item in existing]
        else:
            current = None
            print("[register-mcp] WARNING: approvals.deny is not a list; leaving it "
                  "alone — the model folder and the ClawBox tree are NOT deny-listed.",
                  file=sys.stderr)
        if current is not None:
            missing = [g for g in desired_deny if g not in current]
            if missing:
                approvals_cfg["deny"] = current + missing
                changed = True
                print(f"[register-mcp] added {len(missing)} approvals.deny rules — the "
                      "ClawBox tree and the local-model folders cannot be deleted, "
                      "overwritten, truncated or moved by the agent")

def config_name_list(value):
    """The plugin names in a hermes config list value, or None for a shape this
    script cannot read.

    ONE reader for both `plugins.enabled` and `plugins.disabled`, because the
    re-arm below has to weigh them against each other and a second parse that
    disagreed by a corner case would arm the backend over its own deny-list.
    Three forms reach these keys: a real sequence, hermes' own JSON-string form
    ('["a","b"]', how `hermes config set` stores a list whose coercion missed),
    and a bare scalar meaning one name.

    None, never []: a shape nobody understands is not consent. Read as empty,
    an unparseable `enabled` would be overwritten and an unparseable `disabled`
    would be taken for "nothing is denied".

    DELIBERATELY STRICTER THAN HERMES ON `disabled`. `_get_disabled_set()` is
    `set(disabled) if isinstance(disabled, list) else set()`, so hermes reads a
    JSON-string, a bare scalar or any other NON-LIST deny-list as denying
    NOTHING, while this reader either recovers names from it or answers None,
    and the re-arm below then declines either way. That asymmetry is
    safe HERE and only here: the cost is that a boot does not re-arm and the
    owner's next Settings -> AI Models save does it instead. The same reading
    in src/lib/hermes-clawai.ts would WITHDRAW `image_gen.provider` from a box
    that draws today, which is why that reader answers the empty set for a
    residue.
    """
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    if not isinstance(value, str):
        return None
    if not value.strip().startswith("["):
        return [value] if value else []
    # `hermes config set` stores a list as a JSON string, and
    # src/lib/hermes-clawai.ts writes this very key that way with
    # JSON.stringify — so JSON first, and the Python literal form only as a
    # fallback for anything hand-written.
    parsed = None
    try:
        parsed = json.loads(value)
    except ValueError:
        try:
            parsed = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            parsed = None
    return [str(item) for item in parsed] if isinstance(parsed, list) else None


# ── Enable the outbound EMAIL:-directive hook plugin. ───────────────────────
# `plugins.enabled` is opt-in for every user plugin on the box
# (hermes_cli/plugins.py:4000 skips anything not listed), and it is the SAME
# list that gates the ClawAI image backend — so this is MERGED, never replaced.
# Writing our name over the list would silently unload the customer's image
# generation, and any other plugin they installed, as a side effect of a
# directive strip.
#
# A shape this script does not understand is left alone rather than repaired:
# `hermes config set` stores lists as a JSON string ('["a","b"]'), which
# `parse_config_string_list` reads, and the same two forms the skills block
# below handles turn up here.
#
# THE TYPE REPAIR IS NOT GATED ON THE HOOK. Reading the key, normalising a
# string back into a sequence and appending the hook are three separate
# questions, and only the last one needs a hook to append: `hook_plugin` is
# empty whenever the plugin's files did not land (see EMAIL_HOOK_INSTALLED
# above), and a box whose install failed AND whose `plugins.enabled` is a
# string is exactly the box that loads no plugins at all with nothing else on
# it to put the type back. TASK-701.
hook_plugin = os.environ.get("CLAWBOX_EMAIL_HOOK_PLUGIN") or ""
# Set only where a STRING became a real list — the state a withdrawn image
# claim is paired with. See the re-arm below.
repaired_enabled = False
names = None
plugins_cfg = cfg.get("plugins")
if plugins_cfg is None and hook_plugin:
    # Created only when there is a name to write into it; an absent key with
    # nothing to add is not a repair, it is a needless config rewrite.
    plugins_cfg = {}
    cfg["plugins"] = plugins_cfg
if plugins_cfg is not None and not isinstance(plugins_cfg, dict):
    print("[register-mcp] WARNING: plugins is not a mapping; leaving plugins.enabled alone."
          + (" The EMAIL: directive hook stays disabled." if hook_plugin else ""), file=sys.stderr)
elif isinstance(plugins_cfg, dict):
    raw_enabled = plugins_cfg.get("enabled")
    names = config_name_list(raw_enabled)
    if names is None:
        # LEFT ALONE, whichever shape it is. Falling back to "the whole string
        # is one plugin name" would write `['["clawai", …', 'clawbox_…']` and
        # the customer's image backend would stop loading on the next boot —
        # the exact failure the merge below exists to prevent, caused by the
        # code preventing it.
        print("[register-mcp] WARNING: plugins.enabled is "
              + ("a list this script cannot parse" if isinstance(raw_enabled, str)
                 else "not a list or a string")
              + "; leaving it untouched."
              + (" The EMAIL: directive hook stays disabled." if hook_plugin else ""),
              file=sys.stderr)
    if names is not None and hook_plugin and hook_plugin not in names:
        names = names + [hook_plugin]
        plugins_cfg["enabled"] = names
        changed = True
        # A string that had a name to append was normalised too — the write
        # below is `yaml.safe_dump` of a real sequence either way.
        repaired_enabled = isinstance(raw_enabled, str)
        print("[register-mcp] enabled the " + hook_plugin
              + " plugin — EMAIL: card directives are stripped on the way to a channel")
    elif names is not None and isinstance(raw_enabled, str):
        # NORMALISE THE TYPE even when there is no name to add. A string here
        # is the residue of a `hermes config set` that exited 0 and stored its
        # literal as text; `_get_enabled_set` reads a non-list as EMPTY, so the
        # box loads NO user plugin at all — ours, the customer's and this hook
        # included. The branch above healed it only as a side effect of having
        # a name to append, so a box whose residue already spelled the hook —
        # or one with no hook to append at all — stayed broken indefinitely.
        # `yaml.safe_dump` writes it back as a real sequence. TASK-701.
        plugins_cfg["enabled"] = names
        changed = True
        repaired_enabled = True
        print("[register-mcp] rewrote plugins.enabled as a list — it was stored as text, "
              "which loads no plugins at all")

# ── Re-arm the ClawAI image backend the repair above made loadable. ─────────
# `enableHermesImageGeneration` (src/lib/hermes-clawai.ts) unsets
# `image_gen.provider` when Hermes has ANSWERED that it will not load our
# plugin — the honest thing to do at that moment — and it runs only when the
# owner presses Save in Settings → AI Models. So without this, the repair above
# would leave a box whose plugin loads again still reporting that it cannot
# draw, until someone happened to open that page. A claim taken away by a proof
# is put back by the opposite proof.
#
# AT THE AGENT'S NEXT START, not at this moment. Like the MCP registration this
# script exists for, the repair and the re-arm are writes to config.yaml: the
# Hermes agent already running discovered its plugins at ITS start and holds
# that answer, and this script — which runs as `clawbox`, not root, and has
# never restarted a unit — does not disturb it. So on the boot that repairs a
# residue the claim can be true of the config and not yet of the running agent,
# for one dashboard lifetime. Strictly better than the state before, which was
# permanent, and the reason the line below reports what it WROTE rather than
# claiming the plugin is loaded.
#
# ALL FOUR CONDITIONS, or nothing is written:
#   1. we JUST turned a string into a list, and that list names the backend —
#      so this can only fire on the box the withdrawal was made on;
#   2. the backend's files are really on disk (the link path put them there),
#      because "named in config, nothing to load" is the false success this
#      whole script keeps guarding against;
#   3. `image_gen.provider` is UNSET. Never over a backend the customer chose
#      by hand, and never as a first-time opt-in on a box nobody has linked.
#      KNOWN LIMIT: unset is read as "nobody has chosen", and it cannot tell
#      that from an owner who cleared the key BY HAND to stop the agent drawing
#      — nothing in ClawBox distinguishes the two, since only the link path and
#      this block ever write it. The supported way to say no is Hermes' own
#      `hermes plugins disable clawai`, which condition 4 honours and which the
#      link path reads back as proof; a real ClawBox switch for it belongs on
#      the AI Models page, not in a boot script's inference.
#   4. `plugins.disabled` does NOT name the backend, IN EITHER SPELLING. The
#      deny-list WINS over `plugins.enabled` (`_plugin_status`,
#      hermes_cli/plugins_cmd.py:1931-1937), so a name in it is loadable by
#      every reading of the allow-list and loaded by none — and it is one of the
#      two answers the link path withdraws the claim FOR. Repairing a type does
#      not lift a denial, so re-arming without asking it would put back,
#      unattended, the very claim a proof had just taken away. BOTH spellings
#      because `hermes plugins disable clawai` stores the RESOLVED key
#      `image_gen/clawai` (`cmd_disable` -> `_resolve_plugin_key`, :1710-1739
#      and :1337-1362, read on the pinned 0.20.5 build) while the loader's
#      allow-list carries the bare name — hermes' own `_plugin_status` tests
#      both, and a check that knew only one would miss the deny-list in the one
#      state the harness's own command produces. Weighed through the same
#      reader as the allow-list, and a
#      deny-list this script cannot read declines the re-arm rather than
#      guessing: the cost is one Settings → Save, which asks Hermes itself.
image_plugin = os.environ.get("CLAWBOX_IMAGE_PLUGIN") or ""
image_plugin_key = os.environ.get("CLAWBOX_IMAGE_PLUGIN_KEY") or ""
image_entry = os.environ.get("CLAWBOX_IMAGE_PLUGIN_ENTRY") or ""
if repaired_enabled and image_plugin and image_plugin in (names or []):
    denied = config_name_list(plugins_cfg.get("disabled"))
    image_cfg = cfg.get("image_gen")
    if image_cfg is None:
        image_cfg = {}
    if not isinstance(image_cfg, dict):
        print("[register-mcp] WARNING: image_gen is not a mapping; leaving the image backend alone.",
              file=sys.stderr)
    elif image_cfg.get("provider") is not None:
        pass  # somebody's choice, ours or theirs — not this script's to move
    elif denied is None:
        print("[register-mcp] WARNING: plugins.disabled is a shape this script cannot read; "
              "leaving image_gen.provider unset.", file=sys.stderr)
    elif image_plugin in denied or (image_plugin_key and image_plugin_key in denied):
        # BOTH spellings: `hermes plugins disable clawai` stores the resolved
        # key, and hermes' own `_plugin_status` matches either.
        print("[register-mcp] plugins.disabled names the ClawAI image backend, so hermes "
              "loads it from no list; leaving image_gen.provider unset")
    elif not (image_entry and os.path.isfile(image_entry)):
        print("[register-mcp] the ClawAI image backend is not installed; "
              "leaving image_gen.provider unset")
    else:
        image_cfg["provider"] = image_plugin
        cfg["image_gen"] = image_cfg
        changed = True
        print("[register-mcp] re-armed image_gen.provider — the plugin list was repaired "
              "and the ClawBox AI backend is installed; hermes loads it at its next start")

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
# strictly better than a boot that aborted here — and never unbounded, the same
# reason the doctor below is bounded: this is the OTHER CLI call in a script
# `production-server.js` launches, so a `hermes` that wedges here would leave
# the helper and its child running for as long as the box is up. A timeout
# lands in the branch that already exists for a refusal, which is the honest
# answer for both.
# The braces are load-bearing, not style. `-k 5` makes `timeout` SIGKILL its own
# process group, so `timeout` ITSELF dies by a signal — and bash announces a
# signal-killed foreground child on the SCRIPT's stderr, which the command's own
# `2>&1` cannot reach: "register-mcp.sh: line NNN: <pid> Killed  timeout -k 5 …".
# production-server.js forwards this script's stderr into the clawbox-setup
# journal line by line, so that notice lands there naming this script and reads
# as the reconcile itself having been killed — beside the honest "could not
# disable" line. A misleading journal entry is the thing this whole step exists
# to avoid, so the group gives the shell's message somewhere to go. The exit
# status is unchanged: 137 still reaches the else, 0 still reaches the then.
# The `plugins doctor` call below needs no such group — bash does not print that
# notice for a child of a command substitution, and its output is captured.
# The STATUS is kept, because the group throws away the only other trace. This
# call does the CLI's own load -> save_config on ~/.hermes/config.yaml, which is
# why it sits inside the lock — so "we SIGKILLed it" (137) and "it declined"
# are very different facts for whoever is later holding a truncated config, and
# 125 (a bad duration) and 127 (no `timeout`) are different again. One sentence
# for all four was all the journal had.
# Being the `if` CONDITION is what keeps a refusal non-fatal under `set -e`;
# the group is only about stderr. `$?` in the `else` is still the condition's
# status, so the exit code reaches the log without a separate capture line.
if { timeout -k 5 "$HERMES_CLI_TIMEOUT" "$HERMES_BIN" tools disable browser >/dev/null 2>&1; } 2>/dev/null; then
  log "built-in browser toolset off; browsing goes through the ClawBox browser_* tools"
else
  BROWSER_DISABLE_RC=$?
  log "could not disable the built-in browser toolset (exit $BROWSER_DISABLE_RC) — continuing"
fi

# ── 4a. The ClawBox AI cloud voice: armed AND withdrawn, every boot. ────────
# BEFORE §4b, deliberately. §4b's read-back is written to be "the last word on
# what the boot leaves behind", and every `hermes config set` below is a full
# CLI load -> save_config of the same file. Running after it would put four such
# writes past the read-back that stamps `data/background-optouts.json` as
# seeded — and the CLI has been seen to exit 0 while storing a string, which is
# the exact drift §4b's record exists to prevent. This block has no dependency
# on §4b, so it goes first and §4b keeps its invariant.
# TASK-717 (the arm) and TASK-718 (the withdrawal). One block, because they are
# the two halves of one decision and shipping either alone reproduces the defect
# the other exists to fix: an arm with no withdrawal is the one-way migration
# TASK-718 is about, and a withdrawal with no arm has nothing to take back on a
# Hermes box that was never armed at boot in the first place.
#
# WHAT IS BROKEN WITHOUT IT. `applyClawaiToHermes` — the only thing on this
# edition that ever points `tts.provider` at the ClawBox AI proxy — has three
# callers and every one of them is an explicit (re-)link. So:
#   - a box linked BEFORE the cloud-voice wiring existed never gets it. Nothing
#     re-runs the link, and the owner has no reason to: Settings already says
#     ClawBox AI is connected. It simply never speaks (TASK-717).
#   - a box that WAS entitled and drops to a lower plan keeps `tts.openai.*`
#     pointing at an endpoint the proxy now answers 403 to, and pays a refused
#     round trip on every spoken reply (TASK-718).
# The OpenClaw edition has had both arms since TASK-459: `gateway-pre-start.sh`
# gates on `_clawai_speech_entitled` and has the `elif` that takes its own entry
# back. This is that pair, for the edition that has no `gateway-pre-start.sh`.
#
# THE NATIVE SURFACE IS `hermes config set` / `unset`, and it is what this uses —
# the same commands `hermes-tts.ts` issues for the Settings toggle, so the boot
# repair and the panel cannot drift into writing the config two different ways.
# Hermes has no entitlement mechanism of its own to lean on: `tts.provider` is a
# plain selection with no notion of a plan, and the tier lives only in ClawBox's
# device store because only ClawBox talks to the portal.
#
# WHY HERE. Same answer as §4b: this script already holds `${HERMES_CONFIG}.lock`
# and already makes CLI calls under it, and `production-server.js` fire-and-
# forgets it on every web-server boot on hermes|dual. A Node boot hook would be a
# second, unlocked writer racing this one.
#
# THE ENTITLEMENT IS THE PORTAL'S, not a guess: `clawai_plan_tier` in
# `data/config.json`, with `clawai_tier` behind it for the ARM and NOT behind it
# for the withdrawal, both written by whoever writes the credential and
# refreshed from `device-info` by `/setup-api/ai-models/status` on its
# 30-second poll — the same pair `speechEntitledTier()` reads for the panel and
# `_clawai_speech_entitled` / `_clawai_speech_withdrawable` read on the OpenClaw
# side. `"pro"` is the tier of the MAX plan; the two names are off by one on
# purpose (CLAWBOX_AI_MODEL_BY_TIER in src/lib/clawbox-ai-models.ts).
#
# NOT KNOWING IS NOT AN ANSWER, in either direction, and that is the whole
# false-success/false-failure guard here. A device store that is absent,
# unreadable or not an object; a `config.yaml` that will not parse; a tier that
# is not recorded at all — every one of them holds, and the boot says why. Only
# a tier we have actually been told, and a slot we can positively see is ours,
# moves anything.
#
# OWNERSHIP, mirroring `hermesCloudRouteIsOurs` (src/lib/hermes-tts.ts) key for
# key rather than inventing a second rule: the credential is a `claw_` portal
# token, OR the endpoint names our proxy, OR the slot is genuinely empty (no
# endpoint AND no key — `base_url` is optional for real OpenAI, so an unset
# endpoint alone says nothing). On Hermes `tts.openai` is the GENERIC
# OpenAI-compatible slot, not ClawBox's, and an owner may be running their own
# speech server in it.
#
# THE SELECTION IS THE OWNER'S. The arm moves `tts.provider` only from a
# genuinely unchosen value — unset, or Hermes' factory `edge` — or from
# `clawbox-local` on a box that provably has no on-device engine, which is the
# state the card is about: `install.sh` selects `clawbox-local` whatever the
# engine answered, so an engineless box reads as a chosen local voice. A box on
# `elevenlabs`, `piper` or anything else the owner picked is left alone.
# And the withdrawal deliberately does NOT reset `tts.provider` either — the
# same ruling the OpenClaw arm records: the panel's job is to show that the
# choice is no longer available, and silently rewriting it would hide the
# downgrade. Removing the DEFINITION is what stops the refused calls.
#
# IMAGES ARE NOT PART OF THIS, and that is measured rather than assumed: the
# proxy publishes `modelTiers: {"gpt-image-1-mini": ["free","pro","max"]}`, so
# the image backend has no tier to be downgraded from, and §"Re-arm the ClawAI
# image backend" above already reconciles it every boot.
# ONE binding each for the endpoint and the model, read by the decision below
# and by the writes after it, so what we call ours and what we write cannot
# disagree. Two literals would drift the day one of them moved: the verdict
# would answer `refresh` on every boot and store the stale value for good.
# `CLAWBOX_AI_PROXY_URL` is the same staging override `hermes-clawai.ts` honours,
# and it is normalised the same way that binding normalises it — trimmed, and
# with every trailing slash removed — so the endpoint compared here and the
# endpoint every TypeScript consumer derives are the same string.
CLAWBOX_VOICE_PROXY="${CLAWBOX_AI_PROXY_URL:-https://clawbox.com/api/ai}"
CLAWBOX_VOICE_PROXY="$(printf '%s' "$CLAWBOX_VOICE_PROXY" | tr -d '[:space:]')"
while [ "${CLAWBOX_VOICE_PROXY%/}" != "$CLAWBOX_VOICE_PROXY" ]; do
  CLAWBOX_VOICE_PROXY="${CLAWBOX_VOICE_PROXY%/}"
done
# AFTER the normalisation, not only through `${:-}`. A variable set to
# whitespace survives `${:-}` and normalises to the empty string, and an empty
# "our proxy" is the worst possible value here: it makes an owner's slot that
# carries their key and NO base_url — the canonical way Hermes' generic `openai`
# slot is used — read as ours, so the arm would overwrite their credential and
# the withdrawal would delete it.
if [ -z "$CLAWBOX_VOICE_PROXY" ]; then
  CLAWBOX_VOICE_PROXY="https://clawbox.com/api/ai"
fi
CLAWBOX_VOICE_MODEL="gpt-4o-mini-tts"
CLAWBOX_VOICE_PLAN=$(
  CLAWBOX_DEVICE_STORE="$PROJECT_DIR/data/config.json" \
  CLAWBOX_HERMES_CONFIG="$HERMES_CONFIG" \
  CLAWBOX_SPEECH_DEVICE_TIER="pro" \
  CLAWBOX_AI_PROXY_URL="$CLAWBOX_VOICE_PROXY" \
  CLAWBOX_VOICE_MODEL="$CLAWBOX_VOICE_MODEL" \
  CLAWBOX_KOKORO_STAMP="$HOME_DIR/.cache/clawbox/kokoro-installed" \
  python3 - <<'PY' 2>/dev/null || echo "hold the voice plan could not be computed"
import json, os

# One verdict on stdout: `arm`, `withdraw`, or `hold <why>`. Everything this
# block decides is decided here, so the shell below is only the writes.
def say(verdict):
    print(verdict)
    raise SystemExit(0)

try:
    import yaml
except ImportError:
    say("hold PyYAML is unavailable")

ENTITLED_TIER = os.environ["CLAWBOX_SPEECH_DEVICE_TIER"]
# Trailing slashes are not significant in a base URL comparison, and
# `hermesCloudRouteIsOurs` strips them the same way on the TypeScript side.
PROXY = os.environ["CLAWBOX_AI_PROXY_URL"].strip().rstrip("/")
# Every address ClawBox has ever written as its AI proxy: the live one (which a
# staging box overrides through CLAWBOX_AI_PROXY_URL) plus the two retired
# hosts. `CLAWBOX_AI_PROXY_URLS` in src/lib/clawbox-ai-models.ts is the shared
# answer to exactly this question and the suite pins the two copies together.
# It exists so an entry left on an address we have since moved off is still
# recognisably ours — which is the ONLY thing that makes a credential-blind
# delete safe.
# The empty string can never be a member: an unset endpoint is not an address,
# and admitting one would make every owner slot with a key and no URL ours.
# Defence in depth — the shell above restores the default before we get here.
OUR_PROXIES = {
    PROXY,
    "https://clawbox.com/api/ai",
    "https://openclawhardware.dev/api/ai",
    "https://www.openclawhardware.dev/api/ai",
}
OUR_PROXIES.discard("")
# Hermes' factory default, and the one selection besides "unset" that means
# nobody has chosen: `edge` is Microsoft's cloud voice, which the box gets for
# having expressed no opinion.
FACTORY_PROVIDER = "edge"
LOCAL_PROVIDER = "clawbox-local"
CLOUD_PROVIDER = "openai"
# The one speech model the proxy serves; the same constant `hermes-tts.ts` pins
# as HERMES_CLOUD_TTS_MODEL, because a request that names anything else is
# answered 400. Bound by the shell above so the model compared here and the
# model written below are one value.
CLOUD_MODEL = os.environ["CLAWBOX_VOICE_MODEL"]


def text(value):
    return value.strip() if isinstance(value, str) else ""


def short(value):
    """Owner-controlled text, bounded and flattened before it reaches a log line.

    The verdict string is printed into the clawbox-setup journal, and
    `tts.provider` is whatever is in the customer's config.yaml. One value stays
    one line, and one value does not decide how much gets written — the same two
    rules `logSafe` keeps on the TypeScript side.
    """
    return " ".join(value.split())[:40]


def load(path, loader):
    try:
        with open(path) as fh:
            return loader(fh), None
    except FileNotFoundError:
        return None, "absent"
    except Exception as exc:  # noqa: BLE001 — every failure is "we cannot tell"
        return None, type(exc).__name__


store, why = load(os.environ["CLAWBOX_DEVICE_STORE"], json.load)
if why == "absent":
    say("hold this box has no ClawBox AI link on record")
if why is not None:
    say("hold the device store could not be read (%s)" % why)
if not isinstance(store, dict):
    say("hold the device store is not an object")

token = text(store.get("clawai_token"))


def stamped_tier(key, allowed):
    """One tier stamp out of the device store, normalised, or "" for unknown.

    `normalizeClawboxAiTier` admits exactly `flash` and `pro` and answers null
    to everything else, and `normalizeClawboxAiPlanTier` is that plus the unpaid
    word. A value outside the vocabulary is a store somebody edited or a build
    we have not seen: not evidence of anything, least of all of a downgrade, so
    it collapses to the same "" as an absent one.
    """
    value = store.get(key)
    value = value.strip().lower() if isinstance(value, str) else ""
    return value if value in allowed else ""


# THE ENTITLEMENT IS THE PLAN. `clawai_tier` is `mapPortalTier`'s answer and
# prefers the portal's `deviceTier` STAMP deliberately: it answers "what should
# this box DEFAULT to", and a Max subscriber is allowed to run Flash here.
# `clawai_plan_tier` is `mapPortalPlanTier`'s — "what does this ACCOUNT pay
# for" — and `clawbox-ai-portal-tier.ts` states the rule outright: "Read the
# first for a default to write; read this one before refusing anything"
# (TASK-744).
#
# `free` is the third plan value and it has to exist: `mapPortalTier` and
# `mapPortalPlanTier` both answer null for an unpaid account, so without a
# positive word for it a CANCELLED subscription would be indistinguishable from
# a box nobody has ever asked about. `CLAWAI_PLAN_UNPAID` is the same word.
PLAN_UNPAID = "free"
plan_tier = stamped_tier("clawai_plan_tier", ("flash", ENTITLED_TIER, PLAN_UNPAID))
device_tier = stamped_tier("clawai_tier", ("flash", ENTITLED_TIER))

# ARM: the plan when we have been told one, the badge only when we have not —
# `clawaiEntitlementTier`. The fallback belongs on THIS side alone, because
# arming is recoverable (our own fields, our own values) and every box in the
# field has no plan recorded until its first successful status poll.
arm_tier = plan_tier or device_tier

cfg, why = load(os.environ["CLAWBOX_HERMES_CONFIG"], yaml.safe_load)
if why == "absent":
    # Unreachable in practice — §3 exits long before here on a config it cannot
    # read — but "absent" is a state, not a failure, and reporting it as one
    # would be the false-failure shape in the line an operator reads.
    say("hold this box has no ~/.hermes/config.yaml yet")
if why is not None:
    say("hold ~/.hermes/config.yaml could not be read (%s)" % why)
if cfg is None:
    cfg = {}
if not isinstance(cfg, dict):
    say("hold ~/.hermes/config.yaml is not a mapping")

tts = cfg.get("tts")
tts = tts if isinstance(tts, dict) else {}
provider = text(tts.get("provider"))
slot = tts.get(CLOUD_PROVIDER)
slot = slot if isinstance(slot, dict) else {}
base_url = text(slot.get("base_url"))
api_key = text(slot.get("api_key"))
model = text(slot.get("model"))

# `hermesCloudRouteIsOurs`, key for key: a `claw_` credential, OR our endpoint,
# OR a genuinely empty slot.
key_is_ours = api_key.startswith("claw_")
slot_is_empty = base_url == "" and api_key == ""
route_is_ours = key_is_ours or slot_is_empty or base_url.rstrip("/") == PROXY

if token and arm_tier == ENTITLED_TIER:
    # ALREADY SPEAKING THROUGH US. The selection is not touched again; the
    # DEFINITION still is, because the portal rotates the token on a re-link and
    # this script is the only thing on the boot path that would notice. An
    # unrefreshed key is a 401 on every utterance while every panel — which asks
    # only that the two keys are non-empty — calls the voice configured.
    if provider == CLOUD_PROVIDER and route_is_ours:
        if base_url.rstrip("/") == PROXY and api_key == token and model == CLOUD_MODEL:
            say("hold the cloud voice is already armed")
        say("refresh")
    if provider not in ("", FACTORY_PROVIDER, LOCAL_PROVIDER):
        say("hold this box has already chosen how it speaks (%s)" % short(provider))
    # UNCHOSEN IS ALL THREE, and the engine question is asked of all three.
    # `clawbox-local` is here because `install.sh` `step_openclaw_tts` selects it
    # on every install and every update WHATEVER the engine answered —
    # deliberately, because to Hermes an absent `tts.provider` resolves to
    # Microsoft's Edge cloud, so an engineless box is left honestly mute rather
    # than speaking through a third party. So "a Hermes box with no TTS engine"
    # reads as a CHOSEN local voice. But unset and `edge` belong with it, not
    # apart from it: `step_openclaw_tts` has one arm that leaves the key UNSET
    # (a `hermes config get` that did not answer — one OOM-killed Python start
    # on a loaded Jetson), and this script runs on every web-server boot, so it
    # would fire before anything could correct it. A box that can speak entirely
    # on-device must not be moved off its own voice by a boot script.
    #
    # Moving a box off its own voice is effectively permanent — the next
    # `step_openclaw_tts` sees `openai`, falls into its owner's-choice arm and
    # preserves it — so it happens only on a POSITIVE "this box cannot speak for
    # itself". The stamp is that positive: `localTtsEngineInstalled` is `stamped
    # AND the unit is present`, so an ABSENT stamp settles it with a single file
    # test and no systemd bus. A stamp that IS there is deliberately not pursued
    # further: the unit could still be missing, but "we did not finish asking" is
    # not evidence, and this boot cannot afford the probe the link path makes.
    #
    # The link path (`selectHermesCloudVoiceIfUnvoiced`) goes one step further
    # and SELECTS the on-device engine here. This holds instead: it has a live
    # engine probe and this boot does not, and `step_openclaw_tts` re-selects
    # `clawbox-local` on the next update anyway.
    if os.path.exists(os.environ["CLAWBOX_KOKORO_STAMP"]):
        say("hold this box speaks for itself")
    if not route_is_ours:
        say("hold tts.openai already names its own speech route")
    say("arm")

# The other direction — `clawaiSpeechWithdrawable`, and it reads the PLAN
# ALONE. Only over a plan we have actually been TOLD: an absent stamp is a box
# nobody has told us about, not a box that has lost its plan, and taking a
# working voice away over a store we could not read is the false failure this
# whole block is written to avoid. And never over the BADGE, which is a default
# a Max subscriber is allowed to have set to Flash — withdrawing on it is
# TASK-744 with the customer's configuration gone. `free` is a plan we were
# told, so a cancelled subscription still withdraws.
if plan_tier and plan_tier != ENTITLED_TIER:
    # ONLY what we wrote. The stamp the OpenClaw arm can rely on does not exist
    # here — Hermes' `tts.openai` block is the harness's own schema and carries
    # no room for one — so ownership is the positive endpoint/credential test
    # above, and an EMPTY slot is explicitly not something to take back.
    if slot_is_empty:
        say("hold there is no ClawBox AI cloud voice on this box to withdraw")
    # AN ADDRESS OF OURS, and only that — NOT the credential. The arm above is
    # allowed the looser `hermesCloudRouteIsOurs` rule because the worst it can
    # do is rewrite our own fields to our own values; this is the one place in
    # the file that DESTROYS configuration, and `gateway-pre-start.sh` states
    # the rule its own delete arm keeps: a `claw_` token "is enough to REFRESH
    # an entry … it is not enough to DELETE one, because an owner can point our
    # own token at our own proxy with a model of their choosing, and that entry
    # is theirs". On Hermes there is no `clawboxManaged` stamp to lean on — the
    # harness owns that schema — so the address IS the evidence, and the retired
    # hosts are in the set so an entry left on an address we have moved off is
    # still recognisably ours.
    if base_url.rstrip("/") not in OUR_PROXIES:
        say("hold tts.openai names an address that is not ours — not ours to withdraw")
    say("withdraw")

if not arm_tier:
    say("hold no plan has been recorded for this box yet")
if not plan_tier:
    say("hold only this box's badge says it is not entitled, and a badge is not a plan")
if not token:
    say("hold this box's plan includes the cloud voice but it holds no credential")
say("hold nothing to do")
PY
)
CLAWBOX_VOICE_VERDICT="${CLAWBOX_VOICE_PLAN%% *}"

# One bounded CLI call, with the exit status kept. Braces and `-k 5` for the
# reason §4's `tools disable` documents at length: `timeout` SIGKILLs its own
# process group, bash announces a signal-killed foreground child on the SCRIPT's
# stderr where the command's own redirect cannot reach it, and that notice lands
# in the clawbox-setup journal reading as this script having been killed.
hermes_voice_write() {
  # A COLLECTIVE budget, not four independent ceilings. This runs inside
  # `${HERMES_CONFIG}.lock`, and `setup-hermes-dashboard-auth.sh` waits exactly
  # `flock -w 120` for that lock before proceeding WITHOUT it — which is the
  # config clobber the lock exists to stop. Four writes at the full
  # `HERMES_CLI_TIMEOUT` each would add up to 200 s to the hold on their own.
  # Measured cost of a `hermes config set` on an Orin is a few seconds, so the
  # whole arm gets one `HERMES_CLI_TIMEOUT` between them and each call is
  # bounded by what is left. Running out is reported and retried next boot,
  # which is the safe direction: a lock held past 120 s is not.
  local remaining=$(( CLAWBOX_VOICE_DEADLINE - $(date +%s) ))
  if [ "$remaining" -le 0 ]; then
    CLAWBOX_VOICE_RC=124
    return 1
  fi
  if { timeout -k 5 "$remaining" "$HERMES_BIN" "$@" >/dev/null 2>&1; } 2>/dev/null; then
    return 0
  else
    # INSIDE the else, which is the only place `$?` is the CONDITION's status —
    # after `fi` it is the `if` statement's own 0, and every failure line would
    # report "(exit 0)". The same shape, and the same reason, as §4's
    # `tools disable` capture.
    CLAWBOX_VOICE_RC=$?
    return 1
  fi
}

CLAWBOX_VOICE_DEADLINE=$(( $(date +%s) + HERMES_CLI_TIMEOUT ))

case "$CLAWBOX_VOICE_VERDICT" in
  arm|refresh)
    # DEFINITION BEFORE SELECTION, the same order `selectHermesEngine` keeps:
    # the endpoint, credential and model land first, so a failure leaves
    # `tts.provider` untouched rather than selecting a provider with nowhere to
    # send a request. Nothing is recorded behind a marker, so a boot that got
    # part way is simply offered the whole thing again by the next one.
    CLAWBOX_VOICE_TOKEN=$(
      CLAWBOX_DEVICE_STORE="$PROJECT_DIR/data/config.json" python3 - <<'TOKENPY' 2>/dev/null || true
import json, os
try:
    with open(os.environ["CLAWBOX_DEVICE_STORE"]) as fh:
        value = json.load(fh).get("clawai_token")
except Exception:
    value = None
print(value.strip() if isinstance(value, str) else "")
TOKENPY
    )
    if [ -z "$CLAWBOX_VOICE_TOKEN" ]; then
      log "NOTE: the ClawBox AI cloud voice was armable but the device token could not be re-read; leaving the voice alone"
    elif ! hermes_voice_write config set tts.openai.base_url "$CLAWBOX_VOICE_PROXY"; then
      log "could not write tts.openai.base_url (exit $CLAWBOX_VOICE_RC) — the cloud voice is NOT selected; the next start will try again"
    # The credential is an ARGUMENT and never reaches a message: one of these
    # three writes carries the device token, and the journal keeps what is
    # logged.
    elif ! hermes_voice_write config set tts.openai.api_key "$CLAWBOX_VOICE_TOKEN"; then
      log "could not write tts.openai.api_key (exit $CLAWBOX_VOICE_RC) — the cloud voice is NOT selected; the next start will try again"
    elif ! hermes_voice_write config set tts.openai.model "$CLAWBOX_VOICE_MODEL"; then
      log "could not write tts.openai.model (exit $CLAWBOX_VOICE_RC) — the cloud voice is NOT selected; the next start will try again"
    elif [ "$CLAWBOX_VOICE_VERDICT" = refresh ]; then
      # The selection is already ours and is NOT rewritten: one writer of
      # `tts.provider`, and this path is only here to keep the credential and
      # the endpoint current.
      log "refreshed the ClawBox AI speech credential"
    elif ! hermes_voice_write config set tts.provider openai; then
      log "wrote the ClawBox AI speech endpoint but could not select it (exit $CLAWBOX_VOICE_RC) — the next start will try again"
    else
      log "armed the ClawBox AI cloud voice — this box's plan includes it and nothing else had been chosen"
    fi
    ;;
  withdraw)
    # `tts.provider` is deliberately left where it is — see the block comment.
    # Removing the DEFINITION is what stops the refused round trips; the panel
    # then reports the cloud voice unconfigured, which is the truth.
    #
    # The CREDENTIAL first, and every step reported rather than collapsed into
    # one verdict: a partial withdrawal announced as a whole one is exactly the
    # false success this arm exists to end.
    CLAWBOX_VOICE_WITHDRAWN=true
    for CLAWBOX_VOICE_KEY in tts.openai.api_key tts.openai.base_url tts.openai.model; do
      if ! hermes_voice_write config unset "$CLAWBOX_VOICE_KEY"; then
        log "could not remove $CLAWBOX_VOICE_KEY (exit $CLAWBOX_VOICE_RC) — this box may still be calling a speech endpoint its plan no longer includes; the next start will try again"
        CLAWBOX_VOICE_WITHDRAWN=false
      fi
    done
    if [ "$CLAWBOX_VOICE_WITHDRAWN" = true ]; then
      log "removed the ClawBox AI cloud voice: this box's plan no longer includes it"
    fi
    ;;
  *)
    # Every hold says why, on the boot log, because "nothing happened" is the
    # one outcome an operator cannot tell apart from "this step is not running".
    log "left the voice alone — ${CLAWBOX_VOICE_PLAN#hold }"
    ;;
esac

# ── 4b. Hermes' own background jobs, opted out of ONCE per box. ─────────────
# TASK-609 / owner ruling 2026-09-03: the assistant must not message the owner
# or spend his tokens on its own initiative unless he asked it to. OpenClaw 2's
# three such jobs are seeded by `gateway-pre-start.sh`; these are Hermes' two,
# and they are the harness's own documented keys, read off the installed 0.20.5
# package on the box:
#
#   auxiliary.background_review.enabled  default TRUE — `agent/background_review.py`
#     (`aux.get("background_review")` -> `is_truthy_value(task.get("enabled"),
#     default=True)`). The post-turn memory/skill review fork.
#   curator.enabled                      default TRUE — `hermes_cli/config_defaults.py`
#     ("curator": {"enabled": True, …}); `agent/curator.py` `is_enabled()`,
#     "Default ON when no config says otherwise". The background skill pass.
#
# Hermes has NO heartbeat: its only `heartbeat` keys are transport-level
# (`compute_host_heartbeat_secs`, `websocket_heartbeat_ack_max_age_seconds`),
# so there is no third row to seed. Settings -> System draws the two switches
# and reports the check-ins row `supported: false` (src/lib/background-jobs.ts).
#
# WHY HERE, AND NOT IN THE WEB SERVER. This was first written as a Node boot
# hook calling `patchHermesConfig`, the comment-preserving writer the Settings
# toggles use — and that is a SECOND, UNLOCKED writer of config.yaml on a boot
# path where two already cooperate over `${HERMES_CONFIG}.lock`.
# `production-server.js` spawns THIS script on every web-server boot (on every
# edition; §1 above is what makes it a no-op on the OpenClaw SKU), and it holds
# that lock from §3 to exit while doing a PyYAML read-modify-write plus two CLI
# calls; `setup-hermes-dashboard-auth.sh` is a third, concurrent, locked writer.
# `patchHermesConfig` cannot take the lock (it is a Python `filelock`, i.e. a
# flock, and its own header says so), so a Node seed would win or lose the
# rename by luck: either recording the keys as seeded and then having them
# erased — never offered again, both jobs running, and its own read-back cannot
# see a clobber that lands after it — or erasing `mcp_servers.clawbox`, the
# protected-path `approvals.deny` table and `skills.disabled`, leaving the agent
# with no device tools and no path guard. One writer per harness, inside the
# lock it already holds, is the fix.
#
# WHY NOT `hermes config set`, which IS the native surface. §3 above already
# gives the reason for this file, in this script: the CLI "rewrites the whole
# config through Hermes' own save_config(), which is a much wider blast radius
# for a boot-time provisioning step, and it is slow" — two more Python
# interpreter starts inside a step that already time-boxes its only two CLI
# calls. It also buys nothing back: `save_config()` re-serialises and drops the
# comments just as `safe_dump` does. And it has a known failure mode here — the
# CLI has been seen to exit 0 while storing a STRING, and `agent/curator.py`
# reads `bool(cfg.get("enabled", True))`, so a stored `"false"` would leave the
# curator ON with a config that looks right. The read-back below is what makes
# either writer safe, and this one writes a real YAML boolean.
#
# WHAT THIS COSTS, measured rather than assumed: the live config.yaml on the
# Hermes box carries 36 comment lines (of 275), including Hermes' own
# "── Security ──" and "── Fallback Model ──" blocks, so the ONE boot that seeds
# re-serialises them away. It is once per box — the record below means a seeded
# box never writes again — and the previous revision is kept at
# `config.yaml.bak`, the same recovery path `hermes-config-yaml.ts` uses for its
# own writes. §3's "already current, skipping write" means an ALREADY-REGISTERED
# box pays this on the upgrade boot alone rather than alongside a write it was
# making anyway; a fresh box pays it with §3's first write.
#
# GATED ON THE EDITION, not on the active harness: on a dual box the owner can
# switch to Hermes at any time without restarting the web server, so a seed that
# asked which harness was active at boot would leave a switched-over box running
# both jobs at the harness default until something restarted the server.
#
# THE RECORD, and the drift it accepts. `data/background-optouts.json` is
# ClawBox's own file, shared with the OpenClaw half, and it is a marker for
# state that lives in `~/.hermes` — the shape §4 above argues against, because a
# marker and the thing it stands for can drift. Kept anyway, and the difference
# from §4's case is that re-converging is not free here: `tools disable browser`
# is idempotent, whereas re-writing an opt-out every boot would put `false` back
# over a key the owner had unset by hand to mean "back to the default". The
# accepted residual is the mirror of that: something that restores or reinstalls
# `~/.hermes` without touching `data/` (a ClawKeep harness restore, a manual
# reinstall) leaves the record saying "seeded" over a config that no longer
# carries the keys, and both jobs run at the harness default until the owner
# uses Settings or the box is factory reset — which empties `data/` and offers
# the seed again.
CLAWBOX_OPTOUT_STATE="$PROJECT_DIR/data/background-optouts.json" \
CLAWBOX_HERMES_CONFIG="$HERMES_CONFIG" \
python3 - <<'PY' || log "WARNING: the Hermes background-job opt-out seed did not complete; see the note above it for what was and was not written"
import json, os, sys, tempfile

try:
    import yaml
except ImportError:
    # Defence in depth: §3 above already exits 1 on this, so it cannot be
    # reached from there — but this block must not be the one that assumes it.
    print("[register-mcp] NOTE: PyYAML is unavailable; the background-job opt-outs were not seeded",
          file=sys.stderr)
    raise SystemExit(0)

# path -> the value ClawBox seeds when the owner has expressed no opinion.
# Unlike OpenClaw's heartbeat row, BOTH of these are written explicitly in both
# directions (`true` for on, `false` for off), so an absent value can only mean
# "no opinion expressed" — there is no key here whose "on" looks like an absence.
WANTED = [
    (("auxiliary", "background_review", "enabled"), False),
    (("curator", "enabled"), False),
]

state_path = os.environ["CLAWBOX_OPTOUT_STATE"]
cfg_path = os.environ["CLAWBOX_HERMES_CONFIG"]


def read_seeded(path):
    """The keys this box has already been offered, or None if the record is unusable.

    Absent is the normal first boot. Unusable — unreadable, undecodable, or
    valid JSON that is not `{"seeded": [<string>, ...]}` — is a third fact, and
    the difference matters on a DUAL box, where `gateway-pre-start.sh` keeps its
    own three keys in this same file: rewriting an unusable record would replace
    it with a valid one naming only these two, and the OpenClaw half would then
    read a well-formed record that does not mention `heartbeat.every`, find the
    key absent because the owner had switched check-ins back ON, and write `0m`
    over his choice. So an unusable record still SEEDS (safe, see WANTED) and
    records nothing, leaving the file for the half that can repair it safely.

    Total, because the caller cannot tell a raised exception from a real
    failure: `ValueError` covers JSONDecodeError AND UnicodeDecodeError (a
    record written in another encoding), `RecursionError` a document nested past
    the decoder's limit.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            record = json.load(fh)
    except FileNotFoundError:
        return set()
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(record, dict):
        return None
    rows = record.get("seeded")
    if not isinstance(rows, list) or not all(isinstance(row, str) for row in rows):
        return None
    return set(rows)


record = read_seeded(state_path)
unusable = record is None
seeded = set() if unusable else record
if unusable:
    print("[register-mcp] WARN: the background-job opt-out record exists but cannot be read;"
          " the Hermes opt-outs are still seeded where the key is absent, and nothing is recorded",
          file=sys.stderr)

pending = [(path, value) for path, value in WANTED if ".".join(path) not in seeded]
# A seeded box pays one small file read and nothing else — no YAML load, no
# write. This runs on every web-server boot.
if not pending:
    raise SystemExit(0)

try:
    with open(cfg_path, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
except FileNotFoundError:
    cfg = {}
except Exception as exc:  # noqa: BLE001 - any unreadable config defers, never settles
    # Also defence in depth: §3 exits 1 on an unreadable or unparseable config,
    # so the script never reaches here with one.
    print("[register-mcp] NOTE: the Hermes config could not be read (%s); the background-job"
          " opt-outs will be offered again at the next start" % type(exc).__name__, file=sys.stderr)
    raise SystemExit(0)
if cfg is None:
    cfg = {}
if not isinstance(cfg, dict):
    print("[register-mcp] NOTE: the Hermes config is not a mapping; the background-job opt-outs"
          " were not seeded", file=sys.stderr)
    raise SystemExit(0)


def resolve(path):
    """'value' (the owner has said something), 'absent', or 'unusable'.

    `None` is an ABSENCE, not an unusable shape. `curator:` written as a bare
    header with nothing under it loads as `None`, and calling that unusable
    would refuse the opt-out on every boot for ever over an empty section — the
    write below replaces a null parent with a mapping exactly as it creates a
    missing one. Only a parent holding something ELSE (a scalar, a list) is a
    shape this seed will not reshape.
    """
    node = cfg
    for part in path[:-1]:
        if node is None:
            return "absent"
        if not isinstance(node, dict):
            return "unusable"
        if part not in node:
            # Nothing below an absent parent exists either, and the parents are
            # ours to create.
            return "absent"
        node = node[part]
    if node is None:
        return "absent"
    if not isinstance(node, dict):
        return "unusable"
    return "value" if node.get(path[-1]) is not None else "absent"


settled = []
wrote = []
for path, value in pending:
    key = ".".join(path)
    state = resolve(path)
    if state == "unusable":
        # A parent written as something other than a mapping. Not ours to
        # reshape, and not settled either: "we could not look" is not "the owner
        # has an opinion", and settling it would give up the opt-out for ever.
        print("[register-mcp] NOTE: %s sits under a key this seed cannot read; it will be"
              " offered again at the next start" % key, file=sys.stderr)
        continue
    # Settled whether it was written or was already the owner's: ClawBox has had
    # its say about this key, and offering it again could only ever undo him.
    settled.append(key)
    if state == "value":
        continue
    node = cfg
    for part in path[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            child = {}
            node[part] = child
        node = child
    node[path[-1]] = value
    wrote.append(key)

if not settled:
    raise SystemExit(0)

if wrote:
    directory = os.path.dirname(cfg_path) or "."
    try:
        os.makedirs(directory, exist_ok=True)
        # The previous revision, at the stable name `hermes-config-yaml.ts` uses
        # for its own writes — this is the one boot that re-serialises the
        # customer's config, and the comments it drops are recoverable from here.
        try:
            with open(cfg_path, "rb") as fh:
                previous = fh.read()
        except OSError:
            previous = None
        if previous is not None:
            bfd, btmp = tempfile.mkstemp(dir=directory, prefix=".config.bak.", suffix=".tmp")
            try:
                os.fchmod(bfd, 0o600)
                with os.fdopen(bfd, "wb") as fh:
                    fh.write(previous)
                os.replace(btmp, cfg_path + ".bak")
            except Exception:
                try:
                    os.unlink(btmp)
                except OSError:
                    pass
                raise
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".config.", suffix=".tmp")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as fh:
                yaml.safe_dump(cfg, fh, default_flow_style=False, sort_keys=False, allow_unicode=True)
            os.replace(tmp, cfg_path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception as exc:  # noqa: BLE001
        # NOT a bare raise: a top-level `python3` under `set -euo pipefail` puts
        # the whole traceback in the clawbox-setup journal, which is what
        # TASK-657 took out of §3. Nothing was recorded, so the next boot offers
        # the seed again.
        print("[register-mcp] WARN: could not write the Hermes background-job opt-outs (%s);"
              " the box may spend tokens on background jobs until Settings is used"
              % type(exc).__name__, file=sys.stderr)
        raise SystemExit(0)
    # READ BACK OFF THE FILE, not off `cfg`. A dump that lost a key, a rename
    # that landed somewhere else, a config a concurrent writer replaced inside
    # this critical section — all of them leave `cfg` saying the right thing and
    # the box saying the old one, and recording that as seeded would mean the
    # keys are never offered again. This block sits AFTER §4 and §4a for the same
    # reason: `hermes tools disable browser` does the CLI's own load ->
    # save_config on this file, so a read-back above it would not be the last
    # word on what the boot leaves behind.
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            back = yaml.safe_load(fh) or {}
    except Exception:  # noqa: BLE001
        back = None
    for key in wrote:
        node = back
        for part in key.split("."):
            node = node.get(part) if isinstance(node, dict) else None
        if node is not False:
            print("[register-mcp] WARN: %s did not read back as off after the write; nothing was"
                  " recorded, so the opt-outs are offered again at the next start" % key,
                  file=sys.stderr)
            raise SystemExit(0)
    print("[register-mcp] seeded the Hermes background-job opt-outs (%s) — Settings can switch"
          " them back on" % ", ".join(wrote))

# RECORDED ONLY AFTER THE WRITE LANDED, and merged rather than replaced: on a
# dual box `gateway-pre-start.sh` keeps its own three keys in this file, and a
# wholesale rewrite would drop them and offer that half's seed all over again.
# Merging is SEQUENTIAL safety only — neither half locks this file, and on a
# dual box the gateway's ExecStartPre can run beside this script — so the record
# is re-read here rather than reused from the top, which is as narrow as the
# window gets. The verdict is re-derived from that second read too: a record
# that went bad in between must not be laundered into a valid one naming only
# these two keys, which is the `heartbeat.every` revert `read_seeded` refuses.
if unusable:
    raise SystemExit(0)
again = read_seeded(state_path)
if again is None:
    print("[register-mcp] WARN: the background-job opt-out record became unreadable while the"
          " opt-outs were being written; nothing was recorded", file=sys.stderr)
    raise SystemExit(0)
keep = set(again)
keep.update(settled)

directory = os.path.dirname(state_path) or "."
try:
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".background-optouts.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump({"seeded": sorted(keep)}, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, state_path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
except Exception as exc:  # noqa: BLE001
    # The config IS seeded and verified at this point — only the record is
    # missing, so the next boot writes the same values over themselves and
    # records them then. Said precisely, because "the box may spend tokens" is
    # false on this arm.
    print("[register-mcp] NOTE: the Hermes background-job opt-outs are in place, but the record"
          " of them could not be written (%s); the next start will write them again"
          % type(exc).__name__, file=sys.stderr)
PY

# ── 5. Prove the EMAIL: hook plugin actually LOADS, every boot. ─────────────
# `hermes plugins list` would say "enabled" for a plugin that raises on import,
# has no `register()`, or registers a mistyped hook name: its status is read
# straight back out of the config sets it was just written into
# (hermes_cli/plugins_cmd.py:1931). Believing it is the false success this
# check exists to catch.
#
# `plugins doctor` is the honest one — it really imports the plugin in a
# sandboxed temporary HERMES_HOME and prints what registered
# (hermes_cli/plugin_dev.py:84-107). Three signals are read from it, in order:
# the CLI's own `--ci` exit status (an error verdict); the doctor's own
# declared-vs-registered comparison, which names OUR hook when registration did
# not add it (hermes_cli/plugin_dev.py:342); and, for a box still carrying a
# manifest that declares nothing, "0 hook(s)" — the file loaded and registered
# nothing at all, which is precisely the state nothing else on the box reports.
#
# EVERY BOOT, not once behind a marker — the same reasoning as the browser
# toolset above. The state lives in Hermes' own tree, so a marker in ClawBox's
# data/ can drift from it, and anything that resets ~/.hermes without wiping
# data/ would leave the marker set and the plugin gone, permanently.
#
# Advisory: it must never hold up the web server. What it buys is a line in the
# log that says which of the two states the box is actually in.
#
# BOUNDED like every other `hermes` call here, and its exit status KEPT. The
# `|| EMAIL_HOOK_DOCTOR_RC=$?` is load-bearing under `set -e`, where a command
# substitution that exits non-zero aborts the assignment — i.e. a missing or
# refusing `hermes` would stop the boot here, over a DIAGNOSTIC.
if [ "$EMAIL_HOOK_INSTALLED" = "1" ]; then
  EMAIL_HOOK_DOCTOR_RC=0
  # `--ci` is the harness's OWN verdict: cmd_plugin_doctor raises SystemExit(1)
  # when the report carries an error, and stays 0 for warnings
  # (hermes_cli/plugins_cmd.py). Measured on the Hermes box 2026-09-04: rc 0 on a
  # healthy plugin that is still printing a WARN. Reading that status is what
  # this block should do instead of grepping a human-readable stream for the
  # word ERROR — the output is captured with 2>&1, and a Python `logging` line
  # from the agent import ("ERROR:hermes_cli.x:...") is indistinguishable from
  # the doctor's own "  ERROR: ..." to a substring match.
  #
  # A `hermes` too old for the flag exits non-zero without printing a report at
  # all; the "did it really answer" gate below turns that into the same NOTE as
  # any other unusable CLI, so the flag cannot manufacture a defect.
  EMAIL_HOOK_DOCTOR="$(timeout -k 5 "$HERMES_CLI_TIMEOUT" "$HERMES_BIN" plugins doctor "$EMAIL_HOOK_PLUGIN" --ci 2>&1)" \
    || EMAIL_HOOK_DOCTOR_RC=$?
  # The doctor's own words, trimmed to one line: "no register() function",
  # "No __init__.py in ...", an import traceback's last line. Naming the plugin
  # without naming the reason is what sends an operator to the wrong file. The
  # `|| :=""` for the same reason as the line above: no diagnostic may end the
  # boot, and under `pipefail` any stage of this is enough to do it.
  EMAIL_HOOK_DETAIL="$(printf '%s' "$EMAIL_HOOK_DOCTOR" | tr '\n' ' ' | cut -c1-300)" \
    || EMAIL_HOOK_DETAIL=""
  # ...and, for the branches that fire ON a verdict line, the verdict lines
  # themselves. The banner plus the manifest line is already ~110 characters on
  # the real box, so a head-of-output window is where the reason that triggered
  # the branch gets cut off — the branch would then report a defect and discard
  # the one sentence that says what to fix. Falls back to the head when the
  # doctor said nothing marked.
  # ERRORS FIRST, and `grep -m 3` rather than `| head -3`: under `pipefail` a
  # `head` that closes the pipe early makes the whole pipeline 141, and the `||`
  # then throws away the reason it had just computed. Errors first because the
  # REFUSED branch below fires on rc=1, which only an ERROR finding produces —
  # report order can put three WARNs ahead of it, and quoting those instead
  # drops the one sentence that says what to fix.
  # INDENTED, both of them: the doctor prints its own findings as "  ERROR: …"
  # and "  WARN: …", while the capture is 2>&1 and the doctor imports the whole
  # agent in a blank sandboxed HERMES_HOME — where one missing optional
  # dependency puts Python's default logging format on stderr FLUSH LEFT
  # ("ERROR:hermes_cli.x:…"). With `*` that line wins the errors-first
  # preference below and the boot log quotes a cause the branch did not fire
  # on, dropping the sentence that names the hook.
  EMAIL_HOOK_REASON="$(printf '%s\n' "$EMAIL_HOOK_DOCTOR" | grep -m 3 -E '^[[:space:]]+ERROR:' | tr '\n' ' ' | cut -c1-300)" \
    || EMAIL_HOOK_REASON=""
  [ -n "$EMAIL_HOOK_REASON" ] \
    || EMAIL_HOOK_REASON="$(printf '%s\n' "$EMAIL_HOOK_DOCTOR" | grep -m 3 -E '^[[:space:]]+WARN:' | tr '\n' ' ' | cut -c1-300)" \
    || EMAIL_HOOK_REASON=""
  [ -n "$EMAIL_HOOK_REASON" ] || EMAIL_HOOK_REASON="$EMAIL_HOOK_DETAIL"
  # One flattened copy of the report, and every match below is against it.
  # `rich.Console` wraps at 80 columns off a tty, so any line — the count, or a
  # finding sentence — can arrive split across two. Squeezing all whitespace to
  # single spaces once heals every one of them, and matching the raw capture
  # instead is how a reflow turns into a false verdict.
  EMAIL_HOOK_FLAT="$(printf '%s' "$EMAIL_HOOK_DOCTOR" | tr -s '[:space:]' ' ')" || EMAIL_HOOK_FLAT=""
  # The exit STATUS is read before the words. By the time `timeout` kills it the
  # doctor has usually printed its banner, and on the text alone that banner IS
  # the "ran and refused" branch below — so a wedged CLI would print a hard
  # WARNING about a hook that is very probably registered and working, on every
  # boot. Like the other unknowns this is a NOTE.
  #
  # BOTH 124 and 137, because `-k 5` makes 137 the usual answer for exactly the
  # wedge `-k` was added for: `timeout` signals its whole process group, and
  # SIGKILL cannot be ignored, so it kills ITSELF alongside the child that rode
  # out the SIGTERM and the caller reads 128+9. Matching 124 alone would send
  # that one input into the text case below. And 137 also arrives with no
  # `timeout` involved at all — the OOM killer on a loaded box, where `plugins
  # doctor` imports the whole agent — which says just as little about the hook.
  #
  # Neither code claims the CLI was killed: a child can exit with either itself,
  # and the two are indistinguishable from here.
  #
  # NO ELAPSED SPLIT HERE, unlike the OpenClaw twin, and that difference is
  # deliberate rather than drift. The twin splits 124/137 on the seconds burned
  # because it has a stamp and a 24 h backoff to protect, and stamping a cheap
  # kill costs a day of blindness. This script has neither: it runs once per
  # web-server boot, fire-and-forget, and asks again the next time regardless.
  # With nothing to protect there is nothing for the split to decide.
  if [ "$EMAIL_HOOK_DOCTOR_RC" = "124" ] || [ "$EMAIL_HOOK_DOCTOR_RC" = "137" ]; then
    log "NOTE: 'hermes plugins doctor' answered $EMAIL_HOOK_DOCTOR_RC — the ${HERMES_CLI_TIMEOUT}s ceiling (SIGTERM, then SIGKILL 5s later), a kill from outside, or the CLI's own exit code — so $EMAIL_HOOK_PLUGIN is installed and enabled but whether its hook registered is unknown here. hermes had printed: $EMAIL_HOOK_DETAIL"
  else
    case "$EMAIL_HOOK_FLAT" in
      *"registrations:"*|*"Plugin Doctor"*|*"registration failed"*)
        # The doctor RAN. Everything below is about WHAT it said; a CLI that
        # printed no report at all falls to the NOTE arm instead, which is what
        # keeps an unknown-flag or a too-old `hermes` from reading as a defect.
        if [ "$EMAIL_HOOK_DOCTOR_RC" = "1" ]; then
          # The harness's own verdict, not a word this script looked for. ONE,
          # not "any non-zero": `--ci` is documented as "exit non-zero when
          # validation reports an error" and raises SystemExit(1) for exactly
          # that (hermes_cli/plugins_cmd.py cmd_plugin_doctor). Another non-zero
          # code from a run that still printed a healthy report — a
          # BrokenPipeError at interpreter flush, a teardown raise on a loaded
          # Jetson, a SIGINT during a restart — says nothing about the hook, and
          # calling it a refusal would be a false failure on a working box.
          log "WARNING: the doctor REFUSED $EMAIL_HOOK_PLUGIN — EMAIL: directives will still reach channels. hermes plugins doctor said: $EMAIL_HOOK_REASON"
        elif [ "$EMAIL_HOOK_DOCTOR_RC" != "0" ]; then
          log "NOTE: 'hermes plugins doctor' printed a report for $EMAIL_HOOK_PLUGIN and then exited $EMAIL_HOOK_DOCTOR_RC — not the error verdict --ci defines, so whether its hook registered is unknown here. hermes had printed: $EMAIL_HOOK_REASON"
        else
          case "$EMAIL_HOOK_FLAT" in
            *"declares hook '$EMAIL_HOOK_NAME' but registration did not add it"*\
            |*"declares hook '$EMAIL_HOOK_INBOUND_NAME' but registration did not add it"*)
              # THE name check, and the reason the manifest half of this change
              # exists. Declaring `provides_hooks` makes the doctor compare what
              # was declared against what register() actually added and warn BY
              # NAME when ours is missing (hermes_cli/plugin_dev.py:342) — the
              # Hermes equivalent of the OpenClaw twin's `"reply_payload_sending"
              # in names`. It catches what no count can: a register() that adds a
              # DIFFERENT valid hook still prints "1 hook(s)" with no error.
              #
              # BOTH NAMES, because this plugin now has two hooks and a box that
              # loaded only one of them is a box where either the EMAIL: line
              # reaches a channel or the owner's "send <code>" is answered by
              # the agent instead of the queue. The doctor names the missing one
              # in the line quoted below, so one arm covers both.
              #
              # This direction ONLY. The opposite finding at :343 ("registration
              # adds hook X not listed in provides_hooks") means we registered
              # something EXTRA, which says nothing about ours being missing —
              # warning on it would put "directives may still reach channels" in
              # the boot log of a box where they are being stripped correctly.
              log "WARNING: $EMAIL_HOOK_PLUGIN did not register one of its hooks — EMAIL: directives may still reach channels, and approving a queued email from Telegram will not work. hermes plugins doctor said: $EMAIL_HOOK_REASON"
              ;;
            *" 0 hook(s)"*)
              # The one thing the name check cannot see: a box still carrying a
              # manifest that declares nothing — the boot before this change's
              # plugin.yaml lands. Nothing declared means no comparison and no
              # warning, so "it registered nothing at all" is the only evidence
              # left. Left-anchored on the space, which is what keeps it off the
              # "0" inside "10 hook(s)"; the flattened capture is what makes a
              # wrapped count line one string again.
              log "WARNING: $EMAIL_HOOK_PLUGIN did not register its hook — EMAIL: directives will still reach channels. hermes plugins doctor said: $EMAIL_HOOK_REASON"
              ;;
            *"registration failed"*)
              # The doctor said so in as many words, without an error verdict
              # to go with it. Kept as its own arm: it carries no `registrations:`
              # line, so neither of the two checks above can see it.
              log "WARNING: $EMAIL_HOOK_PLUGIN did not register its hook — EMAIL: directives will still reach channels. hermes plugins doctor said: $EMAIL_HOOK_REASON"
              ;;
            *"registrations:"*)
              # No error verdict, and the doctor did not say our hook is
              # missing — with the manifest declaring it, that IS the check.
              # The count is deliberately not consulted here: a plugin that
              # registers ours PLUS a second hook prints "2 hook(s)" and is
              # perfectly healthy, and matching `1 hook(s)` called that a defect
              # (while also reading "11 hook(s)" as a success — the bug this
              # change was opened for; it is gone because the count is gone).
              log "$EMAIL_HOOK_PLUGIN loaded and registered its outbound and inbound hooks"
              ;;
            *)
              # A report with no registration line at all. `format_text()` always
              # prints one, so this is a shape this script does not understand —
              # and an unread verdict is not a healthy one.
              log "WARNING: $EMAIL_HOOK_PLUGIN did not register its hook — EMAIL: directives will still reach channels. hermes plugins doctor said: $EMAIL_HOOK_REASON"
              ;;
          esac
        fi
        ;;
      *)
        # The doctor could not answer at all — a `hermes` too old for the
        # subcommand or for `--ci`, one that is not there (127) or not
        # executable (126). Reported as UNKNOWN rather than as a defect: saying
        # "directives will still reach channels" about a box where the hook is
        # registered and working is a false failure, and an operator who sees it
        # every boot stops reading the line that matters.
        log "NOTE: could not verify $EMAIL_HOOK_PLUGIN with 'hermes plugins doctor' — the plugin is installed and enabled, but whether its hook registered is unknown here. hermes said: $EMAIL_HOOK_DETAIL"
        ;;
    esac
  fi
fi
