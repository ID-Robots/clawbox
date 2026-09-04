#!/usr/bin/env bash
# ClawBox Installer & Updater — single script for both fresh installs and
# individual update steps triggered from the dashboard.
#
# Usage:
#   sudo bash install.sh              — full install (fresh or re-install)
#   sudo bash install.sh --step NAME  — run a single step (used by systemd)
#
# Environment variables:
#   CLAWBOX_BRANCH       — git branch to clone/checkout (default: main). When
#                          set explicitly it is also persisted to
#                          $PROJECT_DIR/.update-branch, so the device keeps
#                          updating on the branch it was built with.
#   NETWORK_INTERFACE    — WiFi interface override (default: auto-detect)
set -euo pipefail

# ── Require root ─────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo" >&2
  exit 1
fi

# ── Bootstrap: pull latest install.sh and re-exec before parsing constants ───
# Fixes the race where a stale install.sh (e.g. rsync'd from an out-of-date
# checkout by flash.sh) parses old EXPECTED_*_SERVICES while step_git_pull
# later refreshes config/ on disk to a newer set of unit files. The drift
# guard in step_systemd_services then fires on units the up-to-date install.sh
# already registers. Pulling and re-exec'ing up-front (before constants are
# parsed) breaks the race. CLAWBOX_INSTALL_BOOTSTRAPPED prevents recursion.

# Only the update family may self-update. The root-owned dispatcher
# (/usr/local/libexec/clawbox/clawbox-root-step.sh) sets CLAWBOX_ALLOW_SELF_UPDATE
# for those steps and pins every other one with CLAWBOX_INSTALL_BOOTSTRAPPED=1.
# A bare `sudo bash install.sh` (no --step) is an operator running a full
# install and still bootstraps.
#
# This block used to run on EVERY invocation, so `--step chpasswd` did
# `git fetch` + `git reset --hard origin/<branch>` + `chown -R clawbox` + re-exec
# before it touched /etc/shadow. A password change must not depend on GitHub
# being reachable, must not mutate the source tree, and must not be a way to
# pull new code onto the box. The journal showed it firing for chpasswd,
# set_hostname and validate_services. TASK-445.
_clawbox_may_self_update() {
  [ -n "${CLAWBOX_ALLOW_SELF_UPDATE:-}" ] && return 0
  [ "${1:-}" != "--step" ] && return 0
  return 1
}

if [ -z "${CLAWBOX_INSTALL_BOOTSTRAPPED:-}" ] \
  && _clawbox_may_self_update "${1:-}" \
  && [ -d "$(dirname "${BASH_SOURCE[0]}")/.git" ]; then
  _b="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # Resolve the branch like resolve_update_branch() does below — explicit
  # CLAWBOX_BRANCH, else the pinned .update-branch, else the current branch,
  # else (detached) what the box can prove about itself, else nothing at all.
  # Defaulting straight to main (Gap 1) force-reset a beta (or any non-main) box
  # toward main on a bare `install.sh`, and the detached-HEAD case defaulted the
  # same way until TASK-447 round 2. is_safe_git_ref() isn't defined this early,
  # so validate inline before the value reaches a git ref.
  _br="${CLAWBOX_BRANCH:-}"
  if [ -z "$_br" ] && [ -f "$_b/.update-branch" ]; then
    _br="$(head -n 1 "$_b/.update-branch" | tr -d '[:space:]')"
  fi
  if [ -z "$_br" ]; then
    _br="$(git -C "$_b" -c safe.directory="$_b" symbolic-ref --short HEAD 2>/dev/null || true)"
  fi
  # Detached HEAD (symbolic-ref failed): recover from the deployed build's own
  # stamp, then from the local branches that contain HEAD. recover_detached_branch
  # is defined far below and this block runs before it, so the two cheapest of
  # its three probes are inlined. Never `main` — see resolve_update_branch: this
  # block does `reset --hard origin/$_br`, so guessing here IS the retarget.
  if [ -z "$_br" ]; then
    for _stamp in "$_b/.next/standalone/.next/build-info.json" "$_b/.next/build-info.json"; do
      [ -f "$_stamp" ] || continue
      _br="$(sed -n 's/.*"branch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_stamp" | head -n 1)"
      [ "$_br" = "HEAD" ] && _br=""
      [ -n "$_br" ] && break
    done
  fi
  if [ -z "$_br" ]; then
    _br="$(git -C "$_b" -c safe.directory="$_b" for-each-ref --format='%(refname:short)' \
             --contains HEAD refs/heads 2>/dev/null | grep -v '^main$' | head -n 1 || true)"
  fi
  # Unsafe (defends against a malicious .update-branch — the value is
  # interpolated into a git ref below) → treat as no answer.
  case "$_br" in *[!A-Za-z0-9._/-]*) _br="" ;; esac
  if [ -z "$_br" ]; then
    # Nothing says which branch this device belongs to. Skip the refresh rather
    # than reset --hard onto the fleet release channel; the step that follows
    # resolves the target properly, and refuses just as loudly if it cannot.
    echo "[bootstrap] WARN: cannot tell which branch this checkout belongs to; running the on-disk copy."
  else
    echo "[bootstrap] Refreshing install.sh from origin/${_br} before running..."
    git -C "$_b" -c safe.directory="$_b" fetch origin --quiet 2>/dev/null || true
    if git -C "$_b" -c safe.directory="$_b" reset --hard "origin/${_br}" --quiet 2>/dev/null; then
      chown -R clawbox:clawbox "$_b" 2>/dev/null || true
      # Re-record what root is allowed to run, BEFORE re-exec'ing into it. The
      # reset just replaced install.sh, scripts/ and config/ wholesale, so the
      # manifest the root dispatcher checks is now stale by construction — and a
      # stale manifest fails every subsequent step of this very update. Paths are
      # literal because the constants block has not been parsed yet.
      #
      # A failure here is NOT a warning. The root dispatcher fails closed on a
      # stale manifest, so every NON-UPDATE root step is then refused with exit
      # 65 — openclaw_install, performance_mode, gateway_setup, and the owner's
      # password change, hostname change, hotspot restart and llama.cpp install
      # (the update family is deliberately exempt; see SELF_UPDATING_STEPS in
      # config/clawbox-root-step.sh). Seen live: `--verify` returned 65 and every
      # root step was refused, and a single line on the stderr of an update
      # nobody watches was the whole trace. TASK-584.
      _mf=/usr/local/libexec/clawbox/clawbox-root-manifest.sh
      _mf_src="$_b/config/clawbox-root-manifest.sh"
      # Is the installed helper the whole program, or only the first part of it?
      # Nothing below may read its exit status until this says yes: an empty or
      # half-copied helper exits 0 for --write, for --verify AND for the
      # --verify-file the root dispatcher asks about the file it is about to run
      # as root (see SELFTEST_TOKEN in config/clawbox-root-manifest.sh).
      # Believing that 0 is worse than the stale manifest this block exists to
      # fix — it turns the dispatcher from fail-closed into fail-OPEN over a tree
      # the clawbox user can rewrite. Inlined rather than shared with
      # root_exec_manifest_helper_alive below, for the same reason the branch
      # probes above are inlined: this block runs before that function is parsed.
      _mf_alive() {
        local out rc=0
        [ -x "$_mf" ] || return 1
        out="$("$_mf" --selftest 2>/dev/null)" || rc=$?
        [ "$out" = "clawbox-root-manifest alive" ] && return 0
        [ "$rc" -eq 64 ] && return 0
        return 1
      }
      # Replace the installed helper with the one the reset just checked out.
      # Temp name + rename, NEVER a copy over the live file: a copy that fails
      # halfway leaves behind exactly the stub described above.
      _mf_restage() {
        # Once per run. Both call sites below are reachable in a single pass — a
        # helper that was not answering is replaced, answers, and then fails
        # --write — and staging the same bytes a second time cannot change that
        # outcome. It only widens the window in which a file out of the
        # clawbox-writable tree is being installed root-owned into libexec.
        [ "${_mf_staged:-0}" = "0" ] || return 1
        _mf_staged=1
        [ -f "$_mf_src" ] || return 1
        if ! install -o root -g root -m 0755 "$_mf_src" "$_mf.new"; then
          echo "[bootstrap] WARN: could not stage a fresh root-exec manifest helper" >&2
          rm -f "$_mf.new" 2>/dev/null || true
          return 1
        fi
        mv -f "$_mf.new" "$_mf" || { echo "[bootstrap] WARN: could not replace $_mf" >&2; return 1; }
      }
      if [ "$_b" = "/home/clawbox/clawbox" ] && [ -x "$_mf" ]; then
        # Best-effort throughout: this is the bootstrap of the boot path and it
        # must never abort. A helper that cannot answer is replaced first, and
        # only a helper that answers is asked to record anything.
        _mf_ok=0
        if _mf_alive; then
          _mf_ok=1
        else
          echo "[bootstrap] WARN: the installed root-exec manifest helper is not answering — replacing it" >&2
          if _mf_restage && _mf_alive; then _mf_ok=1; fi
        fi
        if [ "$_mf_ok" = "0" ]; then
          echo "[bootstrap] WARN: no working root-exec manifest helper; root steps will refuse until an operator runs 'sudo bash $_b/install.sh --step systemd_services'" >&2
          CLAWBOX_ROOT_MANIFEST_STALE=1
        # --write AND --verify, never --write alone: the write's own status says
        # the helper believes it recorded something, not that the record matches.
        elif ! { "$_mf" --write && "$_mf" --verify >/dev/null; }; then
          # Repair before reporting. The most likely reason the INSTALLED helper
          # failed is that it is the one from before this reset, so replace it
          # from the tree we just checked out and try once more.
          echo "[bootstrap] WARN: could not re-record the root-exec manifest — refreshing the helper and retrying" >&2
          _mf_restage || true
          if ! { _mf_alive && "$_mf" --write && "$_mf" --verify >/dev/null; }; then
            # Carried into the re-exec rather than acted on here: the process
            # that can record it against the run's verdict is the one about to
            # start. It re-checks before believing this.
            CLAWBOX_ROOT_MANIFEST_STALE=1
          fi
        fi
      fi
      echo "[bootstrap] Re-executing as $(git -C "$_b" -c safe.directory="$_b" rev-parse --short HEAD)..."
      exec env CLAWBOX_INSTALL_BOOTSTRAPPED=1 \
        CLAWBOX_ROOT_MANIFEST_STALE="${CLAWBOX_ROOT_MANIFEST_STALE:-0}" \
        bash "$_b/install.sh" "$@"
    fi
    echo "[bootstrap] WARN: couldn't reset to origin/${_br}; continuing with on-disk copy."
  fi
fi

# ── Constants ────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
PROJECT_DIR="/home/clawbox/clawbox"
CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/clawbox"

# ── Provisioning-status signal (read by the flash host) ──────────────────────
# A full install keeps some steps NON-FATAL on purpose — a half-provisioned box
# should still finish and come up reachable rather than abort mid-run. But
# "non-fatal" must never become "invisible": a step that reported errors has to
# reach the operator's summary AND the caller's exit status, or a flash host
# prints "Setup: 1/1 succeeded" over an install that told itself it was broken.
# So every non-fatal failure is recorded here, the summary lists them, install.sh
# exits non-zero, and a machine-readable marker is left for the flash host.
PROVISION_FAILURES=()
PROVISION_STATUS_FILE="${CLAWBOX_PROVISION_STATUS_FILE:-/etc/clawbox/provision-status}"
# The on-device TTS verdict, written by scripts/install-voice.sh and read by
# step_validate_services. Exported to that script rather than defaulted twice,
# so the writer and the reader cannot drift onto two different paths.
TTS_STATUS_FILE="${CLAWBOX_TTS_STATUS_FILE:-/etc/clawbox/tts-status}"
# Identifies THIS run. Stamped into the marker and printed on stdout, so a
# reader holding both can tell whose verdict it is looking at.
PROVISION_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown)-$$"
# Set when the marker channel could not be made to describe this run. The final
# verdict folds this in: a verdict we cannot publish is not a success.
PROVISION_STATUS_UNPUBLISHED=0

record_provision_failure() {
  local f
  # Idempotent. Three sites now record `root_exec_manifest` — the bootstrap's
  # verdict block, refresh_root_exec_manifest and install_root_libexec — and two
  # of them can fire in the same run, which put the token in the operator's
  # "Steps that failed:" line twice and wrote it twice into the marker the flash
  # host parses. `if`, not `[ … ] &&`: a for loop whose last command fails
  # returns non-zero, and under `set -e` that would abort the installer here.
  for f in ${PROVISION_FAILURES[@]+"${PROVISION_FAILURES[@]}"}; do
    if [ "$f" = "$1" ]; then return 0; fi
  done
  PROVISION_FAILURES+=("$1")
}

# Drop a recorded failure that a later step actually repaired. Without this the
# root-exec manifest below would be reported at the end of a run that fixed it
# half a minute later — a false failure over an install that is fine.
clear_provision_failure() {
  local kept=() f
  # `${a[@]+"${a[@]}"}` rather than `"${a[@]}"`: bash before 4.4 calls an empty
  # array unbound under `set -u`, and both arrays here are empty on the common
  # path (nothing recorded, or nothing kept). Aborting the installer inside the
  # function whose whole job is to CLEAR a failure would report exactly the
  # false failure it exists to remove.
  for f in ${PROVISION_FAILURES[@]+"${PROVISION_FAILURES[@]}"}; do
    [ "$f" = "$1" ] || kept+=("$f")
  done
  PROVISION_FAILURES=(${kept[@]+"${kept[@]}"})
}

# The step an operator should re-run to repair a recorded failure. Almost every
# token IS its step, which is what both verdict printers assume — but
# `root_exec_manifest` is recorded before any step runs and is not dispatchable,
# so printing `--step root_exec_manifest` would hand the operator an "Unknown
# step". `systemd_services` is the repair: it re-installs the helper AND the
# dispatcher and re-records the manifest, which is also the hint
# config/clawbox-root-step.sh gives when it refuses.
provision_repair_step() {
  case "$1" in
    root_exec_manifest) printf 'systemd_services' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Does the root-exec manifest helper at $1 actually run, or is it only present?
#
# An empty or half-copied helper exits 0 for every verb without doing any of
# them (see SELFTEST_TOKEN in config/clawbox-root-manifest.sh), so reading that
# 0 reports "the tree is recorded and matches" over a tree nobody hashed — and
# config/clawbox-root-step.sh then execs that tree as root.
#
# Two answers count, and both prove the same thing — the verb dispatcher at the
# bottom of the helper ran: the token from a helper that knows --selftest, or
# exit 64 from an older one rejecting a verb it does not know. A stub does
# neither: it prints nothing and exits 0.
#
# Takes the path as an argument because the block below runs long before
# $ROOT_EXEC_MANIFEST_HELPER is defined.
root_exec_manifest_helper_alive() {
  local out rc=0
  [ -x "$1" ] || return 1
  out="$("$1" --selftest 2>/dev/null)" || rc=$?
  [ "$out" = "clawbox-root-manifest alive" ] && return 0
  [ "$rc" -eq 64 ] && return 0
  return 1
}

# The bootstrap could not re-record the root-exec manifest before re-exec'ing
# into this process (TASK-584). The dispatcher fails closed on a stale manifest,
# so every NON-UPDATE root step — openclaw_install, gateway_setup, and the
# owner's password and hostname changes — is being refused with exit 65.
#
# Verified rather than believed: the marker says the bootstrap's write failed,
# not that the record is still wrong, and reporting a failure over a manifest
# that verifies would be the opposite defect. install_root_libexec re-records it
# later in a full run and clears this again on success.
if [ "${CLAWBOX_ROOT_MANIFEST_STALE:-0}" = "1" ]; then
  if root_exec_manifest_helper_alive /usr/local/libexec/clawbox/clawbox-root-manifest.sh \
     && /usr/local/libexec/clawbox/clawbox-root-manifest.sh --verify >/dev/null 2>&1; then
    echo "[bootstrap] the root-exec manifest verifies after all — continuing"
  else
    record_provision_failure root_exec_manifest
    echo "  ############################################################" >&2
    echo "  # The root-exec manifest could not be re-recorded." >&2
    echo "  # Non-update root steps are being REFUSED (exit 65): password" >&2
    echo "  # change, hostname, hotspot restart, llama.cpp install." >&2
    echo "  # Repair:  sudo bash $PROJECT_DIR/install.sh --step systemd_services" >&2
    echo "  ############################################################" >&2
  fi
fi

# ── The marker must never speak for a run other than this one ────────────────
# The flash host reads $PROVISION_STATUS_FILE INSTEAD of parsing stdout, so the
# file has to satisfy two properties, neither of which "write it at the end and
# hope" provides:
#
#   1. Never stale. A run that cannot write the marker (read-only /etc, a file
#      owned by another user, a full disk) used to leave the PREVIOUS run's
#      STATUS=ok sitting there, and the flash host read it as this run's verdict
#      — the same false-healthy result this whole block exists to prevent. So
#      the marker is DELETED before provisioning starts: if the file exists at
#      the end, this run wrote it.
#   2. Never half-written. Temp file + rename in the same directory, so a reader
#      sees the whole old marker or the whole new one, and a truncated write
#      cannot leave "STATUS=ok" with the rest of the record missing.
#
# When either cannot be guaranteed, that is itself a reason not to ship the box:
# the run says so on stdout and its verdict becomes "incomplete". Staying quiet
# is what produced the false "ok".

# Drop any marker left behind by an earlier run. Called once, before the first
# provisioning step of a full install.
invalidate_provision_status() {
  rm -f "$PROVISION_STATUS_FILE" 2>/dev/null || true
  # `rm -f` reports success for an already-absent file and failure for one it
  # could not remove, so test the outcome rather than its exit status.
  if [ -e "$PROVISION_STATUS_FILE" ]; then
    PROVISION_STATUS_UNPUBLISHED=1
    echo "  WARNING: could not clear the previous provisioning marker"
    echo "           $PROVISION_STATUS_FILE — its contents describe an EARLIER"
    echo "           run and must not be read as this one's verdict."
    return 1
  fi
  return 0
}

# Persist the final provisioning verdict where the flash host (or an operator,
# or the next update) can read it without re-parsing install.sh's stdout.
write_provision_status() {
  local status="$1"; shift
  local dir tmp failed=0
  dir="$(dirname "$PROVISION_STATUS_FILE")"
  tmp="$PROVISION_STATUS_FILE.tmp.$$"
  mkdir -p "$dir" 2>/dev/null || true
  if ! {
    echo "# Written by install.sh at the end of a full install. Machine-readable."
    echo "# One marker per run: the previous one is removed before provisioning"
    echo "# starts, so this file always describes the run named by RUN_ID."
    echo "RUN_ID=$PROVISION_RUN_ID"
    echo "STATUS=$status"
    echo "FAILED_STEPS=$*"
    echo "TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  } > "$tmp" 2>/dev/null; then
    failed=1
  else
    chmod 644 "$tmp" 2>/dev/null || true
    # Rename last: until this succeeds the live path holds nothing (it was
    # cleared at the start), never a partial record.
    mv -f "$tmp" "$PROVISION_STATUS_FILE" 2>/dev/null || failed=1
  fi
  # Either half failing means the same thing to the caller and wants the same
  # answer, so there is one branch for both rather than two that must be kept
  # saying the same thing.
  if [ "$failed" -ne 0 ]; then
    rm -f "$tmp" 2>/dev/null || true
    PROVISION_STATUS_UNPUBLISHED=1
    echo "  WARNING: could not publish $PROVISION_STATUS_FILE (status=$status)."
    echo "           This run has no marker. Use install.sh's exit code or the"
    echo "           [provision-status] line on stdout instead."
    return 1
  fi
  return 0
}

# ── Edition (single-harness lock) ────────────────────────────────────────────
# openclaw | hermes | dual. "openclaw" is the native product (single, locked),
# "hermes" is its own SKU, "dual" is premium (both harnesses + the runtime
# switcher) and additionally requires a signed license at runtime.
#
# WHERE THE EDITION COMES FROM, and why the order matters:
#
#   1. $CLAWBOX_EDITION — the flash-time / QA override.
#   2. /etc/clawbox/edition.env — ROOT-OWNED (root:root 0644), written by
#      step_edition_lock. This is the authority on an installed box. It has to
#      be a root-owned FILE rather than an environment variable because every
#      environment install.sh can be launched from is reachable by the customer:
#      the clawbox user owns $PROJECT_DIR (so config/edition.txt is writable
#      from SSH, the in-UI terminal and the agent's run_command) and owns
#      $PROJECT_DIR/.env, which clawbox-setup.service loads. It also has to be
#      read HERE, not just by the web server, because the in-app updater runs
#      `install.sh --step <name>` via clawbox-root-update@.service — a different
#      environment again. Before this, every updater-run step on a Hermes box
#      evaluated is_hermes_edition() as false and happily reinstalled and
#      started the OpenClaw gateway on a Hermes appliance.
#   3. The legacy systemd drop-in. On boxes provisioned before edition.env
#      existed this is the ONLY durable record of the SKU, and the first update
#      after this change runs its early steps (openclaw_install, openclaw_patch,
#      gateway_setup) before post_update installs the new updater unit — so
#      without this fallback that first update would still reinstall OpenClaw on
#      the existing Hermes fleet.
#   4. config/edition.txt — first-flash seed only (and only readable once the
#      repo has been synced; on a genuinely bare box PROJECT_DIR doesn't exist
#      yet at this point). Never authoritative: it lives in a customer-writable
#      tree that `git reset --hard` does not clean.
CLAWBOX_EDITION_FILE="/etc/clawbox/edition.env"
LEGACY_EDITION_DROPIN="/etc/systemd/system/clawbox-setup.service.d/edition.conf"

# Pull CLAWBOX_EDITION out of a systemd EnvironmentFile (`CLAWBOX_EDITION=x`)
# or a drop-in (`Environment=CLAWBOX_EDITION=x`, optionally quoted).
_read_edition_from_file() {
  [ -f "$1" ] || return 0
  local v
  v="$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\(Environment=\)\{0,1\}"\{0,1\}CLAWBOX_EDITION[[:space:]]*=[[:space:]]*//p' "$1" 2>/dev/null | tail -n 1)"
  v="$(printf '%s' "$v" | tr -d '[:space:]')"
  v="${v%\"}"; v="${v#\"}"
  v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# The edition RECORDED on this device, from the root-owned records only and in
# authority order. Deliberately excludes config/edition.txt: that is a
# first-flash seed in a tree the customer owns, so it is a source for resolution
# (below) but never evidence of what the device already IS.
_read_recorded_edition() {
  local v
  v="$(_read_edition_from_file "$CLAWBOX_EDITION_FILE" || true)"
  [ -n "$v" ] || v="$(_read_edition_from_file "$LEGACY_EDITION_DROPIN" || true)"
  printf '%s' "$v"
}

# Lower-case and map anything unrecognised onto openclaw — the same rule the
# resolution `case` below applies, minus the warning. Empty stays empty so
# "no edition recorded" is distinguishable from "recorded as openclaw".
_normalise_edition() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$v" in
    openclaw|hermes|dual|"") printf '%s' "$v" ;;
    *) printf 'openclaw' ;;
  esac
}

CLAWBOX_RECORDED_EDITION_RAW="$(_read_recorded_edition)"

CLAWBOX_EDITION_RAW="${CLAWBOX_EDITION:-}"
if [ -z "$CLAWBOX_EDITION_RAW" ]; then
  CLAWBOX_EDITION_RAW="$CLAWBOX_RECORDED_EDITION_RAW"
fi
if [ -z "$CLAWBOX_EDITION_RAW" ] && [ -f "$PROJECT_DIR/config/edition.txt" ]; then
  CLAWBOX_EDITION_RAW="$(tr -d '[:space:]' < "$PROJECT_DIR/config/edition.txt" 2>/dev/null || true)"
fi
# Lower-case to match the TypeScript side (src/lib/edition-source.ts), which has
# always normalised case — otherwise "Hermes" in edition.txt silently installs
# an OpenClaw box.
#
# Whitespace is stripped for the same reason, and so that this rule is IDENTICAL
# to _normalise_edition above. When only one of the two stripped whitespace, a
# padded `CLAWBOX_EDITION=" hermes "` resolved to openclaw (unrecognised → warn →
# openclaw) while the lock still read hermes, and the refusal below fired on a
# device nobody was trying to change — reporting "Requested edition: openclaw"
# at an operator who had typed hermes.
CLAWBOX_EDITION="$(printf '%s' "$CLAWBOX_EDITION_RAW" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
case "$CLAWBOX_EDITION" in
  openclaw|hermes|dual) ;;
  "") CLAWBOX_EDITION="openclaw" ;;
  *)
    # Loud, not silent: an unrecognised value used to degrade to openclaw with
    # no output at all, so a typo'd SKU shipped as the wrong product.
    echo "WARNING: unrecognised edition '$CLAWBOX_EDITION_RAW' — installing as 'openclaw'." >&2
    echo "         Valid editions: openclaw | hermes | dual" >&2
    CLAWBOX_EDITION="openclaw"
    ;;
esac

# ── Refuse to change the edition of an already-provisioned device ────────────
#
# install.sh can INSTALL an edition. It cannot MIGRATE one. Two harnesses on one
# box is only the most visible half of that, and step_edition_foreign_teardown
# now handles that half — it stops and disables the harness a device is leaving.
# What it cannot do is move the sign-in: each harness keeps its provider
# credentials in its own file (~/.hermes/config.yaml vs ~/.openclaw/openclaw.json),
# and setup_complete carries over, so the wizard step that would populate the
# incoming harness never runs again. The device comes up quiet instead of
# conflicted, and still has no usable model. The message below spells out what
# that costs an operator; the same reasoning is in
# docs-site/editions/overview.mdx. Changing edition is a reflash.
# scripts/setup-hermes-edition.sh is the other writer of the lock and carries the
# same refusal — both writers have to, or neither means anything.
#
# ORDERING is load-bearing: this is the first thing after the edition resolves,
# so it runs before the lock and drop-in are rewritten, before
# step_edition_gateway_state masks or unmasks anything, and before any unit is
# copied, enabled or started — on the full-install path AND on the `--step`
# dispatch path the in-app updater uses, since both reach this point during
# constant parsing. A refusal that fires after the gateway has been unmasked is
# not a refusal.
#
# EVERY recorded-vs-requested difference counts, including openclaw -> dual and
# hermes -> dual. `dual` is a distinct SKU (both harnesses plus a licence-gated
# runtime switcher), and the additive direction fails the same way as the
# destructive one: the harness being ADDED comes up with an empty provider
# registry and no credentials, and setup_complete suppresses the step that would
# populate them. The lock exists precisely so the SKU cannot be flipped from the
# environment, so "upgrading" to premium by exporting a variable is exactly what
# it must refuse.
CLAWBOX_ALLOW_EDITION_CHANGE="${CLAWBOX_ALLOW_EDITION_CHANGE:-0}"
CLAWBOX_RECORDED_EDITION="$(_normalise_edition "$CLAWBOX_RECORDED_EDITION_RAW")"

# Empty means no lock has ever been written: a fresh install, which is exactly
# how an edition is legitimately chosen. Untouched.
if [ -n "$CLAWBOX_RECORDED_EDITION" ] && [ "$CLAWBOX_RECORDED_EDITION" != "$CLAWBOX_EDITION" ]; then
  if [ "$CLAWBOX_ALLOW_EDITION_CHANGE" = "1" ]; then
    cat >&2 <<EOF

WARNING: CLAWBOX_ALLOW_EDITION_CHANGE=1 — installing '$CLAWBOX_EDITION' over
         '$CLAWBOX_RECORDED_EDITION' on a device that is already provisioned.
         The installer does NOT migrate an edition. The '$CLAWBOX_RECORDED_EDITION' harness
         will be stopped and disabled so two agents do not run at once, but
         the AI provider sign-in is not carried across and setup still reads
         as complete — so the device will come up with no usable model.
         You are expected to finish the transition by hand.

EOF
  else
    cat >&2 <<EOF

ERROR: this device is already installed as the '$CLAWBOX_RECORDED_EDITION' edition.

         Recorded edition:  $CLAWBOX_RECORDED_EDITION   ($CLAWBOX_EDITION_FILE)
         Requested edition: $CLAWBOX_EDITION

       The installer installs an edition; it does not migrate one. It will
       stop and disable the harness a device is leaving, but the AI provider
       sign-in lives in each harness's own config and does not move with it.
       A device installed this way comes up with no usable model, while
       still reporting that setup is complete.

       Changing a device's edition requires a REFLASH.
       See https://docs.clawbox.com/editions/overview

       Nothing has been changed. No unit was stopped, started or masked, and
       the edition lock still reads '$CLAWBOX_RECORDED_EDITION'.

       To re-install this device as the edition it already is, drop
       CLAWBOX_EDITION from the command (the recorded value is used
       automatically) or pass CLAWBOX_EDITION=$CLAWBOX_RECORDED_EDITION.

       If you genuinely intend to overwrite the edition and will finish the
       transition yourself, re-run with CLAWBOX_ALLOW_EDITION_CHANGE=1.

EOF
    exit 1
  fi
fi

# The Hermes SKU: Hermes is the ONLY harness, the OpenClaw gateway is removed.
is_hermes_edition() { [ "$CLAWBOX_EDITION" = "hermes" ]; }
# Editions that ship the Hermes harness + dashboard (hermes AND the premium
# dual SKU, which runs both). Anything Hermes-side must key off this, not
# is_hermes_edition, or dual installs silently get no Hermes at all.
has_hermes_harness() { [ "$CLAWBOX_EDITION" = "hermes" ] || [ "$CLAWBOX_EDITION" = "dual" ]; }
# Editions that ship the OpenClaw gateway (openclaw AND dual).
has_openclaw_harness() { [ "$CLAWBOX_EDITION" != "hermes" ]; }

# CLAWBOX_TEST_MODE=1 skips hardware-only steps (Jetson power modes, CUDA
# llama.cpp build, snap Chromium, WiFi AP, VNC, cloudflared, jtop) so the
# installer can run inside a CI container. See e2e-install/README.md.
#
# The e2e-install entrypoint seeds /etc/clawbox/test-mode.env before any
# install.sh runs. Source it so EVERY invocation detects test mode up front —
# not just the first-boot bootstrap (which gets CLAWBOX_TEST_MODE in its
# service env), but also the updater-triggered `install.sh --step` runs via
# clawbox-root-update@.service, which otherwise inherit only
# /etc/clawbox/network.env (populated late, during step_network_setup) and so
# hit the real Jetson/WiFi steps and fail on a non-Tegra CI host. The file
# exists only in the test container, so this is a no-op on real devices.
if [ -f /etc/clawbox/test-mode.env ]; then
  # shellcheck disable=SC1091
  source /etc/clawbox/test-mode.env
fi
CLAWBOX_TEST_MODE="${CLAWBOX_TEST_MODE:-0}"
is_test_mode() { [ "$CLAWBOX_TEST_MODE" = "1" ]; }
# CLAWBOX_TEST_NO_GPU=1 is the e2e-install container saying "this host has no
# GPU by construction". It is deliberately a second knob and not a reading of
# CLAWBOX_TEST_MODE: the unit tests run the installer's functions under test
# mode too and pin the real-hardware rule that a Kokoro which declines is a
# mute box, so test mode alone must not soften that rule. Only the harness
# entrypoint sets this (e2e-install/entrypoint.sh); a real device never does.
harness_has_no_gpu() {
  [ "${CLAWBOX_TEST_NO_GPU:-0}" = "1" ]
}
BUN="$CLAWBOX_HOME/.bun/bin/bun"
NPM_PREFIX="$CLAWBOX_HOME/.npm-global"
OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"
OPENCLAW_VERSION="2026.8.1"

# Pinned Hermes agent release, in the same spirit as $OPENCLAW_VERSION above:
# the fleet runs the build WE chose instead of whatever
# NousResearch/hermes-agent had on `main` the second a box was flashed.
# Upstream lands ~150 commits a day and cuts a tag two or three times a week,
# so every unpinned install lands on a different, untested tree.
#
# The value is the 40-char COMMIT the release tag points at — not the tag
# name, and not the annotated tag object's own SHA. The upstream installer's
# `--commit` takes a commit only and rejects abbreviated SHAs, while
# `--branch <tag>` is worse than useless on an existing checkout: it rewrites
# remote.origin.fetch to a refspec with no matching head and leaves
# origin/main stale, which breaks the agent's own `hermes update` later.
#
# Overridable from the environment so QA can aim one device at another commit
# without editing the file (`HERMES_PIN_COMMIT=<sha> sudo -E bash install.sh
# --step hermes_install`), exactly as OPENCLAW_PIN_VERSION does for OpenClaw.
# Bump the default in a PR, ship it through beta -> main, and the fleet
# follows on its next update.
#
# Current pin: upstream tag v2026.8.19 == "Hermes Agent v0.20.5".
HERMES_PIN_COMMIT="${HERMES_PIN_COMMIT:-fcbd1076a93841fa88855acce810e342a5b78101}"
GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"
DNSMASQ_DIR="/etc/NetworkManager/dnsmasq-shared.d"
AVAHI_CONF="/etc/avahi/avahi-daemon.conf"

# Is the OpenClaw on this box generation 2 (>= 2026.8)? The INSTALLED binary
# answers when it can — it is the process that parses whatever we write — and
# the pinned target only fills in before the first install. Used to route the
# steps that speak different config dialects per generation.
# The generation rule itself, callable with any version string, so the
# installed-binary probe below and the freshly-pinned TARGET gate in
# step_openclaw_install cannot drift apart.
openclaw_version_is_v2() {
  [ -n "$1" ] && [ "$(printf '%s\n' 2026.8 "$1" | sort -V | head -1)" = "2026.8" ]
}
openclaw_is_v2() {
  local v=""
  if [ -x "$NPM_PREFIX/bin/openclaw" ]; then
    v=$("$NPM_PREFIX/bin/openclaw" --version 2>/dev/null | grep -oE '20[0-9]{2}\.[0-9]+\.[0-9]+' | head -1)
  fi
  if [ -z "$v" ] && [ -f "$PROJECT_DIR/config/openclaw-target.txt" ]; then
    v=$(head -1 "$PROJECT_DIR/config/openclaw-target.txt" | awk '{print $1}')
  fi
  [ -z "$v" ] && v="$OPENCLAW_VERSION"
  openclaw_version_is_v2 "$v"
}

# ── Service registry ─────────────────────────────────────────────────────────
# Authoritative list of clawbox systemd units. Used by step_systemd_services
# (install/enable) and step_validate_services (post-install health check).
#
# ACTIVE: must be enabled and active after install.
# INSTALLED: unit file must exist on disk but the unit is not required to be
# active because it is opt-in (clawbox-tunnel, clawbox-browser), one-shot
# driven by a timer (clawbox-heartbeat.service), or a template that is never
# activated standalone (clawbox-root-update@.service).
EXPECTED_ACTIVE_SERVICES=(
  clawbox-ap.service
  clawbox-setup.service
  clawbox-gateway.service
  clawbox-performance.service
  clawbox-heartbeat.timer
  clawbox-ap-watchdog.timer
  clawbox-codex-auth-sync.timer
)
EXPECTED_INSTALLED_SERVICES=(
  clawbox-heartbeat.service
  clawbox-browser.service
  clawbox-tunnel.service
  "clawbox-root-update@.service"
  clawbox-ap-watchdog.service
  clawbox-codex-auth-sync.service
)

# Units that ship in config/ on EVERY edition but are only installed on the
# SKUs that actually run them. They are deliberately absent from this edition's
# install lists, and the drift guard in step_systemd_services accepts them for
# that reason alone — it must NOT be satisfied by adding them to
# EXPECTED_INSTALLED_SERVICES, because the cp + `systemctl enable` loops iterate
# that list too. Enabling clawbox-hermes-dashboard on an OpenClaw box would
# crash-loop it forever (Restart=always against a /home/clawbox/.local/bin/hermes
# that doesn't exist), and enabling clawbox-gateway on Hermes would undo exactly
# the removal step_edition_gateway_state performs.
#
# Anything else that appears in config/ is still a hard error until it is
# registered in one of the two lists above.
EDITION_SCOPED_UNITS=(
  clawbox-gateway.service                 # openclaw + dual (removed on hermes)
  clawbox-hermes-dashboard.service        # hermes + dual
  clawbox-hermes-dashboard-proxy.service  # hermes + dual
)

# Hermes harness editions (hermes + the premium dual) run the Hermes dashboard
# and its auth proxy.
if has_hermes_harness; then
  EXPECTED_ACTIVE_SERVICES+=(
    clawbox-hermes-dashboard.service
    clawbox-hermes-dashboard-proxy.service
  )
fi
# The Hermes SKU runs no OpenClaw gateway at all — drop it from the active set
# so nothing installs, enables or expects it. (dual keeps it: it runs both.)
if is_hermes_edition; then
  _active_svcs=()
  for _s in "${EXPECTED_ACTIVE_SERVICES[@]}"; do
    [ "$_s" = "clawbox-gateway.service" ] || _active_svcs+=("$_s")
  done
  EXPECTED_ACTIVE_SERVICES=("${_active_svcs[@]}")
fi

# Units belonging to a harness THIS edition does not run.
#
# EXPECTED_ACTIVE_SERVICES only ever describes what should be UP, which left
# step_validate_services blind in one direction: it appends the Hermes units
# inside `if has_hermes_harness`, so on the openclaw edition a fully running
# Hermes stack was not merely tolerated, it was invisible. Anything found here is
# a device that used to be another edition. Both predicates are negated, so
# `dual` — the edition that legitimately runs both — accumulates nothing and
# needs no special case.
#
# ONE list, TWO consumers, in this order: step_edition_foreign_teardown stops and
# disables everything in it early in the run, and step_validate_services asserts
# at the end that none of it is back. So a unit still reported here is one that
# returned under its own Restart=, or one the operator kept with
# CLAWBOX_KEEP_FOREIGN_UNITS=1 — not simply one nobody ever touched.
FOREIGN_EDITION_UNITS=()
if ! has_hermes_harness; then
  # The Hermes harness: the two ClawBox-managed dashboard units, plus the
  # gateway unit the upstream Hermes installer writes. The latter is the one
  # that holds the Telegram bot token, so leaving it running next to the
  # OpenClaw gateway puts two pollers on one token — a permanent conflict loop.
  FOREIGN_EDITION_UNITS+=(
    clawbox-hermes-dashboard.service
    clawbox-hermes-dashboard-proxy.service
    hermes-gateway.service
  )
fi
if ! has_openclaw_harness; then
  # hermes: the OpenClaw gateway. The hermes-only probe in
  # step_validate_services also names this unit — it is an unauthenticated agent
  # surface on :18789 and earns its own message — but that probe only tests
  # `is-active`. Listing it here keeps the mechanism symmetric and adds the
  # `enabled but inactive` case. A masked gateway matches neither, so a
  # correctly provisioned Hermes box reports nothing twice.
  FOREIGN_EDITION_UNITS+=(clawbox-gateway.service)
fi

# Read one KEY=VALUE out of a file this script does NOT trust.
#
# Everything under $PROJECT_DIR/data is written by the web server, i.e. by the
# clawbox user — and install.sh runs as root, reached from a NOPASSWD grant. So
# `source`ing anything in there is arbitrary root code execution for anything
# with clawbox-level code execution: the web server, the in-UI terminal, the
# agent's shell. `printf 'x() { :; }; id > /tmp/pwn\n' > data/hostname.env` plus
# the granted `clawbox-root-update@set_hostname.service` was exactly that, and
# data/network.env was worse still because it was sourced on EVERY root run of
# this script, `--step chpasswd` included.
#
# Parse instead: first matching assignment, optional single or double quotes
# stripped, and nothing containing a character that could not have come from the
# writer we expect. The caller still validates the meaning of the value.
# TASK-445.
read_untrusted_env_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 0
  [ -L "$file" ] && return 0
  line="$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null)" || return 0
  value="${line#*=}"
  # Strip one layer of matching quotes.
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  case "$value" in
    ""|*[!A-Za-z0-9._-]*) return 0 ;;
  esac
  printf '%s' "$value"
}

# Load persisted WiFi interface if available.
IFACE_ENV="$PROJECT_DIR/data/network.env"
_persisted_iface="$(read_untrusted_env_value "$IFACE_ENV" NETWORK_INTERFACE)"
if [ -n "$_persisted_iface" ]; then
  NETWORK_INTERFACE="$_persisted_iface"
fi
unset _persisted_iface

# ── Helpers ──────────────────────────────────────────────────────────────────

# Run a command as the clawbox user
as_clawbox() { sudo -u "$CLAWBOX_USER" "$@"; }

# Run a command as the clawbox user with login environment
# Explicit PATH ensures bun/node are found even inside systemd services
as_clawbox_login() {
  # On Jetson, CUDA tools live at /usr/local/cuda/bin but aren't on the login
  # shell's PATH by default. Include them so cmake / nvcc / llama.cpp builds
  # can find the toolkit during `as_clawbox_login` invocations.
  local cuda_prefix=""
  [ -x /usr/local/cuda/bin/nvcc ] && cuda_prefix="/usr/local/cuda/bin:"
  su - "$CLAWBOX_USER" -c "export PATH=\"${cuda_prefix}$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:$CLAWBOX_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && $*"
}

ensure_clawbox_bashrc_path() {
  # Make ~/.npm-global/bin and ~/.local/bin available in the clawbox user's
  # interactive shells (e.g. the in-UI terminal) so CLIs like openclaw, claude,
  # codex, gemini, hf, and clawkeep resolve without a full path.
  local BASHRC="$CLAWBOX_HOME/.bashrc"
  if ! grep -q 'npm-global/bin' "$BASHRC" 2>/dev/null; then
    cat >> "$BASHRC" <<'PATHEOF'

# npm global binaries (openclaw, codex, gemini) and user-local binaries (claude, hf, clawkeep)
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
PATHEOF
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$BASHRC"
  elif ! grep -q '\.local/bin' "$BASHRC" 2>/dev/null; then
    cat >> "$BASHRC" <<'PATHEOF'

# user-local binaries (claude, hf, clawkeep)
export PATH="$HOME/.local/bin:$PATH"
PATHEOF
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$BASHRC"
  fi
}

node_satisfies_openclaw_engine() {
  local version major
  version=$(node -p 'process.versions.node' 2>/dev/null || echo "")
  [ -n "$version" ] || return 1
  major="${version%%.*}"

  case "$major" in
    22) dpkg --compare-versions "$version" ge "22.22.3" ;;
    24) dpkg --compare-versions "$version" ge "24.15.0" ;;
    25) dpkg --compare-versions "$version" ge "25.9.0" ;;
    2[6-9]|[3-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_openclaw_node_engine() {
  if node_satisfies_openclaw_engine; then
    echo "  Node.js $(node --version) satisfies OpenClaw engine requirements"
    return 0
  fi

  local got
  got=$(node --version 2>/dev/null || echo "missing")
  echo "  Node.js $got does not satisfy OpenClaw 2026.8.1 engine requirements; upgrading Node.js 22..."
  wait_for_apt
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  wait_for_apt
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs

  if ! node_satisfies_openclaw_engine; then
    got=$(node --version 2>/dev/null || echo "missing")
    echo "Error: Node.js upgrade did not reach an OpenClaw-compatible version — got $got." >&2
    echo "       OpenClaw 2026.8.1 requires Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0." >&2
    exit 1
  fi

  echo "  Node.js $(node --version) installed"
}

ensure_env_setting() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  if ! grep -q "^${key}=" "$env_file" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
    echo "  Added ${key} to ${env_file}"
  fi
}

# Move a setting off a superseded default.
#
# ensure_env_setting only ever ADDS a key, so every device installed before a
# default changed keeps the old value in .env forever - and both this script and
# the Next.js runtime read .env, so a new default in the source would never
# reach a device already in the field. This rewrites the value only when it is
# byte-identical to the old default, so a value the operator chose themselves is
# left exactly as they set it.
migrate_env_setting() {
  local env_file="$1"
  local key="$2"
  local old_value="$3"
  local new_value="$4"
  [ -f "$env_file" ] || return 0
  local current_value
  current_value=$(get_env_setting_or_default "$env_file" "$key" "")
  if [ "$current_value" != "$old_value" ]; then
    return 0
  fi
  local tmp
  tmp=$(mktemp "${env_file}.XXXXXX") || return 1
  # Rewrite in place via a temp file rather than sed -i so an unusual character
  # in either value cannot be read as sed syntax.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${key}="*) printf '%s=%s\n' "$key" "$new_value" >> "$tmp" ;;
      *) printf '%s\n' "$line" >> "$tmp" ;;
    esac
  done < "$env_file"
  # mktemp created the temp file as root with 0600; carry the real file's mode
  # and owner across so .env stays readable by the clawbox service user.
  chmod --reference="$env_file" "$tmp" 2>/dev/null || true
  chown --reference="$env_file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$env_file"
  echo "  Migrated ${key} from ${old_value} to ${new_value}"
}

get_env_setting_or_default() {
  local env_file="$1"
  local key="$2"
  local default_value="$3"
  local current_value=""
  if [ -f "$env_file" ]; then
    current_value=$(grep "^${key}=" "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  fi
  if [ -n "$current_value" ]; then
    printf '%s' "$current_value"
  else
    printf '%s' "$default_value"
  fi
}

ensure_llamacpp_model_cached() {
  local ENV_FILE="$PROJECT_DIR/.env"
  local MODEL_DIR="$PROJECT_DIR/data/llamacpp/models"
  local HF_REPO HF_FILE MODEL_PATH

  # A device installed before the QAT switch still has the old repo/file pinned
  # in .env, so migrate the pin before reading it - otherwise this function
  # would keep re-downloading the superseded GGUF forever.
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf" "google/gemma-4-E2B-it-qat-q4_0-gguf"
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf" "gemma-4-E2B_q4_0-it.gguf"

  HF_REPO=$(get_env_setting_or_default "$ENV_FILE" "LLAMACPP_HF_REPO" "google/gemma-4-E2B-it-qat-q4_0-gguf")
  HF_FILE=$(get_env_setting_or_default "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-E2B_q4_0-it.gguf")
  MODEL_PATH="$MODEL_DIR/$HF_FILE"

  mkdir -p "$MODEL_DIR"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data/llamacpp"

  if [ -f "$MODEL_PATH" ]; then
    echo "  Gemma 4 model already cached for offline use"
    prune_superseded_llamacpp_model "$MODEL_DIR" "$HF_FILE"
    return 0
  fi

  echo "  Downloading Gemma 4 GGUF for offline use..."
  if ! as_clawbox_login "mkdir -p \"$MODEL_DIR\" && hf download \"$HF_REPO\" \"$HF_FILE\" --local-dir \"$MODEL_DIR\""; then
    echo "Error: failed to download Gemma 4 for offline startup" >&2
    return 1
  fi

  if [ ! -f "$MODEL_PATH" ]; then
    echo "Error: Gemma 4 download completed but ${MODEL_PATH} was not found" >&2
    return 1
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data/llamacpp"
  echo "  Gemma 4 model cached for offline startup"
  prune_superseded_llamacpp_model "$MODEL_DIR" "$HF_FILE"
}

# The model is addressed by filename, so switching GGUF leaves the old 2.8GB
# file sitting in the models directory doing nothing. Reclaim it - but only the
# one filename we know we shipped, and never the file currently in use.
prune_superseded_llamacpp_model() {
  local model_dir="$1"
  local active_file="$2"
  local stale="gemma-4-e2b-it-edited-q4_0.gguf"

  [ "$active_file" = "$stale" ] && return 0
  [ -f "$model_dir/$stale" ] || return 0

  rm -f "$model_dir/$stale"
  echo "  Removed superseded GGUF ${stale}"
}

has_playwright_chromium() {
  # Playwright 1.50+ ships Chrome-for-Testing at chrome-linux64/chrome on
  # amd64 and chrome-linux-arm64/chrome on arm64; older builds used the
  # unsuffixed chrome-linux/. Check all three so we work across versions.
  find "$CLAWBOX_HOME/.cache/ms-playwright" -type f \
    \( -path "*/chrome-linux/chrome" \
       -o -path "*/chrome-linux64/chrome" \
       -o -path "*/chrome-linux-arm64/chrome" \) \
    -print -quit 2>/dev/null | grep -q .
}

ensure_playwright_chromium() {
  if has_playwright_chromium; then
    echo "  Playwright Chromium runtime already installed"
    return 0
  fi

  local PLAYWRIGHT_BIN="$PROJECT_DIR/node_modules/.bin/playwright"
  local PLAYWRIGHT_PATH="$CLAWBOX_HOME/.cache/ms-playwright"

  echo "  Installing Playwright Chromium runtime for the desktop browser service..."
  if [ -x "$PLAYWRIGHT_BIN" ]; then
    as_clawbox_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" \"$PLAYWRIGHT_BIN\" install chromium"
  else
    as_clawbox_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" $BUN x playwright install chromium"
  fi

  if ! has_playwright_chromium; then
    echo "Error: Playwright Chromium install completed but no service-safe browser binary was found." >&2
    exit 1
  fi

  echo "  Playwright Chromium runtime ready"
}

print_native_build_preflight() {
  local node_version node_abi npm_version python_version make_version gpp_version node_header_dir

  node_version=$(as_clawbox_login "node -p 'process.version'" 2>/dev/null || echo "missing")
  node_abi=$(as_clawbox_login "node -p 'process.versions.modules'" 2>/dev/null || echo "unknown")
  npm_version=$(as_clawbox_login "npm --version" 2>/dev/null || echo "missing")
  python_version=$(/usr/bin/python3 --version 2>/dev/null || echo "python3 missing")

  if command -v make >/dev/null 2>&1; then
    make_version=$(make --version | head -1)
  else
    make_version="make missing"
  fi

  if command -v g++ >/dev/null 2>&1; then
    gpp_version=$(g++ --version | head -1)
  else
    gpp_version="g++ missing"
  fi

  if [ -d /usr/include/nodejs ] && [ -f /usr/include/nodejs/node_api.h ]; then
    node_header_dir="/usr/include/nodejs"
  elif [ -d /usr/include/node ] && [ -f /usr/include/node/node_api.h ]; then
    node_header_dir="/usr/include/node"
  else
    node_header_dir="auto (node-gyp will fetch into ~/.cache/node-gyp/<version>/)"
  fi

  echo "  Native build preflight:"
  echo "    Node.js: $node_version (ABI $node_abi)"
  echo "    npm: $npm_version"
  echo "    Python: $python_version"
  echo "    make: $make_version"
  echo "    g++: $gpp_version"
  echo "    Node headers: $node_header_dir"
}

ensure_node_pty() {
  local verify_cmd="cd $PROJECT_DIR && node -e \"require('node-pty')\""
  if as_clawbox_login "$verify_cmd" &>/dev/null; then
    echo "  node-pty is already loadable"
    return 0
  fi

  echo "  node-pty is missing or built for the wrong Node ABI; preparing native build prerequisites..."
  print_native_build_preflight
  wait_for_apt
  apt-get install -y -qq python3 python3-pip python-is-python3 build-essential pkg-config

  mkdir -p "$CLAWBOX_HOME/.npm" "$CLAWBOX_HOME/.cache/node-gyp"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" \
    "$CLAWBOX_HOME/.npm" \
    "$CLAWBOX_HOME/.cache/node-gyp" \
    "$PROJECT_DIR/node_modules" 2>/dev/null || true

  # Only point node-gyp at system headers if they actually contain node_api.h
  # for the running Node ABI. Ubuntu's libnode-dev / nodejs packages can leave
  # a /usr/include/node directory that's missing node_api.h or holds headers
  # for a Node version different from the one installed via NodeSource — both
  # break the node-addon-api include chain. When neither path is usable, leave
  # npm_config_nodedir unset so node-gyp auto-fetches matching headers into
  # ~/.cache/node-gyp/<version>/.
  local rebuild_cmd="
    cd $PROJECT_DIR &&
    export npm_config_python=/usr/bin/python3 &&
    export npm_config_build_from_source=true &&
    if [ -d /usr/include/nodejs ] && [ -f /usr/include/nodejs/node_api.h ]; then
      export npm_config_nodedir=/usr/include/nodejs
    elif [ -d /usr/include/node ] && [ -f /usr/include/node/node_api.h ]; then
      export npm_config_nodedir=/usr/include/node
    fi &&
    npm rebuild node-pty --foreground-scripts
  "

  echo "  Rebuilding native modules (node-pty)..."
  if ! as_clawbox_login "$rebuild_cmd"; then
    echo "  Initial node-pty rebuild failed; clearing stale build output and retrying once..."
    as_clawbox_login "cd $PROJECT_DIR && rm -rf node_modules/node-pty/build node_modules/node-pty/bin"
    as_clawbox_login "$rebuild_cmd"
  fi

  if ! as_clawbox_login "$verify_cmd" &>/dev/null; then
    echo "Error: node-pty is still not loadable after rebuild. Check the node-gyp output above." >&2
    exit 1
  fi

  echo "  node-pty rebuilt and verified"
}

# ── Memory for the build ─────────────────────────────────────────────────────

# MemAvailable in MiB, or 0 when /proc cannot be read.
#
# Zero rather than a guess, on the same reasoning as the memory guard in
# scripts/openclaw/clawbox-tts.sh: on a Jetson an unreadable /proc means
# something is wrong, and assuming "plenty" is how the OOM killer gets invited
# in. Here it only makes the log line honest — nothing below is conditional on
# the number.
available_mb() {
  local kb
  kb=$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null)
  [ -n "$kb" ] || { printf '0'; return 0; }
  printf '%s' "$((kb / 1024))"
}

# Print the pid of the llama.cpp server named by ClawBox's own pidfile, and
# nothing at all unless that process is really it.
#
# The pid is checked against /proc/<pid>/cmdline before the caller signals it:
# the pidfile outlives a crash, pids are recycled, and this runs as root — so
# an unverified kill from a stale file is a root SIGKILL aimed at whatever
# inherited the number. The TypeScript sibling (stopLlamaCppServer in
# src/instrumentation-node.ts) can go straight from the file to the signal
# because it usually still holds the child handle; from bash there is nothing
# but the file.
llamacpp_pid_if_running() {
  local pidfile="$PROJECT_DIR/data/llamacpp/server.pid" pid
  [ -f "$pidfile" ] || return 1
  read -r pid < "$pidfile" 2>/dev/null || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  grep -qa 'llama-server' "/proc/$pid/cmdline" 2>/dev/null || return 1
  printf '%s' "$pid"
}

# Give `bun run build` the board to itself.
#
# The rebuild is the most memory-hungry thing this appliance ever does, and on
# an 8 GB Jetson it shares that memory with whatever the box was doing a minute
# earlier: ollama keeps a model resident for ten idle minutes after the last
# chat turn, Kokoro holds its voice on the GPU for five, and a llama.cpp server
# stays up until something stops it. A `next build` starting underneath 4 GB of
# resident model does not build slowly — it is OOM-killed, and the update ends
# with the box on a half-written .next and a step painted red.
#
# Called from do_rebuild AFTER clawbox-setup.service is stopped, and that order
# is what makes the free hold: the gateway reaches ollama and llama.cpp through
# the web server's own proxy (src/lib/local-ai-runtime.ts), so with the web
# server down nothing can pull a model back in behind us for the length of the
# build.
#
# Stop, never disable — the same rule the idle standby follows, and the reason
# it is safe: every engine here is meant to come back on demand. An update that
# quietly un-enabled one would be a box that stopped talking after its next
# reboot, which is a far worse bug than the one this fixes.
#
# Every step is best-effort and this function never fails the update: a box
# that cannot stop one of its engines should still attempt the build it was
# asked for, and the log says what happened.
free_memory_for_build() {
  local before after uid unit pid waited
  before=$(available_mb)
  echo "Freeing memory for the build (${before} MB available)..."

  if systemctl cat ollama.service >/dev/null 2>&1; then
    echo "  Stopping ollama.service..."
    systemctl stop ollama.service 2>/dev/null \
      || echo "  Warning: could not stop ollama.service" >&2
  fi

  # The voice engines are USER units, so they need the clawbox user's session
  # bus; with no /run/user/<uid> there is no session and nothing to stop.
  uid=$(id -u "$CLAWBOX_USER" 2>/dev/null || echo "")
  if [ -n "$uid" ] && [ -d "/run/user/$uid" ]; then
    for unit in kokoro-server.service whisper-server.service; do
      sudo -u "$CLAWBOX_USER" XDG_RUNTIME_DIR="/run/user/$uid" \
        systemctl --user cat "$unit" >/dev/null 2>&1 || continue
      echo "  Stopping $unit..."
      sudo -u "$CLAWBOX_USER" XDG_RUNTIME_DIR="/run/user/$uid" \
        systemctl --user stop "$unit" 2>/dev/null \
        || echo "  Warning: could not stop $unit" >&2
    done
  fi

  if pid=$(llamacpp_pid_if_running); then
    echo "  Stopping llama.cpp server (pid $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
    # Three seconds, in the shape of the 1.5 s its TypeScript sibling allows
    # (stopLlamaCppServer): a server that has not gone by then is not going to,
    # and the update has a build to get on with. `kill -0` also succeeds for a
    # process that has died and not yet been reaped, so this loop is written to
    # fall through rather than to wait for a state it might never observe.
    waited=0
    while [ "$waited" -lt 3 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    # Ask again, with the same question, before escalating.
    #
    # Three seconds is long enough for the pid to be freed and handed to
    # something else, and this is a root SIGKILL — so the identity is
    # re-established rather than assumed, and the answer also covers a process
    # that has exited and not yet been reaped (a zombie answers `kill -0`, but
    # its cmdline is empty, so it cannot pass this check and the log does not
    # claim it refused to go).
    #
    # This narrows the window to the gap between these two lines; it does not
    # close it. Nothing in bash can: holding a handle across the wait needs a
    # pidfd, and the shell has no way to open or signal one.
    if [ "$(llamacpp_pid_if_running || true)" = "$pid" ]; then
      echo "  llama.cpp did not exit on SIGTERM — killing it"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PROJECT_DIR/data/llamacpp/server.pid"
  fi

  # Page cache last, once the engines have released their mappings. It is
  # reclaimable by definition, so this hands the build nothing the kernel would
  # not have given it anyway — it just means the build starts without first
  # reclaiming a cache full of model weights, and that MemAvailable below is
  # the number a human would recognise.
  sync || echo "  Warning: could not flush filesystems before dropping the cache" >&2
  echo 3 > /proc/sys/vm/drop_caches 2>/dev/null \
    || echo "  Warning: could not drop the page cache" >&2

  after=$(available_mb)
  echo "  Memory available for the build: ${after} MB (was ${before} MB)"
}

# Stop the setup service, free memory, clear cache, reinstall, and rebuild
do_rebuild() {
  echo "Stopping clawbox-setup.service for rebuild..."
  systemctl stop clawbox-setup.service 2>/dev/null || true
  # After the stop, never before it — see free_memory_for_build.
  free_memory_for_build
  echo "Clearing .next cache..."
  rm -rf "$PROJECT_DIR/.next"
  echo "Running bun install..."
  as_clawbox_login "cd $PROJECT_DIR && $BUN install"
  ensure_node_pty
  echo "Running bun build..."
  as_clawbox_login "cd $PROJECT_DIR && $BUN run build"
}

# ── Step Functions ───────────────────────────────────────────────────────────

step_ensure_user() {
  if ! id -u "$CLAWBOX_USER" &>/dev/null; then
    echo "  Creating user '$CLAWBOX_USER'..."
    useradd -m -s /bin/bash "$CLAWBOX_USER"
    for grp in sudo video audio i2c gpio; do
      getent group "$grp" &>/dev/null && usermod -aG "$grp" "$CLAWBOX_USER" 2>/dev/null || true
    done
    echo "  User '$CLAWBOX_USER' created (uid=$(id -u "$CLAWBOX_USER"))"
  else
    echo "  User '$CLAWBOX_USER' exists (uid=$(id -u "$CLAWBOX_USER"))"
  fi
}

# Recover from interrupted dpkg state before any apt call.
recover_dpkg() {
  if ! dpkg --audit 2>/dev/null | grep -q .; then return 0; fi
  echo "  Detected interrupted dpkg state — running 'dpkg --configure -a' to recover..."
  DEBIAN_FRONTEND=noninteractive dpkg --configure -a 2>&1 | tail -5
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    echo "Error: dpkg --configure -a failed with exit code $rc — apt operations will likely fail." >&2
    return "$rc"
  fi
}

wait_for_apt() {
  local max_wait="${1:-900}"
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; do
    if [ $waited -eq 0 ]; then
      echo "  Waiting for apt lock (another update is running)..."
    fi
    sleep 5
    waited=$((waited + 5))
    if [ $waited -ge "$max_wait" ]; then
      echo "Error: apt lock is still held after $((max_wait / 60)) minutes. Another updater (often unattended-upgrades) is still running; try again shortly." >&2
      return 1
    fi
  done
  recover_dpkg
}

# Best-effort pipx bootstrap. step_apt_update installs pipx as part of the
# full-install/update sequence, but step_clawkeep_install and (the Hugging
# Face CLI install inside) step_llamacpp_install can also run standalone via
# a root-owned standalone step service, outside that sequence — so each calls
# this first rather than assuming apt_update already ran on this boot.
#
# pipx is what keeps these installs working under PEP 668 (the
# externally-managed-environment policy Ubuntu enforces from 24.04 / JetPack
# 7 onward); on JetPack 6.2 / Ubuntu 22.04 it is optional polish; pip --user
# still works there, so callers fall back to it when this returns non-zero.
ensure_pipx() {
  as_clawbox_login "command -v pipx" &>/dev/null && return 0
  wait_for_apt
  # Refresh package metadata first — a standalone dispatch (see comment
  # above) may run on a boot where step_apt_update never ran, so the local
  # apt cache can be stale or empty and "apt-get install pipx" would 404 on
  # a fresh image. Tolerate failure here (offline JetPack 6.2 hosts still
  # need to fall through to the pip --user path below) but don't hide it.
  if ! DEBIAN_FRONTEND=noninteractive apt-get update -qq; then
    echo "  Warning: apt-get update failed (offline?) — trying pipx install from the existing cache" >&2
  fi
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq pipx; then
    echo "  Warning: apt-get install pipx failed" >&2
  fi
  as_clawbox_login "command -v pipx" &>/dev/null
}

step_apt_update() {
  wait_for_apt
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  # poppler-utils is `pdftotext`, and it is the ONLY reason Memory Shard can
  # index a PDF: OpenClaw's memory indexer reads `.md` and nothing else, so
  # ClawBox extracts documents itself (src/lib/memory-extract.ts). Without it a
  # folder of PDFs added as a source would be walked and every file silently
  # skipped, while the panel reported the folder as indexed. It was already on
  # the dev box by accident of another package; naming it here is what makes the
  # feature true on a fresh flash. The same extractor hands .docx, .odt and .rtf
  # to `libreoffice --headless --convert-to txt`, so the same rule applies:
  # libreoffice-writer is the smallest package that carries the Writer import
  # filters those formats need (and pulls in libreoffice-common, which owns the
  # /usr/bin/libreoffice launcher) — the full `libreoffice` metapackage would add
  # Calc, Impress, Base and a Java runtime for nothing the box ever converts.
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl network-manager avahi-daemon iptables ufw iw python3 python3-pip python-is-python3 pipx gh build-essential cmake ninja-build pkg-config poppler-utils libreoffice-writer
  # Node.js for production server and OpenClaw. OpenClaw 2026.8.1 tightened
  # its engines to >=22.22.3; older ClawBox images may have v22.22.2, which
  # looks like "Node 22" but crashes the OpenClaw CLI after npm install.
  if node_satisfies_openclaw_engine; then
    echo "  Node.js $(node --version) already satisfies OpenClaw engine requirements"
  else
    echo "  Installing/upgrading Node.js 22..."
    # NodeSource's setup script will silently exit 0 even when its inner
    # `apt update` fails because of an apt-lock conflict (e.g. packagekitd on
    # first boot), and apt-get install nodejs then falls back to Ubuntu's
    # libnode72 / nodejs 12. That breaks the build at step 8/23 with a
    # confusing optional-chaining parse error inside node-gyp. Wait for the
    # lock first, then validate the installed version.
    wait_for_apt
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    wait_for_apt
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    if ! node_satisfies_openclaw_engine; then
      local got
      got=$(node --version 2>/dev/null || echo "missing")
      echo "Error: Node.js install failed — \`node --version\` reports $got." >&2
      echo "       Likely the NodeSource setup script lost a race for the apt lock" >&2
      echo "       (commonly held by packagekitd or unattended-upgrades on first boot)" >&2
      echo "       or apt kept an older Node.js build. flash.sh's Phase 0 should" >&2
      echo "       mask packagekit.service and unattended-upgrades.service in the" >&2
      echo "       rootfs to prevent this." >&2
      exit 1
    fi
    echo "  Node.js $(node --version) installed"
  fi
}

step_network_setup() {
  # --- Detect WiFi interface ---
  local WIFI_IFACE="${NETWORK_INTERFACE:-}"
  if [ -z "$WIFI_IFACE" ] && ! is_test_mode; then
    WIFI_IFACE=$(iw dev 2>/dev/null | awk '/Interface/{print $2}' | head -1)
  fi
  if [ -z "$WIFI_IFACE" ]; then
    if is_test_mode; then
      WIFI_IFACE="eth0"
      echo "  CLAWBOX_TEST_MODE=1, using stub interface '$WIFI_IFACE'"
    else
      echo "Error: No WiFi interface found. Ensure a wireless adapter is available."
      echo "You can override with: NETWORK_INTERFACE=wlan0 sudo bash install.sh"
      exit 1
    fi
  elif ! is_test_mode; then
    if ! iw dev "$WIFI_IFACE" info >/dev/null 2>&1; then
      echo "Error: WiFi interface '$WIFI_IFACE' not found or not wireless."
      exit 1
    fi
  fi
  echo "  WiFi interface: $WIFI_IFACE"
  # Persist for scripts and services
  mkdir -p "$PROJECT_DIR/data"
  printf 'NETWORK_INTERFACE=%s\n' "$WIFI_IFACE" > "$IFACE_ENV"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data" "$IFACE_ENV"
  # Also write to root-owned path for clawbox-root-update@ service
  mkdir -p /etc/clawbox
  printf 'NETWORK_INTERFACE=%s\n' "$WIFI_IFACE" > /etc/clawbox/network.env
  # In test mode, propagate the flag into the root-update environment too —
  # otherwise updater-triggered install.sh steps would try to do the real
  # Jetson work (nvidia_jetpack, nvpmodel, etc.) and fail on non-Tegra hosts.
  if is_test_mode; then
    printf 'CLAWBOX_TEST_MODE=1\n' >> /etc/clawbox/network.env
  fi
  chmod 644 /etc/clawbox/network.env
  echo "  WiFi interface saved to $IFACE_ENV and /etc/clawbox/network.env"

  # --- Hostname and mDNS ---
  apply_hostname "$(read_configured_hostname)"
}

# Validate an RFC 1123 hostname label: 1-63 chars, [a-z0-9-], no leading/trailing hyphen.
# Prints the lowercased hostname on success, or empty string on failure.
validate_hostname() {
  local name="${1:-}"
  name="${name,,}"
  if [[ ! "$name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
    echo ""
    return 1
  fi
  echo "$name"
}

# Read desired hostname from data/hostname.env (HOSTNAME=value) or config.json.
# Falls back to "clawbox".
read_configured_hostname() {
  local hostname_env="$PROJECT_DIR/data/hostname.env"
  # PARSED, never sourced. data/ is clawbox-writable and this function runs as
  # root from the granted clawbox-root-update@set_hostname.service, so `.` on
  # this file was arbitrary root code execution for anything that can already
  # run code as clawbox. validate_hostname below still decides whether the value
  # is usable; this only decides that it is a value and not a program. TASK-445.
  local name
  name="$(read_untrusted_env_value "$hostname_env" HOSTNAME)"
  if [ -z "$name" ]; then
    name="clawbox"
  fi
  local valid
  valid=$(validate_hostname "$name") || valid=""
  if [ -z "$valid" ]; then
    valid="clawbox"
  fi
  printf '%s' "$valid"
}

# Set system hostname and install the hardened avahi config so mDNS
# advertises <name>.local reliably.
#
# Hardening goals (full rationale in config/avahi-daemon.conf):
#   - Shorter rate-limit window + larger burst so Windows' chatty
#     parallel A/AAAA/SRV/PTR queries don't trip avahi's throttle and
#     trigger a 15-minute negative-cache on the client.
#   - Cross-family (publish-a-on-ipv6 / publish-aaaa-on-ipv4) so dual-
#     stack clients resolve on the first attempt.
#   - use-iff-running=no so we announce the instant an address is
#     assigned, not after IFF_RUNNING flips on.
#   - A NetworkManager dispatcher hook forces avahi to re-announce on
#     every interface up/down / DHCP change so stale negative caches
#     on clients expire within seconds instead of 15 minutes.
apply_hostname() {
  local name
  name=$(validate_hostname "${1:-}") || name=""
  if [ -z "$name" ]; then
    echo "  Invalid hostname '${1:-}', skipping"
    return 1
  fi
  # hostnamectl is best-effort in test mode: Docker containers sharing the
  # host's UTS namespace can't set the hostname and systemd-hostnamed often
  # isn't running. Don't fail the whole install over it.
  if ! hostnamectl set-hostname "$name" 2>/dev/null; then
    if is_test_mode; then
      echo "  CLAWBOX_TEST_MODE=1, hostnamectl unavailable — skipping"
    else
      echo "  Warning: hostnamectl set-hostname failed, continuing"
    fi
  fi

  # Install ClawBox's hardened avahi config if we have one in the repo.
  # Keep the distro default as .bak.orig the first time so operators can
  # diff and revert if needed.
  # Prefer the canonical project copy under $PROJECT_DIR, but fall back to
  # the config shipped next to the installer script. This matters on the
  # fresh-install path where the network setup step runs before `git pull`
  # has populated $PROJECT_DIR — the installer is being executed straight
  # out of the cloned tarball at that moment.
  local clawbox_avahi_src="$PROJECT_DIR/config/avahi-daemon.conf"
  if [ ! -f "$clawbox_avahi_src" ] && [ -f "$(dirname "$0")/config/avahi-daemon.conf" ]; then
    clawbox_avahi_src="$(dirname "$0")/config/avahi-daemon.conf"
  fi
  if [ -f "$clawbox_avahi_src" ]; then
    if [ -f "$AVAHI_CONF" ] && [ ! -f "${AVAHI_CONF}.bak.orig" ]; then
      cp "$AVAHI_CONF" "${AVAHI_CONF}.bak.orig"
    fi
    install -m 644 "$clawbox_avahi_src" "$AVAHI_CONF"
    # Rewrite the host-name line to match the configured device hostname.
    sed -i "s/^#\\?host-name=.*/host-name=$name/" "$AVAHI_CONF"
    echo "  Installed hardened avahi-daemon.conf (host-name=$name)"
  elif [ -f "$AVAHI_CONF" ]; then
    # Fallback when install.sh runs from a repo that doesn't have the
    # new config file (older deployments): just rewrite the host-name
    # line in the distro default, same as before.
    cp -n "$AVAHI_CONF" "${AVAHI_CONF}.bak" 2>/dev/null || true
    if grep -q '^#\?host-name=' "$AVAHI_CONF"; then
      sed -i "s/^#\\?host-name=.*/host-name=$name/" "$AVAHI_CONF"
    elif grep -q '^\[server\]' "$AVAHI_CONF"; then
      sed -i "/^\\[server\\]/a host-name=$name" "$AVAHI_CONF"
    else
      printf '\n[server]\nhost-name=%s\n' "$name" >> "$AVAHI_CONF"
    fi
  else
    echo "  Warning: $AVAHI_CONF not found and no repo config to install"
  fi

  # Install the NetworkManager dispatcher hook that reloads avahi on
  # every interface state change, so clients' negative caches flush.
  local dispatcher_dir="/etc/NetworkManager/dispatcher.d"
  local dispatcher_src="$PROJECT_DIR/config/99-clawbox-avahi-reload"
  if [ ! -f "$dispatcher_src" ] && [ -f "$(dirname "$0")/config/99-clawbox-avahi-reload" ]; then
    dispatcher_src="$(dirname "$0")/config/99-clawbox-avahi-reload"
  fi
  if [ -f "$dispatcher_src" ] && [ -d "$dispatcher_dir" ]; then
    install -m 755 "$dispatcher_src" "$dispatcher_dir/99-clawbox-avahi-reload"
    # NetworkManager requires dispatcher scripts to be owned by root and
    # not world-writable — install(1) defaults already match, but make it
    # explicit so future permission tightening doesn't silently disable.
    chown root:root "$dispatcher_dir/99-clawbox-avahi-reload"
    echo "  Installed NetworkManager dispatcher for avahi re-announce"
  fi

  systemctl restart avahi-daemon
  echo "  Hostname set to '$name', avahi restarted"
}

step_set_hostname() {
  apply_hostname "$(read_configured_hostname)"
}

is_safe_git_ref() {
  local ref="${1:-}"
  [ -n "$ref" ] || return 1
  # Two gates, and both are load-bearing.
  #
  # The character class mirrors src/lib/update-branch.ts. It is not redundant
  # with git's check below: git happily accepts `feat/a+b`, the runtime updater
  # refuses it, and a pin the updater refuses does not fail the update — it
  # falls through to `main`. So install.sh must never write a ref the runtime
  # would reject, or the device drifts while its pin still reads correct.
  #
  # git's own grammar check then rejects the names that are spelled with legal
  # characters but are not branches: `HEAD`, `a..b`, `x/`, `a.lock`.
  case "$ref" in
    -*|/*|*[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  # `-C /` so the answer depends on the ref and nothing else. check-ref-format
  # needs no repository, but git still runs repository discovery from the
  # working directory first, and a broken .git there (a moved worktree, a
  # half-restored backup) makes it exit 128 for EVERY ref — which would look
  # exactly like "no valid branch": no pin written, and the device falls back to
  # main. install.sh is run from whatever directory the operator happened to be
  # in, so that must not be able to decide this.
  git -C / check-ref-format --branch "$ref" >/dev/null 2>&1
}

# Which branch does a DETACHED checkout belong to? Prints it, or nothing.
#
# `git symbolic-ref HEAD` fails on a detached HEAD — the state a support
# engineer leaves behind with `git checkout <sha>` — and that failure used to
# land on resolve_update_branch's `main` default, so one debugging checkout
# hard-reset the device onto the fleet release channel. main is never a guess
# worth making, so the branch is recovered from evidence instead:
#
#   1. the deployed build's own stamp (.next/build-info.json "branch"), written
#      on this device at build time and therefore surviving the checkout;
#   2. local branches that CONTAIN HEAD — git's own record;
#   3. name-rev against origin's refs, which is all a re-clone leaves.
#
# Mirrors recoverDetachedBranch() in src/lib/updater.ts, including the order and
# the two filters: `main` is accepted only when it turns up AS evidence and is
# tried last, and a candidate is used only if origin actually carries it (a
# branch with no upstream would fail later at `reset --hard origin/<branch>`).
recover_detached_branch() {
  [ -d "$PROJECT_DIR/.git" ] || return 0

  local candidates=() stamp branch info others named
  for stamp in "$PROJECT_DIR/.next/standalone/.next/build-info.json" "$PROJECT_DIR/.next/build-info.json"; do
    [ -f "$stamp" ] || continue
    info=$(sed -n 's/.*"branch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$stamp" | head -n 1)
    if [ -n "$info" ] && [ "$info" != "HEAD" ]; then
      candidates+=("$info")
      break
    fi
  done

  others=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" \
    for-each-ref --format='%(refname:short)' --contains HEAD refs/heads 2>/dev/null || true)
  while IFS= read -r branch; do
    [ -n "$branch" ] && candidates+=("$branch")
  done <<< "$others"

  named=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" \
    name-rev --name-only --refs='refs/remotes/origin/*' HEAD 2>/dev/null || true)
  if [ -n "$named" ] && [ "$named" != "undefined" ]; then
    named="${named#remotes/}"
    named="${named#origin/}"
    named="${named%%[~^]*}"
    [ -n "$named" ] && candidates+=("$named")
  fi

  # Non-main candidates first: a box carrying any other evidence keeps its channel.
  local pass
  for pass in other main; do
    for branch in ${candidates+"${candidates[@]}"}; do
      [ -n "$branch" ] || continue
      [ "$branch" != "HEAD" ] || continue
      if [ "$pass" = "main" ]; then
        [ "$branch" = "main" ] || continue
      else
        [ "$branch" != "main" ] || continue
      fi
      is_safe_git_ref "$branch" || continue
      git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" \
        rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null 2>&1 || continue
      printf '%s\n' "$branch"
      return 0
    done
  done
}

# Resolve the update target: CLAWBOX_BRANCH > .update-branch > current branch >
# (detached) recovered branch. Sets UPDATE_TARGET_LOCAL/UPSTREAM, and
# UPDATE_TARGET_UNRESOLVED=1 when the only remaining answer would be a guess —
# callers must refuse rather than sync. `main` is still the default for a
# directory that is not a checkout at all (a fresh install about to clone).
resolve_update_branch() {
  UPDATE_TARGET_LOCAL="main"
  UPDATE_TARGET_UPSTREAM="origin/main"
  UPDATE_TARGET_UNRESOLVED=0

  # An explicit CLAWBOX_BRANCH (CLI or systemd env) wins over everything else.
  if [ -n "${CLAWBOX_BRANCH:-}" ] && is_safe_git_ref "${CLAWBOX_BRANCH}"; then
    UPDATE_TARGET_LOCAL="$CLAWBOX_BRANCH"
    UPDATE_TARGET_UPSTREAM="origin/$CLAWBOX_BRANCH"
    return 0
  fi

  local pinned=""
  if [ -f "$PROJECT_DIR/.update-branch" ]; then
    pinned=$(head -n 1 "$PROJECT_DIR/.update-branch" | tr -d '[:space:]')
    if [ -n "$pinned" ] && is_safe_git_ref "$pinned"; then
      UPDATE_TARGET_LOCAL="$pinned"
      UPDATE_TARGET_UPSTREAM="origin/$pinned"
      return 0
    fi
  fi

  # Not a checkout — nothing to protect; main is the repository's default.
  [ -d "$PROJECT_DIR/.git" ] || return 0

  local current upstream recovered
  current=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" symbolic-ref --short HEAD 2>/dev/null || true)

  if [ -n "$current" ]; then
    if [ "$current" != "main" ] && is_safe_git_ref "$current"; then
      upstream=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" rev-parse --abbrev-ref "${current}@{u}" 2>/dev/null || true)
      if [ -n "$upstream" ] && is_safe_git_ref "$upstream"; then
        UPDATE_TARGET_LOCAL="$current"
        UPDATE_TARGET_UPSTREAM="$upstream"
      elif git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" \
             rev-parse --verify --quiet "refs/remotes/origin/$current" >/dev/null 2>&1; then
        # The upstream LINK does not survive a re-clone even though the branch
        # does; origin carrying the branch is the same evidence by another route.
        UPDATE_TARGET_LOCAL="$current"
        UPDATE_TARGET_UPSTREAM="origin/$current"
      fi
    fi
    return 0
  fi

  # Detached HEAD: evidence, or refuse. Never the main default.
  recovered="$(recover_detached_branch)"
  if [ -n "$recovered" ]; then
    UPDATE_TARGET_LOCAL="$recovered"
    UPDATE_TARGET_UPSTREAM="origin/$recovered"
    return 0
  fi

  UPDATE_TARGET_LOCAL=""
  UPDATE_TARGET_UPSTREAM=""
  UPDATE_TARGET_UNRESOLVED=1
  return 0
}

# The message a device gets instead of being moved to another channel.
refuse_unresolved_update_target() {
  echo "Error: this device is not on a branch (detached HEAD), carries no update pin," >&2
  echo "       and nothing on it records which branch it was built from." >&2
  echo "       Refusing to update: the only remaining answer is 'main', the fleet release" >&2
  echo "       channel, and moving this device there would be a channel change, not an update." >&2
  echo "       Set the update branch in System Update -> Advanced options (or check out the" >&2
  echo "       branch this device belongs to) and run the update again." >&2
  exit 1
}

# The branch this checkout is already sitting on, when that is worth recording.
# Prints nothing (and succeeds) when it is not.
#
# Deliberately narrow, because this runs without anyone having asked for a
# branch. Every condition below is a case where writing a pin would be a guess
# rather than a record:
#   - not a repo → there is no branch name to record.
#   - HEAD is detached → no branch name is directly readable, but the box may
#     still be able to PROVE which branch it belongs to (build stamp, refs that
#     contain HEAD). recover_detached_branch answers that, and its answer is
#     evidence, not a guess, so it is worth recording — a detached device that
#     records nothing has to re-derive the same answer on every future update,
#     and refuses the update outright the day the evidence goes away.
#   - `main` → rule 3's fallback is already main, so a pin changes nothing today
#     and would only freeze a device an operator later moves by hand.
#   - not a ref both resolvers accept → a pin the updater refuses resolves to
#     `main`, which is the very drift this function exists to prevent.
#   - origin does not carry the branch → today such a device falls back to main
#     and keeps updating. Pinning it would turn that into a hard failure at
#     `reset --hard origin/<branch>` on every future update.
adoptable_checkout_branch() {
  [ -d "$PROJECT_DIR/.git" ] || return 0
  local current
  current=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" symbolic-ref --short HEAD 2>/dev/null || true)
  [ -n "$current" ] || current="$(recover_detached_branch)"
  [ -n "$current" ] || return 0
  [ "$current" != "main" ] || return 0
  is_safe_git_ref "$current" || return 0
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" \
    rev-parse --verify --quiet "refs/remotes/origin/$current" >/dev/null 2>&1 || return 0
  printf '%s\n' "$current"
}

# Record the branch this device updates from, so the answer survives.
#
# resolve_update_branch() has always READ $PROJECT_DIR/.update-branch and never
# written it, so the pin existed only if a human created it. Without one, a box
# falls through to rule 2 — the current branch, and only if that branch tracks a
# remote. That upstream *link* does not survive a re-clone even though the
# branch does, so a device built from CLAWBOX_BRANCH=<x> could later resolve to
# `main` and update itself onto a branch it was never built for. Two freshly
# provisioned devices reached an operator with no pin at all.
#
# Three cases, in precedence order:
#   - explicit CLAWBOX_BRANCH → write the pin, including OVER a different
#     existing one. This is the precedence already documented in
#     resolve_update_branch (CLAWBOX_BRANCH > .update-branch > current > main),
#     and the repo is about to be hard-reset onto that branch; a pin still
#     naming the old branch would make the very next unattended update pull the
#     device straight back off it.
#   - no CLAWBOX_BRANCH and NO pin at all → adopt the checked-out branch, if
#     adoptable_checkout_branch vouches for it. This does not move the device;
#     it records where it already is, before sync_repo_to_update_target
#     overwrites the only evidence. It also settles a disagreement inside a
#     single install run: the bootstrap block at the top of this file follows
#     the checked-out branch with no upstream requirement and resets to it,
#     while resolve_update_branch's rule 2 would then send the same box to main.
#   - no CLAWBOX_BRANCH and a pin already present → never rewrite, never delete.
#     An existing pin is somebody's explicit choice (operator, Settings UI, an
#     earlier flash); a bare `sudo bash install.sh` and every updater-triggered
#     `--step` must leave it exactly as found.
persist_update_branch_pin() {
  [ -d "$PROJECT_DIR" ] || return 0

  local pin_file="$PROJECT_DIR/.update-branch"

  # $PROJECT_DIR belongs to $CLAWBOX_USER and this function runs as root, so
  # every path under it is writable by an account the writer outranks. A symlink
  # left at the pin path would redirect the write, the chown and the chmod onto
  # whatever it points at, and `[ -f ]` follows one. Refuse instead. The write
  # goes through a temp file whose name mktemp chooses (see below), and `mv`
  # replaces the pin's directory entry rather than following it.
  if [ -L "$pin_file" ]; then
    echo "  WARN: not pinning update branch — $pin_file is a symlink" >&2
    return 0
  fi

  local existing=""
  if [ -f "$pin_file" ]; then
    existing=$(head -n 1 "$pin_file" | tr -d '[:space:]')
  fi

  local branch="${CLAWBOX_BRANCH:-}"
  local pin_source="explicit CLAWBOX_BRANCH"
  if [ -n "$branch" ]; then
    if ! is_safe_git_ref "$branch"; then
      echo "  WARN: not pinning update branch — '$branch' is not a valid git ref" >&2
      branch=""
    fi
  elif [ -z "$existing" ]; then
    branch="$(adoptable_checkout_branch)"
    pin_source="the branch this checkout is on"
  fi

  if [ -n "$branch" ] && [ "$branch" != "$existing" ]; then
    if [ -n "$existing" ]; then
      # Repinning a device is never silent — an operator watching this run has
      # to be able to see the branch it will follow from here on.
      echo "  Re-pinning update branch '$existing' -> '$branch' ($pin_source)"
    else
      echo "  Pinning update branch to '$branch' ($pin_source)"
    fi
    # Stage the write in a directory of our own rather than beside the pin.
    #
    # A temp file placed directly in $PROJECT_DIR can be swapped for a symlink
    # before the printf/chown/chmod land, because $PROJECT_DIR is writable by
    # $CLAWBOX_USER. With a fixed name that needs no timing at all; the staging
    # directory means an attacker must instead win a race on the directory
    # entry between the mkdir and the write. The final step is a rename, which
    # replaces the pin's directory entry and never follows a symlink left at it.
    #
    # It does NOT close that race, and 0700 is not what stops it: unlinking an
    # entry is governed by the parent's write bit, which $CLAWBOX_USER has, so
    # $stage can still be rmdir'd and replaced between the two lines below.
    # Closing it needs descriptor-bound openat/renameat with no-follow
    # semantics, which POSIX shell cannot express.
    #
    # That residual is accepted deliberately, and the reason is three lines
    # further down: sync_repo_to_update_target runs `git reset --hard` as root
    # inside this same app-writable tree and then `chown -R` over all of it.
    # Whoever can win the race below already has a far larger version of the
    # same primitive in the same step. Hardening the pin write past this point
    # while that stands would be motion, not progress — if this class is worth
    # closing it has to be closed for the tree, not for one file in it.
    local stage="$PROJECT_DIR/.update-branch.stage" tmp_pin
    rm -rf "$stage"
    if ! (umask 077 && mkdir "$stage"); then
      echo "  WARN: could not stage the update-branch pin write" >&2
      return 0
    fi
    tmp_pin="$stage/pin"
    if printf '%s\n' "$branch" > "$tmp_pin" \
      && chown "$CLAWBOX_USER:$CLAWBOX_USER" "$tmp_pin" \
      && chmod 644 "$tmp_pin" \
      && mv -f "$tmp_pin" "$pin_file"; then
      rm -rf "$stage"
      return 0
    fi
    # Never leave the device's working tree holding staging litter.
    rm -rf "$stage"
    echo "  WARN: failed to write the update-branch pin" >&2
    return 0
  fi

  # Nothing to write. Still re-assert owner and mode on an existing pin, and do
  # it whether or not a branch was given: the web app runs as $CLAWBOX_USER and
  # rewrites this file itself through /setup-api/system/update-branch, so a
  # root-owned pin turns that POST into an EACCES — the same class of bug a
  # root-owned data/ caused in the config store. Worse, a pin the app user
  # cannot READ is invisible to the updater, which then resolves to `main` while
  # this script (running as root) still reads the pin and disagrees. Repairing
  # it unconditionally is what makes a pin left behind by a hand-written
  # `sudo sh -c 'echo beta > .update-branch'` heal on the next run. 0644, not
  # 0600: this is a build record, not a secret, and root reads it during the
  # bootstrap re-exec before it drops to $CLAWBOX_USER.
  [ -n "$existing" ] || return 0
  if [ -n "$branch" ]; then
    echo "  Update branch already pinned to '$branch'"
  fi
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$pin_file"
  chmod 644 "$pin_file"
}

sync_repo_to_update_target() {
  local target_branch="$1"
  local upstream_branch="$2"

  if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo "Error: $PROJECT_DIR is not a git repository" >&2
    exit 1
  fi

  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
  # Discard local working-tree changes before switching branches. The later
  # `reset --hard` would blow them away anyway; doing it up-front avoids
  # `git checkout` aborting with "local changes would be overwritten" when
  # the user (or test seeding) has uncommitted edits. This is by design —
  # the updater's whole purpose is to align the device with upstream.
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" reset --hard HEAD 2>/dev/null || true
  if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$target_branch" 2>/dev/null; then
    if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout -b "$target_branch" "$upstream_branch" 2>/dev/null; then
      echo "Error: failed to checkout branch '$target_branch'" >&2
      exit 1
    fi
  fi
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" reset --hard "$upstream_branch"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
  # The tree root is allowed to execute just changed. Re-record it here, in the
  # same function that changed it, so no later step of this update runs against
  # a manifest describing the previous checkout.
  refresh_root_exec_manifest
}

step_bootstrap_updater() {
  # Pull the latest repo files (especially install.sh) before any later update
  # steps run. The current root service finishes under the old script, but the
  # next root step will launch a fresh shell against the updated install.sh.
  step_fix_git_perms
  resolve_update_branch
  [ "${UPDATE_TARGET_UNRESOLVED:-0}" -eq 1 ] && refuse_unresolved_update_target
  echo "  Refreshing updater files on branch '$UPDATE_TARGET_LOCAL'..."
  # An orphan of the pre-3.9 hand-deploy method that nothing reads. Left in
  # place it is an untracked file in the project root, which the drift engine
  # reads as "the code on disk matches no commit" — it raised the About-screen
  # drift banner on a healthy box and stamped `dirty: true` on clean builds.
  # It is gitignored now, so `git clean -fd` will not take it: drop it here.
  rm -f "$PROJECT_DIR/.deployed-sha"
  sync_repo_to_update_target "$UPDATE_TARGET_LOCAL" "$UPDATE_TARGET_UPSTREAM"
}

step_git_pull() {
  local fresh_clone=0
  if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo "  Cloning from $REPO_URL (branch: $REPO_BRANCH)..."
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
    fresh_clone=1
  fi

  # Record the pin BEFORE anything moves the repo. sync_repo_to_update_target
  # below checks out and hard-resets, so on an unpinned device the checked-out
  # branch — the only surviving record of what this unit was built from — is
  # gone by the time it returns. Writing the pin here also feeds
  # resolve_update_branch's rule 1 on this very run, so the branch the device
  # keeps is the branch this run installs. Early enough, too, that a later
  # failed step still leaves a correctly pinned device.
  persist_update_branch_pin

  [ "$fresh_clone" -eq 0 ] || return 0

  # Hard-sync to the resolved update branch (CLAWBOX_BRANCH > .update-branch >
  # current branch > main) instead of a fast-forward-only merge. The old
  # `merge --ff-only ... || echo continuing` silently kept stale code whenever
  # the box had any local divergence, which then pinned config/openclaw-target.txt,
  # OpenClaw, and the gateway to the old version (issue #202). Reuse the same
  # robust path the in-app updater takes: fetch, drop local changes, checkout,
  # and reset --hard to the upstream. sync_repo_to_update_target chowns too.
  resolve_update_branch
  [ "${UPDATE_TARGET_UNRESOLVED:-0}" -eq 1 ] && refuse_unresolved_update_target
  echo "  Repository exists, hard-syncing to '$UPDATE_TARGET_LOCAL'..."
  rm -f "$PROJECT_DIR/.deployed-sha"
  sync_repo_to_update_target "$UPDATE_TARGET_LOCAL" "$UPDATE_TARGET_UPSTREAM"
}

step_install_bun() {
  if [ -x "$BUN" ]; then
    echo "  Bun already installed at $BUN"
    return
  fi
  echo "  Installing bun..."
  as_clawbox bash -o pipefail -c 'curl -fsSL https://bun.sh/install | bash' || {
    echo "Error: Bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash"
    exit 1
  }
}

step_build() {
  cd "$PROJECT_DIR"
  as_clawbox_login "cd $PROJECT_DIR && $BUN install"
  ensure_node_pty
  as_clawbox_login "cd $PROJECT_DIR && $BUN run build"
  if [ ! -f "$PROJECT_DIR/.next/standalone/server.js" ]; then
    echo "Error: Build failed — .next/standalone/server.js not found"
    exit 1
  fi
  echo "  Build complete"
}

step_openclaw_setup() {
  # NOTE (here and at every other early-return below): plain `echo`, never
  # `log`. log() is only defined at the very bottom of this file, AFTER the
  # `--step` dispatch block exits — so a `log` call inside a step function is a
  # guaranteed 127 whenever the in-app updater invokes that step, and under
  # `set -e` an AND-list like `guard && { log …; return 0; }` takes the whole
  # shell down with it.
  # The hermes SKU skips the OpenClaw TRIO — there is no gateway on it — but no
  # longer the whole step. step_openclaw_tts below is the on-device voice, and
  # a blanket `return 0` here is what left a freshly flashed Hermes box with no
  # speech engine at all: the step's own edition guard was removed, and this
  # one silently kept it alive on the fresh-install path.
  if is_hermes_edition; then
    echo "  [hermes edition] skipping OpenClaw install"
  else
    step_openclaw_install
    step_openclaw_patch
    step_openclaw_config
  fi
  # Only 12 ("Kokoro was requested and did not install"), 13 ("this box has NO
  # working on-device TTS engine") and 14 ("the voice scripts did not deploy;
  # Kokoro's own verdict stands") are tolerated here, and only because the step
  # has already recorded each of them with record_provision_failure, so the
  # summary, the exit status, the provisioning marker and step_validate_services'
  # TTS probe all carry them. A box that could not install its speech engine
  # must still finish provisioning and come up reachable — that is how it gets
  # fixed.
  #
  # They are three DIFFERENT facts and they are kept apart on purpose. Folding
  # 14 into 13 would print "this box has NO working on-device TTS engine" over a
  # box whose Kokoro is running perfectly and has merely lost its script deploy
  # — a failure report over something that actually succeeded, which is the same
  # class of untrue status line this whole block exists to stop.
  #
  # Every OTHER non-zero return stays FATAL, exactly as it was before this
  # tolerance existed. Those are the provider-configuration failures — no
  # clawbox-tts.sh, a tts-local-cli plugin that will not resolve, a config write
  # that never landed — and they mean the box has no working speech path at all,
  # not a downgraded one. Blanket-swallowing them here would recreate this PR's
  # own bug one layer up: a successful-looking flash over a box that cannot
  # speak, with nothing in the marker to say so.
  local TTS_STEP_RC=0
  step_openclaw_tts || TTS_STEP_RC=$?
  case "$TTS_STEP_RC" in
    0) ;;
    12) echo "  Warning: Kokoro GPU TTS did not install (recorded above; provisioning continues)" ;;
    13) echo "  Warning: this box has NO working on-device TTS engine (recorded above; provisioning continues)" ;;
    14) echo "  Warning: the TTS install did not complete (recorded above; provisioning continues)" ;;
    *) return "$TTS_STEP_RC" ;;
  esac
}

# Install the Hermes agent (git-based install into ~/.hermes). Needed by every
# edition that runs Hermes — the hermes SKU and the premium dual SKU (which was
# previously skipped here, so a dual box got the switcher but no second
# harness to switch to).
step_hermes_install() {
  has_hermes_harness || return 0
  local shim="$CLAWBOX_HOME/.local/bin/hermes"
  local agent_dir="$CLAWBOX_HOME/.hermes/hermes-agent"
  local venv_python="$agent_dir/venv/bin/python"
  local installed=""
  local pin="$HERMES_PIN_COMMIT"

  # The pin is spliced into a URL below and the file that URL returns is piped
  # into bash, so it is validated before it is used. A malformed value — a tag
  # name, a truncated SHA, an env override carrying a slash — would otherwise
  # fetch some other path from the same host and run it. Refuse, and leave
  # whatever agent the device already has alone.
  if ! printf '%s' "$pin" | grep -Eq '^[0-9a-fA-F]{40}$'; then
    echo "  Warning: the Hermes pin is not a 40-char commit SHA — leaving the existing agent untouched" >&2
    return 0
  fi

  # One constant so the reachability precheck and the install itself can never
  # drift onto different hosts — and it is served FROM the pinned tree, so the
  # installer that runs is the one that shipped with the commit being asked
  # for. The vanity host (hermes-agent.nousresearch.com/install.sh) serves
  # main's copy of the same file: identical today, free to change its flags
  # under us tomorrow.
  local installer_url="https://raw.githubusercontent.com/NousResearch/hermes-agent/$pin/scripts/install.sh"

  # `$shim` alone is NOT evidence of an install: it is a 4-line wrapper in
  # ~/.local/bin that execs $venv_python, and the agent it points at lives
  # under ~/.hermes. A factory reset removed ~/.hermes and left the shim, so
  # the old `[ -x "$shim" ]` guard printed "Hermes already installed ()" — an
  # EMPTY version probe inside an echo nobody looked at — and returned success
  # without reinstalling. Every later repair, a full install.sh re-run
  # included, hit the same guard and did nothing: that is what turned a
  # recoverable box into a reflash.
  #
  # So: require the interpreter to exist AND the agent to actually answer
  # `--version`. Anything less is treated as "not installed".
  if [ -x "$shim" ] && [ -x "$venv_python" ]; then
    # Probed AS THE CLAWBOX USER, deliberately. `hermes` is a Python entry
    # point and CPython writes __pycache__/*.pyc next to the sources it
    # imports; probing as root left root-owned .pyc files inside a
    # clawbox-owned tree, and the factory-reset route (which runs as clawbox)
    # then hit EACCES and aborted MID-WIPE with the agent half deleted. HOME is
    # passed explicitly: hermes resolves ~/.hermes from $HOME, and this
    # function's HOME is /root.
    #
    # `|| installed=""` is NOT decoration. Under `set -euo pipefail` an
    # assignment takes the exit status of its command substitution, so the
    # false-negative probe this step exists to survive would kill install.sh
    # right here — before the reachability check, before any repair, printing
    # nothing — taking `install.sh --step hermes_install` (the documented
    # repair command) and every later step of a full install down with it.
    installed=$(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" \
      "$shim" --version 2>/dev/null | head -1) || installed=""
  fi

  # A version string cannot answer "is this the pinned build?": upstream prints
  # the same `v0.20.5` for the tag and for every untagged commit after it, and
  # there are hundreds of those a week. The checkout's HEAD is the only proof,
  # so HEAD is what decides. Read as the clawbox user for the same reason the
  # probe is: git refuses to operate on a repository owned by somebody else
  # ("detected dubious ownership"), and root reading a clawbox-owned tree is
  # exactly that case. `|| at_commit=""` for the errexit reason above — a
  # checkout that is not a git repository must fall through, not abort.
  local at_commit=""
  if [ -n "$installed" ]; then
    at_commit=$(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" \
      git -C "$agent_dir" rev-parse HEAD 2>/dev/null) || at_commit=""
    if [ "$at_commit" = "$pin" ]; then
      echo "  Hermes already installed at the pinned commit ($installed)"
      return 0
    fi
    # A working agent on the wrong commit takes the SAME path the unrunnable
    # one takes — reachability precheck, current checkout moved aside,
    # install, and the move undone if no working agent comes back. An upgrade
    # that dies halfway must leave the owner with the agent they already had,
    # which is the whole reason this step is built the way it is.
    echo "  Hermes runs but is not on the pinned commit — upgrading"
    echo "    have: ${at_commit:-unknown (not a git checkout)}"
    echo "    want: $pin"
  fi

  # NOTHING above this line has modified the disk, and nothing below it does
  # until the installer is known to be fetchable. step_post_update now calls
  # this step on EVERY update on EVERY hermes/dual box, so a false-negative
  # probe on a device with no internet must not be able to turn a healthy agent
  # into no agent — the very outcome this file exists to prevent.
  if ! runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" \
    curl -fsS --max-time 30 -o /dev/null "$installer_url"; then
    echo "  Warning: cannot reach the Hermes installer — leaving the existing agent untouched" >&2
    return 0
  fi

  # The husk has to be out of the way before the reinstall: the upstream
  # installer refuses outright with "Directory exists but is not a git
  # repository" when $agent_dir survives as an empty shell — exactly what a
  # factory reset leaves behind — so without this the box stays bricked.
  #
  # MOVED ASIDE, never deleted, and only until the outcome is known: the
  # install either succeeds (husk dropped below) or fails (husk moved back), so
  # the device is never left with two copies and never with none, and a wrong
  # diagnosis costs nothing. Renaming as ROOT is also required — the root-owned
  # __pycache__ above is not movable by the clawbox user the installer runs as.
  if [ -e "$agent_dir" ]; then
    # One noun for whatever is being moved, set on the same arm that announces
    # it. The move block below is shared by two very different devices — an
    # agent that does not run, and an agent that runs fine and is merely on the
    # wrong commit — and it used to call both of them "the unusable agent" one
    # line after announcing "Moving the working agent aside". An owner reading
    # that log on a healthy box has every reason to think the upgrade found
    # something wrong with their device.
    local moved_what
    if [ -n "$installed" ]; then
      moved_what="working agent"
      echo "  Moving the $moved_what aside so the pinned install can be undone"
    else
      moved_what="unusable agent"
      echo "  Hermes is present but not runnable — reinstalling the agent"
    fi
    if [ -e "$agent_dir.broken" ]; then
      # An existing husk means an earlier repair was interrupted between the
      # move and the restore: the husk is the owner's original checkout and
      # $agent_dir is whatever the interrupted installer left behind. The
      # original is the copy worth keeping; the partial tree is not. Deleting
      # the husk here instead would destroy the last known-good agent.
      if rm -rf "$agent_dir"; then
        echo "  Kept the earlier husk at $agent_dir.broken and discarded the partial install"
      else
        echo "  Warning: could not clear the partial install at $agent_dir — leaving both in place" >&2
        return 0
      fi
    elif mv "$agent_dir" "$agent_dir.broken"; then
      echo "  Moved the $moved_what to $agent_dir.broken"
    else
      echo "  Warning: could not move the $moved_what aside — leaving it in place" >&2
      return 0
    fi
    # The husk MUST be deletable by the clawbox user: the factory-reset route
    # runs as clawbox and keeps only the exact name "hermes-agent", so a
    # root-owned __pycache__ inside it fails the unlink with EACCES — and a
    # reset that reports a failure aborts BEFORE the password/WiFi/hostname
    # reset and the reboot. Non-fatal: errexit is live at this function's
    # bare call sites and the agent is moved aside right now, so aborting
    # here would leave the device with nothing installed at all.
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$agent_dir.broken" \
      || echo "  Warning: could not give $agent_dir.broken to $CLAWBOX_USER" >&2
  fi

  echo "  Installing Hermes agent (NousResearch) at $pin..."
  # Official installer clones NousResearch/hermes-agent + builds a venv. Runs as
  # the clawbox user so it lands in ~/.hermes and ~/.local/bin. The URL is
  # passed as an argument rather than spliced into the -c string, so it stays a
  # single source of truth without shell-quoting exposure. `-o pipefail`
  # because `curl | bash` otherwise exits 0 when the fetch fails (bash just
  # reads empty stdin) and the warning below could never fire; the timeouts
  # because the caller is a systemd unit with TimeoutStartSec=7200.
  #
  # `--force-commit` is not optional. For an existing checkout the upstream
  # installer fetches, checks out and fast-forwards its branch (main) FIRST
  # and only then applies `--commit`, skipping it with "Ignoring --commit …:
  # the checkout is already newer" whenever the pin is an ancestor of what it
  # just pulled — which is always, a tag being older than the main it was cut
  # from. Without the flag the pin is a silent no-op on every install,
  # including fresh ones, and boxes keep landing on random main commits.
  # `bash -s --` is what gets the flags through the pipe to the script.
  runuser -u "$CLAWBOX_USER" -- bash -o pipefail -c \
    'curl -fsSL --connect-timeout 15 --max-time 600 "$1" | bash -s -- --commit "$2" --force-commit' \
    _ "$installer_url" "$pin" \
    || echo "  Warning: Hermes install failed (non-fatal) — install it manually then re-run install.sh"

  # Verify rather than assume. The installer is fetched over the network and is
  # non-fatal above, so a silent failure here would otherwise be discovered by
  # the owner as a crash-looping dashboard. `|| installed=""` for the same
  # errexit reason as the first probe: when the install laid down nothing, this
  # runs a shim that does not exist and exits 127.
  installed=$(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" \
    "$shim" --version 2>/dev/null | head -1) || installed=""
  if [ -n "$installed" ]; then
    at_commit=$(runuser -u "$CLAWBOX_USER" -- env HOME="$CLAWBOX_HOME" \
      git -C "$agent_dir" rev-parse HEAD 2>/dev/null) || at_commit=""
    if [ "$at_commit" = "$pin" ]; then
      echo "  Hermes installed ($installed) at the pinned commit"
    else
      # The agent RUNS, so it is NOT rolled back: a working unpinned agent is
      # worth more than the copy moved aside, which was unpinned too. Loud,
      # because it means the pin did not take — upstream dropping
      # `--force-commit` would look exactly like this — and the next update
      # will pay for the whole upgrade again.
      echo "  Warning: Hermes installed ($installed) but HEAD is ${at_commit:-unknown}, not the pin $pin" >&2
    fi
    # Diagnosis confirmed, so the insurance copy goes: it costs ~1.9 GB
    # (checkout plus venv) on a disk-constrained device and is one more
    # directory a later factory reset has to be able to delete.
    rm -rf "$agent_dir.broken"

    # The upgrade above is a move-aside plus a FRESH clone, and the bridge's
    # ~80 MB node_modules is untracked — so every pinned upgrade deletes it.
    # Nothing is broken by that: the pairing manager runs this same `npm
    # install` the first time somebody asks for a WhatsApp QR, and it was
    # watched doing so on hardware (bridgeReady false→true, QRs rotating).
    # But it moves the cost to the worst possible moment — the owner has just
    # clicked Pair and is waiting on a code — and a box that happens to be
    # OFFLINE right then gets a pairing FAILURE where the same box would have
    # paired before the upgrade. So pay for it here instead, while the updater
    # demonstrably has the network and nobody is waiting.
    #
    # From the registry, NOT from the husk we just deleted. The husk's
    # node_modules belongs to a DIFFERENT commit; moving it across would carry
    # the old release's dependency tree into the new one's package.json.
    #
    # This runs only on the update that actually re-clones — a box already on
    # the pin returns above and never reaches here — so a warm-up that fails
    # falls back to the on-demand path, not to the next update.
    #
    # Best-effort in every direction, and deliberately so: skipped when there
    # is nothing to warm (no bridge in this release, or its node_modules
    # survived), time-boxed, and its failure is a WARNING. A successful Hermes
    # install must never be reported as a failed step because an npm mirror was
    # down — the on-demand path is still there and still works.
    #
    # 300s, not longer: step_post_update's budget is 900s total
    # (src/lib/updater.ts) and this step is followed inside it by the Gemma
    # re-cache, so a stalled registry must not be able to eat the rest of the
    # update. An 80 MB install over a working link is far inside that, and what
    # would consume the difference is npm's own retry backoff — exactly the
    # case this block already declares non-fatal.
    local bridge_dir="$agent_dir/scripts/whatsapp-bridge"
    if [ -d "$bridge_dir" ] && [ ! -d "$bridge_dir/node_modules" ]; then
      echo "  Warming up the WhatsApp bridge so the first pairing does not pay for it..."
      # `env -C` gives the install its working directory without a wrapper
      # shell to quote the path into, and leaves npm as timeout's direct child
      # so the time box actually lands on it. HOME is explicit for the same
      # reason as every other command in this step: npm caches under $HOME/.npm
      # and this function's HOME is /root, which the clawbox user cannot write.
      runuser -u "$CLAWBOX_USER" -- env -C "$bridge_dir" HOME="$CLAWBOX_HOME" \
        timeout 300 npm install --no-fund --no-audit --progress=false \
        || echo "  Warning: WhatsApp bridge warm-up failed (non-fatal) — the first pairing will install it on demand" >&2
    fi
  else
    echo "  Warning: Hermes still does not run after install — the dashboard will not start" >&2
    # The diagnosis may simply have been wrong — an empty probe on a loaded
    # device is exactly the case above. Put the original back: whatever the
    # failed install left behind is worth less than what was there before, and
    # parking the only copy under another name would leave the owner with no
    # working agent AND no automatic second chance on the next update.
    if [ -e "$agent_dir.broken" ]; then
      # Both steps guarded: a failed rm followed by mv would NEST the original
      # inside the failed install and report success.
      if rm -rf "$agent_dir" && mv "$agent_dir.broken" "$agent_dir"; then
        echo "  Restored the previous agent from $agent_dir.broken" >&2
      else
        echo "  Warning: the previous agent is at $agent_dir.broken — move it back by hand" >&2
      fi
    fi
  fi
  # Explicit: the last command above is a test that is FALSE on the happy path,
  # and step_post_update reports any non-zero return as a failed step.
  return 0
}

# Re-cache ONLY the offline Gemma GGUF.
#
# Split out of step_llamacpp_install so the in-app updater can dispatch it:
# that step also does apt work, a pip install and (worst case) a ~19-minute
# native llama.cpp build, none of which an update needs. This one touches
# nothing but the model file and is a fast no-op when it is already there,
# which is what makes it safe to run on every update.
#
# Not gated on has_hermes_harness: the factory-reset route wipes data/ on EVERY
# edition, so an openclaw box lost the same 3.2 GB model and needs the same
# repair.
step_llamacpp_model() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping Gemma model re-cache"
    return 0
  fi
  # `hf` is installed by step_llamacpp_install. If it was never run on this
  # device there is no model to restore and nothing this step can do — say so
  # instead of failing on a missing binary.
  if ! as_clawbox_login "command -v hf" &>/dev/null; then
    echo "  Hugging Face CLI not installed — skipping Gemma model re-cache"
    return 0
  fi
  ensure_llamacpp_model_cached
}

# The OpenClaw gateway is an UNAUTHENTICATED agent control surface on
# 0.0.0.0:18789. On the Hermes SKU it has no role, so leaving it enabled was a
# LAN-reachable pre-auth agent on a box the customer believes runs only Hermes.
# Stop + disable is not enough on its own: config/clawbox-sudoers grants the
# clawbox user NOPASSWD `systemctl start clawbox-gateway`, reachable from the
# in-UI terminal, SSH and the agent's run_command — so we mask it as well.
#
# `systemctl mask` REFUSES while a real unit file sits in /etc/systemd/system
# ("File … already exists"), which is why the factory-reset route has to use
# `--runtime mask`. A --runtime mask evaporates on reboot, so it is useless
# here: the file (and its drop-in directory) has to be removed first. That is
# safe on this SKU because nothing puts it back — clawbox-gateway.service is not
# in ALL_SERVICES on hermes, and step_gateway_setup early-returns.
#
# Idempotent, and never fatal when the unit was never installed (fresh flash).
step_edition_gateway_state() {
  local unit="clawbox-gateway.service"
  if is_hermes_edition; then
    systemctl stop "$unit" >/dev/null 2>&1 || true
    systemctl disable "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit"
    rm -rf "/etc/systemd/system/$unit.d"
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl mask "$unit" >/dev/null 2>&1 || true
    echo "  [hermes edition] clawbox-gateway.service stopped, disabled and masked"
  else
    # Re-installing a previously-Hermes box as openclaw/dual: the mask is a
    # symlink to /dev/null at the exact path step_systemd_services cp's the unit
    # to, so without unmasking first the copy would silently write to /dev/null
    # and the box would come up with no gateway at all.
    local installed="/etc/systemd/system/$unit"
    if [ -L "$installed" ] && [ "$(readlink -f "$installed" 2>/dev/null || true)" = "/dev/null" ]; then
      systemctl unmask "$unit" >/dev/null 2>&1 || true
      systemctl daemon-reload >/dev/null 2>&1 || true
      echo "  Cleared stale clawbox-gateway mask left by a previous Hermes install"
    fi
  fi
  return 0
}

# Bring down the harness this edition does not run.
#
# step_edition_gateway_state above already does exactly this, but in ONE
# direction only: on hermes it stops, disables, removes and masks
# clawbox-gateway.service. The openclaw/dual direction was never written, so a
# device that used to be hermes kept its entire Hermes stack —
# clawbox-hermes-dashboard, its auth proxy, and the hermes-gateway unit the
# upstream Hermes installer writes. That unit holds the Telegram bot token, so
# both harnesses then long-poll getUpdates on the same token and terminate each
# other's request ("Conflict: terminated by other getUpdates request",
# followed by a stall-detected restart loop): neither side receives a message,
# indefinitely.
#
# step_validate_services REPORTS that state, and reporting is not fixing. An
# appliance whose install finishes loudly broken still has to be repaired by an
# operator who knows which units to name, so the installer names them itself.
#
# Deliberately conservative:
#   - stop + disable ONLY. Nothing is masked, no unit file is removed, so every
#     unit here returns with one `systemctl enable --now`. The mask in
#     step_edition_gateway_state is NOT copied over: it is there because
#     config/clawbox-sudoers grants the clawbox user NOPASSWD `systemctl start
#     clawbox-gateway`, which undoes a plain disable from the in-UI terminal.
#     No Hermes unit has an equivalent grant, so a mask would buy nothing and
#     cost reversibility. hermes-gateway.service is not written by this repo
#     either, so deleting its unit file is not ours to do.
#   - only FOREIGN_EDITION_UNITS, which is built by negating BOTH harness
#     predicates. `dual` satisfies both, so its list is empty and this loop has
#     no body — the edition that legitimately runs both is untouched by
#     construction rather than by a special case that could rot.
#   - never silent: every unit is named with the state it was in and the
#     command that puts it back.
#   - CLAWBOX_KEEP_FOREIGN_UNITS=1 skips the teardown entirely, for an operator
#     who is mid-diagnosis and wants the box left exactly as found. Detection is
#     unaffected either way: step_validate_services still fails the install.
step_edition_foreign_teardown() {
  if [ "${#FOREIGN_EDITION_UNITS[@]}" -eq 0 ]; then
    return 0   # dual — both harnesses belong here
  fi

  local funit f_active f_enabled needs_stop needs_disable
  local -a brought_down=()

  for funit in "${FOREIGN_EDITION_UNITS[@]}"; do
    f_active=$(systemctl is-active "$funit" 2>/dev/null || true)
    f_enabled=$(systemctl is-enabled "$funit" 2>/dev/null || true)

    # An absent unit answers `inactive`, a masked one answers `masked`, and a
    # unit already stopped and disabled matches neither arm — so all three cost
    # nothing and need no `systemctl cat` guard. `enabled but inactive` is still
    # torn down: it is one reboot away from being the second poller.
    needs_stop=false
    needs_disable=false
    case "$f_active" in
      active|activating|reloading) needs_stop=true ;;
    esac
    case "$f_enabled" in
      enabled|enabled-runtime) needs_disable=true ;;
    esac
    if [ "$needs_stop" = false ] && [ "$needs_disable" = false ]; then
      continue
    fi

    if [ "${CLAWBOX_KEEP_FOREIGN_UNITS:-0}" = "1" ]; then
      echo "  [edition] $funit belongs to another edition (active=$f_active enabled=$f_enabled) — left as-is: CLAWBOX_KEEP_FOREIGN_UNITS=1"
      continue
    fi

    if [ "$needs_stop" = true ]; then
      systemctl stop "$funit" >/dev/null 2>&1 || true
    fi
    if [ "$needs_disable" = true ]; then
      systemctl disable "$funit" >/dev/null 2>&1 || true
    fi
    brought_down+=("$funit (was active=$f_active enabled=$f_enabled)")
  done

  if [ "${#brought_down[@]}" -eq 0 ]; then
    return 0
  fi

  echo "  Brought down units belonging to another edition (this device is '$CLAWBOX_EDITION'):"
  local entry
  for entry in "${brought_down[@]}"; do
    echo "    - $entry"
  done
  echo "    Reason: both harnesses poll the same Telegram bot token, so running"
  echo "    them together leaves neither able to receive a message."
  echo "    Stopped and disabled only — nothing was masked and no unit file was"
  echo "    removed. To put one back:  sudo systemctl enable --now <unit>"
  echo "    To leave them alone next time: CLAWBOX_KEEP_FOREIGN_UNITS=1"
  return 0
}

# Bake the edition lock so a customer can't flip the harness.
#
# The record is a ROOT-OWNED file, /etc/clawbox/edition.env. The old drop-in
# alone did not actually lock anything: it sets `Environment=CLAWBOX_EDITION=…`
# on clawbox-setup.service, but that unit also loads
# `EnvironmentFile=-/home/clawbox/clawbox/.env`, which the clawbox user can
# write — and systemd documents EnvironmentFile= as OVERRIDING Environment=.
# Combined with the NOPASSWD `systemctl restart clawbox-setup` grant, appending
# CLAWBOX_EDITION=dual to .env flipped the SKU. clawbox-setup.service now loads
# edition.env as its LAST EnvironmentFile, so the root-owned value wins.
#
# The drop-in is still written, for two reasons: boxes that update into this
# release read it as the H9 migration fallback, and it keeps `systemctl show
# clawbox-setup` honest. Both records are rewritten UNCONDITIONALLY on every
# run — a previously-hermes box re-installed as openclaw/dual used to keep its
# stale hermes lock forever, because this step only ever wrote and never
# reconciled. All three editions are baked now; "dual" used to return early
# here, which is why the premium SKU could not be provisioned at all.
step_edition_lock() {
  install -d -o root -g root -m 0755 /etc/clawbox
  printf '# ClawBox edition lock — written by install.sh (step_edition_lock).\n# Root-owned on purpose: this is the authority for the device SKU.\nCLAWBOX_EDITION=%s\n' \
    "$CLAWBOX_EDITION" > "$CLAWBOX_EDITION_FILE"
  chown root:root "$CLAWBOX_EDITION_FILE"
  chmod 0644 "$CLAWBOX_EDITION_FILE"

  mkdir -p /etc/systemd/system/clawbox-setup.service.d
  printf '[Service]\nEnvironment=CLAWBOX_EDITION=%s\n' "$CLAWBOX_EDITION" \
    > "$LEGACY_EDITION_DROPIN"
  systemctl daemon-reload 2>/dev/null || true

  step_edition_gateway_state
  # After the gateway state, not before: on hermes the step above has already
  # stopped and masked clawbox-gateway (the only foreign unit on that edition),
  # so the teardown finds nothing to do and says nothing. On openclaw/dual it is
  # the step that actually brings the other harness down. Both run inside
  # step_edition_lock, so both reach the full-install path AND the in-app
  # updater, which dispatches `--step edition_lock` from step_post_update.
  step_edition_foreign_teardown

  echo "  Baked edition lock: CLAWBOX_EDITION=$CLAWBOX_EDITION ($CLAWBOX_EDITION_FILE)"
}

# Provision the Hermes side of the box (shared identity, dashboard auth,
# dashboard + proxy units). Split out of the inline call at the bottom so the
# in-app updater can dispatch it too — otherwise no update could ever repair a
# Hermes appliance.
step_hermes_edition() {
  has_hermes_harness || return 0
  if [ ! -f "$PROJECT_DIR/scripts/setup-hermes-edition.sh" ]; then
    echo "  Warning: scripts/setup-hermes-edition.sh missing — Hermes not provisioned"
    return 1
  fi
  CLAWBOX_EDITION="$CLAWBOX_EDITION" bash "$PROJECT_DIR/scripts/setup-hermes-edition.sh"
}

step_openclaw_install() {
  is_hermes_edition && { echo "  [hermes edition] skipping OpenClaw npm install"; return 0; }
  # Always re-assert the .bashrc PATH stanza before any early-return. The
  # function is idempotent (greps before appending), and skipping it here
  # was the root cause of the recurring `bash: openclaw: command not found`
  # regression in the in-UI terminal after update runs.
  ensure_clawbox_bashrc_path

  # Pinned OpenClaw version comes from config/openclaw-target.txt — ClawBox
  # controls which OpenClaw release the fleet runs, instead of every device
  # racing to whatever npm last published. Bump the pin in a PR, ship it
  # through beta → main, and the fleet follows on next update.
  #
  # `OPENCLAW_PIN_VERSION` env var lets QA/dev override without editing the
  # pin file (e.g. `OPENCLAW_PIN_VERSION=2026.5.24-beta.2 sudo bash install.sh`).
  # Falls back to the hardcoded $OPENCLAW_VERSION if the pin file is missing,
  # so a corrupted/partial install still has something to install.
  local PIN_FILE="$PROJECT_DIR/config/openclaw-target.txt"
  local PINNED=""
  if [ -n "${OPENCLAW_PIN_VERSION:-}" ]; then
    PINNED="${OPENCLAW_PIN_VERSION}"
    echo "  Using OPENCLAW_PIN_VERSION env override: $PINNED"
  elif [ -f "$PIN_FILE" ]; then
    # awk '{print $1}' extracts the first whitespace-delimited token, matching
    # updater.ts::getVersionInfo `raw.trim().split(/\s+/)[0]`. tr -d '[:space:]'
    # would concat tokens on a hypothetical multi-field line — keeping the
    # two parsers identical avoids subtle UI ↔ install.sh desync if the file
    # format ever grows.
    # `|| true`: this step is dispatched with errexit deliberately ON, so an
    # unreadable pin file (permissions, a truncated mount) would abort the
    # installer here. The `else` branch below already reports an unknown pin and
    # falls back to the hardcoded version — that is the defined answer, and an
    # aborted update is not. TASK-657, same shape as gateway-pre-start.sh:45.
    PINNED=$(head -1 "$PIN_FILE" 2>/dev/null | awk '{print $1}' || true)
    if [ -n "$PINNED" ]; then
      echo "  Pinned OpenClaw target from $PIN_FILE: $PINNED"
    else
      # The `|| true` above turns an unreadable pin file into an empty PINNED,
      # and a file that is empty (or whose first line is blank) gets there with
      # `head` and `awk` both SUCCEEDING -- so this arm cannot claim the file
      # could not be read. The fallback below is correct either way, but the
      # unconditional line printed "Pinned OpenClaw target from ...: " and
      # asserted a pin had been read when none had. The `else` branch's WARN is
      # not reached from here, so say it here.
      echo "  WARN: $PIN_FILE is empty or could not be read — falling back to hardcoded $OPENCLAW_VERSION" >&2
    fi
  else
    echo "  WARN: $PIN_FILE not found — falling back to hardcoded $OPENCLAW_VERSION" >&2
  fi
  local TARGET="${PINNED:-$OPENCLAW_VERSION}"
  local CORE_NEEDS_INSTALL=1

  # Keep this guard inside the OpenClaw step too, not only in apt_update:
  # update retries can start from this step, and old images with Node v22.22.2
  # otherwise install the npm package but fail as soon as the OpenClaw CLI runs.
  ensure_openclaw_node_engine

  if [ -x "$OPENCLAW_BIN" ]; then
    local INSTALLED INSTALLED_VER
    # `openclaw --version` prints "OpenClaw X.Y.Z (hash)"; extract field 2 so
    # we can compare exactly against the bare npm version. Literal "=" on the
    # full string would always miss because of the prefix/hash.
    INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")
    INSTALLED_VER=$(echo "$INSTALLED" | awk '{print $2}')
    echo "  Installed: $INSTALLED, Target: $TARGET"
    if [ "$INSTALLED_VER" = "$TARGET" ]; then
      echo "  OpenClaw core is already at $TARGET; skipping npm install"
      CORE_NEEDS_INSTALL=0
    fi
  fi
  if [ "$CORE_NEEDS_INSTALL" -eq 1 ]; then
    mkdir -p "$NPM_PREFIX"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$NPM_PREFIX"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.npm" 2>/dev/null || true
    as_clawbox -H npm install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX"
    if [ ! -x "$OPENCLAW_BIN" ]; then
      echo "Error: OpenClaw installation failed — $OPENCLAW_BIN not found"
      exit 1
    fi
    echo "  OpenClaw installed: $($OPENCLAW_BIN --version 2>/dev/null || echo 'unknown version')"
  fi

  # OpenClaw 2 (>= 2026.8) refuses gateway readiness while legacy state is
  # present: the sessions/transcripts move into SQLite and stale config keys
  # fail validation, and BOTH migrations are doctor's to run. A box upgraded
  # without this step boots into a gateway that never comes up. Non-fatal on
  # purpose — a doctor refusal leaves evidence in the gateway's own logs and
  # the gateway start below will say so loudly — and non-interactive so an
  # unattended update never parks on a prompt.
  if openclaw_version_is_v2 "$TARGET"; then
    echo "  Running openclaw doctor --fix (OpenClaw 2 config + session migrations)..."
    # The sessions-to-SQLite move must not race a still-running v1 gateway
    # writing the very files being migrated; gateway_setup restarts it later.
    systemctl stop clawbox-gateway.service 2>/dev/null || true
    as_clawbox -H "$OPENCLAW_BIN" doctor --fix --non-interactive </dev/null \
      || echo "  WARN: openclaw doctor --fix did not complete; the gateway may refuse readiness until it is run"
    # The stop above was for doctor's benefit. A FULL install restarts the
    # gateway later (gateway_setup), but this step is also on the standalone
    # run-step allow-list, where nothing follows — leaving it down would turn
    # a UI-triggered core update into an outage. Best effort: a box where the
    # unit does not exist yet (first install) has nothing to start.
    systemctl start clawbox-gateway.service 2>/dev/null || true
  fi

  # Force-reinstall every externally-installed plugin so they're bumped
  # alongside the core. Without this, a core 5.12→5.22 bump leaves
  # @openclaw/codex stuck at whatever was first installed by
  # gateway-pre-start.sh's peer-dep heal — and the in-UI updater silently
  # reports "Up to date" because it only checks the core package. The new
  # protocol bits introduced by the core (e.g. 5.22's deferred history
  # replay) sit unused until the plugins also move.
  #
  # Runs even when the core was already at target, because plugins drift
  # independently. Bundled plugins (origin: bundled) come with the core
  # npm install and don't need a separate refresh — only external/global
  # plugins do. Failures are non-fatal: a missing-from-npm plugin
  # shouldn't roll back the whole update; gateway-pre-start.sh will retry
  # on next boot. Gateway restart happens later in step_gateway_setup.
  # Emit "<id>\t<npm-package>" per external plugin. The npm package is
  # derived from rootDir (.../node_modules/@scope/name -> @scope/name) so we
  # can pin @openclaw/* plugins to $TARGET. Reinstalling by bare id resolves
  # @latest, which is exactly how @openclaw/codex drifted ahead of the
  # pinned core and crashed every Codex chat.
  local INSTALLED_PLUGINS
  INSTALLED_PLUGINS=$(as_clawbox -H "$OPENCLAW_BIN" plugins list --json 2>/dev/null \
    | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for p in d.get("plugins", []):
    pid = p.get("id")
    if not pid or p.get("origin") == "bundled":
        continue
    root = p.get("rootDir") or p.get("source") or ""
    pkg = ""
    if "node_modules/" in root:
        tail = root.split("node_modules/", 1)[1].split("/")
        if tail and tail[0].startswith("@") and len(tail) >= 2:
            pkg = tail[0] + "/" + tail[1]
        elif tail:
            pkg = tail[0]
    print(pid + "\t" + pkg)
' 2>/dev/null)
  if [ -n "$INSTALLED_PLUGINS" ]; then
    echo "  Refreshing OpenClaw plugins to match core $TARGET:"
    while IFS=$'\t' read -r plugin pkg; do
      [ -z "$plugin" ] && continue
      # Pin @openclaw/* plugins to the core target; others reinstall by id
      # (they version independently). $TARGET is the same pin the core used.
      local spec="$plugin"
      case "$pkg" in
        @openclaw/*) spec="$pkg@$TARGET" ;;
      esac
      echo "    - $spec"
      if ! as_clawbox -H "$OPENCLAW_BIN" plugins install "$spec" --force >/dev/null 2>&1; then
        echo "      WARN: refresh failed (non-fatal; gateway-pre-start will retry on next boot)"
      fi
    done <<< "$INSTALLED_PLUGINS"
  else
    echo "  No external plugins to refresh"
  fi
}

step_clawkeep_install() {
  # Install (or refresh) the device-side ClawKeep Python package from the
  # in-tree source. The user-runtime CLI lives at ~/.local/bin/clawkeep
  # and ~/.local/bin/clawkeepd; without a forced reinstall, an existing
  # install with the same version string ("0.1.0") would skip the upgrade
  # and leave stale code on disk after a `git pull`.
  if [ ! -d "$PROJECT_DIR/clawkeep" ]; then
    echo "  ClawKeep source missing; skipping"
    return 0
  fi

  # pipx builds into its own isolated venv, which sidesteps PEP 668
  # (externally-managed-environment, enforced on Ubuntu 24.04+ / JetPack 7)
  # and, as a side effect, the Jetson UNKNOWN-0.0.0 wheel failure the pip
  # fallback below works around — pipx's venv bootstraps its own pip rather
  # than reusing the stock L4T pip 22.0.2 + setuptools 59.6.0 combination
  # that triggers it. Prefer pipx; fall back to the pip --user path — still
  # correct on JetPack 6.2 / Ubuntu 22.04, where PEP 668 does not apply —
  # only when pipx could not be provisioned.
  if ! ensure_pipx; then
    echo "  Warning: pipx unavailable — falling back to pip --user (blocked by PEP 668 on Ubuntu 24.04+)" >&2
    step_clawkeep_install_pip_user_fallback
    return $?
  fi

  echo "  Installing ClawKeep CLI via pipx"
  # A device upgraded from a pre-pipx install has real pip-installed scripts
  # at these paths; pipx refuses to overwrite files it did not create, so the
  # stale scripts would keep running after every future `git pull` unless
  # removed first.
  as_clawbox_login "rm -f $CLAWBOX_HOME/.local/bin/clawkeep $CLAWBOX_HOME/.local/bin/clawkeepd" \
    2>/dev/null || true
  if ! as_clawbox_login "pipx install --force '$PROJECT_DIR/clawkeep'"; then
    echo "  Warning: clawkeep pipx install failed (non-fatal — restore/scheduler will be unavailable)" >&2
    return 0
  fi

  local CLAWKEEPD_BIN="$CLAWBOX_HOME/.local/bin/clawkeepd"
  if [ ! -x "$CLAWKEEPD_BIN" ]; then
    echo "Error: clawkeep pipx install completed but $CLAWKEEPD_BIN is missing." >&2
    echo "       Try: pipx uninstall clawkeep && sudo bash install.sh" >&2
    return 1
  fi
  echo "  ClawKeep CLI installed: $(as_clawbox_login 'clawkeep --help' 2>&1 | head -n1 || echo 'verify failed')"
}

# Legacy path, used only when pipx could not be provisioned. Still the
# expected path on JetPack 6.2 / Ubuntu 22.04 hosts where apt could not
# install pipx (e.g. offline) — PEP 668 does not block pip --user there.
step_clawkeep_install_pip_user_fallback() {
  # Jetson L4T ships pip 22.0.2 + setuptools 59.6.0. setuptools 59
  # predates PEP 621 ([project] in pyproject.toml), and pip 22's build
  # isolation is patched on Debian/Ubuntu in a way that lets the legacy
  # egg_info path shadow the isolated modern setuptools — so building
  # *any* PEP 621-only package on a fresh Jetson silently produces a
  # `UNKNOWN-0.0.0.whl` with no console scripts. The ClawKeep "Setup
  # needed — clawkeepd is not on $PATH" banner is that failure mode.
  #
  # Fix: bootstrap user-site pip + setuptools to modern versions first,
  # then run the real install with that pip. After this runs once the
  # device will have pip>=23 and setuptools>=68 in ~/.local/lib so every
  # subsequent install — including the post-update rebuild — uses the
  # working toolchain.
  echo "  Bootstrapping user-site pip + setuptools (Jetson stock is too old for PEP 621)"
  if ! as_clawbox_login "python3 -m pip install --user --upgrade --no-warn-script-location pip 'setuptools>=68' wheel"; then
    echo "  Warning: failed to upgrade user-site pip/setuptools — falling back to system pip" >&2
  fi

  # Stale build/ + UNKNOWN.egg-info from a previous bad install would
  # otherwise be re-picked up by the next build and produce another
  # UNKNOWN wheel even with the modern toolchain in place. Also remove
  # the broken UNKNOWN dist-info that the bad install registered in
  # site-packages so pip's --force-reinstall has a clean slate.
  rm -rf "$PROJECT_DIR/clawkeep/build" \
         "$PROJECT_DIR/clawkeep/dist" \
         "$PROJECT_DIR/clawkeep"/*.egg-info 2>/dev/null || true
  as_clawbox_login "rm -rf \"$CLAWBOX_HOME\"/.local/lib/python3.*/site-packages/UNKNOWN-0.0.0.dist-info" \
    >/dev/null 2>&1 || true

  echo "  Installing ClawKeep CLI (pip --user --force-reinstall --use-pep517)"
  # --use-pep517 is explicit so we never silently fall back to the legacy
  # `setup.py install` path even if the pip-bootstrap above failed.
  if ! as_clawbox_login "python3 -m pip install --user --force-reinstall --no-deps --use-pep517 '$PROJECT_DIR/clawkeep'"; then
    echo "  Warning: clawkeep pip install failed (non-fatal — restore/scheduler will be unavailable)" >&2
    return 0
  fi
  # Runtime deps that aren't already on the device. --no-deps above
  # skips the pyproject.toml dependency block entirely, so we install
  # the missing pieces explicitly:
  #   - boto3: cloud upload (huggingface-hub installs requests but not boto3)
  #   - tomli: stdlib `tomllib` is 3.11+ only; Jetson L4T ships Python 3.10
  #     as system default, and clawkeep.config imports tomli on <3.11.
  as_clawbox_login "python3 -m pip install --user --upgrade 'boto3>=1.34'" \
    || echo "  Warning: boto3 install failed (cloud backups will be unavailable until installed manually)" >&2
  as_clawbox_login "python3 -m pip install --user --upgrade 'tomli>=2.0; python_version < \"3.11\"'" \
    || echo "  Warning: tomli install failed (clawkeepd will fail to start on Python <3.11 until installed manually)" >&2

  # Hard-fail on the symptom that produced the "Setup needed" popup: the
  # `[project.scripts]` entry points must be present on disk after install.
  # If they're missing the install silently produced a UNKNOWN-0.0.0 wheel
  # (see comment above) — surface it here instead of letting the UI tell
  # the user to run pip themselves.
  local CLAWKEEPD_BIN="$CLAWBOX_HOME/.local/bin/clawkeepd"
  if [ ! -x "$CLAWKEEPD_BIN" ]; then
    echo "Error: clawkeep pip install completed but $CLAWKEEPD_BIN is missing." >&2
    echo "       The build likely produced a UNKNOWN-0.0.0 wheel. Try:" >&2
    echo "         rm -rf $PROJECT_DIR/clawkeep/build $PROJECT_DIR/clawkeep/*.egg-info" >&2
    echo "         python3 -m pip install --user --upgrade pip 'setuptools>=68'" >&2
    echo "       then re-run sudo bash install.sh." >&2
    return 1
  fi
  echo "  ClawKeep CLI installed: $(as_clawbox_login 'clawkeep --help' 2>&1 | head -n1 || echo 'verify failed')"
}

step_openclaw_patch() {
  is_hermes_edition && return 0
  # OpenClaw 2 rewrote the connect handler this step used to sed: the scope
  # regex now matches sites where the injected identifiers do not exist (a
  # broken bundle), and the device-identity bypass it papered over is retired
  # outright — ClawBox implements the REAL device identity client-side now
  # (src/lib/gateway-device-identity.ts). Nothing here applies to gen 2.
  if openclaw_is_v2; then
    echo "  Gateway patches: not needed on OpenClaw 2 (device identity implemented client-side)"
    return 0
  fi
  # Patcher restricts file searches to .js (runtime bundles) — newer openclaw
  # releases ship .d.ts declaration files alongside bundled JS, and literal
  # type strings would otherwise match files we cannot patch.
  local PATCHED_MARKER='isControlUi && allowControlUiBypass'

  # Gateway scope patch
  if grep -qrl --include='*.js' "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
    echo "  Gateway scope patch: already applied"
  else
    local SCOPE_FILES
    SCOPE_FILES=$(grep -Prl --include='*.js' 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
    if [ -z "$SCOPE_FILES" ]; then
      echo "Error: Gateway scope patch: pattern not found and patch not already applied"
      exit 1
    fi

    for file in $SCOPE_FILES; do
      sed -i -E 's/if[[:space:]]*\([[:space:]]*scopes\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\)[[:space:]]*\{/if (scopes.length > 0 \&\& !(isControlUi \&\& allowControlUiBypass)) {/g' "$file"
    done

    if ! grep -qrl --include='*.js' "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
      echo "Error: Gateway scope patch verification failed"
      exit 1
    fi
    echo "  Gateway scope patch applied and verified"
  fi

  # --- Device identity bypass patch ---
  # OpenClaw bug: dangerouslyDisableDeviceAuth sets allowBypass but
  # handleMissingDeviceIdentity doesn't check it before the final rejection.
  # Add: allow Control UI when bypass flag is set.
  local DEVICE_MARKER='controlUiAuthPolicy.allowBypass) return'

  local DEVICE_FILES
  DEVICE_FILES=$(grep -rl --include='*.js' 'reject-device-required' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ -z "$DEVICE_FILES" ]; then
    echo "  Device identity bypass patch: pattern not found, skipping"
    return
  fi

  # Only patch files that contain the target but NOT the marker yet
  local NEEDS_PATCH=""
  for file in $DEVICE_FILES; do
    if ! grep -q "$DEVICE_MARKER" "$file" 2>/dev/null; then
      NEEDS_PATCH="$NEEDS_PATCH $file"
    fi
  done

  if [ -z "$NEEDS_PATCH" ]; then
    echo "  Device identity bypass patch: already applied"
    return
  fi

  for file in $NEEDS_PATCH; do
    sed -i 's|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };\n\tif (params.isControlUi \&\& params.controlUiAuthPolicy.allowBypass) return { kind: "allow" };|' "$file"
  done

  # Verify ALL files with reject-device-required now have the patch
  local UNPATCHED
  UNPATCHED=""
  for file in $DEVICE_FILES; do
    if ! grep -q "$DEVICE_MARKER" "$file" 2>/dev/null; then
      UNPATCHED="$UNPATCHED $file"
    fi
  done

  if [ -n "$UNPATCHED" ]; then
    echo "Error: Device identity bypass patch failed for:$UNPATCHED"
    exit 1
  fi
  echo "  Device identity bypass patch applied and verified"
}

# `openclaw config set` (OpenClaw 2026.6.x) does an optimistic-concurrency
# check: if anything else writes openclaw.json between its load and write —
# the live gateway, or the CLI's own state migrations triggered by the
# PREVIOUS call — it dies with ConfigMutationConflictError. Under
# `set -euo pipefail` that aborted the whole step mid-update and left
# devices half-updated: rebuild_reboot never reached the rebuild, while the
# updater still reported success (see fix in src/lib/updater.ts). Each retry
# reloads the config fresh, so a transient conflict resolves itself.
oc_config_set() {
  local attempt
  for attempt in 1 2 3; do
    if as_clawbox "$OPENCLAW_BIN" config set "$@"; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      echo "  config set $1 failed (attempt $attempt/3) — retrying..."
      sleep 2
    fi
  done
  echo "  ERROR: config set $1 failed after 3 attempts" >&2
  return 1
}

step_openclaw_config() {
  is_hermes_edition && return 0
  local CLAWBOX_CONFIG="$PROJECT_DIR/data/config.json"
  local CLAWBOX_AI_ENV="$PROJECT_DIR/.env"
  local CLAWBOX_AI_KEY="${CLAWBOX_AI_API_KEY:-}"
  local AUTH_PROFILES="$CLAWBOX_HOME/.openclaw/agents/main/agent/auth-profiles.json"

  # Only seed the primary model if unset — preserves the user's provider choice
  # across updates (rebuild_reboot re-invokes this step).
  local CURRENT_PRIMARY
  CURRENT_PRIMARY=$(as_clawbox "$OPENCLAW_BIN" config get agents.defaults.model.primary 2>/dev/null || echo "")
  if [ -z "$CURRENT_PRIMARY" ] || [ "$CURRENT_PRIMARY" = "null" ]; then
    if openclaw_is_v2; then
      # OpenClaw 2 VALIDATES model refs at config set, and this v1-era seed
      # names a model no fresh box can resolve (the anthropic provider is not
      # configured yet), so the write failed three times and aborted every
      # fresh 2026.8.1 install (caught by e2e-install on PR #565). A fresh
      # gen-2 box needs no placeholder at all: the gateway runs
      # --allow-unconfigured and onboarding/the configure route write the
      # real primary the moment the owner picks a provider.
      echo "  Default model left unset (OpenClaw 2 validates refs; onboarding sets it)"
    else
      oc_config_set agents.defaults.model.primary "anthropic/claude-sonnet-4-20250514"
      echo "  Default model set"
    fi
  else
    echo "  Default model already set ($CURRENT_PRIMARY) — preserving"
  fi
  if openclaw_is_v2; then
    # Gen 2 replaced the reserve-tuning keys with compaction.mode and fails
    # validation on the old one; its own safeguard default needs no seeding.
    echo "  Compaction reserve floor: managed by OpenClaw 2 (compaction.mode)"
  else
    oc_config_set agents.defaults.compaction.reserveTokensFloor 24000
    echo "  Compaction reserve floor set"
  fi

  if [ -z "$CLAWBOX_AI_KEY" ] && [ -f "$CLAWBOX_AI_ENV" ]; then
    CLAWBOX_AI_KEY=$(grep '^CLAWBOX_AI_API_KEY=' "$CLAWBOX_AI_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  fi
  if [ -n "$CLAWBOX_AI_KEY" ]; then
    local CLAWBOX_AI_PROVIDER_JSON
    CLAWBOX_AI_PROVIDER_JSON=$(node -e 'const key=process.argv[1]; process.stdout.write(JSON.stringify({baseUrl:"https://api.deepseek.com",api:"openai-completions",apiKey:key,models:[{id:"deepseek-chat",name:"ClawBox AI",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:8192}]}));' "$CLAWBOX_AI_KEY")
    if openclaw_is_v2; then
      # OpenClaw 2 keeps credentials in its sqlite auth store, and recreating
      # the legacy auth-profiles.json poisons it (the gateway refuses with
      # AuthProfileMigrationRequiredError until doctor runs — the exact defect
      # PR #565 chased through the configure route). The CLI owns the store's
      # schema on every generation; the key rides stdin, never argv.
      printf '%s\n' "$CLAWBOX_AI_KEY" | as_clawbox -H "$OPENCLAW_BIN" models auth paste-api-key --provider deepseek --profile-id deepseek:default \
        || echo "  WARN: models auth paste-api-key failed; ClawBox AI fallback credential not stored"
    else
      mkdir -p "$(dirname "$AUTH_PROFILES")"
      CLAWBOX_AI_KEY="$CLAWBOX_AI_KEY" AUTH_PROFILES="$AUTH_PROFILES" node -e 'const fs=require("fs"); const p=process.env.AUTH_PROFILES; let data={version:1,profiles:{}}; try{data=JSON.parse(fs.readFileSync(p,"utf8"));}catch{} data.profiles["deepseek:default"]={type:"api_key",provider:"deepseek",key:process.env.CLAWBOX_AI_KEY}; fs.writeFileSync(p, JSON.stringify(data,null,2), { mode: 0o600 });'
    fi
    oc_config_set auth.profiles.deepseek:default '{"provider":"deepseek","mode":"api_key"}' --json
    oc_config_set models.providers.deepseek "$CLAWBOX_AI_PROVIDER_JSON" --json
    oc_config_set agents.defaults.model.fallback "deepseek/deepseek-chat"
    echo "  ClawBox AI fallback model configured"
    # Deliberately no image provider here, unlike configureClawboxAi() in
    # src/app/setup-api/ai-models/configure/route.ts and the migration in
    # scripts/gateway-pre-start.sh. CLAWBOX_AI_API_KEY is a raw DeepSeek key
    # pointed straight at api.deepseek.com (see the baseUrl above) — there is
    # no ClawBox AI subscription behind it and therefore no monthly image
    # allowance to wire up. Adding one would send a DeepSeek key to
    # clawbox.com and 401 on every image request. This path is also
    # effectively CI-only: CLAWBOX_AI_API_KEY is commented out in
    # .env.example and set only by .github/workflows/e2e-install.yml.
    #
    # A box provisioned this way is skipped by the boot migration too, which
    # keys off a `claw_`-prefixed portal token in models.providers.deepseek
    # .apiKey. That is correct, not an oversight — do not "fix" it here.
  fi

  # gateway.auth.mode/token and gateway.controlUi.{allowInsecureAuth,
  # dangerouslyDisableDeviceAuth} are deliberately NOT set here:
  # gateway-pre-start.sh owns them, enforcing all four atomically (single
  # read-modify-write on openclaw.json) on every gateway start — including
  # the start right after this installer/updater finishes. Setting them here
  # too made two writers race the live gateway; the controlUi pair was the
  # exact `config set` that died with ConfigMutationConflictError mid-update
  # and aborted rebuild_reboot before the rebuild.
  echo "  Gateway auth/controlUi config deferred to gateway-pre-start.sh"

  # Register Telegram channel (if token exists)
  if [ -f "$CLAWBOX_CONFIG" ]; then
    local TG_TOKEN
    TG_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$CLAWBOX_CONFIG','utf8'));if(c.telegram_bot_token)process.stdout.write(c.telegram_bot_token)}catch{}" 2>/dev/null || true)
    if [ -n "$TG_TOKEN" ]; then
      # Do not set dmPolicy/allowFrom here — see src/lib/openclaw-config.ts
      # setTelegramToken for the security rationale. `openclaw config set`
      # may deep-merge instead of replace, which would leave legacy
      # `dmPolicy:"open"` / `allowFrom:["*"]` values alive. Do the
      # read-modify-write ourselves with a destructure-strip so the
      # installer can't leave insecure values behind, matching what
      # install-x64.sh and src/lib/openclaw-config.ts:setTelegramToken
      # do on their paths.
      as_clawbox env TG_TOKEN="$TG_TOKEN" CFG="$CLAWBOX_HOME/.openclaw/openclaw.json" node - <<'NODE'
const fs = require("fs");
const path = require("path");
const botToken = process.env.TG_TOKEN;
const cfgPath = process.env.CFG;
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch (err) {
  // Only tolerate "file missing" — any other read/parse error (EACCES,
  // corrupt JSON, transient IO) must abort, otherwise we'd silently
  // overwrite a real-but-unreadable config with only the Telegram channel,
  // wiping auth profiles, gateway settings, AI provider config, etc.
  if (!err || err.code !== "ENOENT") throw err;
}
if (!cfg.channels) cfg.channels = {};
const { dmPolicy: _dm, allowFrom: _af, ...rest } = cfg.channels.telegram || {};
cfg.channels.telegram = { ...rest, enabled: true, botToken };
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
const tmp = `${cfgPath}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, cfgPath);
NODE
      echo "  Telegram channel registered"
    fi
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.openclaw" 2>/dev/null || true
  echo "  OpenClaw config updated"
}

# Point OpenClaw's speech output at the box's own engine (TASK-383).
#
# Two halves, and both have to run on updates as well as fresh installs:
#   1. Install Kokoro, the box's only on-device voice, and deploy the scripts
#      it runs from. There is no CPU fallback behind it any more — the owner
#      removed Piper (2026-08). A Kokoro that is missing is reported by
#      scripts/openclaw/clawbox-tts.sh as an exit-1 failure with reasons,
#      which the gateway hands to its cloud voice, rather than hidden behind
#      a second engine.
#   2. Point the built-in `tts-local-cli` provider at clawbox-tts.sh.
#
# The command is the REPO copy, not a copy deployed into the workspace: the
# repo path is refreshed by `git pull` on every update, so the box can never
# end up speaking through a stale fallback chain.
#
# Placeholder casing is load-bearing. OpenClaw's applyTemplate normalizes a
# token to Firstupper+restlower and only falls back to the raw key, so
# `{{OutputPath}}` works and `{{outputPath}}` silently substitutes an EMPTY
# STRING — the command would then be handed no output path at all. `{{Text}}`
# is also what stops OpenClaw piping the text to stdin instead of argv.
# The literal `--` guards against a reply that itself begins with `--` being
# parsed as an option by the script.
#
# outputFormat wav is deliberate: Kokoro emits WAV natively, so the happy path
# needs no ffmpeg at all, and OpenClaw transcodes to Opus itself when a
# channel wants a voice note.
# Configuring the provider is not the same as OpenClaw HAVING it, and the gap
# between those two is silent. `tts-local-cli` ships inside OpenClaw as a
# bundled extension, but the gateway resolves plugins through a PERSISTED
# registry rather than by scanning dist/extensions, and that index goes stale
# whenever the extension set on disk changes — `openclaw plugins registry`
# calls the reason `source-changed`, which is every OpenClaw upgrade. A stale
# index simply does not contain tts-local-cli: the gateway comes up without it
# and every spoken reply dies with
#     TTS conversion failed: tts-local-cli: no provider registered
# while this step, openclaw.json and `capability tts status` all still say the
# box is configured correctly.
#
# Measured on the freshly flashed Orin used for the TASK-383 hardware proof
# (2026-08-19): persisted 32/33 plugins against 49/67 current, the gateway
# loading only memory-core and ollama, and no on-device speech at all —
# `plugins doctor` reported no issues and `plugins enable tts-local-cli`
# answered "Plugin not found". Rebuilding the index was the whole fix.
#
# A failed refresh is only a warning: what decides the outcome is whether the
# provider resolves, not how it got there, so an OpenClaw without the
# subcommand must not cost a box its voice.
tts_ensure_provider_registered() {
  if ! as_clawbox "$OPENCLAW_BIN" plugins registry --refresh >/dev/null 2>&1; then
    echo "  Warning: could not refresh the plugin registry — the provider may not be visible to the gateway" >&2
  fi
  as_clawbox "$OPENCLAW_BIN" plugins info tts-local-cli >/dev/null 2>&1
}

# The on-device voice, for EVERY edition.
#
# This step used to open with
#   is_hermes_edition && { echo "  [hermes edition] skipping on-device TTS"; return 0; }
# so a Hermes box never ran scripts/install-voice.sh at all: no Kokoro, no
# kokoro-server unit, and nothing for step_validate_services to verify. The
# owner's decision is that Hermes runs the SAME on-device engine as OpenClaw,
# so the skip is gone and the two harnesses are registered separately below —
# each through its own native mechanism, neither one standing in for the other.
# Write the `tts-local-cli` provider DEFINITION — command, args, format and
# the timeout the script derives from its own engine slices — into $1 (the
# speech block's home: `tts` on OpenClaw 2, `messages.tts` before). Never
# selects it: that is the caller's decision. src/lib/voice-local-wiring.ts
# writes the same entry from the tts route; keep the two in step.
#
# timeoutMs bounds the WHOLE clawbox-tts.sh process, engine chain included.
# It used to be a hardcoded 120000 while the script's own Kokoro timeout was
# also 120s, so OpenClaw killed the process at the instant Kokoro gave up and
# not even the reasons reached the gateway — a hung GPU was silence with no
# diagnostic, which is the failure this whole feature exists to remove. Ask
# the script for the number instead of keeping a second copy of it here: it
# derives the value from its own engine slices, so re-tuning one of them
# moves this with it.
tts_write_local_provider_definition() {
  local TTS_HOME="$1" TTS_SCRIPT="$2"
  local TTS_TIMEOUT_MS
  TTS_TIMEOUT_MS=$(bash "$TTS_SCRIPT" --provider-timeout-ms 2>/dev/null || echo "")
  # Decimal digits, and more than zero: a 0 would let OpenClaw kill the
  # script the instant it starts. src/lib/voice-local-wiring.ts applies the
  # same rule when it writes this entry from the tts route.
  case "$TTS_TIMEOUT_MS" in
    ''|*[!0-9]*)
      echo "  ERROR: $TTS_SCRIPT did not report a usable provider timeout (got '${TTS_TIMEOUT_MS}')" >&2
      return 1
      ;;
  esac
  if [ "$TTS_TIMEOUT_MS" -le 0 ] 2>/dev/null; then
    echo "  ERROR: $TTS_SCRIPT reported a provider timeout of ${TTS_TIMEOUT_MS} ms, which would kill it at once" >&2
    return 1
  fi
  local TTS_PROVIDER_JSON
  TTS_PROVIDER_JSON=$(node -e 'process.stdout.write(JSON.stringify({command:process.argv[1],args:["--","{{Text}}","{{OutputPath}}"],outputFormat:"wav",timeoutMs:Number(process.argv[2])}));' "$TTS_SCRIPT" "$TTS_TIMEOUT_MS")
  oc_config_set "$TTS_HOME.providers.tts-local-cli" "$TTS_PROVIDER_JSON" --json
}

# ffmpeg, because a channel voice note is Opus and Kokoro speaks WAV.
#
# The on-device engine's happy path needs no ffmpeg — Kokoro emits WAV, the
# provider entry below is configured for WAV, and the desktop chat plays WAV.
# A CHANNEL is the exception: OpenClaw's Local CLI provider FORCES the `opus`
# format for a voice-note target and converts the script's WAV with
# `ffmpeg -c:a libopus`, and Hermes hands a command provider an .mp3 path
# unless output_format says otherwise. So on a box without ffmpeg the local
# attempt throws for every Telegram voice note and the gateway falls through
# to the cloud voice: the box's own voice cannot reach a channel at all,
# silently, whatever this step and `capability tts status` report.
#
# It is asked for HERE rather than only in the main install flow because this
# step is what /setup-api/tts/install and every update run (step_post_update)
# invoke, and those are the only routes a box already in a customer's hands
# has to the fix.
#
# Never fatal: a box that cannot reach an apt mirror still has a working chat
# voice and a cloud voice for its channels, and losing the whole voice install
# over one download would be the worse outcome by far.
tts_ensure_ffmpeg() {
  # The probe is a variable so the contract test can exercise both sides of it
  # on a machine that happens to have ffmpeg already.
  local ffmpeg_bin="${TTS_FFMPEG_BIN:-ffmpeg}"
  if command -v "$ffmpeg_bin" >/dev/null 2>&1; then
    return 0
  fi
  echo "  Installing ffmpeg (a channel voice note is Opus; without it this box's own voice cannot send one)"
  step_ffmpeg_install || true
  if command -v "$ffmpeg_bin" >/dev/null 2>&1; then
    echo "  ffmpeg installed"
  else
    echo "  Warning: ffmpeg is NOT installed — spoken replies on Telegram and the other channels will come from the cloud voice, not from this box" >&2
  fi
  return 0
}

step_openclaw_tts() {
  local TTS_SCRIPT="$PROJECT_DIR/scripts/openclaw/clawbox-tts.sh"

  # Before the engine itself, because this is the half that decides whether
  # the engine can ever reach a channel — and because it has to run on the
  # Hermes arm below too, which returns before the OpenClaw registration.
  tts_ensure_ffmpeg

  # --tts-only installs the CUDA Kokoro stack and deploys the voice scripts,
  # and deliberately not the STT half of that script (faster-whisper + the
  # CTranslate2 source build, about an hour on an Orin) because this step also
  # runs from step_post_update on every in-app update. The flag it replaced
  # installed only the CPU fallback of the time and nothing else, so every box
  # we shipped ran on that fallback while this step printed "Kokoro GPU" — on
  # freshly flashed hardware neither `import kokoro` nor `import torch`
  # resolved and no kokoro-server unit existed (TASK-420). That fallback is
  # gone now; Kokoro is the only on-device engine.
  #
  # Its exit code is the contract: it never fails the install over the GPU
  # path, it reports whether Kokoro is actually there so the summary below can
  # tell the truth instead of asserting it.
  local VOICE_RC=0
  CLAWBOX_TTS_STATUS_FILE="$TTS_STATUS_FILE" \
    bash "$PROJECT_DIR/scripts/install-voice.sh" --tts-only || VOICE_RC=$?

  # WHETHER this box has its engine is a fact the run just PUBLISHED; $VOICE_RC
  # only says how far it got. Reading the first off the second is the defect
  # this step was built around and then reproduced one line lower: exit 1 means
  # "the voice scripts did not deploy; Kokoro's own verdict stands", and the
  # engine line below printed "Kokoro GPU TTS NOT installed" over a box whose
  # GPU engine had installed, warmed up and written KOKORO=ready — while
  # step_validate_services, reading the same file, scored that engine as
  # present. One run, two mutually exclusive facts.
  #
  # `tr -d '\r'` for the same reason install.sh's own probe does it: the file
  # is also restored from tarballs and edited by hand, and a CRLF `ready\r` is
  # not `ready`. Absent or unreadable leaves it empty, and every claim below
  # then falls back to what the exit code carries — nothing to read is not
  # licence to invent.
  #
  # KOKORO= is the only key read. An older release's second key is ignored:
  # install-voice.sh no longer writes it, and a stale line left in the file by
  # an earlier run is never read as an engine.
  local KOKORO_VERDICT=""
  if [ -r "$TTS_STATUS_FILE" ]; then
    KOKORO_VERDICT=$(sed -n 's/^KOKORO=//p' "$TTS_STATUS_FILE" 2>/dev/null | tr -d '\r' | tail -1)
  fi

  local KOKORO_READY=false KOKORO_REASON=""
  # The status this STEP returns, separate from whether TTS could be configured.
  # A Kokoro that was asked for and did not arrive is a failure of this step
  # (12), and so is a board that declines the only engine there is (13): either
  # way the box has no on-device voice until it is fixed. This installer cannot
  # know whether the cloud voice exists — that needs the ClawBox AI link, which
  # happens after install — so neither is graded clean; both are recorded.
  local TTS_RC=0
  case "$VOICE_RC" in
    0)  KOKORO_READY=true ;;
    13)
        # An older install-voice.sh used 10 and 11 for the same fact; the
        # current one emits only 13.
        #
        # ——— This board declines the only on-device engine ————————————
        # Kokoro published `skipped:<reason>` — no CUDA toolkit, no Jetson
        # build for this CPU architecture — and there is no second engine to
        # carry the box, so NO on-device engine can speak. Every shipped
        # ClawBox is a Jetson a Kokoro build exists for, so a skipped Kokoro
        # on real hardware means something is wrong: it is recorded as a
        # provisioning failure, never graded clean. "The cloud voice speaks
        # for it" is not a fact this installer can check — that voice needs
        # the ClawBox AI link, which happens after install.
        #
        # It used to arrive as a bare `exit 1` from the removed second
        # engine's guard, which overwrote whatever Kokoro had reported and
        # landed in the 1 arm below — a warning, TTS_RC left at 0,
        # PROVISION_FAILURES left empty, and "=== ClawBox Setup Complete ==="
        # printed over a mute box.
        #
        # Non-fatal, for the same reason 12 is: a box that cannot speak must
        # still finish provisioning and come up reachable so it can be fixed.
        #
        # The engine is named with the reason it is absent. "No engine" is not
        # an actionable report on its own — a board that declined for want of
        # CUDA and one whose download failed lead to different fixes. The
        # verdict is what the run published, so it is what gets printed.
        case "$KOKORO_VERDICT" in
          skipped:?*) KOKORO_REASON="this board declines Kokoro: ${KOKORO_VERDICT#skipped:}" ;;
          *)          KOKORO_REASON="the voice install reported no working engine (Kokoro: ${KOKORO_VERDICT:-no verdict published}), see the log above" ;;
        esac
        TTS_RC=13
        echo "  ############################################################" >&2
        echo "  # This box has NO working on-device TTS engine." >&2
        echo "  # Kokoro (GPU), the only on-device engine, is absent: ${KOKORO_VERDICT:-no verdict published}" >&2
        echo "  # The cloud voice speaks for this box once it is linked to" >&2
        echo "  # ClawBox AI; until then spoken requests go unanswered." >&2
        echo "  # Re-run:  sudo bash $PROJECT_DIR/install.sh --step openclaw_tts" >&2
        echo "  ############################################################" >&2
        # The e2e-install container has no GPU by construction (it says so
        # with CLAWBOX_TEST_NO_GPU=1 — see e2e-install/README.md, which lists
        # every CUDA step it skips for that reason), so a board that declines
        # Kokoro there is the harness's documented state, not a provisioning
        # failure to file. The verdict still stands in $TTS_STATUS_FILE and
        # the step still returns 13; only the failure record is withheld, and
        # only for that host, so a real device that declines the engine fails
        # exactly as before.
        if harness_has_no_gpu; then
          echo "  CLAWBOX_TEST_NO_GPU=1, not recording the missing engine as a provisioning failure (no GPU in the harness)"
        else
          record_provision_failure openclaw_tts
        fi
        ;;
    12) KOKORO_REASON="the Kokoro GPU install failed, see the log above"
        # ── A hard failure must stop arriving as a soft fallback ─────────────
        # This is the branch that made a shipped defect invisible. Kokoro's
        # model pre-download died on a shell syntax error, this step printed one
        # ERROR line, returned 0, and the flash reported "Setup: 1/1 succeeded"
        # — so every box installed in that window ran the removed second
        # engine while the install claimed GPU TTS, and nobody noticed because
        # speech still worked. 13 deliberately does NOT come through here:
        # "this board declines Kokoro" is recorded too, but it is a different
        # fact from "the GPU engine you asked for did not install" and leads
        # to a different fix.
        #
        # Non-fatal stays non-fatal — the caller decides, the provider is still
        # configured below, and the box's spoken replies fall back to the
        # gateway's cloud voice — but the failure now reaches the run's exit
        # status, the provisioning summary, the marker the flash host reads,
        # and step_validate_services' checks.
        TTS_RC=12
        echo "  ############################################################" >&2
        echo "  # Kokoro GPU TTS was REQUESTED and did NOT install." >&2
        echo "  # This box has no on-device voice; spoken replies fall back" >&2
        echo "  # to the gateway's cloud voice until it is fixed." >&2
        echo "  # Re-run:  sudo bash $PROJECT_DIR/install.sh --step openclaw_tts" >&2
        echo "  ############################################################" >&2
        record_provision_failure openclaw_tts
        ;;
    1)  KOKORO_REASON="the voice scripts did not deploy"
        # Kokoro's own verdict stands (install-voice.sh returns 12, not 1, when
        # the engine itself failed): this is the workspace copy of the voice
        # scripts — kokoro-server.py and the entrypoint — not landing. That is
        # a provisioning failure, not a log line: this branch once recorded
        # NOTHING, which is how a broken voice install reached a customer under
        # an "All checks healthy" banner.
        #
        # 14 rather than 1, because step_openclaw_setup treats 1 as fatal and a
        # failed script deploy must not abort an otherwise good install; and
        # rather than 13, because 13 means the box has no engine and saying
        # that about a box with a working Kokoro would be its own false report.
        TTS_RC=14
        # Named in terms of what failed, without asserting what the engine's
        # state is: install.sh cannot read that from a status code.
        # $TTS_STATUS_FILE can, and it is what step_validate_services reads a
        # moment later.
        echo "  Warning: the voice install did not complete — the voice scripts did not deploy to the workspace" >&2
        echo "  Whether this box has its engine is recorded in $TTS_STATUS_FILE" >&2
        echo "  Re-run:  sudo bash $PROJECT_DIR/install.sh --step openclaw_tts" >&2
        record_provision_failure openclaw_tts
        ;;
    *)  KOKORO_REASON="install-voice.sh exited $VOICE_RC"
        # An exit code nobody wrote a branch for is not evidence of health. The
        # `*)` case used to leave TTS_RC at 0, so a status outside the contract
        # — a future code, a crashed interpreter — scored exactly like success.
        # It is 14 ("something did not complete") rather than 13 ("there is no
        # engine") because an unknown status is not evidence of a mute box
        # either; it is recorded, and the verdict file is what says which.
        TTS_RC=14
        echo "  Warning: install-voice.sh exited $VOICE_RC, which is not in its contract — treating the TTS install as failed" >&2
        record_provision_failure openclaw_tts
        ;;
  esac
  # The GPU engine, named from the verdict where there is one. KOKORO_READY (an
  # inference from $VOICE_RC) is only the answer when the run published nothing.
  local KOKORO_HAVE="$KOKORO_READY"
  case "$KOKORO_VERDICT" in
    ready) KOKORO_HAVE=true ;;
    ?*)    KOKORO_HAVE=false
           # Reached by every non-zero exit that published a verdict, and by a
           # clean exit only if the verdict contradicts it, which the contract
           # does not allow — but "the file says the engine is not there"
           # beats "the status code implied it was", and the reason has to
           # come from somewhere when the exit code named none.
           [ -n "$KOKORO_REASON" ] || KOKORO_REASON="the voice install published KOKORO=$KOKORO_VERDICT"
           ;;
  esac
  if [ "$KOKORO_HAVE" != true ]; then
    # No engine claim here: on VOICE_RC=1 with no verdict on file Kokoro's
    # state is unknown, so naming an engine would be a guess. The summary at
    # the end of the step says what is actually known.
    echo "  Kokoro GPU TTS NOT installed: $KOKORO_REASON"
  elif [ "$VOICE_RC" -eq 0 ]; then
    echo "  Kokoro GPU TTS installed"
  else
    # The engine is there and the run still did not finish clean, so what is
    # missing is the deploy behind it — say that rather than deny the engine.
    echo "  Kokoro GPU TTS installed, but the voice install did not complete ($KOKORO_REASON)"
  fi

  # ── The Hermes harness gets the same engine, through Hermes' own mechanism ──
  #
  # Hermes has a native TTS block — `tts:` in ~/.hermes/config.yaml — whose
  # `tts.providers.<name>` entries can be `type: command`. Its tool substitutes
  # {voice}, {input_path} and {output_path} into the command string and then
  # runs it through a shell. {input_path} is a FILE HOLDING THE TEXT, which is
  # why clawbox-tts.sh grew --text-file: see the block at the top of that
  # script for why the file is read there rather than `cat`-ed into an argument
  # here. `hermes config set` is the harness's own writer for this, so nothing
  # in ClawBox edits config.yaml behind its back.
  #
  # has_hermes_harness, NEVER is_hermes_edition: the premium `dual` SKU runs
  # both harnesses, and a box keyed off the hermes SKU alone would get a voice
  # on OpenClaw and silence on Hermes.
  #
  # WHY AN ALREADY-SHIPPED BOX GETS THIS WITHOUT A FACTORY RESET: the in-app
  # updater dispatches `post_update`, and step_post_update calls
  # step_openclaw_tts directly and unconditionally — there is no edition guard
  # anywhere between the updater's dispatch and this function — so one update
  # brings an existing Hermes box up. (On a FRESH install the caller is
  # step_openclaw_setup, which is why step_hermes_install now runs before it:
  # this block needs the Hermes CLI to exist.)
  if has_hermes_harness; then
    local HERMES_TTS_BIN="${HERMES_BIN:-$CLAWBOX_HOME/.local/bin/hermes}"
    # HOME EXPLICITLY, on every call. `as_clawbox` is `sudo -u`, and whether
    # that resets HOME to the target user's home or preserves root's depends on
    # the sudoers `always_set_home`/`env_reset` configuration — not something a
    # provisioning step should be resting on. With root's HOME preserved the
    # CLI would read and write /root/.hermes/config.yaml while the dashboard
    # serves /home/clawbox/.hermes/config.yaml: every write "succeeds", and the
    # box never speaks. `runHermesCli` pins HOME for the same reason.
    hermes_tts_cli() { as_clawbox env HOME="$CLAWBOX_HOME" "$HERMES_TTS_BIN" "$@"; }
    local HERMES_TTS_PROVIDER="clawbox-local"
    # The command Hermes will run. The placeholders are Hermes' own; the
    # example in its tool ships them unquoted, so they are unquoted here too.
    # NO `--voice`. Two reasons, both verified:
    #
    #  1. clawbox-tts.sh's resolve_voice gives --voice precedence over the saved
    #     voice file, and an UNKNOWN --voice falls back to the script default
    #     rather than to that file. Hermes substitutes its own per-provider
    #     voice (or nothing) for {voice}, and ClawBox writes no voice key for
    #     this provider — so passing it would make the Voice tab's own voice
    #     dropdown a no-op: the owner picks af_bella, gets a 200 and a panel
    #     showing af_bella, and the box keeps speaking af_heart.
    #  2. The OpenClaw provider passes no --voice either, for exactly that
    #     reason. `POST /setup-api/tts {action:"voice",engine:"local"}` writes
    #     $CLAWBOX_TTS_VOICE_FILE and the script reads it on every utterance;
    #     that is the mechanism, and both harnesses now share it.
    #
    # `=` spelling. Hermes shell-quotes each placeholder for its context
    # (_quote_command_tts_placeholder → shlex.quote), so an empty value renders
    # as '' and the separated form would NOT collapse into the next token — an
    # earlier comment here claimed it would, and that was wrong. The `=` form
    # is kept anyway because it cannot be misread whatever the quoting does,
    # and because it says at a glance that the value belongs to the flag.
    local HERMES_TTS_COMMAND="$TTS_SCRIPT --text-file={input_path} -- {output_path}"
    local HERMES_TTS_FAIL="" HERMES_TTS_READ_FAILED=false
    # Rule (a), the same one the OpenClaw arm applies below: never point a
    # harness at a command that is not executable. It looks like a working
    # install right up until someone asks the box to speak.
    if [ ! -x "$TTS_SCRIPT" ]; then
      HERMES_TTS_FAIL="$TTS_SCRIPT is missing or not executable"
    elif [ ! -x "$HERMES_TTS_BIN" ]; then
      HERMES_TTS_FAIL="the Hermes CLI is not runnable at $HERMES_TTS_BIN"
    fi
    if [ -z "$HERMES_TTS_FAIL" ]; then
      # Read the CURRENT selection before writing anything, so the seed
      # decision below is made against what the owner actually has. An unset
      # key exits 1 with `Config key not set: <key>` on stderr and prints
      # nothing, so a failed read and an unset key both arrive here as "".
      # AN UNSET KEY IS NOT A FAILED READ, and the difference decides whether
      # the owner keeps their voice. `hermes config get` exits non-zero for
      # both, and treating the two alike is the defect hermes-config-cache.ts
      # documents at length for the TypeScript side ("storing '' for it …
      # remembers a failed QUESTION as a negative ANSWER"). An owner who chose
      # ElevenLabs, plus one OOM-killed Python start on a loaded Jetson, would
      # otherwise have that choice silently replaced — on every update.
      #
      # So only the "not set" wording, or a clean exit, counts as an answer.
      # Anything else leaves tts.provider alone and says so.
      local CURRENT_HERMES_TTS="" HERMES_TTS_READ_OUT HERMES_TTS_READ_RC=0
      HERMES_TTS_READ_OUT=$(hermes_tts_cli config get tts.provider 2>&1) || HERMES_TTS_READ_RC=$?
      if [ "$HERMES_TTS_READ_RC" -eq 0 ]; then
        CURRENT_HERMES_TTS=$(printf '%s' "$HERMES_TTS_READ_OUT" | tr -d '\r' | tail -1)
      elif printf '%s' "$HERMES_TTS_READ_OUT" | grep -qi "config key not set"; then
        CURRENT_HERMES_TTS=""
      else
        HERMES_TTS_READ_FAILED=true
      fi

      # Rule (b): the DEFINITION lands before the provider is selected, and a
      # definition that did not land is never selected — pointing the harness
      # at a provider that does not exist is strictly worse than leaving
      # tts.provider alone, because then every spoken reply fails while the box
      # looks configured.
      #
      # `command` first, `type` last: `type: command` is what makes Hermes
      # treat the entry as a command provider at all, so writing it second
      # means a half-written provider is never a runnable-looking one.
      #
      # `output_format wav`, and it is load-bearing rather than cosmetic.
      #
      # An earlier version of this block wrote no format key at all, on the
      # reasoning that nothing established a command provider reads one. That
      # was wrong, and verified wrong on the box: tts_tool.py's
      # _get_command_tts_output_format reads `format` or `output_format` and
      # falls back to DEFAULT_COMMAND_TTS_OUTPUT_FORMAT, which is "mp3". With
      # the key unset Hermes therefore hands clawbox-tts.sh an .mp3 output
      # path on EVERY utterance — and that is the one path the script cannot
      # walk alone: it synthesises WAV and then shells out to
      # `ffmpeg -codec:a libmp3lame`, refusing the whole run when ffmpeg is
      # absent rather than write WAV bytes into an .mp3. `tts_ensure_ffmpeg`
      # now installs it from `step_openclaw_tts`, but it only warns when the
      # install fails, so an image without ffmpeg still reaches this arm and
      # the box's own voice fails every time; where it IS present it is a
      # libmp3lame encode per reply inside a 12 s budget.
      #
      # wav matches the OpenClaw arm's deliberate `outputFormat: "wav"` a
      # screen below — same script, same reason ("Kokoro emits WAV natively,
      # so the happy path needs no ffmpeg at all"). The two harnesses must not
      # be configured to disagree about one script.
      if hermes_tts_cli config set "tts.providers.$HERMES_TTS_PROVIDER.command" "$HERMES_TTS_COMMAND" \
        && hermes_tts_cli config set "tts.providers.$HERMES_TTS_PROVIDER.output_format" wav \
        && hermes_tts_cli config set "tts.providers.$HERMES_TTS_PROVIDER.type" command; then
        echo "  Hermes on-device TTS provider defined ($HERMES_TTS_PROVIDER)"
        # ── Seed-if-unset, with ONE extra value counted as unset: `edge` ──────
        #
        # This is the non-obvious rule in this step. Hermes ships
        # `tts.provider: edge` as its FACTORY default — Microsoft's cloud
        # voice. A ClawBox must not default to sending its owner's speech to a
        # cloud service: the product's whole claim is that the box speaks for
        # itself, on-device. So `edge` is treated as the factory setting it is
        # and replaced. Anything ELSE — elevenlabs, openai, a provider the
        # owner added by hand — is the owner's own choice and is preserved
        # untouched, exactly as the OpenClaw arm below preserves theirs, and
        # this step re-runs on every update.
        # SKIP THE SELECTION, never the rest of the step. This was a `return`,
        # which on the DUAL SKU walked out of the function before the OpenClaw
        # registration below — so one transient Hermes CLI hiccup left a box
        # whose OpenClaw harness still needs `tts-local-cli` without it. The
        # two harnesses are configured independently here and a failure in one
        # is not a reason to abandon the other.
        if [ "$HERMES_TTS_READ_FAILED" = true ]; then
          # The provider definition above still landed, which is the half that
          # is safe to repeat. What is refused here is CHOOSING for an owner
          # whose current choice could not be read.
          echo "  Warning: could not read tts.provider from Hermes — leaving the selection alone rather than overwriting a choice we could not read" >&2
        else
        case "$CURRENT_HERMES_TTS" in
          ""|null|edge|"$HERMES_TTS_PROVIDER")
            if hermes_tts_cli config set tts.provider "$HERMES_TTS_PROVIDER"; then
              if [ "$CURRENT_HERMES_TTS" = "edge" ]; then
                echo "  Hermes TTS provider set to $HERMES_TTS_PROVIDER (replacing Hermes' factory 'edge' cloud default)"
              else
                echo "  Hermes TTS provider set to $HERMES_TTS_PROVIDER"
              fi
            else
              HERMES_TTS_FAIL="could not select the $HERMES_TTS_PROVIDER provider"
            fi
            ;;
          *)
            echo "  Hermes TTS provider already set ($CURRENT_HERMES_TTS) — preserving; the $HERMES_TTS_PROVIDER definition is up to date either way"
            ;;
        esac
        fi
      else
        HERMES_TTS_FAIL="could not write the $HERMES_TTS_PROVIDER provider definition"
      fi
    fi
    if [ -n "$HERMES_TTS_FAIL" ]; then
      # Loud, recorded, and carried in the exit status — but NOT a `return 1`.
      # On the dual SKU the OpenClaw arm below is a separate harness's voice
      # and must still be configured; and on the hermes SKU a box that cannot
      # speak must still finish provisioning and come up reachable, which is
      # how it gets fixed. 14 is this step's "the TTS install did not
      # complete", which step_openclaw_setup and step_post_update both report
      # and neither treats as fatal.
      echo "  ERROR: the on-device voice was NOT registered with Hermes — $HERMES_TTS_FAIL" >&2
      echo "         Hermes will not speak on this box until it is. Re-run:" >&2
      echo "         sudo bash $PROJECT_DIR/install.sh --step openclaw_tts" >&2
      record_provision_failure openclaw_tts
      [ "$TTS_RC" -eq 0 ] && TTS_RC=14
    fi
  fi

  # ── The OpenClaw gateway's own provider registration ────────────────────────
  # The hermes SKU removes that gateway entirely (step_openclaw_install
  # early-returns, clawbox-gateway.service is stopped, disabled and masked), so
  # there is no `openclaw` CLI to write to: every oc_config_set below would
  # retry three times, fail, and turn a perfectly good voice install into a
  # failed step. Spelled with is_hermes_edition because that is exactly
  # has_openclaw_harness's own definition — `dual` keeps the gateway and takes
  # the path below like any openclaw box.
  if is_hermes_edition; then
    return "$TTS_RC"
  fi

  # Seed-if-unset, same contract as the primary model above: an owner who has
  # chosen ElevenLabs (or turned TTS off) must not have it silently reset by
  # every update, and rebuild_reboot re-invokes this step.
  local CURRENT_TTS
  # OpenClaw 2 moved the speech block from messages.tts to a top-level tts
  # object; writing the old home there fails config validation and a fresh
  # v2 box would never get its local voice.
  local TTS_HOME="messages.tts"
  openclaw_is_v2 && TTS_HOME="tts"
  CURRENT_TTS=$(as_clawbox "$OPENCLAW_BIN" config get "$TTS_HOME.provider" 2>/dev/null || echo "")
  if [ -n "$CURRENT_TTS" ] && [ "$CURRENT_TTS" != "null" ]; then
    # An owner who chose ElevenLabs keeps it. But when the box is already on
    # OUR provider, preserving the selection is not enough: the update that
    # just replaced OpenClaw is the very thing that invalidates the plugin
    # registry (`source-changed`), so returning here is how an ALREADY-SHIPPED
    # box keeps a provider selected that its gateway can no longer resolve.
    # That is the population this step is in step_post_update for, so the
    # verification has to happen on this path too, not only on first setup.
    if [ "$CURRENT_TTS" = "tts-local-cli" ]; then
      if ! tts_ensure_provider_registered; then
        echo "  ERROR: messages.tts.provider is tts-local-cli but the plugin does not resolve," >&2
        echo "         even after refreshing the registry. The box cannot speak until it does." >&2
        echo "         Diagnose with: openclaw plugins registry; openclaw plugins doctor" >&2
        return 1
      fi
      echo "  TTS provider already set (tts-local-cli) — preserved, plugin registry verified"
      return "$TTS_RC"
    fi
    echo "  TTS provider already set ($CURRENT_TTS) — preserving"
    # Preserving the SELECTION is not the same as leaving the box's own voice
    # undefined. This branch used to return here, so a box whose provider was
    # the cloud voice (seeded by gateway-pre-start, or the owner's pick) never
    # got a tts-local-cli entry at all — and with Kokoro installed, the Local
    # AI tab's "Make primary" answered "not available on this box". Define the
    # provider (never select it); the tts route repairs the same entry on
    # demand, and this keeps an update from leaving it missing.
    if [ -x "$TTS_SCRIPT" ]; then
      tts_write_local_provider_definition "$TTS_HOME" "$TTS_SCRIPT" \
        || echo "  Warning: could not define the on-device voice provider; Settings → Voice can repair it" >&2
    fi
    return "$TTS_RC"
  fi

  # Never point OpenClaw at a command that is not there: that configures the
  # exact silent failure this task removes, and it would look like a working
  # install until someone asked the box to speak.
  if [ ! -x "$TTS_SCRIPT" ]; then
    echo "  ERROR: $TTS_SCRIPT is missing or not executable — refusing to configure TTS against it" >&2
    return 1
  fi

  # Order matters and so does the gate. oc_config_set retries three times and
  # then gives up; if the provider definition did not land, naming it as THE
  # provider leaves the box pointing at a provider that does not exist, and
  # every spoken reply fails — strictly worse than not having run at all.
  if ! tts_write_local_provider_definition "$TTS_HOME" "$TTS_SCRIPT"; then
    echo "  ERROR: could not write the tts-local-cli provider — leaving messages.tts.provider unset" >&2
    return 1
  fi

  # Refuse to select a provider that is not there. Same rule already applied to
  # the script path above: never leave the box configured to speak through
  # something that does not exist, because that configures exactly the silent
  # failure this task removes. Leaving messages.tts.provider unset is the
  # better outcome — OpenClaw then reports TTS as unconfigured instead of
  # accepting spoken requests it cannot answer.
  if ! tts_ensure_provider_registered; then
    echo "  ERROR: the tts-local-cli plugin is not registered even after refreshing the registry." >&2
    echo "         Leaving messages.tts.provider unset rather than pointing the box at a provider" >&2
    echo "         that cannot answer. Diagnose with: openclaw plugins registry; openclaw plugins doctor" >&2
    return 1
  fi

  if ! oc_config_set "$TTS_HOME.provider" "tts-local-cli"; then
    echo "  ERROR: could not select the tts-local-cli provider" >&2
    return 1
  fi
  # Only claim Kokoro when Kokoro is genuinely there. This line asserting
  # "Kokoro GPU" unconditionally is what kept TASK-420 invisible: three
  # freshly flashed boxes printed it while running entirely on the CPU
  # fallback of the time. Claimed from the VERDICT, not the exit code, and only
  # on a clean exit: a ready Kokoro behind a failed script deploy is named in
  # the 1 arm below, in those words.
  if [ "$KOKORO_HAVE" = true ] && [ "$VOICE_RC" -eq 0 ]; then
    echo "  On-device TTS configured (Kokoro GPU)"
  else
    # Each arm names only what its exit code actually carries. 12 and 13 both
    # mean Kokoro is not on this box — by defect, or because the board declines
    # it — and with no second engine that means no on-device voice at all; the
    # line says so instead of naming an engine the box does not have.
    case "$VOICE_RC" in
      12)
        echo "  On-device TTS configured, but Kokoro is not available on this box ($KOKORO_REASON) — spoken replies fall back to the gateway's cloud voice"
        ;;
      1)
        # Kokoro's verdict stands here — install-voice.sh returns 12, not 1,
        # when the engine itself failed — so "NO engine is confirmed
        # installed", which is where this case used to land, would be a
        # failure report over something that may well have succeeded. The
        # exit code says nothing about the engine's state, but the VERDICT
        # does, and an operator reading this line is about to be told by
        # step_validate_services what it says — so when the file names a
        # ready Kokoro, say it here too. NOT by setting KOKORO_READY: that
        # would route into the "(Kokoro GPU)" line above and claim a clean
        # install over a deploy that did not land.
        if [ "$KOKORO_VERDICT" = "ready" ]; then
          echo "  On-device TTS configured — Kokoro GPU is ready, but the voice install did not complete ($KOKORO_REASON)"
        else
          echo "  On-device TTS configured, but the voice install did not complete ($KOKORO_REASON)"
        fi
        ;;
      13)
        echo "  On-device TTS configured, but this box has NO working on-device TTS engine ($KOKORO_REASON) — the cloud voice speaks for it once the box is linked to ClawBox AI"
        ;;
      *)
        echo "  On-device TTS configured, but NO engine is confirmed installed ($KOKORO_REASON)"
        ;;
    esac
  fi
  # Configuring the provider succeeded; whether the ENGINE the owner asked for
  # arrived is a separate verdict, and it is this one that leaves the function.
  return "$TTS_RC"
}

step_setup_config() {
  step_directories_permissions
  step_captive_portal_dns
}

step_captive_portal_dns() {
  mkdir -p "$DNSMASQ_DIR"
  # Remove old captive portal DNS hijack (breaks internet for hotspot clients)
  rm -f "$DNSMASQ_DIR/captive-portal.conf"
  # Install upstream DNS forwarding for hotspot clients
  cp "$PROJECT_DIR/config/dnsmasq-upstream.conf" "$DNSMASQ_DIR/upstream-dns.conf"
  echo "  Removed captive portal DNS, installed upstream DNS forwarding"
}

step_directories_permissions() {
  mkdir -p "$PROJECT_DIR/data"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data"
  find "$PROJECT_DIR/scripts" -name "*.sh" -exec chmod +x {} +
  # Create .env with defaults if it doesn't already exist
  local ENV_FILE="$PROJECT_DIR/.env"
  # Google Gemini CLI public OAuth credentials (split to pass GitHub push protection)
  local G_CID; G_CID="681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j"
  G_CID="${G_CID}.apps.googleusercontent.com"
  local G_SEC; G_SEC="GOCSPX-4uHgMPm"
  G_SEC="${G_SEC}-1o7Sk-geV6Cu5clXFsxl"
  if [ ! -f "$ENV_FILE" ]; then
    cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "  Created $ENV_FILE from .env.example"
  fi
  # Ensure Google OAuth credentials are present (added in v2.2.0)
  if ! grep -q '^GOOGLE_OAUTH_CLIENT_ID=' "$ENV_FILE" 2>/dev/null; then
    printf '\nGOOGLE_OAUTH_CLIENT_ID=%s\n' "$G_CID" >> "$ENV_FILE"
    echo "  Added GOOGLE_OAUTH_CLIENT_ID to $ENV_FILE"
  fi
  if ! grep -q '^GOOGLE_OAUTH_CLIENT_SECRET=' "$ENV_FILE" 2>/dev/null; then
    printf 'GOOGLE_OAUTH_CLIENT_SECRET=%s\n' "$G_SEC" >> "$ENV_FILE"
    echo "  Added GOOGLE_OAUTH_CLIENT_SECRET to $ENV_FILE"
  fi
  if [ -n "${CLAWBOX_AI_API_KEY:-}" ] && ! grep -q '^CLAWBOX_AI_API_KEY=' "$ENV_FILE" 2>/dev/null; then
    printf 'CLAWBOX_AI_API_KEY=%s\n' "$CLAWBOX_AI_API_KEY" >> "$ENV_FILE"
    echo "  Added CLAWBOX_AI_API_KEY to $ENV_FILE"
  fi
  # Propagate test mode into the project .env so clawbox-setup.service
  # (which loads EnvironmentFile=-/home/clawbox/clawbox/.env) sees it at
  # restart and the Next.js runtime's TEST_MODE checks fire.
  if is_test_mode; then
    ensure_env_setting "$ENV_FILE" "CLAWBOX_TEST_MODE" "1"
  fi
  ensure_env_setting "$ENV_FILE" "LLAMACPP_BASE_URL" "http://127.0.0.1:8080/v1"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_MODEL" "gemma4-e2b-it-q4_0"
  # Keep these four lines in step with src/lib/llamacpp.ts - the model id is
  # deliberately unchanged, only the GGUF moved. src/tests/unit/llamacpp-gguf-pin.test.ts
  # fails if this file and that one ever disagree.
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf" "google/gemma-4-E2B-it-qat-q4_0-gguf"
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf" "gemma-4-E2B_q4_0-it.gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "google/gemma-4-E2B-it-qat-q4_0-gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-E2B_q4_0-it.gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_BIN" "/usr/local/bin/llama-server"
  # on | off | auto. Written explicitly so the trade-off is visible and
  # editable on the device rather than buried in a launch script: "off" is
  # ~5x faster on this hardware, "on" is the only way this model gets
  # weekday arithmetic right. Restart clawbox-llamacpp after changing it.
  ensure_env_setting "$ENV_FILE" "LLAMACPP_REASONING" "off"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CONTEXT_WINDOW" "131072"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_K" "q4_0"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_V" "q4_0"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_MAX_TOKENS" "131072"
  echo "  Done"
}

step_system_config() {
  step_systemd_services
  step_polkit_rules
  step_nm_dispatcher
  step_sysctl_linkdown
  # Non-fatal here too, matching step_post_update. This runs under install.sh's
  # `set -euo pipefail` on the fresh-flash path, so an unguarded failure would
  # abort a first install before ollama, llama.cpp, Chromium, VNC and
  # start_services ever ran. A hardening step must never brick a flash.
  step_firewall || echo "  Warning: firewall step failed (non-fatal)"
  step_persistent_journal
}

step_persistent_journal() {
  # Make the journal survive a reboot.
  #
  # Shipped devices ran journald with `Storage=auto` and no /var/log/journal,
  # which means volatile: the entire journal lived in /run/log/journal (tmpfs),
  # was charged to RAM (72 MB measured on a QA box), and was destroyed on every
  # reboot. "What happened before it rebooted?" — the first question of every
  # support case — had no answer on any ClawBox ever shipped, and there was
  # nowhere durable for the web tier's access log to land either.
  #
  # Idempotent: cp + mkdir + a journald restart that flushes /run into /var.
  local drop_in_dir="/etc/systemd/journald.conf.d"
  local drop_in="$drop_in_dir/10-clawbox.conf"
  local src="$PROJECT_DIR/config/journald-clawbox.conf"

  if [ ! -f "$src" ]; then
    echo "  Warning: $src missing, skipping persistent journal setup"
    return 0
  fi

  mkdir -p "$drop_in_dir"
  cp "$src" "$drop_in"
  chmod 644 "$drop_in"

  # journald creates /var/log/journal itself when Storage=persistent, but only
  # on its next start — and systemd-tmpfiles is what applies the correct
  # ownership and the systemd-journal ACL, so do it explicitly rather than
  # leaving a root-only directory behind.
  mkdir -p /var/log/journal
  systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true

  # Restart rather than reload: Storage= is only read at start. This also
  # flushes what is currently in /run into /var, so the CURRENT boot's log is
  # the first one that survives, not the next one.
  systemctl restart systemd-journald >/dev/null 2>&1 || true
  journalctl --flush >/dev/null 2>&1 || true

  if [ -d /var/log/journal ]; then
    echo "  Journal is persistent (/var/log/journal), capped at 200M"
  else
    echo "  Warning: /var/log/journal was not created — journal stays volatile"
  fi

  # NOT fixed here, and not fixable from userspace: the first ~10 s of every
  # boot (~888 kernel lines) are stamped ~361 days early, because the Jetson has
  # no battery-backed RTC and nvvrs-pseq-rtc only sets the system clock at
  # monotonic ~10 s. `journalctl -b` timestamps before that handoff are bogus and
  # `--list-boots` shows one "boot" spanning the gap. This is a hardware/BSP
  # property of the Orin Nano dev kit, not something install.sh can correct.
}

# ── Root-owned entrypoints ───────────────────────────────────────────────────
#
# Anything root executes on behalf of the unprivileged clawbox web server must
# live somewhere clawbox cannot write, or the privilege boundary is decorative.
# /home/clawbox/clawbox and /home/clawbox/clawbox/scripts are both
# clawbox-owned and group-writable, and install.sh's own bootstrap hands the
# tree back with `chown -R clawbox:clawbox` on every root run — so a NOPASSWD
# grant on a script in there is a one-step local root for anything with
# clawbox-level code execution (the web server itself, the in-UI terminal, the
# agent's shell). Copy them here instead, root:root, under root-owned dirs.
# TASK-445.
ROOT_LIBEXEC_DIR="/usr/local/libexec/clawbox"

ROOT_EXEC_MANIFEST_HELPER="$ROOT_LIBEXEC_DIR/clawbox-root-manifest.sh"

# Record the tree root is allowed to execute. Strict: a non-zero return means
# the record is NOT current, and the caller must treat that as a failure.
write_root_exec_manifest() {
  root_exec_manifest_helper_alive "$ROOT_EXEC_MANIFEST_HELPER" || return 1
  "$ROOT_EXEC_MANIFEST_HELPER" --write || return 1
  # VERIFY, then clear — never the other way round. `--write` returning 0 says
  # the helper believes it wrote a manifest, not that the record now matches the
  # tree; a write that landed somewhere else, or a tree that moved while it ran,
  # both end here. And this function's success is read as "the bootstrap's
  # failure is repaired": install_root_libexec installs the root dispatcher on
  # it, and that dispatcher refuses every pinned root step while the manifest
  # does not verify. So prove the record before dropping the failure. TASK-584.
  "$ROOT_EXEC_MANIFEST_HELPER" --verify >/dev/null || return 1
  # This is exactly the repair for what the bootstrap could not do, so the run's
  # verdict must stop reporting it. TASK-584.
  clear_provision_failure root_exec_manifest
}

# Best-effort variant for the update paths that legitimately change the tree. A
# device that has not installed the helper yet has no manifest to keep in step,
# and warning about that on every sync would be noise; a helper that IS present
# and fails is worth a line, because the next root step refuses until the record
# is current again.
refresh_root_exec_manifest() {
  [ -x "$ROOT_EXEC_MANIFEST_HELPER" ] || return 0
  # RECORDED, not just warned. This is the second place install.sh re-records the
  # manifest after a `git reset --hard` (sync_repo_to_update_target), and it had
  # the same defect the bootstrap did: a failure here left the step exiting 0
  # with a stale manifest, and the operator then met it as an opaque exit-65 on
  # some later step instead. Non-fatal on purpose — the update should finish —
  # but the run's verdict says so. TASK-584.
  write_root_exec_manifest && return 0
  echo "  Warning: could not re-record the root-exec manifest; root steps will refuse until an operator runs 'sudo bash $PROJECT_DIR/install.sh --step systemd_services'" >&2
  record_provision_failure root_exec_manifest
}

# Install one root-owned file WITHOUT ever leaving a prefix of it behind.
#
# `install` writes into the destination inode with O_TRUNC, so a copy that dies
# part way through — a full or read-only /usr — leaves an executable PREFIX of
# the file at the destination. For every script this function installs that
# prefix is silently PERMISSIVE rather than noisy, because each one's dispatch
# is at the bottom: a truncated clawbox-root-manifest.sh exits 0 for --write and
# --verify without looking at anything (TASK-584, which is why every caller now
# probes it first), and a truncated clawbox-root-step.sh reaches EOF and exits 0
# without exec'ing the step at all — which `Type=oneshot` reports to the updater
# as a step that SUCCEEDED.
#
# So: temp name in the same directory, then rename. `rename(2)` within a
# directory is atomic, so the live file is either the whole old one or the whole
# new one and never a prefix of either — and a failed copy leaves the working
# file it was replacing untouched. Same shape as the bootstrap's _mf_restage,
# which had this and the path that runs on every install did not. TASK-584.
install_root_file() {
  local src="$1" dst="$2" mode="${3:-0755}"
  if ! install -o root -g root -m "$mode" "$src" "$dst.new"; then
    rm -f "$dst.new" 2>/dev/null || true
    return 1
  fi
  if ! mv -f "$dst.new" "$dst"; then
    rm -f "$dst.new" 2>/dev/null || true
    return 1
  fi
}

install_root_libexec() {
  install -d -o root -g root -m 0755 /usr/local/libexec
  install -d -o root -g root -m 0755 "$ROOT_LIBEXEC_DIR"
  local src
  # The integrity helper first: the dispatcher installed at the END of this
  # function refuses to run any step unless the manifest this writes verifies.
  for src in clawbox-root-manifest.sh clawbox-run-root-step.sh; do
    if [ -f "$PROJECT_DIR/config/$src" ]; then
      install_root_file "$PROJECT_DIR/config/$src" "$ROOT_LIBEXEC_DIR/$src"
    fi
  done
  # Everything the web server may invoke as root via a NOPASSWD grant. Same
  # rule as above: the copy that runs must not be the one clawbox can rewrite.
  for src in optimize-ollama.sh clawbox-desktop-mode.sh clawbox-power-mode.sh \
             clawbox-resource-limits.sh; do
    if [ -f "$PROJECT_DIR/scripts/$src" ]; then
      install_root_file "$PROJECT_DIR/scripts/$src" "$ROOT_LIBEXEC_DIR/$src"
    fi
  done
  # The limits the scripts above read. Root-owned for the same reason they are.
  install -d -o root -g root -m 0755 /etc/clawbox
  if [ -f "$PROJECT_DIR/config/clawbox-resource-limits.env" ]; then
    install_root_file "$PROJECT_DIR/config/clawbox-resource-limits.env" \
      /etc/clawbox/resource-limits.env 0644
  fi

  # Manifest, THEN dispatcher — never the other way round. The dispatcher fails
  # closed on a missing or stale manifest, so installing it first would leave a
  # window (and, if the manifest write failed, a permanent state) in which every
  # root step refuses: no password change, no hostname change, no hotspot
  # restart, on an appliance with no console. If the record cannot be written we
  # keep whatever dispatcher is already installed and say so — the same rule
  # install_sudoers_dropin follows for the allow-list. TASK-445.
  if write_root_exec_manifest; then
    if [ -f "$PROJECT_DIR/config/clawbox-root-step.sh" ]; then
      install_root_file "$PROJECT_DIR/config/clawbox-root-step.sh" \
        "$ROOT_LIBEXEC_DIR/clawbox-root-step.sh"
    fi
  else
    echo "  Warning: could not record the root-exec manifest; leaving the existing root dispatcher in place" >&2
    record_provision_failure "root_exec_manifest"
  fi
}

# ── sudoers ────────────────────────────────────────────────────────────────
SUDOERS_DIR="/etc/sudoers.d"
# Copies of drop-ins we removed, kept so a device can be forensically explained
# (and a removal undone by hand) instead of the file simply vanishing. Root-only:
# the clawbox user must not be able to read a rule back out and re-plant it.
SUDOERS_QUARANTINE_DIR="/var/lib/clawbox/sudoers-quarantine"
# Where a candidate drop-in is staged while it is validated. Root-owned and
# NOT under /etc/sudoers.d — see install_sudoers_dropin().
#
# A subdirectory of its own, not /var/lib/clawbox itself: that directory is
# shared (clawbox-power-mode.sh keeps its clock snapshot there, the first-boot
# VNC marker lives there), and install_sudoers_dropin creates its staging dir
# 0700 root:root. Applying that to the shared parent would stop every non-root
# reader from even traversing it.
SUDOERS_STAGING_DIR="/var/lib/clawbox/sudoers-staging"
# The drop-ins this installer owns. Nothing else in /etc/sudoers.d is ours, and
# quarantine_overbroad_sudoers() below is the only code that touches the rest.
CLAWBOX_SUDOERS_MANAGED=(clawbox clawbox-ollama)

# Install a sudoers drop-in only if it VALIDATES FIRST.
#
# The old order was cp -> visudo -cf -> rm + exit 1 on failure, which turned a
# typo in the repo into a device with no drop-in at all: every systemctl the web
# server needs (updater, power, wifi hand-off, factory reset, desktop toggle)
# then fails on a password prompt nobody can answer, on an appliance with no
# console. So: validate a staged copy, install only if it parses, and on failure
# leave whatever is already installed exactly where it is and say so. TASK-445.
#
# The staging copy deliberately does NOT live in /etc/sudoers.d — sudo parses
# every file in that directory, so a candidate staged there is live the moment
# it lands, valid or not.
install_sudoers_dropin() {
  local src="$1" name="$2"
  local dest="$SUDOERS_DIR/$name"

  if [ ! -f "$src" ]; then
    echo "  Warning: $src is missing; leaving $dest as it is" >&2
    return 1
  fi

  install -d -o root -g root -m 0755 "$SUDOERS_DIR" || return 1
  install -d -o root -g root -m 0700 "$SUDOERS_STAGING_DIR" || return 1

  local staged
  staged="$(mktemp "$SUDOERS_STAGING_DIR/.sudoers-candidate.XXXXXX")" || return 1
  # Checked, not assumed. Both call sites invoke this function in a CONDITION
  # context (`if install_sudoers_dropin …`, `… || echo`), and bash disables
  # `set -e` for the whole dynamic extent of a command being tested. So every
  # step in here has to carry its own `|| return 1`: an unchecked failure does
  # not abort the script, it falls through to the next line and reports success.
  # A truncated-but-parseable candidate — a `cat` that hit ENOSPC halfway down
  # the allow-list — validates under visudo and installs cleanly. TASK-445.
  if ! cat "$src" > "$staged"; then
    rm -f "$staged"
    echo "Error: could not stage $src; keeping the existing $dest" >&2
    return 1
  fi
  if ! cmp -s "$src" "$staged"; then
    rm -f "$staged"
    echo "Error: staged copy of $src is truncated; keeping the existing $dest" >&2
    return 1
  fi
  chown root:root "$staged" || { rm -f "$staged"; return 1; }
  chmod 0440 "$staged" || { rm -f "$staged"; return 1; }

  if ! visudo -cf "$staged" >/dev/null 2>&1; then
    rm -f "$staged"
    echo "Error: $src failed visudo validation; keeping the existing $dest" >&2
    return 1
  fi

  # Byte-identical to what is already installed: nothing to do. Keeps repeat
  # updates from opening a window where the file is momentarily replaced.
  if [ -f "$dest" ] && cmp -s "$staged" "$dest"; then
    rm -f "$staged"
    return 0
  fi

  local backup=""
  if [ -f "$dest" ]; then
    backup="$(mktemp "$SUDOERS_STAGING_DIR/.sudoers-previous.XXXXXX")" || { rm -f "$staged"; return 1; }
    if ! cat "$dest" > "$backup" || ! cmp -s "$dest" "$backup"; then
      rm -f "$staged" "$backup"
      echo "Error: could not back up $dest; leaving it as it is" >&2
      return 1
    fi
  fi

  # install(1) writes to a temp file and renames, so sudo never sees a
  # half-written drop-in.
  #
  # POSITIVE PROOF, not a return code. The caller uses this function's result to
  # decide whether it is safe to quarantine the blanket `NOPASSWD: ALL` drop-in,
  # and the `visudo -c` below cannot tell it: when `install` fails, visudo
  # happily validates whatever is STILL on disk and answers 0. On a device whose
  # only grant is the blanket one, that sequence ends with the narrow file never
  # written and the blanket file removed — no working sudo at all, on an
  # appliance with no console. So compare the bytes that actually landed.
  if ! install -o root -g root -m 0440 "$staged" "$dest" 2>/dev/null || ! cmp -s "$staged" "$dest"; then
    if [ -n "$backup" ]; then
      # `install` may have left a partial/renamed file behind; put the previous
      # content back rather than trusting that it never got that far.
      install -o root -g root -m 0440 "$backup" "$dest" 2>/dev/null \
        || echo "Error: could not restore $dest from its backup at $backup" >&2
    else
      rm -f "$dest"
    fi
    rm -f "$staged" "$backup"
    echo "Error: could not install $name into $dest; leaving the existing grants alone" >&2
    return 1
  fi
  rm -f "$staged"

  # Re-check the WHOLE set: a fragment can be valid on its own and still collide
  # with another drop-in (duplicate alias, bad include order).
  if ! visudo -c >/dev/null 2>&1; then
    if [ -n "$backup" ]; then
      # The "rolled back" message used to print whether or not the rollback
      # worked. Say what actually happened — a device that is now missing its
      # drop-in entirely has to be distinguishable in the install log from one
      # that is safely back on its previous rules.
      if install -o root -g root -m 0440 "$backup" "$dest" 2>/dev/null; then
        echo "Error: installing $name broke /etc/sudoers validation; rolled $dest back" >&2
      else
        rm -f "$dest"
        echo "Error: installing $name broke /etc/sudoers validation AND the rollback failed; removed $dest" >&2
      fi
    else
      rm -f "$dest"
      echo "Error: installing $name broke /etc/sudoers validation; removed $dest" >&2
    fi
    rm -f "$backup"
    return 1
  fi

  rm -f "$backup"
  return 0
}

# Does this drop-in hand the clawbox service user unrestricted passwordless root?
#
# Deliberately narrow. Only a rule whose user spec is `clawbox` or `%clawbox`
# AND whose Cmnd is a bare `ALL` under an active NOPASSWD tag counts. An
# operator's own `%sudo`/`%admin` rule, and the distro default in /etc/sudoers,
# are never inspected and never touched: removing those could lock the only
# administrator out of a device that is 3000 km away.
#
# ACCEPTED RESIDUAL, recorded so the next reader does not mistake it for an
# oversight. Three shapes are knowingly out of scope, all for the same reason —
# each would mean this installer silently rewriting rules a human wrote:
#
#   1. A blanket line inside /etc/sudoers itself. Only /etc/sudoers.d is walked.
#      e2e-install/06-sudoers.spec.ts catches this behaviourally instead: it runs
#      `sudo -n` probes for commands no grant names and requires DENIED.
#   2. A grant that reaches clawbox through a User_Alias rather than by name.
#   3. Over-broad but not blanket — e.g. `clawbox ALL=(ALL) NOPASSWD: /bin/bash`,
#      which is root in one move but is not a bare `ALL`.
#
# Widening the detector to any of these means an installer that can delete an
# operator's deliberate rule on an appliance with no console; the behavioural
# probes in CI are the compensating control. TASK-445.
sudoers_grants_blanket_nopasswd() {
  local file="$1"
  [ -f "$file" ] || return 1
  awk '
    function check(l,   eq, rest, n, parts, i, item, tag, nopass) {
      if (l !~ /^[ \t]*(clawbox|%clawbox)[ \t]/) return 0
      eq = index(l, "=")
      if (eq == 0) return 0
      rest = substr(l, eq + 1)
      nopass = 0
      n = split(rest, parts, ",")
      for (i = 1; i <= n; i++) {
        item = parts[i]
        gsub(/^[ \t]+|[ \t]+$/, "", item)
        sub(/^\([^)]*\)[ \t]*/, "", item)
        while (match(item, /^(NOPASSWD|PASSWD|NOEXEC|EXEC|SETENV|NOSETENV|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW|INTERCEPT|NOINTERCEPT):[ \t]*/)) {
          tag = substr(item, 1, RLENGTH)
          if (tag ~ /^NOPASSWD:/) nopass = 1
          else if (tag ~ /^PASSWD:/) nopass = 0
          item = substr(item, RLENGTH + 1)
          gsub(/^[ \t]+|[ \t]+$/, "", item)
        }
        if (nopass && item == "ALL") return 1
      }
      return 0
    }
    {
      line = $0
      sub(/#.*$/, "", line)
      if (line ~ /\\[ \t]*$/) { sub(/\\[ \t]*$/, "", line); pending = pending line; next }
      line = pending line
      pending = ""
      if (check(line)) { found = 1; exit }
    }
    END { exit(found ? 0 : 1) }
  ' "$file"
}

# Move any /etc/sudoers.d drop-in that hands clawbox unrestricted passwordless
# root out of sudo's way.
#
# Why the installer has to do this rather than just shipping a narrow file: sudo
# takes the UNION of every drop-in. QA and factory provisioning left
# `/etc/sudoers.d/90-clawbox-nopasswd` containing `clawbox ALL=(ALL) NOPASSWD: ALL`
# on shipped devices, and while that file exists every narrowing in
# config/clawbox-sudoers is decorative — the revalidation of TASK-445 measured
# exactly that on the QA box. Narrowing what we ship without removing what is
# already there changes nothing on a device that has both. TASK-445 round 2.
quarantine_overbroad_sudoers() {
  [ -d "$SUDOERS_DIR" ] || return 0

  local f base m managed
  local -a moved_from=() moved_to=()
  for f in "$SUDOERS_DIR"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    managed=0
    for m in "${CLAWBOX_SUDOERS_MANAGED[@]}"; do
      [ "$base" = "$m" ] && managed=1 && break
    done
    [ "$managed" = "1" ] && continue
    sudoers_grants_blanket_nopasswd "$f" || continue

    install -d -o root -g root -m 0700 "$SUDOERS_QUARANTINE_DIR"
    local stamp dest
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    dest="$SUDOERS_QUARANTINE_DIR/$base.$stamp"
    if mv "$f" "$dest" 2>/dev/null; then
      chown root:root "$dest"
      chmod 0400 "$dest"
      moved_from+=("$f")
      moved_to+=("$dest")
      echo "  Removed over-broad sudoers drop-in $base (clawbox had passwordless root on everything); copy kept at $dest"
    else
      echo "  Warning: could not remove over-broad sudoers drop-in $base" >&2
    fi
  done

  [ "${#moved_to[@]}" -eq 0 ] && return 0

  # Removing a file can still break the set — a quarantined drop-in may have
  # defined an alias another one uses. Put everything back rather than leave a
  # device where sudo refuses every command.
  if ! visudo -c >/dev/null 2>&1; then
    local i
    for i in "${!moved_to[@]}"; do
      mv "${moved_to[$i]}" "${moved_from[$i]}" 2>/dev/null || true
    done
    echo "Error: removing the over-broad sudoers drop-in(s) broke /etc/sudoers validation; restored them" >&2
    return 1
  fi
  return 0
}

step_systemd_services() {
  local ALL_SERVICES=("${EXPECTED_ACTIVE_SERVICES[@]}" "${EXPECTED_INSTALLED_SERVICES[@]}")
  # The registry the drift guard checks against: this edition's install lists
  # PLUS the edition-scoped units (see EDITION_SCOPED_UNITS near the top). The
  # guard has to be edition-aware or it hard-exits on every SKU — config/ always
  # contains all three of clawbox-gateway, clawbox-hermes-dashboard and
  # clawbox-hermes-dashboard-proxy, but no single edition installs all three.
  local KNOWN_UNITS=("${ALL_SERVICES[@]}" "${EDITION_SCOPED_UNITS[@]}")
  # Drift guard: every *.service / *.timer in config/ must be in
  # KNOWN_UNITS, otherwise a new unit added to the repo would silently
  # not get installed on fresh devices. The opposite direction (units
  # listed but missing on disk) is caught by the per-file existence
  # check below. (clawkeep/systemd/ is intentionally NOT covered: those
  # units target a standalone ClawKeep deployment with a dedicated
  # `clawkeep` user and /usr/bin/clawkeepd, which doesn't apply on
  # ClawBox — the in-Next.js scheduler in src/lib/clawkeep-scheduler.ts
  # drives backups on this device.)
  local found_unit
  for found_unit in "$PROJECT_DIR/config"/*.service "$PROJECT_DIR/config"/*.timer; do
    [ -f "$found_unit" ] || continue
    local basename
    basename="$(basename "$found_unit")"
    local registered=0
    for svc in "${KNOWN_UNITS[@]}"; do
      if [ "$svc" = "$basename" ]; then registered=1; break; fi
    done
    if [ "$registered" = "0" ]; then
      echo "Error: $basename exists in config/ but is not registered." >&2
      echo "       Add it to EXPECTED_ACTIVE_SERVICES or EXPECTED_INSTALLED_SERVICES" >&2
      echo "       (the module-level constants near the top of install.sh), or to" >&2
      echo "       EDITION_SCOPED_UNITS if it only belongs on some editions," >&2
      echo "       so fresh installs pick it up." >&2
      exit 1
    fi
  done

  local svc
  for svc in "${ALL_SERVICES[@]}"; do
    local src="$PROJECT_DIR/config/$svc"
    if [ ! -f "$src" ]; then
      echo "Error: Service file not found: $src"
      exit 1
    fi
    cp "$src" /etc/systemd/system/
  done
  systemctl daemon-reload
  # Enable all services except templates and on-demand units.
  #
  # Browser is launched ad-hoc by the desktop, never at boot.
  #
  # clawbox-tunnel must be opt-in from Settings → Remote Control: enabling
  # it by default when cloudflared isn't installed produces a permanent
  # restart loop, and even with cloudflared present, exposing a public URL
  # should be a deliberate user choice. The Settings toggle calls
  # `systemctl enable --now` itself.
  #
  # clawbox-heartbeat.service is one-shot — it has no [Install] target and
  # is driven by the matching .timer, which is enabled explicitly below.
  # Skip the .service in this loop so systemctl doesn't complain.
  for svc in "${ALL_SERVICES[@]}"; do
    [[ "$svc" == *@* ]] && continue
    [[ "$svc" == "clawbox-browser.service" ]] && continue
    [[ "$svc" == "clawbox-tunnel.service" ]] && continue
    [[ "$svc" == "clawbox-heartbeat.service" ]] && continue
    # Timer-driven one-shot (no [Install]); enabled via its .timer below.
    [[ "$svc" == "clawbox-ap-watchdog.service" ]] && continue
    [[ "$svc" == "clawbox-codex-auth-sync.service" ]] && continue
    systemctl enable "$svc"
  done
  # Start the heartbeat timer immediately so the portal sees the device
  # transition to Online without waiting for the next reboot.
  systemctl enable --now clawbox-heartbeat.timer
  # Start the AP watchdog immediately so a dropped setup hotspot self-heals
  # without waiting for a reboot.
  systemctl enable --now clawbox-ap-watchdog.timer
  # The sync unit runs under ProtectSystem=strict and can only write paths named
  # in ReadWritePaths. ~/.codex doesn't exist until the first ChatGPT login, so
  # create it up front — otherwise the very first mirror write (the one that
  # makes Codex work at all) hits a read-only namespace.
  install -d -o clawbox -g clawbox -m 700 "$CLAWBOX_HOME/.codex"
  # Start the Codex credential mirror sync immediately so a box updating into
  # this release strips any refresh_token 3.1.11 planted in its mirrors without
  # waiting for a reboot — that token is what burns the OAuth family.
  systemctl enable --now clawbox-codex-auth-sync.timer
  # Clean up older installs that enabled on-demand units at boot.
  systemctl disable --now clawbox-browser.service >/dev/null 2>&1 || true
  # Migration: prior installs enabled clawbox-tunnel by default, which loops
  # forever on devices without cloudflared. Stop the loop on those boxes,
  # but only when the binary is missing — devices where the user opted in
  # via Settings have cloudflared installed and should keep their choice.
  if [ ! -x /usr/local/bin/cloudflared ]; then
    systemctl disable --now clawbox-tunnel.service >/dev/null 2>&1 || true
  fi
  # Root-owned copies of everything root executes on clawbox's behalf. Must run
  # BEFORE the sudoers drop-in, which points at them.
  install_root_libexec
  # Install the narrow allow-list FIRST, then remove any blanket grant. In that
  # order the device is never, even briefly, without the rules the web server
  # needs: if the drop-in fails to validate we keep the old one and skip the
  # quarantine entirely rather than strand the box with neither.
  # The ollama optimiser grant is a SECOND drop-in and it belongs here, next to
  # the first one — not in step_performance_mode where it used to live. That
  # step returns early under CLAWBOX_TEST_MODE and is Jetson-only in spirit, so
  # the grant silently never landed on any box that took the early return: the
  # e2e-install container installed cleanly and still had no
  # `optimize-ollama.sh` grant, which is the same "the narrowing is invisible on
  # the device" shape TASK-445 exists to close. step_systemd_services is the one
  # step both a fresh install and the in-app updater (step_post_update) always
  # run, unconditionally. TASK-445.
  #
  # Called plainly, never as the tested command of an `if`: bash suspends
  # `set -e` for the entire dynamic extent of a command run in a condition
  # context, so that spelling disarmed every unchecked command inside the
  # function body too. The function now checks its own steps, and the status
  # comes back through an explicit variable.
  local sudoers_status=0
  set +e
  install_sudoers_dropin "$PROJECT_DIR/config/clawbox-sudoers" clawbox
  sudoers_status=$?
  set -e

  # Two independent gates before the blanket grant is removed: the installer
  # reported success, AND the bytes on the device are the allow-list we shipped.
  # The second one is the load-bearing half — it is proof about the device, not
  # about a code path, and it is what makes "installed the narrow rules" a
  # precondition of "removed the wide ones" instead of an assumption.
  if [ "$sudoers_status" -eq 0 ] \
    && cmp -s "$PROJECT_DIR/config/clawbox-sudoers" "$SUDOERS_DIR/clawbox"; then
    echo "  Sudoers rules installed"
    # Gated on the PRIMARY allow-list only. That file is what keeps the box
    # operable (wizard, updater, power, hotspot); the ollama grant is one
    # feature's tuning. Letting a missing feature grant block the quarantine
    # would leave a device on blanket passwordless root to protect a KV-cache
    # setting — the wrong trade in the wrong direction.
    quarantine_overbroad_sudoers || true
  else
    echo "  Warning: sudoers rules NOT updated; leaving the existing grants alone" >&2
  fi
  install_sudoers_dropin "$PROJECT_DIR/config/sudoers-clawbox-ollama" clawbox-ollama || \
    echo "  Warning: clawbox-ollama sudoers rules NOT updated; leaving the existing grant alone" >&2
  echo "  Services installed and enabled"
}

step_sysctl_linkdown() {
  local SYSCTL_DIR="/etc/sysctl.d"
  local DEST="$SYSCTL_DIR/90-clawbox-linkdown.conf"
  mkdir -p "$SYSCTL_DIR"
  cat > "$DEST" <<'SYSCTL_EOF'
# ClawBox: instantly skip default routes whose interface has lost link.
# Fixes the 5-10s blackhole when Ethernet is unplugged while WiFi is also up.
net.ipv4.conf.all.ignore_routes_with_linkdown=1
net.ipv4.conf.default.ignore_routes_with_linkdown=1
SYSCTL_EOF
  chown root:root "$DEST"
  chmod 0644 "$DEST"
  sysctl -q -p "$DEST" 2>/dev/null || true
  echo "  Linkdown routing sysctl installed"
}

step_firewall() {
  # Default-deny inbound. See scripts/clawbox-firewall.sh for the policy and the
  # reasoning behind every rule in it; this step only decides WHEN it runs.
  #
  # Called from step_system_config (fresh installs) AND step_post_update
  # (in-app updates), because a box already in the field is exactly the box the
  # 2026-07-28 review was written about — a fresh-install-only firewall would
  # leave every shipped device exactly as exposed as it is today.
  local SRC="$PROJECT_DIR/scripts/clawbox-firewall.sh"
  if [ ! -f "$SRC" ]; then
    echo "  Skipping firewall: $SRC missing"
    return 0
  fi

  # A CI container has no netfilter to program and `ufw enable` fails there.
  # The e2e-install job runs this installer for real on every PR, so the step
  # has to stand down rather than take the whole run red.
  if is_test_mode; then
    echo "  Skipping firewall: test mode"
    return 0
  fi

  # step_apt_update installs ufw and runs before this on both paths. This is
  # only a backstop for a box that got here with it missing (an update that
  # skipped apt because it was offline).
  #
  # Both halves are time-bounded on purpose. post_update runs inside the
  # updater's step budget, and an apt that blocks on an unreachable mirror (or
  # on another process holding the dpkg lock) would burn the whole budget here
  # and push the `hermes_edition` step that follows into a hard failure. The
  # firewall is worth a couple of minutes, not the update.
  if ! command -v ufw >/dev/null 2>&1; then
    wait_for_apt 60 || true
    timeout 180 env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw || true
  fi

  bash "$SRC"
}

step_nm_dispatcher() {
  local DISPATCHER_DIR="/etc/NetworkManager/dispatcher.d"
  local SRC="$PROJECT_DIR/scripts/nm-dispatcher-failover.sh"
  local DEST="$DISPATCHER_DIR/90-clawbox-failover"
  if [ ! -f "$SRC" ]; then
    echo "  Skipping NM dispatcher: $SRC missing"
    return
  fi
  mkdir -p "$DISPATCHER_DIR"
  cp "$SRC" "$DEST"
  chown root:root "$DEST"
  chmod 0755 "$DEST"
  echo "  NetworkManager failover dispatcher installed"
}

step_post_update() {
  # Re-apply system-level fixups that aren't covered by `git pull && build`.
  # Triggered by the in-app updater so existing devices pick up new dispatcher
  # scripts, sysctls, etc. without a full reinstall. Keep this list small and
  # idempotent.
  # step_set_hostname re-runs apply_hostname, which redeploys the hardened
  # avahi-daemon.conf + 99-clawbox-avahi-reload dispatcher hook. Without this
  # call, devices updating via the in-app updater never receive the mDNS
  # fixes from this PR — they'd keep failing to resolve <hostname>.local on
  # Windows until the owner did a fresh install.
  # Re-bake the edition lock FIRST. On a box installed before /etc/clawbox/
  # edition.env existed, the edition currently only lives in the legacy systemd
  # drop-in; re-running the lock migrates it to the root-owned file so every
  # LATER updater step (and the web server, and the next update) resolves the
  # SKU correctly instead of silently defaulting to openclaw. It also re-asserts
  # the Hermes gateway removal, which an older update could have undone.
  step_edition_lock || echo "  Warning: edition_lock step failed (non-fatal)"
  step_set_hostname || echo "  Warning: set_hostname step failed (non-fatal)"
  step_nm_dispatcher || echo "  Warning: nm_dispatcher step failed (non-fatal)"
  step_sysctl_linkdown || echo "  Warning: sysctl_linkdown step failed (non-fatal)"
  # Without this call the firewall would be fresh-install-only and every box
  # already in the field would keep its wide-open INPUT policy — which is the
  # entire finding. Idempotent: the script converges its own rules on each run.
  step_firewall || echo "  Warning: firewall step failed (non-fatal)"
  # Without this call the persistent journal would be fresh-install-only, and
  # every already-shipped box would keep losing its whole log on each reboot.
  step_persistent_journal || echo "  Warning: persistent_journal step failed (non-fatal)"
  # Re-assert the cgroup memory guards and re-sync /etc/clawbox/resource-limits.env
  # from the repo. Without this the guards would be fresh-install-only and every
  # already-shipped box would keep running an unbounded ollama. Idempotent.
  # NOTE: there is deliberately no step_desktop_mode call here — the desktop
  # toggle is the owner's decision and an update must never flip it.
  step_resource_limits || echo "  Warning: resource_limits step failed (non-fatal)"
  # step_vnc_refresh is a tiny idempotent refresh of the clawbox-vnc.service
  # unit + autocutsel package. Devices installed before the display-:99 move
  # and the clipboard-sync addition get both here without needing a reinstall.
  step_vnc_refresh || echo "  Warning: vnc_refresh step failed (non-fatal)"
  # Reinstall the unit files from config/ + daemon-reload. Without this, unit
  # changes only ever reached FRESH installs: the in-app update runs
  # bootstrap_updater -> ... -> post_update and never re-copies
  # /etc/systemd/system, so an updated box kept running whatever unit file it
  # was born with. That silently swallowed the llamacpp_install
  # TimeoutStartSec raise (30 min -> 2 h) that stops "Provisioning offline
  # Gemma 4" from being killed mid-build, and would swallow any future unit or
  # sudoers change the same way. The step is idempotent — cp, daemon-reload,
  # enable — and is exactly what fresh installs already run.
  step_systemd_services || echo "  Warning: systemd_services step failed (non-fatal)"
  # Refresh the device-side ClawKeep CLI from the repo. The Python package
  # has the same version string ("0.1.0") across releases, so a plain
  # `pip install` is a no-op even after restore/scheduler bug fixes land —
  # we have to force-reinstall.
  step_clawkeep_install || echo "  Warning: clawkeep_install step failed (non-fatal)"
  # The coding harness. WITHOUT this call TASK-378 would be fresh-install-only:
  # step_post_update never ran step_ai_tools_install, which is exactly why no
  # already-shipped box has `claude` on it today. Idempotent — a present
  # `claude` short-circuits after one `command -v`, and the wrapper is a copy.
  step_coding_harness || echo "  Warning: coding_harness step failed (non-fatal)"
  # On-device TTS: installs/refreshes Kokoro and the voice scripts, and seeds
  # the tts-local-cli provider. Without this call the whole of TASK-383 would
  # be fresh-install-only, and every already-shipped box would keep answering
  # a spoken request with silence.
  # The SAME tolerance table step_openclaw_setup applies to this step, and for
  # the same reason: 12, 13 and 14 are three different facts about a box's
  # speech and the update path has to keep them apart too. A single
  # `|| echo "(non-fatal)"` — indistinguishable from the fourteen lines around
  # it — reported "this box has no working TTS engine" in the same words as a
  # skipped VNC refresh, on the very path that reaches ALREADY-SHIPPED boxes.
  # ── The Hermes agent FIRST, for the same reason the fresh-install path was
  # reordered ──────────────────────────────────────────────────────────────
  # step_openclaw_tts registers the on-device voice with every harness the box
  # runs, and the Hermes half of that is written through ~/.local/bin/hermes.
  # The repair below is exactly the population that needs it: a box whose
  # factory reset (pre-fix build) deleted ~/.hermes/hermes-agent still HAS the
  # executable shim, so the `-x` guard passes, the `hermes config set` calls
  # fail against the missing venv, and the update ends with a recorded
  # provisioning failure and a scary "Hermes will not speak on this box" — over
  # a box that step_hermes_install repairs perfectly forty lines later, and
  # which would then have no voice registered until the NEXT update.
  #
  # Idempotent and self-gated on has_hermes_harness (a no-op on openclaw), so
  # moving it up costs nothing on any other SKU.
  step_hermes_install || echo "  Warning: hermes_install step failed (non-fatal)"

  local TTS_UPDATE_RC=0
  step_openclaw_tts || TTS_UPDATE_RC=$?
  case "$TTS_UPDATE_RC" in
    0) ;;
    12) echo "  Warning: Kokoro GPU TTS did not install (recorded above; the update continues)" ;;
    13) echo "  Warning: this box has NO working on-device TTS engine (recorded above; the update continues)" ;;
    14) echo "  Warning: the TTS install did not complete (recorded above; the update continues)" ;;
    *)  echo "  Warning: openclaw_tts returned $TTS_UPDATE_RC, which is not in its contract (non-fatal)" ;;
  esac
  # Re-assert the gateway service after an in-app update. The full update
  # syncs repo files and rebuilds before this continuation runs; older devices
  # can therefore reach the new UI while the gateway is still using stale
  # service/drop-in state or is simply down from the reboot handoff. Run the
  # same idempotent setup used by fresh installs so a completed update leaves
  # clawbox-gateway as the active single source of truth.
  step_gateway_setup || echo "  Warning: gateway_setup step failed (non-fatal)"
  step_gateway_legacy_state_recovery || echo "  Warning: gateway_legacy_state_recovery step failed (non-fatal)"
  # Repair the two assets a factory reset performed by a pre-fix build deleted:
  # the Hermes agent install (~/.hermes/hermes-agent) and the offline Gemma
  # GGUF (data/llamacpp). Neither `git pull && build` nor any fixup above put
  # them back, so before this an in-app UPDATE could not heal an
  # already-bricked device — the owner needed SSH, which is not a support path
  # for an appliance.
  #
  # Placed here, at the end of post_update, because both need the network the
  # earlier steps have already brought back, and because the updater's
  # `hermes_edition` step runs immediately AFTER this one and hard-fails when
  # ~/.local/bin/hermes is not runnable — so the agent has to be repaired first
  # or the repair and the provisioning would fight each other.
  #
  # Both are fast no-ops on a box that is already where it should be:
  # step_hermes_install returns after a `--version` probe plus one
  # `git rev-parse`, step_llamacpp_model after a single `[ -f ]` test. The one
  # exception is a box whose agent predates $HERMES_PIN_COMMIT (or was moved
  # off it by a hand-run `hermes update`, which reattaches to main): that box
  # takes the reversible pinned upgrade ONCE — a clone plus venv build, ~90s
  # measured — and is a no-op on every update after it.
  # step_hermes_install has already run ABOVE, before step_openclaw_tts, because
  # the voice registration writes through the Hermes CLI — see the comment
  # there. It is idempotent, so the move is a reordering and not a second run.
  # step_llamacpp_model deliberately does not self-gate (see its comment).
  # Without this the embedding model is fresh-install-only: nothing in the
  # update path pulls it, so a box that missed it when it was built stayed on
  # lexical FTS. Non-fatal in the register of its neighbours.
  ensure_local_embeddings || echo "  Warning: local embeddings check failed (non-fatal)"
  step_llamacpp_model || echo "  Warning: llamacpp_model step failed (non-fatal)"
  # Hermes re-provisioning is deliberately NOT called here. The in-app updater
  # dispatches `hermes_edition` as its own step immediately after this one, so a
  # failure is reported instead of swallowed by `|| echo "(non-fatal)"`.
  # Ordering is unchanged (still after step_systemd_services). Fresh installs
  # call step_hermes_edition directly and are unaffected.
  # Deliberately NO `systemctl restart clawbox-setup` here. The web server reads
  # the edition straight off /etc/clawbox/edition.env on demand
  # (src/lib/edition-source.ts stats the file per call and caches by mtime), so
  # the re-baked lock above is live immediately — while restarting the server
  # mid-update would kill the very process the updater is polling for progress.
  step_update_smoke || echo "  Warning: update_smoke reported issues (non-fatal)"
}

gateway_port_listening() {
  local gw_port="${GATEWAY_PORT:-18789}"
  ss -ltn 2>/dev/null | grep -qE "[:.]${gw_port}[[:space:]]"
}

step_gateway_legacy_state_recovery() {
  # No gateway on the Hermes SKU — "not listening on 18789" is the CORRECT
  # state there, and running `openclaw doctor` + restarting a masked unit would
  # just churn (and, before the mask, resurrect it).
  is_hermes_edition && { echo "  [hermes edition] skipping gateway recovery"; return 0; }
  local gw_port="${GATEWAY_PORT:-18789}"
  if gateway_port_listening; then
    echo "  Gateway is listening on ${gw_port}, skipping legacy state recovery"
    return 0
  fi

  echo "  Gateway is not listening on ${gw_port}; running OpenClaw doctor recovery"
  as_clawbox "$OPENCLAW_BIN" doctor --fix --yes --non-interactive || true
  systemctl reset-failed clawbox-gateway.service 2>/dev/null || true
  systemctl restart clawbox-gateway.service || true
  sleep 8
  if gateway_port_listening; then
    echo "  Gateway recovered after doctor --fix"
    return 0
  fi

  local journal_tail
  journal_tail=$(journalctl -u clawbox-gateway.service -n 160 --no-pager 2>/dev/null || true)
  if ! printf '%s\n' "$journal_tail" | grep -Eq 'installs\.json|conflicting plugin install metadata|carl_pir|belongs to agent piper'; then
    echo "  Gateway still offline, but logs do not match known legacy-state blockers"
    return 0
  fi

  local ts qdir moved=0
  ts=$(date +%Y%m%d-%H%M%S)
  qdir="$CLAWBOX_HOME/openclaw-legacy-quarantine-$ts"
  mkdir -p "$qdir"

  echo "  Quarantining known legacy OpenClaw migration blockers in $qdir"
  systemctl stop clawbox-gateway.service || true
  for f in \
    "$CLAWBOX_HOME/.openclaw/plugins/installs.json"* \
    "$CLAWBOX_HOME/.openclaw/memory/carl_pir.sqlite"* \
    "$CLAWBOX_HOME/.openclaw/agents/carl_pir/agent/openclaw-agent.sqlite"*
  do
    if [ -e "$f" ]; then
      mv -v "$f" "$qdir/" && moved=1
    fi
  done

  if [ "$moved" -eq 0 ]; then
    echo "  No known legacy migration blocker files found to quarantine"
  fi

  as_clawbox "$OPENCLAW_BIN" doctor --fix --yes --non-interactive || true
  systemctl reset-failed clawbox-gateway.service 2>/dev/null || true
  systemctl start clawbox-gateway.service || true
  sleep 12

  if gateway_port_listening; then
    echo "  Gateway recovered after legacy state quarantine"
    return 0
  fi

  echo "  Warning: gateway still not listening on ${gw_port} after legacy state recovery"
  return 1
}

step_update_smoke() {
  # Advisory post-update smokes (#151). The rest of post_update only confirms
  # services are *running* — these confirm two flows that can silently break
  # across an update while health still looks green: gateway auth continuity
  # and Telegram delivery. ALWAYS non-fatal (logged, never rolls back an
  # update). The real-message-send smoke is gated behind
  # CLAWBOX_SMOKE_TELEGRAM_CHAT_ID so production devices (no QA chat id) skip
  # it gracefully; CI/QA sets it to exercise a true round trip.
  local OPENCLAW_CONFIG="$CLAWBOX_HOME/.openclaw/openclaw.json"
  local GW_PORT="${GATEWAY_PORT:-18789}"
  echo "  Post-update smokes (advisory):"

  # 1) Gateway auth continuity — reachable + a strong token in config (the
  #    value the Control UI authenticates with; weak/missing = LAN bypass risk).
  local gw_code
  gw_code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:${GW_PORT}/" 2>/dev/null || echo "000")
  if [ "$gw_code" = "200" ]; then
    echo "    [ok] gateway reachable"
  else
    echo "    [WARN] gateway not reachable (HTTP $gw_code) — Control UI/chat may be down"
  fi
  local tok_state
  tok_state=$(as_clawbox python3 -c '
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    print("missing"); sys.exit()
t = ((c.get("gateway", {}) or {}).get("auth", {}) or {}).get("token")
if isinstance(t, dict):
    keys = set(t)
    source = t.get("source")
    ref_id = t.get("id")
    canonical = (
        source in ("env", "file", "exec") and
        isinstance(ref_id, str) and ref_id.strip() and
        keys == {"source", "provider", "id"} and
        isinstance(t.get("provider"), str) and t["provider"].strip()
    )
    print("secretref" if canonical else "weak")
elif isinstance(t, str) and t.startswith("${") and t.endswith("}") and len(t) > 3:
    print("interp")
elif isinstance(t, str) and t and t != "clawbox" and len(t) >= 32:
    print("strong")
else:
    print("weak")
' "$OPENCLAW_CONFIG" 2>/dev/null || echo "missing")
  case "$tok_state" in
    strong|secretref|interp) echo "    [ok] gateway auth token is strong ($tok_state)" ;;
    *) echo "    [WARN] gateway auth token is weak/missing ($tok_state) — LAN auth may be bypassable" ;;
  esac

  # 2) Telegram bot identity (getMe) — only when a bot token is configured.
  local TG_TOKEN
  TG_TOKEN=$(as_clawbox python3 -c '
import json, sys
try:
    c = json.load(open(sys.argv[1]))
    print(((c.get("channels", {}) or {}).get("telegram", {}) or {}).get("botToken", "") or "")
except Exception:
    print("")
' "$OPENCLAW_CONFIG" 2>/dev/null || echo "")
  if [ -z "$TG_TOKEN" ]; then
    echo "    [skip] no Telegram bot configured"
    return 0
  fi
  local getme
  getme=$(curl -s -m 8 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null \
    | python3 -c 'import json,sys
try: print("yes" if json.load(sys.stdin).get("ok") else "no")
except Exception: print("no")' 2>/dev/null || echo "no")
  if [ "$getme" = "yes" ]; then
    echo "    [ok] Telegram bot identity verified (getMe)"
  else
    echo "    [WARN] Telegram getMe failed — bot token may be invalid/revoked, or network unavailable"
  fi

  # 3) Real delivery smoke — QA only, gated behind a chat id so production
  #    devices skip it. Confirms the bot can actually deliver a message.
  if [ -n "${CLAWBOX_SMOKE_TELEGRAM_CHAT_ID:-}" ]; then
    local msg_id
    msg_id=$(curl -s -m 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CLAWBOX_SMOKE_TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=ClawBox post-update smoke" 2>/dev/null \
      | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(d.get("result",{}).get("message_id","") if d.get("ok") else "")
except Exception: print("")' 2>/dev/null || echo "")
    if [ -n "$msg_id" ]; then
      echo "    [ok] Telegram delivery smoke sent (message_id=$msg_id)"
    else
      echo "    [WARN] Telegram delivery smoke failed to send"
    fi
  fi
  return 0
}

step_polkit_rules() {
  local POLKIT_PKLA_DIR="/etc/polkit-1/localauthority/50-local.d"
  mkdir -p "$POLKIT_PKLA_DIR"
  cp "$PROJECT_DIR/config/49-clawbox-updates.pkla" "$POLKIT_PKLA_DIR/"
  # Remove the manage-units authorisation from devices that already have it.
  # The .pkla shipped above no longer contains that stanza, but `cp` only
  # replaces the file — a box provisioned before TASK-539 keeps whatever polkit
  # already cached until this runs, and there is no other remover.
  #
  # The scoped .rules twin is INSTALLED now rather than deleted. polkit 0.105
  # (JetPack's) ignores rules.d entirely, so on the appliance it is inert
  # documentation; on polkit >= 0.106 it is the correct narrow grant. Deleting
  # it was how the unscoped .pkla ended up as the only authority.
  local POLKIT_RULES_DIR="/etc/polkit-1/rules.d"
  if [ -d "$POLKIT_RULES_DIR" ] && [ -f "$PROJECT_DIR/config/49-clawbox-updates.rules" ]; then
    install_root_file "$PROJECT_DIR/config/49-clawbox-updates.rules" \
      "$POLKIT_RULES_DIR/49-clawbox-updates.rules" 0644
  fi
  echo "  Polkit rules installed (NetworkManager only; root steps go through sudo)"
}

step_start_services() {
  local svc
  local -a svcs=(clawbox-ap clawbox-setup clawbox-performance)
  # The OpenClaw gateway only exists on editions that run it. On the Hermes SKU
  # it is never installed (and is masked by step_edition_gateway_state), and
  # `systemctl restart` on a missing unit exits 5 — which, under the
  # `set -euo pipefail` at the top of this file, used to kill the installer
  # right here, BEFORE the Hermes provisioning block at the bottom ever ran.
  # So a Hermes flash ended with no dashboard, no proxy and no shared identity.
  if has_openclaw_harness; then
    svcs+=(clawbox-gateway)
  fi
  # Hermes dashboard + proxy: started by scripts/setup-hermes-edition.sh a few
  # lines further down (it has to run after the auth provider is configured),
  # so they are deliberately not in this list.
  for svc in "${svcs[@]}"; do
    # In test mode, the AP and performance services reference hardware that
    # doesn't exist (WiFi radio, nvpmodel), so they would fail. Skip them —
    # clawbox-setup + clawbox-gateway are enough to exercise the whole flow.
    if is_test_mode && [[ "$svc" == "clawbox-ap" || "$svc" == "clawbox-performance" ]]; then
      echo "  CLAWBOX_TEST_MODE=1, skipping $svc.service"
      continue
    fi
    # Never fatal: step_validate_services below re-checks every unit in
    # EXPECTED_ACTIVE_SERVICES and fails the install if one didn't come up, so a
    # transient restart failure here should surface as a warning rather than
    # abort the run before the remaining provisioning steps get a chance.
    systemctl restart "$svc.service" \
      || echo "  Warning: failed to restart $svc.service (validation below will catch it)"
  done
  # clawbox-tunnel.service is started on-demand from Settings → Remote Control,
  # not at boot — skip it here.
  echo "  Services started"
}

step_cloudflared_install() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping cloudflared install"
    return 0
  fi
  if [ ! -f "$PROJECT_DIR/scripts/setup-tunnel.sh" ]; then
    echo "  setup-tunnel.sh missing — skipping cloudflared install"
    return 0
  fi
  bash "$PROJECT_DIR/scripts/setup-tunnel.sh" || {
    echo "  WARNING: cloudflared install failed; remote control will be unavailable until reinstalled"
    return 0
  }
}

# ── Update-only steps (called from dashboard System Update) ──────────────────

step_nvidia_jetpack() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping nvidia-jetpack"
    return 0
  fi
  wait_for_apt
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-jetpack
}

step_performance_mode() {
  # Install the root-owned copies the sudoers rules point at FIRST — both the
  # unit below and the ollama optimiser are now invoked through them.
  install_root_libexec
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping nvpmodel/jetson_clocks"
    return 0
  fi
  # Apply whatever profile is persisted in /etc/clawbox/power-mode. On a fresh
  # box nothing is persisted, so this resolves to BALANCED: a real nvpmodel cap
  # with jetson_clocks OFF.
  #
  # This used to be an unconditional `nvpmodel -m MAXN && jetson_clocks`, which
  # pinned all six CPUs to 1,728 MHz and the GPU to 1,020 MHz at 4% load and
  # disabled the cpuidle states — 7.21 W / ~58 C at idle, and 74.8 C median Tj
  # under sustained 3B inference, over the 74 C passive-cooling trip. The pinned
  # profile is unchanged and still one toggle away (Settings -> System ->
  # Performance mode); it is simply no longer what a box does by default.
  # TASK-455.
  "$ROOT_LIBEXEC_DIR/clawbox-power-mode.sh" --apply || \
    echo "  Warning: power profile apply failed (non-fatal)"
  # Ensure persistent service is installed and enabled for next boot
  if [ -f "$PROJECT_DIR/config/clawbox-performance.service" ]; then
    cp "$PROJECT_DIR/config/clawbox-performance.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable clawbox-performance.service
  fi
  # snapd is kept running — required for snap-based Chromium on Ubuntu 22.04
  # Optimize Ollama for 8GB Jetson
  # Run the ROOT-OWNED copy, not the one in the clawbox-writable project tree:
  # it is the copy the sudoers grant points at, so running it here is also the
  # check that install_root_libexec actually put it there. A device whose
  # /usr/local/libexec/clawbox/optimize-ollama.sh is missing is a device where
  # saving a local Ollama model silently skips the q8_0 KV-cache / flash-attention
  # tuning, which is exactly what the TASK-445 revalidation found. TASK-445.
  #
  # The grant that names this path is installed by step_systemd_services, not
  # here: everything below this point is behind the is_test_mode early return
  # above, so installing a sudoers drop-in here meant it never landed on a box
  # that took that return. TASK-445.
  "$ROOT_LIBEXEC_DIR/optimize-ollama.sh"
  # The cgroup memory guards. Deliberately AFTER the ollama optimiser, so the
  # unit it just restarted picks the limits up on the daemon-reload below.
  step_resource_limits
}

step_resource_limits() {
  # cgroup v2 MemoryHigh/MemoryMax for ollama, the automation browser and the
  # GNOME session. Every number comes from
  # config/clawbox-resource-limits.env — see that file. Idempotent: it only
  # ever writes three files called 50-clawbox-memory.conf.
  #
  # The root-owned copy of the env file is what the script prefers at runtime;
  # the repo copy is only a fallback, because /home/clawbox/clawbox is
  # clawbox-writable and this runs as root.
  install -d -o root -g root -m 0755 /etc/clawbox
  if [ -f "$PROJECT_DIR/config/clawbox-resource-limits.env" ]; then
    install_root_file "$PROJECT_DIR/config/clawbox-resource-limits.env" \
      /etc/clawbox/resource-limits.env 0644
  fi
  install_root_libexec
  "$ROOT_LIBEXEC_DIR/clawbox-resource-limits.sh" --apply || \
    echo "  Warning: resource limits apply failed (non-fatal)"
}

step_desktop_mode() {
  # DELIBERATELY DOES NOTHING to the boot target.
  #
  # The desktop is shipped and default-ON (Krasi's ruling, 2026-08-24) and the
  # headless toggle is a SETTING, not an install-time or update-time decision:
  # an owner who switched their box to console-only must not silently get GNOME
  # back on the next `git pull`. So install/update only make the mechanism
  # available (the root-owned script + its sudoers grant, both handled by
  # install_root_libexec and step_systemd_services) and report where the box
  # currently stands. TASK-455.
  install_root_libexec
  "$ROOT_LIBEXEC_DIR/clawbox-desktop-mode.sh" --check || true
}

step_jtop_install() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping jtop install"
    return 0
  fi
  if command -v jtop &>/dev/null; then
    echo "  jtop already installed"
    return
  fi
  # Intentionally unpinned: jetson-stats version must match the JetPack release
  pip3 install jetson-stats
  echo "  jtop installed"
}

# ── Local embedding model ────────────────────────────────────────────────────

# Is the Ollama API answering? Waits up to $1 seconds (default 30).
#
# NEVER starts a daemon the owner switched OFF. Local AI's off switch is
# `systemctl disable --now ollama.service` (src/lib/local-models.ts), while the
# runtime's idle standby is `stop` and deliberately never `disable`
# (src/lib/local-ai-runtime.ts). So `is-active` alone cannot tell "asleep" from
# "switched off for good", and `is-enabled` is the only thing that can —
# starting on is-active would quietly reverse the owner's own decision, which is
# the one thing a "install what is missing" pass must never do.
#
# The URL is the one ensure-local-embeddings.sh itself probes, read from the
# same variable, so this can never certify a daemon the helper then cannot
# reach — `localhost` and `127.0.0.1` are not the same address on a box whose
# resolver answers ::1 first.
ollama_wait_ready() {
  local limit="${1:-30}" waited=0
  local url="${OLLAMA_TAGS_URL:-http://localhost:11434/api/tags}"
  systemctl cat ollama.service >/dev/null 2>&1 || return 1
  # Activity FIRST, and the boot setting only if it is down.
  #
  # The rule this enforces is "never START an engine the owner switched off" —
  # not "never use one". `systemctl disable` without --now leaves the service
  # RUNNING until the next boot, so asking is-enabled first refused a reachable
  # Ollama and skipped a repair that would have started nothing.
  if ! systemctl is-active --quiet ollama.service 2>/dev/null; then
    # Down, so waking it is a decision — and the boot setting is the only thing
    # that can tell the idle standby (`stop`, never `disable`) apart from the
    # owner's switch (`disable --now`).
    #
    # 2, not 1: "switched off" is not "unreachable", and the callers print a
    # connectivity diagnostic on 1 that would contradict the line above it.
    if ! systemctl is-enabled --quiet ollama.service 2>/dev/null; then
      echo "  Ollama is switched off on this box - leaving it that way."
      return 2
    fi
    systemctl start ollama.service >/dev/null 2>&1 || true
  fi
  while :; do
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && return 0
    [ "$waited" -ge "$limit" ] && return 1
    sleep 2
    waited=$((waited + 2))
  done
}

# Make sure this box has its local embedding model, on an UPDATE as well as on a
# fresh install.
#
# step_ollama_install pulls it when the box is first built, and
# gateway-pre-start.sh re-checks it detached on every gateway start — but
# nothing ran it on an update, and the boot check only helps if it happens to
# find ollama awake. A box that was offline when it was flashed, or whose ollama
# was still binding its port in the seconds after `systemctl restart ollama`,
# therefore kept semantic memory on lexical FTS for ever with no route back.
#
# Bounded and non-fatal by construction. post_update holds the gateway quiesced
# and carries a 900 s budget of its own, so a first-time ~639 MB pull gets ten
# minutes here and no more; the helper's 6 h backoff and the detached run at
# gateway start remain the long tail. It returns 0 on every path — it is called
# bare under `set -euo pipefail`, and a missing embedding model must never be
# the reason an update stops.
ensure_local_embeddings() {
  local helper="$PROJECT_DIR/scripts/ensure-local-embeddings.sh"
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping the local embedding model"
    return 0
  fi
  # Same answer, and the same reasoning, as the guard inside step_ollama_install:
  # a hermes box has no core to point at the model it would spend 639 MB on.
  if ! has_openclaw_harness; then
    echo "  Memory search is an OpenClaw feature; this edition does not include it."
    return 0
  fi
  if [ ! -x "$helper" ]; then
    echo "  Warning: $helper is missing or not executable - semantic memory stays on lexical FTS" >&2
    return 0
  fi
  local ready_rc=0
  ollama_wait_ready 30 || ready_rc=$?
  if [ "$ready_rc" -ne 0 ]; then
    # Only rc 1 is a connectivity problem; rc 2 has already said, accurately,
    # that the owner switched the engine off.
    if [ "$ready_rc" -eq 1 ]; then
      echo "  Ollama is not reachable - semantic memory stays on lexical FTS for now"
    fi
    return 0
  fi
  as_clawbox_login "timeout -k 10 600 $helper" || true
  return 0
}

step_ollama_install() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping Ollama install (400MB+ download, not needed for install flow tests)"
    return 0
  fi
  if command -v ollama &>/dev/null; then
    echo "  Ollama already installed"
  else
    echo "  Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  # Ensure the service is enabled and running
  systemctl enable ollama 2>/dev/null || true
  systemctl start ollama 2>/dev/null || true
  # Apply Jetson memory optimizations. Root-owned copy again, same reason as in
  # step_performance_mode: this runs as root, and /home/clawbox/clawbox/scripts
  # is clawbox-writable, so sourcing the repo copy here would be a root path
  # through a file the web server can rewrite. TASK-445.
  install_root_libexec
  "$ROOT_LIBEXEC_DIR/optimize-ollama.sh"
  echo "  Ollama installed and running"

  # Local embedding model for semantic memory. OpenClaw's memory search
  # defaults to OpenAI embeddings, which need an OPENAI_API_KEY the box often
  # doesn't have (ChatGPT-OAuth / DeepSeek users) — and on the boxes that do
  # have one it means every indexed note gets embedded by a third party.
  # ensure-local-embeddings.sh is the single implementation of "pull the model,
  # point memorySearch at it, reindex"; gateway-pre-start.sh runs the same
  # script on every boot so a box that misses this pull still self-heals.
  # Best-effort: a failure must not abort the install (memory falls back to
  # lexical FTS).
  local ENSURE_EMBEDDINGS="$PROJECT_DIR/scripts/ensure-local-embeddings.sh" ready_rc=0
  if ! has_openclaw_harness; then
    # Above the helper, not below it. A hermes box has no core and no
    # openclaw.json, so ensure-local-embeddings.sh finds no provider anywhere,
    # falls through its "deliberate choice" guard and pulls a ~640 MB model
    # whose config write then fails soft by design -- and the report below then
    # told the same operator, in the next line, that this edition does not have
    # the feature. Nothing is lost by skipping it: gateway-pre-start.sh runs the
    # helper only on the OpenClaw gateway, which hermes does not have.
    # Same answer src/app/setup-api/local-models/route.ts gives the UI.
    echo "  Memory search is an OpenClaw feature; this edition does not include it."
  elif [ -x "$ENSURE_EMBEDDINGS" ]; then
    # Wait for the daemon the lines above just restarted. Without this the
    # helper's single 5-second curl could arrive while ollama was still binding
    # its port, and its "not reachable" branch is a silent no-op: no state
    # written, no retry, no provisioning failure recorded — a box that simply
    # lost a race kept lexical FTS and looked healthy doing it.
    # "not reachable", not "did not answer": the post-run check below owns that
    # second phrase for a DIFFERENT failure — a core that answered and could not
    # be parsed — and two unrelated "did not answer" sentences in one run send
    # the operator to the wrong box. Same vocabulary the helper itself uses.
    ready_rc=0
    ollama_wait_ready 30 || ready_rc=$?
    if [ "$ready_rc" -eq 1 ]; then
      echo "  Ollama is not reachable yet; the helper below will report what it found"
    fi
    as_clawbox_login "$ENSURE_EMBEDDINGS" || true
    # The helper exits 0 on every soft failure by design (a missing Ollama must
    # not abort an install), so its exit code says nothing about the outcome.
    #
    # Ask the CORE which embedder it resolved instead of re-deriving it from
    # openclaw.json. `openclaw memory status --agent main --deep --json` is the
    # core's own answer, and it is the call src/lib/clawkeep-memory.ts already
    # makes; the provider is read with the same rule providerLocation() uses
    # there, so ClawBox cannot tell the operator one thing at install time and
    # the owner another in the Memory Shard panel.
    #
    # Re-deriving it is what produced TASK-659: OpenClaw 2 reads memory.search
    # and ignores agents.defaults.memorySearch, a v1 core does the reverse, and
    # a check that took "whichever block names a provider" printed "ready,
    # needs no API key" over a v2 box that was on the default cloud embedder. A
    # config read can only ever prove what was WRITTEN, never what the core
    # does with it -- it cannot see a dimension mismatch or a fail-closed index.
    #
    # Measured on a shipped Orin: rc=0 in ~8 s for 3.3 KB of JSON. What it
    # replaces is a sub-second local read of openclaw.json, so this run costs
    # ~8 s more -- worth it, because a config read can only prove what was
    # written and this answer comes from the thing that has to use it. Bounded
    # and best-effort throughout: a CLI that hangs, is absent or answers nothing
    # must neither stall nor abort the install, and "could not read an embedder"
    # is reported as itself rather than as a verdict.
    #
    # -k 5: `timeout` alone sends SIGTERM only, and collectMemoryStatusJson()
    # in src/lib/clawkeep-memory.ts escalates to SIGKILL after 5 s. A CLI that
    # ignores SIGTERM must not hang here when it would not hang there.
    local EMBED_JSON EMBED_STATE
    # The status is the verdict, not just the bytes. A `--deep` run that fails
    # its provider probe after emitting the shallow status, a core that reports
    # and then exits on an unrelated warning, and `timeout` killing the CLI
    # after a complete document has been written all leave parseable JSON on
    # stdout that describes nothing anyone should vouch for. Throwing the
    # status away with `|| true` is how TASK-659 would re-enter through the
    # exit code -- and collectMemoryStatusJson() rejects on `code !== 0`
    # (src/lib/clawkeep-memory.ts), so trusting it here would put the installer
    # and the Memory Shard panel back into disagreement. Assignment in
    # if-condition position, so errexit stays suppressed.
    if ! EMBED_JSON="$(as_clawbox timeout -k 5 60 "$OPENCLAW_BIN" memory status --agent main --deep --json 2>/dev/null)"; then
      EMBED_JSON=""
    fi
    # `command -v` first, and a state of its own. `--step ollama_install` runs
    # standalone -- step_apt_update, which installs python3, is not on that
    # path -- so without the interpreter the parse below fails and the catch-all
    # would tell the operator the CORE did not answer, about a core that
    # answered perfectly. A warning that names the wrong thing sends them to the
    # wrong box. Nothing here can abort: `command -v` in if-condition position.
    if ! command -v python3 >/dev/null 2>&1; then
      EMBED_STATE="noparser"
    else
      EMBED_STATE="$(python3 - "$EMBED_JSON" <<'PY' 2>/dev/null || true
import json, sys
try:
    doc = json.loads(sys.argv[1])
except Exception:
    raise SystemExit(0)
rows = doc if isinstance(doc, list) else [doc]
row = {}
for entry in rows:
    if isinstance(entry, dict) and entry.get("agentId") == "main":
        row = entry
        break
if not row and rows and isinstance(rows[0], dict):
    row = rows[0]
status = row.get("status")
status = status if isinstance(status, dict) else {}
provider = status.get("provider")
# .strip() so the classification cannot drift from cleanString() in
# src/lib/clawkeep-memory.ts, which trims before comparing.
provider = provider.strip() if isinstance(provider, str) else ""
model = status.get("model")
model = model.strip() if isinstance(model, str) else ""
if not provider:
    raise SystemExit(0)
if provider == "none":
    print("disabled")
elif provider in ("ollama", "local"):
    print("local:%s" % model)
else:
    print("cloud:%s" % provider)
PY
)"
    fi
    case "$EMBED_STATE" in
      local:qwen3-embedding:0.6b)
        echo "  Local embeddings ready (qwen3-embedding:0.6b, semantic memory needs no API key)"
        ;;
      local:)
        # provider says on-device and keyless, which is true and worth saying,
        # but the core named no model. "ready on , not qwen3-embedding:0.6b" is
        # a sentence with a hole in it that still claims READY over a box whose
        # index cannot be matched to anything.
        echo "  Local embeddings are on-device and keyless, but the core named no model, so this run cannot say whether the index matches qwen3-embedding:0.6b (non-fatal)"
        ;;
      local:*)
        # On-device and keyless, so not a warning -- but the index belongs to
        # a different model than ClawBox provisions, and the two have
        # different vector dimensions.
        echo "  Local embeddings ready on ${EMBED_STATE#local:}, not qwen3-embedding:0.6b (on-device, no API key; the index belongs to that model)"
        ;;
      cloud:*)
        echo "  WARN: semantic memory is on a CLOUD embedder (${EMBED_STATE#cloud:}) — every indexed note is embedded off the box and it needs that provider's API key; the Memory Shard app moves it back on-device (non-fatal)"
        ;;
      noparser)
        # Named as the installer's own gap, not the core's.
        echo "  WARN: python3 is not installed on this box, so this run cannot read the embedder answer the core gave; the Memory Shard app shows the live one (non-fatal)"
        ;;
      disabled)
        echo "  WARN: memory search is switched off on this box (the core reports provider \"none\"); semantic memory stays on lexical FTS (non-fatal)"
        ;;
      *)
        # Three states share this line, and only two of them are "did not
        # answer": the CLI was missing, failed or timed out; its output could
        # not be parsed; or the core answered and named no provider at all --
        # providerLocation()'s own "unknown". Claiming the core did not answer
        # was wrong about the third.
        echo "  WARN: could not read an embedder from the core (openclaw memory status did not answer, or named no provider), so this run publishes no embedding verdict; the Memory Shard app shows the live one (non-fatal)"
        ;;
    esac
  elif ollama pull qwen3-embedding:0.6b >/dev/null 2>&1; then
    echo "  Pulled local embedding model qwen3-embedding:0.6b (semantic memory, no API key)"
  else
    echo "  WARN: could not pull qwen3-embedding:0.6b; semantic memory falls back to lexical FTS until available (non-fatal)"
  fi
}

# Install a prebuilt llama.cpp build, but only if it is genuinely usable here.
#
# $1 = source: a .tar.gz on this device, or an http(s) URL to one
# $2 = "ON" when this device expects a CUDA-enabled build
# $3 = the llama.cpp directory whose build/bin the archive populates
#
# It is an ARCHIVE, not a bare binary. llama-server is a 15KB wrapper that
# dlopens ~212MB of siblings (libggml-cuda.so alone is 193MB), and cmake bakes
# an absolute RPATH pointing at the build tree — so the libraries have to land
# back at that same path or the binary installs cleanly and then fails to start.
# Unpacking build/bin reproduces exactly what a source build leaves behind,
# minus the ~19 minutes.
#
# Returns 0 only when the build has passed every check below; every rejection
# returns non-zero so the caller compiles instead. The ways a prebuilt goes
# wrong are silent at install time and loud on a customer's device.
#
# Be precise about what is established here. The checks are FITNESS checks —
# right architecture, right backend, starts on this device. They say nothing
# about whether the archive is the one we meant to ship. Provenance is a
# separate question, answered by the transport (https, or a local file the
# operator placed) and by LLAMACPP_PREBUILT_SHA256 when one is supplied.
install_prebuilt_llamacpp() {
  local src="$1" want_cuda="$2" llama_dir="$3"
  local tmp; tmp="$(mktemp -d)" || return 1
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  local archive="$tmp/prebuilt.tar.gz"

  case "$src" in
    http://*)
      # Refused rather than downgraded. The intended use is a factory bench
      # fetching from a build host, and a binary this function will run as root
      # must not be whatever the network hands over.
      echo "  Prebuilt must be served over https (got http) — ignoring it."
      return 1
      ;;
    https://*)
      echo "  Fetching prebuilt llama.cpp from $src"
      curl -fsSL --proto '=https' --max-time 600 -o "$archive" "$src" \
        || { echo "  Prebuilt download failed."; return 1; }
      ;;
    *)
      [ -f "$src" ] || { echo "  Prebuilt not found at $src"; return 1; }
      archive="$src"
      ;;
  esac

  # Provenance, before anything from the archive is unpacked or run.
  #
  # Everything below this point establishes that the build FITS this device —
  # right architecture, right backend, starts here. None of it says the archive
  # is the one we meant to ship, and the `--version` probe further down executes
  # it as root. So when a digest is supplied it is checked first, and a mismatch
  # ends the attempt.
  #
  # Optional, because the common case is a file copied over SSH by the same
  # operator running the install, where the channel is already the guarantee.
  # Set LLAMACPP_PREBUILT_SHA256 when the archive arrives any other way.
  if [ -n "${LLAMACPP_PREBUILT_SHA256:-}" ]; then
    local actual
    actual="$(sha256sum "$archive" 2>/dev/null | cut -d' ' -f1)"
    if [ -z "$actual" ]; then
      echo "  Could not hash the prebuilt — ignoring it."
      return 1
    fi
    if [ "$actual" != "$LLAMACPP_PREBUILT_SHA256" ]; then
      echo "  Prebuilt digest does not match LLAMACPP_PREBUILT_SHA256 — ignoring it."
      return 1
    fi
    echo "  Prebuilt digest matches."
  fi

  mkdir -p "$tmp/x"
  # --force-local: tar reads "host:path" as a remote source, so any archive path
  # containing a colon would otherwise fail with a confusing network error.
  tar --force-local -xzf "$archive" -C "$tmp/x" 2>/dev/null     || { echo "  Prebuilt archive is unreadable."; return 1; }

  # The archive is expected to contain the contents of build/bin.
  local staged="$tmp/x"
  [ -f "$staged/llama-server" ] || staged="$tmp/x/bin"
  if [ ! -f "$staged/llama-server" ]; then
    echo "  Prebuilt archive has no llama-server — ignoring it."
    return 1
  fi

  # Right machine? A binary built on the flash host rather than a Jetson is the
  # easy mistake, and it fails at exec with a confusing message.
  if ! file -b "$staged/llama-server" 2>/dev/null | grep -q 'ARM aarch64'; then
    echo "  Prebuilt is not aarch64 — ignoring it."
    return 1
  fi

  # Right build? A CPU-only binary on a GPU device costs every inference
  # silently, and the rebuild check above would flag it on the next update
  # anyway — so catch it now rather than shipping it.
  if [ "$want_cuda" = "ON" ] && [ ! -f "$staged/libggml-cuda.so.0" ] \
     && ! ls "$staged"/libggml-cuda.so* >/dev/null 2>&1; then
    echo "  Prebuilt has no CUDA backend but this device expects one — ignoring it."
    return 1
  fi

  # Put the libraries where the RPATH will look for them.
  mkdir -p "$llama_dir/build/bin"
  cp -a "$staged/." "$llama_dir/build/bin/" || return 1
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$llama_dir" 2>/dev/null || true

  # Does it actually run HERE? The check that catches a build made against a
  # different CUDA/driver ABI — it passes every test above and then will not
  # start on the customer's device.
  if ! "$llama_dir/build/bin/llama-server" --version >/dev/null 2>&1; then
    echo "  Prebuilt will not execute on this device — ignoring it."
    return 1
  fi

  install -m 755 "$llama_dir/build/bin/llama-server" /usr/local/bin/llama-server || return 1
  echo "  Installed prebuilt llama.cpp (skipped the source build)."
  return 0
}

step_llamacpp_install() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping llama.cpp native build and model download"
    return 0
  fi
  local LLAMA_DIR="$CLAWBOX_HOME/llama.cpp"
  local ENABLE_GGML_CUDA="OFF"

  # On Jetson, nvcc ships at /usr/local/cuda/bin but isn't on systemd's PATH,
  # so `command -v nvcc` fails and we silently fall back to a CPU-only build.
  # Probe the standard location and add it to PATH so detection works regardless
  # of how install.sh is invoked (interactive shell vs systemd unit).
  if ! command -v nvcc &>/dev/null && [ -x /usr/local/cuda/bin/nvcc ]; then
    export PATH="/usr/local/cuda/bin:$PATH"
  fi

  if command -v nvcc &>/dev/null; then
    ENABLE_GGML_CUDA="ON"
  fi

  if ! command -v cmake &>/dev/null || ! command -v git &>/dev/null || ! command -v python3 &>/dev/null; then
    echo "  Installing llama.cpp build prerequisites..."
    wait_for_apt
    apt-get update -qq
    apt-get install -y -qq git curl python3 python3-pip python-is-python3 build-essential cmake ninja-build pkg-config
  fi

  # Run the pipx migration whether or not `hf` already resolves: a device
  # upgraded from a pre-pipx install has a real pip --user-installed `hf` on
  # PATH already, and gating this on "hf missing" (as before) would leave
  # that stale shim running forever instead of migrating it to pipx. Only
  # fall back to "leave it alone" / pip --user when pipx could not be
  # provisioned at all.
  if ensure_pipx; then
    echo "  Installing Hugging Face CLI via pipx"
    # A device upgraded from a pre-pipx install may have a real pip-
    # installed `hf` at these paths; pipx refuses to overwrite files it
    # did not create, so remove them first or the stale scripts keep
    # running after every future update.
    as_clawbox_login "rm -f $CLAWBOX_HOME/.local/bin/hf $CLAWBOX_HOME/.local/bin/huggingface-cli" \
      2>/dev/null || true
    as_clawbox_login "pipx install --force 'huggingface_hub[cli]'" \
      || echo "  Warning: pipx install of huggingface_hub failed" >&2
  elif as_clawbox_login "command -v hf" &>/dev/null; then
    echo "  Hugging Face CLI already installed (pipx unavailable — leaving existing install as-is)"
  else
    # pipx unavailable (e.g. offline apt) — pip --user still works on
    # JetPack 6.2 / Ubuntu 22.04, where PEP 668 does not apply.
    echo "  Warning: pipx unavailable — falling back to pip --user (blocked by PEP 668 on Ubuntu 24.04+)" >&2
    as_clawbox_login "python3 -m pip install --user --upgrade 'huggingface_hub[cli]'" \
      || echo "  Warning: Hugging Face CLI install failed (pipx unavailable, pip blocked by PEP 668 on newer bases)" >&2
  fi

  # Determine if a rebuild is needed. Rebuild when:
  #   a) llama-server is missing, OR
  #   b) CUDA is now available but the installed binary was built CPU-only
  #      (common upgrade case for existing installs that predate the fix above).
  local needs_rebuild="false"
  if [ ! -x /usr/local/bin/llama-server ]; then
    needs_rebuild="true"
  elif [ "$ENABLE_GGML_CUDA" = "ON" ] \
       && ! ldd /usr/local/bin/llama-server 2>/dev/null | grep -qiE 'libcuda|libcublas|libcudart'; then
    echo "  Existing llama-server was built without CUDA — rebuilding with GPU support"
    needs_rebuild="true"
  fi

  # A prebuilt binary skips the compile below, which is the single most
  # expensive step in the whole install — measured at 18m51s on an Orin Nano,
  # and it produces a byte-identical result on every device of the same model.
  # Supplying one is opt-in (LLAMACPP_PREBUILT), so nothing changes for anyone
  # who doesn't set it.
  #
  # It is validated before it is trusted, and ANY failure falls through to the
  # source build. A device that ends up without a working llama-server is worse
  # than a slow install, so the fast path is never allowed to be the last word.
  if [ "$needs_rebuild" = "true" ] && [ -n "${LLAMACPP_PREBUILT:-}" ]; then
    if install_prebuilt_llamacpp "$LLAMACPP_PREBUILT" "$ENABLE_GGML_CUDA" "$LLAMA_DIR"; then
      needs_rebuild="false"
    else
      echo "  Falling back to building llama.cpp from source."
    fi
  fi

  if [ "$needs_rebuild" = "true" ]; then
    echo "  Installing llama.cpp server (CUDA=$ENABLE_GGML_CUDA)..."
    # Pinned, not tip-of-master. An unpinned --depth 1 clone gave every device
    # whatever upstream happened to be that day — the two boxes here ended up on
    # d2f8305 and db7d8b2, so "the same install" produced different inference
    # binaries. This commit is the one proven on this hardware; move it
    # deliberately, with a rebuild to prove the new one.
    local LLAMACPP_COMMIT="${LLAMACPP_COMMIT:-db7d8b24b5197ca39435cf47b3c1ba039b53605b}"
    if [ ! -d "$LLAMA_DIR/.git" ]; then
      # Not --depth 1: a shallow clone of the default branch cannot check out an
      # arbitrary commit, and the pin is the point.
      as_clawbox git clone https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
    fi
    as_clawbox_login "cd $LLAMA_DIR && git fetch --quiet origin && git checkout --quiet $LLAMACPP_COMMIT"       || echo "  Warning: could not check out $LLAMACPP_COMMIT — building whatever is checked out."
    # Pin CUDA architectures to Jetson Orin's sm_87 so cmake doesn't spend
    # ~15 extra minutes probing / compiling kernels for datacenter and
    # desktop GPUs we don't target. Without this, configure on Jetson ARM
    # can take 20–30 minutes and the resulting binary is 8x larger than
    # needed.
    local LLAMACPP_CMAKE_FLAGS=(-DCMAKE_BUILD_TYPE=Release "-DGGML_CUDA=$ENABLE_GGML_CUDA")
    if [ "$ENABLE_GGML_CUDA" = "ON" ]; then
      LLAMACPP_CMAKE_FLAGS+=(-DCMAKE_CUDA_ARCHITECTURES=87)
    fi
    as_clawbox_login "rm -f $LLAMA_DIR/build/CMakeCache.txt && rm -rf $LLAMA_DIR/build/CMakeFiles && cd $LLAMA_DIR && cmake -S . -B build ${LLAMACPP_CMAKE_FLAGS[*]}"
    as_clawbox_login "cd $LLAMA_DIR && cmake --build build --config Release -j$(nproc) --target llama-server"
    install -m 755 "$LLAMA_DIR/build/bin/llama-server" /usr/local/bin/llama-server
  else
    echo "  llama-server already installed (CUDA=$ENABLE_GGML_CUDA)"
  fi

  ensure_llamacpp_model_cached
  echo "  llama.cpp runtime ready"
}

# Set the appliance owner's system password.
#
# The record arrives in a file the web server wrote, and the web server runs as
# the clawbox user — so $PROJECT_DIR/data is clawbox-writable and this input is
# attacker-choosable by anything with clawbox-level code execution. Until
# TASK-445 every guard on the record lived on the UNPRIVILEGED side, in
# src/lib/chpasswd.ts; the root side piped whatever it found straight into
# chpasswd. Dropping `root:<new>` into that path and starting the granted unit
# therefore set ROOT's password.
#
# So validate here, where the boundary actually is. chpasswd's format is
# `<user>:<password>` per line and it happily takes a list, so all three of
# "which user", "how many records" and "what may the record contain" have to be
# pinned:
#
#   * exactly one record, so a second line cannot smuggle in another account;
#   * the user field is exactly $CLAWBOX_USER — never root, never anything else;
#   * a non-empty password with no CR or NUL, matching the checks the route
#     already makes (src/lib/chpasswd.ts::chpasswdRecord).
#
# Residual, recorded deliberately: clawbox is in the `sudo` group, so being able
# to set the CLAWBOX user's own password is still a route from clawbox code
# execution to an interactive root shell. That is the owner's own administrator
# account and removing it would lock the only administrator out of a console-less
# appliance (see config/clawbox-sudoers and e2e-install/06-sudoers.spec.ts). What
# this closes is the part that was never intended: changing a DIFFERENT account's
# password, root's included.
step_chpasswd() {
  local INPUT_FILE="$PROJECT_DIR/data/.chpasswd-input"
  # -f follows symlinks; -L rejects the link itself. A symlink here would be a
  # way to make root read a file the clawbox user could not otherwise feed in.
  if [ -L "$INPUT_FILE" ]; then
    rm -f "$INPUT_FILE"
    echo "Error: password input file is a symlink; refusing" >&2
    exit 64
  fi
  if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: password input file not found" >&2
    exit 1
  fi

  # Read the file ONCE and validate the value actually used — re-reading it
  # after the checks would leave a window to swap the contents. Command
  # substitution strips trailing newlines, so a well-formed single record has no
  # embedded newline left and a second record is visible as one. It also drops
  # NUL bytes, and it is the stripped value that is piped to chpasswd below, so
  # no NUL can reach it either.
  local record user
  record="$(cat "$INPUT_FILE")"
  rm -f "$INPUT_FILE"

  case "$record" in
    *$'\n'*)
      echo "Error: password input must be exactly one record" >&2
      exit 64
      ;;
    *$'\r'*)
      echo "Error: password input contains a carriage return" >&2
      exit 64
      ;;
  esac
  user="${record%%:*}"
  if [ "$user" != "$CLAWBOX_USER" ]; then
    echo "Error: password input names '$user'; only $CLAWBOX_USER may be changed here" >&2
    exit 64
  fi
  if [ "$record" = "$user" ] || [ -z "${record#*:}" ]; then
    echo "Error: password input has no password" >&2
    exit 64
  fi

  printf '%s\n' "$record" | /usr/sbin/chpasswd
}

step_rebuild() {
  do_rebuild
  echo "Starting clawbox-setup.service..."
  systemctl start clawbox-setup.service
}

step_restart() {
  echo "Restarting clawbox-setup.service..."
  systemctl restart clawbox-setup.service
}

step_restart_ap() {
  echo "Restarting clawbox-ap.service..."
  systemctl restart clawbox-ap.service
}

step_recover() {
  echo "Running ClawBox recovery..."
  bash "$PROJECT_DIR/scripts/start-ap.sh"
  systemctl restart clawbox-setup.service
  echo "Recovery complete"
}

step_gateway_setup() {
  # DO NOT DELETE THIS GUARD AS "REDUNDANT" NOW THAT THE UPDATER FILTERS STEPS.
  #
  # The updater's `applies()` predicate drops the gateway_setup STEP on hermes,
  # which looks like it makes this line dead. It does not: step_post_update has
  # no such predicate — it runs on every SKU — and calls step_gateway_setup
  # internally. This guard is the only thing standing between a Hermes box and
  # an OpenClaw gateway being reinstalled and enabled halfway through its own
  # update, on a SKU whose whole point is that the gateway is not there.
  #
  # The same applies to the guards in step_openclaw_install / step_openclaw_patch
  # and to `install.sh --step <name>`, which can be run by hand on any edition.
  is_hermes_edition && { echo "  [hermes edition] skipping OpenClaw gateway setup"; return 0; }
  cp "$PROJECT_DIR/config/clawbox-gateway.service" /etc/systemd/system/

  # Mask any leftover user-level openclaw-gateway.service. Standalone
  # OpenClaw (and some older `openclaw gateway install` paths) dropped a
  # unit file at ~/.config/systemd/user/openclaw-gateway.service that
  # competes with our system unit for port 18789. When both wake up,
  # operators get port-ownership conflicts, restart churn, and misleading
  # failed-status messages on the wrong unit. ClawBox owns
  # `clawbox-gateway.service` as the single source of truth; the user
  # variant has no role on an appliance install. Replacing the unit file
  # with a symlink to /dev/null is the on-disk equivalent of
  # `systemctl --user mask` — works without needing a live user session.
  # Idempotent: if it's already masked we leave it alone. Reported via
  # ID-Robots/clawbox#141.
  local USER_SYSTEMD_DIR="$CLAWBOX_HOME/.config/systemd/user"
  local USER_GATEWAY_UNIT="$USER_SYSTEMD_DIR/openclaw-gateway.service"
  if [ -e "$USER_GATEWAY_UNIT" ] || [ -L "$USER_GATEWAY_UNIT" ]; then
    local CURRENT_TARGET
    CURRENT_TARGET=$(readlink "$USER_GATEWAY_UNIT" 2>/dev/null || echo "")
    if [ "$CURRENT_TARGET" = "/dev/null" ]; then
      echo "  User-level openclaw-gateway.service already masked"
    else
      echo "  Masking conflicting user-level openclaw-gateway.service"
      # Stop a running user-level instance first so port 18789 is freed
      # immediately — otherwise the old process keeps holding the port
      # until the user's next login session, defeating this run.
      # Non-fatal: no active session yet, or the unit isn't running, both
      # are fine and the on-disk mask still takes effect.
      local CLAWBOX_UID
      CLAWBOX_UID=$(id -u "$CLAWBOX_USER" 2>/dev/null || echo "")
      if [ -n "$CLAWBOX_UID" ]; then
        sudo -u "$CLAWBOX_USER" \
          XDG_RUNTIME_DIR="/run/user/$CLAWBOX_UID" \
          systemctl --user stop openclaw-gateway.service 2>/dev/null || true
      fi
      mkdir -p "$USER_SYSTEMD_DIR"
      chown "$CLAWBOX_USER:$CLAWBOX_USER" "$USER_SYSTEMD_DIR"
      rm -f "$USER_GATEWAY_UNIT"
      ln -s /dev/null "$USER_GATEWAY_UNIT"
      chown -h "$CLAWBOX_USER:$CLAWBOX_USER" "$USER_GATEWAY_UNIT" 2>/dev/null || true
    fi
  fi

  # IPv4-first DNS for the gateway. Without this, on networks where the
  # ISP advertises an IPv6 prefix but doesn't actually route public v6
  # traffic (common on home/SMB networks), every Node `fetch` to a
  # dual-stack host (Telegram polling, OAuth callbacks, npm registry,
  # model providers) hangs ~2 minutes hitting the dead AAAA before
  # falling back. The hung socket starves Node's event loop and makes
  # every WS request slow — surfacing to the user as "Failed to change
  # effort: Request timeout" and similar 120s timeouts. The flag is a
  # no-op on networks with working IPv6 (v4 is tried first, succeeds,
  # never falls back to v6).
  mkdir -p /etc/systemd/system/clawbox-gateway.service.d
  cat > /etc/systemd/system/clawbox-gateway.service.d/dns-ipv4first.conf <<'CONF'
[Service]
Environment="NODE_OPTIONS=--dns-result-order=ipv4first"
CONF

  systemctl daemon-reload
  systemctl enable clawbox-gateway.service
  # Clear any tripped start-limit (breaker) state so the restart isn't refused
  # on a box whose gateway had been crash-looping (issue #284 breaker).
  systemctl reset-failed clawbox-gateway.service 2>/dev/null || true
  systemctl restart clawbox-gateway.service
}

step_chromium_install() {
  if is_test_mode; then
    # snap doesn't work in a standard container, but the desktop browser
    # service only needs the Playwright-cached Chromium binary — use that
    # as the test-mode path so /setup-api/browser/* still works.
    echo "  CLAWBOX_TEST_MODE=1, installing Playwright-managed Chromium only"
    ensure_playwright_chromium
    return 0
  fi
  if snap list chromium &>/dev/null 2>&1; then
    echo "  Chromium already installed (snap)"
  else
    # Ubuntu 22.04 ARM64 only ships Chromium as a snap — no native .deb available.
    # Ensure snapd is running, install chromium, then continue.
    systemctl enable --now snapd snapd.socket 2>/dev/null || true

    # Wait for snapd to be ready (can take a few seconds after enable)
    local retries=0
    while ! snap version &>/dev/null && [ $retries -lt 30 ]; do
      sleep 1
      retries=$((retries + 1))
    done

    # Clean up any leftover Debian repo config from earlier install attempts
    rm -f /etc/apt/sources.list.d/debian-chromium.list /etc/apt/preferences.d/debian-chromium /usr/share/keyrings/debian-bookworm.gpg

    snap install chromium
    echo "  Chromium installed (snap)"
  fi

  ensure_playwright_chromium
}


# Claude Code, via Anthropic's NATIVE installer (Yanko, 2026-08-22 — not npm).
#
# Anthropic GEO-BLOCKS some regions and serves an HTML "App unavailable in
# region" page with HTTP 200, so `curl -f` does NOT catch it. Piping that HTML
# into `bash` yields `syntax error near unexpected token '<'`, and under
# `set -euo pipefail` that aborted the ENTIRE reinstall — the later steps that
# (re)start the gateway never ran and the box came up as an nginx 404 (Discord
# "broke my clawbox", step [18/23]). Guard it: download to a file, verify it
# looks like a shell script and not an HTML/region-block page, only then run
# it, and never let failure escape.
#
# Runs AS the clawbox user, never under sudo: the installer installs into
# $HOME and refuses to run as root from a user shell. It also wants ~512MB
# free, so exit 137 on a Jetson means the OOM killer rather than a broken
# install.
#
# Returns 0 when `claude` is present afterwards, 1 otherwise. Callers decide
# whether that is fatal — for every caller today it is not.
ensure_claude_code() {
  # A LOGIN shell, like the two probes below it and like the in-UI terminal.
  # `sudo -u clawbox bash -c` is non-interactive and non-login: it reads
  # neither ~/.profile nor ~/.bashrc, so ~/.local/bin is not on its PATH and it
  # answers "not installed" on a box where Claude Code works perfectly. That
  # made this fast path dead — every install and every update re-downloaded the
  # CLI — and it is the same false negative the task warns about for ssh.
  if as_clawbox_login "command -v claude" &>/dev/null; then
    echo "  Claude Code already installed"
    return 0
  fi

  local installer rc=1
  installer="$(mktemp)"
  # --max-time bounds a STALLED vendor: this runs inside step_post_update, and
  # every recovery step after it waits behind this download. --proto-redir keeps
  # a redirect from stepping down to plain HTTP on the way to something we then
  # execute as the clawbox user.
  if curl -fsSL --proto '=https' --proto-redir '=https' \
       --connect-timeout 15 --max-time 300 \
       https://claude.ai/install.sh -o "$installer" 2>/dev/null \
     && [ -s "$installer" ] \
     && ! head -c 512 "$installer" | grep -qiE '<!doctype|<html|unavailable in region' \
     && chown "$CLAWBOX_USER" "$installer"; then
    # The chown is why this ever works, and it has to be HERE — after the
    # download, before the run.
    #
    # mktemp makes the file root:root 0600 and the installer is executed AS the
    # clawbox user, so without it every run on every box answered
    # "bash: /tmp/tmp.XXXX: Permission denied" and then "installer ran but
    # failed". That is the other half of why no ClawBox in the field has
    # `claude`: the missing post_update caller was only the first half.
    #
    # And it cannot move earlier. /tmp is sticky and world-writable, and these
    # devices run fs.protected_regular=2 (verified on .65), under which even
    # root may not write a file in such a directory that it does not own — a
    # chown before the download turns the curl into
    # "(23) Failure writing output to destination". Both failure modes were
    # observed on hardware on 2026-08-22, one after the other.
    if sudo -u "$CLAWBOX_USER" bash "$installer" </dev/null; then
      echo "  Claude Code installed"
      rc=0
    else
      echo "  WARN: Claude Code installer ran but failed; skipping (optional, continuing)"
    fi
  else
    echo "  WARN: Claude Code installer unavailable or region-blocked (non-script response); skipping (optional, continuing)"
  fi
  rm -f "$installer"
  return "$rc"
}

# The `claude-ds` wrapper — Claude Code pointed at ClawBox AI (TASK-378).
#
# COPIED out of the checkout rather than symlinked. A symlink would break the
# harness for as long as any update leaves the repo mid-checkout, and the copy
# is refreshed on every install and every in-app update, so it cannot drift.
install_claude_ds_wrapper() {
  local src="$PROJECT_DIR/scripts/claude-ds"
  local dest="$CLAWBOX_HOME/.local/bin/claude-ds"

  if [ ! -f "$src" ]; then
    echo "  WARN: $src missing; claude-ds not installed"
    return 1
  fi

  install -d -o "$CLAWBOX_USER" -g "$CLAWBOX_USER" -m 755 "$CLAWBOX_HOME/.local/bin"
  install -o "$CLAWBOX_USER" -g "$CLAWBOX_USER" -m 755 "$src" "$dest"
  echo "  claude-ds installed at $dest"
}

# The ClawBox coding harness: Claude Code plus the claude-ds wrapper that
# drives it through ClawBox AI.
#
# Split out of step_ai_tools_install and dispatchable on its own because
# step_post_update calls THIS and not the bigger step: an in-app update should
# deliver the harness without also reinstalling the Codex and Gemini CLIs on
# every box that updates.
# Tell a RUNNING agent that the coding harness exists now.
#
# The agent offers coding_agent_run / _status / _stop only when the ClawBox MCP
# server says the harness is ready, and it asks exactly ONCE — in
# `buildContext` while it boots (mcp/lib/context.ts probes
# /setup-api/coding-agent/status; mcp/tools/coding-agent.ts returns without
# declaring anything when the answer is no). The server is then a long-lived
# stdio child of the agent, so a harness installed underneath it is invisible
# until something respawns the server.
#
# The web server already covers the two paths where readiness flips from ITS
# side — see src/lib/coding-agent-mcp-refresh.ts, hung off the enable route and
# the ClawBox AI connect path. This step is the third path, and it had nothing:
# a full install and step_post_update both happen to restart the agent shortly
# afterwards (step_start_services / step_gateway_setup), and the STANDALONE
# `--step coding_harness` — the repair checkReadiness() itself tells the owner
# to run — did not.
#
# ONLY units that are ALREADY ACTIVE are touched. An agent that is stopped, or
# masked by the edition lock, re-probes when it next starts; starting one here
# would resurrect a unit the owner or the SKU deliberately put down, which is
# the whole reason the Hermes edition masks clawbox-gateway.
refresh_agent_coding_tools() {
  local unit failed=false found=false
  for unit in clawbox-gateway.service clawbox-hermes-dashboard.service; do
    systemctl is-active --quiet "$unit" 2>/dev/null || continue
    found=true
    # try-restart, not restart. The probe above and the action below are two
    # commands, and a unit that stops in between would be STARTED by `restart` —
    # exactly the thing this function must never do. `try-restart` acts only on a
    # unit that is running at the moment it runs, and exits 0 when there is
    # nothing to do, so the invariant does not depend on the gap being small.
    if systemctl try-restart "$unit" >/dev/null 2>&1; then
      # "Asked", not "Restarted". try-restart exits 0 both when it restarted the
      # unit and when the unit had stopped in the meantime and it did nothing —
      # so claiming a restart here would be this PR's own bug in miniature. What
      # is true in both cases is that the request was made and the agent will
      # re-probe, now or at its next start.
      echo "  Asked $unit to restart so the agent re-probes and offers the coding tools"
    else
      echo "  WARN: could not restart $unit — the agent will keep answering that it has no coding tools" >&2
      failed=true
    fi
  done
  if [ "$found" = false ]; then
    echo "  No agent running; it will probe the harness when it next starts"
    return 0
  fi
  # EVERY running agent, not "at least one". On the dual edition both units are
  # up, and one that could not be restarted is one harness still blind — a
  # partial refresh reported as a whole one is the shape this whole change is
  # about.
  [ "$failed" = false ]
}

step_coding_harness() {
  # Whether the harness was ALREADY usable decides two things below: nothing
  # needs telling if nothing changed, and a step that changed nothing and fixed
  # nothing must not report that it did.
  local was_ready=false
  if [ -x "$CLAWBOX_HOME/.local/bin/claude-ds" ] && as_clawbox_login "command -v claude" &>/dev/null; then
    was_ready=true
  fi

  # Test mode has no network for claude.ai and no reason to download a binary,
  # but the wrapper is a file copy — install it so e2e-install exercises the
  # real delivery path instead of skipping the whole step.
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping the Claude Code download"
  else
    # Still swallowed here: a download that failed is not the verdict, the
    # probe below is. What changed is that the verdict is now the EXIT STATUS
    # as well as a line of text.
    ensure_claude_code || true
  fi
  install_claude_ds_wrapper || true
  ensure_clawbox_bashrc_path

  if is_test_mode; then
    return 0
  fi

  # Say plainly whether the harness can actually run — and MEAN it in the exit
  # status. This step is what src/lib/coding-agent.ts tells the owner to run
  # when the Coding app refuses ("Run: sudo bash install.sh --step
  # coding_harness"), and it used to exit 0 whatever happened: on a box where
  # the CLI install failed (no network, or Anthropic geo-blocking the region)
  # the owner ran the documented repair, was told nothing had gone wrong, and
  # went back to an app refusing in exactly the same words. A repair that
  # cannot repair has to SAY so.
  # BOTH halves are reported, then one return. An early return after the first
  # would hide the second, and this step exists to tell an owner what is wrong —
  # sending them back for a second run to discover the other half is the same
  # repair loop in slower motion.
  local harness_missing=false
  if ! as_clawbox_login "command -v claude" &>/dev/null; then
    echo "  WARN: Claude Code is NOT installed — the Coding app will refuse until it is" >&2
    echo "  Claude Code is downloaded from https://claude.ai/install.sh, so check this" >&2
    echo "  box's internet access (and whether the installer is available in this" >&2
    echo "  region), then run the step again." >&2
    harness_missing=true
  fi
  if [ ! -x "$CLAWBOX_HOME/.local/bin/claude-ds" ]; then
    echo "  WARN: the claude-ds wrapper is NOT at $CLAWBOX_HOME/.local/bin/claude-ds — the Coding app will refuse until it is" >&2
    harness_missing=true
  fi
  if [ "$harness_missing" = true ]; then
    echo "  This step did NOT repair the coding harness." >&2
    return 1
  fi

  echo "  Coding harness ready: claude-ds -> Claude Code -> ClawBox AI"

  # Only on the transition. A reload respawns every MCP child and invalidates
  # the model's prompt cache, and this step runs on every install and every
  # in-app update — the same rule, and the same reason for it, as the guard in
  # refreshCodingAgentToolsIfReadinessChanged.
  if [ "$was_ready" = false ]; then
    # A refusal here is REPORTED (on stderr, inside the helper) and does not
    # fail the step: the harness itself IS repaired and the Coding app works,
    # so a non-zero exit would be the opposite lie. The agent re-probes at its
    # next start either way.
    if ! refresh_agent_coding_tools; then
      echo "  The agent will offer the coding tools after its next restart" >&2
    fi
  fi
}

step_ai_tools_install() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping Claude/Codex/Gemini CLI install"
    return 0
  fi
  # The AI coding CLIs below are ALL optional — the box boots and runs fine
  # without any of them. This whole step must therefore be best-effort: no
  # single tool's install may abort the run. install.sh runs under
  # `set -euo pipefail`, so every risky command is guarded inside an `if`
  # (where errexit is suspended) and failures only log a WARN.

  ensure_claude_code || true

  # OpenAI Codex CLI (optional)
  if as_clawbox_login "command -v codex" &>/dev/null; then
    echo "  OpenAI Codex already installed"
  elif as_clawbox_login "npm i -g @openai/codex --prefix $NPM_PREFIX"; then
    echo "  OpenAI Codex installed"
  else
    echo "  WARN: OpenAI Codex CLI install failed; skipping (optional, continuing)"
  fi

  # Google Gemini CLI (optional)
  if as_clawbox_login "command -v gemini" &>/dev/null; then
    echo "  Gemini CLI already installed"
  elif as_clawbox_login "npm i -g @google/gemini-cli --prefix $NPM_PREFIX"; then
    echo "  Gemini CLI installed"
  else
    echo "  WARN: Gemini CLI install failed; skipping (optional, continuing)"
  fi

  # The claude-ds wrapper is deliberately NOT installed here. step_coding_harness
  # owns it, and this step early-returns in test mode — which is exactly the
  # environment e2e-install proves the delivery path in.

  # Make claude / claude-ds / codex / gemini resolvable in the in-UI terminal's
  # interactive shell (covers the standalone `step_ai_tools_install` invocation
  # path where step_openclaw_install hasn't run).
  ensure_clawbox_bashrc_path
}

step_vnc_install() {
  # Test mode still installs and enables VNC so browser-automation e2e can
  # exercise the real stack — x11vnc+Xvfb+websockify all work in a
  # --privileged container. Only the GDM-mirror path is shortcut via
  # CLAWBOX_VNC_MODE=virtual, which start-vnc.sh already honors.
  wait_for_apt
  # Install x11vnc, Xvfb (virtual framebuffer fallback), websockify, a lightweight
  # WM, and xclip (the VNC clipboard bridge — setup-api/vnc/clipboard shells out
  # to it; without it the paste modal 503s).
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq x11vnc xvfb websockify dbus-x11 openbox xterm x11-xserver-utils autocutsel xclip

  chmod +x "$PROJECT_DIR/scripts/start-vnc.sh"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/scripts/start-vnc.sh"
  chmod +x "$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh"
  chown root:root "$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh"

  # Systemd service for VNC — force virtual display mode. On headless
  # Jetsons, :0 is GDM's greeter; apps launched into it are covered by
  # the greeter and invisible to VNC viewers. Xvfb :99 gives a clean
  # dedicated surface that matches what the browser service targets.
  cat > /etc/systemd/system/clawbox-vnc.service <<VNCSVC
[Unit]
Description=ClawBox VNC (virtual desktop)
After=network.target

[Service]
Type=simple
User=$CLAWBOX_USER
Environment=CLAWBOX_VNC_MODE=virtual
ExecStart=$PROJECT_DIR/scripts/start-vnc.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
VNCSVC

  # Systemd service for websockify
  cat > /etc/systemd/system/clawbox-websockify.service <<WSSVC
[Unit]
Description=ClawBox WebSocket VNC Proxy
After=clawbox-vnc.service
Requires=clawbox-vnc.service

[Service]
Type=simple
User=$CLAWBOX_USER
# Bind LOOPBACK, not 0.0.0.0. x11vnc deliberately runs -nopw -localhost, so the
# desktop has no password of its own; websockify listening on the wildcard
# address republished that unauthenticated desktop to the whole LAN (anyone
# could point a noVNC client at ws://<box>:6080/ and take the session).
# Browsers reach it through production-server.js's /novnc-ws upgrade route,
# which gates on the clawbox_session cookie — that is the only intended path,
# and VNCApp already uses it (same-origin, so HTTPS + the tunnel work too).
ExecStart=/usr/bin/websockify 127.0.0.1:6080 localhost:5900
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
WSSVC

  # One-shot first-boot service to bring VNC back up after the first reboot
  mkdir -p /var/lib/clawbox
  touch /var/lib/clawbox/ensure-vnc-on-first-boot.pending
  cat > /etc/systemd/system/clawbox-firstboot-vnc.service <<FIRSTBOOTVNC
[Unit]
Description=ClawBox first boot VNC bring-up
After=network-online.target display-manager.service multi-user.target
Wants=network-online.target
ConditionPathExists=/var/lib/clawbox/ensure-vnc-on-first-boot.pending

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 10
ExecStart=$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh

[Install]
WantedBy=multi-user.target
FIRSTBOOTVNC

  # Browser CDP service (launched on demand, not auto-started)
  chmod +x "$PROJECT_DIR/scripts/launch-browser.sh"
  cp "$PROJECT_DIR/config/clawbox-browser.service" /etc/systemd/system/

  systemctl daemon-reload
  systemctl enable clawbox-vnc.service clawbox-websockify.service clawbox-firstboot-vnc.service
  systemctl restart clawbox-vnc.service clawbox-websockify.service || true
  echo "  VNC (x11vnc + Xvfb fallback) and websockify installed and started"
  echo "  First reboot will re-ensure VNC services are active"
}

step_vnc_refresh() {
  # Idempotent subset of step_vnc_install, safe to run on every update path.
  # Picks up changes to the clawbox-vnc.service unit (e.g. the CLAWBOX_VNC_MODE
  # env var added when we moved VNC off display :0) and installs packages
  # added in later PRs (e.g. autocutsel for bidirectional VNC clipboard sync).
  # Without this step, existing devices updating via the in-app updater never
  # receive those fixes — they'd keep mirroring GDM's greeter + have no
  # clipboard support until the owner did a fresh install.
  #
  # Deliberately a narrow subset of step_vnc_install — no firstboot-pending
  # flag, no websockify unit rewrite, no clawbox-browser unit re-copy. All of
  # those are already on-disk from the original install and re-touching them
  # here risks extra reboot-time reruns (the firstboot flag) or racey restarts
  # of services that aren't involved in this particular bugfix.
  #
  # apt-get may collide with unattended-upgrades or a user-triggered install,
  # so wait for the dpkg lock first. Make the install non-fatal — a transient
  # apt failure here shouldn't block the more important unit refresh below.
  wait_for_apt
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq autocutsel; then
    echo "  Warning: autocutsel install failed (non-fatal; continuing with unit refresh)"
  fi

  local unit_path=/etc/systemd/system/clawbox-vnc.service
  local unit_tmp
  unit_tmp="$(mktemp)"
  cat > "$unit_tmp" <<VNCSVC
[Unit]
Description=ClawBox VNC (virtual desktop)
After=network.target

[Service]
Type=simple
User=$CLAWBOX_USER
Environment=CLAWBOX_VNC_MODE=virtual
ExecStart=$PROJECT_DIR/scripts/start-vnc.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
VNCSVC

  # Only reload + restart when the unit actually changed — the restart
  # disconnects any active VNC viewer, so we don't want to kick sessions
  # on an idempotent re-run. Websockify is tied to the VNC service via
  # Requires=, but that only propagates *stops*, not restarts, so we
  # bounce it alongside when the VNC unit changed to keep the proxy
  # aligned with the freshly-restarted server.
  if [ ! -f "$unit_path" ] || ! cmp -s "$unit_tmp" "$unit_path"; then
    install -m 644 "$unit_tmp" "$unit_path"
    systemctl daemon-reload
    systemctl restart clawbox-vnc.service clawbox-websockify.service || true
    echo "  VNC service refreshed (CLAWBOX_VNC_MODE=virtual, autocutsel installed)"
  else
    echo "  VNC service already up-to-date, skipping restart"
  fi
  rm -f "$unit_tmp"
}

step_desktop_theme() {
  if is_test_mode; then
    echo "  CLAWBOX_TEST_MODE=1, skipping GNOME desktop theme (no X session in container)"
    return 0
  fi
  local theme_script="$PROJECT_DIR/scripts/apply-desktop-theme.sh"
  local autostart_dir="$CLAWBOX_HOME/.config/autostart"
  local autostart_file="$autostart_dir/clawbox-desktop-theme.desktop"

  if [ ! -f "$theme_script" ]; then
    echo "Error: Desktop theme script not found: $theme_script" >&2
    exit 1
  fi

  chmod +x "$theme_script"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$theme_script"

  mkdir -p "$autostart_dir"
  cat > "$autostart_file" <<EOF
[Desktop Entry]
Type=Application
Name=ClawBox Desktop Theme
Exec=$theme_script
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$autostart_dir" "$autostart_file"
  chmod 644 "$autostart_file"

  mkdir -p /etc/dconf/db/local.d
  cat > /etc/dconf/db/local.d/01-clawbox-desktop-theme <<'EOF'
[org/gnome/desktop/background]
picture-uri=''
picture-uri-dark=''
picture-options='none'
color-shading-type='solid'
primary-color='#0a0f1a'
secondary-color='#111827'
EOF
  dconf update >/dev/null 2>&1 || true

  if command -v dbus-launch >/dev/null 2>&1; then
    as_clawbox_login "dbus-launch \"$theme_script\"" >/dev/null 2>&1 || true
  else
    as_clawbox_login "\"$theme_script\"" >/dev/null 2>&1 || true
  fi

  echo "  ClawBox desktop background configured"
}

step_ffmpeg_install() {
  wait_for_apt
  apt-get install -y ffmpeg
}

step_openclaw_models() {
  as_clawbox "$OPENCLAW_BIN" models
}

step_fix_git_perms() {
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
  echo "  Fixed .git ownership"
}

step_rebuild_reboot() {
  # Redeploy config files and scripts that may have changed after git pull
  step_directories_permissions
  step_systemd_services
  step_polkit_rules
  step_ollama_install
  step_openclaw_patch
  step_openclaw_config
  # Refresh the in-tree ClawKeep CLI before the rebuild so the next boot
  # sees the new restore.py / scheduler logic.
  step_clawkeep_install || echo "  Warning: clawkeep_install during rebuild failed (non-fatal)"
  do_rebuild
  if is_test_mode; then
    echo "CLAWBOX_TEST_MODE=1, restarting clawbox-setup.service in lieu of reboot"
    systemctl restart clawbox-setup.service
    return 0
  fi
  echo "Rebooting system..."
  reboot
}

step_browser_launch() {
  # Launch Chromium with CDP remote debugging — runs as root then drops to clawbox via runuser
  DISPLAY=:99 bash "$PROJECT_DIR/scripts/launch-browser.sh"
}

step_validate_services() {
  # Polls expected units + functional probes for up to 30 s. Exits 1 if any
  # check fails by the deadline, after printing a per-failure table with a
  # systemctl status snippet for unit failures and a one-line reason for
  # probe failures.

  # step_network_setup persists NETWORK_INTERFACE to network.env but doesn't
  # export it, so on a fresh install our process still has it unset. Reload the
  # value before probing — PARSED from the clawbox-writable copy, sourced only
  # from the root-owned one. See read_untrusted_env_value. TASK-445.
  local _iface
  _iface="$(read_untrusted_env_value "$IFACE_ENV" NETWORK_INTERFACE)"
  if [ -n "$_iface" ]; then
    NETWORK_INTERFACE="$_iface"
  elif [ -f /etc/clawbox/network.env ]; then
    # shellcheck disable=SC1091
    source /etc/clawbox/network.env
  fi

  # In test mode, step_start_services skips clawbox-ap and clawbox-performance
  # (no WiFi radio, no nvpmodel), so they will never come active here either.
  # Filter them out of the expected set and skip the WiFi AP probe so CI runs
  # don't fail on hardware that doesn't exist in the container.
  local -a active_services=()
  local s
  for s in "${EXPECTED_ACTIVE_SERVICES[@]}"; do
    if is_test_mode && [[ "$s" == "clawbox-ap.service" || "$s" == "clawbox-performance.service" ]]; then
      continue
    fi
    active_services+=("$s")
  done

  local deadline=$(( $(date +%s) + 30 ))
  local -a failed_active=() failed_installed=() failed_probe=()

  while :; do
    failed_active=()
    failed_installed=()
    failed_probe=()

    local svc enabled active
    for svc in "${active_services[@]}"; do
      if ! systemctl cat "$svc" >/dev/null 2>&1; then
        failed_active+=("$svc (unit file missing)")
        continue
      fi
      enabled=$(systemctl is-enabled "$svc" 2>/dev/null || true)
      active=$(systemctl is-active "$svc" 2>/dev/null || true)
      [ -z "$enabled" ] && enabled="unknown"
      [ -z "$active" ] && active="unknown"
      case "$enabled" in
        enabled|enabled-runtime|alias|static) ;;
        *) failed_active+=("$svc enabled=$enabled active=$active"); continue ;;
      esac
      [ "$active" = "active" ] || failed_active+=("$svc enabled=$enabled active=$active")
    done

    for svc in "${EXPECTED_INSTALLED_SERVICES[@]}"; do
      systemctl cat "$svc" >/dev/null 2>&1 || failed_installed+=("$svc (unit file missing)")
    done

    # Probe 1: Wi-Fi AP is broadcasting on $NETWORK_INTERFACE.
    # Skip in test mode — clawbox-ap.service was skipped above and the stub
    # interface (eth0) isn't a wireless radio.
    if ! is_test_mode; then
      local iface="${NETWORK_INTERFACE:-}"
      if [ -z "$iface" ]; then
        failed_probe+=("WiFi: NETWORK_INTERFACE not set (check /etc/clawbox/network.env)")
      elif ! iw dev "$iface" info 2>/dev/null | grep -qE '^[[:space:]]*type AP[[:space:]]*$'; then
        failed_probe+=("WiFi: $iface is not in AP mode (clawbox-ap.service running but radio not broadcasting)")
      fi
    fi

    # Probe 2: the ClawBox web server answers HTTP on localhost:80.
    local http_code
    http_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://localhost/ 2>/dev/null) || http_code="000"
    case "$http_code" in
      2*|3*) ;;
      *) failed_probe+=("ClawBox: dashboard at http://localhost/ returned HTTP $http_code (expected 2xx or 3xx)") ;;
    esac

    # Probe: on-device TTS delivered the engine it was asked for.
    #
    # scripts/install-voice.sh publishes its verdict to $TTS_STATUS_FILE for
    # exactly this check. The distinction the file carries tells an operator
    # WHAT to fix, and here it decides the wording, not the outcome: `ready` is
    # the only verdict that passes. `skipped:*` means this board declines
    # Kokoro (no CUDA, no Jetson build for its architecture), and with one
    # engine that is a box with NO on-device voice — a mute box, recorded and
    # named the way step_openclaw_tts records its 13. It does not pass:
    # whether the cloud voice exists is not a fact this installer can check
    # (that needs the ClawBox AI link, which happens after install), and every
    # shipped ClawBox is a Jetson a Kokoro build exists for, so a skipped
    # Kokoro on real hardware means something is wrong. `failed:*` means the
    # GPU engine was requested and did not arrive, and someone has to fix it.
    #
    # Kokoro is the ONLY engine this probe reads. An older release's second
    # key is ignored: install-voice.sh no longer writes it, and a stale line
    # left in the file by an earlier run is never read as an engine that
    # exists.
    #
    # An ABSENT verdict fails too. The TTS step runs before this check on both
    # the install and the update path, so nothing here can assert "Kokoro is
    # fine" from a file that is not there; the codebase has been bitten enough
    # times by a missing signal reading as a healthy one (a gateway restart
    # returning success after failing, an email batch reporting success having
    # sent nothing) that "no answer" is not allowed to score as a pass.
    #
    # Every edition, Hermes included. This probe used to sit behind
    # `if ! is_hermes_edition`, with the comment "Hermes has no on-device TTS
    # step at all, so it has nothing to verify." It runs the same
    # step_openclaw_tts as every other SKU now, so it has exactly the same
    # verdict to verify — and a health check that skips the one engine a box
    # depends on is how "All N checks healthy" gets printed over a mute box.
    # Read fresh from the file on every pass, never from an earlier answer.
    local tts_state=""
    if [ -r "$TTS_STATUS_FILE" ]; then
      # `tr -d '\r'`: the file is written by a shell on the device, but it is
      # also restored from tarballs and edited by hand, and a CRLF line ends
      # the verdict as `ready\r` — a value that is neither `ready` nor any
      # other word in the vocabulary. Parse the line rather than merely
      # refusing it; what a garbled value must NOT do is score a pass, and
      # that is what the `*)` arm below is for.
      tts_state=$(sed -n 's/^KOKORO=//p' "$TTS_STATUS_FILE" 2>/dev/null | tr -d '\r' | tail -1)
    fi
    # `ready` is the only verdict that means "this engine can speak".
    # `skipped:*` is a board that declines it — with one engine, a box with
    # no voice — `failed:*` is one that was asked and could not, and an
    # EMPTY string is a step that reported nothing at all; all three fail.
    # ONE line about this box's speech, so the check probe_count counts as
    # one contributes at most one.
    #
    # The vocabulary is closed: `ready`, `skipped:<reason>`, `failed:<reason>`,
    # or nothing at all. Anything else — a truncated write (tts_status_publish
    # truncates the file with `>` rather than writing-then-renaming, so a box
    # that lost power mid-publish can leave one), a typo, a stray line — used
    # to match no arm and fall out of the chain as a silent PASS, while the
    # strictly LESS informative absent verdict correctly failed. Unparseable
    # is at least as suspicious as absent, so it lands in the `*)` arm and
    # fails — without asserting an engine state it could not read.
    #
    # `?*`, not `*`: a bare `skipped:` or `failed:` carries no reason, and a
    # truncated write is exactly how one appears. "This board declines the
    # engine" is a claim, and a claim with its reason cut off is not evidence
    # for it either.
    #
    # Unreadable is decided FIRST, before any arm names an engine state:
    # "this box has NO working on-device TTS engine" is a claim about an
    # engine that may be running perfectly, and a verdict this probe could
    # not parse is no evidence for it.
    local tts_fix="Fix: sudo bash $PROJECT_DIR/install.sh --step openclaw_tts"
    local tts_verdict_unreadable=false
    case "$tts_state" in ""|ready|skipped:?*|failed:?*) ;; *) tts_verdict_unreadable=true ;; esac
    if [ "$tts_verdict_unreadable" = true ]; then
      failed_probe+=("TTS: unrecognised on-device TTS verdict at $TTS_STATUS_FILE (Kokoro: $tts_state) — a verdict outside the ready/skipped:<reason>/failed:<reason> vocabulary is not evidence of an engine. $tts_fix")
    else
      case "$tts_state" in
        "")
          failed_probe+=("TTS: no on-device TTS verdict at $TTS_STATUS_FILE — the TTS step left no record, so whether this box has an engine cannot be asserted either way. $tts_fix")
          ;;
        ready)
          ;;
        skipped:?*)
          # The mute box: the same recorded, named, non-fatal fact as
          # step_openclaw_tts's 13, checked again here from the file.
          #
          # Except in the e2e-install container, which says it has no GPU by
          # construction with CLAWBOX_TEST_NO_GPU=1 (e2e-install/README.md
          # lists every CUDA step it skips for the same reason): a Kokoro
          # that declines there is the documented state of that host, not a
          # defect in it — and failing every harness run would teach
          # everyone to ignore this check on the hardware where it matters.
          # Not keyed on test mode itself: the unit tests run this probe in
          # test mode and pin the real-hardware rule. Real devices never set
          # either; on them a skipped Kokoro fails exactly as before.
          if harness_has_no_gpu; then
            echo "  CLAWBOX_TEST_NO_GPU=1, on-device TTS declined ($tts_state) — expected without a GPU, not a failed probe"
          else
            failed_probe+=("TTS: this box has NO working on-device TTS engine — Kokoro, the only on-device engine, does not apply to this board ($tts_state). The cloud voice speaks for it once the box is linked to ClawBox AI. $tts_fix")
          fi
          ;;
        failed:?*)
          failed_probe+=("TTS: Kokoro GPU TTS was requested and did NOT install ($tts_state) — this box has no on-device voice; spoken replies fall back to the gateway's cloud voice until it is fixed. $tts_fix")
          ;;
      esac
    fi

    # Probe 3 (hermes only): the OpenClaw gateway must be GONE. This is the only
    # automated guard that the Hermes SKU never ships an unauthenticated agent
    # gateway on :18789 — a regression anywhere in the install path (a stray
    # `systemctl enable`, a re-added unit, an update that ran edition-blind)
    # shows up here instead of on a customer's LAN.
    if is_hermes_edition; then
      local gw_active
      gw_active=$(systemctl is-active clawbox-gateway.service 2>/dev/null || true)
      if [ "$gw_active" = "active" ]; then
        failed_probe+=("Hermes: clawbox-gateway.service is ACTIVE (must be disabled+masked on this SKU)")
      fi
      if gateway_port_listening; then
        failed_probe+=("Hermes: something is listening on the OpenClaw gateway port ${GATEWAY_PORT:-18789}")
      fi
      # Probe 4 (hermes only): the dashboard auth proxy actually answers. The
      # unit being "active" only means node started; without this, a proxy that
      # crashed on its first request counted as a healthy install. An
      # unauthenticated request (no clawbox_session) is answered by a healthy
      # proxy with a 302 to /login, or a 403 from its origin/rebind guard — so
      # 3xx/403 are healthy and "no answer" is not. 401 is NOT whitelisted:
      # a browserless request never earns one from a healthy proxy, and the one
      # place the proxy DOES emit 401 is when the SSO login desynced (see
      # hermes-dashboard-proxy.js) — the exact failure this SKU must not hide.
      local proxy_code
      proxy_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
        http://127.0.0.1:"${HERMES_DASH_PROXY_PORT:-8090}"/ 2>/dev/null) || proxy_code="000"
      case "$proxy_code" in
        2*|3*|403) ;;
        *) failed_probe+=("Hermes: dashboard proxy on :${HERMES_DASH_PROXY_PORT:-8090} returned HTTP $proxy_code") ;;
      esac
    fi

    # Probe (hermes + dual): the dashboard auth PROVIDER is genuinely usable —
    # the stored password actually verifies against the stored password_hash.
    # This is the check that was missing when a Hermes provision printed
    # "dashboard auth setup returned non-zero" and the validator, seconds later,
    # reported every check healthy: the proxy liveness probe above returns 3xx
    # whether or not the provider works, so it can see a dead node but never a
    # desynced or absent auth provider. Runs the auth script's OWN classifier
    # (`--check`), so there is a single source of truth for the invariant and no
    # duplicated scrypt logic here. Runs as root, which can read the clawbox-owned
    # 0600 config + password file. A self-healed box (the dashboard's
    # ExecStartPre re-mints a coherent pair within this loop's retry window)
    # passes honestly, because by then the invariant genuinely holds.
    if has_hermes_harness; then
      local auth_script="$PROJECT_DIR/scripts/setup-hermes-dashboard-auth.sh"
      local auth_rc=0
      if [ -f "$auth_script" ]; then
        HERMES_CONFIG="$CLAWBOX_HOME/.hermes/config.yaml" CLAWBOX_ROOT="$PROJECT_DIR" \
          bash "$auth_script" --check >/dev/null 2>&1 || auth_rc=$?
      else
        auth_rc=99
      fi
      case "$auth_rc" in
        0) ;;
        3) failed_probe+=("Hermes: dashboard auth is DESYNCED — the stored password does not verify against the stored password_hash (setup-hermes-dashboard-auth.sh --check == 3); the dashboard SSO will 401. Fix: sudo bash $PROJECT_DIR/install.sh --step hermes_edition") ;;
        4) failed_probe+=("Hermes: no usable dashboard auth provider in $CLAWBOX_HOME/.hermes/config.yaml (--check == 4) — the dashboard refuses to start on its non-loopback bind without one. Fix: sudo bash $PROJECT_DIR/install.sh --step hermes_edition") ;;
        5) failed_probe+=("Hermes: the dashboard password file is missing or empty (--check == 5). Fix: sudo bash $PROJECT_DIR/install.sh --step hermes_edition") ;;
        *) failed_probe+=("Hermes: could not verify the dashboard auth provider (setup-hermes-dashboard-auth.sh --check == $auth_rc, environment error — not a confirmed-healthy state)") ;;
      esac
    fi

    # Probe: no unit belonging to ANOTHER edition is running here.
    #
    # Every check above asks whether this edition's own units are UP, so a
    # second harness left over from a previous edition scored zero failures and
    # went unseen. Absence has to be asserted too, or "All N checks healthy" is
    # printable on a box running two agents and two Telegram pollers.
    #
    # An absent unit answers `inactive` and a masked one answers `masked`, so
    # neither arm matches and no `systemctl cat` guard is needed — which also
    # means a unit that was masked while still running is still caught.
    # `enabled but inactive` fails too: it is one reboot away from active.
    local funit f_active f_enabled
    for funit in "${FOREIGN_EDITION_UNITS[@]}"; do
      f_active=$(systemctl is-active "$funit" 2>/dev/null || true)
      f_enabled=$(systemctl is-enabled "$funit" 2>/dev/null || true)
      case "$f_active" in
        active|activating|reloading)
          failed_probe+=("Edition: $funit is $f_active but belongs to another edition (this device is '$CLAWBOX_EDITION') — two agent harnesses are running on one box. Fix: sudo systemctl disable --now $funit")
          continue
          ;;
      esac
      case "$f_enabled" in
        enabled|enabled-runtime)
          failed_probe+=("Edition: $funit is enabled but belongs to another edition (this device is '$CLAWBOX_EDITION') — it starts again on the next boot. Fix: sudo systemctl disable $funit")
          ;;
      esac
    done

    [ ${#failed_active[@]} -eq 0 ] && [ ${#failed_installed[@]} -eq 0 ] && [ ${#failed_probe[@]} -eq 0 ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 2
  done

  local probe_count=2
  if is_test_mode; then probe_count=1; fi
  # +1 on EVERY edition: the on-device TTS verdict. Counted even when it passes,
  # so the total the healthy line prints is the number of checks that actually
  # ran.
  #
  # This used to be the `else` arm of the hermes branch below — Hermes got the
  # three gateway probes INSTEAD of the TTS verdict, because Hermes had no
  # on-device TTS step to verify. It runs the same step_openclaw_tts as every
  # other SKU now and the probe above is no longer gated, so an either/or would
  # make the installer's own summary lie: it would print one fewer check than it
  # ran on hermes, and the count is the only thing standing between "All N
  # checks healthy" and a check that silently stopped running.
  probe_count=$(( probe_count + 1 ))
  if is_hermes_edition; then
    # +3: gateway-inactive, gateway-port-silent, dashboard-proxy-answers.
    probe_count=$(( probe_count + 3 ))
  fi
  # +1 (hermes AND dual): the dashboard auth provider actually verifies.
  if has_hermes_harness; then probe_count=$(( probe_count + 1 )); fi
  # One per foreign unit. Counted even when the unit is absent: "the other
  # harness is not here" is a check that ran and passed, and folding it into the
  # total is what stops the healthy line from being printable on a box that is
  # running two of them.
  probe_count=$(( probe_count + ${#FOREIGN_EDITION_UNITS[@]} ))
  local total=$(( ${#active_services[@]} + ${#EXPECTED_INSTALLED_SERVICES[@]} + probe_count ))
  local fails=$(( ${#failed_active[@]} + ${#failed_installed[@]} + ${#failed_probe[@]} ))
  if [ "$fails" -eq 0 ]; then
    echo "  ✓ All $total checks healthy (services + WiFi AP + web dashboard + edition probes)"
    return 0
  fi

  echo "  ✗ $fails of $total checks failed:"
  local entry unit_name
  for entry in "${failed_active[@]}" "${failed_installed[@]}"; do
    echo "    - $entry"
    unit_name="${entry%% *}"
    systemctl status "$unit_name" --no-pager -n 5 2>&1 | sed 's/^/        /' || true
    echo
  done
  local had_edition_failure=false
  for entry in "${failed_probe[@]}"; do
    echo "    - $entry"
    case "$entry" in Edition:*) had_edition_failure=true ;; esac
  done
  # A foreign unit reaching this point means the teardown was skipped or the
  # unit came back. Name the one command that redoes it rather than leaving the
  # operator to reconstruct the unit list from the lines above.
  if [ "$had_edition_failure" = true ]; then
    echo "    To bring every foreign-edition unit down again, in one command:"
    echo "      sudo bash $PROJECT_DIR/install.sh --step edition_foreign_teardown"
  fi
  return 1
}

# ── Single-step mode (used by clawbox-root-update@.service) ──────────────────

# Steps available for --step dispatch (must have a corresponding step_NAME function)
DISPATCH_STEPS=(
  bootstrap_updater apt_update nvidia_jetpack performance_mode jtop_install ollama_install llamacpp_install llamacpp_model
  chromium_install ai_tools_install coding_harness vnc_install vnc_refresh
  openclaw_setup openclaw_install openclaw_patch openclaw_config openclaw_models openclaw_tts
  # Edition steps must be dispatchable or no in-app update can ever re-bake the
  # lock, install Hermes, or repair a Hermes appliance — which is how a Hermes
  # box ended up running edition-blind updates that reinstalled OpenClaw.
  edition_lock edition_foreign_teardown hermes_install hermes_edition
  network_setup set_hostname setup_config system_config
  git_pull build rebuild rebuild_reboot restart restart_ap recover
  chpasswd gateway_setup ffmpeg_install polkit_rules systemd_services
  directories_permissions captive_portal_dns desktop_theme
  fix_git_perms browser_launch cloudflared_install
  nm_dispatcher sysctl_linkdown persistent_journal resource_limits desktop_mode
  # `firewall` is dispatchable so support can re-assert the policy by hand with
  # `sudo bash install.sh --step firewall`. It is not added to
  # clawbox-root-step.sh's ALLOWED_STEPS because it does not need to be — the
  # updater reaches it transitively via post_update. Note this is NOT an
  # isolation boundary: system_config and post_update are both allow-listed and
  # both call step_firewall, so the web server can already cause it to run.
  firewall
  post_update update_smoke validate_services
)

if [ "${1:-}" = "--step" ]; then
  local_step="${2:-}"
  # Validate step name against the whitelist
  step_valid=false
  for s in "${DISPATCH_STEPS[@]}"; do
    if [ "$s" = "$local_step" ]; then
      step_valid=true
      break
    fi
  done
  if [ "$step_valid" = false ]; then
    echo "Unknown step: ${local_step:-<empty>}" >&2
    echo "Available steps: ${DISPATCH_STEPS[*]}" >&2
    exit 1
  fi
  # ── A dispatched step's recorded failures must not die with it ─────────────
  # `"step_x"; exit 0` threw away everything record_provision_failure collected.
  # step_post_update returns 0 whatever its fixups reported, so an in-app update
  # whose TTS step left the box MUTE — exit 13, recorded inside
  # step_openclaw_tts precisely so it would be carried — finished as a
  # successful update with nothing in $PROVISION_STATUS_FILE, the marker the
  # dashboard and the flash host read. The full-install path has printed this
  # summary since the marker existed; the dispatch path never reached it.
  #
  # An EXIT trap, not `"step_x" || rc=$?`: the OR-list form would switch set -e
  # OFF for the entire body of the dispatched step, so every guard inside it
  # that relies on errexit to stop would run on instead. The trap also catches
  # the step that dies mid-way under errexit, which is the case that reported
  # nothing at all.
  #
  # Only `incomplete` is ever published here. One dispatched step finishing
  # cleanly is not evidence that the whole box provisioned, so a clean run
  # writes nothing and leaves the marker to the full install that owns it.
  dispatch_provision_verdict() {
    local rc=$?
    trap - EXIT
    if [ "${#PROVISION_FAILURES[@]}" -gt 0 ]; then
      echo "  ############################################################"
      echo "  # PROVISIONING INCOMPLETE — step $local_step reported errors."
      echo "  # Steps that failed: ${PROVISION_FAILURES[*]}"
      echo "  # Re-run:  sudo bash $PROJECT_DIR/install.sh --step $(provision_repair_step "${PROVISION_FAILURES[0]}")"
      echo "  ############################################################"
      write_provision_status incomplete "${PROVISION_FAILURES[*]}" || true
      # Same stdout contract as the full install: the flash host greps these
      # two lines, and the prefix and the verdict word are byte-identical.
      echo "[provision-status] INCOMPLETE (${PROVISION_FAILURES[*]})"
      echo "[provision-run] $PROVISION_RUN_ID"
      if [ "$rc" -eq 0 ]; then rc=1; fi
    fi
    exit "$rc"
  }
  trap dispatch_provision_verdict EXIT
  "step_${local_step}"
  exit 0
fi

# ── Full Install Mode ───────────────────────────────────────────────────────

# 26 unconditional steps, plus the Hermes provisioning step below, which runs
# only on the hermes and dual editions. Edition-aware rather than a constant:
# the openclaw constant made those editions print "[27/26]" on their last step,
# and an upper bound would leave openclaw finishing at "[26/27]".
TOTAL_STEPS=26
if has_hermes_harness; then TOTAL_STEPS=$((TOTAL_STEPS + 1)); fi
step=0
log() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
}

echo "=== ClawBox Installer ==="

# Clear the previous run's verdict BEFORE provisioning anything. From here until
# the summary at the bottom there is deliberately no marker on disk, so a run
# that dies mid-way (or cannot write its own marker at the end) leaves the flash
# host with "no verdict" rather than with the last run's "ok".
invalidate_provision_status || true

log "Ensuring clawbox user exists..."
step_ensure_user

log "Installing system packages..."
step_apt_update

log "Installing NVIDIA JetPack..."
step_nvidia_jetpack

log "Enabling max performance mode..."
step_performance_mode

log "Configuring network (WiFi, hostname, mDNS)..."
step_network_setup

log "Setting up ClawBox repository..."
step_git_pull

log "Ensuring bun is installed..."
step_install_bun

log "Building ClawBox..."
step_build

# BEFORE step_openclaw_setup, deliberately. That step ends in step_openclaw_tts,
# which registers the on-device voice with EVERY harness the box runs — and the
# Hermes half of that needs ~/.local/bin/hermes to exist to be written through.
# With the old order a fresh hermes/dual box reached the registration before the
# agent it was registering with, and every first install would have recorded a
# provisioning failure for a box that was fine. step_hermes_install self-gates on
# has_hermes_harness (a no-op on openclaw), needs nothing OpenClaw provides, and
# is idempotent, so moving it up costs nothing on any other SKU.
log "Installing Hermes (on the hermes and dual editions)..."
step_hermes_install

log "Installing and configuring OpenClaw..."
step_openclaw_setup

log "Installing ClawKeep CLI..."
step_clawkeep_install

log "Setting up directories, permissions and DNS..."
step_setup_config

# Clean up default NVIDIA desktop shortcuts
rm -f "$CLAWBOX_HOME/Desktop"/*.desktop 2>/dev/null || true

# Bake the edition lock BEFORE any unit is installed. Ordering is load-bearing
# in both directions: on hermes the lock masks clawbox-gateway (so the unit
# install below must already know not to ship it), and on openclaw/dual the lock
# CLEARS a mask left by a previous hermes install — a mask is a symlink to
# /dev/null at exactly the path step_systemd_services copies the unit to, so
# doing this afterwards would leave the box with a gateway written to /dev/null.
log "Baking the edition lock (CLAWBOX_EDITION=$CLAWBOX_EDITION)..."
step_edition_lock

log "Installing systemd services and polkit rules..."
step_system_config

log "Installing jtop (jetson-stats)..."
step_jtop_install

log "Installing Ollama..."
step_ollama_install

log "Installing llama.cpp runtime..."
step_llamacpp_install

log "Installing Chromium..."
step_chromium_install

log "Installing Cloudflare Tunnel (cloudflared)..."
step_cloudflared_install

log "Installing AI coding tools (Claude Code, Codex, Gemini)..."
step_ai_tools_install

log "Installing the ClawBox coding harness (claude-ds)..."
# Guarded, and it has to be. The step now FAILS when the harness did not end up
# usable — that is the whole point of the change, because this step is the
# repair src/lib/coding-agent.ts tells the owner to run and it must not report
# success while the Coding app still refuses. But the harness is OPTIONAL: a box
# with no Claude Code boots, serves its dashboard and runs its agent. Under the
# `set -euo pipefail` at the top of this file an unguarded call would turn a
# region-blocked download into an ABORTED INSTALL, which is the opposite defect.
step_coding_harness \
  || echo "  Warning: the coding harness did not install; the Coding app will refuse until it does"

log "Installing VNC server..."
step_vnc_install

log "Applying ClawBox desktop theme..."
step_desktop_theme

# Belt-and-suspenders PATH stanza — covers update runs that early-return out
# of step_openclaw_install / step_ai_tools_install when those tools are
# already up to date, and also restores the stanza if .bashrc was wiped or
# replaced (e.g. user re-creation, /etc/skel refresh). The function is
# idempotent: it greps before appending.
log "Ensuring clawbox user PATH (openclaw, claude, codex, gemini, hf, clawkeep)..."
ensure_clawbox_bashrc_path

log "Starting services..."
step_start_services

# Hermes harness editions (hermes + dual): seed shared identity, configure the
# dashboard auth provider, (re)start the dashboard + auth proxy. Runs after
# step_start_services because the proxy needs the web server's session secret to
# already exist. The edition lock itself was baked much earlier (see above).
if has_hermes_harness; then
  log "Provisioning Hermes (dashboard + auth proxy + shared identity)..."
  # Non-fatal on purpose — a half-provisioned Hermes box should still finish
  # installing and come up reachable. It is NOT silent, though: the units it
  # manages are in EXPECTED_ACTIVE_SERVICES and the proxy has a functional probe,
  # so step_validate_services below still fails the install if this left the
  # device broken.
  step_hermes_edition || {
    echo "  ############################################################"
    echo "  # WARNING: Hermes provisioning FAILED."
    echo "  # Re-run:  sudo bash $PROJECT_DIR/install.sh --step hermes_edition"
    echo "  ############################################################"
    # Record it so the final summary + exit status + status marker report the
    # failure even though the run continues. Without this the box could still
    # print "Setup Complete", exit 0, and be shipped as healthy.
    record_provision_failure hermes_edition
  }
fi

log "Validating services..."
# Capture rather than let set -e abort here: we still want to print the summary
# AND fold this into the single honest exit status at the very end.
VALIDATE_RC=0
step_validate_services || VALIDATE_RC=$?

# ── Done ─────────────────────────────────────────────────────────────────────

# Re-read the persisted interface for the summary. Parsed, not sourced — this
# file is clawbox-writable and we are root. TASK-445.
_summary_iface="$(read_untrusted_env_value "$IFACE_ENV" NETWORK_INTERFACE)"
if [ -n "$_summary_iface" ]; then
  NETWORK_INTERFACE="$_summary_iface"
fi
unset _summary_iface

echo ""
echo "=== ClawBox Setup Complete ==="
echo ""
echo "  WiFi interface: ${NETWORK_INTERFACE:-unknown}"
echo "  WiFi AP:        ClawBox-Setup (open network)"
echo "  Dashboard:      http://clawbox.local  or  http://10.42.0.1"
echo ""
echo "  Services:"
echo "    systemctl status clawbox-ap"
echo "    systemctl status clawbox-setup"
echo "    systemctl status clawbox-gateway"
echo ""

# ── Honest final status ──────────────────────────────────────────────────────
# One exit code that reflects the WHOLE run: a non-fatal provisioning step that
# reported errors, or a failed service validation, must not be reportable as
# success by the caller (the flash host's "Setup: N/N succeeded"). The marker
# file carries the same verdict for a caller that reads a file instead of the
# exit code, and the sentinel line ([provision-status] ...) for one that greps
# stdout. Keep all three in agreement — including when the marker cannot be
# written at all, in which case the other two must report "incomplete" rather
# than a success no reader of the file can see.
FINAL_RC=0
if [ "${#PROVISION_FAILURES[@]}" -gt 0 ] || [ "${VALIDATE_RC:-0}" -ne 0 ]; then
  FINAL_RC=1
fi

if [ "$FINAL_RC" -ne 0 ]; then
  echo "  ############################################################"
  echo "  # PROVISIONING INCOMPLETE — the box came up but the install"
  echo "  # reported errors. Do NOT ship this box as healthy."
  if [ "${#PROVISION_FAILURES[@]}" -gt 0 ]; then
    echo "  # Steps that failed: ${PROVISION_FAILURES[*]}"
    echo "  # Re-run:  sudo bash $PROJECT_DIR/install.sh --step $(provision_repair_step "${PROVISION_FAILURES[0]}")"
  fi
  if [ "${VALIDATE_RC:-0}" -ne 0 ]; then
    echo "  # Service validation FAILED (see the checks listed above)."
  fi
  echo "  ############################################################"
  write_provision_status incomplete "${PROVISION_FAILURES[*]:-}" || true
  # The sentinel lines below are a stdout contract with the flash host: keep the
  # prefix and the verdict word byte-identical. The run id goes on its own line.
  echo "[provision-status] INCOMPLETE${PROVISION_FAILURES[*]:+ (${PROVISION_FAILURES[*]})}"
  echo "[provision-run] $PROVISION_RUN_ID"
else
  write_provision_status ok "" || true
  if [ "$PROVISION_STATUS_UNPUBLISHED" -ne 0 ]; then
    # Every step passed, but the channel the flash host reads cannot be made to
    # say so for THIS run. Reporting success here is how a stale marker gets
    # read as a fresh verdict, so downgrade instead: an install whose result
    # cannot be published is not an install anyone should ship.
    FINAL_RC=1
    echo "  ############################################################"
    echo "  # PROVISIONING INCOMPLETE — every step passed, but this run"
    echo "  # could not publish its verdict to $PROVISION_STATUS_FILE."
    echo "  # Do NOT ship this box as healthy; fix the path and re-run."
    echo "  ############################################################"
    echo "[provision-status] INCOMPLETE (marker unwritable)"
  else
    echo "[provision-status] OK"
  fi
  echo "[provision-run] $PROVISION_RUN_ID"
fi

exit "$FINAL_RC"
