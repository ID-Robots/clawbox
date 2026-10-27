// One tiny delegated coding run, end to end, through the routes the assistant
// uses (src/app/setup-api/coding-agent/): POST run with a deterministic task
// in a fresh folder of its own, poll runs?id= until the record settles, then
// check on disk that the file it was asked for is there. What it measures is
// what the owner feels — how long until the run shows a sign of life, how long
// until it is done — and what the box paid for it: the web server's bytes
// written per minute while the run was alive (every progress line rewrites
// data/coding-agent-runs.json, so a chatty run is a write amplifier) and its
// CPU share. Skipped under --quick and whenever the coding agent is off or not
// ready. Spends a little of the owner's model budget on purpose.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const id = "coding-agent";
export const title = "Coding agent run";
export const weight = 15;
export const order = 60;
export const needs = ["long"];

const POLL_MS = 3_000;
const DEADLINE_MS = 12 * 60_000;
/** Statuses a record never leaves on its own (src/lib/coding-agent-status.ts RUN_STATUSES). */
const TERMINAL = new Set(["completed", "failed", "stopped", "gave_up"]);
const FOLDER_RE = /\/clawbox-bench-\d+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readRun(r) {
  return r?.json?.run ?? null;
}

/** Stop the run, then give the box a moment to settle the record. */
async function stopRun(client, runId, log) {
  const r = await client.http("/setup-api/coding-agent/stop", { method: "POST", body: { runId }, timeoutMs: 30_000 });
  log(`stop ${runId} → ${r.status}`);
  for (let i = 0; i < 10; i++) {
    const g = await client.http(`/setup-api/coding-agent/runs?id=${encodeURIComponent(runId)}`, { timeoutMs: 30_000 });
    const run = readRun(g);
    if (run && TERMINAL.has(run.status)) return run;
    await sleep(POLL_MS);
  }
  return readRun(await client.http(`/setup-api/coding-agent/runs?id=${encodeURIComponent(runId)}`, { timeoutMs: 30_000 }));
}

export async function run({ client, host, log, repoRoot }) {
  const status = await client.http("/setup-api/coding-agent/status", { timeoutMs: 30_000 });
  if (!status.ok || !status.json) return { skipped: `coding-agent/status answered ${status.status}${status.error ? " " + status.error : ""}`, metrics: {} };
  const st = status.json;
  if (st.enabled !== true) return { skipped: "the coding agent is switched off (status.enabled=false)", metrics: {} };
  if (st.ready !== true) {
    const why = st.readiness && typeof st.readiness === "object" ? JSON.stringify(st.readiness).slice(0, 200) : "status.ready=false";
    return { skipped: `the coding agent is not ready: ${why}`, metrics: {} };
  }

  // A fresh, empty folder of the bench's own, inside the owner's project
  // folder (a run must be INSIDE it when one is set — resolveWorkingDirectory).
  const base = typeof st.defaultDirectory === "string" && st.defaultDirectory ? st.defaultDirectory : path.join(os.homedir(), "Projects");
  const dir = path.join(base, `clawbox-bench-${Date.now()}`);
  if (!FOLDER_RE.test(dir)) throw new Error(`refusing to use ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const marker = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const line = `clawbox bench ${marker}`;
  const task = `Create a file named hello.txt in the current working folder whose entire content is exactly this one line:\n${line}\nDo not create, change or delete any other file, do not run a build, a server or any tests, and do not verify anything in a browser. Say done when the file is written, then stop.`;

  const details = { directory: dir, marker, runId: null, finalStatus: null, polls: 0, stoppedByBench: false, recordLeft: "no per-run delete route: the record stays in the run list (DELETE runs clears EVERY finished run)", pollMs: [] };
  const cleanup = () => {
    try { if (FOLDER_RE.test(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { details.cleanupError = String(e?.message || e); }
  };

  let before = host.snapshot();
  const t0 = Date.now();
  let started;
  try {
    started = await client.http("/setup-api/coding-agent/run", { method: "POST", body: { task, directory: dir }, timeoutMs: 60_000 });
  } catch (err) {
    cleanup(); // the folder must not outlive a start request the transport lost
    throw err;
  }
  const postMs = started.ms;
  const run0 = readRun(started);
  if (started.status === 409) {
    cleanup();
    return { skipped: `run refused 409 (${started.json?.kind ?? "not_ready"}): ${started.json?.error ?? ""}`.trim(), metrics: {} };
  }
  if (started.status !== 202 || !run0?.id) {
    cleanup();
    log(`run did not start: ${started.status} ${started.json?.error ?? started.error ?? started.text?.slice(0, 200) ?? ""}`);
    return {
      metrics: {
        success: { value: 0, unit: "", dir: "higher", good: 1, bad: 0, weight: 3, label: "the run completed and left the file" },
      },
      details: { ...details, startError: `${started.status} ${started.json?.error ?? started.error ?? ""}`.trim() },
    };
  }
  const runId = run0.id;
  details.runId = runId;
  details.queued = started.json?.queued === true;
  log(`run ${runId} ${details.queued ? "queued" : "started"} (POST ${postMs.toFixed(0)} ms) in ${dir}`);

  // Poll until the record settles. "First progress" is read off the record's
  // own clocks (progressAt[0], else the first lastActivityAt past startedAt)
  // so the 3 s poll does not quantise it; the first-seen poll is kept too.
  let run = run0;
  let firstProgressSeenMs = null;
  let firstTurnSeenMs = null;
  let timedOut = false;
  let deadline = t0 + DEADLINE_MS;
  let pollErrors = 0;
  while (true) {
    await sleep(POLL_MS);
    let g;
    try {
      g = await client.http(`/setup-api/coding-agent/runs?id=${encodeURIComponent(runId)}`, { timeoutMs: 30_000 });
    } catch (err) {
      // The transport (the desktop page's DevTools socket) hiccuped, not the
      // run: keep polling a few times before giving the run up.
      pollErrors++;
      details.pollErrors = pollErrors;
      log(`poll failed (${pollErrors}): ${String(err?.message || err).split("\n")[0]}`);
      if (pollErrors >= 5) { details.abandoned = "polling failed five times; the run is left to finish on its own"; break; }
      continue;
    }
    details.polls++;
    details.pollMs.push(Math.round(g.ms));
    const now = Date.now();
    const cur = readRun(g);
    if (cur) {
      run = cur;
      // A queued run has not started: its clock (and the deadline) begins
      // when the box takes it, and the host window with it.
      if (cur.status === "queued") { deadline = now + DEADLINE_MS; before = host.snapshot(); }
      const signs = (cur.progress?.length ?? 0) > 0 || (cur.thinkingTokens ?? 0) > 0 || (cur.tokensUsed ?? 0) > 0 || (cur.filesTouched?.length ?? 0) > 0;
      if (firstProgressSeenMs === null && signs) { firstProgressSeenMs = now - t0; log(`first sign of life after ${(firstProgressSeenMs / 1000).toFixed(1)} s (${cur.progress?.length ?? 0} progress lines)`); }
      if (firstTurnSeenMs === null && (cur.numTurns ?? 0) > 0) firstTurnSeenMs = now - t0;
      if (TERMINAL.has(cur.status)) break;
      if (cur.status === "paused") {
        // Waiting on a meter the bench cannot refill: stop it and score the wait.
        log(`run paused (${cur.pauseReason?.meter ?? "?"}); stopping`);
        details.pausedReason = cur.pauseReason ?? null;
        details.stoppedByBench = true;
        run = (await stopRun(client, runId, log)) ?? cur;
        break;
      }
    } else if (g.status === 404) {
      log(`run ${runId} vanished from the run list`);
      break;
    }
    if (now > deadline) {
      timedOut = true;
      details.stoppedByBench = true;
      log(`deadline: stopping ${runId}`);
      run = (await stopRun(client, runId, log)) ?? run;
      break;
    }
  }
  const after = host.snapshot();
  const wallMs = (typeof run?.completedAt === "number" && typeof run?.startedAt === "number" && run.completedAt > run.startedAt)
    ? run.completedAt - run.startedAt
    : Date.now() - t0;
  details.finalStatus = run?.status ?? null;
  details.timedOut = timedOut;

  // What the run left on disk.
  let fileOk = false;
  let fileContent = null;
  try {
    fileContent = fs.readFileSync(path.join(dir, "hello.txt"), "utf8");
    fileOk = fileContent.replace(/\r?\n$/, "") === line;
  } catch { /* no file */ }
  let extraFiles = [];
  // favicon.png/.ico are the BOX's (src/lib/project-icon.ts draws them into
  // every new run folder a few seconds after the start), not the run's.
  try { extraFiles = fs.readdirSync(dir).filter((f) => !["hello.txt", ".clawbox", ".claude", "favicon.png", "favicon.ico"].includes(f)); } catch { /* gone */ }
  details.fileFound = fileContent !== null;
  details.fileExact = fileOk;
  details.extraFiles = extraFiles;
  const success = run?.status === "completed" && fileOk ? 1 : 0;

  // What the run left running (a server it was told to leave up — none, for
  // this task), ended so the box is as it was.
  if (run?.leftover) {
    const k = await client.http("/setup-api/coding-agent/kill", { method: "POST", body: { runId }, timeoutMs: 30_000 });
    details.killedLeftover = k.status;
  }
  cleanup();

  // First progress off the record's own clocks when it has them.
  const startedAt = typeof run?.startedAt === "number" ? run.startedAt : t0;
  let firstProgressMs = null;
  if (Array.isArray(run?.progressAt) && typeof run.progressAt[0] === "number" && run.progressAt[0] >= startedAt) firstProgressMs = run.progressAt[0] - startedAt;
  else if (firstProgressSeenMs !== null) firstProgressMs = firstProgressSeenMs;
  else if (typeof run?.lastActivityAt === "number" && run.lastActivityAt > startedAt) firstProgressMs = run.lastActivityAt - startedAt;
  else firstProgressMs = wallMs;

  const hd = host.delta(before, after);
  const minutes = Math.max(hd.seconds, 1) / 60;
  const webWriteMbPerMin = hd.web?.writeBytesPerSec != null ? (hd.web.writeBytesPerSec * hd.seconds) / 1048576 / minutes : null;
  let runsJsonKb = null;
  try { runsJsonKb = fs.statSync(path.join(repoRoot, "data", "coding-agent-runs.json")).size / 1024; } catch { /* elsewhere */ }

  const tb = run?.tokenBreakdown && typeof run.tokenBreakdown === "object" ? run.tokenBreakdown : null;
  log(`${run?.status ?? "?"} in ${(wallMs / 1000).toFixed(1)} s, ${run?.numTurns ?? "?"} turns, tokens in ${tb?.input ?? "?"} / out ${tb?.output ?? "?"} (cache read ${tb?.cacheRead ?? "?"}), file ${fileOk ? "exact" : fileContent === null ? "missing" : "wrong"}; web wrote ${webWriteMbPerMin === null ? "?" : webWriteMbPerMin.toFixed(1)} MB/min at ${hd.web?.cpuPct ?? "?"}% CPU`);

  const metrics = {
    success: { value: success, unit: "", dir: "higher", good: 1, bad: 0, weight: 3, label: "the run completed and hello.txt holds exactly the line" },
    wall_ms: { value: wallMs, unit: "ms", dir: "lower", good: 60_000, bad: 600_000, label: "start to settle" },
    first_progress_ms: { value: firstProgressMs, unit: "ms", dir: "lower", good: 5_000, bad: 60_000, label: "start to the first progress line / sign of life" },
    start_post_ms: { value: postMs, unit: "ms", dir: "lower", good: 300, bad: 5_000, label: "POST run answering 202" },
    turns: { value: typeof run?.numTurns === "number" ? run.numTurns : null, unit: "", dir: "lower", label: "turns the record reports (not scored)" },
    tokens_in: { value: tb ? tb.input : null, unit: "", dir: "lower", label: "fresh input tokens (not scored)" },
    tokens_out: { value: tb ? tb.output : null, unit: "", dir: "lower", label: "output tokens (not scored)" },
    tokens_cache_read: { value: tb ? tb.cacheRead : null, unit: "", dir: "lower", label: "cached prefix read back (not scored)" },
    web_write_mb_per_min: { value: webWriteMbPerMin, unit: "MB/min", dir: "lower", good: 2, bad: 60, label: "web server bytes written while the run was alive (runs.json churn)" },
    web_cpu_pct: { value: hd.web?.cpuPct ?? null, unit: "%", dir: "lower", good: 5, bad: 50, label: "web server CPU while the run was alive" },
    runs_json_kb: { value: runsJsonKb, unit: "KB", dir: "lower", label: "size of data/coding-agent-runs.json afterwards (not scored)" },
  };
  if (firstTurnSeenMs !== null) metrics.first_turn_seen_ms = { value: firstTurnSeenMs, unit: "ms", dir: "lower", label: "first poll with numTurns > 0 (not scored)" };
  return { metrics, details: { ...details, wallMs, hostDelta: hd, summary: typeof run?.summary === "string" ? run.summary.slice(0, 300) : null, error: run?.error ?? null } };
}
