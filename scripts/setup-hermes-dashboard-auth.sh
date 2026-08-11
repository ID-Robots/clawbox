#!/usr/bin/env bash
# Configure the Hermes dashboard's password (basic_auth) provider so the
# dashboard runs in gated cookie-auth mode and the reverse proxy can sign the
# ClawBox user in transparently (SSO). Idempotent — safe to re-run.
#
# Run as the CLAWBOX user (owns ~/.hermes/config.yaml). setup-hermes-edition.sh
# invokes it via `runuser -u clawbox`, and clawbox-hermes-dashboard.service runs
# it as an ExecStartPre so a factory-reset box re-provisions itself at boot.
#
# Why a password provider at all: since the June 2026 Hermes hardening, a
# non-loopback dashboard bind ALWAYS requires an auth provider. We bind
# 127.0.0.2 (host-local, but non-loopback → gated mode), so we must configure
# one. The password lives ONLY server-side (data/.hermes-dashboard-pw, 0600);
# the proxy reads it to log in on the user's behalf. The customer never types
# it — their clawbox_session at the proxy is the real gate.
#
# THE INVARIANT THIS SCRIPT EXISTS TO KEEP: the plaintext in $PWFILE and the
# password_hash in the config must always describe the SAME password. The old
# version could break that — it gated on "$PWFILE non-empty AND a dashboard:
# block exists", so after a factory reset removed data/ but left config.yaml it
# minted a NEW password and then explicitly left the OLD hash "as-is". The two
# were then permanently desynced: the proxy's SSO login 401'd forever, the
# customer got a password form for a password that existed nowhere, and
# re-running the script never repaired it because the gate passed again.
# The check below therefore VERIFIES the pair instead of merely observing that
# both artefacts exist, and minting a password now always rewrites the block.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
PWFILE="$PROJECT_DIR/data/.hermes-dashboard-pw"
USERNAME="${HERMES_DASH_USERNAME:-clawbox}"

log() { echo "[hermes-dash-auth] $*"; }

# ── Already correctly configured? ───────────────────────────────────────────
# Not "do both artefacts exist" but "does the stored hash actually verify the
# stored password". That is the only check that can't leave a desynced pair
# behind, and it also repairs a truncated/corrupted password file.
creds_are_consistent() {
  [ -s "$PWFILE" ] || return 1
  [ -f "$HERMES_CONFIG" ] || return 1
  CFG="$HERMES_CONFIG" PW_PATH="$PWFILE" python3 - <<'PY'
import base64, hashlib, os, re, sys

try:
    with open(os.environ["CFG"], "r", encoding="utf-8") as fh:
        cfg = fh.read()
    with open(os.environ["PW_PATH"], "r", encoding="utf-8") as fh:
        pw = fh.read().strip()
except OSError:
    sys.exit(1)

if not pw:
    sys.exit(1)

# Pull the password_hash out of the top-level `dashboard:` block only, so an
# unrelated hash elsewhere in the config can't make us think we're configured.
block = re.search(r"(?m)^dashboard:[ \t]*\n((?:[ \t].*\n|[ \t]*\n)*)", cfg)
if not block:
    sys.exit(1)
found = re.search(r"(?m)^\s*password_hash:\s*[\"']?([^\"'\s]+)[\"']?\s*$", block.group(1))
secret = re.search(r"(?m)^\s*secret:\s*[\"']?([^\"'\s]+)[\"']?\s*$", block.group(1))
if not found or not secret:
    sys.exit(1)

parts = found.group(1).split("$")
if len(parts) != 6 or parts[0] != "scrypt":
    sys.exit(1)
try:
    n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
    salt = base64.b64decode(parts[4])
    expected = base64.b64decode(parts[5])
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=n, r=r, p=p, dklen=len(expected), maxmem=0)
except Exception:
    sys.exit(1)

sys.exit(0 if dk == expected else 1)
PY
}

if creds_are_consistent; then
  log "already configured (stored hash verifies the stored password) — skipping"
  # Still re-assert the file modes: config.yaml carries the dashboard's
  # session-signing secret and the scrypt hash, and the heredoc that used to
  # write it inherited the caller's umask, leaving it world-readable (0664 on
  # the shipping device). Anyone who can read as any user could forge a
  # dashboard session cookie from it.
  chmod 600 "$HERMES_CONFIG" 2>/dev/null || true
  for bak in "$HERMES_CONFIG".bak*; do
    [ -f "$bak" ] && chmod 600 "$bak" 2>/dev/null || true
  done
  chmod 600 "$PWFILE" 2>/dev/null || true
  exit 0
fi

mkdir -p "$(dirname "$PWFILE")"
mkdir -p "$(dirname "$HERMES_CONFIG")"

# A missing config is no longer a reason to give up. It is the NORMAL state
# both on a fresh flash (install.sh clones Hermes, but config.yaml only appears
# on the first `hermes` run) and after a factory reset (which wipes ~/.hermes
# precisely because it holds the previous owner's provider keys, OAuth tokens
# and chat DB). Skipping here meant the dashboard came up on its non-loopback
# bind with no auth provider and crash-looped, with nothing to repair it.
# Creating a config that contains only our dashboard block is safe: Hermes
# merges its own defaults for everything else.
if [ ! -f "$HERMES_CONFIG" ]; then
  log "$HERMES_CONFIG not found — creating one with just the dashboard block"
  : > "$HERMES_CONFIG"
  chmod 600 "$HERMES_CONFIG"
fi

# Generate password + scrypt password_hash + token-signing secret. The hash
# format matches Hermes's plugins.dashboard_auth.basic.hash_password
# (scrypt$n$r$p$salt_b64$dk_b64) but uses only stdlib so we don't depend on the
# Hermes venv/plugin path.
GEN="$(python3 - <<'PY'
import secrets, base64, hashlib
pw = secrets.token_urlsafe(24)
salt = secrets.token_bytes(16)
dk = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32, maxmem=0)
h = "scrypt$%d$%d$%d$%s$%s" % (2**14, 8, 1, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())
print(pw)
print(h)
print(secrets.token_urlsafe(32))
PY
)"
PW="$(printf '%s\n' "$GEN" | sed -n '1p')"
HASH="$(printf '%s\n' "$GEN" | sed -n '2p')"
SECRET="$(printf '%s\n' "$GEN" | sed -n '3p')"

if [ -z "$PW" ] || [ -z "$HASH" ] || [ -z "$SECRET" ]; then
  log "ERROR: failed to generate credentials" >&2
  exit 1
fi

# Install the dashboard block FIRST, then the plaintext. If the rewrite fails we
# exit non-zero having changed nothing the proxy depends on, rather than leaving
# a new plaintext next to an old hash — the exact desync this script guards
# against.
#
# REPLACE, never append: a second top-level `dashboard:` key is invalid YAML
# (and, depending on the loader, silently shadows the first), so an append-only
# path could only ever be run once. Written via a temp file + rename so a crash
# mid-write can't truncate the customer's config.
CFG="$HERMES_CONFIG" USERNAME="$USERNAME" HASH="$HASH" SECRET="$SECRET" PW_PATH="$PWFILE" python3 - <<'PY' || { log "ERROR: failed to write the dashboard block to $HERMES_CONFIG" >&2; exit 1; }
import json, os, re, sys

cfg_path = os.environ["CFG"]
with open(cfg_path, "r", encoding="utf-8") as fh:
    cfg = fh.read()

# Drop any existing top-level `dashboard:` block: the key line plus every
# following indented / blank line, up to the next top-level key.
cfg = re.sub(r"(?m)^dashboard:[ \t]*\n(?:[ \t].*\n|[ \t]*\n)*", "", cfg)
# Also drop the banner comment a previous run of this script wrote above it, so
# repeated repairs don't accumulate duplicated comment blocks.
cfg = re.sub(r"(?m)^# ClawBox Hermes edition — dashboard password auth.*\n(?:^#.*\n)*", "", cfg)
cfg = cfg.rstrip("\n")

block = "\n".join([
    "",
    "# ClawBox Hermes edition — dashboard password auth (SSO via reverse proxy).",
    "# The password lives in %s (0600); the proxy logs in on the user's" % os.environ["PW_PATH"],
    "# behalf. Do not remove — the dashboard requires an auth provider.",
    "# Managed by scripts/setup-hermes-dashboard-auth.sh: this whole block is",
    "# REPLACED whenever the password is re-minted, so hash and plaintext can",
    "# never drift apart. Hand edits will be overwritten.",
    "dashboard:",
    "  basic_auth:",
    # Quoted like the two lines below it. HERMES_DASH_USERNAME is operator-set,
    # and a bare scalar holding ':', '#' or a leading '-' either changes what
    # the line means or stops being YAML at all — at which point Hermes has no
    # auth provider to load and the dashboard cannot come up. json.dumps emits
    # a double-quoted scalar YAML reads back verbatim for any input.
    "    username: %s" % json.dumps(os.environ["USERNAME"]),
    '    password_hash: "%s"' % os.environ["HASH"],
    '    secret: "%s"' % os.environ["SECRET"],
    "    session_ttl_seconds: 604800",
    "",
])

tmp = cfg_path + ".clawbox-tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write((cfg + "\n" if cfg else "") + block)
    os.replace(tmp, cfg_path)
except Exception as exc:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    print("write failed: %s" % exc, file=sys.stderr)
    sys.exit(1)
PY

# config.yaml now holds the session-signing secret and the password hash.
chmod 600 "$HERMES_CONFIG"
for bak in "$HERMES_CONFIG".bak*; do
  [ -f "$bak" ] && chmod 600 "$bak" 2>/dev/null || true
done
log "wrote dashboard.basic_auth to $HERMES_CONFIG (username=$USERNAME, ttl=7d, mode 600)"

# Store the plaintext password for the proxy ONLY (clawbox-owned, 0600).
umask 077
printf '%s' "$PW" > "$PWFILE"
chmod 600 "$PWFILE"
log "wrote $PWFILE (0600)"

# Prove the pair we just installed actually verifies, so a bug here surfaces
# now rather than as a permanent 401 loop at the proxy.
if ! creds_are_consistent; then
  log "ERROR: freshly written password and hash do not verify — refusing to report success" >&2
  exit 1
fi

log "done"
