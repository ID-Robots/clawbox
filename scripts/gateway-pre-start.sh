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
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-${OPENCLAW_HOME:-$CLAWBOX_HOME_DIR/.openclaw}/openclaw.json}"
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
  OPENCLAW_TARGET=$(head -1 "$OPENCLAW_PIN_FILE" | awk '{print $1}')
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
# reporting ready. Decided from the pinned target (the fleet's source of
# truth), falling back to the installed binary when the pin is unknown.
# The INSTALLED binary is the authority: it is the process that will parse
# what this script writes. A partially failed update (repo synced, npm
# install not yet done) leaves pin=2026.8.1 with a 2026.7 binary — deciding
# from the pin there would write v2 keys a v1 gateway refuses AND delete the
# controlUi auth switches v1 still needs. The pin only fills in when the
# binary cannot be asked.
CLAWBOX_OPENCLAW_EFFECTIVE="$("$OPENCLAW_BIN" --version 2>/dev/null | grep -oE '20[0-9]{2}\.[0-9]+\.[0-9]+' | head -1)"
if [ -z "$CLAWBOX_OPENCLAW_EFFECTIVE" ]; then
  CLAWBOX_OPENCLAW_EFFECTIVE="${OPENCLAW_TARGET}"
fi
# An explicit CLAWBOX_OPENCLAW_V2 in the environment wins — the unit tests
# pin BOTH generations of this script against fixture configs, and they must
# not follow whatever the box's own pin file happens to say.
if [ -z "${CLAWBOX_OPENCLAW_V2:-}" ]; then
  CLAWBOX_OPENCLAW_V2=0
  if [ -n "$CLAWBOX_OPENCLAW_EFFECTIVE" ] && [ "$(printf '%s\n' 2026.8 "$CLAWBOX_OPENCLAW_EFFECTIVE" | sort -V | head -1)" = "2026.8" ]; then
    CLAWBOX_OPENCLAW_V2=1
  fi
fi
export CLAWBOX_OPENCLAW_V2

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
export CLAWBOX_PORT
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
except json.JSONDecodeError as err:
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
agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})
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
model_defaults = agents_defaults.setdefault("model", {})
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

# Key presence, not truthiness: an existing but empty {} entry is a deliberate
# operator choice and must be preserved, which .get() would silently overwrite.
_models_now = cfg.get("models")
_providers_now = _models_now.get("providers") if isinstance(_models_now, dict) else None
if _wants_llamacpp and not (
    isinstance(_providers_now, dict) and "llamacpp" in _providers_now
):
    # Touch models/providers only on the repair path. A malformed scalar must
    # not crash ExecStartPre, and an unrelated config must not gain an empty
    # models key merely because some other migration changed the file.
    if not isinstance(_models_now, dict):
        _models_now = {}
        cfg["models"] = _models_now
    if not isinstance(_providers_now, dict):
        _providers_now = {}
        _models_now["providers"] = _providers_now
    _mp = _providers_now
    # The proxy authenticates openclaw -> Next.js with a per-install bearer
    # (src/lib/local-ai-token.ts). Writing the entry WITHOUT it would trade
    # "Unknown model" for a 401 on every turn, which is not an improvement, so
    # a box with no token file is left alone and told why.
    _token_path = os.path.join(
        os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox"), "data", ".local-ai-token"
    )
    try:
        with open(_token_path) as _tf:
            _local_ai_token = _tf.read().strip()
    except OSError:
        _local_ai_token = ""

    if len(_local_ai_token) < 16:
        print(
            "  Skipped llamacpp provider repair: "
            + _wants_llamacpp[0]
            + " is configured but "
            + _token_path
            + " is missing or too short, so the proxy would reject every call."
        )
    else:
        _model_id = _wants_llamacpp[0][len("llamacpp/"):]
        # A non-numeric override must not abort gateway pre-start: this migration
        # runs on the path that repairs a mute box, so raising here would turn a
        # bad env var into a box that never starts at all.
        try:
            _ctx = int(os.environ.get("LLAMACPP_CONTEXT_WINDOW") or 0)
        except ValueError:
            _ctx = 0
        if _ctx < 16384:
            _ctx = 131072
        _proxy_port = (os.environ.get("CLAWBOX_PORT") or os.environ.get("PORT") or "80").strip()
        if not _proxy_port.isdigit() or not 1 <= int(_proxy_port) <= 65535:
            _proxy_port = "80"
        _proxy_default = "http://127.0.0.1" + (
            "" if _proxy_port == "80" else ":" + _proxy_port
        )
        _proxy_root = (
            os.environ.get("CLAWBOX_LOCAL_AI_PROXY_BASE_URL") or _proxy_default
        ).strip().rstrip("/")
        _mp["llamacpp"] = {
            "baseUrl": _proxy_root + "/setup-api/local-ai/llamacpp/v1",
            "api": "openai-completions",
            "apiKey": _local_ai_token,
            "models": [{
                "id": _model_id,
                "name": _model_id,
                "reasoning": False,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": _ctx,
                "maxTokens": _ctx,
            }],
        }
        changed = True
        print("  Repaired models.providers.llamacpp for " + _wants_llamacpp[0])

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
models_providers = cfg.setdefault("models", {}).setdefault("providers", {})
if has_openrouter_auth and not models_providers.get("openrouter"):
    primary = (cfg.get("agents", {}).get("defaults", {}).get("model", {}) or {}).get("primary", "")
    default_model = primary[len("openrouter/"):] if isinstance(primary, str) and primary.startswith("openrouter/") else "moonshotai/kimi-k2-0905"
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
# reader of this set (`_is_our_image_row`, `_is_foreign`) sits inside the
# `claw_` gate below, so on a raw-DeepSeek box the set is never consulted.
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

    # An entry pointing somewhere that is not our proxy is the owner's own
    # OpenAI-compatible voice — a self-hosted Kokoro, an OpenAI key of their
    # own, a different route on our host. Leave every field of it alone. The
    # same one-trailing-slash rule the transcription migration uses, for the
    # same reason: `.../api/ai//` is a deliberate route, not a typo to tidy.
    _speech_base_url = _speech.get("baseUrl")
    _speech_route_taken = bool(
        isinstance(_speech_base_url, str)
        and _speech_base_url.strip()
        and not _same_endpoint(_speech_base_url, _clawai_proxy_base_url)
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
        # Adopt and normalise an unmarked entry that already points at us — a
        # hand repair, or one written before this stamp existed — rather than
        # leave a box with a half-configured voice. Writing is recoverable and
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
    # while it does it. Take back only what we wrote, and "what we wrote" means
    # our own stamp plus our own proxy, not the proxy alone: an entry pointing
    # at this host that we did not stamp is somebody's hand-written config, and
    # this is the one place in the file that destroys configuration. An owner's
    # own voice is theirs whatever their ClawBox AI plan says.
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
        if (
            _speech.get(CLAWBOX_SPEECH_MANAGED_KEY) is True
            and isinstance(_speech_base_url, str)
            and _speech_base_url.strip()
            and _same_endpoint(_speech_base_url, _clawai_proxy_base_url)
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
  python3 - "$DEEPSEEK_PLUGIN_JSON" <<'PY'
import json, os, sys, tempfile

path = sys.argv[1]
target = ["off", "high", "xhigh"]
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
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
LEGACY_CODEX_PRIMARY="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except (FileNotFoundError, json.JSONDecodeError):
    print(""); sys.exit(0)
primary = (((cfg.get("agents") or {}).get("defaults") or {}).get("model") or {}).get("primary") or ""
print(primary if isinstance(primary, str) and primary.lower().startswith("openai-codex/") else "")
PY
)"
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
if [ ! -f "$CODEX_PLUGIN_DIR/package.json" ]; then
  CODEX_PLUGIN_DIR_FOUND="$(
    timeout 20 "$OPENCLAW_BIN" plugins list --json 2>/dev/null |
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
  CODEX_REGISTRY_DEPS_OK="$(
    timeout 20 "$OPENCLAW_BIN" plugins list --json 2>/dev/null |
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
NEEDS_CODEX_PLUGIN="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
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
)"
# OpenClaw 2 loads an installed plugin by default when its config entry is
# absent. That default-enabled state must participate in BOTH the package
# health/version checks and capability consent below; otherwise a migrated
# 2026.7 package can be consented but remain broken against a 2026.8 core.
CODEX_PLUGIN_ENABLED=0
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ -f "$CODEX_PLUGIN_DIR/package.json" ]; then
  CODEX_PLUGIN_ENABLED="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    print("1"); sys.exit(0)
plugins = cfg.get("plugins")
entries = plugins.get("entries", {}) if isinstance(plugins, dict) else {}
codex = entries.get("codex") if isinstance(entries, dict) else None
print("0" if isinstance(codex, dict) and codex.get("enabled") is False else "1")
PY
)"
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
  else
    echo "  WARN: 'openclaw plugins install $CODEX_SPEC' failed or timed out; Codex chats will fail until resolved (gateway will still start)"
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
  if timeout 60 "$OPENCLAW_BIN" plugins enable codex --accept-capabilities </dev/null >/dev/null 2>&1; then
    echo "  Codex runtime plugin capabilities accepted/current"
  else
    echo "  WARN: could not confirm Codex plugin capabilities; gateway readiness may remain blocked"
  fi
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
# pulls the local model if it is missing, points memorySearch at it (only when
# the provider is unset/"auto"/already ollama, so a deliberate remote setup
# stays), and forces the reindex the dimension change requires.
#
# Launched DETACHED on purpose: this is a blocking ExecStartPre and the model is
# a ~600MB download. The script takes its own lock, so overlapping restarts do
# not stack up pulls.
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
if [ ! -s "$MCP_TOKEN_FILE" ] || [ "$(wc -c < "$MCP_TOKEN_FILE" 2>/dev/null || echo 0)" -lt 32 ]; then
  mkdir -p "$(dirname "$MCP_TOKEN_FILE")"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$MCP_TOKEN_FILE"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$MCP_TOKEN_FILE"
  fi
fi
# Re-harden mode unconditionally: chmod only ran on the regeneration
# path before, so a file with drifted permissions (manual edit, upgrade
# from a pre-0600 build) would keep being trusted as-is. The bearer
# is the sole /setup-api/* credential.
chmod 600 "$MCP_TOKEN_FILE"

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
if [ ! -r "$MCP_TOKEN_FILE" ]; then
  echo "  ERROR: MCP token file is not readable: $MCP_TOKEN_FILE" >&2
  exit 1
fi
CLAWBOX_MCP_TOKEN_VAL="$(cat "$MCP_TOKEN_FILE")"
if [ -z "$CLAWBOX_MCP_TOKEN_VAL" ]; then
  echo "  ERROR: MCP token file is empty: $MCP_TOKEN_FILE" >&2
  exit 1
fi
export CLAWBOX_MCP_TOKEN_VAL
export CLAWBOX_BUN_BIN="${CLAWBOX_BUN_BIN:-$CLAWBOX_HOME_DIR/.bun/bin/bun}"
export CLAWBOX_MCP_ENTRY="${CLAWBOX_MCP_ENTRY:-$CLAWBOX_ROOT/mcp/clawbox-mcp.ts}"
export CLAWBOX_API_BASE="${CLAWBOX_API_BASE:-http://127.0.0.1:$CLAWBOX_PORT}"
python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, sys, tempfile

cfg_path = sys.argv[1]
token = os.environ.get("CLAWBOX_MCP_TOKEN_VAL", "")
if not token:
    sys.exit(0)
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
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
unset CLAWBOX_MCP_TOKEN_VAL

# Seed CLAWBOX.md in the OpenClaw workspace so the agent's session-start
# context includes ClawBox-specific guidance (where user-installed skills
# actually live, how to control the desktop Chromium via the browser_*
# MCP tools, how to install/uninstall skills through the App Store
# instead of manipulating the filesystem directly). Without this, the
# base OpenClaw agent defaults don't know any of those conventions and
# falls back to guessing paths — which has misled it before (e.g.
# checking .npm-global/.../openclaw/skills for user skills and finding
# "nothing", even though the skill is installed at
# <workspace>/skills/).
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
  NEEDS_DEEPSEEK_PLUGIN="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except (FileNotFoundError, json.JSONDecodeError):
    print("0"); sys.exit(0)
providers = ((cfg.get("models") or {}).get("providers") or {})
deepseek = providers.get("deepseek")
key = deepseek.get("apiKey") if isinstance(deepseek, dict) else None
print("1" if isinstance(key, str) and key.strip() else "0")
PY
)"
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
    elif timeout 180 "$OPENCLAW_BIN" plugins install "$DEEPSEEK_PLUGIN_SPEC" --accept-capabilities </dev/null; then
      echo "  DeepSeek provider plugin installed ($DEEPSEEK_PLUGIN_SPEC)"
    else
      echo "  WARN: could not install @openclaw/deepseek-provider; the gateway will refuse readiness until it is installed"
    fi
  fi
fi
# Resolve the workspace from agents.defaults.workspace in openclaw.json,
# matching the same logic getSkillsDir() uses on the ClawBox API side —
# falls back to ~/.openclaw/workspace when unset, handles absolute vs
# tilde-relative vs bare-name values, and is safe when the file is
# missing (fresh factory-reset state).
CLAWBOX_WORKSPACE="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, sys
default = os.path.expanduser("~/.openclaw/workspace")
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
    ws = cfg.get("agents", {}).get("defaults", {}).get("workspace")
except (FileNotFoundError, json.JSONDecodeError, KeyError):
    ws = None
if isinstance(ws, str) and ws.strip():
    ws = os.path.expanduser(ws.strip())
    print(ws if os.path.isabs(ws) else os.path.join(os.path.expanduser("~/.openclaw"), ws))
else:
    print(default)
PY
)"
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
if [ -d "$CLAWBOX_WORKSPACE" ] && [ -f "$CLAWBOX_GUIDE_SRC" ]; then
  # Seed-if-missing rather than overwrite-on-diff. The agent and the
  # user may personalize CLAWBOX.md (add device-specific notes, remove
  # sections that don't apply). Overwriting on every gateway start
  # would clobber those edits. If the shipped template changes and an
  # operator wants to pull it in, they can delete the file; the next
  # gateway start will re-seed.
  if [ ! -f "$CLAWBOX_GUIDE_DST" ]; then
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
