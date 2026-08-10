// Background shell jobs for the `bash` tool.
//
// Renamed from "tasks": the previous surface had task_status/task_stop about
// SHELL JOBS sitting next to task_create/task_get/task_list/task_update about a
// TO-DO LIST. Two unrelated meanings behind one verb prefix is a tie a small
// model breaks wrongly. The to-do family is gone entirely (it was in-memory,
// lost on restart, had no observable effect, and both harnesses ship a native
// todo); what survives is job_status / job_stop, which are about processes.

import { spawn, type ChildProcess } from "child_process";
import { HOME } from "./guard";
import { DangerousCommandError } from "./errors";

export interface BgJob {
  id: string;
  command: string;
  description: string;
  status: "running" | "completed" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: number;
  completedAt: number | null;
  process: ChildProcess | null;
}

const jobs = new Map<string, BgJob>();
const MAX_AGE_MS = 3_600_000;
const MAX_KEPT = 50;
const MAX_OUTPUT = 4 * 1024 * 1024; // per stream
let seq = 0;

// Hard blocks. These are TYPO PROTECTION, not a security boundary: `bash` runs
// an arbitrary shell string, so anything this list catches can be spelled
// another way. The real containment is that `bash` exists on OpenClaw only and
// that every other tool is argv-driven.
const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)/, "recursive forced delete"],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/, "recursive forced delete"],
  [/\bgit\s+push\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)/, "force push"],
  [/\bgit\s+reset\s+--hard/, "hard reset discards local changes"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean removes untracked files permanently"],
  [/\bgit\s+branch\s+-D\b/, "force branch delete may lose unmerged work"],
  [/\bdd\s+.*of=\/dev\//, "direct device write"],
  [/\bmkfs\./, "filesystem format"],
  [/\b(chmod|chown)\s+(-R\s+)?.*\/\s*$/, "recursive permission change on /"],
  [/>\s*\/dev\/[sh]d[a-z]/, "redirect to a raw device"],
  [/\bkill\s+-9\s+-1/, "kill every process"],
  [/\bsystemctl\s+(stop|disable)\s+(NetworkManager|sshd|systemd)/, "stopping a critical system service"],
  [/:\(\)\{\s*:\|:&\s*\};:/, "fork bomb"],
];

const GIT_WARNINGS: [RegExp, string][] = [
  [/\bgit\s+push\s+.*--no-verify/, "skipping push hooks"],
  [/\bgit\s+commit\s+.*--no-verify/, "skipping commit hooks"],
  [/\bgit\s+add\s+(-A|--all|\.)(\s|$)/, "git add -A may stage secrets"],
];

export function inspectCommand(cmd: string): { blocked: string[]; warnings: string[] } {
  const blocked = DANGEROUS_PATTERNS.filter(([re]) => re.test(cmd)).map(([, m]) => m);
  const warnings = GIT_WARNINGS.filter(([re]) => re.test(cmd)).map(([, m]) => m);
  return { blocked, warnings };
}

function evictStale(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.completedAt && now - job.completedAt > MAX_AGE_MS) jobs.delete(id);
  }
  if (jobs.size > MAX_KEPT) {
    const done = [...jobs.entries()]
      .filter(([, j]) => j.status !== "running")
      .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));
    while (jobs.size > MAX_KEPT && done.length) jobs.delete(done.shift()![0]);
  }
}

/** Spawn a background shell job. Shared chokepoint for the dangerous-command block. */
export function startJob(
  command: string,
  timeoutMs: number,
  description: string,
  cwd: string,
  allowDangerous: boolean,
): BgJob {
  const { blocked } = inspectCommand(command);
  if (blocked.length && !allowDangerous) throw new DangerousCommandError(blocked);

  evictStale();
  const id = `job-${++seq}`;
  const job: BgJob = {
    id,
    command,
    description,
    status: "running",
    stdout: "",
    stderr: "",
    exitCode: null,
    startedAt: Date.now(),
    completedAt: null,
    process: null,
  };
  jobs.set(id, job);

  const child = spawn("bash", ["-c", command], { timeout: timeoutMs, cwd, env: { ...process.env, HOME } });
  job.process = child;
  let truncated = false;
  const append = (which: "stdout" | "stderr") => (d: Buffer) => {
    if (job[which].length >= MAX_OUTPUT) return;
    job[which] += d.toString();
    if (job[which].length >= MAX_OUTPUT) {
      truncated = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  };
  child.stdout?.on("data", append("stdout"));
  child.stderr?.on("data", append("stderr"));
  child.on("close", (code) => {
    if (truncated) job.stderr += "\n[output truncated: the job produced too much]";
    job.exitCode = code ?? 1;
    job.status = code === 0 ? "completed" : "failed";
    job.completedAt = Date.now();
    job.process = null;
  });
  child.on("error", (err: Error) => {
    job.stderr += err.message;
    job.exitCode = 1;
    job.status = "failed";
    job.completedAt = Date.now();
    job.process = null;
  });
  return job;
}

export function getJob(id: string): BgJob | undefined {
  return jobs.get(id);
}

/** Run a shell command in the foreground with a hard output cap. */
export function runShell(
  command: string,
  timeoutMs: number,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveP) => {
    const child = spawn("bash", ["-c", command], { timeout: timeoutMs, cwd, env: { ...process.env, HOME } });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const onData = (which: "out" | "err") => (d: Buffer) => {
      if (stdout.length + stderr.length >= MAX_OUTPUT) return;
      if (which === "out") stdout += d.toString();
      else stderr += d.toString();
      if (stdout.length + stderr.length >= MAX_OUTPUT) {
        truncated = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    child.stdout?.on("data", onData("out"));
    child.stderr?.on("data", onData("err"));
    child.on("close", (code) => {
      if (truncated) stderr += "\n[output truncated: the command produced too much]";
      resolveP({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on("error", (err: Error) => resolveP({ stdout, stderr: err.message, exitCode: 127 }));
  });
}
