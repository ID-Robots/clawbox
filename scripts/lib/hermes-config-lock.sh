# shellcheck shell=bash
# The mutual exclusion for ~/.hermes/config.yaml. Sourced by EVERY ClawBox
# writer of that file; not executable on its own.
#
# WHY THIS FILE EXISTS
# --------------------
# ~/.hermes/config.yaml has more than one writer, and each does an unlocked
# read-modify-write:
#
#   * scripts/setup-hermes-dashboard-auth.sh — writes the dashboard auth block.
#   * scripts/register-mcp.sh                — reconciles mcp_servers.clawbox,
#                                              and then invokes the Hermes CLI,
#                                              whose own load->save_config is a
#                                              second, wider read-modify-write.
#
# At install time they run seconds apart: install.sh's step_start_services
# restarts clawbox-setup, production-server.js fire-and-forgets register-mcp.sh,
# and step_hermes_edition runs the auth script right after. A writer that
# snapshotted the file BEFORE the auth block was written and lands its
# os.replace AFTER erases the block — a lost update. The auth script's verify
# then read a config with no block and reported a credential fault, blaming
# credentials that were provably correct.
#
# WHY A LOCK RATHER THAN ORDERING THE CALLERS
# -------------------------------------------
# Ordering the install steps would fix install time only. The same two writers
# race again on EVERY boot, from two independent systemd units:
# clawbox-setup.service (register-mcp.sh) and clawbox-hermes-dashboard.service
# (the auth script, as an ExecStartPre). There is no single caller to order
# there, so the exclusion has to live with the writers.
#
# WHY flock, AND HOW THE WRITER WE DO NOT CONTROL IS COVERED
# ----------------------------------------------------------
# flock(2) is advisory and per-open-file-description, so cooperating processes
# serialise without any support from the file format, and it is released by the
# kernel if a holder dies — no stale lock can wedge a boot. The Hermes CLI does
# NOT take this lock and cannot be made to. It does not need to: register-mcp.sh
# holds the lock ACROSS its `hermes` invocation, so the CLI only ever runs inside
# a critical section. A writer we cannot change is serialised by never letting it
# run concurrently, rather than by asking it to cooperate.
#
# WHY THE DERIVATION LIVES HERE AND NOT IN EACH SCRIPT
# ----------------------------------------------------
# It was duplicated in both writers. Mutual exclusion then held only while the
# two copies stayed byte-identical: an edit to one would silently un-serialise
# the pair, and every test would still pass. One definition, sourced twice, makes
# that impossible.
#
# Callers must set HERMES_CONFIG before sourcing. Provides:
#   CONFIG_LOCK        absolute path of the lock file
#   CONFIG_LOCK_HELD   "yes" only if an exclusive lock is genuinely held
#   acquire_config_lock

# Resolve the config path to ONE canonical spelling before deriving the lock
# from it. Two writers naming the same file differently (a symlinked home, a
# doubled slash, a `..`) would otherwise compute two different lock files and
# stop excluding each other while appearing to be locked. The directory is
# created first so readlink has something to resolve — the config itself often
# does not exist yet on a fresh flash.
_hermes_canonical_config() {
  local raw="$1" dir base resolved
  dir="$(dirname "$raw")"
  base="$(basename "$raw")"
  mkdir -p "$dir" 2>/dev/null || true
  resolved="$(readlink -f "$dir" 2>/dev/null || true)"
  [ -n "$resolved" ] && dir="$resolved"
  printf '%s/%s\n' "$dir" "$base"
}

HERMES_CONFIG_CANONICAL="$(_hermes_canonical_config "$HERMES_CONFIG")"
CONFIG_LOCK="${HERMES_CONFIG_CANONICAL}.lock"

# "yes" only after flock(1) actually reports success. Every caller that certifies
# the config to anyone else must gate that claim on this: work done without the
# lock is real work, but it is not serialised, and saying otherwise is the
# dishonesty this whole change exists to remove.
CONFIG_LOCK_HELD="no"

acquire_config_lock() {
  local label="${1:-config lock}"
  command -v flock >/dev/null 2>&1 || {
    echo "[$label] flock unavailable — proceeding WITHOUT the config lock (writes are not serialised)" >&2
    return 0
  }
  # Probe writability in a SUBSHELL first (its redirect is scoped, so a failure
  # can't abort the caller and can't leak past this line). Only then open fd 9.
  if ! ( : > "$CONFIG_LOCK" ) 2>/dev/null; then
    echo "[$label] could not create $CONFIG_LOCK — proceeding WITHOUT the config lock (writes are not serialised)" >&2
    return 0
  fi
  # Open fd 9 for the LIFE of the calling script (that permanence is the point —
  # the lock must outlive this function; the kernel drops it at exit).
  # Redirections on `exec` are permanent, so this line must carry NO other
  # redirect: `exec 9>file 2>/dev/null` would silence the whole script's stderr,
  # hiding every error message the caller prints afterwards.
  exec 9>"$CONFIG_LOCK"
  if flock -w 120 9; then
    CONFIG_LOCK_HELD="yes"
  else
    echo "[$label] could not acquire $CONFIG_LOCK within 120s — proceeding WITHOUT it (writes are not serialised)" >&2
  fi
}
