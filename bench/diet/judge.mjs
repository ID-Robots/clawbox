#!/usr/bin/env node
// The quality judge: a separate model run (Opus by default, through the
// `claude` CLI on the machine that runs this — never on the box under test)
// scores each spec run 0–10 on a fixed rubric from the task, the diff, the
// acceptance results and the run's own summary. It is BLIND to the settings
// and the label, so a cheaper configuration cannot be scored by its name.
// Two independent samples per run, averaged, so one noisy answer cannot move
// the keep/reject rule (which acts on a 0.5 drop).
//
//   node bench/diet/judge.mjs <results/<label>> [--model claude-opus-5-5] [--samples 2] [--force]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summaryTable } from "./lib/report.mjs";

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--"));
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const model = opt("model", "claude-opus-5-5");
const samples = Number(opt("samples", 2));
const force = argv.includes("--force");
if (!dir) { console.error("usage: node bench/diet/judge.mjs <results/<label>> [--model M] [--samples N] [--force]"); process.exit(2); }

const CRITERIA = ["correctness", "completeness", "code_quality", "hygiene"];

function prompt(r) {
  const acc = (r.acceptance?.steps ?? []).map((s) => `- ${s.name}: ${s.ok ? "PASS" : `FAIL (exit ${s.exit})`}${s.ok ? "" : `\n  ${s.tail.replace(/\n/g, "\n  ").slice(-800)}`}`).join("\n");
  const probe = r.acceptance?.probe ? `- app probe ${r.acceptance.probe.url}: ${r.acceptance.probe.ok ? "PASS" : `FAIL (${r.acceptance.probe.error})`}` : "";
  return `You are a senior engineer reviewing a coding agent's finished work. Score it strictly and consistently.

## The task the agent was given
${r.task}

## What a reviewer should check for this task
${r.rubric || "(nothing extra)"}

## Automated acceptance (hidden tests the agent never saw, build, app probe)
${acc || "(none)"}
${probe}
Run status: ${r.status}${r.error ? ` — ${String(r.error).slice(0, 300)}` : ""}

## Files changed
${(r.diff?.names ?? []).slice(0, 200).join("\n")}

## Diff (lockfiles and dependencies excluded${r.diff?.truncated ? "; TRUNCATED" : ""})
\`\`\`diff
${r.diff?.patch ?? "(no diff)"}
\`\`\`

## The agent's closing report
${(r.summary || "(none)").slice(0, 4000)}

## Rubric — integers 0–10 each
- correctness: does the code do what was asked, including edge cases; would it work for a real user? Failing acceptance caps this at 4.
- completeness: every requested part delivered (features, tests, wiring, docs the task asked for); nothing silently skipped.
- code_quality: readable, idiomatic, fits the existing codebase's structure and style, no needless complexity or duplication, tests are meaningful.
- hygiene: no leftover junk (debug output, stray files, commented-out code, unrelated edits, weakened or deleted tests), report is honest about what was and was not verified.
Answer with ONLY one JSON object, no prose before or after:
{"correctness":N,"completeness":N,"code_quality":N,"hygiene":N,"notes":"<= 3 sentences on the biggest problems"}`;
}

function ask(text) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "diet-judge-"));
  try {
    const r = spawnSync("claude", ["-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", ""], { cwd, input: text, encoding: "utf8", timeout: 600_000, maxBuffer: 64 << 20 });
    const out = JSON.parse(r.stdout || "{}");
    const body = String(out.result ?? "");
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no JSON in judge answer: ${body.slice(0, 200)}`);
    const v = JSON.parse(m[0]);
    for (const c of CRITERIA) if (!Number.isFinite(v[c])) throw new Error(`judge answer lacks ${c}`);
    return v;
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

// Scores live in a sidecar (<spec>.judge.json) so re-running acceptance or
// copying results again never loses them.
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".judge.json") && !["meta.json", "summary.json"].includes(f));
const all = [];
for (const f of files) {
  const file = path.join(dir, f);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!r.spec) continue;
  const side = file.replace(/\.json$/, ".judge.json");
  if (fs.existsSync(side)) r.judge = JSON.parse(fs.readFileSync(side, "utf8"));
  else if (r.judge) fs.writeFileSync(side, JSON.stringify(r.judge, null, 2));
  if (r.harnessError || !r.diff) { all.push(r); continue; }
  if (r.judge && !force) { all.push(r); continue; }
  const got = [];
  for (let i = 0; i < samples; i++) {
    try { got.push(ask(prompt(r))); } catch (e) { console.error(`${r.spec}: ${e.message}`); }
  }
  if (got.length) {
    const mean = (c) => got.reduce((a, g) => a + g[c], 0) / got.length;
    const scores = Object.fromEntries(CRITERIA.map((c) => [c, Math.round(mean(c) * 10) / 10]));
    const overall = Math.round((CRITERIA.reduce((a, c) => a + scores[c], 0) / CRITERIA.length) * 10) / 10;
    r.judge = { model, samples: got.length, ...scores, overall, notes: got.map((g) => g.notes).filter(Boolean) };
    fs.writeFileSync(side, JSON.stringify(r.judge, null, 2));
  }
  console.log(`${r.spec}: judge ${r.judge?.overall ?? "–"}`);
  all.push(r);
}
fs.writeFileSync(path.join(dir, "summary.md"), summaryTable(all));
console.log(summaryTable(all));
