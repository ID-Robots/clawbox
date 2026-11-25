#!/usr/bin/env bash
# timeout: 4200
# tier: long
#
# An update whose build dies rolls back to a box that still works.
#
# The commonest real failure of an update on an 8 GB Jetson is `next build`
# being killed (out of memory: `JavaScript heap out of memory`, exit 137). This
# reproduces exactly that, through the box's own updater:
#
#   1. The board is put on the current release (the head of main) through
#      `nano-ci rebuild` — kept when it is on the release already.
#   2. The owner's path: pin the update branch to the branch under test
#      (NANO_BRANCH) and POST /setup-api/update/run.
#   3. Every `next build` the update starts is SIGKILLed, as the OOM killer
#      would.
#   4. The update must end `failed` with a reason, NOT `completed`, and the box
#      must be left working: the dashboard serves /login, the gateway settles,
#      the build it serves names the commit it has checked out (no drift: the
#      rollback put back both, or neither), and a chat turn answers.
#      One exception, by design: an update that had already moved the OpenClaw
#      core past the pin of the restored build's commit keeps the checkout on
#      the branch (install.sh openclaw_core_ahead_of_commit), so the release's
#      build is served over the branch's checkout until the next update. That
#      state must be exactly this: the checkout on NANO_SHA, the restored build
#      a build of the commit the board started on (the release's) and whole
#      as that commit's, and no rollback target left in data/config.json for
#      the dashboard to act on. On every edition but Hermes the checkout must
#      never pin an older core than the one installed.
#
# The board must start on a build of the release's commit; a board whose build
# is of another commit fails at the start.
#
# The core the board starts with is recorded. Only a board that starts with
# the release's own core, updated to a branch that pins a newer one, exercises
# a core move; any other run says plainly that it proves nothing about keeping
# the checkout with a moved core, and NANO_REQUIRE_CORE_MOVE=1 (a release run)
# fails it instead.
#
# Skipped without NANO_BRANCH. The board is left on the release (or wherever
# the rollback left it); 90-upgrade-from-release updates it from there.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${NANO_BRANCH:-}" ]; then
  skip "NANO_BRANCH is not set: the updater needs the branch the commit under test is on"
  finish
fi

ensure_on_release || finish

# The facts the checkout rule turns on, read on the board in one line, "-" for
# what cannot be read: the edition (as install.sh reads its lock, openclaw when
# there is none), the installed OpenClaw core (its package.json, as install.sh
# reads it), the commit the served build names, that commit's pin and the
# checkout's, and whether data/config.json still holds the dashboard's
# rollback target. python3, not jq: a board may have no jq.
CORE_FACTS_PY='
import json, re, subprocess, sys
repo, home = sys.argv[1], sys.argv[2]
def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None
def field(obj, key):
    value = obj.get(key) if isinstance(obj, dict) else None
    return value if isinstance(value, str) and re.fullmatch(r"\S+", value) else "-"
try:
    with open("/etc/clawbox/edition.env") as f:
        m = re.search(r"^CLAWBOX_EDITION=\"?([A-Za-z]+)", f.read(), re.M)
    edition = m.group(1).lower() if m else "openclaw"
except OSError:
    edition = "openclaw"
core = field(load(home + "/.npm-global/lib/node_modules/openclaw/package.json"), "version")
built = field(load(repo + "/.next/standalone/.next/build-info.json") or load(repo + "/.next/build-info.json"), "commit")
def pin(ref):
    if ref == "-":
        return "-"
    r = subprocess.run(["git", "-C", repo, "show", ref + ":config/openclaw-target.txt"], capture_output=True, text=True)
    words = r.stdout.split() if r.returncode == 0 else []
    return words[0] if words else "-"
config = load(repo + "/data/config.json")
target = "-" if not isinstance(config, dict) else ("present" if "update_rollback_target" in config else "absent")
print(edition, core, built, pin(built), pin("HEAD"), target)
'
core_facts() {
  # shellcheck disable=SC2016  # expanded on the board
  board 'python3 -I -c "$1" "$REPO" "$HOME"' "$CORE_FACTS_PY" | tail -n 1
}
# Is $1 a plain release number strictly newer than $2? (install.sh's rule.)
core_newer() {
  local release='^[0-9]+(\.[0-9]+)*(-[0-9]+)?$'
  [[ $1 =~ $release && $2 =~ $release ]] && [ "$1" != "$2" ] \
    && [ "$(printf '%s\n' "$2" "$1" | sort -V | tail -n 1)" = "$1" ]
}
# not_ok under NANO_REQUIRE_CORE_MOVE=1, a note otherwise.
core_move_unproven() {
  if [ "${NANO_REQUIRE_CORE_MOVE:-0}" = 1 ]; then not_ok "$1"; else note "$1"; fi
}

read -r EDITION CORE0 BUILT0 RELEASE_PIN _ _ <<<"$(core_facts)"
# ensure_on_release keeps a board whose checkout is the release without looking
# at its build. A build of another commit (or none readable) is a start this
# test cannot judge a rollback from, so it fails here, not later as a restore.
if [ "${BUILT0:-}" != "$HEAD0" ]; then
  not_ok "the board did not start on the release's build: the checkout is ${HEAD0:0:12}, the served build ${BUILT0:--}"
  finish
fi
note "start: edition ${EDITION:--}, OpenClaw core ${CORE0:--}; the release's build ${BUILT0:0:12} pins ${RELEASE_PIN:--}"
CORE_START_OK=0
if [ "$EDITION" = hermes ]; then
  core_move_unproven "Hermes edition: no OpenClaw core moves, so this run proves nothing about keeping the checkout with a moved core"
elif [ -n "${CORE0:-}" ] && [ "$CORE0" != "-" ] && [ "$CORE0" = "${RELEASE_PIN:-}" ]; then
  CORE_START_OK=1
else
  core_move_unproven "the board starts with OpenClaw ${CORE0:--}, not the release's own ${RELEASE_PIN:--}: this run does not exercise the core move, so it proves nothing about keeping the checkout with a moved core"
fi

KILLS=0
# A running build retitles itself `next-build (vNN)`; `node … next build` is
# its command line before that.
# shellcheck disable=SC2317,SC2329  # called by wait_app_update as its tick
kill_builds() {
  local n
  # Matched on the process's own command line, never with `pkill -f`: the
  # script `board` runs is itself a `bash -c` whose argv holds this pattern.
  # shellcheck disable=SC2016  # expanded on the board
  n=$(board '
    pids=$(ps -u "$(id -u)" -o pid=,args= | awk "\$2 ~ /^next-build/ || (\$2 ~ /(node|bun)\$/ && / next build/) {print \$1}")
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
    echo "count $(printf "%s" "$pids" | grep -c .)"
  ' | sed -n "s/^count //p" | tail -n 1)
  if [[ ${n:-} =~ ^[1-9][0-9]*$ ]]; then
    KILLS=$((KILLS + n))
    note "killed $n next build process(es), as an OOM kill would"
  fi
}

if start_app_update "$NANO_BRANCH"; then
  ok "update to $NANO_BRANCH started through /setup-api/update/run"
else
  not_ok "the update did not start: $(api_error)"
  finish
fi
wait_app_update 3000 kill_builds
note "next build processes killed: $KILLS"
if [ "$KILLS" -eq 0 ]; then
  not_ok "the update never ran next build while it was watched (phase $UPDATE_PHASE): nothing was rolled back"
elif [ "$UPDATE_PHASE" = failed ]; then
  ok "the update with a killed build ended failed: ${UPDATE_ERROR:-no reason given}"
  [ -n "$UPDATE_ERROR" ] || not_ok "the failed update gave the owner no reason"
elif [ "$UPDATE_PHASE" = completed ]; then
  not_ok "the update reported completed although every next build it started was killed"
else
  not_ok "the update did not end within 50 min (phase $UPDATE_PHASE)"
fi

# The box must be usable whatever the updater said.
runtime_settled_line "after the failed update"
runtime_kept
# shellcheck disable=SC2016  # expanded on the board
LOGIN=$(board 'for _ in $(seq 1 24); do c=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "$DASHBOARD/login"); [ "$c" = 200 ] && break; sleep 5; done; echo "$c"' | tail -n 1)
if [ "$LOGIN" = 200 ]; then ok "dashboard still serves /login"; else not_ok "dashboard answered /login with ${LOGIN:-nothing} after the rollback"; fi
HEAD1=$(board_head)
note "checkout after the failed update: ${HEAD1:0:12} (was ${HEAD0:0:12})"
read -r _ CORE BUILT BUILT_PIN HEAD_PIN TARGET <<<"$(core_facts)"
note "after: OpenClaw core ${CORE:--}; served build ${BUILT:0:12} pins ${BUILT_PIN:--}; checkout pins ${HEAD_PIN:--}; dashboard rollback target ${TARGET:--}"
if [ "$CORE_START_OK" = 1 ]; then
  if core_newer "$CORE" "$CORE0"; then
    note "the update moved the OpenClaw core from $CORE0 to $CORE before it failed"
  else
    core_move_unproven "the update did not move the OpenClaw core (still ${CORE:--}): this run proves nothing about keeping the checkout with a moved core"
  fi
fi
IDENT=$(build_identity_ok); rc=$?
if [ "$rc" -eq 0 ]; then
  ok "the served build names the checked-out commit: $(tail -n 1 <<<"$IDENT")"
elif core_newer "$CORE" "$BUILT_PIN" && [ "$HEAD1" != "$BUILT" ] \
  && [[ $IDENT == *"was built from $BUILT but the checkout is at $HEAD1"* ]]; then
  # Only the commit mismatch itself (scripts/verify-build-identity.sh). It
  # stops at that first mismatch, so the restored build is checked again
  # below: it must be a build of the commit the board started on (the
  # release's, checked at the start), and whole as that commit's.
  ok "checkout kept on ${HEAD1:0:12} with OpenClaw $CORE, newer than the $BUILT_PIN the restored build's commit ${BUILT:0:12} pins: the old build over the new checkout until the next update, by design"
  if [ "$HEAD1" != "${NANO_SHA:-}" ]; then
    not_ok "the kept checkout ${HEAD1:0:12} is not the commit under test ${NANO_SHA:-(NANO_SHA unset)}"
  fi
  if [ "$BUILT" != "$BUILT0" ]; then
    not_ok "the restored build ${BUILT:0:12} is not the release's: the board started on a build of ${BUILT0:0:12}"
  else
    # shellcheck disable=SC2016  # expanded on the board
    KEPT=$(board 'cd "$REPO" && bash scripts/verify-build-identity.sh --project-dir "$REPO" --expect-sha "$1" 2>&1 | tail -n 3' "$BUILT"); rc=$?
    if [ "$rc" -eq 0 ]; then
      ok "the restored build is whole and the release's: $(tail -n 1 <<<"$KEPT")"
    else
      not_ok "the restored build does not hold together as ${BUILT:0:12}'s: $(tr '\n' ' ' <<<"$KEPT" | cut -c1-200)"
    fi
  fi
  if [ "$TARGET" = absent ]; then
    ok "no rollback target is left in data/config.json for the dashboard to move the checkout back with"
  else
    not_ok "data/config.json still holds the dashboard's rollback target (${TARGET:--}): a later failure would move the checkout back behind OpenClaw $CORE"
  fi
else
  not_ok "drift after the rollback: the served build is not the checked-out commit ${HEAD1:0:12}: $(tr '\n' ' ' <<<"$IDENT" | cut -c1-200)"
fi
# Every edition whose disk carries the core install.sh moves; Hermes keeps
# whatever OpenClaw an earlier edition left, and its checkout goes back.
if [ "$EDITION" != hermes ]; then
  if [ -z "${CORE:-}" ] || [ "$CORE" = "-" ] || [ -z "${HEAD_PIN:-}" ] || [ "$HEAD_PIN" = "-" ]; then
    not_ok "the installed OpenClaw core (${CORE:--}) or the checkout's pin (${HEAD_PIN:--}) could not be read, so the checkout was not checked against the core"
  elif core_newer "$CORE" "$HEAD_PIN"; then
    not_ok "the checkout ${HEAD1:0:12} pins OpenClaw $HEAD_PIN, older than the $CORE installed: it was moved back behind the core"
  else
    ok "the checkout ${HEAD1:0:12} pins OpenClaw ${HEAD_PIN:--}, not older than the $CORE installed"
  fi
fi
runtime_chat_turn
finish
