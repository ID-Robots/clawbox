#!/usr/bin/env bash
# scripts/check-build-isolation.sh
#
# Prove that `bun run build` never reaches the runtime state under the project
# root: data/ (the owner's config, code projects, web apps, and the coding
# agent's evidence folders and stream files), coding-run worktrees under
# .clawbox/, and a build parked at .next-old by an update (TASK-1102).
#
# On a box all of those change while the build runs, and the build used to walk
# and copy them. A Python venv a coding run left in its evidence folder made
# Turbopack panic ("Symlink … venv/bin/python is invalid, it points out of the
# filesystem root"), and a stream file rotated between the trace and the
# standalone copy killed the copy with ENOENT. src/lib/runtime-path.ts explains
# why and what keeps them out.
#
# What this does, in a checkout that has none of those paths yet (CI, a fresh
# clone). It refuses to run anywhere else, because it would be planting into
# real state and then deleting it:
#
#   1. plants a device-like tree: the data/ layout a box has, a real venv
#      symlink chain that points out of the filesystem root, a dangling symlink,
#      a code project with node_modules links, a run worktree, a parked build,
#      and a file for every name the server code can build (see below);
#   2. runs the build while a loop keeps creating and deleting files under
#      data/coding-agent-streams/ and data/coding-agent-artifacts/;
#   3. fails unless the build succeeded, no `.nft.json` under .next lists
#      anything under those paths or .git, .next/standalone has no data/, and
#      Turbopack did not report tracing the whole project;
#   4. removes everything it planted, whatever happened.
#
# What it cannot see: a default like "/home/clawbox/clawbox/data/x" is inside
# the project only on a box, where the checkout IS that path. Those defaults
# are planted too, so a build run from that path would catch them.
#
# Usage: bash scripts/check-build-isolation.sh [build command, default: bun run build]
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD_CMD="${*:-bun run build}"

# Each is a path the build must not reach. Relative to $ROOT.
PLANTED=(data .clawbox .next-old)

fail() { echo "check-build-isolation: $*" >&2; exit 1; }

for p in "${PLANTED[@]}"; do
  if [ -e "$p" ] || [ -L "$p" ]; then
    fail "$ROOT/$p already exists. Run this in a fresh checkout: it plants a fixture there and deletes it afterwards"
  fi
done

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawbox-build-isolation-XXXXXX")"
LOG="$LOG_DIR/build.log"
CHURN_PID=""

cleanup() {
  local rc=$?
  if [ -n "$CHURN_PID" ]; then
    kill "$CHURN_PID" 2>/dev/null || true
    wait "$CHURN_PID" 2>/dev/null || true
  fi
  rm -rf "${PLANTED[@]}" "$LOG_DIR"
  exit "$rc"
}
trap cleanup EXIT

# 1. The fixture. Names follow what the code writes under data/ on a box; the
# three hazards are the evidence folder's venv, its dangling link and the
# stream files the churn below replaces.
D=data
mkdir -p "$D"/{catalog-cache,chat-transcripts,chat-media,cloudflared,icons,coding-team,coding-agent-streams} \
  "$D"/coding-agent-inputs/{run-fixture,shared} \
  "$D"/coding-agent-artifacts/run-fixture/venv-attempt/venv/bin "$D"/coding-agent-artifacts/run-churn \
  "$D"/webapps/site "$D"/code-projects/site/node_modules/{.bin,tool} \
  .clawbox/worktrees/run-fixture .next-old/standalone
for f in config.json coding-agent-runs.json secrets.json kv.json schedule.json oauth-state.json \
         memory-index-state.json email-pending.json plugin-repair.json; do
  echo '{}' > "$D/$f"
done
for f in .session-secret token config.toml .mcp-token .local-ai-token internal-token.env \
         network.env hotspot.env restoring.flag memory-index.lock; do
  echo fixture > "$D/$f"
done
echo '{}' > "$D/catalog-cache/anthropic.json"
echo '{}' > "$D/chat-transcripts/desktop.jsonl"
echo fixture > "$D/chat-media/a.png"
echo fixture > "$D/cloudflared/config.yml"
echo fixture > "$D/icons/a.png"
echo '{}' > "$D/coding-team/board-1.json"
echo '{}' > "$D/coding-agent-streams/run-fixture.jsonl"
echo fixture > "$D/coding-agent-streams/run-fixture.err"
echo fixture > "$D/coding-agent-inputs/run-fixture/brief.md"
echo fixture > "$D/coding-agent-inputs/shared/notes.md"
echo fixture > "$D/coding-agent-artifacts/run-fixture/report.md"
echo fixture > "$D/coding-agent-artifacts/run-fixture/shot-001.png"
# The shape `python3 -m venv` writes, and the one that panicked Turbopack: a
# link inside the folder to a link that leaves the filesystem root.
ln -s python3 "$D/coding-agent-artifacts/run-fixture/venv-attempt/venv/bin/python"
ln -s /usr/bin/python3 "$D/coding-agent-artifacts/run-fixture/venv-attempt/venv/bin/python3"
echo 'home = /usr/bin' > "$D/coding-agent-artifacts/run-fixture/venv-attempt/venv/pyvenv.cfg"
ln -s /nonexistent/clawbox-build-isolation "$D/coding-agent-artifacts/run-fixture/dangling"
echo '<!doctype html>' > "$D/webapps/site/index.html"
echo '{}' > "$D/webapps/site/meta.json"
echo '<!doctype html>' > "$D/code-projects/site/index.html"
echo '{"name":"site"}' > "$D/code-projects/site/package.json"
echo 'module.exports = 1' > "$D/code-projects/site/node_modules/tool/cli.js"
ln -s ../tool/cli.js "$D/code-projects/site/node_modules/.bin/tool"
echo fixture > .clawbox/worktrees/run-fixture/notes.txt
echo 'module.exports = {}' > .next-old/standalone/server.js

# Every file name the server code can build, planted under data/ too. A glob
# the build makes from a dynamic path only shows up here if data/ holds a file
# it matches: `${CONFIG_PATH}.lock` matches every *.lock, and
# `${dir}/sessions/${id}.jsonl` matches every such pair. So each path-shaped
# template literal in src/ (every `${…}` becomes "x") and each suffix-shaped
# string literal (".tmp", "-wal", "/config.json") becomes a file of its own. A
# build that traces none of them can trace nothing a box writes there either.
node - "$D/fixture-names" <<'NODE'
const fs = require("fs"), path = require("path");
const out = process.argv[2];
const names = new Set();
const exact = new Set();
const roots = ["/home/clawbox/clawbox/", process.cwd() + "/"];
const keep = (s) => s.length > 1 && s.length <= 120 && !/[\s<>*?:#=|"'\\]|\.\.|^~|\/\//.test(s) && /[./]/.test(s);
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== path.join("src", "tests")) walk(p); continue; }
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(e.name)) continue;
    const src = fs.readFileSync(p, "utf8");
    for (const [t] of src.matchAll(/`[^`]*`/g)) {
      const s = t.slice(1, -1).replace(/\$\{[^}]*\}/g, "x").replace(/^\/+/, "");
      if (t.includes("${") && keep(s)) names.add(s);
    }
    for (const m of src.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'/g)) {
      const s = m[1] ?? m[2];
      if (/^[./_-]/.test(s) && keep(s)) names.add("x" + s);
      // An absolute default into a box's own checkout names one exact file,
      // and it is inside the project only where the checkout IS that path.
      for (const root of roots) {
        if (s.startsWith(root + "data/") && keep(s)) exact.add(s.slice(root.length));
      }
    }
  }
};
walk("src");
let n = 0;
// A name that ends in "/" is a directory: it gets a file to hold. A name that
// cannot be planted, because another one already holds that path as a file,
// is skipped rather than crashing the check before it has built anything.
const plant = (file) => {
  if (file.endsWith("/")) file += "x";
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture\n");
    return true;
  } catch {
    return false;
  }
};
let planted = 0;
for (const name of names) {
  const file = path.join(out, String(n++), name); // keeps a trailing "/"
  if (file.startsWith(out + path.sep) && plant(file)) planted++;
}
let named = 0;
for (const rel of exact) if (plant(rel)) named++;
console.log(`check-build-isolation: planted ${planted} file names the server code can build under ${out}, and ${named} it names outright`);
NODE

# 2. Files that appear and vanish for as long as the build runs, the way a live
# run's stream and screenshots do.
(
  i=0
  while :; do
    i=$((i + 1))
    echo "$i" > "$D/coding-agent-streams/run-churn-$i.err"
    echo "$i" > "$D/coding-agent-artifacts/run-churn/shot-$i.png"
    rm -f "$D/coding-agent-streams/run-churn-$((i - 1)).err" "$D/coding-agent-artifacts/run-churn/shot-$((i - 1)).png"
    sleep 0.02
  done
) &
CHURN_PID=$!

echo "check-build-isolation: building with a planted data/ ($BUILD_CMD)"
set +e
bash -c "$BUILD_CMD" 2>&1 | tee "$LOG"
BUILD_RC=${PIPESTATUS[0]}
set -e
kill "$CHURN_PID" 2>/dev/null || true
wait "$CHURN_PID" 2>/dev/null || true
CHURN_PID=""

# 3. The verdicts. Every one is checked and reported before the exit.
PROBLEMS=0
problem() { echo "check-build-isolation: FAIL: $*" >&2; PROBLEMS=$((PROBLEMS + 1)); }

[ "$BUILD_RC" -eq 0 ] || problem "the build exited $BUILD_RC"

# The traces are what Next copies into .next/standalone, so a planted path in
# any of them is a copy that a vanished file can kill. .git is held to the same
# rule without being planted, since a checkout has one: it is rewritten by the
# update's own `git reset --hard` while the build runs, and it rode in on the
# old sweep (88 MB of it on one box). So are the two transient names the atomic
# build reclaim moves a parked build through (TASK-729). Read with node, which
# every machine that builds this app has.
if [ -d .next ]; then
  if ! node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    const planted = [...process.argv.slice(2), ".git"].map((p) => path.join(root, p));
    const transient = /^\.next-(claim|discard)\./;
    const reached = (abs) =>
      planted.some((q) => abs === q || abs.startsWith(q + path.sep))
      || transient.test(path.relative(root, abs).split(path.sep)[0]);
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "standalone" && e.name !== "cache") walk(p); }
        else if (e.name.endsWith(".nft.json")) {
          const { files = [] } = JSON.parse(fs.readFileSync(p, "utf8"));
          for (const f of files) {
            const abs = path.resolve(path.dirname(p), f);
            if (reached(abs)) hits.push(`${path.relative(root, p)}: ${path.relative(root, abs)}`);
          }
        }
      }
    };
    walk(path.join(root, ".next"));
    for (const h of hits.slice(0, 20)) console.error("  " + h);
    if (hits.length > 20) console.error(`  … and ${hits.length - 20} more`);
    process.exit(hits.length ? 1 : 0);
  ' "$ROOT" "${PLANTED[@]}"; then
    problem "a build trace lists files under ${PLANTED[*]} .git (above), so Next copies them into .next/standalone. Build the path with src/lib/runtime-path"
  fi
else
  problem "the build left no .next directory"
fi

# Beside the entry as well as at the top: the nested layout puts the app's tree
# one level down (see scripts/postbuild.sh).
if [ -d .next/standalone ]; then
  LEFT="$(find .next/standalone -maxdepth 3 \( -name node_modules -o -name .next -o -name public \) -prune \
    -o -type d -name data -print -quit)"
  [ -z "$LEFT" ] || problem "$LEFT exists"
else
  problem "the build left no .next/standalone"
fi

# A glob over the whole project reaches data/ by definition, even when this
# fixture happens not to contain a file it would match.
if awk '/causes tracing of the whole project|^Warning: The file pattern/ { hit = 1 } END { exit hit ? 0 : 1 }' "$LOG"; then
  problem "Turbopack traced a dynamic path across the whole project (warnings above). Import path from src/lib/runtime-path, or give the flagged fs call a turbopackIgnore comment"
fi

if [ "$PROBLEMS" -gt 0 ]; then
  fail "$PROBLEMS check(s) failed"
fi
echo "check-build-isolation: OK. The build succeeded, no trace reaches ${PLANTED[*]}, and .next/standalone has no data/"
