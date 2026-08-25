/**
 * The Coding Agent — a headless Claude Code session the assistant delegates
 * coding work to.
 *
 * `scripts/claude-ds` (installed to ~/.local/bin by install.sh) is Claude Code
 * pointed at this box's own ClawBox AI plan. The desktop app used to be nothing
 * more than a terminal typed into that wrapper. This module runs the SAME
 * wrapper non-interactively (`claude-ds -p …`) on behalf of the assistant: the
 * agent hands over a task through the MCP tool, the run works in the
 * background, and the summary comes back when it is done.
 *
 * WHY THE RUNNER LIVES IN THE WEB SERVER, NOT THE MCP PROCESS
 *
 * OpenClaw spawns the ClawBox MCP server lazily per session and reaps it after
 * ten idle minutes; a coding run routinely outlives that. The web server is the
 * one long-lived ClawBox process, it already owns the config store the wrapper
 * reads, and it is where the notices (desktop, Telegram) are sent from. The
 * MCP tools are thin callers of the routes in src/app/setup-api/coding-agent.
 *
 * WHAT A RUN MAY DO — chosen to match the blast radius the agent already has
 * through its own shell tool (`bash` on OpenClaw, Hermes' native terminal on
 * Hermes), not to exceed it:
 *   - `--permission-mode acceptEdits`: file edits inside the working folder are
 *     auto-approved; anything else Claude Code would normally ask about is
 *     silently DENIED in -p mode (it cannot ask), and every denial is counted
 *     and reported, so a task that quietly could not finish is visible as such.
 *   - `--tools` restricts the built-in tool set to files, search and Bash — no
 *     sub-agents, no web tools — and Bash runs only through the allow-list
 *     below: build/test/package tooling and read-only git. `rm -rf`,
 *     `git push`, `curl` and friends are never approved, and the deny-list
 *     names the worst of them explicitly because a deny rule beats an allow.
 *   - The credential folders `src/lib/file-guard.ts` protects are denied to
 *     Claude Code's own Read/Edit/Write as well. That is a guard rail against a
 *     mistake, not a sandbox: a shell can spell a path in ways no pattern list
 *     enumerates, exactly as mcp/README.md says of `bash`.
 *   - `--setting-sources user`: the ClawBox OS checkout's own CLAUDE.md and
 *     .claude/settings must not leak into a run that happens to sit under it
 *     (every code project does — data/code-projects is inside the repo).
 *   - The working folder is a code project by default. Any other folder must
 *     be inside the clawbox home, must not be a protected path, and must not be
 *     the ClawBox OS checkout itself: a prompt-injected "fix the OS" would
 *     otherwise edit the running product in place.
 *
 * The wrapper is spawned by absolute path with an EXPLICIT environment. Two
 * reasons: the web server runs under systemd with no ~/.local/bin on PATH, and
 * its own environment carries the session secret and service tokens, none of
 * which a coding run has any business inheriting.
 *
 * Runs are persisted to data/coding-agent-runs.json so a status question can
 * be answered across MCP restarts, and so a run the web server lost to a
 * restart is reported as failed rather than "still running" forever.
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { CONFIG_ROOT, DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { CODING_HARNESS_COMMAND, CODING_HARNESS_WRAPPER_PATH } from "@/lib/coding-harness";
import { DATA_DIR_PUBLIC_SUBTREES, isProtectedFilePath } from "@/lib/file-guard";
import { projectPath, validateProjectId } from "@/lib/code-projects";
import { announceCodingAgent } from "@/lib/coding-agent-notify";

// ─── Tunables ────────────────────────────────────────────────────────────────

/** config.json key of the owner's switch. Absent means OFF. */
export const CODING_AGENT_CONFIG_KEY = "coding_agent_enabled";

/** Wall-clock ceiling for one run. Claude Code's own retries can stall for
 *  minutes against an unreachable ClawBox AI, so this is the real backstop. */
export const RUN_TIMEOUT_MS = 20 * 60_000;
/** Agent turns before Claude Code stops on its own (`error_max_turns`). */
export const MAX_TURNS = 60;
/** Claude Code's internal cost estimate cap. Informational for an unknown
 *  model name — ClawBox AI bills by plan — but it stops a runaway loop. */
export const MAX_BUDGET_USD = 3;
export const MAX_TASK_CHARS = 4_000;
export const MAX_DIRECTORY_CHARS = 512;
/** Runs at once. A Jetson has one coding agent's worth of memory to spare,
 *  and two runs in one folder would edit each other's files. */
export const MAX_CONCURRENT_RUNS = 1;
/** Longest a status request may block waiting for a run to finish. */
export const MAX_WAIT_MS = 120_000;
/** Runs kept in data/coding-agent-runs.json, newest first. */
const MAX_RUNS_KEPT = 30;
/** Progress lines kept per run. */
const PROGRESS_KEEP = 60;
const MAX_PROGRESS_LINE_CHARS = 160;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_ERROR_CHARS = 1_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_STDOUT_LINE_CHARS = 1_000_000;
const STOP_GRACE_MS = 3_000;
/** How often progress is flushed to disk while a run is busy. */
const FLUSH_INTERVAL_MS = 1_000;

/** Claude Code tools the run may use at all (`--tools`). No Task (sub-agents
 *  multiply cost), no WebFetch/WebSearch (the appliance is offline-first and
 *  the task is local code). */
export const CLAUDE_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,NotebookEdit";

/**
 * Bash commands that run without asking. Claude Code's rule syntax: a
 * `Bash(prefix:*)` rule matches any command line starting with that prefix.
 * Build, test and package tooling plus read-only git — the things a coding
 * task needs to prove it worked. Deliberately absent: rm, curl/wget, sudo,
 * systemctl, git push/reset, anything that reaches outside the folder.
 */
export const BASH_ALLOWLIST: readonly string[] = [
  "Bash(npm:*)", "Bash(npx:*)", "Bash(bun:*)", "Bash(bunx:*)", "Bash(node:*)",
  "Bash(python3:*)", "Bash(python:*)", "Bash(pip:*)", "Bash(pip3:*)", "Bash(pytest:*)",
  "Bash(tsc:*)", "Bash(eslint:*)", "Bash(prettier:*)", "Bash(make:*)", "Bash(cargo:*)", "Bash(go:*)",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)",
  "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(pwd:*)", "Bash(echo:*)",
];

/**
 * Explicit denials. In -p mode anything outside the allow-list is refused
 * anyway; these exist because a deny rule outranks an allow rule in Claude
 * Code, so no future widening of the allow-list can reach them by accident.
 */
export const BASH_DENYLIST: readonly string[] = [
  "Bash(sudo:*)", "Bash(su:*)", "Bash(rm:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)", "Bash(scp:*)",
  "Bash(systemctl:*)", "Bash(nmcli:*)", "Bash(reboot:*)", "Bash(shutdown:*)",
  "Bash(git push:*)", "Bash(git reset:*)", "Bash(git clean:*)", "Bash(git checkout:*)",
  "Bash(openclaw:*)", "Bash(hermes:*)", "Bash(claude:*)", "Bash(claude-ds:*)", "Bash(clawbox:*)",
];

/**
 * Folders (relative to the home directory) whose contents Claude Code's own
 * file tools must not open. Mirrors PROTECTED_DIR_RES in src/lib/file-guard.ts
 * — the same list the ClawBox file tools enforce — plus the wrapper's own state
 * and this checkout's data/, which holds the ClawBox AI token the run is using.
 */
const DENIED_HOME_SUBTREES: readonly string[] = [
  ".ssh", ".openclaw", ".hermes", ".codex", ".clawkeep", ".gnupg", ".aws", ".kube", ".docker",
  ".config/gcloud", ".config/gh", ".config/rclone", ".claude", ".claude-ds",
];

// ─── Types ───────────────────────────────────────────────────────────────────

export type CodingRunStatus = "running" | "completed" | "failed" | "stopped";
export type CodingRunSource = "agent" | "owner";

export interface CodingRun {
  /** Short id, e.g. "run-k3x9q2ab". Short on purpose: MCP error text redacts
   *  every 32+ hex run, and a uuid would come out as [REDACTED]. */
  id: string;
  task: string;
  /** Absolute working folder. */
  directory: string;
  projectId: string | null;
  source: CodingRunSource;
  status: CodingRunStatus;
  startedAt: number;
  completedAt: number | null;
  /** Claude Code session id — what `resume_run_id` continues from. */
  sessionId: string | null;
  model: string | null;
  /** The run's final message: what changed, how to verify, what is left. */
  summary: string | null;
  error: string | null;
  numTurns: number;
  costUsd: number | null;
  filesTouched: string[];
  commandsRun: number;
  /** Things Claude Code wanted to do and was not allowed to. */
  permissionDenials: number;
  progress: string[];
  exitCode: number | null;
}

export interface CodingHarnessReadiness {
  ready: boolean;
  wrapperInstalled: boolean;
  claudeInstalled: boolean;
  clawaiConnected: boolean;
  /** Owner-facing sentences, one per missing piece. Empty when ready. */
  problems: string[];
}

export interface CodingAgentStatus {
  /** The owner's switch. */
  enabled: boolean;
  /** enabled AND the harness is installed and connected — i.e. a run can start. */
  ready: boolean;
  readiness: CodingHarnessReadiness;
  running: number;
  harnessCommand: string;
  maxTaskChars: number;
}

export interface StartRunInput {
  task: string;
  projectId?: string | null;
  directory?: string | null;
  resumeRunId?: string | null;
  source: CodingRunSource;
}

export type CodingAgentErrorKind = "disabled" | "not_ready" | "busy" | "invalid" | "not_found";

/** Thrown by startRun/stopRun; the routes map `kind` to a status code. */
export class CodingAgentError extends Error {
  constructor(readonly kind: CodingAgentErrorKind, message: string) {
    super(message);
    this.name = "CodingAgentError";
  }
}

// ─── The owner's switch ──────────────────────────────────────────────────────

export async function isCodingAgentEnabled(): Promise<boolean> {
  return (await configGet(CODING_AGENT_CONFIG_KEY)) === true;
}

export async function setCodingAgentEnabled(enabled: boolean): Promise<void> {
  await configSet(CODING_AGENT_CONFIG_KEY, enabled === true);
}

// ─── Readiness ───────────────────────────────────────────────────────────────

function homeDir(): string {
  return os.homedir();
}

export function wrapperPath(): string {
  return path.join(homeDir(), CODING_HARNESS_WRAPPER_PATH);
}

/**
 * The PATH a login shell on this box has, spelled out. The web server's own
 * PATH under systemd has no ~/.local/bin, so `command -v claude` inside the
 * wrapper — and any probe here that trusted process.env.PATH — would answer
 * "not installed" on a box where Claude Code works perfectly. install.sh's
 * `as_clawbox_login` uses this exact order.
 */
export function runnerPath(): string {
  const home = homeDir();
  return [
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(file); // follows symlinks
    if (!stat.isFile()) return false;
    await fs.promises.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(binary: string, pathValue: string): Promise<boolean> {
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    if (await isExecutableFile(path.join(dir, binary))) return true;
  }
  return false;
}

export async function checkReadiness(): Promise<CodingHarnessReadiness> {
  const [wrapperInstalled, claudeInstalled, token] = await Promise.all([
    isExecutableFile(wrapperPath()),
    findOnPath("claude", runnerPath()),
    configGet("clawai_token"),
  ]);
  const clawaiConnected = typeof token === "string" && token.trim() !== "";
  const problems: string[] = [];
  if (!claudeInstalled) {
    problems.push("Claude Code is not installed on this ClawBox. Run: sudo bash install.sh --step coding_harness");
  }
  if (!wrapperInstalled) {
    problems.push(`The ${CODING_HARNESS_COMMAND} wrapper is missing from ~/${CODING_HARNESS_WRAPPER_PATH}. Run: sudo bash install.sh --step coding_harness`);
  }
  if (!clawaiConnected) {
    problems.push("ClawBox AI is not connected. Open Settings → AI Models and sign in to ClawBox AI first.");
  }
  return {
    ready: problems.length === 0,
    wrapperInstalled,
    claudeInstalled,
    clawaiConnected,
    problems,
  };
}

export async function getCodingAgentStatus(): Promise<CodingAgentStatus> {
  const [enabled, readiness] = await Promise.all([isCodingAgentEnabled(), checkReadiness()]);
  return {
    enabled,
    ready: enabled && readiness.ready,
    readiness,
    running: runningCount(),
    harnessCommand: CODING_HARNESS_COMMAND,
    maxTaskChars: MAX_TASK_CHARS,
  };
}

// ─── The runs store ──────────────────────────────────────────────────────────
//
// Same discipline as src/lib/email-pending.ts: one JSON file under DATA_DIR,
// written 0600 through a temp file and an atomic rename, a corrupt file read
// as empty. SYNC fs on purpose — an await between read and write is how two
// progress events from one run would lose each other's updates.

const RUNS_PATH = path.join(DATA_DIR, "coding-agent-runs.json");
const RUN_STATUSES: readonly CodingRunStatus[] = ["running", "completed", "failed", "stopped"];

function isCodingRun(value: unknown): value is CodingRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && typeof v.task === "string"
    && typeof v.directory === "string"
    && typeof v.status === "string"
    && RUN_STATUSES.includes(v.status as CodingRunStatus)
    && typeof v.startedAt === "number"
  );
}

/** Fill in fields an older on-disk record may lack, so readers never see undefined. */
function normalizeRun(raw: CodingRun): CodingRun {
  return {
    id: raw.id,
    task: raw.task,
    directory: raw.directory,
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    source: raw.source === "owner" ? "owner" : "agent",
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : null,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    model: typeof raw.model === "string" ? raw.model : null,
    summary: typeof raw.summary === "string" ? raw.summary : null,
    error: typeof raw.error === "string" ? raw.error : null,
    numTurns: typeof raw.numTurns === "number" ? raw.numTurns : 0,
    costUsd: typeof raw.costUsd === "number" ? raw.costUsd : null,
    filesTouched: Array.isArray(raw.filesTouched) ? raw.filesTouched.filter((f) => typeof f === "string") : [],
    commandsRun: typeof raw.commandsRun === "number" ? raw.commandsRun : 0,
    permissionDenials: typeof raw.permissionDenials === "number" ? raw.permissionDenials : 0,
    progress: Array.isArray(raw.progress) ? raw.progress.filter((p) => typeof p === "string") : [],
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
  };
}

function readAll(): CodingRun[] {
  try {
    if (!fs.existsSync(RUNS_PATH)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(RUNS_PATH, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCodingRun).map(normalizeRun);
  } catch {
    // A corrupt file must not take the feature down; the next write repairs it.
    return [];
  }
}

function writeAll(list: CodingRun[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${RUNS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not lose the run record
  }
  fs.renameSync(tmp, RUNS_PATH);
}

interface LiveRun {
  child: ChildProcess;
  timeout: NodeJS.Timeout;
  killTimer: NodeJS.Timeout | null;
  stopRequested: boolean;
  timedOut: boolean;
  sawResult: boolean;
  stderr: string;
}

/** Newest first. `null` until first use. */
let runs: CodingRun[] | null = null;
const live = new Map<string, LiveRun>();
const waiters = new Map<string, Set<() => void>>();
let flushTimer: NodeJS.Timeout | null = null;
let dirty = false;
let exitHookInstalled = false;

/**
 * Load the store, and settle anything the previous web server left behind.
 * `live` is empty when this process starts, so every "running" record on disk
 * belongs to a process that no longer exists — systemd kills the whole cgroup
 * when clawbox-setup restarts at the end of an update.
 */
function loadRuns(): CodingRun[] {
  if (runs) return runs;
  runs = readAll();
  let repaired = false;
  for (const run of runs) {
    if (run.status === "running" && !live.has(run.id)) {
      run.status = "failed";
      run.error = "The ClawBox web server restarted while this run was in progress. Start it again.";
      run.completedAt = Date.now();
      repaired = true;
    }
  }
  if (repaired) {
    try {
      writeAll(runs);
    } catch (err) {
      console.error("[coding-agent] could not repair the runs file:", err instanceof Error ? err.message : err);
    }
  }
  return runs;
}

/** Called from the boot hook so a stale "running" run is settled before anyone asks. */
export function reconcileAfterRestart(): number {
  const list = loadRuns();
  return list.filter((r) => r.status === "running").length;
}

function persist(immediate = false): void {
  const list = loadRuns();
  if (immediate) {
    dirty = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      writeAll(list);
    } catch (err) {
      console.error("[coding-agent] could not write the runs file:", err instanceof Error ? err.message : err);
    }
    return;
  }
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      writeAll(loadRuns());
    } catch (err) {
      console.error("[coding-agent] could not write the runs file:", err instanceof Error ? err.message : err);
    }
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function cloneRun(run: CodingRun): CodingRun {
  return { ...run, filesTouched: [...run.filesTouched], progress: [...run.progress] };
}

export function getRun(id: string): CodingRun | null {
  const run = loadRuns().find((r) => r.id === id);
  return run ? cloneRun(run) : null;
}

export function listRuns(limit = MAX_RUNS_KEPT): CodingRun[] {
  return loadRuns().slice(0, Math.max(0, limit)).map(cloneRun);
}

export function runningCount(): number {
  return loadRuns().filter((r) => r.status === "running").length;
}

/**
 * Resolve once the run has finished, or after `timeoutMs`, whichever is first.
 * Lets a status request block instead of polling every few seconds.
 */
export function waitForRun(id: string, timeoutMs: number): Promise<CodingRun | null> {
  const run = getRun(id);
  if (!run) return Promise.resolve(null);
  if (run.status !== "running") return Promise.resolve(run);
  const ms = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS));
  if (ms === 0) return Promise.resolve(run);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.get(id)?.delete(finish);
      resolve(getRun(id));
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    set.add(finish);
  });
}

function wakeWaiters(id: string): void {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const fn of set) fn();
}

// ─── Validation ──────────────────────────────────────────────────────────────

function newRunId(): string {
  // 8 base36 characters: readable, short, and never a 32-hex run the MCP
  // redaction would blank.
  const bytes = randomBytes(6);
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return `run-${n.toString(36).padStart(8, "0").slice(-8)}`;
}

export const RUN_ID_RE = /^run-[a-z0-9]{8}$/;

function normalizeTask(task: unknown): string {
  if (typeof task !== "string") throw new CodingAgentError("invalid", "A task is required.");
  const cleaned = task.replace(/\u0000/g, "").trim();
  if (!cleaned) throw new CodingAgentError("invalid", "A task is required.");
  if (cleaned.length > MAX_TASK_CHARS) {
    throw new CodingAgentError("invalid", `The task is too long: at most ${MAX_TASK_CHARS} characters.`);
  }
  return cleaned;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realDirectory(abs: string): Promise<string> {
  let real: string;
  try {
    real = await fs.promises.realpath(abs);
  } catch {
    throw new CodingAgentError("not_found", "That folder does not exist on this ClawBox.");
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(real);
  } catch {
    throw new CodingAgentError("not_found", "That folder does not exist on this ClawBox.");
  }
  if (!stat.isDirectory()) throw new CodingAgentError("invalid", "The working folder must be a directory.");
  return real;
}

/**
 * Where the run works. A project id is the normal case; an explicit folder is
 * accepted under the rules in the header. Returns the real (symlink-resolved)
 * absolute path, which is also what is recorded on the run.
 */
export async function resolveWorkingDirectory(input: {
  projectId?: string | null;
  directory?: string | null;
}): Promise<{ directory: string; projectId: string | null }> {
  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null;
  const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;

  if (projectId) {
    if (!validateProjectId(projectId)) throw new CodingAgentError("invalid", "Invalid project id.");
    const dir = projectPath(projectId);
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new CodingAgentError("not_found", "There is no code project with that id on this ClawBox.");
    }
    return { directory: await realDirectory(dir), projectId };
  }

  if (!directory) {
    throw new CodingAgentError("invalid", "Give a code project id or a folder to work in.");
  }
  if (directory.length > MAX_DIRECTORY_CHARS) {
    throw new CodingAgentError("invalid", "The folder path is too long.");
  }
  if (!path.isAbsolute(directory)) {
    throw new CodingAgentError("invalid", "The folder must be an absolute path.");
  }
  const real = await realDirectory(path.resolve(directory));

  // A code project's folder is always fine, wherever the checkout lives (a
  // dev box keeps it under the working directory, not the home). Spelling it
  // as a path rather than an id still records which project it was.
  const checkout = await fs.promises.realpath(CONFIG_ROOT).catch(() => CONFIG_ROOT);
  const projects = path.join(checkout, "data", "code-projects");
  if (isInside(real, projects) && real !== projects) {
    const id = path.relative(projects, real).split(path.sep)[0];
    return { directory: real, projectId: validateProjectId(id) ? id : null };
  }

  const home = await fs.promises.realpath(homeDir()).catch(() => homeDir());
  if (!isInside(real, home)) {
    throw new CodingAgentError("invalid", "The working folder must be inside the ClawBox home directory.");
  }
  // Not the home itself: `acceptEdits` auto-approves every edit UNDER the
  // working folder, and under the home that includes ~/.bashrc and friends.
  if (real === home) {
    throw new CodingAgentError("invalid", "Use a folder inside the home directory, not the home directory itself.");
  }
  if (isProtectedFilePath(real)) {
    throw new CodingAgentError("invalid", "That folder holds credentials or ClawBox's own state and cannot be a working folder.");
  }
  for (const sub of DENIED_HOME_SUBTREES) {
    if (isInside(real, path.join(home, sub))) {
      throw new CodingAgentError("invalid", "That folder holds credentials or ClawBox's own state and cannot be a working folder.");
    }
  }
  if (isInside(real, checkout)) {
    throw new CodingAgentError(
      "invalid",
      "The ClawBox OS checkout itself is off limits. Use a code project or another folder in the home directory.",
    );
  }
  return { directory: real, projectId: null };
}

// ─── Spawning ────────────────────────────────────────────────────────────────

/**
 * What Claude Code is told on top of its defaults. It is running unattended:
 * nobody can answer a question, and the final message IS the deliverable the
 * assistant relays to the person.
 */
export const HEADLESS_BRIEF = [
  "You are running unattended on a ClawBox — a small Linux device on someone's desk — inside the folder you were started in, on behalf of the device's assistant.",
  "Nobody can answer questions, so make sensible assumptions and keep going. Stay inside this folder; do not install system packages or change device settings.",
  "Verify your work where you can (run the build or the tests you have).",
  "Your final message is delivered to the person who delegated the task. State what you changed (file names), how they can check it, and anything you could not finish.",
].join(" ");

const FILE_TOOLS = ["Read", "Edit", "Write"] as const;
/** Always denied under data/, whether or not they exist yet. */
const DATA_SECRET_FILES = ["config.json", "kv.json", ".mcp-token", ".session-secret", "email-pending.json", "coding-agent-runs.json"];

/**
 * Claude Code's Read/Edit/Write rules for the paths a run must not open.
 * `//` = absolute path in that rule syntax (a single leading slash would mean
 * "relative to the project root").
 *
 * data/ is NOT denied wholesale: a deny rule outranks `acceptEdits`, and the
 * run's own working folder is usually data/code-projects/<id>. Instead every
 * entry of data/ is denied individually except the public subtrees — the same
 * containment rule file-guard applies to the ClawBox file tools.
 */
export function fileDenyRules(): string[] {
  const home = homeDir();
  const rules: string[] = [];
  const denyTree = (root: string) => {
    for (const tool of FILE_TOOLS) rules.push(`${tool}(/${root}/**)`);
  };
  const denyFile = (file: string) => {
    for (const tool of FILE_TOOLS) rules.push(`${tool}(/${file})`);
  };
  for (const sub of DENIED_HOME_SUBTREES) denyTree(path.join(home, sub));

  const dataEntries = new Set<string>(DATA_SECRET_FILES);
  try {
    for (const entry of fs.readdirSync(DATA_DIR)) dataEntries.add(entry);
  } catch {
    // no data dir yet — the fixed list above still applies
  }
  for (const entry of [...dataEntries].sort()) {
    if (DATA_DIR_PUBLIC_SUBTREES.has(entry)) continue;
    const abs = path.join(DATA_DIR, entry);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      // listed but absent: treat as a file
    }
    if (isDir) denyTree(abs);
    else denyFile(abs);
  }
  denyFile(path.join(CONFIG_ROOT, ".env"));
  return rules;
}

/** True when a Read/Edit/Write deny rule would cover `directory` — the check the contract test runs. */
export function denyRulesCover(rules: readonly string[], directory: string): boolean {
  return rules.some((rule) => {
    const m = /^(?:Read|Edit|Write)\(\/(.+?)(\/\*\*)?\)$/.exec(rule);
    if (!m) return false;
    const root = m[1];
    return m[2] ? isInside(directory, root) : directory === root;
  });
}

/** The argv handed to the wrapper. Exported for the contract test. */
export function buildRunArgs(opts: { resumeSessionId?: string | null }): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--permission-mode", "acceptEdits",
    "--setting-sources", "user",
    "--max-turns", String(MAX_TURNS),
    "--max-budget-usd", String(MAX_BUDGET_USD),
    "--append-system-prompt", HEADLESS_BRIEF,
  ];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // The three tool flags are variadic and swallow any positional that follows,
  // which is why the task travels on stdin and these come last.
  args.push("--tools", CLAUDE_TOOLS);
  args.push("--allowedTools", ...BASH_ALLOWLIST);
  args.push("--disallowedTools", ...BASH_DENYLIST, ...fileDenyRules());
  return args;
}

/** The environment a run gets — and nothing else. Exported for the contract test. */
export function buildRunEnv(): Record<string, string> {
  const home = homeDir();
  const user = process.env.USER || process.env.LOGNAME || path.basename(home);
  const env: Record<string, string> = {
    HOME: home,
    USER: user,
    LOGNAME: user,
    PATH: runnerPath(),
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    CLAWBOX_ROOT: CONFIG_ROOT,
    // No update checks, no telemetry: the appliance may be offline, and a run
    // that stalls on a version check is a run that looks hung.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  // The device's own overrides for the wrapper, when the owner set them.
  for (const key of ["CLAWBOX_AI_PROXY_URL", "CLAUDE_DS_MODEL", "CLAUDE_DS_SMALL_MODEL", "CLAUDE_DS_EFFORT", "CLAUDE_DS_CONFIG_DIR"]) {
    const value = process.env[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  return env;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function pushProgress(run: CodingRun, line: string): void {
  const cleaned = line.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  run.progress.push(cleaned.length > MAX_PROGRESS_LINE_CHARS ? `${cleaned.slice(0, MAX_PROGRESS_LINE_CHARS - 1)}…` : cleaned);
  if (run.progress.length > PROGRESS_KEEP) run.progress.splice(0, run.progress.length - PROGRESS_KEEP);
}

function relativeToRun(run: CodingRun, file: unknown): string | null {
  if (typeof file !== "string" || !file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(run.directory, file);
  return isInside(abs, run.directory) ? path.relative(run.directory, abs) || "." : abs;
}

function noteFile(run: CodingRun, file: string | null): void {
  if (!file || run.filesTouched.includes(file)) return;
  run.filesTouched.push(file);
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: unknown };
  result?: unknown;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  permission_denials?: unknown;
  errors?: unknown;
}

/** One line of `--output-format stream-json`. */
function handleEvent(run: CodingRun, state: LiveRun, event: StreamEvent): void {
  if (typeof event.session_id === "string" && event.session_id && !run.sessionId) run.sessionId = event.session_id;

  if (event.type === "system" && event.subtype === "init") {
    if (typeof event.model === "string" && event.model) run.model = event.model;
    pushProgress(run, `Started${run.model ? ` with ${run.model}` : ""}`);
    return;
  }

  if (event.type === "assistant") {
    const raw = event.message?.content;
    const content = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        pushProgress(run, block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
        switch (block.name) {
          case "Bash":
            run.commandsRun += 1;
            pushProgress(run, `$ ${typeof input.command === "string" ? input.command : ""}`);
            break;
          case "Write":
          case "Edit":
          case "NotebookEdit": {
            const file = relativeToRun(run, input.file_path ?? input.notebook_path);
            noteFile(run, file);
            pushProgress(run, `${block.name} ${file ?? ""}`);
            break;
          }
          case "Read":
            pushProgress(run, `Read ${relativeToRun(run, input.file_path) ?? ""}`);
            break;
          case "Glob":
          case "Grep":
            pushProgress(run, `${block.name} ${typeof input.pattern === "string" ? input.pattern : ""}`);
            break;
          default:
            pushProgress(run, `${block.name}`);
        }
      }
    }
    return;
  }

  if (event.type === "result") {
    state.sawResult = true;
    if (typeof event.num_turns === "number") run.numTurns = event.num_turns;
    if (typeof event.total_cost_usd === "number") run.costUsd = event.total_cost_usd;
    if (Array.isArray(event.permission_denials)) run.permissionDenials = event.permission_denials.length;
    const text = typeof event.result === "string" ? event.result.trim() : "";
    if (text) run.summary = text.slice(0, MAX_SUMMARY_CHARS);
    switch (event.subtype) {
      case "success":
        run.status = event.is_error ? "failed" : "completed";
        if (event.is_error && !run.error) run.error = (text || "Claude Code reported an error.").slice(0, MAX_ERROR_CHARS);
        break;
      case "error_max_turns":
        run.status = "failed";
        run.error = `Stopped after ${run.numTurns || MAX_TURNS} turns without finishing. Resume it with a narrower task, or split the work.`;
        break;
      case "error_max_budget_usd":
        run.status = "failed";
        run.error = "Stopped at the cost ceiling for one run. Resume it with a narrower task, or split the work.";
        break;
      default: {
        run.status = "failed";
        const errors = Array.isArray(event.errors) ? event.errors.filter((e) => typeof e === "string").join("; ") : "";
        run.error = (errors || text || "Claude Code stopped with an error.").slice(0, MAX_ERROR_CHARS);
      }
    }
  }
}

/** The wrapper's own diagnostics, minus its start-up banner. */
function stderrTail(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^claude-ds: ClawBox AI \(/.test(l));
  return lines.slice(-4).join(" ").slice(0, MAX_ERROR_CHARS);
}

function finishRun(run: CodingRun, state: LiveRun, exitCode: number | null): void {
  if (run.status === "running") {
    if (state.stopRequested) {
      run.status = "stopped";
      run.error = run.error ?? "Stopped before it finished.";
    } else if (state.timedOut) {
      run.status = "failed";
      run.error = `Ran longer than ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes and was stopped.`;
    } else {
      run.status = "failed";
      const tail = stderrTail(state.stderr);
      run.error = tail || `Claude Code exited with code ${exitCode ?? "unknown"} before reporting a result.`;
    }
  }
  // A stop that raced the final message keeps "completed": the work is done.
  run.exitCode = exitCode;
  run.completedAt = Date.now();
  clearTimeout(state.timeout);
  if (state.killTimer) clearTimeout(state.killTimer);
  live.delete(run.id);
  pushProgress(run, `Finished: ${run.status}`);
  persist(true);
  wakeWaiters(run.id);
  console.error(`[coding-agent] ${run.id} ${run.status} after ${Math.round((run.completedAt - run.startedAt) / 1000)}s (${run.numTurns} turns)`);
  void announceCodingAgent(cloneRun(run)).catch((err: unknown) => {
    console.error("[coding-agent] announce failed:", err instanceof Error ? err.message : err);
  });
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const state of live.values()) killTree(state.child, "SIGTERM");
  });
}

function spawnRun(run: CodingRun, resumeSessionId: string | null): void {
  const args = buildRunArgs({ resumeSessionId });
  const child = spawn(wrapperPath(), args, {
    cwd: run.directory,
    // Deliberately NOT process.env: see the header. The cast is only because
    // this repo's ProcessEnv augmentation insists on NODE_ENV, which a run has
    // no use for.
    env: buildRunEnv() as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state: LiveRun = {
    child,
    timeout: setTimeout(() => {
      state.timedOut = true;
      killTree(child, "SIGTERM");
      state.killTimer = setTimeout(() => killTree(child, "SIGKILL"), STOP_GRACE_MS);
      state.killTimer.unref();
    }, RUN_TIMEOUT_MS),
    killTimer: null,
    stopRequested: false,
    timedOut: false,
    sawResult: false,
    stderr: "",
  };
  state.timeout.unref();
  live.set(run.id, state);
  installExitHook();

  let settled = false;
  const settle = (code: number | null) => {
    if (settled) return;
    settled = true;
    finishRun(run, state, code);
  };

  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let nl = stdoutBuffer.indexOf("\n");
    while (nl >= 0) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line && line.length <= MAX_STDOUT_LINE_CHARS && line.startsWith("{")) {
        try {
          handleEvent(run, state, JSON.parse(line) as StreamEvent);
          persist();
        } catch {
          // not JSON — Claude Code prints the odd plain line; ignore it
        }
      }
      nl = stdoutBuffer.indexOf("\n");
    }
    if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) stdoutBuffer = "";
  });
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-MAX_STDERR_CHARS);
  });

  child.on("error", (err) => {
    // Typically ENOENT: the wrapper is not where install.sh puts it.
    run.status = "failed";
    run.error = `Could not start ${CODING_HARNESS_COMMAND}: ${err.message}`.slice(0, MAX_ERROR_CHARS);
    settle(null);
  });
  // Settle on `exit` after a short drain rather than on `close`: a grandchild
  // holding the pipes open would otherwise keep a finished run "running".
  child.on("exit", (code) => {
    setTimeout(() => settle(code), 250).unref();
  });
  child.on("close", (code) => settle(code));

  try {
    child.stdin?.on("error", () => {
      // EPIPE when the wrapper dies before reading the task; `exit` reports it.
    });
    child.stdin?.end(run.task);
  } catch {
    // reported through the exit path
  }
}

// ─── Public operations ───────────────────────────────────────────────────────

export async function startRun(input: StartRunInput): Promise<CodingRun> {
  const task = normalizeTask(input.task);

  if (!(await isCodingAgentEnabled())) {
    throw new CodingAgentError("disabled", "The coding agent is switched off. The owner can turn it on in Settings → System → Coding agent.");
  }
  const readiness = await checkReadiness();
  if (!readiness.ready) {
    throw new CodingAgentError("not_ready", readiness.problems.join(" "));
  }

  let resumeSessionId: string | null = null;
  let directory: string;
  let projectId: string | null;

  const resumeRunId = typeof input.resumeRunId === "string" ? input.resumeRunId.trim() : "";
  if (resumeRunId) {
    const previous = loadRuns().find((r) => r.id === resumeRunId);
    if (!previous) throw new CodingAgentError("not_found", "There is no coding run with that id to resume.");
    if (previous.status === "running") throw new CodingAgentError("busy", "That run is still in progress; wait for it to finish before resuming it.");
    if (!previous.sessionId) throw new CodingAgentError("invalid", "That run never started a Claude Code session, so it cannot be resumed. Start a new run instead.");
    // The session lives in the wrapper's state dir keyed by the folder it ran
    // in, so a resume always happens where the original run happened.
    directory = await realDirectory(previous.directory);
    projectId = previous.projectId;
    resumeSessionId = previous.sessionId;
  } else {
    ({ directory, projectId } = await resolveWorkingDirectory(input));
  }

  const list = loadRuns();
  const active = list.filter((r) => r.status === "running");
  if (active.length >= MAX_CONCURRENT_RUNS) {
    throw new CodingAgentError("busy", `A coding run is already in progress (${active[0].id}). Wait for it or stop it first.`);
  }

  const run: CodingRun = {
    id: newRunId(),
    task,
    directory,
    projectId,
    source: input.source === "owner" ? "owner" : "agent",
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
    sessionId: null,
    model: null,
    summary: null,
    error: null,
    numTurns: 0,
    costUsd: null,
    filesTouched: [],
    commandsRun: 0,
    permissionDenials: 0,
    progress: [],
    exitCode: null,
  };
  if (resumeSessionId) pushProgress(run, "Resuming the previous session");

  list.unshift(run);
  // Never drop a running run; trim the oldest finished ones.
  while (list.length > MAX_RUNS_KEPT) {
    const idx = findLastFinished(list);
    if (idx < 0) break;
    list.splice(idx, 1);
  }
  persist(true);
  console.error(`[coding-agent] ${run.id} started by ${run.source} in ${run.directory}`);
  spawnRun(run, resumeSessionId);
  return cloneRun(run);
}

function findLastFinished(list: CodingRun[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].status !== "running") return i;
  }
  return -1;
}

/** Idempotent: stopping a finished run just returns it. */
export function stopRun(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status !== "running") return cloneRun(run);
  const state = live.get(id);
  if (!state) {
    // On disk as running but not ours — a record from a previous process that
    // loadRuns() did not get to repair. Settle it here.
    run.status = "stopped";
    run.error = "Stopped.";
    run.completedAt = Date.now();
    persist(true);
    wakeWaiters(id);
    return cloneRun(run);
  }
  if (!state.stopRequested) {
    state.stopRequested = true;
    pushProgress(run, "Stop requested");
    killTree(state.child, "SIGTERM");
    state.killTimer = setTimeout(() => killTree(state.child, "SIGKILL"), STOP_GRACE_MS);
    state.killTimer.unref();
    persist();
  }
  return cloneRun(run);
}

/** Test hook: forget in-memory state so the next call re-reads the file. */
export function _resetCodingAgentStateForTests(): void {
  for (const state of live.values()) {
    clearTimeout(state.timeout);
    if (state.killTimer) clearTimeout(state.killTimer);
    killTree(state.child, "SIGKILL");
  }
  live.clear();
  waiters.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  dirty = false;
  runs = null;
}
