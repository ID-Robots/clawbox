// Capture everything about one run before anything can evict it: the store
// keeps only 30 records, transcripts belong to claude-ds, and workdirs are
// disposable. A failing run is a finding — capture is what makes it one.
//
// Layout per run, under bench/results/<suiteVersion>/:
//   index.jsonl                     one flat line per run — what compare.mjs reads
//   <stamp>-<task>-<runId>/
//     record.json                   the full run record as the box served it
//     score.json                    the deterministic scorer's output
//     git.json                      commit, diff stat, working-tree cleanliness
//     transcript.jsonl              the main session transcript (when readable)
//     usage.json                    per-model token sums from the transcript
//     subagents/                    claude-ds sub-agent artifacts, when any exist
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseTranscript } from "./transcript.mjs";

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

function copyIfReadable(src, dest) {
  try {
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sub-agent transcripts are claude-ds internals — ClawBox itself never writes
 * per-run agent files (verified against src/lib/coding-agent.ts). Sweep
 * defensively: the session's own directory if the CLI made one, plus any
 * agent-*.jsonl beside the transcript that appeared after the run started.
 */
function captureSubagentArtifacts(run, destDir) {
  if (!run.transcriptPath) return 0;
  const projectDir = path.dirname(run.transcriptPath);
  let copied = 0;
  const take = (src, rel) => {
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (copyIfReadable(src, dest)) copied++;
  };
  const sweep = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { sweep(full, path.join(rel, entry.name)); continue; }
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      if (mtime >= run.startedAt) take(full, path.join(rel, entry.name));
    }
  };
  if (run.sessionId) {
    const sessionDir = path.join(projectDir, run.sessionId);
    if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) sweep(sessionDir, "");
  }
  let siblings = [];
  try { siblings = fs.readdirSync(projectDir); } catch { /* unreadable */ }
  for (const name of siblings) {
    if (!/^agent-.*\.jsonl$|\.meta\.json$/.test(name)) continue;
    const full = path.join(projectDir, name);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (mtime >= run.startedAt) take(full, name);
  }
  return copied;
}

export function captureRun({ run, task, workdir, resultsRoot, suiteVersion, score, outcome, wallMs, commitLagMs, label }) {
  const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dirName = `${stamp}-${task.id}-${run.id}`;
  const runDir = path.join(resultsRoot, suiteVersion, dirName);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, "record.json"), JSON.stringify(run, null, 2));
  if (score) fs.writeFileSync(path.join(runDir, "score.json"), JSON.stringify(score, null, 2));

  let usage = null;
  if (run.transcriptPath && copyIfReadable(run.transcriptPath, path.join(runDir, "transcript.jsonl"))) {
    usage = parseTranscript(path.join(runDir, "transcript.jsonl"));
    if (usage) fs.writeFileSync(path.join(runDir, "usage.json"), JSON.stringify(usage, null, 2));
  }
  const subagentFiles = captureSubagentArtifacts(run, path.join(runDir, "subagents"));

  const git = {
    commit: run.commit ?? null,
    commitLagMs: commitLagMs ?? null,
    head: sh("git", ["rev-parse", "--short", "HEAD"], workdir),
    log: sh("git", ["log", "--oneline", "-5"], workdir),
    diffStat: run.commit ? sh("git", ["show", "--stat", "--format=", run.commit], workdir) : null,
    dirty: sh("git", ["status", "--porcelain"], workdir),
  };
  fs.writeFileSync(path.join(runDir, "git.json"), JSON.stringify(git, null, 2));

  const line = {
    suiteVersion,
    task: task.id,
    tier: task.tier,
    label: label ?? null,
    outcome, // completed | failed | stopped | timeout | not-started
    runId: run.id,
    startedAt: run.startedAt,
    wallMs: wallMs ?? (run.completedAt ? run.completedAt - run.startedAt : null),
    status: run.status,
    error: run.error ?? null,
    retries: run.retries ?? 0,
    resumable: run.resumable ?? false,
    numTurns: run.numTurns ?? 0,
    costUsd: run.costUsd ?? null,
    tokensUsed: run.tokensUsed ?? 0,
    thinkingTokens: run.thinkingTokens ?? 0,
    commandsRun: run.commandsRun ?? 0,
    filesTouched: (run.filesTouched ?? []).length,
    permissionDenials: run.permissionDenials ?? 0,
    deniedActions: run.deniedActions ?? [],
    subagentsTotal: run.subagentsTotal ?? 0,
    subagentsByType: run.subagentsByType ?? {},
    modelsUsed: run.modelsUsed ?? [],
    effort: run.effort ?? null,
    model: run.model ?? null,
    commit: run.commit ?? null,
    commitLagMs: commitLagMs ?? null,
    score: score?.score ?? null,
    checksFailed: score ? score.checks.filter((c) => !c.pass).map((c) => c.name) : null,
    usageByModel: usage?.byModel ?? null,
    subagentFiles,
    dir: dirName,
  };
  fs.appendFileSync(path.join(resultsRoot, suiteVersion, "index.jsonl"), JSON.stringify(line) + "\n");
  return { runDir, line };
}
