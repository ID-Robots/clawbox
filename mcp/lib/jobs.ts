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
/** How long to keep collecting output after the shell has already exited. */
const DRAIN_MS = 250;
let seq = 0;

/**
 * Kill the shell AND anything it backgrounded. Both spawns below use
 * `detached: true` so the shell leads its own process group; without the group
 * kill, `npm run dev &` outlives the call it was started from and keeps our
 * stdout pipe open.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

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

  // `detached` + our own timer, not spawn's `timeout`: spawn's timeout only
  // signals the direct child, and the job was only ever marked finished from
  // `close`, which never fires while a backgrounded grandchild holds the pipe.
  // Such a job was reported "running" by job_status forever.
  const child = spawn("bash", ["-c", command], { cwd, env: { ...process.env, HOME }, detached: true });
  job.process = child;
  let truncated = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (code: number | null, note?: string) => {
    if (job.status !== "running") return;
    clearTimeout(hardTimer);
    if (drainTimer) clearTimeout(drainTimer);
    if (truncated) job.stderr += "\n[output truncated: the job produced too much]";
    if (note) job.stderr += note;
    job.exitCode = code ?? 1;
    job.status = code === 0 ? "completed" : "failed";
    job.completedAt = Date.now();
    child.stdout?.destroy();
    child.stderr?.destroy();
    job.process = null;
  };

  const hardTimer = setTimeout(() => {
    killTree(child, "SIGKILL");
    setTimeout(() => settle(124, `\n[stopped: the job ran longer than ${Math.round(timeoutMs / 1000)}s]`), DRAIN_MS);
  }, timeoutMs);

  const append = (which: "stdout" | "stderr") => (d: Buffer) => {
    if (job[which].length >= MAX_OUTPUT) return;
    job[which] += d.toString();
    if (job[which].length >= MAX_OUTPUT) {
      truncated = true;
      killTree(child, "SIGKILL");
      setTimeout(() => settle(1), DRAIN_MS);
    }
  };
  child.stdout?.on("data", append("stdout"));
  child.stderr?.on("data", append("stderr"));
  child.on("close", (code) => settle(code));
  child.on("exit", (code) => {
    if (job.status !== "running" || drainTimer) return;
    drainTimer = setTimeout(() => settle(code), DRAIN_MS);
  });
  child.on("error", (err: Error) => {
    job.stderr += err.message;
    settle(1);
  });
  return job;
}

/** Stop a running job and everything it started. */
export function stopJob(job: BgJob): void {
  if (job.process) killTree(job.process, "SIGTERM");
  job.status = "failed";
  job.completedAt = Date.now();
  job.process = null;
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
    // Same shape as startJob, and for the same reason: `bash -c "sleep 30 &"`
    // exits in milliseconds but its grandchild keeps stdout open, so a promise
    // that resolved from `close` never settled and the tool call hung for the
    // rest of the session. Nothing above this has a per-request timeout.
    const child = spawn("bash", ["-c", command], { cwd, env: { ...process.env, HOME }, detached: true });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (truncated) stderr += "\n[output truncated: the command produced too much]";
      if (timedOut) stderr += `\n[stopped: the command ran longer than ${Math.round(timeoutMs / 1000)}s]`;
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveP({ stdout, stderr, exitCode: code ?? 1 });
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGKILL");
      setTimeout(() => finish(124), DRAIN_MS);
    }, timeoutMs);

    const onData = (which: "out" | "err") => (d: Buffer) => {
      if (stdout.length + stderr.length >= MAX_OUTPUT) return;
      if (which === "out") stdout += d.toString();
      else stderr += d.toString();
      if (stdout.length + stderr.length >= MAX_OUTPUT) {
        truncated = true;
        killTree(child, "SIGKILL");
        setTimeout(() => finish(1), DRAIN_MS);
      }
    };
    child.stdout?.on("data", onData("out"));
    child.stderr?.on("data", onData("err"));
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => finish(code), DRAIN_MS);
    });
    child.on("error", (err: Error) => {
      stderr += err.message;
      finish(127);
    });
  });
}
