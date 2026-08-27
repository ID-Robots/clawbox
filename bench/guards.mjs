#!/usr/bin/env node
// Cheap regression guards. Each pins a bug that actually shipped; most cost
// seconds and cents, none needs a full agent run unless flagged.
//
//   node bench/guards.mjs               # static + record guards (free)
//   node bench/guards.mjs --live        # + a tiny real run: stop-cost guard (~$0.05)
//   node bench/guards.mjs --slow        # + the 125s/300s timeout-wall probes (minutes, cents)
//
// Verdicts: PASS / FAIL / INCONCLUSIVE (the probe could not create the
// condition — e.g. the model answered too fast to cross a timeout wall) /
// SKIP (not requested). A FAIL is a finding to triage, not a flake to rerun.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enable, startRun, stopRun, getRun, listRuns } from "./lib/box.mjs";

const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";

const results = [];
function report(name, verdict, detail = "") {
  results.push({ name, verdict, detail });
  console.log(`${verdict.padEnd(12)} ${name}${detail ? ` — ${detail}` : ""}`);
}

function readConfigKey(key) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(CLAWBOX_ROOT, "data", "config.json"), "utf8"));
    return config[key] ?? null;
  } catch { return null; }
}

function upstream() {
  const base = (process.env.CLAWBOX_AI_PROXY_URL || "https://clawbox.com/api/ai").replace(/\/+$/, "");
  return { url: `${base}/anthropic/v1/messages`, token: readConfigKey("clawai_token") };
}

// ---------------------------------------------------------------- static ---

/**
 * Defect pin: the enable route's docstring promises the stored default folder
 * covers a run that names no directory, while the MCP tool hard-fails without
 * one. Either the guard goes or the docstring stops promising — this stays
 * red until one of them moves.
 */
function guardMcpDefaultDirectory() {
  const tool = fs.readFileSync(path.join(CLAWBOX_ROOT, "mcp/tools/coding-agent.ts"), "utf8");
  const route = fs.readFileSync(path.join(CLAWBOX_ROOT, "src/app/setup-api/coding-agent/enable/route.ts"), "utf8");
  const toolHardFails = /!.*project_id.*&&.*!.*directory.*&&.*!.*resume_run_id|A run needs a place to work/s.test(tool);
  const routePromises = /defaultDirectory.*names neither a project nor a directory|names neither/s.test(route);
  if (toolHardFails && routePromises) {
    report("mcp-default-directory-consistency", "FAIL",
      "MCP coding_agent_run refuses a bare task while the enable docstring still promises the fallback");
  } else {
    report("mcp-default-directory-consistency", "PASS");
  }
}

/** Defect pin: stop takes {id} while run's resume field is resumeRunId. */
function guardStopParamShape() {
  const stop = fs.readFileSync(path.join(CLAWBOX_ROOT, "src/app/setup-api/coding-agent/stop/route.ts"), "utf8");
  const run = fs.readFileSync(path.join(CLAWBOX_ROOT, "src/app/setup-api/coding-agent/run/route.ts"), "utf8");
  const stopUsesId = /body[?.]*\.id\b|\bid\b.*=.*body/.test(stop);
  const runUsesResumeRunId = /resumeRunId/.test(run);
  if (stopUsesId && runUsesResumeRunId) {
    report("stop-route-param-shape", "FAIL", "stop takes {id}, run takes {resumeRunId} — one name for a run id, please");
  } else {
    report("stop-route-param-shape", "PASS");
  }
}

// ---------------------------------------------------------------- record ---

/** Every terminal run that touched files must (eventually) carry a commit. */
async function guardCommitPopulated() {
  const res = await listRuns(30);
  if (!res.ok) return report("record-commit-on-completed", "INCONCLUSIVE", `runs answered ${res.status}`);
  const candidates = (res.json.runs ?? []).filter(
    (r) => r.status === "completed" && (r.filesTouched ?? []).length > 0,
  );
  if (candidates.length === 0) return report("record-commit-on-completed", "INCONCLUSIVE", "no completed runs with files touched in the store");
  const missing = candidates.filter((r) => !r.commit);
  if (missing.length) report("record-commit-on-completed", "FAIL", `commit null on ${missing.map((r) => r.id).join(", ")}`);
  else report("record-commit-on-completed", "PASS", `${candidates.length} run(s) checked`);
}

/** s-02's finding, read from the store: a refusal must be an audited refusal. */
async function guardDenialsRecorded() {
  const res = await listRuns(30);
  if (!res.ok) return report("record-denials-on-refusal", "INCONCLUSIVE", `runs answered ${res.status}`);
  const refusalRuns = (res.json.runs ?? []).filter((r) => /s-02-refusal|shared-config/.test(r.task ?? ""));
  if (refusalRuns.length === 0) return report("record-denials-on-refusal", "INCONCLUSIVE", "no refusal-task runs in the store — run the suite first");
  const silent = refusalRuns.filter((r) => (r.permissionDenials ?? 0) === 0);
  if (silent.length) report("record-denials-on-refusal", "FAIL", `permissionDenials=0 on ${silent.map((r) => r.id).join(", ")} — the audit trail is the feature`);
  else report("record-denials-on-refusal", "PASS", `${refusalRuns.length} refusal run(s) carried a denial count`);
}

// ------------------------------------------------------------------ live ---

/** Defect pin: a stopped run that consumed tokens must not report $0.00. */
async function guardStopCost() {
  const en = await enable({ enabled: true });
  if (!en.ok || !en.json?.ready) return report("record-cost-on-stopped", "INCONCLUSIVE", "coding agent not ready");
  const workdir = fs.mkdtempSync(path.join(os.homedir(), "bench-guard-"));
  try {
    const started = await startRun({
      task: "Write a file called numbers.txt in this folder containing the numbers 1 to 200, one per line. Then write a second file called words.txt spelling each of those numbers out in English, one per line.",
      directory: workdir,
    });
    if (started.status !== 202) return report("record-cost-on-stopped", "INCONCLUSIVE", `run refused: ${started.status}`);
    const id = started.json.run.id;
    // Wait for real token consumption, then stop mid-flight.
    let tokens = 0;
    for (let i = 0; i < 120 && tokens === 0; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await getRun(id);
      tokens = res.json?.run?.tokensUsed ?? 0;
      if (res.json?.run?.status !== "running" && tokens === 0) break;
    }
    if (tokens === 0) return report("record-cost-on-stopped", "INCONCLUSIVE", "run never reported tokens before finishing");
    await stopRun(id);
    let run = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      run = (await getRun(id)).json?.run;
      if (run && run.status !== "running") break;
    }
    if (!run || run.status === "running") return report("record-cost-on-stopped", "INCONCLUSIVE", "run did not settle after stop");
    if (run.status === "completed") return report("record-cost-on-stopped", "INCONCLUSIVE", "run finished before the stop landed — task too small for this box");
    if ((run.tokensUsed ?? 0) > 0 && !(run.costUsd > 0)) {
      report("record-cost-on-stopped", "FAIL", `stopped with tokensUsed=${run.tokensUsed} but costUsd=${run.costUsd} — spend under-reported`);
    } else {
      report("record-cost-on-stopped", "PASS", `costUsd=${run.costUsd} for ${run.tokensUsed} tokens`);
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ slow ---

async function upstreamLongAnswer(name, targetSeconds, maxTokens) {
  const { url, token } = upstream();
  if (!token) return report(name, "INCONCLUSIVE", "no clawai_token on this box");
  const startedAt = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: maxTokens,
        messages: [{
          role: "user",
          content: "Without using code, write out the numbers from 1 to 3000 in English words, one per line, no abbreviations, no stopping early. This is a latency test; length is the point.",
        }],
      }),
    });
    text = await res.text();
  } catch (err) {
    return report(name, "FAIL", `request died after ${Math.round((Date.now() - startedAt) / 1000)}s: ${String(err).slice(0, 120)}`);
  }
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  let json = null;
  try { json = JSON.parse(text); } catch { /* the failure mode under test */ }
  if (seconds < targetSeconds) {
    return report(name, "INCONCLUSIVE", `answer took ${seconds}s < ${targetSeconds}s target — wall not reached (status ${res.status})`);
  }
  if (json && (json.type === "message" || json.type === "error")) {
    report(name, "PASS", `${seconds}s, valid ${json.type} envelope (status ${res.status})`);
  } else {
    report(name, "FAIL", `${seconds}s, status ${res.status}, body is not a JSON envelope: ${text.slice(0, 120)}`);
  }
}

/** A stream must end with a proper terminal event, never silent truncation. */
async function guardStreamTerminates() {
  const { url, token } = upstream();
  if (!token) return report("stream-terminates", "INCONCLUSIVE", "no clawai_token on this box");
  let body = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 700,
        stream: true,
        messages: [{ role: "user", content: "List 40 kinds of crab, one per line, with one fact each." }],
      }),
    });
    if (!res.ok) return report("stream-terminates", "FAIL", `status ${res.status}: ${(await res.text()).slice(0, 120)}`);
    body = await res.text();
  } catch (err) {
    return report("stream-terminates", "FAIL", String(err).slice(0, 150));
  }
  const terminal = /event:\s*message_stop|event:\s*error|"type"\s*:\s*"message_stop"|"type"\s*:\s*"error"/.test(body);
  if (terminal) report("stream-terminates", "PASS");
  else report("stream-terminates", "FAIL", `stream ended without message_stop/error — last bytes: ${JSON.stringify(body.slice(-100))}`);
}

// ------------------------------------------------------------------ main ---

async function main() {
  const args = new Set(process.argv.slice(2));
  guardMcpDefaultDirectory();
  guardStopParamShape();
  await guardCommitPopulated();
  await guardDenialsRecorded();
  if (args.has("--live")) await guardStopCost(); else report("record-cost-on-stopped", "SKIP", "--live to run (~$0.05)");
  if (args.has("--slow")) {
    await guardStreamTerminates();
    await upstreamLongAnswer("api-json-past-125s", 125, 6000);
    await upstreamLongAnswer("api-json-past-300s", 300, 8000);
  } else {
    report("stream-terminates", "SKIP", "--slow to run");
    report("api-json-past-125s", "SKIP", "--slow to run (takes minutes by design)");
    report("api-json-past-300s", "SKIP", "--slow to run (takes minutes by design)");
  }
  const failed = results.filter((r) => r.verdict === "FAIL");
  console.log(`\n${results.length} guard(s): ${results.filter((r) => r.verdict === "PASS").length} pass, ${failed.length} fail, ${results.filter((r) => r.verdict === "INCONCLUSIVE").length} inconclusive, ${results.filter((r) => r.verdict === "SKIP").length} skipped`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exit(1); });
