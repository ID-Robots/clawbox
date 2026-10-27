#!/usr/bin/env node
// The ClawBox bench: one number per area (chat, coding agent, desktop, owner
// API, idle chatter, Memory Shard, Prime Radiant, files, terminal, resources)
// and one overall score, measured on the LIVE box through the Chrome that
// shows its desktop, so an update can be scored before and after.
//
//   node scripts/bench/clawbox-bench.mjs run [--out file] [--scenarios a,b] [--runs n] [--quick]
//   node scripts/bench/clawbox-bench.mjs compare before.json after.json
//   node scripts/bench/clawbox-bench.mjs list
//
// Options: --auth cdp|token (default cdp: the signed-in desktop page on the
//          kiosk's DevTools port; token: the MCP bearer in data/.mcp-token),
//          --cdp-port <n> (default 18801, CLAWBOX_KIOSK_CDP_PORT),
//          --base-url <url> (token mode; default http://localhost:3005),
//          --url-match <text> (which page is the desktop), --out <file>
//          (default data/bench/<timestamp>.json), --runs <n> (median of n),
//          --scenarios <ids> (comma list, default every scenario), --quick
//          (shorter windows, no coding run), --label <text>.
//
// It reads, opens a page of its own and closes it, sends a few throwaway
// chat turns in sessions of its own, writes and deletes a file in a folder of
// its own and starts one tiny coding run. Nothing else on the box changes.
// Read docs/clawbox-bench.md for the areas, the anchors and how to compare.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "./lib/client.mjs";
import { scoreArea, overallScore, compareReports, median } from "./lib/score.mjs";
import * as host from "./lib/host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BENCH_VERSION = 1;

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };

const opts = {
  auth: opt("--auth", "cdp"),
  cdpPort: Number(opt("--cdp-port", process.env.CLAWBOX_KIOSK_CDP_PORT || 18801)),
  baseUrl: opt("--base-url", "http://localhost:3005"),
  urlMatch: opt("--url-match", null),
  out: opt("--out", null),
  runs: Math.max(1, Number(opt("--runs", 1))),
  scenarios: opt("--scenarios", null),
  label: opt("--label", ""),
  quick: flag("--quick"),
  verbose: flag("--verbose"),
  repoRoot: REPO,
};
const command = argv.shift() || "run";

async function loadScenarios() {
  const dir = path.join(HERE, "scenarios");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  const all = [];
  for (const f of files) {
    const mod = await import(path.join(dir, f));
    if (!mod.id || typeof mod.run !== "function") continue;
    all.push({ id: mod.id, title: mod.title ?? mod.id, weight: mod.weight ?? 1, needs: mod.needs ?? [], order: mod.order ?? 50, run: mod.run });
  }
  return all.sort((a, b) => a.order - b.order);
}

function boxInfo(client) {
  const git = (args) => { try { return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", timeout: 5000 }).trim(); } catch { return null; } };
  return {
    hostname: os.hostname(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memMb: Math.round(os.totalmem() / 1048576),
    kernel: os.release(),
    node: process.version,
    clawboxCommit: git(["rev-parse", "--short", "HEAD"]),
    clawboxBranch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    clawboxDescribe: git(["describe", "--tags", "--always"]),
    authMode: client.mode,
  };
}

async function boxFacts(client) {
  const facts = {};
  const bi = await client.http("/setup-api/system/build-identity").catch(() => null);
  if (bi?.json) facts.buildIdentity = bi.json;
  const ha = await client.http("/setup-api/harness/active").catch(() => null);
  if (ha?.json) facts.harness = ha.json;
  const ver = await client.http("/setup-api/update/status").catch(() => null);
  if (ver?.json) facts.updateStatus = { version: ver.json.version ?? ver.json.currentVersion ?? null, branch: ver.json.branch ?? null };
  return facts;
}

function fmt(v, unit) {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "number") return String(v);
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

async function runOnce(scenarios, client, log) {
  const results = {};
  const hostStart = host.snapshot();
  const startedAt = new Date().toISOString();
  for (const sc of scenarios) {
    if (sc.needs.includes("page") && client.mode !== "cdp") {
      results[sc.id] = { title: sc.title, weight: sc.weight, score: null, skipped: "needs the desktop page (--auth cdp)", metrics: {} };
      log(`  ${sc.id}: skipped (needs the desktop page)`);
      continue;
    }
    if (sc.needs.includes("long") && opts.quick) {
      results[sc.id] = { title: sc.title, weight: sc.weight, score: null, skipped: "--quick", metrics: {} };
      log(`  ${sc.id}: skipped (--quick)`);
      continue;
    }
    const t0 = Date.now();
    log(`  ${sc.id}: running…`);
    const before = host.snapshot();
    try {
      const ctx = { client, host, opts, repoRoot: REPO, log: (m) => log(`    ${m}`), hostStart, scratchDir: scratch() };
      const r = await sc.run(ctx);
      const after = host.snapshot();
      const metrics = r?.metrics ?? {};
      const score = r?.skipped ? null : scoreArea(metrics);
      results[sc.id] = { title: sc.title, weight: sc.weight, score, skipped: r?.skipped ?? null, metrics, details: r?.details ?? null, durationMs: Date.now() - t0, host: host.delta(before, after) };
      log(`  ${sc.id}: ${score === null ? `no score (${r?.skipped ?? "no scorable metric"})` : `${score}/100`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      results[sc.id] = { title: sc.title, weight: sc.weight, score: null, error: String(err?.stack || err), metrics: {}, durationMs: Date.now() - t0 };
      log(`  ${sc.id}: ERROR ${String(err?.message || err).split("\n")[0]}`);
    }
  }
  const hostEnd = host.snapshot();
  return { startedAt, finishedAt: new Date().toISOString(), scenarios: results, hostDelta: host.delta(hostStart, hostEnd) };
}

function scratch() {
  const d = path.join(os.tmpdir(), "clawbox-bench");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Median of n runs per metric, with the spread kept as `noise`. */
function mergeRuns(runs) {
  if (runs.length === 1) return { ...runs[0], noise: null };
  const ids = new Set(runs.flatMap((r) => Object.keys(r.scenarios)));
  const scenarios = {};
  for (const id of ids) {
    const entries = runs.map((r) => r.scenarios[id]).filter(Boolean);
    const base = entries.find((e) => e.metrics && Object.keys(e.metrics).length) ?? entries[0];
    const metrics = {};
    for (const name of new Set(entries.flatMap((e) => Object.keys(e.metrics || {})))) {
      const samples = entries.map((e) => e.metrics?.[name]).filter(Boolean);
      const proto = samples[0];
      const values = samples.map((s) => s.value);
      metrics[name] = { ...proto, value: median(values), samples: values };
    }
    const scores = entries.map((e) => e.score).filter((s) => typeof s === "number");
    scenarios[id] = { ...base, metrics, score: scores.length ? median(scores) : null, scoreSamples: scores, details: entries.map((e) => e.details) };
  }
  const spreads = Object.values(scenarios).map((s) => s.scoreSamples?.length > 1 ? Math.max(...s.scoreSamples) - Math.min(...s.scoreSamples) : 0);
  return { startedAt: runs[0].startedAt, finishedAt: runs[runs.length - 1].finishedAt, scenarios, hostDelta: runs[runs.length - 1].hostDelta, noise: Math.round(Math.max(0, ...spreads) * 10) / 10 };
}

function printReport(report) {
  const rows = Object.entries(report.scenarios).map(([id, s]) => [id, s.title, s.score === null ? (s.error ? "ERROR" : `skip: ${s.skipped ?? "no metric"}`) : `${s.score}`, `${((s.durationMs ?? 0) / 1000).toFixed(0)} s`]);
  const w = [Math.max(...rows.map((r) => r[0].length), 8), Math.max(...rows.map((r) => r[1].length), 5)];
  console.log("");
  console.log(`${"area".padEnd(w[0])}  ${"title".padEnd(w[1])}  score   time`);
  for (const r of rows) console.log(`${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${String(r[2]).padStart(5)}   ${r[3]}`);
  console.log(`\nOVERALL ${report.overall ?? "—"}/100${report.noise !== null && report.noise !== undefined ? `  (run-to-run spread ${report.noise})` : ""}`);
  if (opts.verbose) {
    for (const [id, s] of Object.entries(report.scenarios)) {
      if (!Object.keys(s.metrics || {}).length) continue;
      console.log(`\n[${id}]`);
      for (const [n, m] of Object.entries(s.metrics)) console.log(`  ${n.padEnd(28)} ${fmt(m.value, m.unit).padStart(14)}   ${m.label ?? ""}`);
    }
  }
}

function printCompare(cmp, a, b) {
  const mark = (v) => v === "better" ? "▲ better" : v === "worse" ? "▼ worse" : v === "same" ? "= same" : "n/a";
  console.log(`before: ${a.label || a.box?.clawboxCommit || "?"} (${a.startedAt})`);
  console.log(`after:  ${b.label || b.box?.clawboxCommit || "?"} (${b.startedAt})`);
  console.log(`threshold: ±${cmp.threshold} points\n`);
  console.log(`${"area".padEnd(16)} ${"before".padStart(7)} ${"after".padStart(7)} ${"delta".padStart(7)}  verdict`);
  for (const [id, e] of Object.entries(cmp.areas)) {
    console.log(`${id.padEnd(16)} ${String(e.before ?? "—").padStart(7)} ${String(e.after ?? "—").padStart(7)} ${String(e.delta ?? "—").padStart(7)}  ${mark(e.verdict)}`);
  }
  console.log(`${"OVERALL".padEnd(16)} ${String(cmp.overall.before ?? "—").padStart(7)} ${String(cmp.overall.after ?? "—").padStart(7)} ${String(cmp.overall.delta ?? "—").padStart(7)}  ${mark(cmp.overall.verdict)}`);
  const moved = [];
  for (const [id, e] of Object.entries(cmp.areas)) {
    for (const [n, m] of Object.entries(e.metrics)) {
      if (m.pct === null || m.pct === undefined || Math.abs(m.pct) < 10) continue;
      moved.push([id, n, m]);
    }
  }
  if (moved.length) {
    console.log("\nmetrics that moved ≥10%:");
    for (const [id, n, m] of moved) console.log(`  ${(id + "/" + n).padEnd(40)} ${fmt(m.before, m.unit).padStart(14)} → ${fmt(m.after, m.unit).padEnd(14)} ${m.pct > 0 ? "+" : ""}${m.pct}%  ${m.direction}`);
  }
}

async function main() {
  if (command === "list") {
    for (const s of await loadScenarios()) console.log(`${s.id.padEnd(16)} w=${String(s.weight).padStart(2)}  ${s.title}${s.needs.length ? `  [needs: ${s.needs.join(", ")}]` : ""}`);
    return;
  }
  if (command === "compare") {
    const [fa, fb] = argv;
    if (!fa || !fb) throw new Error("compare needs two report files");
    const a = JSON.parse(fs.readFileSync(fa, "utf8")), b = JSON.parse(fs.readFileSync(fb, "utf8"));
    const threshold = Math.max(3, a.noise ?? 0, b.noise ?? 0);
    const cmp = compareReports(a, b, { threshold });
    printCompare(cmp, a, b);
    if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(cmp, null, 2));
    return;
  }
  if (command !== "run") throw new Error(`unknown command ${command}`);

  let scenarios = await loadScenarios();
  if (opts.scenarios) {
    const want = opts.scenarios.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = want.filter((w) => !scenarios.some((s) => s.id === w));
    if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(", ")}`);
    scenarios = scenarios.filter((s) => want.includes(s.id));
  }
  const log = (m) => console.log(m);
  const client = await createClient(opts);
  try {
    const box = boxInfo(client);
    const facts = await boxFacts(client);
    log(`ClawBox bench v${BENCH_VERSION} — ${box.hostname} (${box.arch}, ${box.cpus} cores, ${box.memMb} MB) — commit ${box.clawboxCommit} on ${box.clawboxBranch} — auth ${client.mode}`);
    const runs = [];
    for (let i = 0; i < opts.runs; i++) {
      if (opts.runs > 1) log(`run ${i + 1}/${opts.runs}`);
      runs.push(await runOnce(scenarios, client, log));
    }
    const merged = mergeRuns(runs);
    const areas = Object.fromEntries(Object.entries(merged.scenarios).map(([id, s]) => [id, { score: s.score, weight: s.weight }]));
    const report = { benchVersion: BENCH_VERSION, label: opts.label, quick: opts.quick, runs: opts.runs, box, facts, ...merged, overall: overallScore(areas) };
    const out = opts.out ?? path.join(REPO, "data", "bench", `bench-${report.startedAt.replace(/[:.]/g, "-")}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    printReport(report);
    console.log(`\nsaved ${out}`);
  } finally {
    client.close();
  }
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
