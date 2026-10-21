#!/usr/bin/env node
// Token-diet suite runner. Runs ON the box (it mints the owner cookie the way
// ../lib/box.mjs does, because the settings switch is owner-only), starts each
// spec as an ordinary coding run through the box's own API, waits for the run
// AND everything that follows it (queue, completion attempts, the review
// pass), then judges the result by machine: the spec's acceptance commands on
// a clean checkout of what the run left behind, with the spec's HIDDEN tests
// copied over, plus an optional probe that starts the app and asks it one
// question. The quality judge (an LLM rubric) is ../diet/judge.mjs, run
// afterwards on a workstation over the JSON this writes.
//
//   node bench/diet/run-suite.mjs --label base [--specs a,b] [--concurrency 2]
//        [--settings '{"effort":"xhigh","reviewPass":false}'] [--provider clawbox-ai|anthropic]
//        [--root /home/clawbox/Projects] [--out bench/diet/results]
//
// One JSON per spec run in <out>/<label>/<spec>.json, plus summary.md. It
// spends real tokens; never part of `test:*`.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as box from "../lib/box.mjs";
import { splitPhases, toolStats } from "./lib/phases.mjs";
import { summaryTable } from "./lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const label = args.label;
if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) usage("--label is required ([A-Za-z0-9._-])");
const specsDir = path.resolve(args.specsDir ?? path.join(HERE, "specs"));
const wanted = args.specs ? args.specs.split(",") : null;
const specs = fs.readdirSync(specsDir)
  .filter((d) => fs.existsSync(path.join(specsDir, d, "spec.json")))
  .map((d) => ({ ...JSON.parse(fs.readFileSync(path.join(specsDir, d, "spec.json"), "utf8")), dir: path.join(specsDir, d) }))
  .filter((s) => !wanted || wanted.includes(s.id))
  .sort((a, b) => tierRank(b.tier) - tierRank(a.tier)); // long first: they bound the wall clock
if (!specs.length) usage("no specs matched");
const concurrency = Math.max(1, Number(args.concurrency ?? 1));
const outDir = path.resolve(args.out ?? path.join(HERE, "results"), label);
fs.mkdirSync(outDir, { recursive: true });
const RUN_DEADLINE_MS = Number(args.deadlineMin ?? 240) * 60_000;

function usage(msg) {
  console.error(`run-suite: ${msg}\nusage: node bench/diet/run-suite.mjs --label L [--specs a,b] [--concurrency N] [--settings JSON] [--provider P] [--root DIR] [--out DIR]`);
  process.exit(2);
}
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-zA-Z-]+)$/);
    if (!m) usage(`unexpected argument ${argv[i]}`);
    o[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return o;
}
function tierRank(t) { return t === "long" ? 2 : t === "short" ? 1 : 0; }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, opts = {}) => execFileSync("bash", ["-c", cmd], { encoding: "utf8", maxBuffer: 256 << 20, ...opts });
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 256 << 20 }).trim();

// ---------------------------------------------------------------- settings
async function applySettings() {
  if (args.settings) {
    const want = JSON.parse(args.settings);
    // One key per request: the route refuses a whole body over one bad field,
    // and the error should name the field.
    for (const [k, v] of Object.entries(want)) {
      const r = await box.enable({ [k]: v });
      if (!r.ok) throw new Error(`setting ${k}=${JSON.stringify(v)} refused: ${r.status} ${r.text.slice(0, 200)}`);
    }
  }
  const st = (await box.codingStatus()).json ?? {};
  const pick = ["provider", "effort", "maxTurns", "reviewPass", "reviewRounds", "completionAttempts", "tokenLimit", "maxParallelRuns", "autoPr", "harnessCommand"];
  return Object.fromEntries(pick.map((k) => [k, st[k] ?? null]));
}

// ---------------------------------------------------------------- project
function projectRoot() {
  if (args.root) return args.root;
  const st = sh(`python3 -c "import json;print(json.load(open('${process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox"}/data/config.json')).get('coding_agent_default_directory') or '')"`).trim();
  return st || path.join(os.homedir(), "Projects");
}

function prepareProject(spec, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  if (spec.source?.kind === "git") {
    sh(`git clone -q --depth 1 --branch '${spec.source.ref}' '${spec.source.url}' '${dir}'`);
    // A clean history of one commit, so BASE is the starting point and the
    // run's branch diff is the run's work alone.
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  } else {
    fs.cpSync(path.join(spec.dir, "seed"), dir, { recursive: true });
  }
  sh(`cd '${dir}' && git init -q -b main && git add -A && git -c user.name=bench -c user.email=bench@localhost commit -qm 'Initial import'`);
  if (spec.setup) sh(`cd '${dir}' && ${spec.setup}`, { stdio: ["ignore", "ignore", "pipe"], timeout: 30 * 60_000 });
  const dirty = git(dir, "status", "--porcelain");
  if (dirty) throw new Error(`${spec.id}: setup left the project dirty (a run's worktree would not merge home): ${dirty.slice(0, 200)}`);
  return git(dir, "rev-parse", "HEAD");
}

// ---------------------------------------------------------------- waiting
const SETTLED = new Set(["completed", "failed", "stopped", "timed_out", "gave_up", "paused"]);

async function settle(id, deadline) {
  for (;;) {
    const res = await box.getRun(id, 60);
    const run = res.json?.run;
    if (!run) throw new Error(`runs?id=${id}: ${res.status} ${res.text.slice(0, 160)}`);
    if (SETTLED.has(run.status) || Date.now() > deadline) return run;
  }
}

/** A run is DONE when it and every run that follows it (review pass, review
 * rounds) have settled and stay settled across two looks a minute apart —
 * a completion attempt resumes the SAME record after it first settles. */
async function waitAll(runId, deadline) {
  let quiet = 0;
  let main = null;
  const followers = new Map();
  while (quiet < 2) {
    main = await settle(runId, deadline);
    const list = (await box.get("/setup-api/coding-agent/runs?limit=40")).json?.runs ?? [];
    for (const r of list) if (r.reviewOf === runId || r.reviewLoopOf === runId || r.ciFixOf === runId) followers.set(r.id, r);
    let live = !SETTLED.has(main.status);
    for (const id of followers.keys()) {
      const r = await settle(id, deadline);
      followers.set(id, r);
      if (!SETTLED.has(r.status)) live = true;
    }
    if (Date.now() > deadline) break;
    quiet = live ? 0 : quiet + 1;
    if (quiet < 2) await sleep(30_000);
  }
  main = (await box.getRun(runId)).json?.run ?? main;
  return { main, followers: [...followers.values()] };
}

// ---------------------------------------------------------------- judging by machine
function finalCommit(projectDir, run) {
  const branch = run.worktree?.branch;
  const merged = run.worktree?.result?.kind === "merged";
  if (!merged && branch) {
    try { return { sha: git(projectDir, "rev-parse", branch), from: `branch ${branch} (${run.worktree?.result?.kind ?? "unsettled"}: ${run.worktree?.result?.reason ?? ""})` }; } catch { /* fall through */ }
  }
  return { sha: git(projectDir, "rev-parse", "HEAD"), from: merged ? "merged into main" : "project HEAD" };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

async function probe(spec, dir) {
  if (!spec.probe) return null;
  const port = await freePort();
  const child = spawn("bash", ["-c", spec.probe.start], { cwd: dir, env: { ...process.env, PORT: String(port) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out = (out + d).slice(-2000); });
  child.stderr.on("data", (d) => { out = (out + d).slice(-2000); });
  const url = spec.probe.url.replace("{port}", String(port));
  let result = { ok: false, url: url.replace(String(port), "{port}"), status: null, error: "no answer in 90 s" };
  const until = Date.now() + 90_000;
  while (Date.now() < until && child.exitCode === null) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = await res.text();
      const statusOk = res.status === (spec.probe.expectStatus ?? 200);
      const bodyOk = !spec.probe.expectBodyIncludes || body.includes(spec.probe.expectBodyIncludes);
      result = { ok: statusOk && bodyOk, url: result.url, status: res.status, error: statusOk ? (bodyOk ? null : "body lacks expected text") : `status ${res.status}` };
      break;
    } catch { await sleep(1500); }
  }
  if (child.exitCode !== null && !result.status) result.error = `app exited ${child.exitCode}: ${out.slice(-300)}`;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  await sleep(500);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  return result;
}

async function acceptance(spec, projectDir, base, sha) {
  const evalDir = fs.mkdtempSync(path.join(os.tmpdir(), `diet-eval-${spec.id}-`));
  fs.rmSync(evalDir, { recursive: true, force: true });
  git(projectDir, "worktree", "add", "-q", "--detach", evalDir, sha);
  try {
    // A run's worktree links the project's node_modules; a box without the
    // `/node_modules` exclude committed that link (an absolute path into the
    // project). Judge the code, not the link — and say it happened.
    let committedLink = false;
    try {
      if (fs.lstatSync(path.join(evalDir, "node_modules")).isSymbolicLink()) { fs.unlinkSync(path.join(evalDir, "node_modules")); committedLink = true; }
    } catch { /* none */ }
    // Dependencies the setup installed are not in git: lend them.
    // When the project's own copy is broken (a merged link pointing at
    // itself), install afresh in the checkout instead.
    let lent = false;
    for (const dep of ["node_modules"]) {
      const src = path.join(projectDir, dep);
      let usable = false;
      try { usable = fs.statSync(src).isDirectory(); } catch { usable = false; }
      if (usable && !fs.existsSync(path.join(evalDir, dep))) { fs.symlinkSync(src, path.join(evalDir, dep)); lent = true; }
    }
    if (!lent && spec.setup && fs.existsSync(path.join(evalDir, "package.json"))) {
      try { sh(`cd '${evalDir}' && ${spec.setup}`, { stdio: ["ignore", "ignore", "pipe"], timeout: 20 * 60_000 }); } catch { /* the steps will say */ }
    }
    const hidden = path.join(spec.dir, "hidden");
    if (fs.existsSync(hidden)) {
      for (const e of fs.readdirSync(hidden)) if (e !== ".keep") fs.cpSync(path.join(hidden, e), path.join(evalDir, e), { recursive: true, force: true });
    }
    const steps = [];
    for (const step of spec.accept ?? []) {
      const t0 = Date.now();
      const r = spawnSync("bash", ["-c", step.cmd], {
        cwd: evalDir, encoding: "utf8", timeout: (step.timeoutSec ?? 300) * 1000, maxBuffer: 64 << 20,
        // PROJECT is the checkout under test (the run's final commit), never
        // the owner's folder, which may not hold the run's work.
        env: { ...process.env, BASE: base, HIDDEN: hidden, PROJECT: evalDir, CI: "1" },
      });
      steps.push({ name: step.name, ok: r.status === 0, exit: r.status, signal: r.signal ?? null, ms: Date.now() - t0, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-1500) });
    }
    const pr = await probe(spec, evalDir);
    return { steps, probe: pr, committedNodeModulesLink: committedLink, pass: steps.every((s) => s.ok) && (pr ? pr.ok : true) };
  } finally {
    try { git(projectDir, "worktree", "remove", "--force", evalDir); } catch { fs.rmSync(evalDir, { recursive: true, force: true }); }
  }
}

function diffFor(projectDir, base, sha) {
  // `glob` magic so `**/` also matches at the root (plain pathspecs only match
  // the pattern under a directory); the bare `node_modules` entry catches a
  // committed root symlink, which `**/node_modules/**` does not.
  const exclude = [":(glob,exclude)**/package-lock.json", ":(glob,exclude)**/yarn.lock", ":(glob,exclude)**/*.lock", ":(glob,exclude)**/node_modules/**", ":(exclude)node_modules", ":(glob,exclude)**/dist/**"];
  const stat = git(projectDir, "diff", "--stat", base, sha, "--", ".", ...exclude);
  const names = git(projectDir, "diff", "--name-status", base, sha).split("\n").filter(Boolean);
  let patch = git(projectDir, "diff", base, sha, "--", ".", ...exclude);
  const cap = 150_000;
  const truncated = patch.length > cap;
  if (truncated) patch = `${patch.slice(0, cap)}\n… [diff truncated at ${cap} chars of ${patch.length}]`;
  return { stat, names, patch, truncated };
}

// ---------------------------------------------------------------- transcripts
function transcriptFiles(runs) {
  const files = new Set();
  for (const r of runs) {
    if (!r?.transcriptPath) continue;
    const tp = r.transcriptPath;
    if (fs.existsSync(tp)) files.add(tp);
    const sideDir = tp.replace(/\.jsonl$/, "");
    if (fs.existsSync(sideDir)) {
      for (const f of sh(`find '${sideDir}' -name '*.jsonl'`).split("\n").filter(Boolean)) files.add(f);
    }
  }
  return [...files];
}

/** A fingerprint of everything a spec is (its JSON, seed and hidden files), so
 * two suite runs are only ever compared on the same task. */
function specHash(spec) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(spec.dir, p)); h.update(fs.readFileSync(p)); }
    }
  };
  walk(spec.dir);
  return h.digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------- one spec
async function runSpec(spec, root, settings) {
  const dir = path.join(root, `${spec.project}-${label}`);
  const rec = { spec: spec.id, specHash: specHash(spec), tier: spec.tier, label, settings, provider: args.provider ?? settings.provider, project: path.basename(dir) };
  try {
    const base = prepareProject(spec, dir);
    rec.base = base;
    const t0 = Date.now();
    const started = await box.post("/setup-api/coding-agent/run", { task: spec.task, directory: dir, ...(args.provider ? { provider: args.provider } : {}) });
    const runId = started.json?.run?.id;
    if (!runId) throw new Error(`run refused: ${started.status} ${started.text.slice(0, 300)}`);
    rec.runId = runId;
    log(`${spec.id}: ${runId} ${started.json?.queued ? "queued" : "started"}`);
    const { main, followers } = await waitAll(runId, t0 + RUN_DEADLINE_MS);
    const { run } = await box.waitForCommit(runId, 60_000);
    const final = run ?? main;
    rec.wallMs = Date.now() - t0;
    rec.status = final.status;
    rec.error = final.error ?? null;
    rec.numTurns = final.numTurns;
    rec.effort = final.effort;
    rec.maxTurns = final.maxTurns;
    rec.model = final.model;
    rec.modelsUsed = final.modelsUsed;
    rec.tokensUsed = final.tokensUsed ?? 0;
    rec.tokenBreakdown = final.tokenBreakdown ?? null;
    rec.spawnTokens = final.spawnTokens ?? null;
    rec.thinkingTokens = final.thinkingTokens ?? null;
    rec.subagentsTotal = final.subagentsTotal ?? 0;
    rec.subagentsByType = final.subagentsByType ?? {};
    rec.attempts = (final.attempts ?? []).length;
    rec.agentMs = (final.completedAt && final.startedAt) ? final.completedAt - final.startedAt : null;
    // Start of the run to the end of the last thing that followed it, on the
    // box's own clock — the wall time without any wait in the queue.
    const ends = [final.completedAt, ...followers.map((f) => f.completedAt)].filter((t) => typeof t === "number");
    rec.activeMs = final.startedAt && ends.length ? Math.max(...ends) - final.startedAt : null;
    rec.followers = followers.map((f) => ({ id: f.id, kind: f.reviewOf ? "review" : f.reviewLoopOf ? "review-loop" : "ci-fix", status: f.status, tokensUsed: f.tokensUsed ?? 0, numTurns: f.numTurns, ms: f.completedAt && f.startedAt ? f.completedAt - f.startedAt : null }));
    // The box's figures, kept for comparison only: a review pass resumes the
    // run's session and its record carries the session total (main included).
    rec.boxTokens = { run: rec.tokensUsed, followers: rec.followers.reduce((a, f) => a + f.tokensUsed, 0) };
    const files = transcriptFiles([final, ...followers]);
    rec.phases = splitPhases(files, {
      reviewStart: followers.filter((f) => f.reviewOf).map((f) => f.startedAt).sort()[0] ?? null,
      attemptStarts: (final.attempts ?? []).slice(1).map((a) => a.startedAt).filter(Boolean),
    });
    rec.tools = toolStats(files);
    rec.totalTokens = rec.phases.total || rec.tokensUsed;
    // Keep the raw transcripts for later attribution.
    if (files.length) {
      try { execFileSync("tar", ["czf", path.join(outDir, `${spec.id}-transcripts.tgz`), ...files.map((f) => path.relative("/", f))], { cwd: "/" }); } catch { /* best effort */ }
    }
    const fc = finalCommit(dir, final);
    rec.finalSha = fc.sha;
    rec.finalFrom = fc.from;
    rec.acceptance = await acceptance(spec, dir, base, fc.sha);
    rec.pass = rec.acceptance.pass && final.status === "completed";
    rec.diff = diffFor(dir, base, fc.sha);
    rec.summary = (final.summary ?? final.resultText ?? "").slice(0, 6000);
    rec.task = spec.task;
    rec.rubric = spec.rubric ?? "";
  } catch (err) {
    rec.pass = false;
    rec.harnessError = String(err?.stack ?? err).slice(0, 2000);
    log(`${spec.id}: harness error ${String(err).slice(0, 200)}`);
  }
  fs.writeFileSync(path.join(outDir, `${spec.id}.json`), JSON.stringify(rec, null, 2));
  log(`${spec.id}: ${rec.pass ? "PASS" : "FAIL"} tokens=${rec.totalTokens ?? "?"} (box run ${rec.tokensUsed ?? "?"}) turns=${rec.numTurns ?? "?"} wall=${Math.round((rec.wallMs ?? 0) / 60000)}m`);
  return rec;
}

// ---------------------------------------------------------------- re-acceptance
// `--reaccept 1`: no new runs. Re-run acceptance (and the probe) for the
// results already in <out>/<label>, against the spec as it is now — for a
// corrected check. The project folders and the runs' commits are still there.
if (args.reaccept) {
  const root = projectRoot();
  for (const spec of specs) {
    const file = path.join(outDir, `${spec.id}.json`);
    if (!fs.existsSync(file)) continue;
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!rec.finalSha || !rec.base) continue;
    const dir = path.join(root, rec.project);
    rec.acceptance = await acceptance(spec, dir, rec.base, rec.finalSha);
    rec.pass = rec.acceptance.pass && rec.status === "completed";
    rec.specHash = specHash(spec);
    rec.reaccepted = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    log(`${spec.id}: re-accepted ${rec.pass ? "PASS" : "FAIL"}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- main
const settings = await applySettings();
log(`settings ${JSON.stringify(settings)}`);
const build = (() => { try { return sh(`git -C ${process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox"} rev-parse --short HEAD`).trim(); } catch { return null; } })();
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ label, settings, provider: args.provider ?? settings.provider, build, startedAt: new Date().toISOString(), specs: specs.map((s) => s.id), concurrency }, null, 2));
const root = projectRoot();
const queue = [...specs];
const results = [];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async (_, i) => {
  await sleep(i * 20_000); // stagger, so two setups do not share the CPU at once
  for (let spec = queue.shift(); spec; spec = queue.shift()) results.push(await runSpec(spec, root, settings));
}));
fs.writeFileSync(path.join(outDir, "summary.md"), summaryTable(results));
log("done");
