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

# Pinned OpenClaw target — external plugins (e.g. @openclaw/codex) must stay
# locked to the same version as the core, or they drift ahead via @latest and
# crash at runtime against the pinned core. Read from the repo pin file, same
# source install.sh and updater.ts use. Empty = pin unknown, fall back to the
# unpinned alias (preserves old behaviour rather than risk skipping a repair).
OPENCLAW_TARGET=""
OPENCLAW_PIN_FILE="/home/clawbox/clawbox/config/openclaw-target.txt"
if [ -n "${OPENCLAW_PIN_VERSION:-}" ]; then
  OPENCLAW_TARGET="${OPENCLAW_PIN_VERSION}"
elif [ -f "$OPENCLAW_PIN_FILE" ]; then
  OPENCLAW_TARGET=$(head -1 "$OPENCLAW_PIN_FILE" | awk '{print $1}')
fi

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
import json, os, sys, tempfile, secrets

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
# gateway start. Mirrors CODEX_SUPPORTED_MODEL_RE / hasOpenAiApiKeyProfile /
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

if _has_codex_oauth_profile() and not _has_openai_api_key_profile():
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
# worth guarding, so the strip is kept for everything that is NOT a codex
# model -- an orphaned agentRuntime on some other provider has no purpose.
#
# Also seed the entry for any codex model the box is actually configured to
# use, so picking one in the UI works after the next gateway start rather than
# needing the key added by hand.
agents_models = agents_defaults.get("models")
if not isinstance(agents_models, dict):
    agents_models = {}

def _is_codex_ref(model_id):
    return isinstance(model_id, str) and model_id.strip().lower().startswith("codex/")

_codex_refs = set()
if _is_codex_ref(model_defaults.get("primary")):
    _codex_refs.add(model_defaults["primary"].strip())
for _fb in model_defaults.get("fallbacks") or []:
    if _is_codex_ref(_fb):
        _codex_refs.add(_fb.strip())
for _model_key in list(agents_models.keys()):
    if _is_codex_ref(_model_key):
        _codex_refs.add(_model_key)

for _model_key, _model_val in list(agents_models.items()):
    if not isinstance(_model_val, dict):
        continue
    if not _is_codex_ref(_model_key) and "agentRuntime" in _model_val:
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
channels = cfg.get("channels")
if isinstance(channels, dict):
    telegram = channels.get("telegram")
    if isinstance(telegram, dict):
        for k in ("dmPolicy", "allowFrom"):
            if k in telegram:
                del telegram[k]
                changed = True
        # Config-validity migration: a Telegram bot set up on an older OpenClaw
        # can carry a channels.telegram.groupPolicy value the current schema no
        # longer accepts (allowed: open, disabled, allowlist). One invalid value
        # makes the WHOLE config invalid, so the gateway loads nothing and the
        # bot goes silent ("Telegram channel active" but never replies). Reset
        # unknown values to the secure default so the device self-heals on the
        # next gateway start — ClawBox exposes no group-chat UI, so "disabled"
        # (bot ignores group chats; owner DMs still work) is the safe choice.
        if telegram.get("groupPolicy") not in (None, "open", "disabled", "allowlist"):
            telegram["groupPolicy"] = "disabled"
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
if isinstance(deepseek_provider, dict) and deepseek_provider.get("baseUrl") in (
    "https://openclawhardware.dev/api/ai",
    "https://www.openclawhardware.dev/api/ai",
):
    deepseek_provider["baseUrl"] = "https://clawbox.com/api/ai"
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
if [ ! -f "$CODEX_PLUGIN_DIR/package.json" ]; then
  CODEX_PLUGIN_DIR_FOUND="$(ls -d "$OPENCLAW_HOME_DIR"/npm/projects/*/node_modules/@openclaw/codex 2>/dev/null | head -1 || true)"
  [ -n "$CODEX_PLUGIN_DIR_FOUND" ] && CODEX_PLUGIN_DIR="$CODEX_PLUGIN_DIR_FOUND"
fi
NEEDS_CODEX_PLUGIN="$(python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    print("0"); sys.exit(0)
primary = (cfg.get("agents", {}).get("defaults", {}).get("model", {}) or {}).get("primary") or ""
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
    (isinstance(k, str)
     and (k.lower().startswith("codex:") or k.lower().startswith("openai-codex:"))) or
    (isinstance(v, dict) and isinstance(v.get("provider"), str)
     and v["provider"].lower() in ("codex", "openai-codex"))
    for k, v in profiles.items()
)
print("1" if uses_codex else "0")
PY
)"
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
if [ "$NEEDS_CODEX_PLUGIN" = "1" ]; then
  if [ ! -f "$CODEX_PLUGIN_DIR/package.json" ] || [ ! -e "$CODEX_PEER_DEP" ]; then
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
  # Hard time-box this install. gateway-pre-start.sh runs as a BLOCKING
  # ExecStartPre for clawbox-gateway.service, so an npm install that hangs
  # (slow/blocked/offline registry on a Jetson) would keep the gateway from
  # ever reaching "listening" — which is exactly the "gateway won't start
  # after update" failure. Best-effort: if the install fails OR times out we
  # log a warning and let the gateway start anyway. Codex is one provider;
  # a degraded Codex is far better than a dead box, and the next boot (or a
  # manual `openclaw plugins install`) can still repair it.
  if timeout 120 "$OPENCLAW_BIN" plugins install "$CODEX_SPEC" --force >/dev/null 2>&1; then
    echo "  Codex runtime plugin installed/repaired ($CODEX_SPEC)"
  else
    echo "  WARN: 'openclaw plugins install $CODEX_SPEC' failed or timed out; Codex chats will fail until resolved (gateway will still start)"
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
  AUTH_PROFILE_MIGRATION="${CLAWBOX_ROOT:-/home/clawbox/clawbox}/scripts/migrate-auth-profiles.js"
  if [ -f "$AUTH_PROFILE_MIGRATION" ]; then
    node "$AUTH_PROFILE_MIGRATION" "$OPENCLAW_HOME_DIR" || true
  fi

  CODEX_AUTH_MIRROR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}/scripts/codex-auth-mirror.js"
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
# auth/API-key access". If the user hasn't deliberately chosen an embeddings
# provider AND the local model is present in Ollama, point memory search at
# local Ollama so semantic recall works with zero API key. Self-heals existing
# boxes on upgrade, not just fresh installs. Gated on the model actually being
# present so we never leave memorySearch fail-closed on a missing model; only
# touches an unset/"auto" provider so a deliberate OpenAI/remote setup stays.
MEM_PROVIDER="$(python3 -c "import json;print(((json.load(open('$OPENCLAW_CONFIG')).get('agents',{}).get('defaults',{}) or {}).get('memorySearch',{}) or {}).get('provider') or '')" 2>/dev/null || echo "")"
if [ -z "$MEM_PROVIDER" ] || [ "$MEM_PROVIDER" = "auto" ]; then
  if curl -fsS --max-time 5 http://localhost:11434/api/tags 2>/dev/null | grep -q "qwen3-embedding"; then
    if "$OPENCLAW_BIN" config set agents.defaults.memorySearch.provider ollama >/dev/null 2>&1 \
       && "$OPENCLAW_BIN" config set agents.defaults.memorySearch.model qwen3-embedding:0.6b >/dev/null 2>&1; then
      echo "  Memory search -> local Ollama embeddings (qwen3-embedding:0.6b, no API key needed)"
    else
      echo "  WARN: could not set memorySearch to local Ollama embeddings (non-fatal; memory falls back to lexical FTS)"
    fi
  fi
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
MCP_TOKEN_FILE="${CLAWBOX_ROOT:-/home/clawbox/clawbox}/data/.mcp-token"
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
    "command": "/home/clawbox/.bun/bin/bun",
    "args": ["run", "/home/clawbox/clawbox/mcp/clawbox-mcp.ts"],
    "env": {
        "CLAWBOX_API_BASE": "http://127.0.0.1:80",
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
CLAWBOX_GUIDE_SRC="/home/clawbox/clawbox/config/clawbox-workspace-guide.md"
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
