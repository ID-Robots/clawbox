#!/usr/bin/env bash
# Finish the standalone build — and fail when finishing it did not work.
#
# `next build` writes `.next/standalone`, but not everything the dashboard
# needs to run from it: `.next/static`, `public/`, the build-identity stamp and
# the Playwright packages are copied in here. `install.sh`'s
# `verify_build_present` is written around that fact — a build is servable only
# once this script has run.
#
# It used to be one line inside package.json's `postbuild`, and it was a false
# success in three separate ways, all of them measured in CI on 2026-09-05
# (e2e-install runs 33971129750, 33974951149, 33977666658 — TASK-725):
#
#   1. It found the entry with
#      `find .next/standalone -maxdepth 3 -name node_modules -prune -o -name server.js -print -quit`
#      and trusted whatever readdir handed back first — while Next had already
#      recorded where it put the entry (see "Where the entry is" below).
#      During an update the project root also holds `.next-old` — parked by
#      `set_previous_build_aside` so an OOM-killed rebuild cannot leave the box
#      with no build at all — and Next's file tracing copies it INTO the new
#      standalone tree (see "why the parked build is in there" below). So the
#      lookup had two candidates, and on those three runs it picked
#      `.next/standalone/.next-old/standalone/server.js`: the PARKED build's
#      entry, three levels down.
#   2. Every `cp` then wrote at the parked copy instead of the real tree, all
#      four failed with "No such file or directory" — and the step exited 0.
#   3. Its last clause replaced the real `.next/standalone/server.js` with a
#      symlink to that parked entry, so `require("./.next/standalone/server.js")`
#      would have loaded the build the update was replacing.
#      `verify-build-identity.sh` caught the missing stamp, the rebuild was
#      rolled back, and the update failed.
#
# So: the entry is the one `next build` wrote, not the first one readdir
# offers; every copy is checked (`set -e`); and a step that cannot do its job
# says so with a non-zero status.
#
# Why the parked build is in there at all: `src/instrumentation-node.ts:154`
# resolves `path.join(CONFIG_ROOT, 'scripts', 'terminal-server.mjs')`, and
# CONFIG_ROOT is read from the environment (`src/lib/config-store.ts:4`), so
# @vercel/nft cannot resolve it and emits the whole project directory as an
# asset directory. Reproduced locally on Next 16.3.3: with a build parked
# beside it, `.next/server/instrumentation.js.nft.json` lists 6186 files of
# which 4202 are `../../.next-old/**`. `outputFileTracingExcludes` does not
# reach that trace — Next applies it per route entry, and the middleware and
# instrumentation traces are built separately (the measurement is recorded in
# next.config.ts). The sweep is also load-bearing today: `.next/standalone/scripts`
# comes from it and system-profile.ts resolves scripts/ from the process cwd.
# Narrowing it is its own change, with its own device proof; until then the
# parked copy is removed here so the tree that ships is only this build.
set -euo pipefail

STANDALONE=".next/standalone"

fail() { echo "postbuild: $*" >&2; exit 1; }

# CLAWBOX_ROOT pinned to the build's own directory: write-build-info.mjs resolves
# its project dir from that variable first, and a shell that exports it at some
# other path (a dev box, a test runner) would write the stamp into a tree this
# build knows nothing about — which under `set -e` is now a failed build rather
# than a warning. The stamp belongs to the build in this directory.
CLAWBOX_ROOT="$PWD" node scripts/write-build-info.mjs

[ -d "$STANDALONE" ] || fail "no $STANDALONE — next build wrote no standalone output (next.config.ts sets output: \"standalone\")"

# Where the entry is, asked of Next rather than guessed at.
#
# `relativeAppDir` in `.next/required-server-files.json` is
# `path.relative(outputFileTracingRoot, dir)`
# (next/dist/build/index.js:1107) — the exact segment `copyTracedFiles` joins
# under `.next/standalone` when it writes the entry
# (next/dist/build/utils.js:1107). It is "" for this repo, because
# `outputFileTracingRoot` is unset and therefore the project directory; it is
# the app's path below the tracing root for the nested layout Next produces
# when that root is a parent (a monorepo). Either way Next has already
# recorded the answer, so nothing here has to depend on readdir order.
#
# Read with node, as scripts/verify-build-identity.sh reads build-info.json:
# a Jetson runs the server, so it has node, and it does not necessarily have
# jq. A value that could climb out of the standalone tree is not an answer
# this script will act on.
rel_app_dir() {
  node -e '
    const fs = require("fs");
    try {
      const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).relativeAppDir;
      if (typeof v !== "string") process.exit(1);
      if (v.startsWith("/") || v.split("/").includes("..")) process.exit(1);
      process.stdout.write(v);
    } catch { process.exit(1); }
  ' "$1" 2>/dev/null
}

# The fallbacks, in order: the manifest, then the layout the manifest describes
# for this repo, then a search for a tree that carries neither. The search
# prunes the parked build and `node_modules` (next/ and react-dom/ have
# `server.js` files of their own) and takes regular files only, so the symlink
# a previous run of this script may have left is never taken for the entry.
REL="$(rel_app_dir ".next/required-server-files.json")" || REL=""
CANDIDATE="$STANDALONE${REL:+/$REL}/server.js"
if [ -f "$CANDIDATE" ] && [ ! -L "$CANDIDATE" ]; then
  SRVJS="$CANDIDATE"
elif [ -f "$STANDALONE/server.js" ] && [ ! -L "$STANDALONE/server.js" ]; then
  SRVJS="$STANDALONE/server.js"
else
  SRVJS="$(find "$STANDALONE" -maxdepth 3 \
    \( -name node_modules -o -name '.next-old*' \) -prune \
    -o -type f -name server.js -print -quit)"
  [ -n "$SRVJS" ] || fail "no server.js under $STANDALONE — this build produced nothing the dashboard can load"
fi
SDIR="$(dirname "$SRVJS")"
# The stamp, the static assets and public/ all go NEXT TO the entry, in that
# tree's own `.next`. If it is not there, $SDIR is not a standalone root and
# copying into it would write a build nothing can serve.
[ -d "$SDIR/.next" ] || fail "$SRVJS is not a standalone entry — $SDIR/.next does not exist"

# A parked previous build swept in by the trace is a second, complete build
# inside this one — hundreds of MB on an eMMC, and a second `server.js` for
# anything that goes looking. It is a copy; the real parked tree is
# `$PROJECT_DIR/.next-old` and is not touched here.
#
# After the entry is chosen, not before: the search above must be able to
# refuse a parked entry on its own (that is what its `-prune` is for), and in
# the nested layout the copy lands beside the entry rather than at the top of
# the standalone tree, so both places are swept.
for swept in "$STANDALONE"/.next-old* "$SDIR"/.next-old*; do
  [ -e "$swept" ] || continue
  echo "postbuild: removing $swept — a parked previous build was traced into the standalone output" >&2
  rm -rf "$swept"
done

# data/ first, before the copies, because this is the one removal whose failure
# has to be reported by name: it holds the owner's live state and 0600 secrets
# (see next.config.ts), and a standalone tree that ships a stale duplicate of
# them is a build failure, not a warning. `|| true` on the removals so the
# check below is what reports it rather than errexit on `rm`.
rm -rf "$SDIR/data" || true
if [ -e "$SDIR/data" ]; then
  chmod -R u+w "$SDIR/data" 2>/dev/null || true
  rm -rf "$SDIR/data" || true
fi
if [ -e "$SDIR/data" ]; then
  fail "$SDIR/data survived removal - the standalone tree would ship a duplicate of the runtime data directory, including 0600 secrets (see next.config.ts)"
fi

# The checkout's own `.env` and `.git`, for the same reason and by the same
# rule — but swept from the WHOLE tree, not just beside the entry.
#
# Two different routes put them there, and only one of them has a native
# switch (the measurement for both is recorded in next.config.ts):
#
#   * `.env` and `.env.production` are copied by Next ITSELF, outside the
#     trace: writeStandaloneDirectory() walks `loadedEnvFiles` and copyFile()s
#     exactly those two names (next/dist/build/index.js), with no config switch.
#     This sweep is the only thing that removes them.
#   * `.git` rides in on the instrumentation trace — the same whole-project
#     asset directory that brings `.next-old` in above. Read off the OpenClaw
#     box on 2026-09-05: `.next/standalone/.git` was 88 MB. That trace IS
#     reachable by `outputFileTracingExcludes` (only middleware's is not), so
#     `.git/**` is excluded there now and this sweep should find nothing —
#     kept because no real build has been measured with that line in place,
#     and because a post-condition that fails the build is worth more than an
#     exclude nobody would notice regressing.
#
# On a box the checkout `.env` is 0600 and holds GOOGLE_OAUTH_CLIENT_SECRET
# and, where install.sh was given one, CLAWBOX_AI_API_KEY. Nothing reads the
# copy: systemd hands the real file to clawbox-setup as an EnvironmentFile, and
# @next/env never overwrites a variable that is already in the environment.
#
# Depth-unbounded because the trace copies whole project subdirectories:
# `e2e-install/.env.test` (gitignored, and its tracked .example documents seven
# provider keys) lands at `.next/standalone/e2e-install/.env.test`, two levels
# down. `node_modules` is pruned — packages ship `.env` fixtures of their own,
# and failing a build over one would be a false failure.
# Every pattern quoted, including the three that need no quoting today: this
# script runs with the project root as cwd, where `.env` and `.git` both exist,
# so one added `*` in an unquoted word would be expanded by the shell against
# the checkout before `find` ever saw it.
env_and_git_copies() {
  find "$STANDALONE" \
    -name 'node_modules' -prune \
    -o \( -name '.env' -o -name '.env.*' -o -name '.git' \) -prune "$@"
}

# `|| true` so the check below is what reports a failed removal, rather than
# errexit killing the script on `rm` with nothing said — the same shape the
# data/ removal above uses.
env_and_git_copies -exec rm -rf {} + || true

# `-quit` rather than a pipe to `head`: under `pipefail` a `find` that is still
# writing when `head` exits dies of SIGPIPE, and errexit would then end the
# build with no output at all.
LEFT="$(env_and_git_copies -print -quit)" \
  || fail "could not scan $STANDALONE for copied .env/.git files"
if [ -n "$LEFT" ]; then
  fail "$LEFT survived removal - the standalone tree would ship a copy of the checkout's environment files or of its .git (see next.config.ts)"
fi

rm -rf "$SDIR/.next/static" "$SDIR/public"
cp -r .next/static "$SDIR/.next/static"
cp -r public "$SDIR/public"
cp .next/build-info.json "$SDIR/.next/build-info.json"

# Playwright is not traced (the browser tests import it dynamically), so it is
# copied beside the entry for the on-device browser tools.
# Never through a symlinked node_modules: in a worktree whose node_modules
# is a symlink to another checkout's, the traced tree's node_modules is a
# symlink to that real directory, and an rm through it removed the real
# playwright package (2026-09-05). A symlinked tree resolves to the full
# packages already, so there is nothing to copy there.
if [ ! -L "$SDIR/node_modules" ]; then
  for pwp in playwright playwright-core; do
    if [ -d "node_modules/$pwp" ]; then
      rm -rf "$SDIR/node_modules/$pwp"
      mkdir -p "$SDIR/node_modules"
      cp -r "node_modules/$pwp" "$SDIR/node_modules/$pwp"
    fi
  done
fi
# The webpack standalone build's traced copy of `next` misses
# lib/metadata/get-metadata-route and the server dies on it at start: point
# the tree at the real package (the script refuses a symlinked tree and fails
# the build when the link cannot be made). The traced node_modules sits
# beside the app in a nested layout, or at the standalone root.
LINK_TREE="$SDIR"
[ -d "$SDIR/node_modules" ] || LINK_TREE="$STANDALONE"
bash scripts/link-standalone-next.sh "$LINK_TREE"

# Nested layout only: production-server.js and install.sh both load
# `.next/standalone/server.js`, so point it at the real entry. The link is
# absolute, which is why `build_entry_present` in install.sh tests `-L` beside
# `-e` — it dangles while the tree is parked under `.next-old`.
if [ "$SRVJS" != "$STANDALONE/server.js" ]; then
  ln -sf "$(pwd)/$SRVJS" "$STANDALONE/server.js"
fi
