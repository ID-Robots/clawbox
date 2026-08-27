#!/usr/bin/env node
// The coding-agent bench runner. Drives the box's own HTTP API — the same
// routes hand-testing used — through the fixed, versioned task suite in
// bench/tasks/, and captures every run into bench/results/ before anything
// can evict it.
//
//   node bench/runner.mjs                      # every non-manual task, once
//   node bench/runner.mjs --nightly            # only tasks marked nightly
//   node bench/runner.mjs --tasks s-01-single-edit,m-03-failing-tests
//   node bench/runner.mjs --tier S,M --repeat 5 --budget 2.50
//   node bench/runner.mjs --effort low --label effort-low
//   node bench/runner.mjs --dry-run
//
// Costs real money and real wall-clock. NEVER wire this into test:e2e.
//
// Rules carried over from the design doc:
//  - a failing run is a FINDING, not a retry: capture it, move on
//  - the budget is a ceiling on NEW runs, not a kill switch for a running one
//  - one runner at a time: a busy box aborts the suite rather than queueing
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enable, startRun, stopRun, waitForRun, waitForCommit, baseUrl } from "./lib/box.mjs";
import { captureRun } from "./lib/capture.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(BENCH_DIR, "tasks");
const RESULTS_DIR = path.join(BENCH_DIR, "results");

function parseArgs(argv) {
  const args = { repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--tasks") args.tasks = next().split(",").map((s) => s.trim());
    else if (a === "--tier") args.tiers = next().split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--nightly") args.nightly = true;
    else if (a === "--manual") args.manual = true;
    else if (a === "--repeat") args.repeat = Math.max(1, Number(next()) || 1);
    else if (a === "--budget") args.budget = Number(next());
    else if (a === "--effort") args.effort = next();
    else if (a === "--max-turns") args.maxTurns = Number(next());
    else if (a === "--token-limit") args.tokenLimit = Number(next());
    else if (a === "--workroot") args.workroot = next();
    else if (a === "--label") args.label = next();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  return args;
}

function loadSuite() {
  return JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "suite.json"), "utf8"));
}

function loadTask(id) {
  const dir = path.join(TASKS_DIR, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
  const brief = fs.readFileSync(path.join(dir, "brief.md"), "utf8").trim();
  if (brief.length > 4000) throw new Error(`${id}: brief is ${brief.length} chars; the run route caps task at 4000`);
  return { ...meta, dir, brief, seedDir: fs.existsSync(path.join(dir, "seed")) ? path.join(dir, "seed") : null };
}

function seedWorkdir(task, runRoot) {
  const workdir = path.join(runRoot, "work");
  fs.mkdirSync(workdir, { recursive: true });
  if (task.seedDir) fs.cpSync(task.seedDir, workdir, { recursive: true });
  // Files the task plants OUTSIDE the working folder (refusal-path tasks):
  // relative to the run root, i.e. one level above the workdir.
  for (const [rel, content] of Object.entries(task.outside ?? {})) {
    const dest = path.join(runRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return workdir;
}

async function scoreTask(task, workdir, run) {
  const scorePath = path.join(task.dir, "score.mjs");
  if (!fs.existsSync(scorePath)) return null;
  try {
    const mod = await import(pathToFileURL(scorePath).href);
    return await mod.default({ workdir, run });
  } catch (err) {
    return { score: 0, max: 100, checks: [{ name: "scorer crashed", pass: false, detail: String(err).slice(0, 300), weight: 1 }] };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("see the header of this file for usage");
    return;
  }
  const suite = loadSuite();
  let ids = args.tasks ?? suite.tasks;
  const unknown = ids.filter((id) => !fs.existsSync(path.join(TASKS_DIR, id)));
  if (unknown.length) { console.error(`unknown tasks: ${unknown.join(", ")}`); process.exit(2); }
  let tasks = ids.map(loadTask);
  if (args.tiers) tasks = tasks.filter((t) => args.tiers.includes(t.tier));
  if (args.nightly) tasks = tasks.filter((t) => t.nightly);
  if (!args.manual) tasks = tasks.filter((t) => !t.manual);

  const plan = tasks.flatMap((t) => Array.from({ length: args.repeat }, (_, i) => ({ task: t, rep: i + 1 })));
  const expected = tasks.reduce((s, t) => s + (t.expectedCostUsd ?? 0) * args.repeat, 0);
  console.log(`suite v${suite.suiteVersion} → ${plan.length} run(s) on ${baseUrl()}; expected cost ≈ $${expected.toFixed(2)}${args.budget ? `, budget $${args.budget.toFixed(2)}` : ""}`);
  for (const { task, rep } of plan) console.log(`  ${task.id} (${task.tier}${task.manual ? ", MANUAL" : ""}) rep ${rep}/${args.repeat} — ~$${(task.expectedCostUsd ?? 0).toFixed(2)}, ≤${task.timeoutMinutes}min`);
  if (args.dryRun) return;

  // The switch and the run settings are enable-time config, not per-run: the
  // record snapshots them at startRun. Set them once, up front, as the owner.
  const settings = { enabled: true };
  if (args.effort) settings.effort = args.effort;
  if (Number.isFinite(args.maxTurns)) settings.maxTurns = args.maxTurns;
  if (Number.isFinite(args.tokenLimit)) settings.tokenLimit = args.tokenLimit;
  const enabled = await enable(settings);
  if (!enabled.ok) { console.error(`enable failed: ${enabled.status} ${enabled.text.slice(0, 300)}`); process.exit(1); }
  if (!enabled.json.ready) {
    console.error(`harness not ready: ${JSON.stringify(enabled.json.readiness?.problems ?? [])}`);
    process.exit(1);
  }

  const workroot = args.workroot ?? path.join(os.homedir(), "bench-work");
  let spent = 0;
  const summary = [];
  for (const { task, rep } of plan) {
    if (args.budget != null) {
      const projected = spent + (task.expectedCostUsd ?? 0);
      if (projected > args.budget) {
        console.log(`SKIP ${task.id} rep ${rep}: $${spent.toFixed(2)} spent + ~$${(task.expectedCostUsd ?? 0).toFixed(2)} expected exceeds the $${args.budget.toFixed(2)} budget`);
        summary.push({ task: task.id, rep, outcome: "skipped-budget" });
        continue;
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runRoot = path.join(workroot, `${stamp}-${task.id}-r${rep}`);
    const workdir = seedWorkdir(task, runRoot);
    console.log(`\n▶ ${task.id} rep ${rep} in ${workdir}`);

    const started = await startRun({ task: task.brief, directory: workdir });
    if (started.status !== 202 || !started.json?.run) {
      console.error(`  run refused: ${started.status} ${started.text.slice(0, 300)}`);
      summary.push({ task: task.id, rep, outcome: "not-started", detail: `${started.status} ${started.json?.kind ?? ""}` });
      if (started.status === 409 && started.json?.kind === "busy") {
        console.error("  a run is already in progress — one runner at a time; aborting the suite.");
        break;
      }
      continue;
    }
    const runId = started.json.run.id;
    console.log(`  run ${runId} started (effort ${started.json.run.effort}, maxTurns ${started.json.run.maxTurns})`);
    if (task.manual && task.manualProcedure) console.log(`  MANUAL STEP NOW: ${task.manualProcedure}`);

    const deadline = Date.now() + task.timeoutMinutes * 60_000;
    let lastLine = "";
    let run = await waitForRun(runId, deadline, (r) => {
      const line = (r.progress ?? []).at(-1) ?? "";
      if (line && line !== lastLine) { console.log(`  · ${line.slice(0, 110)}`); lastLine = line; }
    });

    let outcome = run.status;
    if (run.status === "running") {
      // Runner timeout: capture-worthy on its own. Stop it so the suite can
      // go on — the record of the stop is part of the finding.
      outcome = "timeout";
      console.error(`  TIMEOUT after ${task.timeoutMinutes}min — stopping ${runId}`);
      await stopRun(runId);
      run = (await waitForRun(runId, Date.now() + 30_000)) ?? run;
    }

    // Commit settles after the record does; wait bounded, measure the lag.
    const settled = await waitForCommit(runId);
    if (settled.run) run = settled.run;

    const score = await scoreTask(task, workdir, run);
    const wallMs = (run.completedAt ?? Date.now()) - run.startedAt;
    const { line } = captureRun({
      run, task, workdir,
      resultsRoot: RESULTS_DIR, suiteVersion: suite.suiteVersion,
      score, outcome, wallMs, commitLagMs: settled.commitLagMs, label: args.label ?? null,
    });
    spent += run.costUsd ?? 0;
    console.log(`  ${outcome} in ${Math.round(wallMs / 1000)}s — score ${score ? `${score.score}/100` : "n/a"}, ${run.costUsd == null ? "cost unreported" : `$${run.costUsd.toFixed(2)}`}, ${run.tokensUsed} tok, ${line.filesTouched} files, ${run.retries} retries`);
    if (score) for (const c of score.checks.filter((x) => !x.pass)) console.log(`    ✗ ${c.name}${c.detail ? ` — ${c.detail.slice(0, 90)}` : ""}`);
    summary.push({ task: task.id, rep, outcome, score: score?.score ?? null, costUsd: run.costUsd ?? null, wallMs });
  }

  console.log(`\n== suite done: $${spent.toFixed(2)} recorded spend ==`);
  for (const s of summary) {
    console.log(`  ${s.task} rep ${s.rep}: ${s.outcome}${s.score != null ? ` score ${s.score}` : ""}${s.costUsd != null ? ` $${s.costUsd.toFixed(2)}` : ""}`);
  }
  const failed = summary.filter((s) => !["completed"].includes(s.outcome));
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exit(1); });
