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
#
# TWO THINGS THIS SCRIPT LEARNED THE HARD WAY, both about ~/.hermes/config.yaml
# having MORE THAN ONE WRITER:
#
#   1. The write and the verify race other writers. register-mcp.sh (run
#      fire-and-forget by production-server.js on every web-server boot), the
#      Hermes CLI's own load→save_config, and the /setup-api/hermes/* routes all
#      do read-modify-write on this same file. A writer that snapshotted the
#      file BEFORE we wrote our block, and lands its os.replace AFTER, silently
#      erases the block — a lost update. The verify then re-reads a config with
#      no dashboard block and fails, and the OLD message blamed the credentials,
#      which were never wrong. So this script now takes an flock over
#      $CONFIG_LOCK across its whole critical section, and register-mcp.sh takes
#      the SAME lock. Cooperating writers serialise; the block survives.
#
#   2. Even with the cause fixed, the CHECK must be honest. "I could not run the
#      check" (python/scrypt missing, config unreadable) and "another process
#      erased the block I just wrote" and "the password genuinely does not match
#      the hash" are three different failures with three different fixes. The
#      old check collapsed all of them — plus a truncated password file, plus a
#      missing python3 — into one exit 1 and one message that asserted the one
#      thing that is definitely true (both artefacts are correct). classify the
#      outcome instead, so the next unknown failure describes itself.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
PWFILE="$PROJECT_DIR/data/.hermes-dashboard-pw"
USERNAME="${HERMES_DASH_USERNAME:-clawbox}"
# One lock file, next to the config, shared by every ClawBox writer of
# ~/.hermes/config.yaml (this script + register-mcp.sh). A writer computes it
# from the SAME HERMES_CONFIG path it is about to touch, so both land on the
# same file without a hard-coded absolute path.
CONFIG_LOCK="${HERMES_CONFIG}.lock"

log() { echo "[hermes-dash-auth] $*"; }

# ── Serialise all writers of config.yaml ────────────────────────────────────
# Hold an exclusive flock for the LIFE of the script (fd 9, released on exit),
# so the early read, the mint, and the verify are one atomic critical section
# against the other cooperating writer (register-mcp.sh, same lock file).
# Best-effort: if flock is unavailable, or we can't get it inside the window, we
# proceed WITHOUT it rather than leave the dashboard with no auth provider — the
# honest classification below then still describes a lost write correctly if one
# happens. `flock` is util-linux and present on the Jetson image and on CI.
acquire_config_lock() {
  command -v flock >/dev/null 2>&1 || {
    log "flock unavailable — proceeding without the config lock"
    return 0
  }
  mkdir -p "$(dirname "$CONFIG_LOCK")" 2>/dev/null || true
  # Probe writability in a SUBSHELL first (its redirect is scoped, so a failure
  # can't abort the install and can't leak past this line). Only then open fd 9.
  if ! ( : > "$CONFIG_LOCK" ) 2>/dev/null; then
    log "could not create $CONFIG_LOCK — proceeding without the config lock"
    return 0
  fi
  # Open fd 9 for the LIFE of the script (that permanence is the point — the lock
  # must outlive this function). Redirections on `exec` are permanent, so this
  # line must carry NO other redirect: `exec 9>file 2>/dev/null` would silence
  # the whole script's stderr, hiding every error message below.
  exec 9>"$CONFIG_LOCK"
  flock -w 120 9 || log "could not acquire $CONFIG_LOCK within 120s — proceeding without it"
}

# ── Classify the stored (password, hash) pair ───────────────────────────────
# Returns a code that names WHICH kind of not-consistent, never a bare 1:
#   0  MATCH             the stored hash verifies the stored password
#   3  MISMATCH          hash is well-formed and scrypt ran, but pw != hash
#   4  NOT_CONFIGURED    no dashboard block, or no/!corrupt password_hash/secret
#   5  PW_MISSING        the password file is absent or empty
#   6  CONFIG_UNREADABLE config.yaml exists but could not be read (permissions)
#   7  COMPUTE_ERROR     scrypt itself could not run in this interpreter
# 127  python3 is not on PATH (the shell reports this for us)
CREDS_MATCH=0
CREDS_MISMATCH=3
CREDS_NOT_CONFIGURED=4
CREDS_PW_MISSING=5
CREDS_CONFIG_UNREADABLE=6
CREDS_COMPUTE_ERROR=7

classify_creds() {
  [ -f "$HERMES_CONFIG" ] || return "$CREDS_NOT_CONFIGURED"
  [ -s "$PWFILE" ] || return "$CREDS_PW_MISSING"
  local rc=0
  CFG="$HERMES_CONFIG" PW_PATH="$PWFILE" \
    NOT_CONFIGURED="$CREDS_NOT_CONFIGURED" PW_MISSING="$CREDS_PW_MISSING" \
    CONFIG_UNREADABLE="$CREDS_CONFIG_UNREADABLE" COMPUTE_ERROR="$CREDS_COMPUTE_ERROR" \
    MISMATCH="$CREDS_MISMATCH" \
    python3 - <<'PY' || rc=$?
import base64, hashlib, os, re, sys

NOT_CONFIGURED = int(os.environ["NOT_CONFIGURED"])
PW_MISSING = int(os.environ["PW_MISSING"])
CONFIG_UNREADABLE = int(os.environ["CONFIG_UNREADABLE"])
COMPUTE_ERROR = int(os.environ["COMPUTE_ERROR"])
MISMATCH = int(os.environ["MISMATCH"])

try:
    with open(os.environ["CFG"], "r", encoding="utf-8") as fh:
        cfg = fh.read()
except OSError:
    sys.exit(CONFIG_UNREADABLE)
try:
    with open(os.environ["PW_PATH"], "r", encoding="utf-8") as fh:
        pw = fh.read().strip()
except OSError:
    sys.exit(PW_MISSING)
if not pw:
    sys.exit(PW_MISSING)

# Pull the password_hash out of the top-level `dashboard:` block only, so an
# unrelated hash elsewhere in the config can't make us think we're configured.
block = re.search(r"(?m)^dashboard:[ \t]*\n((?:[ \t].*\n|[ \t]*\n)*)", cfg)
if not block:
    # The block is simply not here: either never written, or a concurrent
    # writer erased it. Either way there is no credential to compare against.
    sys.exit(NOT_CONFIGURED)
found = re.search(r"(?m)^\s*password_hash:\s*[\"']?([^\"'\s]+)[\"']?\s*$", block.group(1))
secret = re.search(r"(?m)^\s*secret:\s*[\"']?([^\"'\s]+)[\"']?\s*$", block.group(1))
if not found or not secret:
    sys.exit(NOT_CONFIGURED)

parts = found.group(1).split("$")
if len(parts) != 6 or parts[0] != "scrypt":
    sys.exit(NOT_CONFIGURED)
try:
    n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
    salt = base64.b64decode(parts[4])
    expected = base64.b64decode(parts[5])
except Exception:
    # A hash is present but its fields don't parse — a corrupt block, not a
    # broken environment. Treat it as "not configured" so we re-mint.
    sys.exit(NOT_CONFIGURED)
try:
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=n, r=r, p=p, dklen=len(expected), maxmem=0)
except Exception:
    # scrypt genuinely could not run here (missing OpenSSL scrypt, a memory
    # limit, a uv-managed interpreter without it). This is an ENVIRONMENT
    # failure — it says nothing about whether the stored pair is correct.
    sys.exit(COMPUTE_ERROR)

sys.exit(0 if dk == expected else MISMATCH)
PY
  return "$rc"
}

# ── Mint a fresh (password, hash, secret) and install it ────────────────────
# Returns 0 once both artefacts are on disk; 4 for an environment failure that
# stopped generation (scrypt/python), 1 for a write failure. Does NOT verify —
# the caller does that so a lost write can be told apart from a bad one.
mint_credentials() {
  mkdir -p "$(dirname "$PWFILE")"
  mkdir -p "$(dirname "$HERMES_CONFIG")"

  # A missing config is the NORMAL state on a fresh flash (config.yaml only
  # appears on the first `hermes` run) and after a factory reset (which wipes
  # ~/.hermes). Create one holding only our dashboard block: Hermes merges its
  # own defaults for everything else.
  if [ ! -f "$HERMES_CONFIG" ]; then
    log "$HERMES_CONFIG not found — creating one with just the dashboard block"
    : > "$HERMES_CONFIG"
    chmod 600 "$HERMES_CONFIG"
  fi

  # Generate password + scrypt password_hash + token-signing secret. The hash
  # format matches Hermes's plugins.dashboard_auth.basic.hash_password
  # (scrypt$n$r$p$salt_b64$dk_b64) but uses only stdlib so we don't depend on
  # the Hermes venv/plugin path.
  local gen
  if ! gen="$(python3 - <<'PY'
import secrets, base64, hashlib
pw = secrets.token_urlsafe(24)
salt = secrets.token_bytes(16)
dk = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32, maxmem=0)
h = "scrypt$%d$%d$%d$%s$%s" % (2**14, 8, 1, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())
print(pw)
print(h)
print(secrets.token_urlsafe(32))
PY
  )"; then
    log "ERROR: could not generate credentials — python3/hashlib.scrypt failed in this environment. This is NOT a credential problem." >&2
    return 4
  fi

  local pw hash secret
  pw="$(printf '%s\n' "$gen" | sed -n '1p')"
  hash="$(printf '%s\n' "$gen" | sed -n '2p')"
  secret="$(printf '%s\n' "$gen" | sed -n '3p')"
  if [ -z "$pw" ] || [ -z "$hash" ] || [ -z "$secret" ]; then
    log "ERROR: the credential generator produced empty output (environment error)." >&2
    return 4
  fi

  # Install the dashboard block FIRST, then the plaintext. If the rewrite fails
  # we return non-zero having changed nothing the proxy depends on, rather than
  # leaving a new plaintext next to an old hash.
  #
  # REPLACE, never append: a second top-level `dashboard:` key is invalid YAML
  # (and, depending on the loader, silently shadows the first). Written via a
  # temp file + rename so a crash mid-write can't truncate the config.
  if ! CFG="$HERMES_CONFIG" USERNAME="$USERNAME" HASH="$hash" SECRET="$secret" PW_PATH="$PWFILE" python3 - <<'PY'; then
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
    log "ERROR: failed to write the dashboard block to $HERMES_CONFIG" >&2
    return 1
  fi

  # config.yaml now holds the session-signing secret and the password hash.
  chmod 600 "$HERMES_CONFIG"
  for bak in "$HERMES_CONFIG".bak*; do
    [ -f "$bak" ] && chmod 600 "$bak" 2>/dev/null || true
  done

  # Store the plaintext password for the proxy ONLY (clawbox-owned, 0600).
  #
  # Same temp-file-and-rename as the config write above, for the same reason:
  # `> "$PWFILE"` truncates in place, so the proxy — which re-reads this file on
  # every session renewal — can observe an empty or partial password and answer
  # 401, and a crash between the truncate and the write leaves it empty for good
  # (classify_creds then calls that PW_MISSING). The temp file lives in the same
  # directory so the rename is atomic, and is created 0600 by umask so the
  # plaintext is never briefly world-readable.
  local pwtmp="$PWFILE.tmp.$$"
  if ! ( umask 077; printf '%s' "$pw" > "$pwtmp" ); then
    rm -f "$pwtmp" 2>/dev/null || true
    log "ERROR: failed to write $pwtmp" >&2
    return 1
  fi
  # Checked separately from the write above: folding both into one subshell
  # would let a successful chmod mask a partial printf.
  if ! chmod 600 "$pwtmp"; then
    rm -f "$pwtmp" 2>/dev/null || true
    log "ERROR: failed to set mode 600 on $pwtmp" >&2
    return 1
  fi
  if ! mv -f "$pwtmp" "$PWFILE"; then
    rm -f "$pwtmp" 2>/dev/null || true
    log "ERROR: failed to install $PWFILE" >&2
    return 1
  fi
  return 0
}

# ── Re-assert the file modes of an already-correct install ──────────────────
reassert_modes() {
  # config.yaml carries the dashboard's session-signing secret and the scrypt
  # hash; a world-readable copy lets anyone forge a session cookie.
  chmod 600 "$HERMES_CONFIG" 2>/dev/null || true
  for bak in "$HERMES_CONFIG".bak*; do
    [ -f "$bak" ] && chmod 600 "$bak" 2>/dev/null || true
  done
  chmod 600 "$PWFILE" 2>/dev/null || true
}

# ── Read-only check mode (--check) ──────────────────────────────────────────
# Report whether the dashboard auth provider is genuinely usable, without
# changing anything. This is the ONE source of truth for the invariant, reused
# by install.sh's step_validate_services so the validator and the provisioner
# agree on what "healthy" means. Exit code IS the classification (see the table
# above): 0 usable, 3 desynced, 4 not configured, 5 no password, 6/7/127 the
# check could not run. No write lock — a point-in-time read is enough, and the
# caller retries in its own loop.
if [ "${1:-}" = "--check" ] || [ "${1:-}" = "--verify" ]; then
  check_rc=0
  classify_creds || check_rc=$?
  case "$check_rc" in
    "$CREDS_MATCH")            log "check: OK — the stored password verifies against the stored password_hash" ;;
    "$CREDS_MISMATCH")         log "check: DESYNCED — the stored password does NOT match the stored password_hash" >&2 ;;
    "$CREDS_NOT_CONFIGURED")   log "check: NOT CONFIGURED — no usable dashboard.basic_auth block in $HERMES_CONFIG" >&2 ;;
    "$CREDS_PW_MISSING")       log "check: NO PASSWORD — $PWFILE is missing or empty" >&2 ;;
    "$CREDS_CONFIG_UNREADABLE")log "check: CONFIG UNREADABLE — $HERMES_CONFIG could not be read (environment error)" >&2 ;;
    "$CREDS_COMPUTE_ERROR"|127)log "check: COULD NOT RUN — python3/hashlib.scrypt unavailable (environment error, not a credential verdict)" >&2 ;;
    *)                         log "check: unexpected status $check_rc" >&2 ;;
  esac
  exit "$check_rc"
fi

# ── Main ────────────────────────────────────────────────────────────────────
acquire_config_lock

gate_rc=0
classify_creds || gate_rc=$?
case "$gate_rc" in
  "$CREDS_MATCH")
    log "already configured (stored hash verifies the stored password) — skipping"
    reassert_modes
    exit 0
    ;;
  "$CREDS_CONFIG_UNREADABLE")
    log "ERROR: $HERMES_CONFIG exists but could not be read (environment/permission error) — cannot safely (re)configure. This is NOT a credential problem." >&2
    exit 4
    ;;
  "$CREDS_COMPUTE_ERROR"|127)
    log "ERROR: could not run the credential check — python3/hashlib.scrypt is unavailable or failed in this environment. Refusing to guess; this is NOT a credential problem." >&2
    exit 4
    ;;
  *)
    # NOT_CONFIGURED / MISMATCH / PW_MISSING — the normal "(re)mint" path.
    ;;
esac

# Mint, then verify what actually landed on disk. Because config.yaml has more
# than one writer, a verify failure is classified rather than blamed on the
# credentials: the same generator wrote both artefacts moments ago, so a real
# scrypt mismatch here would be a hashing bug — while a vanished block is a lost
# write by another process. Retry the lost-write cases a few times (we hold the
# lock; a cooperating writer cannot clobber us — this only fires if flock is
# unavailable or a non-cooperating writer is racing).
attempt=0
max_attempts=3
while :; do
  attempt=$((attempt + 1))

  mint_rc=0
  mint_credentials || mint_rc=$?
  if [ "$mint_rc" -ne 0 ]; then
    # 4 = environment (already logged), 1 = write failure (already logged).
    exit "$mint_rc"
  fi
  log "wrote dashboard.basic_auth to $HERMES_CONFIG (username=$USERNAME, ttl=7d, mode 600)"
  log "wrote $PWFILE (0600)"

  verify_rc=0
  classify_creds || verify_rc=$?
  case "$verify_rc" in
    "$CREDS_MATCH")
      log "done"
      exit 0
      ;;
    "$CREDS_MISMATCH")
      log "ERROR: the password we just wrote does not verify against the password_hash we just wrote. This is a hashing fault in this script, NOT an environment problem and NOT a lost write." >&2
      exit 2
      ;;
    "$CREDS_NOT_CONFIGURED"|"$CREDS_PW_MISSING")
      if [ "$attempt" -lt "$max_attempts" ]; then
        log "WARNING: the dashboard auth block / password file we just wrote to $HERMES_CONFIG is already gone — a concurrent process rewrote the file. The credentials generated were correct; the write was lost. Retrying under $CONFIG_LOCK (attempt $attempt/$max_attempts)." >&2
        # Back off before re-minting. This branch only runs when the lock did
        # NOT hold us apart, i.e. exactly while the other writer is still inside
        # its own read-modify-write window — retrying immediately loses the same
        # race again, and all three attempts can finish before it lands its
        # os.replace. Grows with the attempt so a slow writer still gets a turn.
        sleep "$attempt"
        continue
      fi
      log "ERROR: after $attempt attempts our dashboard auth block did not survive in $HERMES_CONFIG — another process keeps rewriting the file and is not honouring $CONFIG_LOCK. This is a write/serialisation fault, NOT a credential mismatch: the password and hash were correct on every attempt." >&2
      exit 3
      ;;
    "$CREDS_CONFIG_UNREADABLE")
      log "ERROR: could not read $HERMES_CONFIG to verify what we just wrote (environment/permission error) — NOT a credential mismatch." >&2
      exit 4
      ;;
    "$CREDS_COMPUTE_ERROR"|127)
      log "ERROR: could not run the verification — python3/hashlib.scrypt is unavailable or failed. The stored password and hash may well be correct; this is an environment error, NOT a credential mismatch." >&2
      exit 4
      ;;
    *)
      log "ERROR: the credential check returned an unexpected status ($verify_rc)." >&2
      exit 1
      ;;
  esac
done
