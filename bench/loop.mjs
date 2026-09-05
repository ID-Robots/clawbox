#!/usr/bin/env node
// The bench's MAIN LOOP: run the suite's demo tasks as coding PROJECTS on
// the box (folders under the owner's project folder, so each shows up in
// the Coding Agent app like any other project), sample every run while it
// works, and write the figures the harness is tuned by — token spend,
// parallelisation, time to finish, cost per task — as one report per cycle,
// with the change against the cycle before. Repeat with --cycles.
//
//   node bench/loop.mjs --dry-run                      what would run
//   node bench/loop.mjs --tasks s-01-single-edit        one task, one cycle
//   node bench/loop.mjs --nightly --cycles 3 --pause 60 the loop
//   node bench/loop.mjs --baseline nightly-c1 --nightly compare against a cycle
//
// Spends real tokens and real wall-clock; never part of `test:*`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enable, codingStatus, startRun, stopRun, getRun, waitForCommit, baseUrl } from "./lib/box.mjs";
import { captureRun } from "./lib/capture.mjs";
import { costOfUsage, formatUsd, loadPricing } from "./lib/cost.mjs";
import { deltaByTask, formatMs, formatTokens, hints, parallelism, summarizeCycle, taskFigures } from "./lib/metrics.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(BENCH_DIR, "tasks");
const RESULTS_DIR = path.join(BENCH_DIR, "results");
const PRICING = path.join(BENCH_DIR, "pricing.json");
/** How often a live run is sampled for its parallelism and spend. */
const SAMPLE_MS = 5_000;

function parseArgs(argv) {
  const args = { cycles: 1, pause: 0, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--tasks") args.tasks = next().split(",").map((s) => s.trim());
    else if (a === "--tier") args.tiers = next().split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--nightly") args.nightly = true;
    else if (a === "--cycles") args.cycles = Math.max(1, Number(next()) || 1);
    else if (a === "--pause") args.pause = Math.max(0, Number(next()) || 0);
    else if (a === "--repeat") args.repeat = Math.max(1, Number(next()) || 1);
    else if (a === "--label") args.label = next();
    else if (a === "--baseline") args.baseline = next();
    else if (a === "--workroot") args.workroot = next();
    else if (a === "--effort") args.effort = next();
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
  return { ...meta, dir, brief, seedDir: fs.existsSync(path.join(dir, "seed")) ? path.join(dir, "seed") : null };
}

/**
 * The task's folder IS the project: `<projects>/bench-<task>-<stamp>`, directly
 * under the owner's project folder, which is what the app lists. A task's
 * "outside" files (the refusal probe's `../shared-config/…`) land beside it.
 */
function seedProject(task, projectsRoot, stamp) {
  const workdir = path.join(projectsRoot, `bench-${task.id}-${stamp}`);
  fs.mkdirSync(workdir, { recursive: true });
  if (task.seedDir) fs.cpSync(task.seedDir, workdir, { recursive: true });
  for (const [rel, content] of Object.entries(task.outside ?? {})) {
    const dest = path.resolve(workdir, "..", rel);
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

/** Wait for a run, sampling it on the way: the samples are the parallelism record. */
async function sampleUntilSettled(runId, deadline, samples) {
  let run = null;
  let lastLine = "";
  for (;;) {
    const res = await getRun(runId, 0);
    if (!res.ok) throw new Error(`run read failed: ${res.status}`);
    run = res.json.run ?? res.json;
    samples.push({
      t: Date.now(),
      status: run.status,
      tokensUsed: run.tokensUsed ?? 0,
      thinkingTokens: run.thinkingTokens ?? 0,
      numTurns: run.numTurns ?? 0,
      subagentsActive: run.subagentsActive ?? 0,
      subagentsTotal: run.subagentsTotal ?? 0,
      filesTouched: (run.filesTouched ?? []).length,
    });
    const line = (run.progress ?? []).at(-1) ?? "";
    if (line && line !== lastLine) { console.log(`  · ${line.slice(0, 110)}`); lastLine = line; }
    if (run.status !== "running" || Date.now() >= deadline) return run;
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
}

function readFigures(suiteVersion, label) {
  const file = path.join(RESULTS_DIR, suiteVersion, `loop-${label}.jsonl`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function pct(d) {
  if (!d || d.pct === null || d.pct === undefined) return "";
  return `${d.pct > 0 ? "+" : ""}${d.pct}%`;
}

function writeReport({ suiteVersion, label, figures, summary, deltas, baseline, pricing }) {
  const lines = [];
  lines.push(`# Bench loop — ${label}`, "");
  lines.push(`Suite v${suiteVersion} · ${summary.runs} run(s) · ${summary.completed} completed (${Math.round(summary.successRate * 100)}%) · mean score ${summary.meanScore ?? "n/a"}`);
  lines.push(`Wall ${formatMs(summary.wallMs)} · tokens ${formatTokens(summary.tokensUsed)} · cost ${formatUsd(summary.costUsd)} (${pricing.currency}) · peak agents beside the run ${summary.peakActive} · agent-seconds per wall-second ${summary.meanAgentSecondsPerWallSecond ?? "n/a"}`);
  if (summary.unpriced.length) lines.push(`Unpriced models (set them in bench/pricing.json): ${summary.unpriced.join(", ")}`);
  lines.push("", "| task | outcome | score | time | turns | tokens | thinking | cost | helpers | peak | agent-s/wall-s | denials |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of figures) {
    const helpers = Object.entries(r.subagentsByType).map(([k, n]) => `${n}× ${k}`).join(", ") || "0";
    lines.push(`| ${r.task} | ${r.outcome} | ${r.score ?? "n/a"} | ${formatMs(r.wallMs)} | ${r.numTurns} | ${formatTokens(r.tokensUsed)} | ${formatTokens(r.thinkingTokens)} | ${formatUsd(r.costUsd)} | ${helpers} | ${r.parallel.peakActive} | ${r.parallel.agentSecondsPerWallSecond} | ${r.permissionDenials} |`);
  }
  if (deltas) {
    lines.push("", `## Against ${baseline}`, "", "| task | outcome | score | time | tokens | cost | peak agents | agent-s/wall-s |", "|---|---|---|---|---|---|---|---|");
    for (const d of deltas) {
      if (d.fresh) { lines.push(`| ${d.task} | new | | | | | | |`); continue; }
      lines.push(`| ${d.task} | ${d.outcome.before} → ${d.outcome.after} | ${pct(d.score)} | ${pct(d.wallMs)} | ${pct(d.tokensUsed)} | ${pct(d.costUsd)} | ${pct(d.peakActive)} | ${pct(d.agentSecondsPerWallSecond)} |`);
    }
  }
  const h = hints(figures);
  if (h.length) { lines.push("", "## Look at", ""); for (const x of h) lines.push(`- ${x}`); }
  lines.push("", "Cost is priced from bench/pricing.json over the per-model usage in each run's transcript (the main loop on the tier model, the helpers on flash); parallelism from a sample of the run every 5 s. A failing run is a finding, not a retry.");
  const file = path.join(RESULTS_DIR, suiteVersion, `report-${label}.md`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

async function runCycle({ args, suite, tasks, label, projectsRoot, pricing }) {
  const figures = [];
  const plan = tasks.flatMap((t) => Array.from({ length: args.repeat }, (_, i) => ({ task: t, rep: i + 1 })));
  for (const { task, rep } of plan) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const workdir = seedProject(task, projectsRoot, stamp);
    console.log(`\n▶ ${task.id} rep ${rep} as project ${path.basename(workdir)}`);
    const started = await startRun({ task: task.brief, directory: workdir });
    if (started.status !== 202 || !started.json?.run) {
      console.error(`  run refused: ${started.status} ${started.text.slice(0, 300)}`);
      figures.push({ cycle: label, task: task.id, tier: task.tier, runId: null, outcome: "not-started", score: null, wallMs: null, numTurns: 0, tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, permissionDenials: 0, subagentsTotal: 0, subagentsByType: {}, modelsUsed: [], costUsd: null, costByModel: {}, unpricedModels: [], parallel: parallelism([], 0) });
      if (started.status === 409 && started.json?.kind === "busy") { console.error("  a run is already in progress — one at a time; stopping this cycle."); break; }
      continue;
    }
    const runId = started.json.run.id;
    console.log(`  run ${runId} started (effort ${started.json.run.effort}, maxTurns ${started.json.run.maxTurns})`);
    let run = started.json.run;
    let outcome;
    let settled = { run: null, commitLagMs: null };
    const samples = [];
    try {
      run = await sampleUntilSettled(runId, Date.now() + task.timeoutMinutes * 60_000, samples);
      outcome = run.status;
      if (run.status === "running") {
        outcome = "timeout";
        console.error(`  TIMEOUT after ${task.timeoutMinutes}min — stopping ${runId}`);
        await stopRun(runId);
        run = await sampleUntilSettled(runId, Date.now() + 30_000, samples);
      }
      settled = await waitForCommit(runId);
      if (settled.run) run = settled.run;
    } catch (err) {
      outcome = "transport-failure";
      console.error(`  polling failed after start: ${String(err).slice(0, 200)}`);
    }
    const score = await scoreTask(task, workdir, run);
    const wallMs = (run.completedAt ?? Date.now()) - run.startedAt;
    const { runDir, line } = captureRun({ run, task, workdir, resultsRoot: RESULTS_DIR, suiteVersion: suite.suiteVersion, score, outcome, wallMs, commitLagMs: settled.commitLagMs, label });
    fs.writeFileSync(path.join(runDir, "samples.json"), JSON.stringify(samples, null, 2));
    const cost = costOfUsage(line.usageByModel, pricing);
    const parallel = parallelism(samples, wallMs);
    const fig = taskFigures({ line, cost, parallel, cycle: label });
    figures.push(fig);
    fs.appendFileSync(path.join(RESULTS_DIR, suite.suiteVersion, `loop-${label}.jsonl`), JSON.stringify(fig) + "\n");
    console.log(`  ${outcome} in ${formatMs(wallMs)} — score ${score ? `${score.score}/100` : "n/a"}, ${formatTokens(line.tokensUsed)} tok, ${formatUsd(cost.totalUsd)}, peak ${parallel.peakActive} helper(s), agent-s/wall-s ${parallel.agentSecondsPerWallSecond}`);
    if (cost.unpriced.length) console.log(`  unpriced: ${cost.unpriced.join(", ")} — set bench/pricing.json`);
  }
  return figures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log("see the header of this file for usage"); return; }
  const suite = loadSuite();
  let ids = args.tasks ?? suite.tasks;
  const unknown = ids.filter((id) => !fs.existsSync(path.join(TASKS_DIR, id)));
  if (unknown.length) { console.error(`unknown tasks: ${unknown.join(", ")}`); process.exit(2); }
  let tasks = ids.map(loadTask).filter((t) => !t.manual);
  if (args.tiers) tasks = tasks.filter((t) => args.tiers.includes(t.tier));
  if (args.nightly) tasks = tasks.filter((t) => t.nightly);
  const pricing = loadPricing(PRICING);
  const baseLabel = args.label ?? (args.nightly ? "nightly" : "loop");
  console.log(`suite v${suite.suiteVersion} → ${tasks.length} task(s) × ${args.repeat} × ${args.cycles} cycle(s) on ${baseUrl()}`);
  for (const t of tasks) console.log(`  ${t.id} (${t.tier}) — ≤${t.timeoutMinutes}min`);
  if (args.dryRun) return;

  // The projects root: the box's own, so the demo tasks are projects the
  // owner sees; only when asked is the folder switched (and then the owner's
  // projects vanish from the app for the session — say so).
  const status = await codingStatus();
  if (!status.ok) { console.error(`status failed: ${status.status}`); process.exit(1); }
  const projectsRoot = args.workroot ?? status.json.defaultDirectory;
  if (!projectsRoot) { console.error("no project folder is set on this box and --workroot was not given"); process.exit(1); }
  const settings = { enabled: true };
  if (args.workroot && args.workroot !== status.json.defaultDirectory) {
    console.log(`switching the project folder to ${args.workroot} for this session — the app lists only what is under it meanwhile`);
    settings.defaultDirectory = args.workroot;
  }
  if (args.effort) settings.effort = args.effort;
  const enabled = await enable(settings);
  if (!enabled.ok) { console.error(`enable failed: ${enabled.status} ${enabled.text.slice(0, 300)}`); process.exit(1); }
  if (!enabled.json.ready) { console.error(`harness not ready: ${JSON.stringify(enabled.json.readiness?.problems ?? [])}`); process.exit(1); }
  fs.mkdirSync(path.join(RESULTS_DIR, suite.suiteVersion), { recursive: true });

  let previous = args.baseline ? readFigures(suite.suiteVersion, args.baseline) : null;
  let previousLabel = args.baseline ?? null;
  if (args.baseline && !previous) console.error(`no figures for baseline ${args.baseline}; comparing from the first cycle on`);
  let anyFailed = false;
  for (let c = 1; c <= args.cycles; c++) {
    const label = `${baseLabel}-c${c}-${new Date().toISOString().slice(0, 10)}`;
    console.log(`\n== cycle ${c}/${args.cycles}: ${label} ==`);
    const figures = await runCycle({ args, suite, tasks, label, projectsRoot, pricing });
    const summary = summarizeCycle(figures);
    const deltas = previous ? deltaByTask(previous, figures) : null;
    const report = writeReport({ suiteVersion: suite.suiteVersion, label, figures, summary, deltas, baseline: previousLabel, pricing });
    console.log(`\n== ${label}: ${summary.completed}/${summary.runs} completed, mean score ${summary.meanScore ?? "n/a"}, ${formatMs(summary.wallMs)}, ${formatTokens(summary.tokensUsed)} tok, ${formatUsd(summary.costUsd)} → ${path.relative(BENCH_DIR, report)}`);
    for (const h of hints(figures)) console.log(`  → ${h}`);
    if (figures.some((f) => f.outcome !== "completed")) anyFailed = true;
    previous = figures;
    previousLabel = label;
    if (c < args.cycles && args.pause > 0) {
      console.log(`pausing ${args.pause}s before the next cycle`);
      await new Promise((r) => setTimeout(r, args.pause * 1000));
    }
  }
  process.exitCode = anyFailed ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exit(1); });
