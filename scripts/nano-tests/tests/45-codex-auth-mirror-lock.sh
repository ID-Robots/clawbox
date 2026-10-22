#!/usr/bin/env bash
# timeout: 600
# covers: scripts/codex-auth-mirror.js config/clawbox-codex-auth-sync.service config/clawbox-codex-auth-sync.timer
#
# A codex-auth-mirror pass is not held up by the live gateway's writes. The
# write-back of an app-server rotation used to take core's write lock
# (`BEGIN IMMEDIATE`) on the main agent's openclaw-agent.sqlite before it
# looked inside, so on a migrated `state-db` box — the login in the shared
# store, the agent's own `auth_profile_store` row without it — every timer
# pass queued behind the gateway's writes for up to the whole 5 s
# busy_timeout, to find nothing to write. The store is now read first
# (read-only; WAL readers never queue behind a writer) and only a store that
# holds the profile is locked.
#
# On the board, against the live pinned gateway:
#
#   * The main agent's store must hold no ChatGPT sign-in of its own — the
#     card's case, and the guard that keeps the fixture rotation below from
#     ever reaching a real login. A board that has one is skipped.
#   * The rest of the login is a fixture in a throwaway folder: a shared
#     `state-db` store holding `openai:chatgpt` (reached through
#     OPENCLAW_STATE_DIR, the override core and the script both honour) and an
#     app-server CODEX_HOME that has rotated. Its agent folder's
#     openclaw-agent.sqlite is a symlink to the LIVE main agent's database, so
#     the write-back meets the gateway's real lock on the gateway's real file.
#   * Real chat turns (two rounds of two, each in a session of its own) keep
#     the gateway writing sessions and transcripts into that database while
#     the shipped script runs over and over exactly as
#     clawbox-codex-auth-sync.service runs it: the unit's PATH and
#     CODEX_AUTH_MIRROR_QUIET=1.
#   * Beside the passes, a probe asks for the write lock every 10 ms without
#     waiting (busy_timeout 0, rolled back at once) to see when the gateway
#     holds it, and a waiter queues a `BEGIN IMMEDIATE` with the script's
#     5 s busy_timeout — the step beta's write-back took — to show what
#     queuing would have cost at that moment.
#
# Every pass must exit 0 in under 2 s, reach the write-back (its "could not
# be updated" warning: nothing to record the rotation in), adopt nothing, and
# leave the live store's row byte-for-byte as it was. At least one pass must
# have run while the gateway held the lock; when the gateway never held it
# during a pass the run cannot show that, and says so as a skip.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

LIMIT_MS=2000

# Runs ON the board under the board's node (see BOARD_SCRIPT). Modes:
#   inspect LIVE_DB        -> one JSON line: journal mode, profile counts, row hash
#   setup LIVE_DB WORK     -> the fixture login under WORK
#   run LIVE_DB SCRIPT NODE WORK UNIT_PATH -> passes until WORK/load-done, then one JSON line
read -r -d '' OBSERVER <<'JS'
"use strict";
const { DatabaseSync } = require("node:sqlite");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROFILE = "openai:chatgpt";
const CORE_REFRESH = "nano-ci-refresh-held-by-core";
const ROTATED_REFRESH = "nano-ci-refresh-rotated-by-app-server";
const SAMPLE_MS = 10;
const MIN_PASSES = 8;
const CAP_MS = 420000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function token(marker) {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "nano-ci" } };
  return `nano-ci.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${marker}`;
}

// The script's own test (isChatgptProfile): an openai-provider OAuth profile.
function chatgptShaped(key, entry) {
  if (!entry || typeof entry !== "object") return false;
  const provider = String(entry.provider || key.split(":")[0] || "").trim().toLowerCase();
  const mode = String(entry.type || entry.mode || "").trim().toLowerCase();
  if (mode && mode !== "oauth") return false;
  return provider === "openai" || provider === "codex" || provider === "openai-codex";
}

function inspect(live) {
  const db = new DatabaseSync(live, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const journal = db.prepare("PRAGMA journal_mode").get().journal_mode;
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_profile_store'")
      .get();
    const row = table
      ? db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'").get()
      : undefined;
    const json = row && row.store_json ? String(row.store_json) : "";
    let profiles = {};
    try {
      profiles = (json && JSON.parse(json).profiles) || {};
    } catch {
      profiles = {};
    }
    const keys = Object.keys(profiles);
    return {
      journal,
      table: Boolean(table),
      row: Boolean(row),
      profiles: keys.length,
      chatgpt: keys.filter((key) => chatgptShaped(key, profiles[key])).length,
      holdsProfile: Boolean(profiles[PROFILE]),
      sha: crypto.createHash("sha256").update(json).digest("hex").slice(0, 16),
    };
  } finally {
    db.close();
  }
}

function layout(work) {
  const home = path.join(work, "openclaw");
  const agentDir = path.join(home, "agents", "main", "agent");
  return {
    home,
    agentDir,
    rotated: path.join(agentDir, "codex-home", "auth.json"),
    stateDir: path.join(work, "state-dir"),
    homeAuth: path.join(work, "home-auth.json"),
    done: path.join(work, "load-done"),
  };
}

function setup(live, work) {
  const at = layout(work);
  fs.mkdirSync(path.dirname(at.rotated), { recursive: true, mode: 0o700 });
  fs.symlinkSync(live, path.join(at.agentDir, "openclaw-agent.sqlite"));
  fs.mkdirSync(path.join(at.stateDir, "state"), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(at.stateDir, "state", "openclaw.sqlite"));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(
      "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)",
    );
    const put = db.prepare("INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)");
    put.run("auth.sharedStore", JSON.stringify({ location: "state-db" }), Date.now());
    const login = {
      type: "oauth",
      provider: "openai",
      access: token("core"),
      refresh: CORE_REFRESH,
      expires: Date.now() + 3600000,
    };
    put.run("authProfiles.store", JSON.stringify({ version: 1, profiles: { [PROFILE]: login } }), Date.now());
  } finally {
    db.close();
  }
  const rotation = {
    OPENAI_API_KEY: null,
    tokens: { access_token: token("rotated"), refresh_token: ROTATED_REFRESH, account_id: "nano-ci" },
  };
  fs.writeFileSync(at.rotated, JSON.stringify(rotation), { mode: 0o600 });
}

function refreshIn(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).tokens.refresh_token;
  } catch {
    return null;
  }
}

// What a BEGIN IMMEDIATE with the script's busy_timeout waits right now: the
// step beta's write-back took before it looked inside the store.
const WAITER = [
  'const { DatabaseSync } = require("node:sqlite");',
  "const db = new DatabaseSync(process.argv[1]);",
  'db.exec("PRAGMA busy_timeout = 5000");',
  "const t0 = Date.now();",
  "let got = true;",
  'try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); } catch { got = false; }',
  "const t1 = Date.now();",
  "db.close();",
  "process.stdout.write(JSON.stringify({ t0, t1, got }));",
].join("\n");

async function run(live, script, nodeBin, work, unitPath) {
  const at = layout(work);
  // The environment clawbox-codex-auth-sync.service gives the script, plus the
  // fixture's state directory.
  const env = {
    HOME: process.env.HOME,
    PATH: unitPath,
    CODEX_AUTH_MIRROR_QUIET: "1",
    OPENCLAW_STATE_DIR: at.stateDir,
  };

  // Never waits and never writes: BEGIN IMMEDIATE either fails at once
  // (someone holds the write lock) or is rolled back at once.
  const probe = new DatabaseSync(live);
  probe.exec("PRAGMA busy_timeout = 0");
  const samples = [];
  const sample = () => {
    let held = false;
    try {
      probe.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!/locked|busy/i.test(String(error && error.message))) throw error;
      held = true;
    }
    if (!held) probe.exec("ROLLBACK");
    samples.push([Date.now(), held]);
  };
  const timer = setInterval(sample, SAMPLE_MS);

  const waits = [];
  let stop = false;
  const waiting = (async () => {
    while (!stop) {
      const wait = await new Promise((resolve) => {
        const child = spawn(nodeBin, ["--no-warnings", "-e", WAITER, live], {
          env,
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.on("error", () => resolve(null));
        child.on("close", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      });
      if (wait) waits.push(wait);
      await sleep(100);
    }
  })();

  const pass = () =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const started = process.hrtime.bigint();
      const child = spawn(nodeBin, [script, at.home, at.homeAuth], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("error", (error) =>
        resolve({ t0, t1: Date.now(), ms: -1, code: String(error.message), reached: false }),
      );
      child.on("close", (code, signal) =>
        resolve({
          t0,
          t1: Date.now(),
          ms: Number((process.hrtime.bigint() - started) / 1000000n),
          code: code === null ? String(signal) : code,
          // The write-back ran and found nowhere to record the rotation.
          reached: err.includes("core's store could not be updated"),
        }),
      );
    });

  const began = Date.now();
  const passes = [];
  for (;;) {
    const loadDone = fs.existsSync(at.done);
    if ((loadDone && passes.length >= MIN_PASSES) || Date.now() - began > CAP_MS) break;
    passes.push(await pass());
    await sleep(150);
  }
  stop = true;
  await waiting;
  clearInterval(timer);
  probe.close();

  // A waiter's own moment of holding the lock is not the gateway's.
  const own = waits.filter((w) => w.got).map((w) => w.t1);
  const gateway = samples.filter(([t, held]) => held && !own.some((t1) => Math.abs(t - t1) <= 2));
  let longest = 0;
  let runStart = null;
  let last = null;
  for (const [t, held] of samples) {
    const isGateway = held && !own.some((t1) => Math.abs(t - t1) <= 2);
    if (isGateway) {
      if (runStart === null) runStart = t;
      last = t;
      longest = Math.max(longest, last - runStart + SAMPLE_MS);
    } else {
      runStart = null;
    }
  }
  const report = passes.map((p) => {
    const inWindow = samples.filter(([t]) => t >= p.t0 && t <= p.t1).length;
    const held = gateway.filter(([t]) => t >= p.t0 && t <= p.t1).length;
    const beside = waits.filter((w) => w.t0 <= p.t1 && w.t1 >= p.t0);
    return {
      ms: p.ms,
      code: p.code,
      reached: p.reached,
      held,
      samples: inWindow,
      queuedMs: beside.reduce((max, w) => Math.max(max, w.t1 - w.t0), 0),
    };
  });
  return {
    node: process.version,
    passes: report,
    samples: samples.length,
    held: gateway.length,
    longestHeldMs: longest,
    waits: {
      n: waits.length,
      timedOut: waits.filter((w) => !w.got).length,
      maxMs: waits.reduce((max, w) => Math.max(max, w.t1 - w.t0), 0),
    },
    mirror: { [CORE_REFRESH]: "core", [ROTATED_REFRESH]: "rotated" }[refreshIn(at.homeAuth)] || "none",
    rotatedIntact: refreshIn(at.rotated) === ROTATED_REFRESH,
  };
}

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "inspect") console.log(JSON.stringify(inspect(args[0])));
  else if (mode === "setup") setup(args[0], args[1]);
  else if (mode === "run") console.log(JSON.stringify(await run(...args)));
  else throw new Error(`unknown mode ${mode}`);
})().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exit(1);
});
JS

# Answers in prefixed lines: FAIL / SKIP <why>, BEFORE / AFTER <inspect JSON>,
# RESULT <run JSON>, TURN <round-n> <exit status>.
# shellcheck disable=SC2016  # expanded on the board
BOARD_SCRIPT='
openclaw=$1 session=$2 marker=$3 observer=$4
live=$HOME/.openclaw/agents/main/agent/openclaw-agent.sqlite
script=$REPO/scripts/codex-auth-mirror.js
# clawbox-codex-auth-sync.service: ExecStart=/usr/bin/env node, systemd PATH.
unit_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
node_bin=$(PATH=$unit_path command -v node) || node_bin=""
[ -n "$node_bin" ] || { echo "FAIL no node on the PATH clawbox-codex-auth-sync.service runs with"; exit 0; }
[ -f "$script" ] || { echo "FAIL the checkout has no scripts/codex-auth-mirror.js"; exit 0; }
[ -f "$live" ] || { echo "SKIP the main agent keeps no openclaw-agent.sqlite (not a SQLite-store core)"; exit 0; }
work=$(mktemp -d /tmp/nano-ci-codex-mirror.XXXXXX) || { echo "FAIL could not make a work folder"; exit 0; }
jobs_started=()
cleanup() {
  local p
  for p in "${jobs_started[@]}"; do kill "$p" 2>/dev/null; done
  rm -rf "$work"
}
trap cleanup EXIT
printf "%s\n" "$observer" > "$work/observe.js"
obs() { "$node_bin" --no-warnings "$work/observe.js" "$@"; }

before=$(obs inspect "$live" 2>&1) || { echo "FAIL could not read the main agent store: $(printf "%s" "$before" | tail -n 1)"; exit 0; }
echo "BEFORE $before"
case "$before" in
  *"\"chatgpt\":0,"*) ;;
  *) echo "SKIP the main agent holds a ChatGPT sign-in of its own; the fixture rotation must never reach a real login"; exit 0 ;;
esac
setup_err=$(obs setup "$live" "$work" 2>&1) || { echo "FAIL could not build the fixture login: $(printf "%s" "$setup_err" | tail -n 1)"; exit 0; }

"$node_bin" --no-warnings "$work/observe.js" run "$live" "$script" "$node_bin" "$work" "$unit_path" \
  > "$work/run.json" 2> "$work/run.err" &
observer_pid=$!
jobs_started+=("$observer_pid")

prompt="In about 150 words, describe a quiet morning in a small workshop. End with the line $marker"
for round in 1 2; do
  turns=()
  for n in 1 2; do
    (
      timeout 200 "$openclaw" agent --agent main --session-key "$session-$round-$n" \
        -m "$prompt" --json --timeout 190 > /dev/null 2>&1
      echo "$?" > "$work/turn-$round-$n.rc"
    ) &
    turns+=("$!")
    jobs_started+=("$!")
  done
  wait "${turns[@]}"
done
touch "$work/load-done"
wait "$observer_pid"
jobs_started=()

for rc in "$work"/turn-*.rc; do
  name=${rc##*/turn-}
  echo "TURN ${name%.rc} $(cat "$rc")"
done
after=$(obs inspect "$live" 2>&1) || after="{}"
echo "AFTER $after"
if [ -s "$work/run.json" ]; then
  echo "RESULT $(tail -n 1 "$work/run.json")"
else
  echo "FAIL the observer stopped without a result: $(tail -n 1 "$work/run.err" 2>/dev/null)"
fi
'

out=$(board "$BOARD_SCRIPT" "$OPENCLAW_BIN" "nano-ci-$NANO_RUN_ID-$(date +%s)-mirror" \
  "NANO-CI-MIRROR $NANO_SERIAL" "$OBSERVER")
rc=$?
field() { printf '%s\n' "$out" | sed -n "s/^$1 //p" | head -n 1; }

failed=$(field FAIL)
skipped=$(field SKIP)
before=$(field BEFORE)
after=$(field AFTER)
result=$(field RESULT)

[ -n "$before" ] && note "main agent store before: $(jq -c '{journal, table, row, profiles, chatgpt}' <<<"$before" 2>/dev/null)"
while read -r name status; do
  [ -n "$name" ] && note "chat turn $name exited $status"
done <<<"$(printf '%s\n' "$out" | sed -n 's/^TURN //p')"

if [ -n "$failed" ]; then
  not_ok "$failed"
  finish
fi
if [ -n "$skipped" ]; then
  skip "$skipped"
  finish
fi
if [ -z "$result" ] || ! jq -e '.passes' >/dev/null 2>&1 <<<"$result"; then
  not_ok "the board answered no result (exit $rc): $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ' | head -c 300)"
  finish
fi

note "board node $(jq -r '.node' <<<"$result"); the gateway held the write lock in $(jq -r '.held' <<<"$result") of $(jq -r '.samples' <<<"$result") probes, longest stretch $(jq -r '.longestHeldMs' <<<"$result") ms"
note "a BEGIN IMMEDIATE queued with the script's 5 s busy_timeout (beta's write-back step): $(jq -r '.waits | "\(.n) waits, longest \(.maxMs) ms, \(.timedOut) ran out the 5 s"' <<<"$result")"
note "passes (ms / gateway-held probes in the pass / longest wait beside it): $(jq -r '([.passes[:40][] | "\(.ms)/\(.held)/\(.queuedMs)"] | join(" ")) + (if (.passes | length) > 40 then " and \((.passes | length) - 40) more" else "" end)' <<<"$result")"

n=$(jq '.passes | length' <<<"$result")
slow=$(jq --argjson limit "$LIMIT_MS" '[.passes[] | select(.code != 0 or .ms < 0 or .ms >= $limit)] | length' <<<"$result")
max=$(jq '[.passes[].ms] | max // 0' <<<"$result")
if [ "$n" -eq 0 ]; then
  not_ok "no codex-auth-mirror pass ran"
elif [ "$slow" -eq 0 ]; then
  ok "all $n codex-auth-mirror passes exited 0 in under $LIMIT_MS ms (slowest $max ms)"
else
  not_ok "$slow of $n codex-auth-mirror passes failed or took $LIMIT_MS ms or more: $(jq -r --argjson limit "$LIMIT_MS" '[.passes[] | select(.code != 0 or .ms < 0 or .ms >= $limit) | "\(.ms) ms exit \(.code)"] | join(", ")' <<<"$result")"
fi

unreached=$(jq '[.passes[] | select(.reached | not)] | length' <<<"$result")
if [ "$n" -gt 0 ] && [ "$unreached" -eq 0 ]; then
  ok "every pass reached the write-back and found no profile to record the rotation in"
elif [ "$n" -gt 0 ]; then
  not_ok "$unreached of $n passes never reached the write-back (no \"could not be updated\" warning): the fixture login was not read"
fi

if [ "$(jq -r '.sha' <<<"$before")" = "$(jq -r '.sha // empty' <<<"$after" 2>/dev/null)" ] \
  && [ "$(jq -r '.mirror' <<<"$result")" = core ] && [ "$(jq -r '.rotatedIntact' <<<"$result")" = true ]; then
  ok "the live store's auth_profile_store row is unchanged, nothing was adopted, and the app-server's rotation was left alone"
else
  not_ok "something was written: row before $(jq -r '.sha' <<<"$before") after $(jq -r '.sha // "unreadable"' <<<"$after" 2>/dev/null), mirror carries the $(jq -r '.mirror' <<<"$result") token, rotation intact $(jq -r '.rotatedIntact' <<<"$result")"
fi

under=$(jq '[.passes[] | select(.held > 0)] | length' <<<"$result")
if [ "$under" -gt 0 ]; then
  ok "$under of $n passes ran while the gateway held the main agent's write lock, slowest $(jq '[.passes[] | select(.held > 0) | .ms] | max' <<<"$result") ms; a BEGIN IMMEDIATE queued beside them waited up to $(jq '[.passes[] | select(.held > 0) | .queuedMs] | max' <<<"$result") ms"
else
  skip "the gateway never held the main agent's write lock during a pass ($(jq -r '.held' <<<"$result") of $(jq -r '.samples' <<<"$result") probes held), so this run cannot show a pass beside the held lock"
fi
finish
