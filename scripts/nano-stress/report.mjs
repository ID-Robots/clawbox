#!/usr/bin/env node
// Turns the raw records of a stress run (scripts/nano-stress/board-stress.mjs)
// into the per-step numbers and a short markdown summary (TASK-2500).
//
//   node scripts/nano-stress/report.mjs --json out.json --md out.md raw-a.json [raw-b.json ...]
//
// One raw file per runtime; several are summarised side by side. The JSON is
// { version, runs: [report, ...] }; the markdown is a table per runtime plus
// the findings (errors, OOM kills, restarts, low memory) under it.
//
// Latency counts every turn that got an answer, right or wrong; a turn that
// timed out or lost its connection has no latency and counts as an error.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const REPORT_VERSION = 1;
/** MemAvailable below this during a step is called out as a finding. */
export const LOW_MEM_MB = 400;

/** Nearest-rank percentile of the finite numbers in `values`; null when none. */
export function percentile(values, p) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length, Math.max(1, rank)) - 1];
}

const finite = (xs) => xs.filter((v) => typeof v === "number" && Number.isFinite(v));
const maxOf = (xs) => { const f = finite(xs); return f.length ? Math.max(...f) : null; };
const minOf = (xs) => { const f = finite(xs); return f.length ? Math.min(...f) : null; };
const meanOf = (xs) => { const f = finite(xs); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null; };
const mb = (kb) => (typeof kb === "number" && Number.isFinite(kb) ? Math.round(kb / 1024) : null);
const round1 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** The samples taken while a step ran, plus the last one before it (its start). */
export function samplesFor(samples, startedAt, endedAt) {
  const inside = samples.filter((s) => s.t >= startedAt && s.t <= endedAt);
  const before = samples.filter((s) => s.t < startedAt).at(-1);
  const after = samples.find((s) => s.t > endedAt);
  return { inside, start: before ?? inside[0] ?? null, end: inside.at(-1) ?? after ?? null };
}

/** Error kinds that mean no answer came back at all: no latency to count. */
const NO_ANSWER = new Set(["timeout", "connection", "rpc", "http"]);
const answeredTurn = (t) => !t.error || !NO_ANSWER.has(t.error.kind);

function latencyStats(turns) {
  const answered = turns.filter(answeredTurn);
  const lat = answered.map((t) => t.latencyMs);
  const ft = answered.map((t) => t.firstTokenMs);
  return {
    p50: percentile(lat, 50), p95: percentile(lat, 95), max: maxOf(lat), min: minOf(lat),
    mean: meanOf(lat) === null ? null : Math.round(meanOf(lat)),
    firstTokenP50: percentile(ft, 50), firstTokenP95: percentile(ft, 95),
  };
}

function unitDelta(before, after) {
  const out = {};
  for (const role of Object.keys({ ...(before || {}), ...(after || {}) })) {
    const b = before?.[role] || {}, a = after?.[role] || {};
    out[role] = {
      unit: a.unit || b.unit || null,
      restarts: typeof a.restarts === "number" && typeof b.restarts === "number" ? a.restarts - b.restarts : null,
      pidChanged: Boolean(b.mainPid && a.mainPid && b.mainPid !== a.mainPid),
      activeAfter: a.active ?? null,
    };
  }
  return out;
}

/** One step's numbers. */
export function summarizeStep(step, raw) {
  const turns = raw.turns.filter((t) => t.step === step.id);
  const failed = turns.filter((t) => !t.ok);
  const errorKinds = {};
  const messages = [];
  for (const t of failed) {
    const k = t.error?.kind || "unknown";
    errorKinds[k] = (errorKinds[k] || 0) + 1;
    const line = `${k}: ${t.error?.message || ""}`.trim();
    if (!messages.includes(line) && messages.length < 5) messages.push(line);
  }
  const { inside, start, end } = samplesFor(raw.samples || [], step.startedAt, step.endedAt);
  const all = start && !inside.includes(start) ? [start, ...inside] : inside;
  const wallS = (step.endedAt - step.startedAt) / 1000;
  const out = {
    id: step.id,
    kind: step.kind,
    concurrency: step.concurrency,
    wallS: round1(wallS),
    turns: { total: turns.length, ok: turns.length - failed.length, failed: failed.length },
    turnsPerMin: turns.length && wallS > 0 ? round1((turns.length / wallS) * 60) : null,
    latencyMs: latencyStats(turns),
    toolCalls: turns.reduce((n, t) => n + (t.toolCalls || 0), 0),
    errors: { kinds: errorKinds, messages },
    resources: {
      samples: inside.length,
      memAvailableMb: { start: mb(start?.memAvailableKb), min: mb(minOf(all.map((s) => s.memAvailableKb))), end: mb(end?.memAvailableKb) },
      swapUsedMb: { start: mb(start?.swapUsedKb), max: mb(maxOf(all.map((s) => s.swapUsedKb))), end: mb(end?.swapUsedKb) },
      tempC: { start: round1(start?.tempMaxC), max: round1(maxOf(all.map((s) => s.tempMaxC))), end: round1(end?.tempMaxC) },
      cpuBusyPct: { mean: round1(meanOf(inside.map((s) => s.cpuBusyPct))), max: round1(maxOf(inside.map((s) => s.cpuBusyPct))) },
      load1Max: round1(maxOf(all.map((s) => s.load1))),
      gatewayRssMb: { start: mb(start?.gatewayRssKb), max: mb(maxOf(all.map((s) => s.gatewayRssKb))), end: mb(end?.gatewayRssKb) },
      gatewayCgroupMbMax: mb(maxOf(all.map((s) => s.gatewayCgroupKb))),
      gatewayProcsMax: maxOf(all.map((s) => s.gatewayProcs)),
      webRssMb: { start: mb(start?.webRssKb), max: mb(maxOf(all.map((s) => s.webRssKb))), end: mb(end?.webRssKb) },
    },
    units: unitDelta(step.unitsBefore, step.unitsAfter),
    slowChatSends: step.slowChatSends ?? null,
    oomKills: typeof step.oomKillsAfter === "number" && typeof step.oomKillsBefore === "number" ? step.oomKillsAfter - step.oomKillsBefore : null,
    healthyAfter: step.healthyAfter ?? null,
    ...(step.failure ? { failure: step.failure } : {}),
  };
  if (step.kind === "long") {
    const chat = turns.filter((t) => t.kind === "chat" && answeredTurn(t));
    const recall = turns.filter((t) => t.kind === "recall");
    out.long = {
      firstFiveP50Ms: percentile(chat.slice(0, 5).map((t) => t.latencyMs), 50),
      lastFiveP50Ms: percentile(chat.slice(-5).map((t) => t.latencyMs), 50),
      recall: { asked: recall.length, ok: recall.filter((t) => t.ok).length },
    };
  }
  if (step.kind === "tool") {
    out.tool = { turnsWithToolCalls: turns.filter((t) => (t.toolCalls || 0) > 0).length };
  }
  return out;
}

/** The findings worth a line: anything that failed, died or ran out. */
export function findingsOf(report) {
  const f = [];
  for (const s of report.steps) {
    if (s.turns.failed) f.push(`${s.id}: ${s.turns.failed}/${s.turns.total} turns failed (${Object.entries(s.errors.kinds).map(([k, n]) => `${k} ${n}`).join(", ")})`);
    if (s.oomKills) f.push(`${s.id}: ${s.oomKills} OOM kill(s)`);
    for (const [role, u] of Object.entries(s.units)) {
      if (u.restarts) f.push(`${s.id}: ${u.unit || role} restarted ${u.restarts} time(s)`);
      else if (u.pidChanged) f.push(`${s.id}: ${u.unit || role} has a new main process`);
    }
    if (s.healthyAfter === false) f.push(`${s.id}: ${report.runtime} not healthy within 120 s after the step`);
    const low = s.resources.memAvailableMb.min;
    if (typeof low === "number" && low < LOW_MEM_MB) f.push(`${s.id}: MemAvailable fell to ${low} MB`);
    if (s.failure) f.push(`${s.id}: step stopped early: ${s.failure}`);
    if (s.long && s.long.recall.ok < s.long.recall.asked) f.push(`${s.id}: recalled the code word ${s.long.recall.ok}/${s.long.recall.asked} times`);
  }
  return f;
}

/** The whole run. */
export function summarizeRaw(raw) {
  if (!raw || raw.tool !== "clawbox-nano-stress") throw new Error("not a clawbox-nano-stress record");
  const steps = (raw.steps || []).map((s) => summarizeStep(s, raw));
  const answered = raw.turns || [];
  const report = {
    version: REPORT_VERSION,
    runId: raw.runId,
    complete: raw.final === true,
    runtime: raw.runtime,
    units: raw.units,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    board: raw.board,
    models: [...new Set(answered.map((t) => t.model).filter((m) => typeof m === "string" && m))],
    config: raw.config,
    totals: {
      turns: answered.length,
      ok: answered.filter((t) => t.ok).length,
      failed: answered.filter((t) => !t.ok).length,
      latencyMs: latencyStats(answered),
      oomKills: steps.reduce((n, s) => n + (s.oomKills || 0), 0),
      restarts: steps.reduce((n, s) => n + Object.values(s.units).reduce((m, u) => m + (u.restarts || 0), 0), 0),
      memAvailableMinMb: minOf(steps.map((s) => s.resources.memAvailableMb.min)),
      swapUsedMaxMb: maxOf(steps.map((s) => s.resources.swapUsedMb.max)),
      tempMaxC: maxOf(steps.map((s) => s.resources.tempC.max)),
      gatewayRssMaxMb: maxOf(steps.map((s) => s.resources.gatewayRssMb.max)),
    },
    steps,
  };
  report.findings = findingsOf(report);
  return report;
}

const sec = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "–");
const val = (v) => (v === null || v === undefined ? "–" : String(v));

/** Markdown for one or more reports. */
export function renderMarkdown(reports) {
  const out = ["# ClawBox stress run", ""];
  for (const r of reports) {
    const b = r.board || {};
    out.push(`## ${r.runtime === "hermes" ? "Hermes" : "OpenClaw"}${r.complete ? "" : " (incomplete)"}`, "");
    out.push(`- Board: ${val(b.model)}, ${val(b.memTotalMb)} MB RAM, ${val(b.swapTotalMb)} MB swap, ${val(b.cpus)} CPUs${b.l4t ? `, ${b.l4t}` : ""}`);
    out.push(`- Build: \`${(b.clawboxSha || "unknown").slice(0, 12)}\`${b.clawboxBranch ? ` (${b.clawboxBranch})` : ""}; runtime unit \`${val(r.units?.gateway)}\``);
    out.push(`- Run: ${r.startedAt} → ${r.endedAt}; turn timeout ${val(r.config?.turnTimeoutS)} s${r.models?.length ? `; model ${r.models.join(", ")}` : ""}`);
    const t = r.totals;
    out.push(`- Turns: ${t.ok}/${t.turns} ok; latency p50 ${sec(t.latencyMs.p50)} s, p95 ${sec(t.latencyMs.p95)} s; OOM kills ${t.oomKills}; unit restarts ${t.restarts}`);
    out.push(`- Lowest MemAvailable ${val(t.memAvailableMinMb)} MB; most swap used ${val(t.swapUsedMaxMb)} MB; hottest zone ${val(t.tempMaxC)} °C; runtime RSS peak ${val(t.gatewayRssMaxMb)} MB`, "");
    out.push("| step | chats | turns ok | p50 s | p95 s | max s | 1st token p50 s | MemAvail start→min MB | swap used max MB | temp max °C | CPU mean % | runtime RSS start→max MB | runtime cgroup max MB | runtime procs max | web RSS max MB | restarts | OOM |");
    out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const s of r.steps) {
      const x = s.resources;
      const restarts = Object.values(s.units).reduce((n, u) => n + (u.restarts || 0), 0);
      out.push(`| ${s.id} | ${s.concurrency || "–"} | ${s.turns.total ? `${s.turns.ok}/${s.turns.total}` : "–"} | ${sec(s.latencyMs.p50)} | ${sec(s.latencyMs.p95)} | ${sec(s.latencyMs.max)} | ${sec(s.latencyMs.firstTokenP50)} | ${val(x.memAvailableMb.start)}→${val(x.memAvailableMb.min)} | ${val(x.swapUsedMb.max)} | ${val(x.tempC.max)} | ${val(x.cpuBusyPct.mean)} | ${val(x.gatewayRssMb.start)}→${val(x.gatewayRssMb.max)} | ${val(x.gatewayCgroupMbMax)} | ${val(x.gatewayProcsMax)} | ${val(x.webRssMb.max)} | ${restarts} | ${val(s.oomKills)} |`);
    }
    out.push("");
    const long = r.steps.find((s) => s.long);
    if (long) out.push(`Long session: ${long.turns.total} turns, p50 of the first five ${sec(long.long.firstFiveP50Ms)} s vs the last five ${sec(long.long.lastFiveP50Ms)} s; code word recalled ${long.long.recall.ok}/${long.long.recall.asked}.`);
    const tool = r.steps.find((s) => s.tool);
    if (tool) out.push(`Tool session: ${tool.turns.ok}/${tool.turns.total} turns right, ${tool.tool.turnsWithToolCalls} with tool calls seen (${tool.toolCalls} calls).`);
    const slow = r.steps.filter((s) => s.slowChatSends?.count);
    if (slow.length) out.push(`Gateway "slow chat send" log lines: ${slow.map((s) => `${s.id} ${s.slowChatSends.count} (max ${sec(s.slowChatSends.maxMs)} s, preparation ${sec(s.slowChatSends.maxPreparationMs)} s)`).join("; ")}.`);
    out.push("", r.findings.length ? "Findings:" : "Findings: none — no failed turn, no OOM kill, no restart, MemAvailable stayed above " + LOW_MEM_MB + " MB.");
    for (const f of r.findings) out.push(`- ${f}`);
    for (const s of r.steps) for (const m of s.errors.messages) out.push(`  - ${s.id} — ${m}`);
    out.push("");
  }
  return out.join("\n");
}

function main(args) {
  const take = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const jsonOut = take("--json");
  const mdOut = take("--md");
  if (args.length === 0) {
    console.error("usage: report.mjs [--json out.json] [--md out.md] raw.json [raw.json ...]");
    process.exit(2);
  }
  const reports = args.map((f) => summarizeRaw(JSON.parse(fs.readFileSync(f, "utf8"))));
  const md = renderMarkdown(reports);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ version: REPORT_VERSION, runs: reports }, null, 2) + "\n");
  if (mdOut) fs.writeFileSync(mdOut, md + "\n");
  if (!mdOut) process.stdout.write(md + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main(process.argv.slice(2));
