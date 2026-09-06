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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLAWBOX_HOME_DIR="${CLAWBOX_HOME_DIR:-${HOME:-/home/clawbox}}"
CLAWBOX_ROOT="${CLAWBOX_ROOT:-$CLAWBOX_HOME_DIR/clawbox}"
CLAWBOX_PORT="${CLAWBOX_PORT:-80}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$CLAWBOX_HOME_DIR/.npm-global/bin/openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-${CLAWBOX_OPENCLAW_HOME:-${OPENCLAW_HOME:-$CLAWBOX_HOME_DIR/.openclaw}}/openclaw.json}"
# Every `openclaw` below, and the scripts this one launches, must read and
# write THAT file. The CLI does not look at OPENCLAW_CONFIG: it takes
# OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR when set and otherwise derives
# its tree from OPENCLAW_HOME — which it reads as the ACCOUNT home, so the
# state lands in `$OPENCLAW_HOME/.openclaw`. ClawBox has always used that
# name for the .openclaw directory itself, and the updater exported it into
# this script: the CLI then built a second tree at ~/.openclaw/.openclaw/ and
# wrote the memory-search switch there while the real config stayed
# half-written (2026-09-04). The two canonical overrides win over
# OPENCLAW_HOME, and the misread name is dropped from the environment so no
# child can inherit it. Neither reaches the gateway: ExecStartPre's
# environment ends with it.
export OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG"
# Assigned apart from the export: `export X="$(cmd)"` answers with export's
# own status, so a dirname that failed would have handed every child an EMPTY
# state dir behind a clean exit. As a plain assignment the substitution's
# status is the line's, and `set -e` stops this ExecStartPre on it instead.
OPENCLAW_STATE_DIR="$(dirname "$OPENCLAW_CONFIG")"
export OPENCLAW_STATE_DIR
unset OPENCLAW_HOME
HOSTNAME_ENV="${HOSTNAME_ENV:-$CLAWBOX_ROOT/data/hostname.env}"

# Pinned OpenClaw target — external plugins (e.g. @openclaw/codex) must stay
# locked to the same version as the core, or they drift ahead via @latest and
# crash at runtime against the pinned core. Read from the repo pin file, same
# source install.sh and updater.ts use. Empty = pin unknown, fall back to the
# unpinned alias (preserves old behaviour rather than risk skipping a repair).
OPENCLAW_TARGET=""
OPENCLAW_PIN_FILE="${OPENCLAW_PIN_FILE:-$CLAWBOX_ROOT/config/openclaw-target.txt}"
if [ -n "${OPENCLAW_PIN_VERSION:-}" ]; then
  OPENCLAW_TARGET="${OPENCLAW_PIN_VERSION}"
elif [ -f "$OPENCLAW_PIN_FILE" ]; then
  # `|| true`: the file exists, but a read can still fail (permissions, a
  # truncated mount), and under `set -euo pipefail` a failed pipeline in an
  # assignment aborts this ExecStartPre — which means no gateway at all. An
  # empty target is already a defined state here (see above); an aborted boot
  # is not. TASK-657.
  OPENCLAW_TARGET=$(head -1 "$OPENCLAW_PIN_FILE" 2>/dev/null | awk '{print $1}' || true)
  if [ -z "$OPENCLAW_TARGET" ]; then
    # Say it, for the same reason the two installer copies of this read do — and
    # here the empty value is not merely a missing pin. It also switches OFF the
    # codex version-skew guard below and turns CODEX_SPEC into the bare `codex`
    # alias, which this file's own comment says makes every Codex chat crash
    # with `createDiagnosticTraceContextFromActiveScope is not a function`.
    # Reaching a defined-but-costly state through a NEW silent route is what
    # needs the line.
    echo "  WARN: $OPENCLAW_PIN_FILE is empty or could not be read — continuing with no pinned OpenClaw target" >&2
  fi
fi

if [ ! -x "$OPENCLAW_BIN" ]; then
  exit 0
fi

# OpenClaw 2 (>= 2026.8) renamed the config homes this script writes:
# messages.tts -> tts, agents.defaults.imageGenerationModel ->
# agents.defaults.mediaModels.image, tools.media.audio.models ->
# tools.media.models (rows carry capabilities: ["audio"]), and retired
# gateway.controlUi.allowInsecureAuth / dangerouslyDisableDeviceAuth.
# v2 also REFUSES a config carrying the legacy keys once its own loader
# migration has produced the new ones, so writing the old names against a
# v2 gateway does not degrade politely — it kept this gateway from ever
# reporting ready. The INSTALLED core is the authority and the ONLY source:
# it is the process that will parse what this script writes. The pinned
# target is deliberately NOT a fallback — a partially failed update (repo
# synced, npm install not yet done) leaves pin=2026.8.1 with a 2026.7 core,
# and that is exactly the state in which the core cannot be read, so a pin
# fallback would fire precisely when it is wrong: v2 keys a v1 gateway
# refuses, and the controlUi auth switches v1 still needs deleted.
#
# Read from the core's own package.json -- the file the binary IS -- rather than
# by RUNNING it. Two reasons, and the second is TASK-657:
#
#   1. `openclaw --version` costs ~10 s on a Jetson (measured on a shipped Orin:
#      7904 ms and 8044 ms; the package.json read is 53 ms) and this is a
#      BLOCKING ExecStartPre. Both siblings that ask this same question already
#      refuse the CLI for exactly that reason and say so in writing --
#      scripts/ensure-local-embeddings.sh and src/lib/memory-shard.ts.
#   2. The old pipeline FAILED whenever the CLI could not answer: `grep -oE`
#      exits 1 on no match, a crashed binary or a node engine mismatch exits
#      non-zero, and `pipefail` carried either into the assignment, which under
#      `set -e` aborted the WHOLE pre-start. That box got no gateway and no chat
#      at all, with the only trace in the unit's failure -- while the paragraph
#      above was already written as though an empty result was what happened.
CLAWBOX_OPENCLAW_PKG="$(dirname "$OPENCLAW_BIN")/../lib/node_modules/openclaw/package.json"
CLAWBOX_OPENCLAW_EFFECTIVE="$(python3 - "$CLAWBOX_OPENCLAW_PKG" <<'PY' 2>/dev/null || true
import json, sys
try:
    v = json.load(open(sys.argv[1])).get("version")
except Exception:
    v = None
print(v if isinstance(v, str) else "")
PY
)"
# The manifest read accepted any non-empty string while the fallback below
# applied this regex, so the stricter of the two was the one almost never
# reached: a core whose version is not 20YY.M.P -- a dev or nightly build, a
# fork, an `npm i -g <git url>` install, a vendor rebuild -- yielded a non-empty
# value that sailed past the "write nothing" guard and picked v1 semantics for a
# core that may well be v2, whose loader then refuses the legacy names this
# script would write. A version that is not a date says nothing about the
# generation, so it must read as "unknown".
#
# ANCHORED, and the two sources are deliberately NOT graded alike. This one is
# a version FIELD, so the whole string has to be the version. The CLI fallback
# below reads a BANNER, where the version is one token among words this script
# does not control, so it can only extract -- which means a `--version` that
# happens to mention any other 20YY.M.P (a "built from" note, a schema warning
# on its own line) is taken at face value there. Tightening that arm needs the
# real banner of a shipped core measured on a box, not a guess: an anchor that
# is wrong by one space turns every healthy fallback into "cannot identify the
# core" and skips the whole pre-start fleet-wide, which is worse than the state
# it would close. Recorded rather than guessed at; the manifest is the source
# that answers on every ordinary box, and it is the one that is strict.
CLAWBOX_OPENCLAW_EFFECTIVE="$(printf '%s' "$CLAWBOX_OPENCLAW_EFFECTIVE" | grep -oE '^20[0-9]{2}\.[0-9]+\.[0-9]+' || true)"
# Second source, and time-boxed. `|| true` only rescues a CLI that RETURNS: a
# wedged `--version` (an import that never resolves, an fs stall, a SQLite lock)
# would hold ExecStartPre until TimeoutStartSec killed the unit, and
# Restart=always would then spend StartLimitBurst on a box that never comes up.
# 45 s, justified on this call's OWN measurement rather than on any precedent:
# `openclaw --version` costs 7.9-8.0 s on a shipped Orin, a cold first boot is
# the slow case, so the bound has to leave several multiples of that as headroom
# or it cuts off a HEALTHY core and makes the fallback useless exactly when it is
# needed. It also has to stay far inside the unit's own TimeoutStartSec=600, and
# running out of time here means skipping the whole pre-start (below), not
# aborting. `-k 5` because plain `timeout` sends SIGTERM only: a `--version` that
# ignores it would hold this ExecStartPre for the unit's entire start budget,
# which is precisely the outcome the bound exists to prevent.
if [ -z "$CLAWBOX_OPENCLAW_EFFECTIVE" ]; then
  CLAWBOX_OPENCLAW_EFFECTIVE="$(timeout -k 5 45 "$OPENCLAW_BIN" --version 2>/dev/null | grep -oE '20[0-9]{2}\.[0-9]+\.[0-9]+' | head -1 || true)"
fi
# And if the installed core cannot be identified at all, WRITE NOTHING. The pin
# is deliberately not a fallback here: a partially failed update (repo synced,
# npm install unfinished) is precisely the state in which the core cannot answer,
# and it is also the state in which the pin is ahead of the binary -- so guessing
# from it would write v2 keys a v1 gateway refuses AND permanently delete
# commands.ownerDisplay, gateway.tailscale.resetOnExit and
# agents.defaults.compaction.reserveTokensFloor, which nothing on the boot path
# re-adds. The config on disk booted this box before; leaving it alone is the
# only option here that cannot make a working box stop working. A box with no
# core at all already exited 0 a few lines above.
# An explicit CLAWBOX_OPENCLAW_V2 in the environment wins — the unit tests
# pin BOTH generations of this script against fixture configs, and they must
# not follow whatever the box's own pin file happens to say. It has to be
# checked BEFORE the give-up below, not after: with the `exit 0` above it, a
# pinned generation became a silent no-op on any box whose core could not be
# identified, while the comment here still said it wins.
if [ -z "${CLAWBOX_OPENCLAW_V2:-}" ]; then
  if [ -z "$CLAWBOX_OPENCLAW_EFFECTIVE" ]; then
    # Not a small skip. Everything below this line is skipped, and most of it is
    # not generation-sensitive at all, so the WARN has to name what this boot
    # does NOT re-apply rather than sound like "one rewrite was left out".
    echo "  WARN: cannot tell which OpenClaw generation is installed ($CLAWBOX_OPENCLAW_PKG carries no usable version and $OPENCLAW_BIN did not answer)." >&2
    echo "  WARN: leaving openclaw.json exactly as it is and starting the gateway on it." >&2
    echo "  WARN: this boot therefore does NOT re-apply the gateway auth token, the messaging-channel security pass, the gateway.controlUi.allowedOrigins rebuild (a changed LAN IP is not picked up), the @openclaw/codex plugin install and repair, the deepseek catalog patch, the CLAWBOX.md workspace guide, the MCP token seeding or the MCP registration reconcile." >&2
    exit 0
  fi
  CLAWBOX_OPENCLAW_V2=0
  if [ "$(printf '%s\n' 2026.8 "$CLAWBOX_OPENCLAW_EFFECTIVE" | sort -V | head -1)" = "2026.8" ]; then
    CLAWBOX_OPENCLAW_V2=1
  fi
fi
export CLAWBOX_OPENCLAW_V2

# Resolve configured mDNS hostname (defaults to "clawbox" if unset/invalid)
CONFIGURED_HOSTNAME="clawbox"
if [ -f "$HOSTNAME_ENV" ]; then
  # Parse HOSTNAME=... without executing the file (avoid arbitrary code execution).
  # `|| true` for the same reason as the pin read above: `sed` exits non-zero on
  # a file it cannot open, and an unreadable hostname file must cost this box its
  # configured mDNS name, never its gateway. The regex below already rejects the
  # empty result and keeps the "clawbox" default. TASK-657.
  _h=$(sed -n 's/^[[:space:]]*HOSTNAME[[:space:]]*=[[:space:]]*//p' "$HOSTNAME_ENV" | head -n1 || true)
  _h="${_h%\"}"; _h="${_h#\"}"
  _h="${_h%\'}"; _h="${_h#\'}"
  if [[ "$_h" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
    CONFIGURED_HOSTNAME="$_h"
  else
    # Not silent: this name feeds gateway.controlUi.allowedOrigins below, so a
    # boot that falls back here rebuilds that list around "clawbox.local" and
    # drops the configured one — which is the "origin not allowed" failure the
    # comment further down exists to prevent.
    echo "  WARN: no usable HOSTNAME in $HOSTNAME_ENV — using the default mDNS name \"clawbox\"" >&2
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
export CLAWBOX_PORT
# The migrations below resolve $CLAWBOX_ROOT/.env and the local-AI token from
# this value; without the export python falls back to the compiled-in default
# and the two disagree on any box whose root is not /home/clawbox/clawbox.
export CLAWBOX_ROOT
# Serialize the LAN_IPS bash array into an env var Python can parse —
# newline-separated is bash-safe (IPv4s contain no newlines).
if [ ${#LAN_IPS[@]} -gt 0 ]; then
  printf -v CLAWBOX_LAN_IPS '%s\n' "${LAN_IPS[@]}"
else
  CLAWBOX_LAN_IPS=""
fi
export CLAWBOX_LAN_IPS

# Trusted control UI origins — a narrow escape hatch for genuinely
# cross-origin/custom-origin Control UI deployments (see README and
# scripts/gateway_origins.py). Same-origin access via `<hostname>.local`,
# `.ts.net`, or a private LAN IP already works without any entry here.
# Loaded from CLAWBOX_CONTROL_UI_ORIGINS_FILE (or the module's default
# path) via scripts/gateway_origins.py. Missing helper module or missing
# config file both fall through to "no extras" — defaults still boot.
CLAWBOX_EXTRA_ORIGINS="$(CLAWBOX_GATEWAY_ORIGINS_SCRIPT_DIR="$SCRIPT_DIR" python3 - <<'PY'
import os, sys

script_dir = os.environ.get("CLAWBOX_GATEWAY_ORIGINS_SCRIPT_DIR", "")
if script_dir:
    sys.path.insert(0, script_dir)

try:
    import gateway_origins
except Exception as exc:
    print(
        "  WARN: trusted control UI origins helper unavailable "
        f"({type(exc).__name__}); using defaults only",
        file=sys.stderr,
    )
    sys.exit(0)

try:
    path = gateway_origins.resolve_origins_path()
    origins, warnings = gateway_origins.load_configured_origins(path)
except Exception as exc:
    print(
        "  WARN: trusted control UI origins helper failed "
        f"({type(exc).__name__}); using defaults only",
        file=sys.stderr,
    )
    sys.exit(0)
for warning in warnings:
    print(f"  WARN: {warning}", file=sys.stderr)
for origin in origins:
    print(origin)
PY
)"
if [ -n "$CLAWBOX_EXTRA_ORIGINS" ]; then
  while IFS= read -r origin; do
    [ -n "$origin" ] && echo "  Trusted control UI origin: $origin"
  done <<<"$CLAWBOX_EXTRA_ORIGINS"
fi
export CLAWBOX_EXTRA_ORIGINS

# The device store the Next app writes (`data/config.json`), not openclaw.json.
# The cloud-voice migration below needs the portal-confirmed plan stamp that
# lives there, and only there. Exported rather than passed as a second argv so
# the block keeps the single-argument shape every other python heredoc here has.
export CLAWBOX_DEVICE_STORE="$CLAWBOX_ROOT/data/config.json"

python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, sys, tempfile, secrets, shutil, time

# OpenClaw 2 config homes — see the bash block that computes this.
CLAWBOX_OPENCLAW_V2 = os.environ.get("CLAWBOX_OPENCLAW_V2") == "1"

# Gateway auth token gates LAN access to the agent's privileged tools
# (run_command / file_write / system_power). Earlier builds wrote the public
# literal "clawbox" — documented in the open-source history — so any device
# carrying it is an unauthenticated-LAN-access risk. A strong per-device token
# must be PRESERVED once set: the configure route's random hex, a `${ENV}`
# interpolation, or a SecretRef object are all legitimate strong values we
# must not clobber back to the literal.
LEGACY_GATEWAY_TOKEN = "clawbox"
MIN_GATEWAY_TOKEN_LENGTH = 32

def is_strong_gateway_token(v):
    # SecretRef object — managed externally. OpenClaw stores canonical refs as
    # {source, provider, id}. Reject legacy key-style, providerless, partial,
    # and extra-key objects: current OpenClaw rejects all of those shapes.
    if isinstance(v, dict):
        source = v.get("source")
        ref_id = v.get("id")
        if source in ("env", "file", "exec") and isinstance(ref_id, str) and ref_id.strip():
            provider = v.get("provider")
            if set(v) == {"source", "provider", "id"} and isinstance(provider, str) and provider.strip():
                return True
        return False
    if isinstance(v, str):
        # `${VAR}` interpolation (non-empty body) resolves from env at runtime.
        if v.startswith("${") and v.endswith("}") and len(v) > 3:
            return True
        return v != LEGACY_GATEWAY_TOKEN and len(v) >= MIN_GATEWAY_TOKEN_LENGTH
    return False

cfg_path = sys.argv[1]
hostname = os.environ.get("CLAWBOX_HOSTNAME", "clawbox")
lan_ips = [line for line in os.environ.get("CLAWBOX_LAN_IPS", "").split("\n") if line]
extra_origins = [line for line in os.environ.get("CLAWBOX_EXTRA_ORIGINS", "").split("\n") if line]

allowed_origins = [
    f"http://{hostname}.local",
    "http://localhost",
    "http://127.0.0.1",
    "http://10.42.0.1",
    "http://10.43.0.1",
    *lan_ips,
]
port = os.environ.get("CLAWBOX_PORT", "80").strip()
if port and port != "80":
    allowed_origins.extend([
        f"http://{hostname}.local:{port}",
        f"http://localhost:{port}",
        f"http://127.0.0.1:{port}",
        *(f"{origin}:{port}" for origin in lan_ips),
    ])
# Merge already-validated extra origins (scripts/gateway_origins.py) into the
# generated defaults, deterministically and before the set comparison below —
# defaults first, extras appended in file order, de-duplicated.
for _extra in extra_origins:
    if _extra not in allowed_origins:
        allowed_origins.append(_extra)

try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except OSError as err:
    # The file EXISTS and could not be opened (a mode, an ACL, an I/O error).
    # Neither of the two obvious answers is safe here. Letting it escape aborts
    # this ExecStartPre under `set -e`, so the box gets no gateway at all, on
    # every boot, until someone with shell access fixes the mode -- and
    # openclaw.json is clawbox-owned, so an agent can reach that from a chat
    # turn. Answering {} is worse: that object is written back below, and a
    # config that merely could not be READ would lose every provider, auth
    # profile and channel. PermissionError is not a FileNotFoundError, so the
    # arm above never covered this. Leave the file alone and boot on it, the
    # same policy the generation probe settles on further up.
    # `err.strerror` rather than `err`: str(OSError) carries the full path, which
    # the basename above was chosen to keep out of the line.
    print(
        f"  WARN: {os.path.basename(cfg_path)} could not be read "
        f"({err.strerror or type(err).__name__}); leaving it exactly as it is "
        f"and starting the gateway on it",
        file=sys.stderr,
    )
    # Not a small skip, and the same understatement the generation give-up was
    # corrected for further up: SystemExit ends this whole program, so this boot
    # also does NOT re-apply the gateway auth token, the messaging-channel
    # security pass, the gateway.controlUi.allowedOrigins rebuild (a changed LAN
    # IP is not picked up), the model catalog or the provider blocks.
    #
    # The MCP registration reconcile is named too, and it is the one that is
    # SILENT rather than skipped: the shell carries on past this program and runs
    # it, but that block's own `except (OSError, json.JSONDecodeError)` exits 0
    # on the same unreadable file, so its `if !` guard prints nothing and the
    # registration no-ops without a word. Say it here, where the cause is known.
    print(
        "  WARN: this boot therefore does NOT re-apply the gateway auth token, "
        "the messaging-channel security pass, the gateway.controlUi.allowedOrigins "
        "rebuild (a changed LAN IP is not picked up), the model catalog, the "
        "provider blocks or the MCP server registration.",
        file=sys.stderr,
    )
    raise SystemExit(0)
except (json.JSONDecodeError, UnicodeDecodeError) as err:
    # UnicodeDecodeError is a ValueError, NOT a JSONDecodeError and NOT an
    # OSError, so a config holding bytes that are not valid UTF-8 escaped all
    # three arms and took the ExecStartPre down with a traceback -- on every
    # boot, until someone with shell access fixed the file. That is the same
    # class as the arm above, one exception type over, and it is reached by the
    # same event this backup exists for: a power loss mid-write on a Jetson
    # leaves arbitrary bytes here, not a truncated but decodable string.
    # "Corrupt" is the right verdict for both, and the .corrupt-<utc> copy below
    # preserves the bytes either way.
    #
    # Corrupt file — start from an empty object and let the gateway re-seed on
    # first write; the alternative is refusing to boot. But that {} is written
    # back below, and until it was copied first the write replaced every
    # provider, auth profile and channel with an allowedOrigins-only file and
    # logged "Updated gateway config" — the same fragment overwrite the setup
    # writers refuse in src/lib/openclaw-config.ts. So the previous contents
    # are kept beside the file as openclaw.json.corrupt-<utc> BEFORE anything
    # replaces them. (src/tests/unit/gateway-pre-start-corrupt-config.test.ts
    # extracts this block by its first and last lines.)
    backup = f"{cfg_path}.corrupt-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    try:
        shutil.copy2(cfg_path, backup)
        kept = f"previous contents kept at {backup}"
    except OSError as copy_err:
        kept = f"previous contents could NOT be copied aside ({copy_err})"
    print(
        f"  WARN: {os.path.basename(cfg_path)} is not valid JSON ({err}); "
        f"re-seeding from an empty object, {kept}",
        file=sys.stderr,
    )
    cfg = {}

changed = False

# OpenClaw 2 moved/retired these v1 state and tuning fields. Doctor normally
# removes them, but plugin-verification failures can make doctor exit before
# it writes the repaired config, leaving the gateway in a permanent loop.
# They remain valid on v1, so never run this cleanup there.
if CLAWBOX_OPENCLAW_V2:
    meta = cfg.get("meta")
    if isinstance(meta, dict) and "lastTouchedAt" in meta:
        del meta["lastTouchedAt"]
        changed = True
    commands = cfg.get("commands")
    if isinstance(commands, dict) and "ownerDisplay" in commands:
        del commands["ownerDisplay"]
        changed = True
    tailscale = (cfg.get("gateway") or {}).get("tailscale") if isinstance(cfg.get("gateway"), dict) else None
    if isinstance(tailscale, dict) and "resetOnExit" in tailscale:
        del tailscale["resetOnExit"]
        changed = True

# Strip invalid agent keys that prevent gateway from starting.
# `agents` and `agents.defaults` are not guaranteed to be objects either: a
# hand-edited or half-written config leaves a scalar or a null there, and
# `setdefault` returns it rather than a dict — every `.get` below then raises
# AttributeError, which under `set -euo pipefail` aborts ExecStartPre and the
# gateway never reaches ExecStart at all. Same coercion, same reasoning, as the
# `models` containers further down.
_agents_block = cfg.get("agents")
if not isinstance(_agents_block, dict):
    if _agents_block is not None:
        print("  WARN: agents was not an object; replacing it — OpenClaw's schema requires one")
        changed = True
    _agents_block = {}
    cfg["agents"] = _agents_block
agents_defaults = _agents_block.get("defaults")
if not isinstance(agents_defaults, dict):
    if agents_defaults is not None:
        print("  WARN: agents.defaults was not an object; replacing it")
        changed = True
    agents_defaults = {}
    _agents_block["defaults"] = agents_defaults
for k in ("tools", "systemPromptSuffix"):
    if k in agents_defaults:
        del agents_defaults[k]
        changed = True
if CLAWBOX_OPENCLAW_V2:
    compaction = agents_defaults.get("compaction")
    if isinstance(compaction, dict) and "reserveTokensFloor" in compaction:
        del compaction["reserveTokensFloor"]
        changed = True

# Model migration: some early ClawBox images/configs can leave the active
# primary on Anthropic's retired May 2025 Sonnet id. New OpenClaw builds no
# longer recognize it, so every chat turn fails before the agent can reply.
# Move only those known-dead defaults back to the bundled local model; a user
# can still re-authorize ClawBox AI / ChatGPT afterward.
model_defaults = agents_defaults.get("model")
if not isinstance(model_defaults, dict):
    if model_defaults is not None:
        print("  WARN: agents.defaults.model was not an object; replacing it")
        changed = True
    model_defaults = {}
    agents_defaults["model"] = model_defaults
primary_model = model_defaults.get("primary")
if isinstance(primary_model, str) and primary_model.lower() in (
    "anthropic/claude-sonnet-4-20250514",
    "claude-cli/claude-sonnet-4-20250514",
):
    model_defaults["primary"] = "llamacpp/gemma4-e2b-it-q4_0"
    changed = True

# Migration: a primary (or fallback) that names `llamacpp/<model>` while
# `models.providers.llamacpp` is absent. OpenClaw ships an `ollama` plugin but
# NO llamacpp one, so `llamacpp/*` resolves ONLY through an explicit provider
# entry. Without it every chat turn dies before the agent can reply:
#
#   [model-fallback/decision] decision=candidate_failed
#       requested=llamacpp/gemma4-e2b-it-q4_0 reason=model_not_found next=none
#   Embedded agent failed before reply: Unknown model: llamacpp/gemma4-e2b-it-q4_0
#
# Measured on a freshly-provisioned Orin Nano: `models.providers` was `{}` from
# the install onward, and the dead-Anthropic migration directly above then moved
# `primary` onto the local model — swapping one unresolvable id for another and
# leaving the box just as mute. The device's OWN status route reports the model
# `available: true` the whole time (it reads the llamacpp runtime, which is
# genuinely installed and answers on its proxy), so nothing surfaces the gap.
#
# `ai-models/configure` writes this entry on the local-AI path, but a box that
# reaches llamacpp through the migration above — or through an image that
# pre-set `primary` — never runs that route. Same shape, and the same fix, as
# the OpenRouter provider-def migration further down.
#
# Keep in step with the isLlamaCpp branch of
# src/app/setup-api/ai-models/configure/route.ts and the constants in
# src/lib/llamacpp.ts; a shell migration cannot import them.
_llamacpp_refs = []
_primary_now = model_defaults.get("primary")
if isinstance(_primary_now, str):
    _llamacpp_refs.append(_primary_now)
_fallbacks_now = model_defaults.get("fallbacks")
if isinstance(_fallbacks_now, list):
    _llamacpp_refs.extend([f for f in _fallbacks_now if isinstance(f, str)])
# The runtime trims the ref before it checks the prefix, so " llamacpp/x " starts
# the local runtime but would skip this repair and still fail model resolution.
_wants_llamacpp = [r.strip() for r in _llamacpp_refs if r.strip().startswith("llamacpp/")]

# One row per DISTINCT id, in the order they are configured. Registering only
# the first left a second llamacpp id among the fallbacks resolving to "Unknown
# model" — the very failure this migration exists to remove. An EMPTY id (a bare
# "llamacpp/") is dropped rather than written: ModelDefinitionSchema requires
# id.min(1), so a row of {"id": "", "name": ""} makes the WHOLE openclaw.json
# fail validation, and a box that merely could not answer ends up with a gateway
# that cannot load its config at all.
_llamacpp_model_ids = []
for _ref in _wants_llamacpp:
    _model_id = _ref[len("llamacpp/"):].strip()
    if _model_id and _model_id not in _llamacpp_model_ids:
        _llamacpp_model_ids.append(_model_id)

_models_now = cfg.get("models")
_providers_now = _models_now.get("providers") if isinstance(_models_now, dict) else None
_llamacpp_entry = _providers_now.get("llamacpp") if isinstance(_providers_now, dict) else None

# PRESENT is not the same as USABLE, and "usable" means exactly what OpenClaw's
# own schema means by it — read off the installed package rather than guessed:
#
#   ModelProvidersSchema.superRefine  a non-built-in provider id (llamacpp is
#                                     not in BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS)
#                                     needs a truthy `baseUrl` and an array
#                                     `models`. `api` and `apiKey` are optional.
#   ModelDefinitionSchema             every row needs `id` AND `name`, both
#                                     .min(1).
#
# Key presence alone treated an existing `{}` as a deliberate operator choice,
# but such an entry fails validation outright — strictly worse than the "Unknown
# model" this migration exists to fix. So fill exactly what the schema is
# missing and nothing else: an entry OpenClaw already accepts is never touched,
# and `api`/`apiKey` are not invented on one that chose to omit them.
_llamacpp_gaps = []
_llamacpp_rows = []
_llamacpp_dropped_rows = 0
_llamacpp_named_rows = 0
_llamacpp_trimmed_rows = 0
if _wants_llamacpp:
    _entry_now = _llamacpp_entry if isinstance(_llamacpp_entry, dict) else {}
    _base_url_now = _entry_now.get("baseUrl")
    if not (isinstance(_base_url_now, str) and _base_url_now.strip()):
        _llamacpp_gaps.append("baseUrl")
    _entry_models = _entry_now.get("models")
    if isinstance(_entry_models, list):
        # Keep the operator's rows and repair them in place. A row with an id
        # and no `name` fails the schema exactly as an empty id does, and is
        # trivially completable; a row naming no model at all cannot be
        # repaired into one, so it is dropped and counted.
        #
        # The id is TRIMMED into the kept row, not only into the comparison
        # below. `_llamacpp_have_ids` strips before matching, so a padded id
        # satisfies the "this row already exists" test and nothing is appended —
        # while the row that stays in the file keeps its padding, and the
        # harness matches a row id with a strict `==` against a ref it has
        # already normalised. The migration would print "Completed", the gateway
        # would start, and every turn would still end "Unknown model", which is
        # the exact failure this block exists to remove. Counted for the same
        # reason `_llamacpp_named_rows` is: on an entry whose baseUrl is already
        # usable nothing else makes `models` a gap, so an uncounted correction
        # is computed and never written.
        for _row in _entry_models:
            _row_id = _row.get("id") if isinstance(_row, dict) else None
            if not (isinstance(_row_id, str) and _row_id.strip()):
                _llamacpp_dropped_rows += 1
                continue
            _row = dict(_row)
            if _row["id"] != _row_id.strip():
                _row["id"] = _row_id.strip()
                _llamacpp_trimmed_rows += 1
            _row_name = _row.get("name")
            if not (isinstance(_row_name, str) and _row_name.strip()):
                _row["name"] = _row_id.strip()
                _llamacpp_named_rows += 1
            _llamacpp_rows.append(_row)
    # Missing rows are APPENDED, never a replacement: an entry that lists one
    # model while `primary`/`fallbacks` name another left the box mute with
    # "Unknown model" and said nothing, because the entry looked complete.
    _llamacpp_have_ids = {_r["id"] for _r in _llamacpp_rows}
    _llamacpp_missing_ids = [i for i in _llamacpp_model_ids if i not in _llamacpp_have_ids]
    if (
        not isinstance(_entry_models, list)
        or _llamacpp_missing_ids
        or _llamacpp_dropped_rows
        or _llamacpp_named_rows
        or _llamacpp_trimmed_rows
    ):
        _llamacpp_gaps.append("models")

_clawbox_root = os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox")

if _wants_llamacpp and _llamacpp_gaps and not _llamacpp_model_ids:
    print(
        "  Skipped llamacpp provider repair: "
        + _wants_llamacpp[0]
        + " names no model id, and a provider row with an empty id fails"
        + " OpenClaw's schema for the whole config."
    )
elif _wants_llamacpp and _llamacpp_gaps:
    # The proxy authenticates openclaw -> Next.js with a per-install bearer
    # (src/lib/local-ai-token.ts). Writing OUR baseUrl WITHOUT it would trade
    # "Unknown model" for a 401 on every turn, which is not an improvement, so a
    # box with no token file is left alone and told why. The guard keys on
    # whether we are about to point the entry at our proxy, NOT on whether
    # `apiKey` happens to be absent: an entry naming the operator's own
    # llama-server needs no token from us, and refusing there would leave their
    # config invalid over a credential it never wanted.
    _llamacpp_takes_proxy = "baseUrl" in _llamacpp_gaps
    _token_path = os.path.join(_clawbox_root, "data", ".local-ai-token")
    try:
        with open(_token_path) as _tf:
            _local_ai_token = _tf.read().strip()
    except OSError:
        _local_ai_token = ""

    if _llamacpp_takes_proxy and len(_local_ai_token) < 16:
        print(
            "  Skipped llamacpp provider repair: "
            + _wants_llamacpp[0]
            + " is configured but "
            + _token_path
            + " is missing or too short, so the proxy would reject every call."
            + " The entry still has no models.providers.llamacpp.baseUrl, which"
            + " OpenClaw's schema requires for this provider, so the gateway"
            + " will refuse this config until that file is restored."
        )
    else:
        # Touch models/providers only on the repair path. A malformed scalar must
        # not crash ExecStartPre, and an unrelated config must not gain an empty
        # models key merely because some other migration changed the file. A
        # value that IS discarded is named, never dropped in silence — the
        # OpenRouter repair further down says the same thing about the same two
        # containers, and the two are deliberately not factored into one helper
        # because each region is extracted and executed on its own by its
        # regression suite.
        if not isinstance(_models_now, dict):
            if _models_now is not None:
                print("  WARN: models was not an object; replacing it — OpenClaw's schema requires one")
            _models_now = {}
            cfg["models"] = _models_now
        if not isinstance(_providers_now, dict):
            if _providers_now is not None:
                print("  WARN: models.providers was not an object; replacing it")
            _providers_now = {}
            _models_now["providers"] = _providers_now

        # The tuning below lives in $CLAWBOX_ROOT/.env (install.sh and
        # install-x64.sh both write it with ensure_env_setting) and NEITHER
        # gateway unit loads that file: clawbox-gateway.service takes
        # network.env and discord.env, the x64 unit only Environment= lines.
        # (Other units do read .env — clawbox-setup, clawbox-embed,
        # clawbox-browser — which is exactly why llama-server, started under
        # clawbox-setup, ran at the configured size while this repair, reading
        # os.environ alone, ALWAYS wrote the 131072 default: OpenClaw believed
        # 131k, compaction never fired, and a long session died with
        # context-exceeded.) Reading the few keys we need is deliberately
        # narrower than adding `EnvironmentFile=-.../.env` to the gateway unit,
        # which would hand every key in a clawbox-writable file to the
        # long-running gateway process, CLAWBOX_TEST_MODE included.
        #
        # errors="replace" and a bare except: .env is clawbox-writable and one
        # latin-1 byte in an operator's key would otherwise raise
        # UnicodeDecodeError out of this heredoc, fail ExecStartPre under
        # `set -euo pipefail`, and leave the box with no gateway at all.
        _llamacpp_dotenv = {}
        try:
            with open(os.path.join(_clawbox_root, ".env"), encoding="utf-8", errors="replace") as _ef:
                for _line in _ef:
                    _line = _line.strip()
                    if not _line or _line.startswith("#") or "=" not in _line:
                        continue
                    _key, _, _value = _line.partition("=")
                    _key = _key.strip()
                    if _key.startswith("export "):
                        _key = _key[len("export "):].strip()
                    _value = _value.strip()
                    if len(_value) >= 2 and _value[0] == _value[-1] and _value[0] in ("'", '"'):
                        _value = _value[1:-1]
                    _llamacpp_dotenv[_key] = _value
        except Exception:
            _llamacpp_dotenv = {}

        def _llamacpp_setting(_name):
            """The process environment first, then the shipped .env."""
            _from_env = (os.environ.get(_name) or "").strip()
            return _from_env if _from_env else _llamacpp_dotenv.get(_name, "").strip()

        def _llamacpp_int(_raw, _minimum, _default):
            """Number() semantics, not int(): see src/lib/llamacpp.ts.

            int() raises on "32768.0" and "1e5" — both of which the TypeScript
            side accepts and llama-server is genuinely started with — and the
            except swallowed it, so the provider silently got the default while
            the server ran at the configured size. A non-numeric override must
            still not abort gateway pre-start: this migration runs on the path
            that repairs a mute box, so raising here would turn a bad env var
            into a box that never starts at all.
            """
            try:
                _value = int(float(_raw))
            except (TypeError, ValueError, OverflowError):
                return _default
            return _value if _value >= _minimum else _default

        _ctx = _llamacpp_int(_llamacpp_setting("LLAMACPP_CONTEXT_WINDOW"), 16384, 131072)
        # getLlamaCppMaxTokens(): an absent or unusable value means the context
        # window, not the 131072 default.
        _max_tokens_raw = _llamacpp_setting("LLAMACPP_MAX_TOKENS")
        _max_tokens = _llamacpp_int(_max_tokens_raw, 1, _ctx) if _max_tokens_raw else _ctx
        # The port is in the unit environment on both installers (this script
        # defaults and exports it; the x64 unit sets Environment=CLAWBOX_PORT),
        # and no installer writes it to .env — so it is read from the process
        # environment alone, unlike the tuning above.
        _proxy_port = (os.environ.get("CLAWBOX_PORT") or os.environ.get("PORT") or "80").strip()
        if not _proxy_port.isdigit() or not 1 <= int(_proxy_port) <= 65535:
            _proxy_port = "80"
        _proxy_default = "http://127.0.0.1" + (
            "" if _proxy_port == "80" else ":" + _proxy_port
        )
        _proxy_root = (
            _llamacpp_setting("CLAWBOX_LOCAL_AI_PROXY_BASE_URL") or _proxy_default
        ).rstrip("/")
        _repaired_entry = dict(_llamacpp_entry) if isinstance(_llamacpp_entry, dict) else {}
        if "models" in _llamacpp_gaps:
            _repaired_entry["models"] = _llamacpp_rows + [{
                "id": _mid,
                "name": _mid,
                "reasoning": False,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": _ctx,
                "maxTokens": _max_tokens,
            } for _mid in _llamacpp_missing_ids]
        # The bearer we are about to write is PROVIDER-WIDE. OpenClaw resolves a
        # row's endpoint as `model.baseUrl ?? provider.baseUrl` and has no
        # per-model credential slot, so completing this entry while a row keeps
        # its own baseUrl ON ANOTHER HOST sends this box's local-AI token to
        # that host on every turn of the row. Such an entry is one we did not
        # build: leave it, and say what leaving it costs.
        #
        # ANOTHER HOST, not merely a row-level baseUrl. There is no ownership
        # marker on a llamacpp row the way `isOurImageRow` has one for an image
        # row, so ownership is decided by host: loopback and the proxy's own
        # authority are this box, and everything else — including a URL that
        # will not parse, because guessing permissively is the wrong way to be
        # wrong about a credential — is not. Refusing over a row that points AT
        # US would cost a gateway for nothing: the entry we decline to complete
        # still has no provider baseUrl, which OpenClaw's schema requires for
        # llamacpp (it is not a bundled overlay), so ExecStart refuses the whole
        # config. Rows are the ones that SURVIVE the repair — a row without an
        # id is dropped above and `ModelDefinitionSchema` rejects it anyway, so
        # it can never route a turn.
        _llamacpp_foreign_row = False
        if _llamacpp_takes_proxy:
            import urllib.parse as _lc_url

            def _lc_host(_raw):
                try:
                    return (_lc_url.urlsplit(_raw).hostname or "").lower() or None
                except ValueError:
                    return None

            _lc_ours = {"127.0.0.1", "localhost", "::1"}
            _lc_proxy_host = _lc_host(_proxy_root)
            if _lc_proxy_host:
                _lc_ours.add(_lc_proxy_host)
            for _r in (_repaired_entry.get("models") or []):
                if not isinstance(_r, dict):
                    continue
                _rid = _r.get("id")
                if not (isinstance(_rid, str) and _rid.strip()):
                    continue
                _rb = _r.get("baseUrl")
                if not (isinstance(_rb, str) and _rb.strip()):
                    continue
                if _lc_host(_rb.strip()) not in _lc_ours:
                    _llamacpp_foreign_row = True
                    break

        if _llamacpp_foreign_row:
            # The URL itself is never printed: an owner-configured endpoint can
            # carry user-info or query credentials, and the journal keeps what
            # it is given.
            print(
                "  Skipped llamacpp provider repair: a model row under"
                " models.providers.llamacpp names its own baseUrl on another"
                " host, and this box's local-AI token would be the bearer for"
                " it. The entry still has no models.providers.llamacpp.baseUrl,"
                " which OpenClaw's schema requires for this provider, so the"
                " gateway will refuse this config until you set one or remove"
                " that row's baseUrl."
            )
        if _llamacpp_takes_proxy and not _llamacpp_foreign_row:
            _repaired_entry["baseUrl"] = _proxy_root + "/setup-api/local-ai/llamacpp/v1"
            # The key travels WITH the baseUrl or not at all: our proxy accepts
            # only our bearer, so leaving a foreign apiKey beside it would be
            # the 401-per-turn the guard above exists to prevent.
            if _repaired_entry.get("apiKey") != _local_ai_token:
                if isinstance(_repaired_entry.get("apiKey"), str) and _repaired_entry["apiKey"].strip():
                    print("  Replaced models.providers.llamacpp.apiKey: the entry now points at this box's local-AI proxy, which accepts only its own bearer")
                _repaired_entry["apiKey"] = _local_ai_token
        if not isinstance(_llamacpp_entry, dict) and not _llamacpp_foreign_row:
            # Only on a FRESH entry. `api` is optional in the schema, and an
            # entry an operator deliberately left api-less routes as
            # openai-compatible anyway, so injecting it would change nothing but
            # their file.
            _repaired_entry["api"] = "openai-completions"
        if not _llamacpp_foreign_row:
            _providers_now["llamacpp"] = _repaired_entry
            changed = True
            if isinstance(_llamacpp_entry, dict):
                print(
                    "  Completed models.providers.llamacpp ("
                    + ", ".join(_llamacpp_gaps)
                    + "): OpenClaw's schema requires them"
                    + (
                        " — dropped " + str(_llamacpp_dropped_rows) + " model row(s) naming no id"
                        if _llamacpp_dropped_rows
                        else ""
                    )
                    # A value CHANGED is named for the same reason a value
                    # discarded is: an id corrected in place is otherwise an
                    # invisible edit to the operator's own file.
                    + (
                        " — trimmed whitespace from " + str(_llamacpp_trimmed_rows) + " model row id(s)"
                        if _llamacpp_trimmed_rows
                        else ""
                    )
                )
            else:
                print(
                    "  Repaired models.providers.llamacpp for "
                    + ", ".join(_llamacpp_model_ids)
                )

# Model migration: legacy ChatGPT-subscription devices can have their active
# model — or a fallback — stored as `openai/<gpt>` from before the setup UI
# routed ChatGPT picks through Codex. On a device with ChatGPT (Codex OAuth)
# auth and NO OpenAI API key, that id resolves to api.openai.com, which 401s
# with "Missing bearer or basic authentication in header": either on the
# active turn, or — more often — only once the OAuth token first refreshes
# and the failover chain reaches the keyless `openai/*` fallback, which
# surfaces as a FailoverError days into use. The chat-model pick route already
# rewrites `openai/<gpt>` -> `codex/<gpt>`, but only when the user re-picks the
# model; existing configs never re-pick, so migrate primary + fallbacks here on
# gateway start. Mirrors CODEX_SUPPORTED_MODEL_RE in
# src/lib/subscription-surface.ts, and hasOpenAiApiKeyProfile /
# hasCodexOauthProfile in src/app/setup-api/chat/model/route.ts. Guarded on
# "codex OAuth present AND no OpenAI API key" so dual-auth / API-key boxes,
# where openai/* is a valid keyed route, are left untouched.
_CODEX_SUPPORTED = (
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
)

def _auth_profiles():
    _auth = cfg.get("auth")
    _profiles = _auth.get("profiles") if isinstance(_auth, dict) else None
    return _profiles.values() if isinstance(_profiles, dict) else []

def _has_openai_api_key_profile():
    for _entry in _auth_profiles():
        if not isinstance(_entry, dict):
            continue
        _p = str(_entry.get("provider", "")).strip().lower()
        _m = str(_entry.get("mode", "")).strip().lower()
        if _p == "openai" and _m in ("token", "api_key", "api-key"):
            return True
    return False

def _has_openai_oauth_profile():
    # The OpenClaw 2 shape: the ChatGPT sign-in is an OAuth profile of the
    # OPENAI provider (src/lib/chatgpt-subscription.ts), beside the API-key one.
    for _entry in _auth_profiles():
        if not isinstance(_entry, dict):
            continue
        _p = str(_entry.get("provider", "")).strip().lower()
        _m = str(_entry.get("mode", "")).strip().lower()
        if _p == "openai" and _m == "oauth":
            return True
    return False

def _has_codex_oauth_profile():
    for _entry in _auth_profiles():
        if not isinstance(_entry, dict):
            continue
        _p = str(_entry.get("provider", "")).strip().lower()
        _m = str(_entry.get("mode", "")).strip().lower()
        if _p == "codex" and _m == "oauth":
            return True
    return False

def _openai_gpt_to_codex(model_id):
    # `openai/<codex-supported gpt>` -> `codex/<gpt>`; otherwise None (leave as-is).
    if not isinstance(model_id, str):
        return None
    _m = model_id.strip()
    if not _m.lower().startswith("openai/"):
        return None
    _bare = _m[len("openai/"):]
    return "codex/" + _bare if _bare.lower() in _CODEX_SUPPORTED else None

# OpenClaw 2 migrates every codex/* reference to openai/* itself (doctor
# --fix, "retaining Codex runtime intent") — rewriting the other way here
# would fight that migration on every boot. Bound via globals() because the
# unit tests run this block extracted from the file.
_clawbox_v2_codex = bool(globals().get("CLAWBOX_OPENCLAW_V2", False))
if (not _clawbox_v2_codex) and _has_codex_oauth_profile() and not _has_openai_api_key_profile():
    _migrated_primary = _openai_gpt_to_codex(model_defaults.get("primary"))
    if _migrated_primary:
        model_defaults["primary"] = _migrated_primary
        changed = True
    _fallbacks = model_defaults.get("fallbacks")
    if isinstance(_fallbacks, list):
        for _i, _fb in enumerate(_fallbacks):
            _migrated_fb = _openai_gpt_to_codex(_fb)
            if _migrated_fb and _migrated_fb != _fallbacks[_i]:
                _fallbacks[_i] = _migrated_fb
                changed = True

# agentRuntime routing for codex models.
#
# `agents.defaults.models["codex/*"].agentRuntime = {"id": "codex"}` is what
# sends a codex turn through the Codex app-server harness. WITHOUT it core
# falls back to its generic HTTP responses transport, which posts to
# https://chatgpt.com/backend-api/responses -- a browser endpoint Cloudflare
# managed-challenges -- and every turn dies with "the provider returned an HTML
# error page". The real Codex API is /backend-api/codex/responses, and only the
# app-server addresses it correctly. Proven on a live box 2026-07-28: with the
# key, `CODEX OK`; remove the key, restart, same box, HTML challenge. See #280.
#
# ClawBox used to delete this key unconditionally, because
# @openclaw/codex >= 2026.5.27 writes it and an older *pinned* core rejected it
# in strict config validation, bricking the AI provider page. That is still
# worth guarding on v1. OpenClaw 2 natively uses this key to retain runtime
# intent while migrating codex/* references to openai/*, so deleting it there
# erases the only signal that the migrated model still requires Codex.
#
# Also seed the entry for any codex model the box is actually configured to
# use, so picking one in the UI works after the next gateway start rather than
# needing the key added by hand.
agents_models = agents_defaults.get("models")
if not isinstance(agents_models, dict):
    agents_models = {}

def _is_codex_ref(model_id):
    return isinstance(model_id, str) and model_id.strip().lower().startswith("codex/")

# OpenClaw 2 references the ChatGPT subscription as `openai/<id>` and keeps the
# Codex runtime on THAT entry (src/lib/chatgpt-subscription.ts), so a seed that
# only recognises the retired namespace restores nothing on the core ClawBox
# pins — and the arm is the one thing standing between a ChatGPT turn and the
# Cloudflare-challenged browser endpoint.
#
# Widened, but only where the reference cannot be anything else: a box holding
# the sign-in and NO OpenAI API key. On a box with both credentials an
# `openai/<id>` is ambiguous at boot, and arming it would push an API-key turn
# through the Codex app-server with no ChatGPT account behind it. That one is
# decided by the chat route, which knows the row the owner picked.
_v2_chatgpt_only = (
    _clawbox_v2_codex
    and _has_openai_oauth_profile()
    and not _has_openai_api_key_profile()
)

def _needs_codex_runtime(model_id):
    if _is_codex_ref(model_id):
        return True
    return (
        _v2_chatgpt_only
        and isinstance(model_id, str)
        and model_id.strip().lower().startswith("openai/")
    )

_codex_refs = set()
if _needs_codex_runtime(model_defaults.get("primary")):
    _codex_refs.add(model_defaults["primary"].strip())
for _fb in model_defaults.get("fallbacks") or []:
    if _needs_codex_runtime(_fb):
        _codex_refs.add(_fb.strip())
for _model_key in list(agents_models.keys()):
    if _needs_codex_runtime(_model_key):
        _codex_refs.add(_model_key)

# The OTHER side of the seed, and the only remover on the box. On v1 the rule
# was "an agentRuntime outside the codex/ namespace is stale", which the
# namespace made safe. On v2 the namespace says nothing — both OpenAI lanes are
# `openai/<id>` — so this fires only on POSITIVE evidence that the arm is
# stale: the box holds an OpenAI API key and NO ChatGPT sign-in of any kind.
# There is then no account for the arm to route to and every turn on that model
# dies on the Cloudflare-challenged browser endpoint — the recovery for a box
# whose sign-in was removed while the arm stayed.
#
# Absence of evidence is not evidence: a config with no auth block at all is an
# unconfigured or half-read box, and `doctor --fix` writes exactly this arm
# when it migrates a `codex/<id>` reference, so stripping there would fight the
# core's own migration. And where a sign-in DOES exist the reference is
# ambiguous at boot — the chat and configure routes own that one, and both now
# write AND clear it from the row the owner picked.
def _has_any_chatgpt_signin():
    for _entry in _auth_profiles():
        if not isinstance(_entry, dict):
            continue
        _p = str(_entry.get("provider", "")).strip().lower()
        _m = str(_entry.get("mode", "")).strip().lower()
        if _m == "oauth" and _p in ("openai", "codex", "openai-codex"):
            return True
    return False

_v2_no_chatgpt = (
    _clawbox_v2_codex
    and _has_openai_api_key_profile()
    and not _has_any_chatgpt_signin()
)

def _armed_codex(entry):
    _rt = entry.get("agentRuntime")
    if not isinstance(_rt, dict):
        return False
    return str(_rt.get("id", "")).strip().lower() == "codex"

for _model_key, _model_val in list(agents_models.items()):
    if not isinstance(_model_val, dict):
        continue
    _stale_v1 = (not _clawbox_v2_codex) and not _is_codex_ref(_model_key)
    _stale_v2 = _v2_no_chatgpt and _armed_codex(_model_val)
    if (_stale_v1 or _stale_v2) and "agentRuntime" in _model_val:
        del _model_val["agentRuntime"]
        changed = True

for _ref in sorted(_codex_refs):
    _entry = agents_models.get(_ref)
    if not isinstance(_entry, dict):
        _entry = {}
        agents_models[_ref] = _entry
        changed = True
    if _entry.get("agentRuntime") != {"id": "codex"}:
        _entry["agentRuntime"] = {"id": "codex"}
        changed = True

if _codex_refs or agents_models:
    agents_defaults["models"] = agents_models

# Security migration: older ClawBox versions silently wrote
# channels.telegram.dmPolicy="open" + allowFrom=["*"] at bot-token setup,
# which opened the bot — and the agent's shell/file/system_power tools —
# to any Telegram user who found the handle. Strip those keys on every
# gateway start so updated devices re-secure themselves without needing
# a bot-token reconfigure or factory reset. No-op on already-safe configs.
#
# Discord gets the same treatment for the same reason: ClawBox never writes
# those keys for it either, and one out-of-schema value in ANY channel block
# invalidates the whole config — a Discord misconfiguration would take a
# working Telegram bot down with it.
channels = cfg.get("channels")
if isinstance(channels, dict):
    for _channel_name in ("telegram", "discord"):
        _channel = channels.get(_channel_name)
        if not isinstance(_channel, dict):
            continue
        for k in ("dmPolicy", "allowFrom"):
            if k in _channel:
                del _channel[k]
                changed = True
        # Config-validity migration: a bot set up on an older OpenClaw can carry
        # a channels.<name>.groupPolicy value the current schema no longer
        # accepts (allowed: open, disabled, allowlist). One invalid value makes
        # the WHOLE config invalid, so the gateway loads nothing and the bot goes
        # silent ("channel active" but never replies). Reset unknown values to
        # the secure default so the device self-heals on the next gateway start
        # — ClawBox exposes no group-chat UI, so "disabled" (bot ignores group
        # chats; owner DMs still work) is the safe choice.
        if _channel.get("groupPolicy") not in (None, "open", "disabled", "allowlist"):
            _channel["groupPolicy"] = "disabled"
            changed = True

# OpenClaw 2 split some formerly bundled channels into consent-gated external
# plugins. A legacy config can retain plugins.entries.<channel>.enabled=true
# even when that channel is explicitly disabled; core then tries to repair the
# absent plugin, blocks on capability consent, and refuses gateway readiness.
# Remove only that contradictory stale enablement. An enabled channel, or a
# plugin entry the owner explicitly disabled, is preserved.
plugin_entries = (cfg.get("plugins") or {}).get("entries") if isinstance(cfg.get("plugins"), dict) else None
if isinstance(plugin_entries, dict) and isinstance(channels, dict):
    for _channel_name in ("slack",):
        _entry = plugin_entries.get(_channel_name)
        _channel = channels.get(_channel_name)
        if (
            isinstance(_entry, dict)
            and _entry.get("enabled") is True
            and isinstance(_channel, dict)
            and _channel.get("enabled") is False
        ):
            del plugin_entries[_channel_name]
            changed = True

# Migration: devices that configured OpenRouter before the provider-def
# fix have `auth.profiles.openrouter:default` set but no
# `models.providers.openrouter` entry, so OpenClaw's runtime has no
# baseUrl to call and every chat turn silently returns `usage: 0/0/0`.
# Fix those in place on gateway start. The configure route now writes the
# provider def on new setups, so only legacy devices will hit this branch.
# The `models` array is UI-only — OpenClaw routes any `openrouter/<slug>`
# through the same baseUrl, so listing just the current default is enough.
auth_profiles = cfg.get("auth", {}).get("profiles", {}) if isinstance(cfg.get("auth"), dict) else {}
has_openrouter_auth = isinstance(auth_profiles, dict) and "openrouter:default" in auth_profiles
# `models` and `models.providers` are not guaranteed to be objects. A hand-edited
# or half-written config can leave a scalar in either, and `.setdefault` on a str
# — or `.get` on the None a `"providers": null` yields — raises AttributeError.
# This line runs on EVERY config, not only on OpenRouter boxes, and under
# `set -euo pipefail` an exception here aborts ExecStartPre: the gateway never
# reaches ExecStart at all. Repair the containers instead, the way the llamacpp
# repair above already does, and say so rather than silently discarding a value.
_models_block = cfg.get("models")
if not isinstance(_models_block, dict):
    if _models_block is not None:
        print("  WARN: models was not an object; replacing it — OpenClaw's schema requires one")
        # Persisted deliberately: the value on disk fails validation as it
        # stands, so writing the object form IS the repair. Left unpersisted it
        # would warn on every boot and be undone by the next writer.
        changed = True
    _models_block = {}
    cfg["models"] = _models_block
models_providers = _models_block.get("providers")
if not isinstance(models_providers, dict):
    if models_providers is not None:
        print("  WARN: models.providers was not an object; replacing it")
        changed = True
    models_providers = {}
    _models_block["providers"] = models_providers
if has_openrouter_auth and not models_providers.get("openrouter"):
    primary = (cfg.get("agents", {}).get("defaults", {}).get("model", {}) or {}).get("primary", "")
    # The runtime trims the ref before it checks the prefix, and a bare
    # "openrouter/" leaves an EMPTY id — which ModelDefinitionSchema rejects
    # (id.min(1)), failing validation for the whole openclaw.json. OpenRouter
    # routes any `openrouter/<slug>` through the same baseUrl and this list is
    # UI-only, so falling back to the bundled default is both safe and honest.
    default_model = ""
    if isinstance(primary, str) and primary.strip().startswith("openrouter/"):
        default_model = primary.strip()[len("openrouter/"):].strip()
    if not default_model:
        default_model = "moonshotai/kimi-k2-0905"
    models_providers["openrouter"] = {
        "baseUrl": "https://openrouter.ai/api/v1",
        "api": "openai-completions",
        "apiKey": "openrouter-ref",
        "models": [{
            "id": default_model,
            "name": default_model,
            "input": ["text"],
            "contextWindow": 131072,
            "maxTokens": 8192,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        }],
    }
    changed = True

gateway = cfg.setdefault("gateway", {})
control_ui = gateway.setdefault("controlUi", {})
auth = gateway.setdefault("auth", {})

def set_if(obj, key, value):
    global changed
    if obj.get(key) != value:
        obj[key] = value
        changed = True

_clawbox_v2 = bool(globals().get("CLAWBOX_OPENCLAW_V2", False))
if not _clawbox_v2:
    # Retired on OpenClaw 2: the control UI pairs through the normal device
    # flow, and a config still carrying either key fails validation outright.
    set_if(control_ui, "allowInsecureAuth", True)
    set_if(control_ui, "dangerouslyDisableDeviceAuth", True)
else:
    for _retired in ("allowInsecureAuth", "dangerouslyDisableDeviceAuth"):
        if _retired in control_ui:
            del control_ui[_retired]
            changed = True
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
# Preserve a strong token; only (re)generate when missing or the weak legacy
# literal. The service no longer passes --token, so the gateway resolves this
# config value at runtime (same value gateway-proxy.ts injects into the SPA) —
# one source of truth, no service↔UI drift (issues #149, #150).
if not is_strong_gateway_token(auth.get("token")):
    auth["token"] = secrets.token_hex(32)
    changed = True

# Backfill `compat.supportedReasoningEfforts: ["off", "high", "xhigh"]` onto any
# DeepSeek V4 models the configure route wrote before this declaration was
# added. Without it, the gateway's catalogSupportsXHigh() returns false for
# the configured deepseek provider and sessions.patch rejects xhigh ("use
# off|minimal|low|medium|high"), even though the upstream translation layer
# maps OpenClaw xhigh → DeepSeek reasoning_effort: "max" correctly. New
# configurations get the field from configure/route.ts; this branch handles
# devices that were configured before that landed.
ds_models = (
    cfg.get("models", {}).get("providers", {}).get("deepseek", {}).get("models")
    if isinstance(cfg.get("models"), dict) else None
)
deepseek_provider = (
    cfg.get("models", {}).get("providers", {}).get("deepseek")
    if isinstance(cfg.get("models"), dict) else None
)
# These two are LEGACY values on purpose: they are what a box paired before the
# clawbox.com move still has written in its config, and matching them is the
# whole point of the branch. Do not "update" them to the current domain — that
# turns the retarget into a no-op that rewrites the config to itself (and sets
# `changed` on every boot) while leaving field devices pointed at the old host.
if isinstance(deepseek_provider, dict) and deepseek_provider.get("baseUrl") in (
    "https://openclawhardware.dev/api/ai",
    "https://www.openclawhardware.dev/api/ai",
):
    deepseek_provider["baseUrl"] = "https://clawbox.com/api/ai"
    changed = True

# Migration: ClawBox AI vision (image understanding).
#
# A ClawBox accepts an image attachment in chat and then cannot look at it.
# Both ClawBox AI chat models are `input: ["text"]`, so OpenClaw does not
# inline image parts; it hands the turn a media path and expects the `image`
# tool to describe it. That tool resolves its model from
# `agents.defaults.imageModel`, which ClawBox provisioning never wrote, so
# runWithImageModelFallback throws "No image model configured"
# (dist/model-fallback-CvSRhgYr.js on 2026.7.1). Reproduced on a real box on
# 2026-08-21; see TASK-417.
#
# Boxes already in the field never re-run the configure route, so the repair
# has to happen here. Mirrors buildClawboxAiProviderDefinition() and the
# imageModel write in src/app/setup-api/ai-models/configure/route.ts; the two
# must stay in step, and src/tests/unit/gateway-pre-start-clawai-vision.test.ts
# runs these exact bytes out of the shipped .sh.
#
# Registered under the `deepseek` provider even though the id is an OpenAI one:
# that entry IS the ClawBox AI proxy, already carrying api=openai-completions,
# the proxy baseUrl and the claw_ token. OpenClaw's `openai` provider defaults
# to openai-responses, which the proxy does not speak. It cannot show up in the
# chat model picker — the clawai catalogue is the hardcoded CLAWAI_STATIC_MODELS
# list, not a read of this array.
#
# The model id and the ceiling are duplicated from CLAWBOX_AI_VISION_* in
# src/lib/clawbox-ai-models.ts because a shell migration cannot import them.
# 128000 is measured, not guessed: against the live proxy on 2026-08-21,
# max_tokens 128000 is accepted and 200000 (the generic default an entry falls
# through to when the field is absent) comes back 400 "supports at most 128000
# completion tokens".
# Honour the same env override CLAWBOX_AI_VISION_MODEL_ID gives the route, so a
# box provisioned against a staging proxy with a different alias map is not
# dragged back to the production slug at the next boot. Unset (the normal case)
# means the shipped PREFERRED default — DeepSeek's own multimodal model — but
# nothing writes it unverified: the proxy allowlists bare ids and answers 400
# model_not_allowed for anything it does not serve yet, so the block below
# probes first and stays on the previous vision model until the proxy says
# yes. Boots re-resolve, so a box upgrades itself the first boot after the
# proxy starts serving the new id — and heals back the same way. This mirrors
# resolveVisionModelId() in src/lib/clawbox-ai-vision.ts; the two must stay
# in step. CLAWBOX_VISION_PROBE=allowed|not-allowed|unknown forces the
# verdict (the unit test runs these bytes without a network).
CLAWBOX_VISION_PREFERRED_ID = "deepseek-v4-flash-vision-exp"
CLAWBOX_VISION_LEGACY_ID = "gpt-5.6-luna"
CLAWBOX_VISION_OVERRIDE_ID = (os.environ.get("CLAWBOX_AI_VISION_MODEL_ID") or "").strip()
CLAWBOX_VISION_MODEL_NAME = "ClawBox AI Vision"
CLAWBOX_VISION_MAX_TOKENS = 128000

def _clawbox_vision_probe(token):
    forced = (os.environ.get("CLAWBOX_VISION_PROBE") or "").strip()
    if forced in ("allowed", "not-allowed", "unknown"):
        return forced
    try:
        import json as _vp_json
        import urllib.request as _vp_rq
        base = ((os.environ.get("CLAWBOX_AI_PROXY_URL") or "").strip() or "https://clawbox.com/api/ai").rstrip("/")
        req = _vp_rq.Request(
            base + "/chat/completions",
            data=_vp_json.dumps({
                "model": CLAWBOX_VISION_PREFERRED_ID,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "ok"}],
            }).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
            method="POST",
        )
        with _vp_rq.urlopen(req, timeout=6) as resp:
            resp.read(64)
        return "allowed"
    except Exception as err:  # noqa: BLE001 - any failure below is a verdict, not a crash
        body = ""
        try:
            body = err.read().decode("utf-8", "replace") if hasattr(err, "read") else str(err)
        except Exception:  # noqa: BLE001
            body = str(err)
        if "model_not_allowed" in body or "Model not allowed" in body:
            return "not-allowed"
        return "unknown"

# The token is the entitlement, exactly as for images: only a box that actually
# has ClawBox AI gets a vision model pointed at the ClawBox AI proxy. Read here
# rather than borrowing the image migration's `_clawai_token`, so this block
# stays a self-contained slice its unit test can run out of the shipped .sh.
_vision_models = deepseek_provider.get("models") if isinstance(deepseek_provider, dict) else None
_vision_token = deepseek_provider.get("apiKey") if isinstance(deepseek_provider, dict) else None
if isinstance(_vision_models, list) and isinstance(_vision_token, str) and _vision_token.startswith("claw_"):
    # Resolve which of OUR ids this box may name. An operator override wins
    # unprobed; otherwise the proxy's own answer decides, and an unanswered
    # question keeps whatever the config already says rather than flapping.
    if CLAWBOX_VISION_OVERRIDE_ID:
        CLAWBOX_VISION_MODEL_ID = CLAWBOX_VISION_OVERRIDE_ID
    else:
        _vision_verdict = _clawbox_vision_probe(_vision_token)
        if _vision_verdict == "allowed":
            CLAWBOX_VISION_MODEL_ID = CLAWBOX_VISION_PREFERRED_ID
        elif _vision_verdict == "not-allowed":
            CLAWBOX_VISION_MODEL_ID = CLAWBOX_VISION_LEGACY_ID
        else:
            _vision_has_preferred = any(
                isinstance(m, dict) and m.get("id") == CLAWBOX_VISION_PREFERRED_ID
                for m in _vision_models
            )
            CLAWBOX_VISION_MODEL_ID = (
                CLAWBOX_VISION_PREFERRED_ID if _vision_has_preferred else CLAWBOX_VISION_LEGACY_ID
            )
    CLAWBOX_VISION_MODEL_REF = "deepseek/" + CLAWBOX_VISION_MODEL_ID
    _vision_our_ids = {CLAWBOX_VISION_PREFERRED_ID, CLAWBOX_VISION_LEGACY_ID, CLAWBOX_VISION_OVERRIDE_ID} - {""}

    _vision_entry = next(
        (m for m in _vision_models if isinstance(m, dict) and m.get("id") == CLAWBOX_VISION_MODEL_ID),
        None,
    )
    if _vision_entry is None:
        # A box carrying the OTHER of our ids is mid-migration: retarget that
        # entry in place instead of stacking a second vision model beside it.
        _vision_entry = next(
            (m for m in _vision_models if isinstance(m, dict) and m.get("id") in _vision_our_ids),
            None,
        )
        if _vision_entry is not None:
            _vision_entry["id"] = CLAWBOX_VISION_MODEL_ID
            changed = True
    if _vision_entry is None:
        _vision_models.append({
            "id": CLAWBOX_VISION_MODEL_ID,
            "name": CLAWBOX_VISION_MODEL_NAME,
            "input": ["text", "image"],
            "maxTokens": CLAWBOX_VISION_MAX_TOKENS,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        })
        changed = True
    else:
        # Repair only what makes the entry unusable, in the same order the
        # route builds it. `name` first: OpenClaw's schema rejects a models[]
        # row without one and the gateway then refuses to start.
        if not isinstance(_vision_entry.get("name"), str) or not _vision_entry.get("name").strip():
            _vision_entry["name"] = CLAWBOX_VISION_MODEL_NAME
            changed = True
        # Without "image" in `input`, resolveImageRuntime refuses the model
        # outright ("Model does not support images"), which is the whole
        # failure this migration exists to fix.
        _vision_input = _vision_entry.get("input")
        if not isinstance(_vision_input, list) or "image" not in _vision_input:
            _vision_entry["input"] = ["text", "image"]
            changed = True
        # Only fill an absent ceiling. A number someone else chose is theirs.
        if _vision_entry.get("maxTokens") is None:
            _vision_entry["maxTokens"] = CLAWBOX_VISION_MAX_TOKENS
            changed = True

    # Claim agents.defaults.imageModel only when it is empty, where "empty"
    # means what OpenClaw's hasToolModelConfig means: neither a primary nor a
    # usable fallback. A fallbacks-only entry is a working, deliberate
    # configuration, and the write below replaces the whole object.
    _vision_model_cfg = agents_defaults.get("imageModel")
    _vision_fallbacks = (
        _vision_model_cfg.get("fallbacks") if isinstance(_vision_model_cfg, dict) else None
    )
    _has_vision_model = isinstance(_vision_model_cfg, dict) and bool(
        (isinstance(_vision_model_cfg.get("primary"), str) and _vision_model_cfg.get("primary").strip())
        or (
            isinstance(_vision_fallbacks, list)
            and any(isinstance(ref, str) and ref.strip() for ref in _vision_fallbacks)
        )
    )
    _vision_primary = (
        _vision_model_cfg.get("primary") if isinstance(_vision_model_cfg, dict) else None
    )
    _vision_primary = _vision_primary.strip() if isinstance(_vision_primary, str) else ""
    if not _has_vision_model:
        agents_defaults["imageModel"] = {"primary": CLAWBOX_VISION_MODEL_REF}
        changed = True
    elif (
        _vision_primary in {"deepseek/" + i for i in _vision_our_ids}
        and _vision_primary != CLAWBOX_VISION_MODEL_REF
    ):
        # The slot names one of OUR vision ids — the previous default is ours
        # to move to the resolved one, both directions. Anything else in the
        # slot is the owner's choice and stays — and the move changes ONLY
        # `primary`, so fallbacks the owner added ride along.
        _vision_model_cfg["primary"] = CLAWBOX_VISION_MODEL_REF
        changed = True

# Set by the image-generation migration below, on the one path where it decides
# the `openai` provider slot is ours to write. The speech-to-text migration
# after it is gated on exactly that fact: it points channel audio at our proxy,
# and that proxy is reached with whatever key sits on that provider.
_clawai_openai_route_is_ours = False
_clawai_proxy_base_url = ""

# Migration: ClawBox AI image generation.
#
# OpenClaw only registers its `image_generate` tool when an image-generation
# provider is configured, and ClawBox provisioning configured none — so every
# box paired before this change cannot produce a picture even though the
# subscription includes 5/50/200 of them a month. Boxes already in the field
# never re-run the configure route, so the repair has to happen here.
#
# Mirrors configureClawboxAiImages() in
# src/app/setup-api/ai-models/configure/route.ts; the two must stay in step.
# See that function for why each field is shaped the way it is. The short
# version: the per-model `baseUrl` retargets exactly one model (a provider-wide
# one would point OpenAI's whole built-in chat catalog at a proxy that does not
# speak it), the absent `api` NARROWS where the entry is offered as a chat
# model but does not hide it — OpenClaw skips that gate under
# `models.mode: "replace"`, and its picker exempts every configured row anyway,
# so its own surfaces can still offer our image model (see the docblock in
# src/lib/clawbox-ai-models.ts for the measurement and the two source paths);
# ClawBox's own surfaces are closed separately. `name` is required or the
# config will not validate, and the `imageGenerationModel` write is what
# actually makes the tool appear: `imageModel` is a different key that selects
# the vision model.
#
# The model id is duplicated from CLAWBOX_AI_IMAGE_MODEL_ID in
# src/lib/clawbox-ai-models.ts because a shell migration cannot import it. It
# must name a model production allows: the proxy matches the bare id and
# answers 400 "Model not allowed" on a miss.
CLAWBOX_IMAGE_MODEL_ID = "gpt-image-1-mini"
CLAWBOX_IMAGE_MODEL_NAME = "ClawBox AI Images"
CLAWBOX_IMAGE_MODEL_REF = "openai/" + CLAWBOX_IMAGE_MODEL_ID

# Where OpenClaw sends an `openai` request that names no host of its own:
# resolveConfiguredOpenAIBaseUrl, dist/shared-BdJp-xt6.js:11 on 2026.7.1-2.
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"

# Imported here rather than at the top of the block so this migration stays a
# self-contained slice: src/tests/unit/gateway-pre-start-clawai-images.test.ts
# runs these exact bytes out of the shipped .sh.
from urllib.parse import urlsplit


# The scheme's default port, which `new URL(u).host` omits on the TypeScript
# side. Spelling it out here is what keeps the two normalisers agreeing on
# `https://clawbox.com:443/api/ai` — the route called that row ours while this
# script called the same row foreign and backed the whole migration off.
_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}


def _url_host(_url):
    """Lowercased host[:port] of a URL, or None when it is not a usable URL.

    Deliberately excludes any userinfo, and matches what `new URL(u).host`
    returns on the TypeScript side so the two guards agree on the same string —
    including the default port, which `URL.host` drops and `urlsplit` keeps.
    """
    try:
        _parts = urlsplit(_url if isinstance(_url, str) else "")
        if not _parts.scheme or not _parts.hostname:
            return None
        _port = _parts.port
    except ValueError:
        return None
    if _port is not None and _DEFAULT_PORTS.get(_parts.scheme.lower()) == _port:
        _port = None
    return _parts.hostname.lower() + (":" + str(_port) if _port is not None else "")


# Every host ClawBox has ever written as the ClawBox AI proxy: the live one off
# the deepseek entry (so a staging box names its staging host), plus the two
# retired ones the retarget above still recognises. Hoisted here because both
# questions below — "is this row mine to repair" and "would my token leave the
# building" — have to be asked with the same set.
#
# The live value must only count when the deepseek entry is a ClawBox AI one:
# install.sh's CLAWBOX_AI_API_KEY branch provisions a RAW DeepSeek key at
# api.deepseek.com, and admitting that host would make a genuine third party
# "not foreign". Here that is already true without a test of its own — every
# reader of this set (`_is_our_image_row`, `_is_foreign`, `_clawai_host_is_ours`)
# sits inside the `claw_` gate below — the speech migration through
# `_clawai_openai_route_is_ours`, which is only set there — so on a raw-DeepSeek
# box the set is never consulted.
# clawboxProxyHosts() in src/app/setup-api/ai-models/configure/route.ts DOES
# test it, because its call site is not gated; the two therefore agree on
# every box. If a reader of this set is ever moved ABOVE that gate, the
# `claw_` test has to come with it.
_clawai_image_base_url = deepseek_provider.get("baseUrl") if isinstance(deepseek_provider, dict) else None
if not isinstance(_clawai_image_base_url, str) or not _clawai_image_base_url.strip():
    _clawai_image_base_url = "https://clawbox.com/api/ai"
_clawbox_proxy_hosts = set()
for _known in (
    _clawai_image_base_url,
    "https://clawbox.com/api/ai",
    "https://openclawhardware.dev/api/ai",
    "https://www.openclawhardware.dev/api/ai",
):
    _known_host = _url_host(_known)
    if _known_host:
        _clawbox_proxy_hosts.add(_known_host)


def _is_our_image_row(_row):
    """Is this models[] row the one WE wrote?

    The id cannot answer it on its own. `gpt-image-1-mini` is a real OpenAI
    model id, so an owner running their own image endpoint — Azure OpenAI,
    LiteLLM, vLLM, any self-hosted OpenAI-compatible gateway — can carry a row
    of exactly that id. Claiming it repoints their route at our proxy,
    overwrites their `api`, and puts the portal token on the provider block as
    the credential for a route we do not own.

    So ownership is POSITIVE: the row's own `baseUrl` must name a host ClawBox
    itself has written. "Not api.openai.com" is the wrong test — api.openai.com
    is the least likely place for a power user's private row. The set includes
    the retired hosts, so the retarget of an entry left on an old proxy still
    recognises it as ours.

    A row with no `baseUrl` of its own is not ours either: ClawBox has always
    written one, and an inherited provider-level URL is the owner's choice.

    Mirrors isOurImageRow() in src/app/setup-api/ai-models/configure/route.ts.
    """
    if not isinstance(_row, dict) or _row.get("id") != CLAWBOX_IMAGE_MODEL_ID:
        return False
    _row_base_url = _row.get("baseUrl")
    if not isinstance(_row_base_url, str) or not _row_base_url.strip():
        return False
    return _url_host(_row_base_url) in _clawbox_proxy_hosts


# Only boxes that actually have ClawBox AI get an image provider — the token is
# the entitlement. Read it from where the configure route already put it rather
# than re-reading data/config.json, and take the proxy URL off the same entry so
# a box provisioned against a staging proxy (CLAWBOX_AI_PROXY_URL) keeps
# talking to that staging proxy for images too.
_clawai_token = deepseek_provider.get("apiKey") if isinstance(deepseek_provider, dict) else None
if isinstance(_clawai_token, str) and _clawai_token.startswith("claw_"):
    _image_base_url = _clawai_image_base_url

    openai_provider = models_providers.get("openai")
    if not isinstance(openai_provider, dict):
        openai_provider = {}

    # A literal key we did not write is someone's own OpenAI credential. Leave
    # it — and the whole migration — alone rather than overwrite it. ClawBox
    # itself has never written this field (the openai setup path uses an auth
    # profile), so anything else here was put there deliberately.
    _existing_key = openai_provider.get("apiKey")
    _key_is_ours = (
        _existing_key is None
        or (isinstance(_existing_key, str) and (not _existing_key.strip() or _existing_key.startswith("claw_")))
    )

    # The apiKey we are about to write is provider-wide, not image-only: nothing
    # in OpenClaw scopes it to one model. getApiKeyForModel
    # (dist/model-auth-CJEm9SNp.js:753 on 2026.7.1-2) walks per-entry bindings,
    # auth profiles, then the environment, and lands on
    # models.providers.<p>.apiKey last. A ClawBox has no openai auth profile and
    # no OPENAI_API_KEY, so that last step is where every `openai/*` request gets
    # its bearer — including one aimed at a host that is not ours.
    #
    # Two configured shapes route off-proxy, and the owner wrote both (ClawBox
    # writes neither):
    #   - a models[] row other than ours, whose endpoint resolves as
    #     `row.baseUrl or provider.baseUrl or api.openai.com` — so a hand-added
    #     {"id": "gpt-5", "api": "openai-completions"} with no baseUrl goes
    #     straight to api.openai.com carrying claw_…
    #   - a provider-level baseUrl, the fallback for every row without one.
    # Either means an `openai` setup we did not build, so back the whole
    # migration off. Half-configuring it — key written, images maybe working —
    # is the outcome that mails the subscription token to a third party.
    # An unparseable URL counts as foreign: we cannot say where it points.
    # Mirrors foreignOpenAiRoute() in
    # src/app/setup-api/ai-models/configure/route.ts — the SAME set
    # _is_our_image_row uses, so the two questions this block asks ("is this
    # row mine to repair" and "would my token leave the building") cannot
    # disagree about a host, and neither can the two writers. On the old
    # single-host form an owner row on a RETIRED ClawBox proxy was foreign
    # here and ours in the route, so the same config produced two different
    # box states depending on which ran last — and the back-off also gates the
    # speech-to-text migration below.
    def _is_foreign(_url):
        _host = _url_host(_url)
        return _host is None or _host not in _clawbox_proxy_hosts

    _provider_base_url = openai_provider.get("baseUrl")
    if not isinstance(_provider_base_url, str) or not _provider_base_url.strip():
        _provider_base_url = ""
    _foreign_route = _provider_base_url if (_provider_base_url and _is_foreign(_provider_base_url)) else None
    if _foreign_route is None:
        for _row in (openai_provider.get("models") if isinstance(openai_provider.get("models"), list) else []):
            # OUR row is skipped — not every row that happens to share its id.
            # See _is_our_image_row: skipping by id let the upsert claim an
            # owner's own gpt-image-1-mini row and repoint it at our proxy.
            if not isinstance(_row, dict) or _is_our_image_row(_row):
                continue
            _row_base_url = _row.get("baseUrl")
            if not isinstance(_row_base_url, str) or not _row_base_url.strip():
                _row_base_url = _provider_base_url or OPENAI_DEFAULT_BASE_URL
            if _is_foreign(_row_base_url):
                _foreign_route = _row_base_url
                break

    if _key_is_ours and _foreign_route is not None:
        print(
            # The host only, like the TypeScript sibling: an owner-configured
            # URL can carry user-info or query credentials, and the journal
            # keeps what is logged.
            "  Skipped ClawBox AI image provider: models.providers.openai already routes to "
            + (_url_host(_foreign_route) or "an unparseable URL")
            + ", and the apiKey we would write there is the credential for that route too"
        )

    if _key_is_ours and _foreign_route is None:
        models_providers["openai"] = openai_provider
        _clawai_openai_route_is_ours = True
        _clawai_proxy_base_url = _image_base_url
        if openai_provider.get("apiKey") != _clawai_token:
            openai_provider["apiKey"] = _clawai_token
            changed = True

        # Upsert our entry, preserving any other model entries the box carries.
        _openai_models = openai_provider.get("models")
        if not isinstance(_openai_models, list):
            _openai_models = []
            openai_provider["models"] = _openai_models
        _our_entries = [m for m in _openai_models if _is_our_image_row(m)]
        if not _our_entries:
            _openai_models.append({
                "id": CLAWBOX_IMAGE_MODEL_ID,
                "name": CLAWBOX_IMAGE_MODEL_NAME,
                "baseUrl": _image_base_url,
            })
            changed = True
        # Every duplicate of our row is repaired the same way: a stale copy
        # left by an older upsert is offered by the same pickers as the live one.
        for _entry in _our_entries:
            if not isinstance(_entry.get("name"), str) or not _entry.get("name").strip():
                _entry["name"] = CLAWBOX_IMAGE_MODEL_NAME
                changed = True
            if _entry.get("baseUrl") != _image_base_url:
                _entry["baseUrl"] = _image_base_url
                changed = True
            # An `api` here widens where the image model is offered as a
            # conversational model that fails on every turn — see the header
            # above for why removing it narrows rather than closes that. Only
            # ever ours to remove, so drop it wherever it appears.
            if "api" in _entry:
                del _entry["api"]
                changed = True

        # Only claim the slot when it is empty. A box whose owner pointed image
        # generation at their own provider keeps that choice.
        #
        # "Empty" has to mean what OpenClaw means by it, which is neither a
        # primary NOR a usable fallback: hasToolModelConfig()
        # (dist/model-config.helpers-BS3FWcoO.js:25 on 2026.7.1-2) returns true
        # for `primary?.trim() || fallbacks.some(non-empty)`, so a
        # fallbacks-only entry is a working, deliberate configuration. Testing
        # `primary` alone would replace the whole object below and take the
        # owner's fallbacks with it — the exact outcome the paragraph above
        # says must not happen.
        _clawbox_v2 = bool(globals().get("CLAWBOX_OPENCLAW_V2", False))
        if _clawbox_v2:
            # v2: the same object lives at agents.defaults.mediaModels.image
            # (the loader migration moves imageGenerationModel there verbatim).
            _media_models = agents_defaults.get("mediaModels")
            if not isinstance(_media_models, dict):
                _media_models = {}
            # An owner's pick still sitting in the LEGACY key (the loader
            # migration has not run yet on this file) is a configured model,
            # not an empty slot to claim.
            _image_model_cfg = _media_models.get("image")
            if _image_model_cfg is None:
                _image_model_cfg = agents_defaults.get("imageGenerationModel")
        else:
            _image_model_cfg = agents_defaults.get("imageGenerationModel")
        _image_model_fallbacks = (
            _image_model_cfg.get("fallbacks") if isinstance(_image_model_cfg, dict) else None
        )
        _has_image_model = isinstance(_image_model_cfg, dict) and bool(
            (isinstance(_image_model_cfg.get("primary"), str) and _image_model_cfg.get("primary").strip())
            or (
                isinstance(_image_model_fallbacks, list)
                and any(isinstance(ref, str) and ref.strip() for ref in _image_model_fallbacks)
            )
        )
        if not _has_image_model:
            if _clawbox_v2:
                _media_models["image"] = {"primary": CLAWBOX_IMAGE_MODEL_REF}
                agents_defaults["mediaModels"] = _media_models
            else:
                agents_defaults["imageGenerationModel"] = {"primary": CLAWBOX_IMAGE_MODEL_REF}
            changed = True

# Migration: ClawBox AI speech to text.
#
# A voice note arriving over a chat channel — Telegram is the one v4 ships — is
# transcribed through OpenClaw's media-understanding surface, and that surface
# is not a models[] row and never reads one. It takes its endpoint from
# `tools.media.audio.baseUrl` and its bearer from
# `models.providers.openai.apiKey` — the same last-resort key walk described
# above. So on a paired ClawBox that configures no audio at all, every voice
# note ships the claw_ subscription token to OpenAI's default host and comes
# back
#   HTTP 401 Incorrect API key provided: claw_…
# Reproduced on both loop boxes on beta 02249c1; see TASK-502. That broke two
# things, not one: no channel voice note could ever be transcribed, and the
# token the block above takes such care never to hand to a foreign route was
# being handed to one on every attempt.
#
# Both fields written below are load-bearing, measured against the live proxy
# on 2026-08-22:
#   - the baseUrl alone still fails, because OpenClaw's default audio model for
#     `openai` is gpt-4o-transcribe and the proxy answers 400 "Model not
#     supported for transcription: gpt-4o-transcribe. Use
#     gpt-4o-mini-transcribe."
#   - the model pin alone still resolves to api.openai.com and still 401s
#
# The device chat microphone does not come through here — it posts to the proxy
# itself from src/app/setup-api/chat/transcribe/route.ts — which is exactly why
# this stayed invisible until a channel voice note was tried on real hardware.
#
# The model id is duplicated from TRANSCRIBE_MODEL in src/lib/stt-preference.ts
# for the same reason the image id is duplicated above: a shell migration cannot
# import a TS constant. It must name a model production allows, because the
# proxy matches the bare id and answers 400 on a miss.
CLAWBOX_TRANSCRIBE_MODEL_ID = "gpt-4o-mini-transcribe"
CLAWBOX_CLOUD_AUDIO_MODEL = {"provider": "openai", "model": CLAWBOX_TRANSCRIBE_MODEL_ID}
# What a box with no audio config gets: the cloud alone. The on-box engine is
# a `type: "cli"` row running the workspace's stt-client.py, and it is
# Settings (src/app/setup-api/stt) that adds it — only that route knows
# whether faster-whisper is installed here. The script name is duplicated from
# src/lib/stt-local.ts; it is matched by name rather than full path because
# HOME is the script's to resolve, and a path check here would call a moved
# workspace foreign.
CLAWBOX_AUDIO_MODELS = [CLAWBOX_CLOUD_AUDIO_MODEL]
CLAWBOX_STT_CLIENT_SCRIPT = "stt-client.py"
# v2 keeps baseUrl under tools.media.audio; the model list moved to
# tools.media.models with capabilities: ["audio"] per row. Bound via
# globals() because the unit tests run this block extracted from the file.
_clawbox_v2 = bool(globals().get("CLAWBOX_OPENCLAW_V2", False))


def _is_clawbox_audio_model(_entry):
    """Is one models[] row one of the two ClawBox itself writes?

    v2 rows carry capabilities: ["audio"]; the field says where the row may
    be used, not whose it is, so it is ignored for the ownership question.
    """
    if not isinstance(_entry, dict):
        return False
    if list(_entry.get("capabilities") or []) in ([], ["audio"]):
        _entry = {k: v for k, v in _entry.items() if k != "capabilities"}
    if _entry.get("type") == "cli":
        _args = _entry.get("args")
        _named = [_entry.get("command")] + (list(_args) if isinstance(_args, list) else [])
        return any(isinstance(_v, str) and _v.endswith(CLAWBOX_STT_CLIENT_SCRIPT) for _v in _named)
    return _entry == CLAWBOX_CLOUD_AUDIO_MODEL


def _is_clawbox_audio_models(_models):
    """Could src/lib/stt-preference.ts have built this whole list?

    Cloud only, [cloud, on-box] or [on-box, cloud]: the ORDER is the owner's
    speech-to-text preference, saved from Settings, and this migration has no
    say in it. It matches row by row rather than the list against one fixed
    shape so that preference survives the next boot. Anything else — an empty
    list, a foreign model, a CLI row naming some other script — is the owner's
    own transcription setup.
    """
    return (
        isinstance(_models, list)
        and len(_models) > 0
        and all(_is_clawbox_audio_model(_entry) for _entry in _models)
    )


def _same_endpoint(_a, _b):
    """Do two configured endpoints name the same route?

    The WHOLE endpoint, not just its host. An owner who pointed transcription
    at https://clawbox.com/their-own-route chose that path deliberately, and a
    host-only match would stamp over it while reporting success. One trailing
    slash is the only difference that means nothing; stripping every slash
    would also treat an owner's deliberate `.../api/ai//` route as ours and
    stamp over it.

    Module level rather than nested in the guard below because the cloud-voice
    migration after it asks the same question of the same proxy and must give
    the same answer. Two copies of this rule would be two rules.
    """
    def _without_one_trailing_slash(_value):
        return _value[:-1] if _value.endswith("/") else _value

    return _without_one_trailing_slash(_a) == _without_one_trailing_slash(_b)


def _clawai_host_is_ours(_url):
    """Does this address name a host CLAWBOX ITSELF has written?

    The same `_clawbox_proxy_hosts` the image row's ownership test uses — the
    live proxy (so a staging box names its staging host) plus the retired ones —
    rather than a second list, so "is this row mine to repair" and "is this
    speech route mine" cannot drift into two answers.

    Host, not full address, and deliberately: the arms below that ask this one
    are looking for a route of OURS that has MOVED, and a move is exactly the
    case an equality test cannot see. The arms that need the precise address
    still ask `_same_endpoint`.

    Same gate caveat as the set it reads: every caller must sit inside the
    `claw_` test above it, or a raw-DeepSeek box would admit api.deepseek.com as
    ours. This one does — the speech migration runs only when
    `_clawai_openai_route_is_ours`, which is set inside that gate.
    """
    return _url_host(_url) in _clawbox_proxy_hosts if isinstance(_url, str) else False


def _clawai_route_is_ours(_base_url, _api_key, _stamped, _proxy_base_url):
    """Is a configured media route OURS — ours to refresh, ours to take back?

    THE CURRENT PROXY URL IS NOT THE QUESTION, and asking it as though it were
    is what this replaces. `CLAWBOX_AI_PROXY_URL` is env-overridable and moves
    between releases, so a box we linked under a previous address carries an
    entry we wrote, pointing at an endpoint that has since been retired — and
    an equality test reads that as the OWNER'S own speech server and skips it,
    while the chat provider and the image row are repaired in the same boot.
    The customer's transcription and voice stay pointed at a dead host and
    nothing says so: the false-failure class.

    Ownership needs POSITIVE evidence, in the same three shapes the Hermes half
    of this uses (`hermesCloudRouteIsOurs`, src/lib/hermes-tts.ts — one rule,
    two editions, and TASK-726 is this half of it):

      - our own stamp on the entry (`clawboxManaged`);
      - or a `claw_` portal token on it, which is what survives the proxy URL
        moving;
      - or the endpoint names our proxy, or a host of ours it has moved from;
      - or the slot is genuinely EMPTY — no endpoint AND no key. An unset
        endpoint alone says nothing: the canonical way an owner uses the
        generic `openai` slot is their key with no URL at all.

    FOREIGN EVIDENCE OF EITHER KIND — their credential, or a host that is none
    of ours — takes the slot back, and is asked first. Their key is the obvious
    one and was the only one this asked for at first; but a speech server on the
    LAN needs no key at all, so on the shape an owner is most likely to run, THE
    ADDRESS IS THE ONLY THING THAT SPEAKS FOR IT. This is
    the only generic OpenAI-compatible speech slot OpenClaw has, so an owner who
    wants their own speech server has to edit the entry we already wrote — which
    `openclaw config set` does in place, leaving our `clawboxManaged` key behind
    on a route that is now theirs. Trusting a stamp on its own would overwrite
    their server, their key and their model at the next gateway start, and
    DELETE the whole entry on a downgrade. `hermesCloudRouteIsOurs` refuses that
    same entry, and so did the rule this replaces.

    The transcription block above deliberately does NOT use this: nothing it
    writes carries a stamp or a credential, so its endpoint really is the only
    evidence it has, and treating its seeded model list as one would claim an
    owner's own route on our host that happens to serve the same model (two
    cases in gateway-pre-start-clawai-audio.test.ts pin exactly that). Stamping
    what it writes, so the same repair becomes possible there, is its own card.
    """
    _key = _api_key.strip() if isinstance(_api_key, str) else ""
    _has_endpoint = isinstance(_base_url, str) and bool(_base_url.strip())
    if _key and not _key.startswith("claw_"):
        # Somebody else's credential on the entry: only the endpoint can still
        # say it is ours, and a stale stamp cannot.
        return _has_endpoint and _same_endpoint(_base_url, _proxy_base_url)
    if _has_endpoint and not _clawai_host_is_ours(_base_url):
        # Somebody else's HOST. The same kind of evidence as somebody else's
        # key, and the only kind a KEYLESS speech server ever produces — a
        # Kokoro or a Piper on the LAN has no credential to speak for it, and
        # asking only about the key claimed it, overwrote it, and deleted it on
        # a downgrade. Retired addresses of ours are still ours, so this costs
        # the repair below nothing.
        return False
    if _stamped or _key.startswith("claw_"):
        return True
    if not _has_endpoint:
        return not _key
    return _same_endpoint(_base_url, _proxy_base_url)


if _clawai_openai_route_is_ours:
    # Anything already under tools.media.audio that is not what we would write
    # is the owner's own transcription setup: a self-hosted Whisper, a Deepgram
    # key, a different model on our own proxy. Leave all of it alone. A
    # half-applied migration that keeps their endpoint and swaps their model is
    # worse than none, and sending our token to their host is the failure this
    # whole block exists to stop.
    # A non-dict at any of these paths is config the gateway cannot read at
    # all, so it is replaced rather than respected — the same call the `compat`
    # migration below makes, for the same reason.
    _tools = cfg.get("tools")
    if not isinstance(_tools, dict):
        _tools = {}
    _media = _tools.get("media")
    if not isinstance(_media, dict):
        _media = {}
    _audio = _media.get("audio")
    if not isinstance(_audio, dict):
        _audio = {}

    _audio_base_url = _audio.get("baseUrl")
    # v2 keeps baseUrl under tools.media.audio but the model list moved up to
    # tools.media.models (one list for every media capability; audio rows are
    # tagged capabilities: ["audio"]).
    _audio_models = _media.get("models") if _clawbox_v2 else _audio.get("models")
    if _clawbox_v2 and _audio_models is None and _audio.get("models") is not None:
        # A legacy tools.media.audio.models list the loader migration has not
        # moved yet. Seeding the v2 home beside it would duplicate the rows
        # the moment the migration runs; whatever the list holds, this boot
        # leaves the whole surface alone and the next boot sees it migrated.
        _audio_models = _audio.get("models")
    _audio_has_base_url = isinstance(_audio_base_url, str) and bool(_audio_base_url.strip())
    _audio_route_taken = bool(
        (_audio_has_base_url and not _same_endpoint(_audio_base_url, _clawai_proxy_base_url))
        or (_audio_models is not None and not _is_clawbox_audio_models(_audio_models))
    )
    if _audio_route_taken:
        print(
            "  Skipped ClawBox AI speech to text: tools.media.audio already names its own transcription route"
        )
    elif _audio_base_url != _clawai_proxy_base_url or _audio_models is None:
        _audio["baseUrl"] = _clawai_proxy_base_url
        # Seed the list only where there is none. A list this migration
        # recognises is left exactly as Settings wrote it, order included.
        if _audio_models is None:
            _seed = [dict(_entry) for _entry in CLAWBOX_AUDIO_MODELS]
            if _clawbox_v2:
                for _row in _seed:
                    _row["capabilities"] = ["audio"]
                _media["models"] = _seed
            else:
                _audio["models"] = _seed
        _media["audio"] = _audio
        _tools["media"] = _media
        cfg["tools"] = _tools
        changed = True


# Migration: ClawBox AI cloud voice (text to speech).
#
# The mirror image of the block above, and it went wrong the same way. Cloud
# TTS shipped to production on 2026-08-22 (clawbox-website PR #523), so
# ClawBox AI genuinely serves speech now — but nothing on the device was ever
# told, and `messages.tts.providers` on a paired box carries only the local
# CLI entry. So `cloudCredentialIsUnusable` (src/lib/voice-output.ts) read a
# claw_ token with no speech endpoint behind it, correctly concluded it was
# unusable, and every box printed "ClawBox AI does not serve the voice yet" —
# a confident statement about the product that had stopped being true.
# Reproduced on both loop boxes on beta ddd168e through the real Settings UI;
# see TASK-490.
#
# All three fields are load-bearing, measured against the live proxy from .65
# on 2026-08-22 (`openclaw capability tts convert`, 50,688 bytes of real MPEG
# in 1.96 s against 27.7 s for the on-device voice):
#   - `baseUrl`, or OpenClaw sends /audio/speech to api.openai.com and the
#     claw_ token comes back 401. Same shape as the audio baseUrl above: the
#     provider root, with OpenClaw appending /audio/speech.
#   - `model`, or the request carries OpenClaw's own default and the proxy
#     answers 400 — it serves exactly one speech model.
#   - `apiKey`, because the documented fallback for the OpenAI TTS provider is
#     the OPENAI_API_KEY environment variable, which a ClawBox does not set.
#     `models.providers.openai.apiKey` is not consulted for speech.
#
# THE TIER GATE. Cloud speech is Max-only on the proxy (SPEECH_MODEL_TIERS),
# which answers 403 to Free and Pro. Pointing a Pro box at it would be worse
# than leaving it alone: the panel would call the cloud voice configured, Auto
# would move the primary onto it, and every spoken reply would pay a failed
# round trip before falling back to the voice the box already had. So the
# stamp the status route persists from a live portal answer is the gate.
# `clawai_tier` is a DEVICE tier, and "pro" is the device tier of the MAX
# plan — the two names are off by one on purpose (see CLAWBOX_AI_MODEL_BY_TIER
# in src/lib/clawbox-ai-models.ts). Anything else, including a missing stamp,
# means we have not been told this box is entitled, and an unentitled box is
# left exactly as it was. A customer who upgrades gets the cloud voice at the
# next gateway start, once the status route has refreshed the stamp.
#
# The customer-facing "your plan speaks locally, Max speaks in the cloud" line
# is TASK-486 and deliberately not written here.
CLAWBOX_SPEECH_MODEL_ID = "gpt-4o-mini-tts"
CLAWBOX_SPEECH_DEVICE_TIER = "pro"
# Stamped on the entry we write, and the ONLY thing that authorises removing
# one later. Ownership of `models.providers.openai` is decided upstream by the
# image migration, but that says nothing about who wrote
# `messages.tts.providers.openai`, and the downgrade path below is the one
# irreversible action in this file. Matching on the proxy URL alone would let
# it delete a hand-written entry that happens to point at the same host.
# Verified harmless on a real box on 2026-08-22: an unknown key on a speech
# provider entry survives `openclaw config set`, is not stripped, does not
# upset `openclaw doctor`, and the entry still synthesises.
CLAWBOX_SPEECH_MANAGED_KEY = "clawboxManaged"
# v2 moved messages.tts to a top-level tts object; same inner shape. Bound
# via globals() because the unit tests run this block extracted from the file.
_clawbox_v2 = bool(globals().get("CLAWBOX_OPENCLAW_V2", False))

def _clawai_device_tier():
    """The portal-confirmed plan stamp, or None when the store cannot be read.

    Unreadable, absent and malformed all collapse to None on purpose: every one
    of them means "nobody has told us this box is on Max", and the gate below
    treats not-knowing exactly like not-entitled.
    """
    _store_path = os.environ.get("CLAWBOX_DEVICE_STORE") or ""
    if not _store_path:
        return None
    try:
        with open(_store_path) as _fh:
            _store = json.load(_fh)
    except Exception:
        return None
    if not isinstance(_store, dict):
        return None
    _tier = _store.get("clawai_tier")
    return _tier.strip() if isinstance(_tier, str) else None


_clawai_speech_entitled = _clawai_device_tier() == CLAWBOX_SPEECH_DEVICE_TIER

if _clawai_openai_route_is_ours and _clawai_speech_entitled:
    _messages = cfg.get("messages")
    if not isinstance(_messages, dict):
        _messages = {}
    # v2 moved the whole block from messages.tts to a top-level tts object,
    # inner shape unchanged (the loader migration carries clawboxManaged
    # through, so ownership stamps survive the move).
    _tts = (cfg.get("tts") if _clawbox_v2 else _messages.get("tts"))
    if _clawbox_v2 and not isinstance(_tts, dict):
        _legacy_tts = _messages.get("tts") if isinstance(_messages, dict) else None
        if isinstance(_legacy_tts, dict) and _legacy_tts.get("providers"):
            # A legacy messages.tts block the loader migration has not moved
            # yet: writing the v2 home beside it would leave two speech
            # configs racing the migration. Leave it; next boot reads the
            # migrated home.
            _tts = _legacy_tts
    if not isinstance(_tts, dict):
        _tts = {}
    _tts_providers = _tts.get("providers")
    if not isinstance(_tts_providers, dict):
        _tts_providers = {}
    _speech = _tts_providers.get("openai")
    if not isinstance(_speech, dict):
        _speech = {}

    # Whose entry is this? `_clawai_route_is_ours` above holds the whole rule —
    # a foreign credential takes the slot back whatever else says, then our own
    # stamp or a `claw_` token claims it wherever it points, then the endpoint,
    # then an empty slot. An entry that is not ours is the owner's own
    # OpenAI-compatible voice — a self-hosted Kokoro, an OpenAI key of their
    # own, a different route on our host — and every field of it is left alone.
    # The endpoint arm keeps the one-trailing-slash rule the transcription
    # migration uses: `.../api/ai//` is a deliberate route, not a typo to tidy.
    _speech_base_url = _speech.get("baseUrl")
    _speech_route_taken = not _clawai_route_is_ours(
        _speech_base_url,
        _speech.get("apiKey"),
        _speech.get(CLAWBOX_SPEECH_MANAGED_KEY) is True,
        _clawai_proxy_base_url,
    )
    if _speech_route_taken:
        print(
            "  Skipped ClawBox AI cloud voice: messages.tts.providers.openai already names its own speech route"
        )
    else:
        _speech_before = dict(_speech)
        _speech["baseUrl"] = _clawai_proxy_base_url
        _speech["model"] = CLAWBOX_SPEECH_MODEL_ID
        _speech["apiKey"] = _clawai_token
        # Adopt and normalise an unmarked entry that is ours by any of the other
        # arms — a hand repair, one written before this stamp existed, or one
        # still naming an address we have since retired — rather than leave a
        # box with a half-configured voice. Writing is recoverable and
        # deleting is not, which is why only the delete below insists on it.
        _speech[CLAWBOX_SPEECH_MANAGED_KEY] = True
        if _speech != _speech_before:
            _tts_providers["openai"] = _speech
            _tts["providers"] = _tts_providers
            if _clawbox_v2:
                cfg["tts"] = _tts
            else:
                _messages["tts"] = _tts
                cfg["messages"] = _messages
            changed = True

elif _clawai_openai_route_is_ours:
    # The other direction, and it has to exist or this migration is one-way.
    # A box that was Max and is not any more keeps an entry pointing at an
    # endpoint that now answers 403, so every spoken reply buys a refused round
    # trip before falling back — and the panel calls the cloud voice configured
    # while it does it. Take back only what we wrote: our own STAMP — whatever
    # address it names, which is the half this fixes — and not an entry the
    # owner has since re-aimed with a credential of their own. An entry
    # pointing at this host that we did not stamp is somebody's hand-written
    # config, and this is the one place in the file that destroys
    # configuration. An owner's own voice is theirs whatever their ClawBox AI
    # plan says.
    #
    # `messages.tts.provider` is deliberately NOT touched here either. If the
    # customer had explicitly chosen the cloud voice, the panel's job is to show
    # them that their choice is no longer available and that the box is speaking
    # locally instead — which is precisely what it does once the entry is gone.
    # Silently rewriting their pick would hide the downgrade.
    _messages = cfg.get("messages")
    _tts = (cfg.get("tts") if _clawbox_v2 else (_messages.get("tts") if isinstance(_messages, dict) else None))
    _tts_providers = _tts.get("providers") if isinstance(_tts, dict) else None
    _speech = _tts_providers.get("openai") if isinstance(_tts_providers, dict) else None
    if isinstance(_speech, dict):
        _speech_base_url = _speech.get("baseUrl")
        # The STAMP is the authorisation, not the address. Requiring the
        # current proxy URL as well left a downgraded box that had been linked
        # under a previous address holding our own dead entry for good — every
        # spoken reply buying a refused round trip, and the panel calling the
        # cloud voice configured while it did. The stamp still has to be there:
        # this is the one place in the file that destroys configuration, and an
        # unstamped entry is somebody's hand-written config whatever it points
        # at.
        # THE STAMP, and only the stamp, opens this door — narrower than the
        # adopt path above on purpose, and the difference is that this one
        # cannot be undone. A `claw_` token is enough to REFRESH an entry
        # because the worst case is our own fields rewritten to our own values;
        # it is not enough to DELETE one, because an owner can point our own
        # token at our own proxy with a model of their choosing, and that entry
        # is theirs (the suite pins it).
        #
        # `_clawai_route_is_ours` is still asked, for its FOREIGN arms: a
        # stamped entry the owner has since re-aimed is not ours to take,
        # whatever the stamp says — and it is re-aimed whether or not they put a
        # credential of their own on it. The address has to still be one of
        # OURS, because this is the one place in the file that destroys
        # configuration.
        #
        # Residual, and unchanged either way by this rule: a FOREIGN credential
        # sitting on our own CURRENT proxy address still reads as ours, so such
        # an entry is still overwritten and, here, deleted. Narrowing that is a
        # behaviour change beyond this card.
        if (
            _speech.get(CLAWBOX_SPEECH_MANAGED_KEY) is True
            and isinstance(_speech_base_url, str)
            and _speech_base_url.strip()
            and _clawai_route_is_ours(
                _speech_base_url,
                _speech.get("apiKey"),
                True,
                _clawai_proxy_base_url,
            )
        ):
            del _tts_providers["openai"]
            print(
                "  Removed the ClawBox AI cloud voice: this box's plan no longer includes it"
            )
            changed = True


if isinstance(ds_models, list):
    target_efforts = ["off", "high", "xhigh"]
    for model in ds_models:
        if not isinstance(model, dict):
            continue
        if model.get("id") not in ("deepseek-v4-flash", "deepseek-v4-pro"):
            continue
        compat = model.setdefault("compat", {}) if isinstance(model.get("compat"), dict) or "compat" not in model else None
        if compat is None:
            # `compat` exists but isn't a dict — replace it; the gateway
            # only reads it as an object and a stray scalar would crash.
            compat = {}
            model["compat"] = compat
        if compat.get("supportedReasoningEfforts") != target_efforts:
            compat["supportedReasoningEfforts"] = target_efforts
            changed = True
        if compat.get("supportsReasoningEffort") is not True:
            compat["supportsReasoningEffort"] = True
            changed = True

        # Context/output/modality backfill. A configured provider entry
        # overrides OpenClaw's bundled catalog outright, so a model that
        # omits contextWindow does not inherit V4's real 1M window — it
        # silently resolves to the generic 200,000 default. Boxes shipped
        # before this fix are in one of three states: absent, an old
        # explicit 128000, or the 200000 fallback written back by a
        # previous run. All three are wrong and all three are corrected.
        #
        # Only those three values are touched. A number we did not ship
        # is left alone: someone capped it deliberately (a small-RAM box,
        # a cost experiment) and stamping over that would be the migration
        # picking a fight with its operator. Same reason input is only
        # written when absent or empty.
        if model.get("contextWindow") in (None, 128000, 131072, 200000):
            model["contextWindow"] = 1000000
            changed = True
        # maxTokens: filled in when absent, and corrected when it holds a
        # number this migration itself put there. 384000 shipped first and is
        # 9,216 short of the ceiling the upstream enforces (393216 = 384*1024,
        # measured against the live proxy), so a box carrying it is carrying
        # our rounding, not its owner's decision. Any other value is left
        # alone — a box told to cap output at 8K meant it.
        if model.get("maxTokens") in (None, 384000):
            model["maxTokens"] = 393216
            changed = True
        if not isinstance(model.get("input"), list) or not model.get("input"):
            model["input"] = ["text"]
            changed = True

if changed:
    # Atomic write so a crash mid-rewrite can't leave a half-written
    # file where the gateway would refuse to boot.
    #
    # WARN and carry on, never raise. This heredoc is invoked bare, and the
    # script runs under `set -euo pipefail` as the gateway unit's
    # ExecStartPre= with no `-` prefix (config/clawbox-gateway.service) -- so
    # an exception here fails the unit, and Restart=always then spends
    # StartLimitBurst: no gateway and no chat, on every boot. An unwritable
    # ~/.openclaw or a full disk must cost this boot its config migration, not
    # the box its gateway; the gateway starts on the config already on disk,
    # which is the state it was in a moment ago. Same call as the deepseek
    # plugin patch and the MCP registration further down, both already guarded
    # this way. TASK-657.
    #
    # `mkstemp` is INSIDE the guard, and that is the half that was missing: it
    # is the call that raises PermissionError on a directory this uid cannot
    # write and OSError on ENOSPC, and it sat outside the `try` that existed
    # to contain exactly those.
    tmp_path = None
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(cfg_path), prefix=".openclaw.", suffix=".tmp")
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp_path, cfg_path)
        print("  Updated gateway config")
    except Exception as exc:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        print(
            "  WARN: could not write the gateway config (%s: %s); the gateway starts on the config already on disk"
            % (type(exc).__name__, exc),
            file=sys.stderr,
        )
else:
    print("  Gateway config already correct, skipping write")
PY

# OpenClaw 2 refuses to start while any legacy auth-profiles.json remains,
# even when the credentials were already copied into SQLite. Provider setup
# normally runs doctor before restarting, but an interrupted configure or a
# late writer from an older x64 install can recreate the file after that pass.
# Repair only when the sentinel file exists, so normal boots pay no CLI cost.
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then
  LEGACY_AUTH_PROFILE="$(find "$(dirname "$OPENCLAW_CONFIG")/agents" -mindepth 3 -maxdepth 3 -name auth-profiles.json -type f -print -quit 2>/dev/null || true)"
  if [ -n "$LEGACY_AUTH_PROFILE" ]; then
    echo "  Migrating legacy auth profiles into OpenClaw 2 SQLite state..."
    if ! timeout 180 "$OPENCLAW_BIN" doctor --fix --non-interactive </dev/null; then
      echo "  ERROR: OpenClaw 2 auth-profile migration failed" >&2
      exit 1
    fi
    if find "$(dirname "$OPENCLAW_CONFIG")/agents" -mindepth 3 -maxdepth 3 -name auth-profiles.json -type f -print -quit 2>/dev/null | grep -q .; then
      echo "  ERROR: OpenClaw doctor left a legacy auth-profiles.json in place" >&2
      exit 1
    fi
  fi
fi

# Patch the installed openclaw deepseek plugin JSON to declare that the
# DeepSeek V4 models accept `off` and `xhigh` reasoning efforts. The shipped plugin
# only sets `supportsReasoningEffort: true`, but `catalogSupportsXHigh()`
# in openclaw's thinking.ts reads the optional `supportedReasoningEfforts`
# array — without it, sessions.patch rejects `xhigh` for deepseek-v4-pro
# and the chat popup's effort picker errors with "use off|minimal|low|
# medium|high". The provider-stream-shared translation layer already maps
# OpenClaw `xhigh` → DeepSeek's upstream `reasoning_effort: "max"`, so the
# only thing missing was the catalog declaration.
#
# Re-running on every gateway start is necessary because `npm install -g
# openclaw@latest` overwrites this file and the patch needs to survive
# system updates. Idempotent: skips the rewrite if the field already
# matches the target.
DEEPSEEK_PLUGIN_JSON="$(dirname "$OPENCLAW_BIN")/../lib/node_modules/openclaw/dist/extensions/deepseek/openclaw.plugin.json"
if [ ! -f "$DEEPSEEK_PLUGIN_JSON" ]; then
  # OpenClaw 2 unbundled the provider: the manifest lives with the installed
  # plugin, not in the core dist. Same patch, same idempotence — without this
  # the xhigh declaration silently stopped landing and the effort picker
  # refused xhigh for deepseek on every 2026.8 box.
  DEEPSEEK_PLUGIN_JSON="$(dirname "$OPENCLAW_CONFIG")/extensions/deepseek/openclaw.plugin.json"
fi
if [ -f "$DEEPSEEK_PLUGIN_JSON" ]; then
  # Guarded, like the guide seeding further down and for the same reason: this
  # is a bare top-level command in a script under `set -e`, its write `raise`s
  # on failure, and a read-only rootfs or a full disk would turn a cosmetic
  # "declare xhigh reasoning effort" patch into a box with no gateway.
  if ! python3 - "$DEEPSEEK_PLUGIN_JSON" <<'PY'
import json, os, sys, tempfile

path = sys.argv[1]
target = ["off", "high", "xhigh"]
try:
    with open(path) as f:
        cfg = json.load(f)
except (OSError, json.JSONDecodeError):
    sys.exit(0)

models = cfg.get("modelCatalog", {}).get("providers", {}).get("deepseek", {}).get("models", [])
changed = False
for model in models:
    if not isinstance(model, dict):
        continue
    if model.get("id") not in ("deepseek-v4-flash", "deepseek-v4-pro"):
        continue
    compat = model.setdefault("compat", {})
    if compat.get("supportedReasoningEfforts") != target:
        compat["supportedReasoningEfforts"] = target
        changed = True

if changed:
    tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".plugin.", suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise
    print("  Patched deepseek plugin JSON with xhigh reasoning effort")
else:
    print("  Deepseek plugin JSON already declares xhigh, skipping write")
PY
  then
    echo "  WARN: could not patch the deepseek plugin JSON with xhigh reasoning effort; the gateway starts without it" >&2
  fi
fi

# One-time config migration for devices updating from OpenClaw <=2026.5.x:
# the ChatGPT-subscription provider id was renamed `openai-codex` -> `codex`
# in 2026.6.x, so a device configured on the old version still has
# `model.primary = openai-codex/<model>` stored — which 2026.6.x rejects with
# "Unknown model: openai-codex/..." until the user re-picks the model. Rewrite
# the stored primary to `codex/<model>` so the update self-heals (the auth side
# is covered by the ~/.codex synthesis below, which reads the legacy
# openai-codex:default profile).
#
# OpenClaw 2 ONLY, gated like its sibling above (`_clawbox_v2_codex`): on the
# pinned core BOTH `openai-codex/*` and `codex/*` are retired and the canonical
# reference is `openai/<id>`, which `doctor --fix` writes itself. Unguarded,
# this ran `config set ... codex/<id>` on every boot of a v2 box, the core
# refused it, and the WARN below steered the owner at a namespace that no
# longer exists.
if [ "$CLAWBOX_OPENCLAW_V2" != "1" ]; then
# TOTAL, like the reader in the background-job block below and the two
# assignments above: this is a BLOCKING ExecStartPre under `set -euo
# pipefail`, so an unhandled shape here is not a bad answer, it is NO
# GATEWAY. The `except` list catches what was foreseen — and a config whose
# bytes are not UTF-8 raises `UnicodeDecodeError`, a `ValueError` that is NOT
# a `json.JSONDecodeError`, so it escapes. The fallback is this site's own
# documented default, the one its except-branch already prints.
LEGACY_CODEX_PRIMARY="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except (OSError, json.JSONDecodeError):
    print(""); sys.exit(0)
primary = (((cfg.get("agents") or {}).get("defaults") or {}).get("model") or {}).get("primary") or ""
print(primary if isinstance(primary, str) and primary.lower().startswith("openai-codex/") else "")
PY
)" || LEGACY_CODEX_PRIMARY=""
if [ -n "$LEGACY_CODEX_PRIMARY" ]; then
  NEW_CODEX_PRIMARY="codex/${LEGACY_CODEX_PRIMARY#*/}"
  if "$OPENCLAW_BIN" config set agents.defaults.model.primary "$NEW_CODEX_PRIMARY" >/dev/null 2>&1; then
    echo "  Migrated primary model $LEGACY_CODEX_PRIMARY -> $NEW_CODEX_PRIMARY (openai-codex provider renamed to codex in OpenClaw 2026.6.x)"
  else
    echo "  WARN: failed to migrate $LEGACY_CODEX_PRIMARY -> $NEW_CODEX_PRIMARY; Codex chats may fail with 'Unknown model'"
  fi
fi
fi

# Ensure @openclaw/codex runtime plugin is installed if any agent uses
# the codex provider (`openai-codex` on OpenClaw <=2026.5.x, renamed to
# `codex` in 2026.6.x — we detect both). OpenClaw split the codex harness
# out of the core gateway into a separate npm package and only auto-
# installs it during `openclaw onboard --auth-choice codex…`.
# Our configure route writes openclaw.json directly (see the schema-
# drift note in src/app/setup-api/ai-models/configure/route.ts), so
# devices that pick a Codex model never trigger the install and the
# gateway logs `Requested agent harness "codex" is not registered` on
# every chat attempt. Detect the codex provider in config and install
# the plugin idempotently here — mirrors OpenClaw's own
# `modelSelectionShouldEnsureCodexPlugin` detection logic.
# Derive the plugin directory from $OPENCLAW_CONFIG instead of hard-
# coding `/home/clawbox/...` so the script works for non-default
# clawbox users / per-user installs. `dirname $OPENCLAW_CONFIG`
# resolves to `~/.openclaw`, the same root OpenClaw's own plugin
# installer writes under (`<openclaw-home>/npm/node_modules/...`).
OPENCLAW_HOME_DIR="$(dirname "$OPENCLAW_CONFIG")"
# ── Booting WITHOUT a plugin that could not be made loadable ────────────────
#
# TASK-606, owner ruling 2026-09-03 (option a). OpenClaw 2 refuses gateway
# readiness for ANY enabled plugin whose declared surface has not been consented
# to, and for a configured provider with no plugin behind it. Every install and
# consent below used to end its failure branch with "gateway will still start",
# which was not true: the gateway came up, refused readiness, was restarted by
# `Restart=always`, and burned the unit's `StartLimitBurst=20` in about fifteen
# minutes — measured on a box as 46 minutes with no agent and no Telegram, and
# nothing running as `clawbox` clears a start limit at boot. The pre-v2 contract,
# "a degraded provider is better than a dead box", had quietly become false.
#
# So a step that fails now switches the entry OFF and records why, and the box
# boots without that provider or channel. The record is
# `data/plugin-repair.json`, which Settings reads to show a "Needs repair" row
# with the reason and a Retry (src/lib/plugin-repair.ts).
#
# HARNESS FIRST. The switch-off is the core's own `openclaw config set` against
# its own `plugins.entries.<id>.enabled` key — not a hand-written JSON patch —
# and the Retry is nothing but `openclaw plugins install` / `plugins enable` run
# again. `openclaw plugins list --json` is the native answer to "is this plugin
# installed and consented", and it is what the Retry confirms with; it is not
# what Settings polls, because that CLI is a full Node program that loads the
# gateway SDK on every run (~8-10 s on an Orin). This file is the boot script's
# record of what IT could not do, written by the only process that was there.
CLAWBOX_PLUGIN_REPAIR_FILE="$CLAWBOX_ROOT/data/plugin-repair.json"

# `plugins.entries["<id>"].enabled` — bracket notation always, because the ids
# include `@openclaw/discord`, which dot notation would split.
clawbox_plugin_enabled_path() {
  printf 'plugins.entries["%s"].enabled' "$1"
}

# Is this plugin's entry present and enabled in openclaw.json? Answers 1/0, and
# 0 for a config it cannot read — there is nothing to switch off in a file this
# script cannot parse, and the marker below still records the failure.
clawbox_plugin_entry_enabled() {
  CLAWBOX_PLUGIN_ID="$1" python3 - "$OPENCLAW_CONFIG" <<'PY' 2>/dev/null || echo 0
import json, os, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        entries = (json.load(fh).get("plugins") or {}).get("entries") or {}
except (OSError, json.JSONDecodeError):
    print("0"); raise SystemExit(0)
entry = entries.get(os.environ["CLAWBOX_PLUGIN_ID"]) if isinstance(entries, dict) else None
print("1" if isinstance(entry, dict) and entry.get("enabled") is True else "0")
PY
}

# Switch it off through the core's own config writer, and PROVE it landed.
#
# The CLI exit code is not the answer on its own: this is an ExecStartPre with a
# timeout, and a spawn killed at its deadline may still have written the file —
# reporting that as a failure would leave a marker saying "still enabled" over a
# config that says otherwise. Answers 0 only when the file itself now says
# `enabled: false`.
clawbox_plugin_disable() {
  local id="$1"
  timeout -k 5 60 "$OPENCLAW_BIN" config set "$(clawbox_plugin_enabled_path "$id")" false --strict-json \
    >/dev/null 2>&1 || true
  CLAWBOX_PLUGIN_ID="$id" python3 - "$OPENCLAW_CONFIG" <<'PY' 2>/dev/null
import json, os, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        entries = (json.load(fh).get("plugins") or {}).get("entries") or {}
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
entry = entries.get(os.environ["CLAWBOX_PLUGIN_ID"]) if isinstance(entries, dict) else None
raise SystemExit(0 if isinstance(entry, dict) and entry.get("enabled") is False else 1)
PY
}

# The mirror of `clawbox_plugin_disable`, and PROVED the same way.
#
# `openclaw plugins install` deliberately leaves an entry whose
# `plugins.entries.<id>.enabled` is explicitly `false` alone — its config
# enablement short-circuits on exactly that — so a successful install is NOT yet
# a plugin that loads when a previous boot switched the entry off. Answers 0 only
# when the file itself now says `enabled: true`.
clawbox_plugin_reenable() {
  local id="$1"
  timeout -k 5 60 "$OPENCLAW_BIN" config set "$(clawbox_plugin_enabled_path "$id")" true --strict-json \
    >/dev/null 2>&1 || true
  CLAWBOX_PLUGIN_ID="$id" python3 - "$OPENCLAW_CONFIG" <<'PY' 2>/dev/null
import json, os, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        entries = (json.load(fh).get("plugins") or {}).get("entries") or {}
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
entry = entries.get(os.environ["CLAWBOX_PLUGIN_ID"]) if isinstance(entries, dict) else None
raise SystemExit(0 if isinstance(entry, dict) and entry.get("enabled") is True else 1)
PY
}

# Record — or update — one plugin's repair row. Never fatal: a box that cannot
# write this file still boots without the plugin, it just cannot explain itself
# in Settings, and the boot log says so.
clawbox_plugin_repair_mark() {
  local id="$1" stage="$2" disabled="$3" reason="$4" spec="${5:-}"
  if ! CLAWBOX_REPAIR_ID="$id" CLAWBOX_REPAIR_STAGE="$stage" \
    CLAWBOX_REPAIR_DISABLED="$disabled" CLAWBOX_REPAIR_REASON="$reason" \
    CLAWBOX_REPAIR_SPEC="$spec" \
    python3 - "$CLAWBOX_PLUGIN_REPAIR_FILE" <<'PY'
import json, os, sys, tempfile, time

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as fh:
        rows = json.load(fh)
    if not isinstance(rows, dict):
        rows = {}
except (FileNotFoundError, json.JSONDecodeError):
    rows = {}
# A file that EXISTS and cannot be read is not an empty file: rewriting it would
# discard rows for other plugins that are still broken.
except OSError as err:
    print(f"  WARN: could not read {path} ({err.strerror or type(err).__name__}); "
          "the Settings panel will not explain this failure", file=sys.stderr)
    raise SystemExit(1)

plugin_id = os.environ["CLAWBOX_REPAIR_ID"]
rows[plugin_id] = {
    "id": plugin_id,
    "stage": os.environ["CLAWBOX_REPAIR_STAGE"],
    "reason": os.environ["CLAWBOX_REPAIR_REASON"],
    "atMs": int(time.time() * 1000),
    "disabled": os.environ["CLAWBOX_REPAIR_DISABLED"] == "1",
    # THE SPEC THIS SCRIPT ACTUALLY INSTALLS, not the short id. `codex` is
    # installed as `@openclaw/codex@<pinned core>` and the DeepSeek provider as
    # `clawhub:@openclaw/deepseek-provider@<release>`; a Retry that ran
    # `plugins install codex` would resolve @latest, drift ahead of the pinned
    # runtime and crash every Codex chat — the exact bug the pin exists for.
    # Empty for a consent failure, which installs nothing.
    "spec": os.environ.get("CLAWBOX_REPAIR_SPEC") or "",
}
directory = os.path.dirname(path) or "."
os.makedirs(directory, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".plugin-repair.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump(rows, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
  then
    echo "  WARN: could not record the $id plugin repair in $CLAWBOX_PLUGIN_REPAIR_FILE; Settings will show the row as simply not connected" >&2
  fi
}

# Remove a plugin's row after the same step has just worked.
#
# THE OTHER HALF OF THE RULE, and the one that is easy to forget: a marker that
# is only ever written turns into a permanent "Needs repair" badge on a plugin
# that has been fine for weeks — a false failure, and the shape this codebase
# keeps producing. Every success branch below calls this.
clawbox_plugin_repair_clear() {
  # No file, nothing to clear — AND nothing to re-enable from, which is the one
  # gap this pairing does not close: a box whose `clawbox_plugin_repair_mark`
  # could not write (unwritable `data/`, the deliberately non-fatal WARN above)
  # ends the boot with the entry off, no row and no way to know we did it. That
  # is why the mark's failure is a WARN on stderr rather than a silent skip:
  # the boot log is the only record left of it.
  [ -f "$CLAWBOX_PLUGIN_REPAIR_FILE" ] || return 0
  # PUT THE ENTRY BACK BEFORE THE BADGE GOES, and only for a row that says WE
  # switched it off.
  #
  # Every caller here reaches this line off a successful `plugins install` or
  # `plugins enable`. `enable` flips an explicit `false`; `install` does not —
  # it leaves an entry that is explicitly `false` exactly as it found it. So on
  # the install paths the payload came back and the entry stayed OFF, and
  # deleting the row there left the plugin dead with nothing on screen to say
  # so: for DeepSeek permanently, because the install block's own on-disk guard
  # stops it re-running and the managed consent loop only visits entries that
  # are already enabled. Pairing the two here rather than at each success branch
  # is what makes that impossible to forget at the next call site.
  #
  # `disabled: false` means ClawBox recorded a failure and changed nothing —
  # an entry the OWNER turned off is his, and stays off.
  #
  # WHAT THIS COSTS, because this runs inside a blocking ExecStartPre: one
  # python read per clear, and on a row we did switch off one `openclaw config
  # set` cold start (`timeout -k 5 60`) plus the read-back. Only on a box that
  # is actually recovering from a failed plugin — a healthy box has no rows and
  # pays the `[ -f ]` above — but a new call site added to this helper inherits
  # that, so count it against the same budget the managed loop rations.
  if [ "$(CLAWBOX_REPAIR_ID="$1" python3 - "$CLAWBOX_PLUGIN_REPAIR_FILE" <<'PY' 2>/dev/null || echo 0
import json, os, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        rows = json.load(fh)
except (OSError, json.JSONDecodeError):
    print("0"); raise SystemExit(0)
row = rows.get(os.environ["CLAWBOX_REPAIR_ID"]) if isinstance(rows, dict) else None
print("1" if isinstance(row, dict) and row.get("disabled") is True else "0")
PY
)" = "1" ]; then
    if ! clawbox_plugin_reenable "$1"; then
      # The badge STAYS. It is the only true thing left on the screen: the
      # plugin is installed and still switched off, and the Retry the badge
      # offers is the owner's way to try the same write again.
      echo "  WARN: could not switch the $1 plugin back on after repairing it; leaving the repair record in place" >&2
      return 0
    fi
    echo "  Switched the $1 plugin back on after repairing it"
  fi
  # SAID, not swallowed. A clear that fails leaves a "Needs repair" badge on a
  # row that is working — a false failure the owner cannot act on, because the
  # Retry it offers will succeed and change nothing he can see.
  if ! CLAWBOX_REPAIR_ID="$1" python3 - "$CLAWBOX_PLUGIN_REPAIR_FILE" <<'PY' 2>/dev/null
import json, os, sys, tempfile

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as fh:
        rows = json.load(fh)
except (OSError, json.JSONDecodeError):
    raise SystemExit(0)
if not isinstance(rows, dict) or os.environ["CLAWBOX_REPAIR_ID"] not in rows:
    raise SystemExit(0)
del rows[os.environ["CLAWBOX_REPAIR_ID"]]
directory = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".plugin-repair.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump(rows, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
  then
    echo "  WARN: could not clear the $1 plugin repair record; Settings will go on offering a repair for something that now works" >&2
  fi
}

# The whole "boot without it" move: switch the entry off if there is one to
# switch off, record why, and say it in the boot log.
clawbox_plugin_boot_without() {
  local id="$1" stage="$2" reason="$3" spec="${4:-}" disabled=0
  if [ "$(clawbox_plugin_entry_enabled "$id")" = "1" ]; then
    if clawbox_plugin_disable "$id"; then
      disabled=1
      echo "  Switched the $id plugin off so the gateway can start; Settings shows it as needing repair"
    else
      echo "  WARN: could not switch the $id plugin off — the gateway may refuse readiness until it is repaired" >&2
    fi
  fi
  clawbox_plugin_repair_mark "$id" "$stage" "$disabled" "$reason" "$spec"
}

# ── What a capability-consent attempt actually PROVED ───────────────────────
#
# TASK-606 follow-up. `timeout -k 5 60 openclaw plugins enable <id>
# --accept-capabilities` has one failure that says nothing about whether the
# consent was recorded: the kill at the deadline. The verb writes
# `plugins.entries.<id>.enabled` FIRST and only then spends seconds loading the
# gateway SDK, so on a cold Jetson the consent lands and the process is still
# killed at 60 s. Reading that as a refusal switched the entry OFF — and the box
# then booted without a channel its owner had correctly consented, permanently,
# because these loops only ever visit entries that are still `enabled: true`.
#
# Re-reading `enabled` cannot separate the two: it is already `true` before the
# call. NEITHER CAN `plugins inspect --runtime`'s `status`/`activated`, which is
# the trap this block exists to avoid — in 2026.8.1 both fields are the config's
# own enablement decision under another name (`status: enabled ? "loaded" :
# "disabled"` in the loader, `activated: source !== "disabled"` in the
# activation resolver), and no loader or status module consults the consent
# record at all. They are true BEFORE the verb runs and stay true when it never
# landed, so clearing a repair marker on them would be a false success.
#
# The core does publish the real answer, from the persisted install record and
# without loading any plugin runtime: a `diagnostics` entry, emitted for every
# enabled non-bundled plugin whose accepted surface is not current, reading
# `Plugin "<id>" requires capability consent; …`. That is the same sentence the
# updater greps out of the gateway journal (PLUGIN_CAPABILITY_CONSENT_RE), and
# `plugins inspect --all --json` carries it WITHOUT `--runtime` — so this costs
# a CLI start and not a module load of every enabled plugin.
#
# BUT SILENCE IS NOT CONSENT. `collectPluginCapabilityConsentDiagnostics`
# (2026.8.1) walks the INSTALLED index and skips a plugin that is bundled,
# index-disabled, or has no install owner and record; a plugin the index does
# not list at all is never walked. So "no diagnostic names this id" is a
# statement about consent only for an id the core actually adjudicated, and
# reading it as one for the rest is the false success this block exists to
# remove: on a payload stranded by a core generation bump (TASK-602) it would
# leave an unloadable plugin enabled and clear its repair badge, which IS the
# TASK-606 outage.
#
# So the report is asked what it POSITIVELY says about the id, and there are
# three answers rather than two:
#
#   * adjudicated (the entry carries the install record the `--all` branch
#     attaches) and not named by a consent diagnostic -> the consent is
#     recorded: clear the marker, leave the plugin on;
#   * named by a consent diagnostic -> still unconsented: the existing refusal
#     path, unchanged;
#   * the report does not name the id, or names it in a state the core would
#     not load -> nothing was proved and the plugin cannot be relied on to
#     load: the same refusal path, because leaving it enabled is the outage.
#
# WHAT THIS DELIBERATELY DOES NOT DO: it never leaves a plugin the core would
# refuse to load enabled. A gateway that refuses readiness burns
# `StartLimitBurst=20` inside `StartLimitIntervalSec=3600` and the unit is then
# FAILED, not retried — the measured TASK-606 outage — and nothing running as
# `clawbox` clears a start limit at boot.
#
# The one case that changes nothing either way is a plugin the report names but
# keeps NO install record for — `clawbox-email-directives` is exactly that on a
# box today: copied out of the checkout by the block below, so it sits in
# `~/.openclaw/extensions/` with nothing in the installed index to own it.
# (`deepseek` lives in the same directory and is NOT this case — its ClawHub
# install does write a record, and the box's own report says `consented`. The
# directory is not the test; the install record is.)
#
# WHY IT IS SAFE TO LEAVE THAT ONE ENABLED, and the reason is the install record
# and nothing else. It is NOT `status: "loaded"` — that field is read here only
# to withhold evidence, never to grant it, for exactly the reason fifteen lines
# above. It is that every mechanism in 2026.8.1 which can refuse gateway
# readiness over a plugin is gated on an install record: both consent emitters
# (`collectPluginCapabilityConsentDiagnostics`, and the management service's
# `ownership.ok && installRecord`) and the startup payload verification, which
# is driven entirely by `loadInstalledPluginIndexInstallRecords`. A plugin the
# core keeps no record for can therefore neither have its consent reported nor
# block readiness — so switching it off would be a false failure over a plugin
# that cannot be the problem, and calling it accepted/current a false success.
# The boot says which of the two it is in one line and leaves the entry and any
# existing marker exactly as it found them, for the next boot or the Settings
# Retry to resolve.

# The consent question is asked at most ONCE per boot, for every id at once:
# the CLI start is the dominant cost and this runs inside a blocking
# ExecStartPre. Empty until the first kill asks for it.
#
# ONE SNAPSHOT, TAKEN AT THE FIRST KILL OF THE BOOT, and memoised. A consent
# recorded by a LATER killed verb is not in it, so that plugin is still named
# and is switched off — beta's behaviour, and the reason this reads as a fix for
# a consent that was ALREADY current before the boot (the common shape:
# `plugins enable` is idempotent, so it is a slow no-op that gets killed) rather
# than for one written inside the verb that was then killed. The codex verb runs
# before the managed loop, so on a boot whose codex verb is killed the snapshot
# predates every managed plugin's own consent write.
#
# STALE IN ONE DIRECTION ONLY, which is what makes it safe rather than merely
# cautious: `plugins enable --accept-capabilities` only ever ADDS consent, so an
# old snapshot can be wrong by naming a plugin that has since been consented — a
# false failure, identical to beta — and a stale `consented` is unreachable.
#
# The memoisation is not only cost. Measured on a box, this call is ~10 s
# against its 60 s ceiling, so re-reading it per verb would be affordable on a
# HEALTHY box — but the box that reaches this code is one loaded enough to kill
# `plugins enable` at 60 s, and there the inspect can reach its own deadline
# too. Per verb that costs 5 x 65 s to produce the same refusal five times;
# memoised it costs one 65 s attempt and every later verb reuses the answer for
# free. Bounding the damage on that box is what this is for.
CLAWBOX_CONSENT_STATES=""
CLAWBOX_CONSENT_STATES_READY=0

# `@openclaw/discord`, `openclaw-discord` and `discord` are one plugin: the
# registry answers to all three and `ensureChannelPlugin` enables whichever one
# it found, while the core's reports always key on the bare id. Same rule as
# `canonical()` in the managed-plugin reader below, and without it an
# alias-keyed entry would match nothing in the report and be switched off on
# every killed verb.
clawbox_plugin_canonical_id() {
  # The FIRST matching prefix only, because the reader's `canonical()` below
  # returns on its first match too: stripping both here would answer `discord`
  # for `@openclaw/openclaw-discord` where python answers `openclaw-discord`,
  # and two functions written in one commit to implement one rule must not
  # disagree about it.
  case "$1" in
    @openclaw/*) printf '%s' "${1#@openclaw/}" ;;
    openclaw-*) printf '%s' "${1#openclaw-}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# What the core's own report says about each plugin, as ` <state>:<id> ` tokens
# for a substring test. Answers 1 when the question could be asked at all, 2
# when it could not.
clawbox_consent_states_load() {
  local rc=0 file=""
  [ "$CLAWBOX_CONSENT_STATES_READY" = "0" ] || return "$CLAWBOX_CONSENT_STATES_READY"
  # THROUGH A FILE, not through the environment. Measured on a box: this answer
  # is 285 KB for 65 plugin reports, and Linux caps a single environment string
  # at MAX_ARG_STRLEN (131 072), so the `VAR="$out" python3 -` idiom the rest of
  # this script uses for small payloads dies here with E2BIG. A command
  # substitution would hold it in the shell too; the reader gets a path.
  file="$(mktemp 2>/dev/null)" || { CLAWBOX_CONSENT_STATES_READY=2; return 2; }
  # `--all --json` and NOT `--runtime`: the consent diagnostics are on the
  # snapshot path as well, and the runtime flag only adds the hook/tool/service
  # data this question never reads — it is the module load of every enabled
  # plugin that makes that call cost tens of seconds on an Orin. One CLI start
  # answers for every id, which is what keeps this affordable in a blocking
  # ExecStartPre.
  timeout -k 5 60 "$OPENCLAW_BIN" plugins inspect --all --json </dev/null >"$file" 2>/dev/null || rc=$?
  if [ "$rc" != "0" ]; then
    rm -f "$file" 2>/dev/null || true
    CLAWBOX_CONSENT_STATES_READY=2
    return 2
  fi
  # The reader prints `ok` and then the states, so an answer that could not be
  # parsed is NOT read as "every plugin is consented" — that would be the exact
  # false success this whole block exists to remove.
  CLAWBOX_CONSENT_STATES="$(python3 - "$file" <<'PY' 2>/dev/null || true
import json, sys

try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    raise SystemExit(1)


def canonical(name):
    for prefix in ("@openclaw/", "openclaw-"):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


# A consent diagnostic is only ever raised against an id the core adjudicated,
# so collecting them wherever they sit in the document is safe. What the states
# below decide is what their ABSENCE is allowed to mean.
def collect_pending(node, out):
    if isinstance(node, dict):
        for entry in node.get("diagnostics") or []:
            if not isinstance(entry, dict):
                continue
            pid = entry.get("pluginId")
            if isinstance(pid, str) and "requires capability consent" in str(entry.get("message") or ""):
                out.add(canonical(pid))
        for value in node.values():
            collect_pending(value, out)
    elif isinstance(node, list):
        for value in node:
            collect_pending(value, out)


pending = set()
collect_pending(data, pending)

# `--all` answers with a LIST of per-plugin reports (65 of them on a real box);
# a single `inspect <id>` answers with one object.
if isinstance(data, list):
    reports = [item for item in data if isinstance(item, dict)]
elif isinstance(data, dict):
    reports = [data]
else:
    reports = []

states = {}
for report in reports:
    plugin = report.get("plugin")
    if not isinstance(plugin, dict):
        continue
    pid = plugin.get("id")
    if not isinstance(pid, str) or not pid:
        continue
    pid = canonical(pid)
    # `status` is NOT evidence of a consent — it is the config's own enablement
    # bit under another name — and is read here only to WITHHOLD one: a plugin
    # the core would not load must never be left enabled on a "cannot tell".
    if plugin.get("status") != "loaded":
        continue
    # `install` is the install record the `--all` branch attaches per plugin,
    # and it is absent exactly when the core could not resolve an install owner
    # for it — one of the gates in front of every consent diagnostic. Without
    # one the core CANNOT have an opinion on this plugin's consent, so its
    # silence is not one.
    install = report.get("install")
    states[pid] = "consented" if isinstance(install, dict) and install else "seen"

# LAST, so it overrides: a diagnostic is the core speaking, and it outranks
# anything read off the same plugin's own entry — including an entry the report
# does not carry at all.
for pid in pending:
    states[pid] = "pending"

print(" ".join(["ok"] + sorted(f"{state}:{pid}" for pid, state in states.items())))
PY
  )"
  rm -f "$file" 2>/dev/null || true
  case "$CLAWBOX_CONSENT_STATES" in
    ok|"ok "*)
      CLAWBOX_CONSENT_STATES=" ${CLAWBOX_CONSENT_STATES#ok} "
      CLAWBOX_CONSENT_STATES_READY=1
      return 1
      ;;
  esac
  CLAWBOX_CONSENT_STATES=""
  CLAWBOX_CONSENT_STATES_READY=2
  return 2
}

# What the core's report positively says about one plugin's consent.
#   0  it adjudicated the plugin and raised no consent diagnostic — recorded
#   1  it says the plugin still requires consent
#   2  it names the plugin but keeps no install record for it — the question
#      cannot be answered, and cannot arise either (nothing that refuses
#      readiness applies to a plugin with no record)
#   3  it does not name the plugin, names it in a state it would not load, or
#      could not be asked at all
clawbox_plugin_consent_state() {
  local id ready=0
  id="$(clawbox_plugin_canonical_id "$1")"
  clawbox_consent_states_load || ready=$?
  [ "$ready" = "1" ] || return 3
  case "$CLAWBOX_CONSENT_STATES" in
    *" pending:$id "*) return 1 ;;
    *" consented:$id "*) return 0 ;;
    *" seen:$id "*) return 2 ;;
  esac
  return 3
}

# Set by clawbox_plugin_consent_outcome for its caller's own message.
CLAWBOX_CONSENT_DETAIL=""

# The verdict on one consent attempt.
#   0  consented, or already current — clear any repair marker
#   1  not established — the caller's existing refusal path, unchanged
#   2  cannot be established, and the plugin is one the core keeps no install
#      record for — change nothing at all and say so
#
# Only a kill at the deadline asks the second question, and only a definite
# "the core has the consent recorded" changes the answer. 124 is `timeout`
# firing at the ceiling; 137 is the SIGKILL `-k 5` sends five seconds later,
# and is also what the OOM killer sends. Both are asked about rather than
# assumed, so a CLI that chose 124 as its own exit code is not mis-read either.
clawbox_plugin_consent_outcome() {
  local id="$1" rc="$2" state=0
  CLAWBOX_CONSENT_DETAIL=""
  if [ "$rc" = "0" ]; then
    return 0
  fi
  case "$rc" in
    124|137)
      clawbox_plugin_consent_state "$id" || state=$?
      case "$state" in
        0)
          CLAWBOX_CONSENT_DETAIL=" (the consent verb was killed at its deadline, and the core reports the consent as recorded)"
          return 0
          ;;
        2)
          return 2
          ;;
      esac
      ;;
  esac
  return 1
}

# A `.openclaw` INSIDE the state directory is what the CLI leaves behind when
# it was run with OPENCLAW_HOME pointing at the state directory (see the pin
# near the top): a second config, a second empty index, nothing the gateway
# reads. OpenClaw never nests its own tree, so the only question is whether a
# person could have put something there — a real home always carries a
# workspace and a credentials directory, and one with neither is removed.
remove_stray_state_tree() {
  # Only ever the literal nesting `.openclaw/.openclaw`: a state directory
  # under any other name is not the shape this bug produces, and a fresh
  # home may not have its workspace yet.
  [ "$(basename "$1")" = ".openclaw" ] || return 0
  local stray="$1/.openclaw"
  [ -d "$stray" ] || return 0
  if [ -d "$stray/workspace" ] || [ -d "$stray/credentials" ]; then
    echo "  WARN: $stray looks like a real OpenClaw home, leaving it alone"
    return 0
  fi
  if rm -rf "$stray" 2>/dev/null; then
    echo "  Removed the stray OpenClaw state tree at $stray (left by an update that ran the CLI under OPENCLAW_HOME)"
  else
    echo "  WARN: could not remove the stray OpenClaw state tree at $stray"
  fi
}
remove_stray_state_tree "$OPENCLAW_HOME_DIR"
# OpenClaw's plugin install layout changed across versions: older cores wrote
# the plugin flat under <home>/npm/node_modules/@openclaw/codex, while current
# cores (2026.7.x) isolate each plugin in its own project dir under
# <home>/npm/projects/<hash>/node_modules/@openclaw/codex. Hard-coding only the
# flat path made the "is it installed?" check below read the plugin as ALWAYS
# missing on newer cores, so pre-start reinstalled codex on EVERY boot (slow,
# and — before this fix — an unbounded npm install on the blocking boot path,
# a prime "gateway won't start after update" trigger). Resolve to whichever
# layout actually holds the package.json; keep the flat path as the default so
# a first-time install still has a well-known destination.
CODEX_PLUGIN_DIR="$OPENCLAW_HOME_DIR/npm/node_modules/@openclaw/codex"
CODEX_PLUGIN_LAYOUT="flat-managed"
if [ ! -f "$CODEX_PLUGIN_DIR/package.json" ]; then
  CODEX_PLUGIN_DIR_FOUND="$(ls -d "$OPENCLAW_HOME_DIR"/npm/projects/*/node_modules/@openclaw/codex 2>/dev/null | head -1 || true)"
  if [ -n "$CODEX_PLUGIN_DIR_FOUND" ]; then
    CODEX_PLUGIN_DIR="$CODEX_PLUGIN_DIR_FOUND"
    CODEX_PLUGIN_LAYOUT="project-managed"
  fi
fi
# A historical/global install can be visible to OpenClaw's registry without
# living in either managed-home layout above. That is the main→v2 upgrade
# shape: the gateway loads Codex and requires consent, while a filesystem-only
# check sees no package and silently skips the entire repair path. Ask the
# pinned CLI for the root it will actually load, time-bounded because this is
# ExecStartPre, and accept it only when it contains the expected package file.
#
# `-k 5` is what makes "time-bounded" true. Plain `timeout` sends SIGTERM and
# then goes on WAITING for the child, and an `openclaw` that ignores it — or any
# surviving grandchild — keeps this command substitution's pipe open through the
# `python3` stage, which reads stdin to EOF. Bash completes the assignment when
# the SURVIVOR dies, not when `timeout` returns: measured 60 s of wall clock
# against a 2 s ceiling. This is an ExecStartPre with no leading `-`, so that
# stall is the gateway's start time and then the unit's failure — with no agent
# on the box — over the codex plugin-repair probe.
if [ ! -f "$CODEX_PLUGIN_DIR/package.json" ]; then
  CODEX_PLUGIN_DIR_FOUND="$(
    timeout -k 5 20 "$OPENCLAW_BIN" plugins list --json 2>/dev/null |
      python3 -c 'import json, os, sys
try:
    data = json.load(sys.stdin)
except (json.JSONDecodeError, OSError):
    raise SystemExit(0)
plugins = data.get("plugins", []) if isinstance(data, dict) else []
for plugin in plugins:
    if not isinstance(plugin, dict) or plugin.get("id") != "codex":
        continue
    root = plugin.get("rootDir")
    source = plugin.get("source")
    if not isinstance(root, str) and isinstance(source, str):
        parent = os.path.dirname(source)
        root = os.path.dirname(parent) if os.path.basename(parent) == "dist" else parent
    if isinstance(root, str):
        print(root)
    break'
  )" || CODEX_PLUGIN_DIR_FOUND=""
  if [ -n "$CODEX_PLUGIN_DIR_FOUND" ] && [ -f "$CODEX_PLUGIN_DIR_FOUND/package.json" ]; then
    CODEX_PLUGIN_DIR="$CODEX_PLUGIN_DIR_FOUND"
    CODEX_PLUGIN_LAYOUT="registry"
  fi
fi
# OpenClaw's registry resolves dependencies through parent/global node_modules,
# not only the plugin's direct nested folder. Its requiredInstalled verdict is
# therefore authoritative when available; a missing direct peer file can still
# be a completely healthy global/project install. Retain the filesystem check
# as the fallback for older CLIs or malformed registry output.
CODEX_REGISTRY_DEPS_OK=0
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ -f "$CODEX_PLUGIN_DIR/package.json" ]; then
  # `-k 5` for the reason spelled out above the sibling call: without it the
  # ceiling is not one, because a survivor holds this substitution's pipe.
  CODEX_REGISTRY_DEPS_OK="$(
    timeout -k 5 20 "$OPENCLAW_BIN" plugins list --json 2>/dev/null |
      python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except (json.JSONDecodeError, OSError):
    print("0"); raise SystemExit(0)
plugins = data.get("plugins", []) if isinstance(data, dict) else []
for plugin in plugins:
    if not isinstance(plugin, dict) or plugin.get("id") != "codex":
        continue
    deps = plugin.get("dependencyStatus")
    print("1" if isinstance(deps, dict) and deps.get("requiredInstalled") is True else "0")
    break
else:
    print("0")'
  )" || CODEX_REGISTRY_DEPS_OK=0
fi
# TOTAL, like the reader in the background-job block below and the two
# assignments above: this is a BLOCKING ExecStartPre under `set -euo
# pipefail`, so an unhandled shape here is not a bad answer, it is NO
# GATEWAY. The `except` list catches what was foreseen — and a config whose
# bytes are not UTF-8 raises `UnicodeDecodeError`, a `ValueError` that is NOT
# a `json.JSONDecodeError`, so it escapes. The fallback is this site's own
# documented default, the one its except-branch already prints.
NEEDS_CODEX_PLUGIN="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except (OSError, json.JSONDecodeError):
    print("0"); sys.exit(0)
agents = cfg.get("agents")
defaults = agents.get("defaults", {}) if isinstance(agents, dict) else {}
model_selection = defaults.get("model", {}) if isinstance(defaults, dict) else {}
primary = model_selection.get("primary") if isinstance(model_selection, dict) else ""
models_raw = defaults.get("models", {}) if isinstance(defaults, dict) else {}
models = models_raw if isinstance(models_raw, dict) else {}
# Defensive: `cfg["auth"]` may be missing, `None`, or a corrupted
# scalar on a hand-edited config. Match the same isinstance pattern
# used at line 131 for openrouter so a malformed auth block doesn't
# crash pre-start and silently skip the codex install.
auth = cfg.get("auth")
profiles_raw = auth.get("profiles", {}) if isinstance(auth, dict) else {}
profiles = profiles_raw if isinstance(profiles_raw, dict) else {}
uses_codex = (
    isinstance(primary, str)
    and (primary.lower().startswith("codex/") or primary.lower().startswith("openai-codex/"))
) or any(
    isinstance(settings, dict)
    and isinstance(settings.get("agentRuntime"), dict)
    and str(settings["agentRuntime"].get("id", "")).lower() == "codex"
    for settings in models.values()
) or any(
    (isinstance(k, str)
     and (k.lower().startswith("codex:") or k.lower().startswith("openai-codex:"))) or
    (isinstance(v, dict) and isinstance(v.get("provider"), str)
     and v["provider"].lower() in ("codex", "openai-codex"))
    for k, v in profiles.items()
)
print("1" if uses_codex else "0")
PY
)" || NEEDS_CODEX_PLUGIN=0
# OpenClaw 2 loads an installed plugin by default when its config entry is
# absent. That default-enabled state must participate in BOTH the package
# health/version checks and capability consent below; otherwise a migrated
# 2026.7 package can be consented but remain broken against a 2026.8 core.
CODEX_PLUGIN_ENABLED=0
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ -f "$CODEX_PLUGIN_DIR/package.json" ]; then
  # TOTAL, like the reader in the background-job block below and the two
  # assignments above: this is a BLOCKING ExecStartPre under `set -euo
  # pipefail`, so an unhandled shape here is not a bad answer, it is NO
  # GATEWAY. The `except` list catches what was foreseen — and a config whose
  # bytes are not UTF-8 raises `UnicodeDecodeError`, a `ValueError` that is NOT
  # a `json.JSONDecodeError`, so it escapes. The fallback is this site's own
  # documented default, the one its except-branch already prints.
  CODEX_PLUGIN_ENABLED="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except (OSError, json.JSONDecodeError):
    print("1"); sys.exit(0)
plugins = cfg.get("plugins")
entries = plugins.get("entries", {}) if isinstance(plugins, dict) else {}
codex = entries.get("codex") if isinstance(entries, dict) else None
print("0" if isinstance(codex, dict) and codex.get("enabled") is False else "1")
PY
)" || CODEX_PLUGIN_ENABLED=1
fi
# ── OpenClaw 2's three background jobs, opted out of ONCE ───────────────────
#
# TASK-609, owner ruling 2026-09-03. The 2026.8.1 upgrade switches three things
# on by default, and every one of them spends the owner's tokens or messages him
# without being asked:
#
#   heartbeat        `agents.defaults.heartbeat.every` — a recurring agent turn,
#                    30 m by default (1 h on Anthropic OAuth), whose alerts go to
#                    the operator's DM. Measured on a box: "[heartbeat] started"
#                    in the gateway journal at 15:41 and again at 21:08, with
#                    commands.ownerAllowFrom naming exactly one Telegram user.
#   dreaming         `plugins.entries.memory-core.config.dreaming.enabled` —
#                    background memory consolidation on the DEFAULT model, which
#                    on a linked box is the owner's own subscription. The core
#                    logs "[plugins] memory-core: created managed dreaming cron
#                    job." the first time it runs.
#   self-learning    `skills.workshop.autonomous.mode` — `auto` by default, and
#                    the core's own table says `auto` "also enables weekly
#                    collection review", which is the `skill-collection-review`
#                    cron row found enabled in state/openclaw.sqlite.
#
# SEEDED ONCE PER BOX, AND ONLY THEN. The first boot writes the three opt-outs
# for the keys the owner has said nothing about; after that this step is done
# and the harness keys are left alone for ever.
#
# NOT "seed whenever the key is absent", which is what this was first written as
# and is a ONE-WAY switch: turning the check-ins back on means REMOVING
# `agents.defaults.heartbeat.every` — the core's default cadence is 30 m, or an
# hour on Anthropic OAuth, and that distinction applies only while the key is
# unset, so ClawBox has no business freezing it — and an absence gate then reads
# the owner's "on" as "no opinion". Worse, that write is followed by a gateway
# restart whose ExecStartPre is THIS SCRIPT, so the seed would put `0m` back
# before the gateway even started: switch on, panel says on, reload Settings and
# it is off again, for ever.
#
# The record is `data/background-optouts.json`, ClawBox's own file rather than a
# key in the harness's config, because it is a fact about what CLAWBOX did — and
# a factory reset empties `data/`, so a box whose `~/.openclaw` was wiped is
# offered the opt-outs again, which is right.
#
# HARNESS FIRST: all three are the core's own documented keys
# (docs/gateway/heartbeat.md, docs/concepts/dreaming.md, docs/tools/self-learning.md)
# and they are written through the core's own `config set --batch-json`, which
# validates against the schema and applies the whole batch or none of it. One
# CLI start for up to three keys, and only on a box that has not been seeded — a
# seeded box pays nothing at all, which matters inside a blocking ExecStartPre.
CLAWBOX_OPTOUT_STATE="$CLAWBOX_ROOT/data/background-optouts.json"
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then
  CLAWBOX_OPTOUT_BATCH="$(CLAWBOX_OPTOUT_STATE="$CLAWBOX_OPTOUT_STATE" python3 - "$OPENCLAW_CONFIG" <<'SEEDPY' || true
import json, os, sys

# path -> the value ClawBox seeds when the owner has expressed no opinion.
# `0m` rather than removing the key: the core reads an absent `every` as its own
# default, so silence is not an opt-out (docs/gateway/heartbeat.md).
# The third field is whether the OWNER'S "on" is the ABSENCE of the key, which is
# what makes one of these three impossible to re-offer safely without the record:
# switching check-ins on REMOVES `heartbeat.every`, so an absent value there means
# either "never seeded" or "he turned it on". The other two are written
# explicitly in both directions, so an absent value can only mean "no opinion
# expressed" and is always safe to seed.
WANTED = [
    (("agents", "defaults", "heartbeat", "every"), "0m", True),
    (("plugins", "entries", "memory-core", "config", "dreaming", "enabled"), False, False),
    (("skills", "workshop", "autonomous", "mode"), "off", False),
]

try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        cfg = json.load(fh)
except (OSError, json.JSONDecodeError):
    # No config, or one this script cannot read: seeding into it is not this
    # step's business, and the blocks above have already reported on it.
    print("")
    raise SystemExit(0)

def read_seeded(path):
    """The keys this box has already been offered, or None if the record is unusable.

    THREE DIFFERENT FACTS, and only one of them means "the owner has never been
    asked". An ABSENT record is the normal first boot, so seed. A record that is
    THERE but cannot be used — unreadable, undecodable, or valid JSON that is
    not `{"seeded": [<string>, ...]}` — is neither: reading it as "nothing has
    been seeded" would re-seed a box that has been, and for the check-ins key
    that is not a harmless rewrite of a value the config already carries.
    Switching check-ins ON REMOVES `agents.defaults.heartbeat.every` (the core's
    default cadence is what should decide it), so `present()` is false for
    exactly the key the owner has just turned on, and a re-seed writes `0m` back
    over his choice. So: say so, and change nothing.

    The membership test also has to be TOTAL, because the caller's `|| true`
    swallows anything raised here and the box then neither seeds nor explains
    itself — the failure this whole function exists to end. `set()` raises on a
    list of unhashable elements and `sorted()` raises on mixed types, so the
    rows must be strings all the way down before either is reached.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            record = json.load(fh)
    except FileNotFoundError:
        return set()
    # ValueError covers json.JSONDecodeError AND UnicodeDecodeError — a record
    # written in another encoding is unusable, not absent — and RecursionError
    # covers a document nested past the decoder's limit. Nothing may escape:
    # the caller's `|| true` swallows it and the box then neither seeds nor
    # explains itself.
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(record, dict):
        return None
    rows = record.get("seeded")
    if not isinstance(rows, list) or not all(isinstance(row, str) for row in rows):
        return None
    return set(rows)

record = read_seeded(os.environ["CLAWBOX_OPTOUT_STATE"])
unusable = record is None
seeded = set() if unusable else record
if unusable:
    # Says what happened on THIS boot. The "recorded as settled" half is
    # downstream of a `config set` that may still fail, and a WARN that promises
    # it would be a false success in an operator message: on the failing path
    # nothing is recorded and every later boot repeats this.
    print("  WARN: the background-job opt-out record exists but cannot be read; the check-ins"
          " opt-out is being SKIPPED this boot — an absent heartbeat cadence is also what"
          " 'switched on' looks like, and re-seeding it could undo that. It is recorded as"
          " settled, and so stops being offered, once this boot's write and its record both"
          " land; the messages below say whether they did. Switch check-ins off in Settings if"
          " that is what you want.", file=sys.stderr)

def present(path):
    node = cfg
    for part in path:
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return node is not None

batch = []
# Everything not already recorded is DONE with after this boot, whether it was
# written or was already the owner's. A path he had set on the first boot used
# to be skipped and never recorded, so removing it later — which is what
# turning check-ins back on does — offered the seed all over again. Recording
# it is the same statement the batch makes: ClawBox has had its say about this
# key.
settled = []
for path, value, absence_is_on in WANTED:
    key = ".".join(path)
    if key in seeded:
        continue
    settled.append(key)
    if unusable and absence_is_on:
        # The record is there and cannot be read, and for THIS key an absent
        # value is also what the owner's "on" looks like. Recorded as settled so
        # it is never offered again — writing `0m` here could revert his choice,
        # and giving up one opt-out on a box whose record is corrupt is the
        # cheaper of the two mistakes. The WARN above says so.
        continue
    if not present(path):
        batch.append({"path": key, "value": value})
print(json.dumps({"batch": batch, "settled": settled}) if settled else "")
SEEDPY
)"
  if [ -n "$CLAWBOX_OPTOUT_BATCH" ]; then
    # Non-fatal like every other CLI call here: this is a blocking ExecStartPre,
    # and a box that keeps its noisy defaults is far better than one with no
    # gateway. The next boot tries again, because the keys are still absent.
    # GUARDED like every other Python call in this block (SEEDPY with `|| true`,
    # STATEPY inside an `if !`), and for the reason stated just above: under
    # `set -euo pipefail` a failing reader here aborted gateway-pre-start.sh
    # outright, which as a blocking ExecStartPre means NO GATEWAY — the one
    # outcome this block's own policy refuses.
    #
    # The `|| true` alone is not enough. It removes the invariant that this
    # variable is `json.dumps` output, and a reader that fails can still have
    # written to stdout — a `sitecustomize` that prints leaves the banner in the
    # variable and an emptiness test does not fire. So the SHAPE is what is
    # checked, not the length: anything that is not a JSON array is "cannot tell
    # what to write", nothing is recorded, and the next boot tries again.
    CLAWBOX_OPTOUT_WRITES="$(printf %s "$CLAWBOX_OPTOUT_BATCH" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["batch"]))' || true)"
    case "$CLAWBOX_OPTOUT_WRITES" in
      "["*"]") ;;
      *) CLAWBOX_OPTOUT_WRITES="" ;;
    esac
    if [ -z "$CLAWBOX_OPTOUT_WRITES" ]; then
      echo "  WARN: could not read the background-job opt-out batch; leaving the harness keys alone this boot" >&2
    # Nothing to write — every key was already the owner's — so record and move
    # on without paying a CLI start for it.
    elif [ "$CLAWBOX_OPTOUT_WRITES" = "[]" ] \
      || timeout -k 5 90 "$OPENCLAW_BIN" config set --batch-json "$CLAWBOX_OPTOUT_WRITES" >/dev/null 2>&1; then
      [ "$CLAWBOX_OPTOUT_WRITES" = "[]" ] \
        || echo "  Seeded the OpenClaw 2 background-job opt-outs (heartbeat, memory dreaming, self-learning) — Settings can switch any of them back on"
      # RECORDED ONLY AFTER THE WRITE LANDED, and merged with what is there: a
      # seed that failed must be offered again next boot, and a box seeded key
      # by key over several boots must not lose the earlier ones.
      if ! CLAWBOX_OPTOUT_BATCH="$CLAWBOX_OPTOUT_BATCH" \
        CLAWBOX_OPTOUT_STATE="$CLAWBOX_OPTOUT_STATE" python3 - <<'STATEPY'
import json, os, tempfile

path = os.environ["CLAWBOX_OPTOUT_STATE"]
# Same predicate as the reader above, and TOTAL for the same reason: this runs
# after a write that landed, and a record that cannot be used must not stop the
# recording of it — `sorted()` on a mixed list raises, the `if !` below turns
# that into a WARN, and the same seed is then offered at every boot for ever.
# Anything that is not `{"seeded": [<string>, ...]}` is replaced.
#
# The except list matches `read_seeded`'s deliberately. SEEDPY used to exit on an
# unusable record, so this half never saw one; now that it continues, a record
# whose bytes are not valid UTF-8 — the shape a power cut mid-write leaves —
# reaches here, and the narrow guard let `UnicodeDecodeError` out as a raw
# traceback that no boot ever repaired.
try:
    with open(path, encoding="utf-8") as fh:
        record = json.load(fh)
except (OSError, ValueError, RecursionError):
    record = None
rows = record.get("seeded") if isinstance(record, dict) else None
seeded = {row for row in rows if isinstance(row, str)} if isinstance(rows, list) else set()
seeded.update(json.loads(os.environ["CLAWBOX_OPTOUT_BATCH"])["settled"])

directory = os.path.dirname(path) or "."
os.makedirs(directory, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".background-optouts.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump({"seeded": sorted(seeded)}, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
STATEPY
      then
        echo "  WARN: could not record the background-job opt-out seeding; the next boot may re-seed a switch the owner has since turned on" >&2
      fi
    else
      echo "  WARN: could not seed the OpenClaw 2 background-job opt-outs; the box may send unprompted check-ins and spend tokens on background jobs until Settings is used" >&2
    fi
  fi
fi

CODEX_SHOULD_LOAD="$NEEDS_CODEX_PLUGIN"
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ "$CODEX_PLUGIN_ENABLED" = "1" ]; then
  CODEX_SHOULD_LOAD=1
fi
# Also check the nested peer-dep symlink. `openclaw plugins install
# codex` writes `<codex>/node_modules/openclaw -> <global openclaw>`
# alongside the package.json; if that symlink is missing or dangling
# (partial install, openclaw upgrade that cleared the nested
# node_modules, manual cleanup) the codex plugin loads but its
# top-level imports fail at runtime with:
#   Error: Cannot find package 'openclaw' imported from
#   .../@openclaw/codex/dist/shared-client-…js
# Checking only the package.json misses that broken state. `-e`
# follows symlinks, so it catches both "missing" and "dangling".
# `--force` on install rebuilds the symlink without reinstalling
# unnecessary content when the package directory is already there.
CODEX_PEER_DEP="$CODEX_PLUGIN_DIR/node_modules/openclaw/package.json"
CODEX_NEEDS_INSTALL=0
CODEX_INSTALL_REASON=""
if [ "$CODEX_SHOULD_LOAD" = "1" ]; then
  # The direct nested peer symlink is only one valid resolution shape. Trust a
  # positive registry dependency verdict across managed, project, and global
  # layouts; treating a healthy parent-resolved plugin as broken launches a
  # needless reinstall in ExecStartPre, which an updater restart can kill
  # mid-transaction and leave SQLite locked.
  if [ ! -f "$CODEX_PLUGIN_DIR/package.json" ] || {
    [ "$CODEX_REGISTRY_DEPS_OK" != "1" ] && [ ! -e "$CODEX_PEER_DEP" ];
  }; then
    CODEX_NEEDS_INSTALL=1
    CODEX_INSTALL_REASON="missing or peer-dep broken"
  elif [ -n "$OPENCLAW_TARGET" ]; then
    # Version-skew guard. Older builds ran `plugins install codex`, which
    # resolves @latest — so the codex plugin drifts ahead of the pinned core
    # and every Codex chat crashes with "_diagnosticRuntime.
    # createDiagnosticTraceContextFromActiveScope is not a function" (the
    # newer plugin calls a runtime API the pinned core doesn't expose).
    # Reinstall only when the BASE version actually differs.
    #
    # Republish-tolerant compare: npm republishes the SAME release with a
    # -N / -beta.N build suffix (2026.7.1 -> 2026.7.1-1 -> 2026.7.1-2). Those
    # share the same runtime API as their base version, so an exact-string
    # `!=` compare would flag `2026.7.1-1` vs pinned `2026.7.1` as a skew and
    # reinstall the plugin — synchronously, on the gateway boot path — on
    # EVERY boot. On a Jetson with slow/blocked npm that stalls startup and
    # the gateway never comes online ("Update failed / gateway still offline").
    # Strip the build suffix and compare only MAJOR.MINOR.PATCH: a real
    # API-skew (plugin 2026.7.2 vs core 2026.7.1) still triggers a reinstall,
    # a mere republish does not.
    CODEX_INSTALLED_VER=$(python3 -c "import json; print(json.load(open('$CODEX_PLUGIN_DIR/package.json')).get('version',''))" 2>/dev/null || echo "")
    CODEX_INSTALLED_BASE="${CODEX_INSTALLED_VER%%-*}"
    OPENCLAW_TARGET_BASE="${OPENCLAW_TARGET%%-*}"
    if [ "$CODEX_INSTALLED_BASE" != "$OPENCLAW_TARGET_BASE" ]; then
      CODEX_NEEDS_INSTALL=1
      CODEX_INSTALL_REASON="base version $CODEX_INSTALLED_VER != core target $OPENCLAW_TARGET"
    fi
  fi
fi
if [ "$CODEX_NEEDS_INSTALL" = "1" ]; then
  echo "  Installing/repairing @openclaw/codex runtime plugin ($CODEX_INSTALL_REASON)…"
  # Pin to the core target via the full scoped npm spec; fall back to the
  # bare alias only when the pin is unknown, so a needed repair still happens.
  CODEX_SPEC="codex"
  [ -n "$OPENCLAW_TARGET" ] && CODEX_SPEC="@openclaw/codex@$OPENCLAW_TARGET"
  CODEX_CAPABILITY_ARGS=()
  if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then
    CODEX_CAPABILITY_ARGS=(--accept-capabilities)
  fi
  # Hard time-box this install. gateway-pre-start.sh runs as a BLOCKING
  # ExecStartPre for clawbox-gateway.service, so an npm install that hangs
  # (slow/blocked/offline registry on a Jetson) would keep the gateway from
  # ever reaching "listening" — which is exactly the "gateway won't start
  # after update" failure. Best-effort: if the install fails OR times out we
  # log a warning and let the gateway start anyway. Codex is one provider;
  # a degraded Codex is far better than a dead box, and the next boot (or a
  # manual `openclaw plugins install`) can still repair it.
  if timeout 120 "$OPENCLAW_BIN" plugins install "$CODEX_SPEC" --force "${CODEX_CAPABILITY_ARGS[@]}" >/dev/null 2>&1; then
    echo "  Codex runtime plugin installed/repaired ($CODEX_SPEC)"
    clawbox_plugin_repair_clear codex
  else
    # NOT "gateway will still start" any more — see the "Booting WITHOUT a
    # plugin" block above for why that sentence was false under OpenClaw 2.
    echo "  WARN: 'openclaw plugins install $CODEX_SPEC' failed or timed out; booting without Codex"
    clawbox_plugin_boot_without codex install \
      "The ChatGPT (Codex) plugin could not be installed. The device may be offline, or the package registry unreachable." \
      "$CODEX_SPEC"
  fi
elif [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ "$CODEX_SHOULD_LOAD" = "1" ]; then
  # OpenClaw 2 added declared-capability consent to managed plugins. A plugin
  # migrated from 2026.7 may already have the right package, peer dependency,
  # and version — so every repair check above passes — while its install record
  # has no accepted surface hash. The gateway then refuses readiness with
  # "Plugin codex requires capability consent" forever. `enable` is the
  # idempotent local operation for this exact state: it records the current
  # reviewed surface when needed and otherwise leaves an already-enabled,
  # already-consented plugin unchanged. Time-box because this is ExecStartPre.
  # A v1 install can leave Codex enabled even after the owner switches primary
  # auth to another provider. V2 verifies every enabled/default-enabled plugin
  # before opening its port, so consent it even when no Codex model is selected.
  # `-k 5` like every other timed CLI call here: plain `timeout` only sends
  # SIGTERM, and an `openclaw` that ignores it keeps running past the ceiling.
  # It is also what makes 137 reachable, which the classifier below reads the
  # same way as 124.
  CODEX_CONSENT_RC=0
  timeout -k 5 60 "$OPENCLAW_BIN" plugins enable codex --accept-capabilities </dev/null >/dev/null 2>&1 \
    || CODEX_CONSENT_RC=$?
  CODEX_CONSENT_VERDICT=0
  clawbox_plugin_consent_outcome codex "$CODEX_CONSENT_RC" || CODEX_CONSENT_VERDICT=$?
  if [ "$CODEX_CONSENT_VERDICT" = "0" ]; then
    echo "  Codex runtime plugin capabilities accepted/current$CLAWBOX_CONSENT_DETAIL"
    clawbox_plugin_repair_clear codex
  elif [ "$CODEX_CONSENT_VERDICT" = "2" ]; then
    # The core names the plugin but keeps no install record for it, so it can
    # neither report the consent nor refuse readiness over it — see the block
    # above for why that, and not anything `status` says, is what makes leaving
    # it enabled safe. Nothing is switched off and nothing is cleared: an
    # existing repair row is still the truest thing on the screen, and the next
    # boot or the Retry it offers resolves this.
    echo "  Codex runtime plugin capabilities are still unknown (the consent verb was killed at its deadline and the core keeps no consent record for this plugin); leaving it as it is"
  else
    echo "  WARN: could not confirm Codex plugin capabilities; booting without Codex"
    clawbox_plugin_boot_without codex consent \
      "The ChatGPT (Codex) plugin is installed but its capabilities could not be accepted, so the gateway would refuse to start with it enabled."
  fi
fi

# ── Capability consent for the OTHER ClawBox-managed plugins ────────────────
#
# The block above is the codex half of this, and has been here since OpenClaw 2
# added declared-capability consent. The gateway refuses readiness for ANY
# enabled plugin whose declared surface has not been consented to, and ClawBox
# installs four more: deepseek (the provider ClawBox AI rides on), discord and
# whatsapp (installed by the Settings panel when the owner asks for that
# channel) and clawbox-email-directives (ours, copied out of the checkout
# below).
#
# WHY IT MATTERS THAT THIS IS THE BOOT PATH. src/lib/updater.ts repairs the same
# state from the gateway's journal, but only during an update. A box that is
# already down — the 2026-09-01 outage was exactly this, on discord — gets a
# reboot from its owner long before it gets an update, and every boot runs this
# script. Without this block the reboot changed nothing and the gateway came
# back to the same refusal (TASK-603).
#
# `enable` is the idempotent consent verb, as for codex: it records the current
# reviewed surface when needed and leaves an already-consented plugin alone.
# Only for entries openclaw.json ALREADY says to load, so this can never switch
# a channel on — a plugin the owner disabled stays disabled, and one he never
# asked for is never enabled by a boot script. Time-boxed and non-fatal,
# because this is a blocking ExecStartPre.
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then
  MANAGED_ENABLED_PLUGINS="$(python3 - "$OPENCLAW_CONFIG" <<'MANAGEDPY' || true
import json, sys
MANAGED = ("deepseek", "discord", "whatsapp", "clawbox-email-directives")


def canonical(name):
    """`@openclaw/discord` and `openclaw-discord` are the same plugin as `discord`.

    The registry keys a plugin under any of the three and `ensureChannelPlugin`
    enables it under whichever one it found, so matching the literal key would
    skip an enabled alias and leave the gateway blocked on its consent refusal.
    """
    for prefix in ("@openclaw/", "openclaw-"):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        entries = (json.load(fh).get("plugins") or {}).get("entries") or {}
except (OSError, json.JSONDecodeError):
    raise SystemExit(0)
if not isinstance(entries, dict):
    raise SystemExit(0)
# The CONFIGURED key is what `plugins enable` is given — the alias is the name
# the registry answers to — while MANAGED is matched on the canonical one.
for key, entry in entries.items():
    if not isinstance(key, str) or canonical(key) not in MANAGED:
        continue
    if isinstance(entry, dict) and entry.get("enabled") is True:
        print(key)
MANAGEDPY
)"
  for MANAGED_PLUGIN in $MANAGED_ENABLED_PLUGINS; do
    MANAGED_PLUGIN_RC=0
    MANAGED_PLUGIN_OUT="$(timeout -k 5 60 "$OPENCLAW_BIN" plugins enable "$MANAGED_PLUGIN" --accept-capabilities </dev/null 2>&1)" \
      || MANAGED_PLUGIN_RC=$?
    MANAGED_PLUGIN_VERDICT=0
    clawbox_plugin_consent_outcome "$MANAGED_PLUGIN" "$MANAGED_PLUGIN_RC" || MANAGED_PLUGIN_VERDICT=$?
    if [ "$MANAGED_PLUGIN_VERDICT" = "0" ]; then
      echo "  $MANAGED_PLUGIN plugin capabilities accepted/current$CLAWBOX_CONSENT_DETAIL"
      clawbox_plugin_repair_clear "$MANAGED_PLUGIN"
      continue
    fi
    if [ "$MANAGED_PLUGIN_VERDICT" = "2" ]; then
      # Same as the codex arm above: the core names this plugin but keeps no
      # install record for it — `clawbox-email-directives`, the one this script
      # copies out of the checkout rather than installing, is exactly this on a
      # box today — so the core can neither report its consent nor refuse
      # readiness over it. Change nothing, clear nothing, say which of the two
      # it is.
      echo "  $MANAGED_PLUGIN plugin capabilities are still unknown (the consent verb was killed at its deadline and the core keeps no consent record for this plugin); leaving it as it is"
      continue
    fi
    # The consent is not established — either `enable` refused outright, or it
    # was killed and the core does not report the consent as recorded. WHY it
    # said no decides what happens next, and the exit code alone cannot: it is
    # also non-zero for a config lock, a registry hiccup and the kill above,
    # none of which a 120 s npm install repairs. `Plugin not found: <id>`
    # is the core's own wording for the package not being on disk (verified
    # against the installed 2026.8.1 CLI), which is the state a core upgrade
    # leaves behind: plugin payloads live in npm project directories keyed to
    # the core GENERATION, so a bump strands everything installed under the old
    # one (TASK-602). The codex block above asks the same question of the
    # filesystem rather than of an exit code, for the same reason.
    #
    # TWO CARDS MEET HERE, and both of their answers are needed. TASK-602 says
    # a stranded payload is reinstalled from ClawBox's own pinned npm package;
    # TASK-606 says a plugin that still cannot be made loadable is switched off
    # so the gateway can start at all. So: try the reinstall when — and only
    # when — the refusal is the missing payload, and fall through to booting
    # without the plugin whenever that reinstall fails or the refusal was
    # something else. Keeping only one of the two would put back the failure the
    # other card exists to end.
    case "$MANAGED_PLUGIN_OUT" in
      *"Plugin not found"*)
        # The payload is gone, and only ClawBox's own npm packages may be
        # replaced here: deepseek comes from ClawHub and clawbox-email-directives
        # is copied out of the checkout — both have their own block in this
        # script, and an `@openclaw/<id>` guess would fetch a package that is not
        # the plugin. Same list as OFFICIAL_CHANNEL_PLUGINS in
        # src/lib/openclaw-channels.ts, which
        # gateway-pre-start-managed-plugin-payload.test.ts holds it to.
        MANAGED_PLUGIN_KEY="${MANAGED_PLUGIN#@openclaw/}"
        MANAGED_PLUGIN_KEY="${MANAGED_PLUGIN_KEY#openclaw-}"
        MANAGED_PLUGIN_PKG=""
        case "$MANAGED_PLUGIN_KEY" in
          discord|whatsapp) MANAGED_PLUGIN_PKG="@openclaw/$MANAGED_PLUGIN_KEY" ;;
        esac
        if [ -z "$MANAGED_PLUGIN_PKG" ]; then
          # NOT switched off here: the block that owns this plugin runs later in
          # this same script and installs it properly, and it has its own
          # boot-without on failure. Disabling it now would have that block
          # write `enabled: true` back over a marker saying otherwise.
          echo "  WARN: the $MANAGED_PLUGIN payload is missing and ClawBox has no npm package of its own for it; its own installer owns that repair"
          continue
        fi
        # Pinned to the INSTALLED core, like the deepseek block below and unlike
        # the codex one above: this script never installs the core, so on a box
        # that pulled new ClawBox code before its core update landed the pin file
        # names a release the running runtime cannot load.
        # `CLAWBOX_OPENCLAW_EFFECTIVE` is already normalised to
        # MAJOR.MINOR.PATCH above, so an npm republish (2026.7.1 -> 2026.7.1-2)
        # cannot turn into a 404 here. The unpinned spec is the fallback for a
        # core whose release could not be read at all, never a second attempt:
        # this is a BLOCKING ExecStartPre, so ONE 120 s install per plugin is the
        # whole budget — at most 6 minutes for the two ids above, and only on a
        # box whose gateway would not come up at all.
        if [ -n "$CLAWBOX_OPENCLAW_EFFECTIVE" ]; then
          MANAGED_PLUGIN_SPEC="$MANAGED_PLUGIN_PKG@$CLAWBOX_OPENCLAW_EFFECTIVE"
        else
          MANAGED_PLUGIN_SPEC="$MANAGED_PLUGIN_PKG"
        fi
        if timeout -k 5 120 "$OPENCLAW_BIN" plugins install "$MANAGED_PLUGIN_SPEC" --force --accept-capabilities </dev/null >/dev/null 2>&1; then
          echo "  $MANAGED_PLUGIN plugin payload reinstalled ($MANAGED_PLUGIN_SPEC)"
          clawbox_plugin_repair_clear "$MANAGED_PLUGIN"
          continue
        fi
        # The reinstall was the repair and it did not work, so readiness would
        # stay blocked on this entry. The marker carries the SPEC this script
        # tried, so the Settings Retry re-runs the pinned install rather than
        # resolving @latest.
        echo "  WARN: could not reinstall the $MANAGED_PLUGIN plugin payload ($MANAGED_PLUGIN_SPEC); booting without it"
        clawbox_plugin_boot_without "$MANAGED_PLUGIN" install \
          "The plugin payload is missing and could not be reinstalled, so the gateway would refuse to start with it enabled." \
          "$MANAGED_PLUGIN_SPEC"
        continue
        ;;
    esac
    if [ "$MANAGED_PLUGIN" = "clawbox-email-directives" ]; then
      # NOT switched off, and not marked. This one is OURS: it is copied out of
      # the checkout by the block ~450 lines below, which then writes
      # `enabled: true` unconditionally — so a disable here would be undone in
      # the same script run, leaving a marker that says `disabled: true` over a
      # config that says otherwise, on a row no panel can render (it is neither
      # a provider nor a channel) and no Retry can clear. It is also not a
      # registry package: there is nothing for a Retry to install.
      echo "  WARN: could not confirm $MANAGED_PLUGIN plugin capabilities; EMAIL: directives may reach channels" >&2
      continue
    fi
    # The 2026-09-01 outage was this branch, on discord: readiness refused,
    # `Restart=always`, and the start limit gone in a quarter of an hour.
    echo "  WARN: could not confirm $MANAGED_PLUGIN plugin capabilities; booting without it"
    clawbox_plugin_boot_without "$MANAGED_PLUGIN" consent \
      "The plugin is installed but its capabilities could not be accepted, so the gateway would refuse to start with it enabled."
  done
fi

# Codex reads its ChatGPT session from a Codex CLI-style auth.json. Without
# one the app-server falls back to api.openai.com with no bearer -> 401
# "Missing bearer or basic authentication in header", which is what users hit
# as "codex is unusable" on a ChatGPT-subscription box. Two things have to
# line up, and on current cores neither did:
#
#   1. WHERE the app-server reads it. Codex 2026.6.x used the shared
#      ~/.codex. OpenClaw 2026.7.x spawns the app-server with
#      CODEX_HOME=<agentDir>/codex-home (confirmed from the live process
#      environment), so a credential that exists only in ~/.codex is never
#      seen. Mirror it into every agent's codex-home.
#   2. WHERE we read the profile from. The tokens used to live in
#      agents/<id>/agent/auth-profiles.json; on 2026.7.x they moved into the
#      auth_profile_store table of openclaw-agent.sqlite, so the old
#      JSON-only lookup silently found nothing and wrote no credential at all.
#
# THE MIRRORS MUST NOT CARRY refresh_token. ChatGPT OAuth refresh tokens are
# single-use and rotating: the whole family dies the moment two holders each
# present one ("refresh_token has already been used", HTTP 401
# refresh_token_reused). 3.1.11 shipped the mirrors WITH the refresh token,
# which gave the box two independent rotators — core (owner of the OAuth flow,
# persists to openclaw-agent.sqlite) and the Codex app-server binary, which
# rotates whatever sits in its CODEX_HOME. Boxes worked for a few hours and
# then died. See #278.
#
# So: core stays the single rotator, and the mirrors are access-token-only,
# read-only copies. They are REWRITTEN on every boot (not write-if-missing)
# so they track core's current token instead of decaying, and so boxes already
# poisoned by 3.1.11 self-heal on the next restart. Between boots
# clawbox-codex-auth-sync.timer keeps them fresh -- an access token expires in
# about an hour, far short of a reboot interval.
#
# A user-supplied OPENAI_API_KEY in ~/.codex/auth.json is preserved: that is
# the API-key path, which core reads from this file and which has no rotation
# problem.
if [ "$NEEDS_CODEX_PLUGIN" = "1" ]; then
  # Credentials written by the setup wizard can land only in the legacy
  # <agentDir>/auth-profiles.json, while core 2026.7.x resolves auth from the
  # auth_profile_store table of openclaw-agent.sqlite. When that happens core
  # attaches no profile (`profile=-` in the log), sends no bearer, and every
  # turn 401s while the UI still shows the provider as connected. Migrate
  # first, so the mirror below reads a populated store.
  AUTH_PROFILE_MIGRATION="$CLAWBOX_ROOT/scripts/migrate-auth-profiles.js"
  # v1 only: the script copies legacy auth-profiles.json entries into the
  # auth_profile_store table of openclaw-agent.sqlite — a table OpenClaw 2
  # retired (state/openclaw.sqlite's config_machine_state records
  # auth.sharedStore = state-db, and migration_sources shows the move).
  # Writing it on a gen-2 box recreates exactly the legacy state doctor
  # migrates away from; core owns its own store there.
  if [ "$CLAWBOX_OPENCLAW_V2" != "1" ] && [ -f "$AUTH_PROFILE_MIGRATION" ]; then
    node "$AUTH_PROFILE_MIGRATION" "$OPENCLAW_HOME_DIR" || true
  fi

  CODEX_AUTH_MIRROR="$CLAWBOX_ROOT/scripts/codex-auth-mirror.js"
  if [ -f "$CODEX_AUTH_MIRROR" ]; then
    node "$CODEX_AUTH_MIRROR" "$OPENCLAW_HOME_DIR" "$HOME/.codex/auth.json" || true
  else
    echo "  WARN: $CODEX_AUTH_MIRROR missing; Codex credential mirrors not synced"
  fi
fi

# Semantic memory embeddings default. OpenClaw's memory search defaults to
# OpenAI embeddings, which need an OPENAI_API_KEY many boxes don't have
# (ChatGPT-OAuth / DeepSeek users) — surfacing after updates as
# "Semantic memory search is still offline ... missing OpenAI provider
# auth/API-key access", and on the boxes that do have a key it means every
# indexed note is embedded by a third party. scripts/ensure-local-embeddings.sh
# fetches the local model if it is missing, points memory.search at the
# embedder behind the web server's local-AI proxy (only when the provider is
# unset/"auto"/the old ollama one/already ours, so a deliberate remote setup
# stays), and forces the reindex the provider change requires.
#
# Launched DETACHED on purpose: this is a blocking ExecStartPre, the model is a
# ~640MB download, and the script waits for the web server's proxy, which may
# still be starting beside this gateway. The script takes its own lock, so
# overlapping restarts do not stack up downloads.
LOCAL_EMBEDDINGS="$SCRIPT_DIR/ensure-local-embeddings.sh"
LOCAL_EMBEDDINGS_LOG="$CLAWBOX_ROOT/data/local-embeddings.log"
if [ -x "$LOCAL_EMBEDDINGS" ]; then
  mkdir -p "$(dirname "$LOCAL_EMBEDDINGS_LOG")" 2>/dev/null || true
  setsid nohup "$LOCAL_EMBEDDINGS" >>"$LOCAL_EMBEDDINGS_LOG" 2>&1 &
  echo "  Local embeddings check running in the background (see $LOCAL_EMBEDDINGS_LOG)"
else
  echo "  WARN: $LOCAL_EMBEDDINGS missing; semantic memory keeps whatever embeddings provider is configured"
fi

# Ensure the per-install MCP bearer token exists and is wired into the
# openclaw MCP server registration. The token lets the MCP subprocess
# (mcp/clawbox-mcp.ts) authenticate back to /setup-api/* on port 80 —
# without it, middleware.ts 307s every tool call to /login: POSTs
# surface as 405 ("Method Not Allowed" on the GET-only login route)
# and GETs receive the login HTML page that JSON.parse chokes on
# ("Failed to parse JSON"). See src/lib/mcp-token.ts for the matching
# verifier. production-server.js also seeds this file at Next.js boot;
# we mirror that here so the gateway can register the MCP server even
# if it comes up before clawbox-setup on a fresh boot.
MCP_TOKEN_FILE="$CLAWBOX_ROOT/data/.mcp-token"
# One writer, used by the seed below and by the re-harden beneath it, so the two
# cannot drift on entropy source or on mode. `umask 077` rather than a chmod
# afterwards: the file must never exist readable, and on the re-harden path
# chmod is precisely what has just failed.
mcp_write_token() {
  if command -v openssl >/dev/null 2>&1; then
    ( umask 077; openssl rand -hex 32 > "$1" ) 2>/dev/null
  else
    ( umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$1" ) 2>/dev/null
  fi
}
# `{ ...; } 2>/dev/null` rather than `wc ... 2>/dev/null`: a failed INPUT
# redirect is reported by the shell, not by wc, so the narrower form printed a
# bare "Permission denied" into the journal for a token this uid cannot read --
# a line that reads like the boot failing, immediately before the block below
# repairs it.
if [ ! -s "$MCP_TOKEN_FILE" ] || [ "$( { wc -c < "$MCP_TOKEN_FILE"; } 2>/dev/null || echo 0 )" -lt 32 ]; then
  # Every write here is guarded so a full or read-only filesystem cannot abort
  # the boot. Nothing is lost by falling through: the token's readability and
  # length are checked below, and that check is the deliberate hard failure.
  mkdir -p "$(dirname "$MCP_TOKEN_FILE")" 2>/dev/null || true
  mcp_write_token "$MCP_TOKEN_FILE" || true
fi
# Re-harden mode unconditionally: chmod only ran on the regeneration
# path before, so a file with drifted permissions (manual edit, upgrade
# from a pre-0600 build) would keep being trusted as-is. The bearer
# is the sole /setup-api/* credential.
# Guarded: this runs on EVERY boot, and the file is also seeded by
# production-server.js. One created under another uid (a root update step, a
# manual repair) makes chmod return EPERM, and an unguarded failure here cost
# the box its gateway on every boot from then on. TASK-657.
chmod 600 "$MCP_TOKEN_FILE" 2>/dev/null || true
# But the MODE is the outcome, not chmod's exit code -- and the outcome has two
# halves, both of which grading the literal string "600" got wrong:
#
#   * can anyone ELSE read it? A file this uid cannot chmod whose mode carries
#     group/other bits hands the sole /setup-api/* credential to every local
#     user on the box. 0644 is what root's umask gives a bare
#     `openssl rand > file`.
#   * can THIS uid read it? Every shipped writer that can create the file as
#     root leaves it 0600 -- scripts/register-mcp.sh mints under `umask 077`,
#     production-server.js writes `{ mode: 0o600 }` -- so root:root 0600 is the
#     state the fleet actually produces, and it is unreadable to
#     User=clawbox. A `case` keyed on "600"
#     declined to touch exactly that file, and the `[ ! -r ]` check below then
#     exited 1: ExecStartPre fails, no gateway, on every boot.
#
# So grade on `-r` plus the permission bits, never on a literal. The corollary
# matters as much: a mode with no group/other bits that this uid CAN read (0400,
# 0600) is exposed to nobody, and rotating it would be pure cost -- see the
# second WARN below for what a rotation costs.
#
# Replacing it is the only remedy available here that is neither exposure nor a
# brick. The DIRECTORY is clawbox's own (install.sh chowns $PROJECT_DIR/data),
# and a rename is governed by the directory, not by the file's owner -- so a
# file this uid can neither chmod nor read can still be swapped for one it owns
# at 0600. One boot rotates; every boot after it the file is ours and chmod
# succeeds.
MCP_TOKEN_MODE="$(stat -c '%a' "$MCP_TOKEN_FILE" 2>/dev/null || echo unknown)"
# `stat -c %a` prints three or four octal digits (setuid/setgid/sticky make it
# four). Anything else is a box that cannot report a mode at all -- not a reason
# to rotate a working token on its own. `-r` backstops the UNREADABLE half of
# that state; there is no backstop for the exposed half, so say so rather than
# be silent about a bearer nothing could grade.
mcp_mode_is_exposed() {
  case "${1:-}" in
    ''|*[!0-7]*) return 1 ;;
  esac
  [ "$(( 8#$1 & 8#077 ))" -ne 0 ]
}
# `unknown` is never "exposed", so this needs no second call to say so: a mode
# that could not be read on a file that CAN be read is the one state nothing
# below grades, and it passes through silently unless it is said here.
if [ "$MCP_TOKEN_MODE" = unknown ] && [ -r "$MCP_TOKEN_FILE" ]; then
  echo "  WARN: could not read the mode of $MCP_TOKEN_FILE; using it as it stands without checking whether other local users can read it" >&2
fi
if [ ! -r "$MCP_TOKEN_FILE" ] || mcp_mode_is_exposed "$MCP_TOKEN_MODE"; then
  # State the STATE, never a cause this shell cannot establish. The earlier
  # wording asserted "it belongs to another user" for a file that does not exist
  # (the seeding above could not create it, because data/ is not writable) and
  # for a 0644 file this uid owns perfectly well -- the same "a message
  # asserting a cause it cannot know" the pin WARN was corrected for. The
  # outcome sentences below carry the verbs; this carries the fact.
  if [ ! -e "$MCP_TOKEN_FILE" ]; then
    MCP_TOKEN_WHY="does not exist and could not be created"
  elif [ ! -r "$MCP_TOKEN_FILE" ]; then
    MCP_TOKEN_WHY="is mode $MCP_TOKEN_MODE, which this gateway cannot read"
  else
    MCP_TOKEN_WHY="is mode $MCP_TOKEN_MODE, which other local users can read"
  fi
  MCP_TOKEN_TMP="$(mktemp "$(dirname "$MCP_TOKEN_FILE")/.mcp-token.XXXXXX" 2>/dev/null || true)"
  if [ -n "$MCP_TOKEN_TMP" ] && mcp_write_token "$MCP_TOKEN_TMP" \
    && mv -f "$MCP_TOKEN_TMP" "$MCP_TOKEN_FILE" 2>/dev/null; then
    echo "  WARN: $MCP_TOKEN_FILE $MCP_TOKEN_WHY; replaced it with a fresh 0600 token this boot owns." >&2
    # What a rotation costs, and who pays it. The reconcile below republishes
    # the new bearer to the MCP SUBPROCESS only -- it rewrites openclaw.json
    # from whatever the file now holds. It does NOT reach the VERIFIER:
    # src/lib/mcp-token.ts caches in module state and production-server.js pins
    # the value into CLAWBOX_MCP_TOKEN at Next.js boot, and nothing orders
    # clawbox-setup.service against this unit. The verifier now re-reads the
    # file when a bearer check fails, so this heals itself on the next call --
    # but say it, because a device tool that 401s once after a rotation should
    # have a line in the journal explaining itself.
    echo "  WARN: the web server re-reads the rotated bearer on its next /setup-api/* check; restart clawbox-setup.service if device tools keep answering 401." >&2
  else
    if [ -n "$MCP_TOKEN_TMP" ]; then rm -f "$MCP_TOKEN_TMP" 2>/dev/null || true; fi
    echo "  WARN: $MCP_TOKEN_FILE $MCP_TOKEN_WHY, and could be neither re-hardened nor replaced (is $(dirname "$MCP_TOKEN_FILE") writable?) — the MCP bearer for /setup-api/* is left exactly as it stands" >&2
  fi
fi

# Always reconcile the MCP server registration in openclaw.json with
# the current token. Done in Python so the atomic-rename pattern used
# elsewhere in this script applies — and so we can detect a no-op
# update (token already current) without paying the ~10 s cost of
# `openclaw config set`.
#
# Validate explicitly before exporting. `set -euo pipefail` doesn't
# catch a non-failing-but-empty `cat` (the file exists but is empty,
# or the read returned no bytes), and `export VAR="$(cmd)"` masks
# command-substitution exit codes entirely. Without this guard the
# Python block would `sys.exit(0)` on an empty token and silently
# skip the openclaw.json reconcile — leaving the MCP subprocess
# with a stale or missing CLAWBOX_MCP_TOKEN and every tool call
# 307'd to /login again.
#
# WARN and skip, never `exit 1`. This was the last unguarded step in the block,
# and it made every guard above it decorative: when the seeding AND the
# replacement both fail -- `data/` not writable, or ENOSPC on a box whose token
# was never seeded -- control fell out of the "left exactly as it stands" WARN
# straight into an `exit 1` here. `ExecStartPre=` carries no `-` prefix
# (config/clawbox-gateway.service), so that fails the unit, and Restart=always
# then spends StartLimitBurst: no gateway and no chat, on every boot. It is not
# even privileged: `data/` is clawbox-owned at 0755, so any process running as
# clawbox -- a coding-agent run, the in-UI terminal, an ssh session -- reaches it
# by removing the token and chmod-ing the directory. TASK-657, and the same
# outcome the block was rewritten to remove.
#
# A missing bearer costs this boot its MCP tools, exactly like a failed
# registration write below, which has always been a WARN. It must not also cost
# the box its gateway, its chat, the CLAWBOX.md seeding or the deepseek catalog
# pass that follow. The empty value is carried deliberately: the reconcile's
# python `sys.exit(0)`s on it, so openclaw.json keeps whatever it already had.
CLAWBOX_MCP_TOKEN_VAL=""
if [ ! -r "$MCP_TOKEN_FILE" ]; then
  echo "  WARN: MCP token file is not readable ($MCP_TOKEN_FILE); skipping the MCP server registration — the ClawBox MCP tools are unavailable this boot" >&2
else
  CLAWBOX_MCP_TOKEN_VAL="$(cat "$MCP_TOKEN_FILE" 2>/dev/null || true)"
  if [ -z "$CLAWBOX_MCP_TOKEN_VAL" ]; then
    echo "  WARN: MCP token file is empty ($MCP_TOKEN_FILE); skipping the MCP server registration — the ClawBox MCP tools are unavailable this boot" >&2
  elif [ "${#CLAWBOX_MCP_TOKEN_VAL}" -lt 32 ]; then
    # The same threshold the seeding gate above uses, and for the same reason.
    # That gate re-seeds anything under 32 bytes, so a shorter file can only be
    # one whose write did not finish -- an ENOSPC part way through `openssl rand
    # -hex 32 > "$1"`, on the boot where the seed itself failed and `|| true`
    # swallowed it. The length check ran BEFORE that write, so nothing between
    # there and here looks at the value again, and a truncated bearer would be
    # published to openclaw.json as if it were a token this box generated.
    #
    # Refusing it costs the same as an empty one: the MCP tools, for this boot,
    # and the file is re-seeded on the next. Keeping it costs more than it
    # looks. Under 16 characters src/lib/mcp-token.ts's readTokenFile() rejects
    # it outright, the verifier mints its own value instead, and every tool call
    # 307s to /login with nothing in the journal to say why. Between 16 and 31
    # it WORKS -- and that is the bad case, because the box then runs on a
    # bearer with a fraction of the intended entropy and nothing ever says so.
    #
    # 32 rather than a 64-hex literal on purpose: three writers seed this file
    # (mcp_write_token's two branches and production-server.js) and all three
    # produce 64 hex characters today, but the gate above is the one that
    # decides what counts as seeded, and the two must not be able to disagree.
    echo "  WARN: MCP token file holds only ${#CLAWBOX_MCP_TOKEN_VAL} characters ($MCP_TOKEN_FILE), too short to be a token this box wrote; skipping the MCP server registration — the ClawBox MCP tools are unavailable this boot" >&2
    CLAWBOX_MCP_TOKEN_VAL=""
  fi
fi
export CLAWBOX_MCP_TOKEN_VAL
export CLAWBOX_BUN_BIN="${CLAWBOX_BUN_BIN:-$CLAWBOX_HOME_DIR/.bun/bin/bun}"
export CLAWBOX_MCP_ENTRY="${CLAWBOX_MCP_ENTRY:-$CLAWBOX_ROOT/mcp/clawbox-mcp.ts}"
export CLAWBOX_API_BASE="${CLAWBOX_API_BASE:-http://127.0.0.1:$CLAWBOX_PORT}"
# Guarded for the same reason as the deepseek patch above: a bare heredoc whose
# write `raise`s, in a script under `set -e`. A full disk must cost this boot
# its MCP registration, never its gateway.
if ! python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, sys, tempfile

cfg_path = sys.argv[1]
token = os.environ.get("CLAWBOX_MCP_TOKEN_VAL", "")
if not token:
    sys.exit(0)
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except (OSError, json.JSONDecodeError):
    sys.exit(0)

desired = {
    "command": os.environ["CLAWBOX_BUN_BIN"],
    "args": ["run", os.environ["CLAWBOX_MCP_ENTRY"]],
    "env": {
        "CLAWBOX_API_BASE": os.environ["CLAWBOX_API_BASE"],
        "CLAWBOX_MCP_TOKEN": token,
    },
}
mcp_servers = cfg.setdefault("mcp", {}).setdefault("servers", {})
if mcp_servers.get("clawbox") == desired:
    print("  MCP server registration already current, skipping write")
    sys.exit(0)
mcp_servers["clawbox"] = desired
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
print("  Updated MCP server registration with bearer token")
PY
then
  echo "  WARN: could not write the MCP server registration; the ClawBox MCP tools are unavailable this boot" >&2
fi
unset CLAWBOX_MCP_TOKEN_VAL

# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ────────────
#
# ONE INSTALLER FOR BOTH of the plugins ClawBox ships (the protected-path deny
# of TASK-605 below, and the EMAIL:-directive strip after it). It was one
# plugin's worth of straight-line script until the second arrived; a copy of it
# would have been two places for the partial-write handling to drift apart, and
# every failure this function reports was learned the hard way once already.
#
# Arguments: <plugin id> <destination dir> <consequence sentence> <source file>...
# Sets CLAWBOX_HOOK_PLUGIN_READY to 1 only when the files are on disk AND the
# config says the gateway may load them.
#
# The sources are absolute paths rather than names under one directory, because
# the path guard's table lives in `config/` beside the rest of the product's
# rendered configuration and is read by the Hermes edition too.
install_clawbox_hook_plugin() {
  local plugin_id="$1" dst="$2" consequence="$3"
  shift 3
  local sources=("$@")
  local src

  CLAWBOX_HOOK_PLUGIN_READY=0

  for src in "${sources[@]}"; do
    if [ ! -f "$src" ]; then
      echo "  WARNING: $src is missing, so $plugin_id is not a complete plugin — $consequence" >&2
      return 0
    fi
  done

  # THE SOURCES ARE READ BEFORE ANYTHING ON DISK IS TOUCHED. `cp` opens its
  # source first and leaves the destination alone when that open fails, so a
  # source-side problem — a checkout still being written by the updater, a
  # permission slip — must NOT be treated the same as a copy that died half-way.
  # Answering that question here rather than after the fact is what lets the
  # failure branch below know which state the box is in.
  if ! cat "${sources[@]}" > /dev/null 2>&1; then
    # The installed copy, if there is one, is untouched and still the last one
    # that worked. Leaving it alone is strictly better than removing it.
    echo "  WARNING: could not read the $plugin_id plugin sources — leaving whatever is already installed in place" >&2
    return 0
  fi

  # Overwritten unconditionally: the files are OURS and versioned with the app,
  # so an update that ships a fixed plugin has to actually deliver it. There is
  # no customer edit here to preserve.
  if mkdir -p "$dst" 2>/dev/null && cp -f "${sources[@]}" "$dst/" 2>/dev/null; then
    CLAWBOX_HOOK_PLUGIN_READY=1
  else
    # Never fatal. Without the plugin the box behaves exactly as it did before
    # this existed; a gateway that refuses to start would be strictly worse.
    #
    # BUT THE HALF-WRITTEN COPY GOES. The sources read cleanly a moment ago, so
    # a failure here is on the WRITE side — ENOSPC, an I/O error, a target that
    # is not a file any more — and `cp -f` truncates each target before it
    # writes it. Whatever is in the destination now is a mixture of new files,
    # truncated files and stale ones, and `plugins.entries.<id>.enabled` (true
    # from an earlier boot) still tells the gateway to import it. Removing it
    # leaves ONE state instead of that — no plugin, no hook, and a line that
    # says so — rather than a module that may throw halfway through parsing.
    # Where the removal cannot work either — a read-only filesystem, or a
    # destination directory whose mode lets `cp` truncate the files already in
    # it but does not let `rm` unlink them — the removal is REPORTED as not
    # done. Claiming a cleanup that did not happen is the false success this
    # step exists to avoid, and it is the difference between "nothing loads" and
    # "the gateway imports a plugin that is missing a file".
    if rm -rf "$dst" 2>/dev/null; then
      echo "  WARNING: could not install the $plugin_id plugin into $dst — anything partial there has been removed rather than left for the gateway to import, so $consequence until the next boot repairs it" >&2
    else
      echo "  WARNING: could not install the $plugin_id plugin into $dst AND could not remove what is there — the gateway may import a partial copy. $consequence; the next boot repairs it only if that path becomes writable" >&2
    fi
    return 0
  fi

  # Enabled only once the files are on disk, so the config can never name a
  # plugin that is not there. `plugins.entries.<id>.enabled` is the core's own
  # load-permission key; the manifest's `activation.onStartup` is what makes a
  # HOOK-ONLY plugin load at all (a plugin with no tool, provider or channel has
  # no other reason to be constructed) — the two together are the documented
  # startup intent.
  #
  # `if !` rather than a bare call: this script is an ExecStartPre with no
  # leading `-`, under `set -euo pipefail`, so an unwritable ~/.openclaw (a full
  # disk, a partition remounted read-only after an unclean shutdown) would
  # otherwise re-raise out of the write below, fail the unit, and leave the box
  # with no agent at all — over a hook this very block calls optional.
  if ! CLAWBOX_HOOK_PLUGIN_ID="$plugin_id" python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, sys, tempfile

cfg_path = sys.argv[1]
plugin_id = os.environ["CLAWBOX_HOOK_PLUGIN_ID"]
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError, OSError):
    # A config this script could not read is one the blocks above already
    # reported on; writing a fresh one from here would discard it.
    #
    # NON-ZERO, so the caller reports it and clears READY. Exiting 0 here made
    # the function's own contract false — "READY=1 means the files are on disk
    # AND the config says the gateway may load them" — on the one box where it
    # matters: a corrupt openclaw.json left the plugin installed, unenabled, and
    # the boot log silent, so the operator saw a clean start on a device whose
    # guard the gateway would never load.
    sys.exit(1)

plugins = cfg.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
    cfg["plugins"] = plugins
entries = plugins.get("entries")
if not isinstance(entries, dict):
    entries = {}
    plugins["entries"] = entries
entry = entries.get(plugin_id)
if not isinstance(entry, dict):
    entry = {}
    entries[plugin_id] = entry

if entry.get("enabled") is True:
    print(f"  {plugin_id} already enabled, skipping write")
    sys.exit(0)

entry["enabled"] = True
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
print(f"  Enabled {plugin_id}")
PY
  then
    echo "  WARNING: could not enable the $plugin_id plugin in $OPENCLAW_CONFIG — $consequence" >&2
    CLAWBOX_HOOK_PLUGIN_READY=0
  fi
  return 0
}

# ── The protected-path deny hook ───────────────────────────────────────────
#
# TASK-605: a turn asked to "delete the largest of those files" ran rm on a
# 3.2 GB local-model GGUF. The owner's ruling of 2026-09-04 is a hard deny on
# the local-model folder and the ClawBox tree, with no confirmation prompt
# anywhere — "narrower, but silent when it bites".
#
# HARNESS FIRST, AND WHAT OPENCLAW ACTUALLY OWNS. There is no path-scoped deny
# to configure on 2026.8.1: `tools.exec.mode` is `deny|allowlist|ask|auto|full`
# over ALL host exec, an approvals allowlist entry is a glob over the BINARY,
# and tool policy is per tool, not per path. The core's own advice is
# all-or-nothing ("To hard-block host exec, set approvals security to `deny` or
# deny the `exec` tool via tool policy", docs/tools/exec-approvals.md), which
# would take the shell away from the agent entirely. The seam that CAN express a
# path is the typed `before_tool_call` hook — "Block a tool or request
# approval", `{ block: true, blockReason }`, docs/plugins/hooks.md — so the deny
# is a plugin, installed exactly like the EMAIL: one above. The Hermes edition
# uses its own native `approvals.deny` globs instead (scripts/register-mcp.sh);
# both read config/protected-paths.json and one test holds them to one answer.
CLAWBOX_PATH_GUARD_ID="clawbox-path-guard"
CLAWBOX_PATH_GUARD_SRC="$CLAWBOX_ROOT/scripts/openclaw-plugins/$CLAWBOX_PATH_GUARD_ID"
CLAWBOX_PATH_GUARD_DST="$OPENCLAW_HOME_DIR/extensions/$CLAWBOX_PATH_GUARD_ID"
CLAWBOX_PATH_GUARD_TABLE="$CLAWBOX_ROOT/config/protected-paths.json"
install_clawbox_hook_plugin "$CLAWBOX_PATH_GUARD_ID" "$CLAWBOX_PATH_GUARD_DST" \
  "the ClawBox tree and the local-model folders are NOT protected from the agent's tool calls" \
  "$CLAWBOX_PATH_GUARD_SRC/openclaw.plugin.json" \
  "$CLAWBOX_PATH_GUARD_SRC/package.json" \
  "$CLAWBOX_PATH_GUARD_SRC/index.mjs" \
  "$CLAWBOX_PATH_GUARD_SRC/path-guard.mjs" \
  "$CLAWBOX_PATH_GUARD_TABLE"

# PROVE THE COPY IS A WORKING GUARD, not just five files with the right names.
#
# Cheap on purpose — one `node` start against the INSTALLED copy, tens of
# milliseconds, no `openclaw` CLI and no module-load of the other 40-odd
# plugins. It answers the two questions a file list cannot: does the module
# import (the table is the one thing it reads, and a truncated or absent
# protected-paths.json is exactly what a half-finished cp leaves), and does the
# rule it loaded still refuse the command that opened this task.
#
# This is NOT the same claim `openclaw plugins inspect --runtime` makes for the
# EMAIL: plugin below — it does not prove the gateway imported the extension —
# but it removes every failure this install can cause on its own, at a cost the
# boot budget in this file's header can afford.
CLAWBOX_PATH_GUARD_NODE="$(command -v node 2>/dev/null || true)"
if [ "$CLAWBOX_HOOK_PLUGIN_READY" != "1" ]; then
  :
elif [ -z "$CLAWBOX_PATH_GUARD_NODE" ]; then
  echo "  NOTE: no node on PATH, so the installed $CLAWBOX_PATH_GUARD_ID plugin was not exercised here — it is installed and enabled, and the gateway loads it with its own node" >&2
else
  if ! CLAWBOX_PATH_GUARD_DST="$CLAWBOX_PATH_GUARD_DST" "$CLAWBOX_PATH_GUARD_NODE" --input-type=module -e '
    const dir = process.env.CLAWBOX_PATH_GUARD_DST;
    const plugin = (await import(`${dir}/index.mjs`)).default;
    const hooks = [];
    plugin.register({ on: (name) => hooks.push(name) });
    if (!hooks.includes("before_tool_call")) throw new Error("no before_tool_call hook");
    const { toolCallDenyReason } = await import(`${dir}/path-guard.mjs`);
    const denied = toolCallDenyReason(
      { toolName: "exec", params: { command: "rm ~/clawbox/data/llamacpp/models/x.gguf" } },
      "/home/clawbox",
    );
    if (!denied) throw new Error("the installed rule does not refuse a model-folder delete");
  ' 2>&1; then
    echo "  WARNING: the installed $CLAWBOX_PATH_GUARD_ID plugin did not load or did not refuse a model-folder delete — the ClawBox tree and the local-model folders are NOT protected from the agent's tool calls" >&2
  fi
fi

# ── The outbound EMAIL:-directive hook plugin ───────────────────────────────
#
# `EMAIL:4471` is how the agent tells a ClawBox CHAT that its reply points at a
# message the owner can open: chat-email-refs.ts lifts the line out and the
# bubble shows a card. Telegram, WhatsApp and Discord have no cards, so there
# the line is an internal id printed at the owner (TASK-679). PR #605 stopped
# the email tools ASKING for it on a channel; that half is a sentence in a tool
# result, and a sentence is something a model can misread. This is the
# guarantee behind it.
#
# THE SEAM IS THE CORE'S OWN: `reply_payload_sending`, the typed outbound hook
# ("Mutate or cancel normalized reply payloads before delivery"). It runs after
# the core has already parsed its own MEDIA: and [[…]] directives out and
# before the channel adapter sends, on every delivery path — and it is
# fail-open with a 15 s ceiling, so a fault in our handler is logged and
# skipped, never a reply that does not arrive.
#
# THE SAME PLUGIN NOW CARRIES THE INBOUND HALF: `before_dispatch`, the core's
# typed inbound CLAIM hook ("Handle an inbound message before the normal model
# dispatch"), which is how the owner's "send <code>" reply to a queued email
# reaches ClawBox without a second Telegram bot — see
# scripts/openclaw-plugins/clawbox-email-directives/email-approvals.mjs and
# src/lib/email-approval-reply.ts. It needs no conversation-access grant (the
# core gates only the prompt/agent hooks), so nothing about the config written
# below changes for it.
#
# THE FIRST PLUGIN CLAWBOX EVER SHIPPED INTO OPENCLAW. The four non-stock
# plugins on a box today (deepseek, codex, discord, whatsapp) are all upstream
# packages installed by npm; this one is ours, so it is copied from the
# checkout instead — no registry, no network, and it moves with the app.
#
# WHY HERE. `~/.openclaw` does not survive a factory reset (setup/reset's
# OPENCLAW_DIR wipe), and this script is an ExecStartPre of the gateway unit,
# so every boot puts the plugin back. Same reason register-mcp.sh owns the
# Hermes twin.
CLAWBOX_HOOK_PLUGIN_ID="clawbox-email-directives"
CLAWBOX_HOOK_PLUGIN_SRC="$CLAWBOX_ROOT/scripts/openclaw-plugins/$CLAWBOX_HOOK_PLUGIN_ID"
CLAWBOX_HOOK_PLUGIN_DST="$OPENCLAW_HOME_DIR/extensions/$CLAWBOX_HOOK_PLUGIN_ID"
CLAWBOX_HOOK_PLUGIN_FILES="openclaw.plugin.json package.json index.mjs email-directives.mjs email-approvals.mjs"
install_clawbox_hook_plugin "$CLAWBOX_HOOK_PLUGIN_ID" "$CLAWBOX_HOOK_PLUGIN_DST" \
  "EMAIL: directives will reach channels and approving a queued email from Telegram will not work" \
  "$CLAWBOX_HOOK_PLUGIN_SRC/openclaw.plugin.json" \
  "$CLAWBOX_HOOK_PLUGIN_SRC/package.json" \
  "$CLAWBOX_HOOK_PLUGIN_SRC/index.mjs" \
  "$CLAWBOX_HOOK_PLUGIN_SRC/email-directives.mjs" \
  "$CLAWBOX_HOOK_PLUGIN_SRC/email-approvals.mjs"

if [ "$CLAWBOX_HOOK_PLUGIN_READY" = "1" ]; then

  # PROVE IT LOADS — whenever the answer could have changed.
  #
  # `plugins list` is a cold inventory: it reads the config and the manifests,
  # so it would call this plugin "enabled" while its module throws on import or
  # registers nothing. `inspect --runtime` actually loads the module and
  # reports what registered, and the hook names live in the TOP-LEVEL
  # `typedHooks[]` — `plugin.hookNames` is empty even when `hookCount` is not.
  #
  # BUT IT IS NOT FREE, AND THIS SCRIPT EXISTS TO BE FREE. The header of this
  # file records why: seven `openclaw config set` calls at ~10 s of CLI cold
  # start each put ~70 s between systemd "starting" and the gateway listening,
  # and the desktop's OpenClaw iframe renders "Reload gateway" through all of
  # it. `inspect --runtime` is heavier than any of them — a registry snapshot
  # plus a module load of every enabled plugin — and a gateway restart happens
  # on a skill install, a Telegram reconfigure, a provider change, a chat model
  # switch and every crash. Paying it on all of those would put the delay back.
  #
  # So it is gated on a STAMP of the two things that can change the answer: the
  # bytes of the plugin we just copied, and the pinned core they run against. A
  # normal restart matches the stamp and spends nothing. An update, a factory
  # reset (which takes `~/.openclaw` and the stamp with it) or an edited plugin
  # does not match, and pays once.
  #
  # THE SUCCESS STAMP IS ONLY EVER WRITTEN ON SUCCESS, so a box where the hook
  # did not register keeps asking rather than settling for a marker file that
  # says "checked once" — but it asks at a BOUNDED rate, which the second stamp
  # below is for.
  #
  # Advisory, and time-boxed: this is an ExecStartPre, and a plugin that failed
  # to load must cost the box its directive strip, never its gateway.
  # WHERE THE BOOKKEEPING LIVES. Beside `~/.openclaw`, not inside
  # `extensions/`: that directory is the core's own global plugin root and the
  # loader enumerates it. A dot-prefixed plain file would almost certainly be
  # skipped, and "almost certainly" is not a thing to build on — nor is dropping
  # ClawBox state into a directory the harness owns. `$OPENCLAW_HOME_DIR` keeps
  # both properties the stamp needs (beside the thing it describes, and taken by
  # the factory reset that takes the plugin) and is outside the scan.
  CLAWBOX_HOOK_STAMP_FILE="$OPENCLAW_HOME_DIR/.$CLAWBOX_HOOK_PLUGIN_ID-verified"
  # AND A SECOND STAMP, FOR THE ATTEMPTS THAT DID NOT CONFIRM.
  #
  # The success stamp alone left the two inconclusive verdicts unbounded, and
  # those are the ones most likely to be PERMANENT rather than transient: a
  # build with no `plugins inspect` subcommand, a plugin the CLI cannot resolve,
  # an Orin that cannot module-load 44 plugins inside the 45 s ceiling. Such a
  # box never stamps, so it paid the full CLI cold start on EVERY gateway
  # restart — a skill install, a Telegram reconfigure, a provider change, a chat
  # model switch, every crash — for ever, which is the regression the header of
  # this file exists to prevent.
  #
  # So an attempt is recorded too, with its verdict and the time. Nothing has
  # changed and the last answer is fresh: say what it was and move on. The
  # operator still hears about a broken box on every single boot; they just do
  # not pay 10-45 s for the box to repeat itself.
  CLAWBOX_HOOK_ATTEMPT_FILE="$OPENCLAW_HOME_DIR/.$CLAWBOX_HOOK_PLUGIN_ID-attempted"
  CLAWBOX_HOOK_RETRY_AFTER=86400
  # WHAT THE STAMP HAS TO COVER: everything the answer depends on.
  #
  # The plugin's own bytes and the pinned core are the obvious two. The third is
  # the OTHER ENABLED PLUGINS, because `inspect --runtime` module-loads every one
  # of them — and ClawBox itself changes that set AFTER a good verification
  # (`src/app/setup-api/discord/configure/route.ts` and
  # `src/lib/openclaw-config.ts` both write `plugins.entries`, and the gateway
  # restarts). Without this a plugin installed later that breaks the loader
  # would stop ours registering while the boot log positively claimed
  # "unchanged since it was last verified" — a false success of exactly the kind
  # the readback exists to prevent. One `python3` start (~30 ms) against the
  # 10-45 s this gate is here to save.
  CLAWBOX_HOOK_PLUGIN_SET="$(python3 - "$OPENCLAW_CONFIG" <<'PY' 2>/dev/null
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    entries = ((cfg.get("plugins") or {}).get("entries") or {})
    if not isinstance(entries, dict):
        raise ValueError
except Exception:
    # Unreadable is its own value: it must not collide with "no plugins".
    print("unreadable")
else:
    print(",".join(sorted(k for k, v in entries.items() if isinstance(v, dict) and v.get("enabled") is True)))
PY
  )" || CLAWBOX_HOOK_PLUGIN_SET="unreadable"
  CLAWBOX_HOOK_STAMP="$( { (cd "$CLAWBOX_HOOK_PLUGIN_SRC" && cat $CLAWBOX_HOOK_PLUGIN_FILES) \
    && printf 'core=%s\nplugins=%s\n' "${OPENCLAW_TARGET:-unpinned}" "$CLAWBOX_HOOK_PLUGIN_SET"; } 2>/dev/null | sha256sum 2>/dev/null | awk '{print $1}' || true)"
  CLAWBOX_HOOK_NEEDS_VERIFY=1
  CLAWBOX_HOOK_BACKOFF=""
  CLAWBOX_HOOK_BACKED_OFF=0
  # An empty stamp means we could not compute one (no sha256sum): verify every
  # boot rather than skip on a comparison that cannot fail.
  if [ -n "$CLAWBOX_HOOK_STAMP" ] \
    && [ "$(cat "$CLAWBOX_HOOK_STAMP_FILE" 2>/dev/null || true)" = "$CLAWBOX_HOOK_STAMP" ]; then
    CLAWBOX_HOOK_NEEDS_VERIFY=0
  elif [ -n "$CLAWBOX_HOOK_STAMP" ]; then
    CLAWBOX_HOOK_ATTEMPT="$(head -n 1 "$CLAWBOX_HOOK_ATTEMPT_FILE" 2>/dev/null || true)"
    CLAWBOX_HOOK_ATTEMPT_REST="${CLAWBOX_HOOK_ATTEMPT#* }"
    CLAWBOX_HOOK_ATTEMPT_WHEN="${CLAWBOX_HOOK_ATTEMPT_REST%% *}"
    case "$CLAWBOX_HOOK_ATTEMPT_WHEN" in ''|*[!0-9]*) CLAWBOX_HOOK_ATTEMPT_WHEN=0 ;; esac
    # `10#` AND NOT JUST THE ALL-DIGITS GUARD ABOVE. To bash arithmetic a leading
    # zero means OCTAL, so `08` and `0899` are all digits and not valid octal:
    # `$(( ))` raises "value too great for base", which is a non-zero status on
    # an assignment under `set -euo pipefail` in an ExecStartPre with no leading
    # `-`. This file rewrites the attempt stamp on any boot the check does not
    # confirm, so a torn write during a power cut is enough — and the gateway
    # would then burn its start limit and sit failed for the hour, coming back to
    # the same file, over a DIAGNOSTIC. Every other branch here is written to
    # make that impossible; the guard only looked as though it did.
    CLAWBOX_HOOK_AGE=$(( $(date +%s 2>/dev/null || echo 0) - 10#$CLAWBOX_HOOK_ATTEMPT_WHEN ))
    # A negative age is a clock that moved (a box with no RTC): re-verify rather
    # than trust a stamp from the future.
    if [ "${CLAWBOX_HOOK_ATTEMPT%% *}" = "$CLAWBOX_HOOK_STAMP" ] \
      && [ "$CLAWBOX_HOOK_AGE" -ge 0 ] && [ "$CLAWBOX_HOOK_AGE" -lt "$CLAWBOX_HOOK_RETRY_AFTER" ]; then
      CLAWBOX_HOOK_NEEDS_VERIFY=0
      CLAWBOX_HOOK_BACKED_OFF=1
      CLAWBOX_HOOK_BACKOFF="${CLAWBOX_HOOK_ATTEMPT_REST#* }"
    fi
  fi
  # The FLAG and not the text: a recorded verdict that came back empty must
  # never fall through to "unchanged since it was last verified", which would
  # report a box that failed the check as a box that passed it.
  if [ "$CLAWBOX_HOOK_BACKED_OFF" = "1" ]; then
    echo "  WARNING: the last runtime check of the $CLAWBOX_HOOK_PLUGIN_ID plugin did not confirm its hook (${CLAWBOX_HOOK_BACKOFF:-no verdict recorded}) and nothing has changed since — not repeating the check this boot" >&2
  elif [ "$CLAWBOX_HOOK_NEEDS_VERIFY" = "0" ]; then
    echo "  EMAIL: directive hook plugin unchanged since it was last verified, skipping the runtime check"
  else
    # WHY THE EXIT STATUS IS KEPT AND STDERR IS READ. Discarding both made two
    # very different boxes print the same mild line: one where the CLI simply
    # could not be run (an UNKNOWN) and one where the CLI ran and did not know
    # this plugin — which is exactly what an undiscovered `extensions/` copy
    # looks like, and is a DEFECT. They are told apart below and they read
    # differently in the journal.
    #
    # The stderr goes to a temp file rather than `$OPENCLAW_HOME_DIR`, and the
    # file is PROVEN WRITABLE before it is used: a redirection that cannot be
    # opened fails the command before it ever runs, and a `refused exit 1` for a
    # CLI that was never invoked is a false failure — on a full disk, the very
    # box most likely to hit it. `/dev/null` is the honest fallback there: no
    # stderr excerpt, and the exit status still classifies correctly.
    CLAWBOX_HOOK_ERR_FILE="$(mktemp 2>/dev/null || true)"
    if [ -z "$CLAWBOX_HOOK_ERR_FILE" ] || ! : > "$CLAWBOX_HOOK_ERR_FILE" 2>/dev/null; then
      CLAWBOX_HOOK_ERR_FILE=/dev/null
    fi
    CLAWBOX_HOOK_RC=0
    # The `|| CLAWBOX_HOOK_RC=$?` is load-bearing: this script runs under
    # `set -e`, where a command substitution that exits non-zero aborts the
    # assignment — i.e. a missing or wedged `openclaw` would stop the gateway
    # from starting because a DIAGNOSTIC could not run.
    # `-k 5`, the same grace register-mcp.sh's two `hermes` calls carry (only
    # the grace — that script deliberately does not split 124/137 on elapsed
    # time, because it has no stamp to protect; the reason is written out at its
    # own classifier). Plain `timeout`
    # only sends SIGTERM, and an `openclaw` that ignores it — or any surviving
    # grandchild of it — keeps this command substitution's pipe open. Bash
    # blocks reading that pipe until EOF, so the assignment completes when the
    # SURVIVOR dies, not when `timeout` returns 124: measured 20 s of wall clock
    # against a 2 s ceiling. This block is an ExecStartPre with no leading `-`,
    # so that stall is the gateway's start time and then the unit's failure,
    # over a diagnostic this block itself calls advisory.
    # ONE constant, because the classifier below compares the elapsed time
    # against it: two copies of 45 that drift would mis-classify every timeout.
    # Deliberately not an environment knob — the Hermes twin's
    # HERMES_CLI_TIMEOUT has to be validated precisely because a user-writable
    # .env can reach it, and `timeout 0` means no timeout at all.
    CLAWBOX_HOOK_CEILING=45
    # What separates a kill worth backing off from one worth re-asking is COST,
    # which is the ground 126|127 go unstamped on: a failed `execve` answers in
    # microseconds. So the threshold is "was it as cheap as that", NOT "did our
    # ceiling fire" — an OOM kill at 40 s on a memory-tight Orin is expensive
    # whoever sent the signal, and leaving it unstamped puts those 40 s back on
    # EVERY gateway restart for ever, which is the regression this file's header
    # exists to prevent and the reason the attempt stamp was added at all.
    CLAWBOX_HOOK_CHEAP=5
    # MONOTONIC, not wall clock. `SECONDS` is `now - shell start`, so a clock
    # STEP inside the measured interval lands straight in the elapsed time — and
    # the Orin has no battery-backed RTC, so it boots with a stale clock and
    # timesyncd steps it in the same few seconds this ExecStartPre runs. A
    # forward step would stamp a 3-second kill as a 3602-second one; a backward
    # step would leave a real 45 s timeout unstamped. `/proc/uptime` is
    # CLOCK_BOOTTIME and immune to both, and `read` is a builtin, so this still
    # costs no fork.
    clawbox_hook_uptime() {
      local up rest
      read -r up rest < /proc/uptime 2>/dev/null || return 1
      up="${up%%.*}"
      case "$up" in ''|*[!0-9]*) return 1 ;; esac
      printf '%s' "$up"
    }
    CLAWBOX_HOOK_BEGAN="$(clawbox_hook_uptime || true)"
    CLAWBOX_HOOK_JSON="$(timeout -k 5 "$CLAWBOX_HOOK_CEILING" "$OPENCLAW_BIN" plugins inspect "$CLAWBOX_HOOK_PLUGIN_ID" --runtime --json 2>"$CLAWBOX_HOOK_ERR_FILE")" \
      || CLAWBOX_HOOK_RC=$?
    CLAWBOX_HOOK_ENDED="$(clawbox_hook_uptime || true)"
    if [ -n "$CLAWBOX_HOOK_BEGAN" ] && [ -n "$CLAWBOX_HOOK_ENDED" ]; then
      CLAWBOX_HOOK_ELAPSED=$(( CLAWBOX_HOOK_ENDED - CLAWBOX_HOOK_BEGAN ))
      CLAWBOX_HOOK_TOOK="after ${CLAWBOX_HOOK_ELAPSED}s"
    else
      # No readable /proc/uptime: we cannot say what it cost, so call it
      # EXPENSIVE and stamp — the same rule the stamp itself uses for a missing
      # sha256sum, which is to act rather than skip on a comparison that cannot
      # be made. Backing off wrongly costs one day of re-checking; not backing
      # off wrongly costs the ceiling on every restart for ever.
      CLAWBOX_HOOK_ELAPSED="$CLAWBOX_HOOK_CHEAP"
      CLAWBOX_HOOK_TOOK="after an unmeasured time"
    fi
    CLAWBOX_HOOK_ERR="$(tr '\n\r' '  ' < "$CLAWBOX_HOOK_ERR_FILE" 2>/dev/null | cut -c1-200 || true)"
    # Never `rm` the fallback.
    [ "$CLAWBOX_HOOK_ERR_FILE" = "/dev/null" ] || rm -f "$CLAWBOX_HOOK_ERR_FILE" 2>/dev/null || true
    case "$CLAWBOX_HOOK_RC" in
      # 127 not found, 126 not executable. The CLI never got to have an opinion
      # about this plugin — and it said so in MICROSECONDS, a failed `execve`.
      # There is nothing to save by not asking again, and these are the most
      # transient states on the box: `openclaw` absent or not yet executable
      # during the first boot after an update (this same script repairs npm
      # packages a few hundred lines above), a moved `$OPENCLAW_BIN`, a
      # mid-update restart. So this verdict is NOT stamped: backing a box off
      # for a day over it would print a daily warning about a plugin that is
      # almost certainly loaded and working, which is the false failure the
      # NOTE below exists to avoid.
      126|127)
        CLAWBOX_HOOK_VERDICT="cli-missing exit $CLAWBOX_HOOK_RC${CLAWBOX_HOOK_ERR:+: $CLAWBOX_HOOK_ERR}"
        ;;
      # 124 is `timeout` killing it at the ceiling; 137 is the SIGKILL `-k 5`
      # sends five seconds later when SIGTERM did not move it — `timeout`
      # signals its whole process group and SIGKILL cannot be ignored, so it
      # kills itself too and the caller reads 128+9.
      #
      # STAMPED ON THE COST, NOT ON THE EXIT CODE. Backing a box off for a day
      # is justified by what the run SPENT: a box that burned the ceiling will
      # usually burn it again on the next restart, and 126/127 go unstamped
      # because a failed `execve` costs microseconds. 137 arrives both ways —
      # our own SIGKILL at the ceiling, and the OOM killer on a loaded box with
      # no `timeout` involved — and so does 124, which a CLI can choose as its
      # own exit code. The exit code therefore says nothing about the cost, and
      # the elapsed time says everything: a kill that answered inside
      # CLAWBOX_HOOK_CHEAP seconds is as cheap to repeat as a 127, and anything
      # slower is stamped whoever sent the signal. Stamping a cheap kill buys a
      # day of warning noise AND a day in which a hook that genuinely stopped
      # registering goes unreported; NOT stamping an expensive one puts those
      # seconds back on every restart, for ever.
      124|137)
        if [ "$CLAWBOX_HOOK_ELAPSED" -ge "$CLAWBOX_HOOK_CHEAP" ]; then
          CLAWBOX_HOOK_VERDICT="cli-unavailable exit $CLAWBOX_HOOK_RC $CLAWBOX_HOOK_TOOK${CLAWBOX_HOOK_ERR:+: $CLAWBOX_HOOK_ERR}"
        else
          CLAWBOX_HOOK_VERDICT="cli-killed exit $CLAWBOX_HOOK_RC $CLAWBOX_HOOK_TOOK${CLAWBOX_HOOK_ERR:+: $CLAWBOX_HOOK_ERR}"
        fi
        ;;
      0)
        # The answer travels in the environment rather than down a pipe, because
        # the reader's own program arrives on stdin (`python3 -` plus a
        # heredoc), and a heredoc replaces the pipe rather than queueing behind
        # it.
        CLAWBOX_HOOK_VERDICT="$(CLAWBOX_HOOK_JSON="$CLAWBOX_HOOK_JSON" python3 - <<'PY'
import json, os

raw = os.environ.get("CLAWBOX_HOOK_JSON") or ""
if not raw.strip():
    # Exit 0 and nothing on stdout is a CLI that answered without answering.
    print("cli-unavailable exit 0 with no output")
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    print("unreadable the CLI printed something that is not JSON")
    raise SystemExit(0)
if not isinstance(data, dict):
    print("unreadable the CLI printed JSON that is not an object")
    raise SystemExit(0)
plugin = data.get("plugin") if isinstance(data.get("plugin"), dict) else {}
hooks = data.get("typedHooks") if isinstance(data.get("typedHooks"), list) else []
names = [h.get("name") for h in hooks if isinstance(h, dict)]
# BOTH hooks, by NAME and never by count: this plugin registers an outbound
# strip and an inbound approval claim, and a box that loaded only one of them is
# a box where either the EMAIL: line reaches a channel or the owner's "send
# <code>" is answered by the agent instead of the queue. A count would call that
# healthy the moment the numbers happened to line up.
missing = [want for want in ("reply_payload_sending", "before_dispatch") if want not in names]
if not missing:
    print("ok")
else:
    # The diagnostics are what tell an operator WHICH of the failures this is:
    # a manifest the core rejected, a module that threw, a plugin the config
    # never enabled.
    diagnostics = data.get("diagnostics") if isinstance(data.get("diagnostics"), list) else []
    detail = "; ".join(str(d)[:120] for d in diagnostics[:2])
    print("unregistered status={} missing={} hooks={} {}".format(
        plugin.get("status"), ",".join(missing), names or "none", detail).strip())
PY
        )" || CLAWBOX_HOOK_VERDICT="cli-unavailable the verdict reader could not run"
        ;;
      *)
        # The CLI RAN and refused. `plugins inspect` exits non-zero on an id it
        # cannot resolve, which is precisely what an untracked `extensions/`
        # copy the loader never discovered looks like from here.
        CLAWBOX_HOOK_VERDICT="refused exit $CLAWBOX_HOOK_RC${CLAWBOX_HOOK_ERR:+: $CLAWBOX_HOOK_ERR}"
        ;;
    esac
    case "$CLAWBOX_HOOK_VERDICT" in
      ok)
        echo "  ClawBox email hook plugin loaded (reply_payload_sending and before_dispatch registered)"
        printf '%s\n' "$CLAWBOX_HOOK_STAMP" > "$CLAWBOX_HOOK_STAMP_FILE" 2>/dev/null || true
        rm -f "$CLAWBOX_HOOK_ATTEMPT_FILE" 2>/dev/null || true
        ;;
      cli-missing*)
        # UNKNOWN, not a defect, and free to ask again next boot — so no stamp.
        echo "  NOTE: the openclaw CLI could not be run ($CLAWBOX_HOOK_VERDICT), so whether the $CLAWBOX_HOOK_PLUGIN_ID plugin registered its hook is unknown here — it is installed and enabled, and this will be re-checked on the next start" >&2
        ;;
      cli-killed*)
        # It answered inside the CHEAP window, so this script's `timeout` is NOT
        # what stopped it: a kill from outside (the OOM killer on a loaded box,
        # an operator, a restart) or the CLI's own exit code. UNKNOWN either
        # way, and it cost nothing — so no stamp, exactly like 126/127.
        echo "  NOTE: 'openclaw plugins inspect $CLAWBOX_HOOK_PLUGIN_ID --runtime' answered within ${CLAWBOX_HOOK_CHEAP}s ($CLAWBOX_HOOK_VERDICT) — a kill from outside or the CLI's own exit code, not this script's timeout, and cheap to repeat — so whether the plugin registered its hook is unknown here; it is installed and enabled, and this will be re-checked on the next start" >&2
        ;;
      cli-unavailable*)
        # UNKNOWN, not a defect: telling an operator "directives will still
        # reach channels" about a box where the hook is registered and working
        # is a false failure, and one they see every boot is one they stop
        # reading.
        echo "  NOTE: the openclaw CLI could not be run ($CLAWBOX_HOOK_VERDICT), so whether the $CLAWBOX_HOOK_PLUGIN_ID plugin registered its hook is unknown here — it is installed and enabled" >&2
        printf '%s %s %s\n' "$CLAWBOX_HOOK_STAMP" "$(date +%s 2>/dev/null || echo 0)" "$CLAWBOX_HOOK_VERDICT" \
          > "$CLAWBOX_HOOK_ATTEMPT_FILE" 2>/dev/null || true
        ;;
      refused*|unreadable*)
        # A DEFECT, and the shape an undiscovered plugin makes. Said plainly,
        # because the whole OpenClaw half of this feature does nothing here.
        echo "  WARNING: 'openclaw plugins inspect $CLAWBOX_HOOK_PLUGIN_ID --runtime' did not answer ($CLAWBOX_HOOK_VERDICT) — the plugin may not be discovered at all and EMAIL: directives may still reach channels" >&2
        printf '%s %s %s\n' "$CLAWBOX_HOOK_STAMP" "$(date +%s 2>/dev/null || echo 0)" "$CLAWBOX_HOOK_VERDICT" \
          > "$CLAWBOX_HOOK_ATTEMPT_FILE" 2>/dev/null || true
        ;;
      *)
        echo "  WARNING: the $CLAWBOX_HOOK_PLUGIN_ID plugin did not register both of its hooks — EMAIL: directives may still reach channels, and approving a queued email from Telegram will not work ($CLAWBOX_HOOK_VERDICT)" >&2
        printf '%s %s %s\n' "$CLAWBOX_HOOK_STAMP" "$(date +%s 2>/dev/null || echo 0)" "$CLAWBOX_HOOK_VERDICT" \
          > "$CLAWBOX_HOOK_ATTEMPT_FILE" 2>/dev/null || true
        ;;
    esac
  fi
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
# <workspace>/skills/) — and, on the box this top-up was written for, into
# queueing an operator-approval proposal for a gateway restart nothing here
# can render (TASK-612).
#
# OpenClaw 2 unbundled the DeepSeek provider into its own plugin
# (@openclaw/deepseek-provider) and refuses gateway readiness while a
# configured provider has no consented plugin behind it. ClawBox AI rides
# the deepseek provider on every paired box, and the configure route writes
# openclaw.json directly (it never runs onboarding), so nothing else
# installs the plugin — the first 2026.8.1 boot on a paired box parked at
# "Plugin \"deepseek\" requires capability consent" until it was installed
# by hand. Heal it here, exactly like the codex plugin above: idempotent
# (the marker file check), consent given explicitly, non-fatal — a failed
# install leaves the gateway refusing readiness with its own clear message.
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ ! -f "$OPENCLAW_HOME_DIR/extensions/deepseek/openclaw.plugin.json" ]; then
  # TOTAL, like the reader in the background-job block below and the two
  # assignments above: this is a BLOCKING ExecStartPre under `set -euo
  # pipefail`, so an unhandled shape here is not a bad answer, it is NO
  # GATEWAY. The `except` list catches what was foreseen — and a config whose
  # bytes are not UTF-8 raises `UnicodeDecodeError`, a `ValueError` that is NOT
  # a `json.JSONDecodeError`, so it escapes. The fallback is this site's own
  # documented default, the one its except-branch already prints.
  NEEDS_DEEPSEEK_PLUGIN="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except (OSError, json.JSONDecodeError):
    print("0"); sys.exit(0)
providers = ((cfg.get("models") or {}).get("providers") or {})
deepseek = providers.get("deepseek")
key = deepseek.get("apiKey") if isinstance(deepseek, dict) else None
print("1" if isinstance(key, str) and key.strip() else "0")
PY
)" || NEEDS_DEEPSEEK_PLUGIN=0
  if [ "$NEEDS_DEEPSEEK_PLUGIN" = "1" ]; then
    # Pinned to the INSTALLED core, like @openclaw/codex above. The plugin is
    # cut from the openclaw/openclaw tree with the core's own version number
    # and each release declares the plugin API it needs: the day 2026.8.2
    # shipped, the unpinned spec resolved to a build wanting ">=2026.8.2",
    # the pinned 2026.8.1 runtime refused it ("requires plugin API
    # >=2026.8.2, but this OpenClaw runtime exposes 2026.8.1"), and every
    # fresh install parked at a gateway that would not report ready. The
    # binary decides, not the pin file: it is the process that loads the
    # plugin, and the two disagree mid-update. The unpinned spec is only the
    # fallback for a core with no plugin build of its own version.
    DEEPSEEK_PLUGIN_SPEC="clawhub:@openclaw/deepseek-provider"
    DEEPSEEK_PLUGIN_PINNED=""
    if [ -n "$CLAWBOX_OPENCLAW_EFFECTIVE" ]; then
      DEEPSEEK_PLUGIN_PINNED="${DEEPSEEK_PLUGIN_SPEC}@${CLAWBOX_OPENCLAW_EFFECTIVE}"
    fi
    echo "  Installing @openclaw/deepseek-provider (OpenClaw 2 unbundled it; ClawBox AI needs it)..."
    if [ -n "$DEEPSEEK_PLUGIN_PINNED" ] \
      && timeout 180 "$OPENCLAW_BIN" plugins install "$DEEPSEEK_PLUGIN_PINNED" --accept-capabilities </dev/null; then
      echo "  DeepSeek provider plugin installed ($DEEPSEEK_PLUGIN_PINNED)"
      clawbox_plugin_repair_clear deepseek
    elif timeout 180 "$OPENCLAW_BIN" plugins install "$DEEPSEEK_PLUGIN_SPEC" --accept-capabilities </dev/null; then
      echo "  DeepSeek provider plugin installed ($DEEPSEEK_PLUGIN_SPEC)"
      clawbox_plugin_repair_clear deepseek
    else
      # STATED PRECISELY, because this one is not fully repairable from here.
      # The readiness refusal for DeepSeek comes from a CONFIGURED PROVIDER with
      # no plugin behind it, not from an enabled plugin entry — so switching an
      # entry off (there may not even be one) does not always clear it, and the
      # only thing that would is removing the provider, which would take ClawBox
      # AI off the box without the owner asking. The marker is what makes the
      # difference visible in Settings instead of leaving a boot loop nobody can
      # read.
      echo "  WARN: could not install @openclaw/deepseek-provider; recording it for repair in Settings"
      clawbox_plugin_boot_without deepseek install \
        "The DeepSeek provider plugin, which ClawBox AI runs on, could not be installed. The device may be offline, or the package registry unreachable." \
        "${DEEPSEEK_PLUGIN_PINNED:-$DEEPSEEK_PLUGIN_SPEC}"
    fi
  fi
fi
# Resolve the workspace from agents.defaults.workspace in openclaw.json,
# matching the same logic getSkillsDir() uses on the ClawBox API side —
# falls back to ~/.openclaw/workspace when unset, handles absolute vs
# tilde-relative vs bare-name values, and is safe when the file is
# missing (fresh factory-reset state).
# TOTAL, like the reader in the background-job block below and the two
# assignments above: this is a BLOCKING ExecStartPre under `set -euo
# pipefail`, so an unhandled shape here is not a bad answer, it is NO
# GATEWAY. The `except` list catches what was foreseen — and a config whose
# bytes are not UTF-8 raises `UnicodeDecodeError`, a `ValueError` that is NOT
# a `json.JSONDecodeError`, so it escapes. The fallback is this site's own
# documented default, the one its except-branch already prints.
CLAWBOX_WORKSPACE="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, sys
default = os.path.expanduser("~/.openclaw/workspace")
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
    ws = cfg.get("agents", {}).get("defaults", {}).get("workspace")
except (OSError, json.JSONDecodeError, KeyError):
    ws = None
if isinstance(ws, str) and ws.strip():
    ws = os.path.expanduser(ws.strip())
    print(ws if os.path.isabs(ws) else os.path.join(os.path.expanduser("~/.openclaw"), ws))
else:
    print(default)
PY
)" || CLAWBOX_WORKSPACE="$HOME/.openclaw/workspace"
# --- clawbox bootstrap seed ---
# ClawBox's own first-conversation ritual.
#
# OpenClaw arms an introduction ("birth sequence") the first time the agent
# replies in a brand-new workspace: it writes BOOTSTRAP.md, the agent works
# through it and deletes the file, and the workspace is stamped complete so it
# never runs again. The template it would use lives inside the npm package and
# asks what to call the ASSISTANT — it never asks the owner's name. With the
# "Your name" field gone from Settings, that first conversation is the only
# thing on the device that asks, so the script has to be ours. A BOOTSTRAP.md
# that is already on disk is adopted verbatim (upstream seeds it with a
# write-if-missing), so pre-writing ours here is the supported way to ship one
# and it survives a reinstall of the openclaw package, which patching the
# package's own templates would not.
#
# GENUINELY FRESH ONLY. The test is not "there is no BOOTSTRAP.md": on a box
# that has already been introduced, BOOTSTRAP.md is absent precisely BECAUSE
# the ritual finished, and seeding on that test alone would re-run the
# introduction on every ordinary reboot. So every file the first turn would
# have created, and every trace of a working agent, has to be absent too.
#
# This is also the one write in this section that must reach a workspace that
# does not exist yet: factory reset empties ~/.openclaw wholesale, and without
# the directory the gateway would create it on the first turn and seed the
# stock ritual before we ever got a say. An empty workspace directory is not
# itself evidence of a configured agent, so creating it changes nothing else.
CLAWBOX_BOOTSTRAP_SRC="$CLAWBOX_ROOT/config/clawbox-bootstrap.md"
CLAWBOX_BOOTSTRAP_DST="$CLAWBOX_WORKSPACE/BOOTSTRAP.md"
if [ -r "$CLAWBOX_BOOTSTRAP_SRC" ] \
  && [ ! -e "$CLAWBOX_BOOTSTRAP_DST" ] \
  && [ ! -e "$CLAWBOX_WORKSPACE/USER.md" ] \
  && [ ! -e "$CLAWBOX_WORKSPACE/IDENTITY.md" ] \
  && [ ! -e "$CLAWBOX_WORKSPACE/SOUL.md" ] \
  && [ ! -e "$CLAWBOX_WORKSPACE/AGENTS.md" ] \
  && [ ! -e "$CLAWBOX_WORKSPACE/MEMORY.md" ] \
  && [ ! -d "$CLAWBOX_WORKSPACE/memory" ]; then
  # Guarded like every other write here: config/clawbox-gateway.service runs
  # this script as a bare ExecStartPre under `set -euo pipefail`, so a failure
  # is the unit's failure and the box loses its assistant over a text file.
  if mkdir -p "$CLAWBOX_WORKSPACE" 2>/dev/null \
    && install -m 644 "$CLAWBOX_BOOTSTRAP_SRC" "$CLAWBOX_BOOTSTRAP_DST"; then
    echo "  Seeded ClawBox's BOOTSTRAP.md into a fresh OpenClaw workspace"
  else
    # The same partial-write hole the CLAWBOX.md seed below closes, in the same
    # verb, and its consequence is worse. `install` that stops part way — ENOSPC
    # on a full eMMC, the first-boot and post-factory-reset path — leaves a
    # fragment, and the guard above is `[ ! -e ]`, which a fragment satisfies
    # FOREVER. The script's own rule is that a BOOTSTRAP.md already on disk is
    # adopted verbatim, so OpenClaw would run the birth sequence against a ritual
    # cut off mid-sentence, delete the file when it thinks it is done, and stamp
    # the workspace complete: the owner is never asked their name, permanently,
    # with no second chance. The enclosing `[ ! -e "$CLAWBOX_BOOTSTRAP_DST" ]`
    # proves the file did not exist before this attempt, so removing it destroys
    # nothing and the next boot re-seeds from scratch.
    rm -f "$CLAWBOX_BOOTSTRAP_DST" 2>/dev/null || true
    # Not fatal, and not silent: OpenClaw still runs its own introduction, it
    # just will not ask the owner their name.
    echo "  WARNING: could not seed BOOTSTRAP.md; OpenClaw will use its own ritual" >&2
  fi
fi
# --- end clawbox bootstrap seed ---

# Make sure the workspace skills root exists before the gateway starts.
# OpenClaw's skills watcher (skills.load.watch, on by default) hands each
# configured root to chokidar once, when a turn first builds the skills
# snapshot; a root that does not exist at that moment is simply never watched,
# and it is not re-attached later because the watch target list has not
# changed. Creating the directory up front means the very first skill a
# customer installs lands in an already-watched root, so the running gateway
# notices it without being restarted.
if [ -d "$CLAWBOX_WORKSPACE" ]; then
  mkdir -p "$CLAWBOX_WORKSPACE/skills" 2>/dev/null || true
fi

CLAWBOX_GUIDE_SRC="$CLAWBOX_ROOT/config/clawbox-workspace-guide.md"
CLAWBOX_GUIDE_DST="$CLAWBOX_WORKSPACE/CLAWBOX.md"
# Topping an existing CLAWBOX.md up, section by section.
#
# Seeding is deliberately seed-if-MISSING, so an owner's or the agent's edits
# survive a gateway start — and the cost of that was measured on the OpenClaw
# dev box (2026-09-03, TASK-706): its CLAWBOX.md is dated Aug 13 and carries
# five headings, so it has NEVER received "## Coding agent (delegate a whole
# task)", which is how the agent learns that coding_agent_run /
# coding_agent_status / coding_agent_stop exist and what to say when they are
# not offered. Every box set up before that section landed is in the same state,
# silently, and TASK-612's rule reached the field only because someone added a
# marker for it BY HAND.
#
# One marker per section does not scale, so there is no marker list any more:
# every `## ` heading in the shipped template that the box's file does not carry
# is appended, in template order. The heading IS the marker, which is why every
# comparison below is a WHOLE-LINE one (modulo a CR) rather than a substring —
# a guide that says "## Skills and other things" must not satisfy "## Skills".
#
# The trade this takes, deliberately and per the card: an owner who DELETED a
# section gets it back on the next gateway start. The alternative is what the
# box has today — sections that never arrive at all, with nothing that says so.
# Whole-line matching cuts the same way in both directions, and both are the
# trade: `## Skills and other things` no longer satisfies `## Skills` (the old
# substring match said it did, and would have withheld that section forever),
# and a heading the agent DEMOTED to `### Skills` no longer satisfies it either,
# so such a box gets one copy of the section back — once, because the appended
# copy is found on the next boot.
#
# Values reach awk through the environment rather than `-v`, which runs them
# through escape processing: a heading that ever grew a backslash would quietly
# stop matching and the section would go missing with no warning.

# ONE fence rule, shared by the three helpers below.
#
# Prepended to each awk program, so `text[i]` is every line with trailing
# whitespace and a CR trimmed and `clawbox_fences()` marks in `hidden[i]` the
# lines a fence encloses, and sets `unbalanced` when one never closed. Trailing
# whitespace is trimmed in one place for all three: a heading that differs from
# the template's only by a trailing space would otherwise be judged absent by
# one helper and found by another, and the section appended a second time,
# permanently.
#
# Fenced `## ` lines do not count. This template is markdown that documents
# markdown and shell, and the destinations are the owner's and the agent's to
# edit: a ``` block quoting a heading would otherwise be enumerated as a phantom
# section on the source side, and read as the section already being present on
# the destination side.
#
# A delimiter is a ``` or ~~~ line indented by AT MOST THREE spaces, which is
# how CommonMark defines one — an opener and a closer alike. Matching only at
# column 0 is not a stricter rule, it is a WRONG one: an indented closing fence
# then goes unseen, the next opener is paired with the previous opener, and the
# prose between two examples is marked as fenced. Measured on a COPY of this
# template carrying two two-space-indented closers — which render correctly on
# GitHub and are invisible in review — `## Browser (real Chromium on the
# device)` and `## Apps and UI` were enumerated by nothing and delivered to no
# box, exit 0, not one word on stderr. (A copy: the shipped file has exactly one
# fenced block and it is in the LAST section, so its own closers cannot reach
# those two headings. The shape is what matters, and the day an example lands
# above them it would.) The interval form `{0,3}` is not available: mawk 1.3.4
# does not merely reject it, it aborts with `REcompile() - panic`.
#
# A delimiter also closes only a fence opened with the SAME character, and only
# with a run at least as long — CommonMark again, and the same mis-pairing as
# above one delimiter character over. These files document markdown, so a ```
# block quoting a ~~~ example is an ordinary edit; with both characters in one
# list the ``` opener pairs with the quoted ~~~, the lines between the two
# quoted delimiters fall outside every pair, and a heading the template only
# QUOTES is appended to every box as a section of its own. The run-length half
# is what lets a ```` block quote a ``` one, which is how this template shows
# markdown inside markdown.
#
# CommonMark's THIRD closer rule — that a closer carries no info string, so
# "```md" cannot close "```text" — is applied to the TEMPLATE and not to the
# destinations, and that asymmetry is the point rather than an oversight. It
# changes which delimiter becomes the closer, so it moves the answer in BOTH
# directions depending on the file, and the two files want opposite things:
#
#   The template is OURS — shipped, reviewed, and pinned by a unit test that
#   compares this enumerator against a fence-blind list of every `## ` line. It
#   should be parsed by the book, and anything the book cannot parse cleanly
#   should be REFUSED out loud. Without the rule it is not: a `` ```text ``
#   example closed by a `` ```md `` line (a copy-paste slip that renders
#   correctly on GitHub) pairs opener-with-content, the pairing still comes out
#   even, and `## Real Heading` below it is enumerated by nothing. Measured on
#   exactly that shape: `Appended to CLAWBOX.md: First`, exit 0, not one word on
#   stderr, and the section never reaches a box. That is this card's own defect.
#
#   A destination is the OWNER's and the agent's, edited by hand and by a model,
#   and there the unaffordable outcome is not a wrong parse but an UNBOUNDED
#   one: a heading wrongly hidden is judged missing and re-appended on every
#   boot. Measured with the rule applied there too: a CLAWBOX.md carrying one
#   stray ``` grew 8793 -> 11731 bytes over two boots, because the rule stopped
#   the appended section's own `` ```text `` from closing the stray and let a
#   later bare ``` close it instead — swallowing everything appended in between.
#   Lenient, the same file is unbalanced, read as prose, and stable from boot 1.
#
# So: strict on the file we control, lenient on the files we do not.
#
# And a fence hides only what it CLOSES, which is the whole reason these read
# the file twice instead of toggling as they go. An opener with no closer is
# ordinary damage in a file the owner and the agent both edit, and a naive
# toggle makes it catastrophic in BOTH directions: on the destination every
# heading after the stray delimiter is "missing", the copy this block appends
# lands in the fenced region too, and the file grows by those sections on EVERY
# boot; on the template the headings simply stop being enumerated. Such a file
# is therefore read as prose — nothing is hidden at all, which is what this
# script did before fences were considered — and the two blocks below SAY SO
# rather than leaving it silent, because "read as prose" on the destination
# means a heading quoted inside a fence counts as present and its section is
# withheld.
CLAWBOX_FENCE_AWK='
  function clawbox_fences(   i, j, k, open, pairs, from, to) {
    open = 0; pairs = 0
    for (i = 1; i <= fences; i++) {
      if (!open) { open = i; continue }
      if (fchar[i] != fchar[open] || flen[i] < flen[open]) continue
      if (strict && finfo[i]) continue
      pairs++; from[pairs] = fence[open]; to[pairs] = fence[i]; open = 0
    }
    unbalanced = (open != 0)
    if (unbalanced) return
    for (k = 1; k <= pairs; k++)
      for (j = from[k]; j <= to[k]; j++) hidden[j] = 1
  }
  {
    line = $0; sub(/[ \t\r]+$/, "", line); text[NR] = line
    if (line ~ /^ *(```|~~~)/ && match(line, /^ */) && RLENGTH < 4) {
      mark = substr(line, RLENGTH + 1)
      char = substr(mark, 1, 1)
      run = 1
      while (substr(mark, run + 1, 1) == char) run++
      fences++
      fence[fences] = NR; fchar[fences] = char; flen[fences] = run
      # An info string ("```text"), which an opener may carry and a closer may
      # not. `mark` has already had its trailing whitespace trimmed, so anything
      # past the delimiter run is real text.
      finfo[fences] = (length(mark) > run)
    }
  }
'

# Do this file'"'"'s fences balance? 0 yes, 1 no, 2 could not be read.
#
# Asked once per file rather than folded into the helpers, because the answer is
# a fact about the FILE and the helpers are called once per heading. `$2`
# non-empty asks the STRICT reading, and every caller passes what the helpers
# that go on to read the same file use — the answer must come from the same
# pairing those helpers apply, not a second rule that could drift from it.
clawbox_fences_balanced() {
  [ -r "$1" ] || return 2
  awk -v strict="${2-}" "$CLAWBOX_FENCE_AWK"'
    END { clawbox_fences(); exit(unbalanced ? 1 : 0) }
  ' "$1"
}

# Every `## ` heading in a markdown file, in order. Template-side, so strict.
clawbox_guide_headings() {
  awk -v strict=1 "$CLAWBOX_FENCE_AWK"'
    END {
      clawbox_fences()
      for (i = 1; i <= NR; i++)
        if (!hidden[i] && text[i] ~ /^## +[^ ]/) print text[i]
    }
  ' "$1"
}

# Does this file already carry that heading, as a whole line?
#
# One helper for BOTH destinations — CLAWBOX.md's sections and AGENTS.md's two
# markers — so the two files cannot come to disagree about what "already there"
# means. No `strict`, deliberately: these are the owner's and the agent's files,
# where the lenient closer is the reading that leans toward "unbalanced, so read
# it as prose and hide nothing", and hiding nothing is the only answer that
# cannot make a section be re-appended on every boot. See the rule above. The AGENTS.md blocks used `grep -qF`, a SUBSTRING match, which read
# `### ClawBox integration notes` as the marker and withheld the pointer for
# good; whole-line is the correction. And whole-line is exactly what a bare
# `grep -qxF` cannot do here, because a CRLF file stores the marker as
# `## X\r`: an exact match misses it, the block appends on EVERY boot and the
# file grows without bound — so the CR is normalised on both sides, in one
# place, for both files.
#
# Three answers, not two: 0 present, 1 absent, 2 could not be read. `awk` returns
# 2 for a file it cannot open, and reading that as "absent" is how an unreadable
# destination gets appended to — the defect the readability guard above exists to
# stop, through a door that guard cannot cover once the loop is running.
#
clawbox_file_has_heading() {
  [ -r "$1" ] || return 2
  heading="$2" awk "$CLAWBOX_FENCE_AWK"'
    END {
      clawbox_fences()
      for (i = 1; i <= NR; i++)
        if (!hidden[i] && text[i] == ENVIRON["heading"]) exit 0
      exit 1
    }
  ' "$1"
}

# One section of the template: its heading line and everything up to the NEXT
# `## ` heading.
#
# Bounded by the next heading rather than by the `---` rule that happens to sit
# before it: a rule inside the section would have truncated it, and a CRLF
# template (`---\r`) would have matched no terminator at all and dragged every
# following section along. Trailing blank lines and that closing rule are then
# dropped, because the append supplies its own separator and carrying the
# template's too ends the topped-up guide on a dangling rule.
clawbox_guide_section() {
  heading="$2" awk -v strict=1 "$CLAWBOX_FENCE_AWK"'
    # The only helper that reproduces lines rather than matching them, so it is
    # the only one that keeps a second copy of the file in memory. The shared
    # prologue builds `text[]`, which is trimmed; a section must be appended to
    # the box exactly as it is shipped.
    { raw[NR] = $0 }
    END {
      clawbox_fences()
      for (i = 1; i <= NR && !start; i++)
        if (!hidden[i] && text[i] == ENVIRON["heading"]) start = i
      if (!start) exit 0
      last = NR
      for (i = start + 1; i <= NR && last == NR; i++)
        if (!hidden[i] && text[i] ~ /^## /) last = i - 1
      while (last > start && (text[last] == "" || text[last] == "---")) last--
      for (i = start; i <= last; i++) print raw[i]
    }
  ' "$1"
}

# Append to a file so that a write which stops PART WAY leaves nothing behind.
#
# Every append below writes its HEADING first, and that heading is also the
# marker the next boot greps for to decide whether the append already happened.
# A write that stops half-way — ENOSPC on a full Jetson eMMC is the realistic
# shape — therefore leaves the marker sitting on a fragment: every later gateway
# start finds the heading, appends nothing, and the file stays cut mid-sentence
# FOREVER, while the only warning is a journal line from a boot nobody is
# watching. What is lost is the tail of the section, which is where TASK-612's
# deliverable ("never queue an operator_approval proposal") lives.
#
# Rolling the file back to the length it had removes the fragment AND the
# marker, so the next boot retries. Rollback rather than build-a-copy-and-
# rename: these are owner-personalised files with their own mode and owner, and
# the case this exists for is a FULL disk, where a second full copy is the least
# affordable thing to ask for.
#
# NAMED FOR WHAT IT IS, not "atomic", because it is not: it undoes a write that
# FAILED, and nothing it can do covers a shell that DIES between the partial
# write and the rollback — a SIGTERM from `systemctl restart` landing in
# ExecStartPre, an OOM kill, a power cut on the very box whose disk is full.
# That residual window is the price of not writing a second copy of the file,
# and it is a much smaller target than the whole build: temp-file + rename is
# the option that closes it, at the cost of a full copy at peak on the one
# occasion there is no room for one.
#
# The destination must already exist, and that is the CONTRACT rather than a
# case to handle: the seed branch runs only when it does not, and the two
# AGENTS.md blocks test `-f` first. An "it was absent, so remove it" branch was
# tried and removed — it is unreachable from every caller, and the one line in
# it that could run is the only line here able to delete a file the helper did
# not create (`[ -e ]` is false for a DANGLING SYMLINK, `printf >>` follows the
# link and creates its target, and the removal would then take the link and
# orphan the fragment: the opposite of a rollback).
#
# Single-writer, and that is a precondition, not a coincidence: `truncate -s`
# restores a length measured before the write, so anything a second writer
# appended in that window is discarded. Safe here because this runs in
# `ExecStartPre` with the gateway — and therefore the agent and its file tools —
# stopped. A caller that runs while the agent is live must not use it.
# The size of a file in bytes, or "" when it cannot be read.
#
# Two syscall paths, because the number decides whether a rollback happens at
# all: `wc -c` opens and reads, `stat` does not, so a file that is present but
# unopenable (mode 0222) still answers. Note the redirection ORDER — bash
# applies them left to right, so `< "$f" 2>/dev/null` opens BEFORE stderr is
# silenced and a "Permission denied" line reaches the gateway journal on a boot
# where nothing went wrong.
clawbox_file_size() {
  local size=""
  [ -e "$1" ] || return 0
  size="$(wc -c 2>/dev/null < "$1" || true)"
  size="${size//[![:digit:]]/}"
  [ -n "$size" ] || size="$(stat -c %s "$1" 2>/dev/null || true)"
  size="${size//[![:digit:]]/}"
  printf '%s' "$size"
}

clawbox_append_or_rollback() {
  local dest="$1" payload="$2" before="" after=""
  # A no-op append that reports success is the failure mode this whole block
  # goes to lengths to avoid elsewhere ("appending a separator alone would
  # report a success that added nothing, and would do it again on every gateway
  # start"). Refuse it here so no future caller has to remember.
  if [ -z "$payload" ]; then
    echo "  WARNING: refusing to append an empty payload to $dest" >&2
    return 1
  fi
  # Measured BEFORE the write, and a length that could not be read is a length
  # this must never truncate to: with no number the only safe outcome is to
  # leave the file as the failed write left it and say what to do about it.
  before="$(clawbox_file_size "$dest")"
  if printf '%s' "$payload" >> "$dest"; then
    return 0
  fi
  if [ -z "$before" ]; then
    echo "  WARNING: could not measure $dest before a failed append. Check it for a truncated '${payload%%$'\n'*}' section; deleting the file lets the next gateway start rebuild it." >&2
    return 1
  fi
  # A write that failed at OPEN — EACCES on a 0444 file, EROFS on a rootfs
  # remounted read-only — wrote nothing at all, and truncating then fails for
  # the same reason. Warning about a file that is byte-identical to what it was
  # sends an operator triaging a real disk fault to inspect a guide that is
  # fine, on every boot. Ask the file before saying anything about it.
  after="$(clawbox_file_size "$dest")"
  if [ -n "$after" ] && [ "$after" = "$before" ]; then
    return 1
  fi
  # `truncate` is coreutils, which is essential on both rootfs images; python3
  # is the fallback, and it is python rather than `dd` deliberately —
  # `dd of=… seek=N count=0` truncates at the seek offset on GNU coreutils but
  # is not guaranteed to elsewhere, and the one implementation that gets it
  # wrong empties the file this function exists to preserve. `os.truncate` says
  # exactly what is meant, and this script already depends on python3 throughout.
  if ! truncate -s "$before" "$dest" 2>/dev/null \
    && ! python3 -c 'import os,sys; os.truncate(sys.argv[1], int(sys.argv[2]))' "$dest" "$before" 2>/dev/null; then
    echo "  WARNING: could not roll $dest back after a failed append; it may be cut mid-section" >&2
  fi
  return 1
}
# EVERY write in this block — the appends through the helper above included —
# is guarded, and that is a boot requirement rather than a matter of taste:
# config/clawbox-gateway.service runs this script as an
# `ExecStartPre=` with no leading `-`, so under `set -euo pipefail` a failing
# write here is the unit's failure. With Restart=always and RestartSec=5 the
# gateway would burn StartLimitBurst=20 in about a hundred seconds and then sit
# failed for the rest of the StartLimitIntervalSec=3600 window — the box loses
# its assistant over an advisory text file. So each write warns and boots on.
if [ -d "$CLAWBOX_WORKSPACE" ]; then
  # Seed-if-missing rather than overwrite-on-diff. The agent and the
  # user may personalize CLAWBOX.md (add device-specific notes, remove
  # sections that don't apply). Overwriting on every gateway start
  # would clobber those edits. If the shipped template changes and an
  # operator wants to pull it in, they can delete the file; the next
  # gateway start will re-seed.
  #
  # The template is tested with `-r`, HERE rather than in the condition above.
  # It is only ever read, so `-r` covers both the missing file the old enclosing
  # `-f` tested for and the existing-but-unreadable one `-f` waved through into a
  # write that then fails. Testing it inside this chain is what keeps the promise
  # the next block relies on: the AGENTS.md rule needs no template at all, and it
  # is the copy the harness actually injects, so it must still land when the
  # template is missing or unreadable — which the enclosing `-f` silently
  # prevented, with no warning at all.
  if [ ! -r "$CLAWBOX_GUIDE_SRC" ]; then
    echo "  WARNING: could not read $CLAWBOX_GUIDE_SRC; leaving CLAWBOX.md as it is" >&2
  elif [ -e "$CLAWBOX_GUIDE_DST" ] && [ ! -f "$CLAWBOX_GUIDE_DST" ]; then
    # `-f` alone says "seed it" about a DIRECTORY, and `install SRC DIR` copies
    # INTO it: two boots, two "Seeded CLAWBOX.md" success lines, a
    # CLAWBOX.md/clawbox-workspace-guide.md nobody reads, and no guide on the
    # box ever — a success printed on every boot, forever. A socket and a FIFO
    # are the same shape (verified: the FIFO does not hang here either).
    # NOT a dangling symlink: `-e` follows the link and is false, so that case
    # goes to the seed below, where `install` replaces the link with the guide —
    # which is the right outcome and is why this is `-e` rather than `-h`.
    # Nothing here can fix a directory, so it says so instead of reporting work
    # it did not do.
    echo "  WARNING: $CLAWBOX_GUIDE_DST exists and is not a regular file; leaving it as it is" >&2
  elif [ ! -f "$CLAWBOX_GUIDE_DST" ]; then
    if install -m 644 "$CLAWBOX_GUIDE_SRC" "$CLAWBOX_GUIDE_DST"; then
      echo "  Seeded CLAWBOX.md in OpenClaw workspace"
    else
      # The seed has the same partial-write problem as the appends, and it is
      # WORSE: the fragment it leaves already contains the headings that ARE the
      # top-up markers, so the loop below finds them on every later boot, appends
      # nothing, and the box keeps a guide cut mid-sentence for good. The enclosing
      # `elif [ ! -f "$CLAWBOX_GUIDE_DST" ]` proves the file did not exist before
      # this attempt, so removing it destroys nothing and the next boot re-seeds
      # from scratch.
      rm -f "$CLAWBOX_GUIDE_DST" 2>/dev/null || true
      # The first-boot and post-factory-reset path, and the one write in this
      # block that used to be bare: a full rootfs, a filesystem remounted
      # read-only after errors, or the documented "delete CLAWBOX.md to
      # re-seed" step on such a box all land here.
      echo "  WARNING: could not seed CLAWBOX.md in the OpenClaw workspace" >&2
    fi
  elif [ ! -r "$CLAWBOX_GUIDE_DST" ]; then
    # `awk` answers exit 2 on a file it cannot read, which reads as
    # "the heading is not there" — so a 0200 CLAWBOX.md was appended to on EVERY
    # boot, growing without bound, while the file itself could never be checked.
    # A file this block cannot read is a file it must not top up.
    echo "  WARNING: could not read $CLAWBOX_GUIDE_DST; leaving it as it is" >&2
  else
    CLAWBOX_GUIDE_ADDED=""
    CLAWBOX_GUIDE_HEADINGS=""
    # A file whose fences do not balance is read as prose (see the fence rule
    # above), and on each side that costs something different, so each side says
    # so in its own words.
    #
    # The TEMPLATE is ours and a template we cannot parse must not be merged
    # from: every `## ` line quoted inside its examples would be enumerated as a
    # section, extracted from inside the fence to the next such line — so the
    # real section above it is truncated AND a phantom one is appended, to every
    # box, permanently. Refusing is the same call the "no headings at all" arm
    # below already makes about the same kind of half-deployed file.
    CLAWBOX_GUIDE_FENCES=0
    clawbox_fences_balanced "$CLAWBOX_GUIDE_SRC" strict || CLAWBOX_GUIDE_FENCES=$?
    # The DESTINATION is the owner's and the agent's, so it is not refused —
    # only reported. Reading its fences as prose means a heading quoted inside
    # one counts as present and that section is withheld, which is this card's
    # own defect; there is no second guard that would catch it, so the operator
    # gets the sentence instead of silence.
    CLAWBOX_DST_FENCES=0
    clawbox_fences_balanced "$CLAWBOX_GUIDE_DST" || CLAWBOX_DST_FENCES=$?
    if [ "$CLAWBOX_DST_FENCES" = 1 ]; then
      echo "  WARNING: the \`\`\` fences in $CLAWBOX_GUIDE_DST do not balance; a heading quoted inside one will be read as present and its section withheld. Close the fence, or delete the file and the next gateway start re-seeds it" >&2
    fi
    if [ "$CLAWBOX_GUIDE_FENCES" = 1 ]; then
      echo "  WARNING: the \`\`\` fences in $CLAWBOX_GUIDE_SRC do not balance; CLAWBOX.md not topped up (a quoted heading would be appended as a section)" >&2
    elif ! CLAWBOX_GUIDE_HEADINGS="$(clawbox_guide_headings "$CLAWBOX_GUIDE_SRC")"; then
      # An I/O fault on the template, not a renamed heading: the two send an
      # operator to different files, so they are reported apart.
      echo "  WARNING: could not read $CLAWBOX_GUIDE_SRC to top up CLAWBOX.md" >&2
    elif [ -z "$CLAWBOX_GUIDE_HEADINGS" ]; then
      # A readable template with no `## ` headings at all — a truncated or
      # zero-byte file from a half-finished deploy. Silence here would be
      # indistinguishable from "the guide is already complete", which is exactly
      # the shape of the defect this card exists to fix: sections that never
      # arrive, with nothing that says so. This replaces the old code's "the
      # shipped guide no longer carries '<marker>'" warning, which fired on the
      # same input.
      echo "  WARNING: $CLAWBOX_GUIDE_SRC carries no '## ' headings; CLAWBOX.md not topped up" >&2
    else
      while IFS= read -r CLAWBOX_GUIDE_HEADING; do
        [ -n "$CLAWBOX_GUIDE_HEADING" ] || continue
        # `|| var=$?` and not a bare call: a non-zero status from a simple
        # command is the whole shell's failure under `set -e`, and "the heading
        # is absent" is the COMMON answer here, not an error.
        CLAWBOX_GUIDE_SEEN=0
        clawbox_file_has_heading "$CLAWBOX_GUIDE_DST" "$CLAWBOX_GUIDE_HEADING" \
          || CLAWBOX_GUIDE_SEEN=$?
        case "$CLAWBOX_GUIDE_SEEN" in
          0) continue ;;
          1) ;;
          *)
            # The destination stopped being readable mid-loop: EIO on a failing
            # eMMC, the path replaced by a directory, a symlink that went
            # dangling. Judging every remaining section "missing" from that is
            # the same false success the readability guard above prevents.
            echo "  WARNING: could not read $CLAWBOX_GUIDE_DST while topping it up; stopping" >&2
            break
            ;;
        esac
        CLAWBOX_GUIDE_SECTION=""
        if ! CLAWBOX_GUIDE_SECTION="$(clawbox_guide_section "$CLAWBOX_GUIDE_SRC" "$CLAWBOX_GUIDE_HEADING")"; then
          echo "  WARNING: could not read $CLAWBOX_GUIDE_SRC to top up CLAWBOX.md" >&2
          break
        fi
        if [ -z "$CLAWBOX_GUIDE_SECTION" ]; then
          # The heading came out of this same template a moment ago, so an empty
          # extraction is a bug in the extractor, not a renamed section.
          # Appending a separator alone would report a success that added
          # nothing, and would do it again on every gateway start.
          echo "  WARNING: '$CLAWBOX_GUIDE_HEADING' extracted empty from $CLAWBOX_GUIDE_SRC" >&2
          continue
        fi
        # A file that does not end in a newline would otherwise have its last
        # line joined to the separator, making it a setext heading. Re-tested per
        # section, because the previous append in this loop changed the answer.
        CLAWBOX_GUIDE_LEAD=""
        if [ -s "$CLAWBOX_GUIDE_DST" ] && [ "$(tail -c1 "$CLAWBOX_GUIDE_DST")" != "" ]; then
          CLAWBOX_GUIDE_LEAD=$'\n'
        fi
        # Rendered whole first, then handed to the one writer that can undo a
        # partial write. `printf -v` and not a command substitution: `$( )` strips
        # trailing newlines, and the section's final newline is what keeps the
        # next append off the last line of this one.
        #
        # Undoing a partial write matters MORE here than it did for one section:
        # a boot can now append up to seven of them, so a full disk is that many
        # more chances to leave a heading sitting on a fragment.
        printf -v CLAWBOX_GUIDE_APPEND '%s\n---\n\n%s\n' "$CLAWBOX_GUIDE_LEAD" "$CLAWBOX_GUIDE_SECTION"
        if clawbox_append_or_rollback "$CLAWBOX_GUIDE_DST" "$CLAWBOX_GUIDE_APPEND"; then
          CLAWBOX_GUIDE_ADDED="$CLAWBOX_GUIDE_ADDED${CLAWBOX_GUIDE_ADDED:+, }${CLAWBOX_GUIDE_HEADING#\#\# }"
        else
          # The cause is on this shell's stderr already — the helper's failing
          # redirection prints it — so this line names the deliverable, not the
          # errno. The loop carries on: one section that will not fit is no
          # reason to withhold the rest.
          echo "  WARNING: could not append '$CLAWBOX_GUIDE_HEADING' to CLAWBOX.md" >&2
        fi
      done <<< "$CLAWBOX_GUIDE_HEADINGS"
      if [ -n "$CLAWBOX_GUIDE_ADDED" ]; then
        echo "  Appended to CLAWBOX.md: $CLAWBOX_GUIDE_ADDED"
      fi
    fi
  fi

  # Append a one-liner reference to AGENTS.md if it exists and doesn't
  # already mention CLAWBOX.md, so the agent loads our guide as part of
  # its session-start context without us having to overwrite AGENTS.md
  # (which the agent may have personalized).
  CLAWBOX_AGENTS_MD="$CLAWBOX_WORKSPACE/AGENTS.md"
  # Guarded on the pointer's OWN heading, not on the bare "CLAWBOX.md" literal.
  # The rule block below ends "`CLAWBOX.md` has the long form", so a literal
  # guard is satisfied by the rule's own text: the two blocks both landed only
  # because this one happens to be written first. That ordering was
  # load-bearing and stated nowhere — a reorder, or moving the rule into a
  # helper that ran earlier, would have cost every fresh box its pointer with
  # both markers "satisfied" and no warning. Nothing else writes this heading,
  # and every box in the field already carries it verbatim (it has not changed
  # since it was introduced), so no box receives a second copy.
  CLAWBOX_AGENTS_POINTER="## ClawBox integration"
  # One readability test for both blocks, and one `case` over the helper's THREE
  # answers.
  #
  # `! clawbox_file_has_heading …` would collapse them to two, and reading
  # "could not be read" as "the marker is absent" is how this file grew by ~1 KB
  # on every single boot, each one printed as a success — mode 0200 denies the
  # read while PERMITTING the write. `-r` closes that measured door; the `case`
  # closes the rest of them (an EIO on a failing eMMC, `awk` missing from a
  # stripped rootfs, the file losing readability after the test), the way the
  # CLAWBOX.md loop above already does. AGENTS.md is the file the harness
  # injects into every session, under a bootstrap character budget.
  #
  # One warning per fault, not one per marker: both calls below ask about the
  # SAME file for the same reason, so an unreadable AGENTS.md would otherwise
  # put two lines in the journal, and a duplicate reads as two faults to whoever
  # is triaging a failing eMMC. The old code had this property and the hoist
  # into a shared wrapper dropped it.
  CLAWBOX_AGENTS_UNREADABLE=0
  clawbox_agents_append() {
    # `local` for namespace hygiene beside `clawbox_append_or_rollback`, which
    # declares its own: the value is assigned on every call, so nothing leaks
    # between them, but a name this file uses nowhere else should not become a
    # global that a later block could read.
    local CLAWBOX_AGENTS_SEEN=0
    clawbox_file_has_heading "$CLAWBOX_AGENTS_MD" "$1" || CLAWBOX_AGENTS_SEEN=$?
    case "$CLAWBOX_AGENTS_SEEN" in
      0) return 0 ;;
      1) ;;
      *)
        if [ "$CLAWBOX_AGENTS_UNREADABLE" = 0 ]; then
          CLAWBOX_AGENTS_UNREADABLE=1
          echo "  WARNING: could not read $CLAWBOX_AGENTS_MD while looking for its markers; leaving it as it is" >&2
        fi
        return 0
        ;;
    esac
    # Guarded, and not a bare append: a read-only AGENTS.md used to abort
    # pre-start under `set -euo pipefail` and the gateway never started — over a
    # pointer sentence. Advisory text must never hold up the gateway; the next
    # start retries.
    if clawbox_append_or_rollback "$CLAWBOX_AGENTS_MD" "$2"; then
      echo "  $3"
    else
      echo "  WARNING: $4" >&2
    fi
  }
  # The same two sentences CLAWBOX.md gets above, because this is the file the
  # harness injects into EVERY session and a withheld rule here is TASK-612's
  # failure mode returning.
  #
  # Nothing here creates AGENTS.md — the harness owns that — so there is no seed
  # arm and no dangling-symlink case to answer: `-e` is false for a dangling
  # link, which lands on "no AGENTS.md yet", which is correct.
  if [ -e "$CLAWBOX_AGENTS_MD" ] && [ ! -f "$CLAWBOX_AGENTS_MD" ]; then
    # A directory, socket or FIFO in AGENTS.md's place: `-f` alone reads that as
    # "there is no AGENTS.md" and both blocks below are skipped in silence, boot
    # after boot, with the pointer and the rule never delivered.
    echo "  WARNING: $CLAWBOX_AGENTS_MD exists and is not a regular file; leaving it as it is" >&2
  elif [ -f "$CLAWBOX_AGENTS_MD" ] && [ ! -r "$CLAWBOX_AGENTS_MD" ]; then
    echo "  WARNING: could not read $CLAWBOX_AGENTS_MD; leaving it as it is" >&2
  elif [ -f "$CLAWBOX_AGENTS_MD" ]; then
    # An AGENTS.md whose own fences do not balance is read as prose, so a marker
    # QUOTED inside a fence — the agent showing the owner what ClawBox appends —
    # counts as present and its block is withheld for good. Nothing else here
    # would catch it, so the operator gets the sentence instead of silence.
    CLAWBOX_AGENTS_FENCES=0
    clawbox_fences_balanced "$CLAWBOX_AGENTS_MD" || CLAWBOX_AGENTS_FENCES=$?
    if [ "$CLAWBOX_AGENTS_FENCES" = 1 ]; then
      echo "  WARNING: the \`\`\` fences in $CLAWBOX_AGENTS_MD do not balance; a marker quoted inside one will be read as present and its block withheld. Close the fence" >&2
    fi
    printf -v CLAWBOX_AGENTS_POINTER_TEXT '\n\n%s\n\nSee `CLAWBOX.md` for device-specific conventions: where user-installed skills live, how to control the desktop Chromium via `browser_*` tools, how to install/uninstall skills through the App Store, and which system actions are the owner'"'"'s.\n' "$CLAWBOX_AGENTS_POINTER"
    clawbox_agents_append "$CLAWBOX_AGENTS_POINTER" "$CLAWBOX_AGENTS_POINTER_TEXT" \
      "Appended CLAWBOX.md reference to AGENTS.md" \
      "could not append the CLAWBOX.md reference to AGENTS.md"

    # THE RULE ITSELF GOES IN AGENTS.md, not only in CLAWBOX.md.
    #
    # OpenClaw's workspace file map (docs/concepts/agent-workspace.md, verified
    # in the pinned 2026.8.1 package) injects AGENTS.md, SOUL.md, USER.md,
    # IDENTITY.md, BOOT.md, BOOTSTRAP.md and memory/ at the start of every
    # session — and describes AGENTS.md as "operating instructions ... good
    # place for rules". CLAWBOX.md is NOT in that set: it is read only if the
    # agent chooses to open it, prompted by the pointer above. A behavioural
    # prohibition that the model may never load is not a prohibition, which is
    # how TASK-612 could otherwise have shipped green and reproduced unchanged.
    #
    # Its own marker, deliberately not the "CLAWBOX.md" one: that pointer is
    # already present on every box in the field, so anything guarded by it can
    # never be delivered again.
    CLAWBOX_AGENTS_RULE="## System actions on this ClawBox"
    printf -v CLAWBOX_AGENTS_RULE_TEXT '\n\n%s\n\nRestarting the OpenClaw gateway is not yours to do from a chat turn: the gateway hosts this session, so the restart kills the reply before it lands. It is rarely needed either — saving a setting under Settings -> Providers, Voice or Channels restarts it. Say that, and name the setting.\n\nA device restart or shutdown IS yours when the owner asks in their own words: `system_power`, `confirm: true`, with their reason. Their own control is the power menu in the desktop tray, not Settings -> System.\n\nNever queue an `operator_approval` proposal for any of this. ClawBox renders no approval card, so a queued proposal is shown to nobody; a parked one is answered with `openclaw approvals pending` / `openclaw approvals resolve` from the Terminal app. `CLAWBOX.md` has the long form.\n' "$CLAWBOX_AGENTS_RULE"
    clawbox_agents_append "$CLAWBOX_AGENTS_RULE" "$CLAWBOX_AGENTS_RULE_TEXT" \
      "Appended the system-actions rule to AGENTS.md" \
      "could not append the system-actions rule to AGENTS.md"
  fi

  # --- clawbox language re-apply ---
  # Re-apply the owner's chosen UI language to the persona.
  #
  # The Next app no longer writes USER.md/SOUL.md when the language is picked
  # in the setup wizard: doing so before the agent's first reply is what told
  # OpenClaw the workspace was already configured and cost every box its
  # introduction (src/lib/language-persona.ts, personaWritesAllowed). The pick
  # is still stored, in `pref:ui_language` in the device store, and this is one
  # of the two places it is paid back.
  #
  # This one is the BOOT path, not the only one. Nothing restarts the gateway
  # when the introduction ends, so a box left running would wait here for days;
  # the five-minute portal heartbeat drains the same debt through
  # applyDeferredLanguagePersona() (src/lib/language-persona.ts). This block
  # stays because it costs nothing and it covers the box that reboots, or
  # updates, before its first tick lands.
  #
  # Same two conditions the route applies, for the same reasons: USER.md must
  # already exist (creating it is the suppressing act) and BOOTSTRAP.md must
  # not (the ritual is armed and unfinished, and an edit now makes the next
  # turn delete it). A language changed from Settings AFTER the introduction
  # goes straight through the route and does not wait for this.
  #
  # The transformation is byte-for-byte the one writeLanguagePersona() performs
  # — src/tests/unit/gateway-prestart-onboarding.test.ts runs this very block
  # against that function and compares — and it rewrites nothing when the files
  # already say the right thing, so it is a no-op on every reboot after the
  # first.
  if [ -f "$CLAWBOX_WORKSPACE/USER.md" ] && [ ! -e "$CLAWBOX_WORKSPACE/BOOTSTRAP.md" ]; then
    export CLAWBOX_LANG_USER_MD="$CLAWBOX_WORKSPACE/USER.md"
    export CLAWBOX_LANG_SOUL_MD="$CLAWBOX_WORKSPACE/SOUL.md"
    # Guarded and warn-only, under this section's standing rule: this script is
    # a bare ExecStartPre under `set -euo pipefail`, so an unguarded failure
    # here is the gateway's failure.
    if ! python3 - <<'PY_LANG'
import json, os, re

# The locales the desktop ships, with the names that reach the agent's system
# prompt. Kept in step with LANG_NAMES in src/lib/language-persona.ts by the
# test named above, which drives both and diffs the result.
LANG_NAMES = {
    "en": "English", "bg": "Български", "de": "Deutsch", "es": "Español",
    "fr": "Français", "it": "Italiano", "ja": "日本語", "nl": "Nederlands",
    "sv": "Svenska", "zh": "中文",
}

try:
    with open(os.environ["CLAWBOX_DEVICE_STORE"], encoding="utf-8") as fh:
        lang = json.load(fh).get("pref:ui_language")
except (OSError, ValueError):
    # No device store yet, or one that is mid-write: nothing was ever picked,
    # so there is nothing to pay back. Not an error.
    raise SystemExit(0)
# The stored value is validated on the way in, but this reads a file on disk,
# and this string is interpolated into a system prompt — so the closed set is
# checked again here rather than trusted.
if not isinstance(lang, str) or lang not in LANG_NAMES:
    raise SystemExit(0)
name = LANG_NAMES[lang]

line = "- **Language:** %s (%s)" % (name, lang)
if lang != "en":
    line += " — Always respond in %s" % name

SOUL_SECTION = re.compile(r"\n## Language\n[\s\S]*?(?=\n## |\n\Z|\Z)")


def user_md(text):
    text = re.sub(r"\n- \*\*Language:\*\*.*\n", "\n", text)
    if "- **Name:**" in text:
        return re.sub(r"(- \*\*Name:\*\*.*\n)", lambda m: m.group(1) + line + "\n", text, count=1)
    return text.rstrip() + "\n" + line + "\n"


def soul_md(text):
    stripped = SOUL_SECTION.sub("", text, count=1)
    if lang == "en":
        # English is the absence of the instruction, not another instruction.
        return stripped.rstrip() + "\n" if "## Language" in text else text
    return stripped.rstrip() + (
        "\n\n## Language\n\nYou MUST respond in %s. The user's preferred language is %s (%s). "
        "All messages, explanations, and summaries must be in %s. Only use English for code, "
        "technical terms, and tool names.\n" % (name, name, lang, name)
    )


def rewrite(path, transform, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            before = fh.read()
    except FileNotFoundError:
        # Only the non-English SOUL.md is worth creating; see soul_md above.
        if default is None:
            return
        before = default
    after = transform(before)
    # Idempotence, and the reason a reboot is not a write: the persona is the
    # agent's own file and rewriting it with identical bytes on every gateway
    # start would churn its mtime for nothing.
    if after == before:
        return
    tmp = path + ".clawbox-lang.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(after)
    os.replace(tmp, path)


rewrite(os.environ["CLAWBOX_LANG_USER_MD"], user_md)
rewrite(os.environ["CLAWBOX_LANG_SOUL_MD"], soul_md,
        None if lang == "en" else "# SOUL.md - Who You Are\n")
PY_LANG
    then
      echo "  WARNING: could not apply the saved UI language to the workspace persona" >&2
    fi
    unset CLAWBOX_LANG_USER_MD CLAWBOX_LANG_SOUL_MD
  fi
  # --- end clawbox language re-apply ---
fi
# --- end guide seeding ---
