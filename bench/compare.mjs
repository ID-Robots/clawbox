#!/usr/bin/env node
// Read bench/results/<suite>/index.jsonl and print the comparison tables the
// design doc asked for: per-task outcome/score/cost, cost per delivered file
// and per point of score, the orchestrator-vs-sub-agent token split, and the
// flake rate over repeats. With --baseline, diff two result sets.
//
//   node bench/compare.mjs                              # latest suite version
//   node bench/compare.mjs --suite 1 --label effort-low
//   node bench/compare.mjs --baseline bench/results/1/index.jsonl
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {} from "./lib/transcript.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(BENCH_DIR, "results");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") args.suite = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--json") args.json = true;
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  return args;
}

function readIndex(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function latestSuite() {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const suites = fs.readdirSync(RESULTS_DIR).filter((d) => fs.existsSync(path.join(RESULTS_DIR, d, "index.jsonl")));
  // Numeric where possible: suite "10" is newer than suite "9".
  return suites.sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b)).at(-1) ?? null;
}

const fmt = {
  secs: (ms) => (ms == null ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`),
  tok: (n) => (n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)),
  num: (v, d = 2) => (v == null ? "—" : v.toFixed(d)),
};

function table(headers, rows) {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (row) => "| " + row.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |";
  console.log(line(headers));
  console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  for (const r of rows) console.log(line(r));
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

function summarizeTask(rows) {
  const done = rows.filter((r) => r.outcome === "completed");
  const scores = rows.map((r) => r.score).filter((s) => s != null);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const score = avg(scores);
  const files = avg(rows.map((r) => r.filesTouched));
  return {
    runs: rows.length,
    completed: done.length,
    flakeRate: rows.length > 1 ? 1 - done.length / rows.length : null,
    score,
    wallMs: avg(rows.map((r) => r.wallMs).filter((w) => w != null)),
    tokens: avg(rows.map((r) => r.tokensUsed)),
    retries: rows.reduce((s, r) => s + (r.retries ?? 0), 0),
    denials: rows.reduce((s, r) => s + (r.permissionDenials ?? 0), 0),
    subagents: avg(rows.map((r) => r.subagentsTotal)),
  };
}

function printSet(rows, title) {
  console.log(`\n## ${title} — ${rows.length} run(s)\n`);
  const byTask = groupBy(rows, (r) => r.task);
  table(
    ["task", "runs", "ok", "flake", "score", "wall", "tokens", "sub-ag", "retries", "denials"],
    [...byTask.entries()].map(([task, list]) => {
      const s = summarizeTask(list);
      return [
        task, s.runs, s.completed,
        s.flakeRate == null ? "—" : `${Math.round(s.flakeRate * 100)}%`,
        fmt.num(s.score, 0), fmt.secs(s.wallMs), fmt.tok(s.tokens),
        fmt.num(s.subagents, 1), s.retries, s.denials,
      ];
    }),
  );

  // Orchestrator vs sub-agent: the shipped sub-agents all run on flash while
  // the main loop runs on the tier model, so the per-model transcript sums
  // ARE the split.
  const models = new Map();
  for (const r of rows) {
    for (const [model, u] of Object.entries(r.usageByModel ?? {})) {
      const slot = models.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
      for (const k of Object.keys(slot)) slot[k] += u[k] ?? 0;
      models.set(model, slot);
    }
  }
  if (models.size > 0) {
    console.log("\n### Token split by model (from transcripts)\n");
    table(
      ["model", "msgs", "input", "output", "cache-r", "cache-w"],
      [...models.entries()].map(([model, u]) => [
        model, u.messages, fmt.tok(u.input), fmt.tok(u.output), fmt.tok(u.cacheRead), fmt.tok(u.cacheWrite),
      ]),
    );
  }

  const failures = rows.filter((r) => r.outcome !== "completed");
  if (failures.length) {
    console.log("\n### Non-completed runs — findings, per the triage rule\n");
    table(
      ["task", "run", "outcome", "status", "retries", "tokens", "error"],
      failures.map((r) => [r.task, r.runId, r.outcome, r.status, r.retries, fmt.tok(r.tokensUsed), (r.error ?? "").slice(0, 60)]),
    );
  }
  const badChecks = rows.filter((r) => (r.checksFailed ?? []).length > 0);
  if (badChecks.length) {
    console.log("\n### Failed scorer checks\n");
    for (const r of badChecks) console.log(`- ${r.task} ${r.runId}: ${r.checksFailed.join("; ")}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const suite = args.suite ?? latestSuite();
  if (!suite) { console.error("no results yet — run bench/runner.mjs first"); process.exit(1); }
  let rows = readIndex(path.join(RESULTS_DIR, suite, "index.jsonl"));
  if (args.label) rows = rows.filter((r) => r.label === args.label);
  if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  printSet(rows, `suite v${suite}${args.label ? ` · label ${args.label}` : ""}`);

  if (args.baseline) {
    const base = readIndex(args.baseline);
    printSet(base, `baseline (${args.baseline})`);
    console.log("\n## Delta vs baseline (task: score)\n");
    const cur = groupBy(rows, (r) => r.task);
    const prev = groupBy(base, (r) => r.task);
    for (const [task, list] of cur) {
      const a = summarizeTask(list);
      const b = prev.has(task) ? summarizeTask(prev.get(task)) : null;
      if (!b) { console.log(`- ${task}: new task, no baseline`); continue; }
      const dScore = a.score != null && b.score != null ? a.score - b.score : null;
      console.log(`- ${task}: score ${fmt.num(b.score, 0)} → ${fmt.num(a.score, 0)} (${dScore == null ? "—" : (dScore >= 0 ? "+" : "") + dScore.toFixed(0)})`);
    }
  }
}

main();
