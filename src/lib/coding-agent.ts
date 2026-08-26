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
 *   - The run starts with NO Linux capabilities. `clawbox-setup.service` grants
 *     the web server `CAP_NET_BIND_SERVICE`, `CAP_NET_ADMIN` and `CAP_NET_RAW`
 *     as AMBIENT capabilities so it can manage WiFi and bind port 80, and
 *     ambient capabilities are inherited across execve by design — so without
 *     this a run held `CapAmb=0x3400` while the agent's own shell tool, which
 *     the gateway spawns, held none. Measured on a real box: a run asked for
 *     `python3 -c "…/proc/self/status…"` — an allow-listed interpreter, so no
 *     tool policy applied — and printed the three capabilities back. That is
 *     more power than the bar this feature is held to, so the wrapper is
 *     spawned through `setpriv` with the ambient and inheritable sets emptied
 *     and no-new-privs set. Readiness refuses to start a run when `setpriv` is
 *     missing rather than quietly running with the capabilities.
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
import { DATA_DIR_PUBLIC_SUBTREES, isProtectedFilePath, PROTECTED_HOME_DIRS } from "@/lib/file-guard";
import { projectPath, validateProjectId } from "@/lib/code-projects";
import { announceCodingAgent } from "@/lib/coding-agent-notify";
import { commitRunWork } from "@/lib/coding-git";

// ─── Tunables ────────────────────────────────────────────────────────────────

/** config.json key of the owner's switch. Absent means OFF. */
export const CODING_AGENT_CONFIG_KEY = "coding_agent_enabled";
/**
 * config.json key of the folder a run works in when the caller names neither a
 * project nor a directory. Absent means "no default": a run must then say
 * where it works, as it always had to.
 *
 * It is stored as the owner typed it and re-validated on EVERY use, never
 * trusted because it was validated once when it was set. The containment rules
 * are the same ones an explicit directory faces — a default is a convenience,
 * not a way around them.
 */
export const CODING_AGENT_DIR_CONFIG_KEY = "coding_agent_default_directory";

/**
 * How hard Claude Code thinks per turn (`--effort`, via the wrapper's
 * CLAUDE_DS_EFFORT). These are the levels the installed CLI accepts — it
 * warns and falls back to its default on anything else, so the set is
 * validated here rather than passed through.
 *
 * Higher is slower and costs more; on a Jetson the difference is felt. "max"
 * stays the default because a delegated run is unattended: the owner is not
 * watching to notice it gave up early.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/**
 * The levels the app offers, as opposed to the ones the CLI accepts.
 *
 * Measured on this box, same prompt, deepseek-v4-pro[1m], reasoning tokens:
 *
 *     low 82   medium 94   high 102   xhigh 139   max 414
 *
 * The effort does reach the model — the request carries
 * output_config {"effort": "..."} and it changes with the flag — but low,
 * medium and high land within noise of each other. Offering five buttons
 * where three do the same thing teaches a false model of the machine, so the
 * picker shows the three that measurably differ. All five stay valid for
 * anyone setting the config key directly.
 */
export const OFFERED_EFFORT_LEVELS: readonly CodingEffort[] = ["low", "xhigh", "max"];
export type CodingEffort = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: CodingEffort = "max";
export const CODING_AGENT_EFFORT_CONFIG_KEY = "coding_agent_effort";


/**
 * Full command access and sub-agents are BOTH permanent now, at the owner's
 * instruction. They were switches; the switches are gone.
 *
 * What that settles, so nobody has to rediscover it:
 *
 *   - Every command runs without asking. There is no command policy.
 *   - Claude Code's own Read/Edit/Write tools still refuse the credential
 *     paths, and that is worth keeping because it costs nothing — but it does
 *     NOT hold against Bash. `python3 -c "open('.../config.json').read()"`
 *     reads the file, measured on the box. A tool-name policy cannot fence an
 *     interpreter, so in practice a run can read and write anything the
 *     clawbox user can.
 *   - What still holds: the working folder must resolve inside the ClawBox
 *     home and never the OS checkout, and setpriv still empties the ambient
 *     capability set.
 *
 * Real containment would be an OS boundary — a user that cannot read those
 * files — not a switch.
 */

/** Wall-clock ceiling for one run. Claude Code's own retries can stall for
 *  minutes against an unreachable ClawBox AI, so this is the real backstop. */
/**
 * How long a run may go with NO sign of life before the device calls it stuck.
 *
 * This used to be a wall-clock ceiling — twenty minutes from spawn, whatever
 * the run was doing — which quietly made a long project impossible: a build
 * that was working perfectly well was killed mid-flight for the crime of
 * taking a while. Real projects run for hours.
 *
 * So the question is no longer "how long has it been alive" but "is it doing
 * anything". Every stream event stamps lastActivityAt, and only silence
 * counts against a run. Runaway cost is bounded separately and properly, by
 * the owner's step and token ceilings; this is only here so a wedged process cannot
 * hold the one-run-at-a-time slot forever.
 */
export const RUN_IDLE_TIMEOUT_MS = 30 * 60_000;
/** How often the idle check runs. */
const IDLE_CHECK_MS = 60_000;
/** Agent turns before Claude Code stops on its own (`error_max_turns`). */
/** Default agent turns before Claude Code stops itself. The owner can change
 *  it; a long project needs more than a short one. */
export const DEFAULT_MAX_TURNS = 150;
export const MIN_MAX_TURNS = 10;
export const MAX_MAX_TURNS = 2_000;
export const CODING_AGENT_TURNS_CONFIG_KEY = "coding_agent_max_turns";

/**
 * Optional ceiling on the tokens one run may spend. Null means no ceiling.
 *
 * Claude Code has no flag for this — only --max-budget-usd, which prices an
 * unknown model name and so meant nothing here — so the device enforces it
 * from the usage the stream already reports, and stops the run itself.
 *
 * Counted the way a bill is: every request pays for the input it carries, so
 * input is summed per turn even though the conversation repeats. Cache reads
 * are cheaper than fresh input but are not free, so they count too.
 */
export const CODING_AGENT_TOKENS_CONFIG_KEY = "coding_agent_token_limit";
export const MIN_TOKEN_LIMIT = 10_000;
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

/**
 * The run is spawned through this, not directly, so it starts with an empty
 * ambient and inheritable capability set. See the header: the web server holds
 * CAP_NET_ADMIN and CAP_NET_RAW ambiently and every child would otherwise keep
 * them. `--no-new-privs` is here for the same reason — a run has no business
 * regaining through a setuid binary what these flags just took away.
 */
export const CAPABILITY_DROP_COMMAND = "setpriv";
export const CAPABILITY_DROP_ARGS: readonly string[] = [
  "--ambient-caps=-all",
  "--inh-caps=-all",
  "--no-new-privs",
  "--",
];

/** Claude Code tools the run may use at all (`--tools`). No WebFetch/WebSearch:
 *  the appliance is offline-first and the task is local code. Task (sub-agents)
 *  is added only when the owner has switched them on — see
 *  CODING_AGENT_SUBAGENTS_CONFIG_KEY. */
export const CLAUDE_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,NotebookEdit";
/**
 * Claude Code's sub-agent tool, as it appears in `--tools` and in the stream.
 *
 * It is "Agent". This was "Task" — a name the binary also contains — and the
 * mismatch is why every run reported subagentsTotal 0 while the transcripts
 * showed real delegation: the runs WERE handing work to the explorer, and the
 * parser was counting a tool nobody had called. Both names are recognised on
 * the way in so a version that renames it back cannot silence the count
 * again.
 */
export const SUBAGENT_TOOL = "Agent";

/**
 * The sub-agents a run may hand work to.
 *
 * Without these the Task tool exists and is never used: every run on this box
 * reported subagentsTotal 0, because the main model has nothing to delegate
 * TO. Claude Code reads the `description` to decide, which is why each one
 * says "Use proactively" — that phrasing is what actually triggers a hand-off.
 *
 * The model split follows what the two DeepSeek tiers are good at. Flash and
 * Pro share the same 1M window, Flash is roughly three times cheaper, and
 * sub-agents spend most of their tokens READING — files, logs, test output —
 * and hand back a short summary the main model re-checks. So reading and
 * summarising go to Flash, and anything that writes code stays on the main
 * model, where multi-constraint correctness is measurably better.
 *
 * Deliberately no "builder" agent: writing the code is the run's own job, and
 * delegating it would put the expensive judgement behind a summary.
 */
export const SUBAGENT_DEFINITIONS = {
  explorer: {
    description:
      "Searches and maps a codebase: finds where something lives, which files "
      + "matter, how a pattern is used. Use proactively before editing "
      + "unfamiliar code, and whenever a question spans several files.",
    prompt:
      "You map code and report findings. Read and search only — never edit. "
      + "Answer with file paths and line numbers, the shortest excerpt that "
      + "proves the point, and nothing else. Say plainly when you did not find "
      + "something rather than guessing.",
    tools: ["Read", "Grep", "Glob"],
    model: "deepseek-v4-flash",
  },
  tester: {
    description:
      "Runs a build, a test suite or a script and reports what failed. Use "
      + "proactively after making changes, to check the work actually holds.",
    prompt:
      "You verify work. Run the build or tests you were asked to run, then "
      + "report ONLY the outcome: pass or fail, the failing cases, and the "
      + "exact error lines. Never edit a file. If a command is refused, say so "
      + "and say which command.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "deepseek-v4-flash",
  },
  reviewer: {
    description:
      "Reads finished changes and reports real defects — bugs, unsafe handling, "
      + "obvious omissions. Use proactively before reporting a task complete.",
    prompt:
      "You review changes already made. Read only — never edit. Report only "
      + "defects you can point at in the code, each with a file, a line and "
      + "what goes wrong. If the change looks correct, say so in one line "
      + "rather than inventing something to say.",
    tools: ["Read", "Grep", "Glob"],
    model: "deepseek-v4-flash",
  },
} as const;

export type SubagentName = keyof typeof SUBAGENT_DEFINITIONS;

export function toolsFor(subagents: boolean): string {
  return subagents ? `${CLAUDE_TOOLS},${SUBAGENT_TOOL}` : CLAUDE_TOOLS;
}

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
  // Read-only queries a real run asked for and was refused; they change nothing.
  "Bash(git rev-parse:*)", "Bash(git check-ignore:*)", "Bash(git show:*)", "Bash(git branch:*)",
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
 * file tools must not open: the credential stores file-guard protects for the
 * ClawBox file tools — the SAME list, imported, so the two cannot drift — plus
 * Claude Code's own state directories (transcripts of every run and of the
 * owner's interactive sessions).
 */
const DENIED_HOME_SUBTREES: readonly string[] = [...PROTECTED_HOME_DIRS, ".claude", ".claude-ds"];

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
  /**
   * WHICH ones, in the owner's words: "Bash: git -C . log --oneline -3".
   *
   * The count alone was not diagnosable — working out what a run had been
   * refused meant reading the progress lines and inferring. This is the
   * owner's own surface, and it holds the same class of text `progress`
   * already does: the command the agent tried, not anything the model wrote
   * about it. Capped, and never sent to Telegram — that notice stays a
   * template.
   */
  deniedActions: string[];
  /** The effort the run was started with. Recorded per-run because the owner
   *  can change the setting while a run is in flight. */
  effort: CodingEffort;
  /** Sub-agents working RIGHT NOW. Always 0 once the run has settled — a
   *  sub-agent cannot outlive the run that spawned it. */
  subagentsActive: number;
  /** WHICH ones, so the app can show what each is doing rather than a count. */
  activeSubagents: ActiveSubagent[];
  /** Sub-agents this run spawned in total, live or finished. */
  subagentsTotal: number;
  /** The commit this run's work was recorded as, when it changed anything. */
  commit: string | null;
  /** How many of each kind — explorer, tester, reviewer. */
  subagentsByType: Record<string, number>;
  /** Every model that did work for this run, main and sub-agents alike. */
  modelsUsed: string[];
  /** The step ceiling this run started with. */
  maxTurns: number;
  /** Tokens spent so far, summed the way a bill is — see the config key. */
  tokensUsed: number;
  /** The ceiling that applied, or null when the run was uncapped. */
  tokenLimit: number | null;
  /**
   * Reasoning tokens Claude Code reports so far.
   *
   * Without this a run on `effort: max` looks identical to a hung one: the
   * first turn of a big task can spend minutes thinking before it emits a
   * single word, and `numTurns` only arrives with the final result event. On
   * a real box that cost a healthy run — the assistant read "0 turns, no
   * progress" and called coding_agent_stop at 295 seconds.
   */
  thinkingTokens: number;
  /** When the run last showed ANY sign of life. The answer to "is it stuck?". */
  lastActivityAt: number;
  /**
   * Automatic restarts after a transient upstream failure. At most one, and
   * only for a run that had done no work — see TRANSIENT_FAILURE_RE.
   */
  retries: number;
  /**
   * Whether RESUMING this run's session could help.
   *
   * True only where the session holds real work and merely ran out of room —
   * a turn or cost ceiling. False for a run that died on authentication or
   * transport, because Claude Code persists that failure IN the session and
   * replays it on every resume: observed on a real box, where a transient
   * upstream error at 09:01 was resumed at 09:05 into the same session id and
   * failed identically. A resume is then not a retry, it is a re-enactment.
   */
  resumable: boolean;
  progress: string[];
  exitCode: number | null;
}

/** One sub-agent currently out, as the owner should read it. */
export interface ActiveSubagent {
  /** Which definition it is — explorer, tester, reviewer. */
  type: string;
  /** What it was asked to do, in the run's own words. */
  description: string;
  startedAt: number;
}

export interface CodingHarnessReadiness {
  ready: boolean;
  wrapperInstalled: boolean;
  claudeInstalled: boolean;
  clawaiConnected: boolean;
  /**
   * Whether `setpriv` is here to strip the web server's inherited network
   * capabilities off the run. False means no run may start: see the header.
   */
  capabilityDropAvailable: boolean;
  /** Owner-facing sentences, one per missing piece. Empty when ready. */
  problems: string[];
}

export interface CodingAgentStatus {
  /** The owner's switch. */
  enabled: boolean;
  /** The owner's default working folder, or null when they have not set one. */
  defaultDirectory: string | null;
  /** enabled AND the harness is installed and connected — i.e. a run can start. */
  ready: boolean;
  readiness: CodingHarnessReadiness;
  running: number;
  harnessCommand: string;
  maxTaskChars: number;
  /** How hard a run thinks per turn. */
  effort: CodingEffort;
  /** The levels the app should show — see OFFERED_EFFORT_LEVELS. */
  effortLevels: readonly CodingEffort[];
  /** Folders in the default project folder the assistant may work in. */
  projectFolders: string[];
  /** The ceilings a run stops at, so the app can show them without guessing. */
  /** Agent steps a run gets, and the range the owner may choose from. */
  maxTurns: number;
  minMaxTurns: number;
  maxMaxTurns: number;
  /** Token ceiling the device enforces, or null for none. */
  tokenLimit: number | null;
  minTokenLimit: number;
  /** Silence, not total time, is what ends a run. */
  runIdleTimeoutMs: number;
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

/** The owner's default working folder, or null when they have not set one. */
export async function getDefaultDirectory(): Promise<string | null> {
  const raw = await configGet(CODING_AGENT_DIR_CONFIG_KEY);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Set (or clear, with null/"") the default working folder.
 *
 * Validated here rather than only at the route so there is one answer to "is
 * this folder allowed", and it is the same answer a run gets. Returns the
 * resolved path so the owner sees what the device actually recorded — a
 * symlink is stored as the folder it leads to, not as the name they typed.
 */
export async function setDefaultDirectory(directory: string | null): Promise<string | null> {
  if (directory === null || directory.trim() === "") {
    await configSet(CODING_AGENT_DIR_CONFIG_KEY, undefined);
    return null;
  }
  const { directory: resolved } = await resolveWorkingDirectory({ directory });
  await configSet(CODING_AGENT_DIR_CONFIG_KEY, resolved);
  return resolved;
}

function isEffort(value: unknown): value is CodingEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Where Claude Code keeps this run's transcript.
 *
 * It encodes the working folder by replacing every slash with a dash, so
 * /home/clawbox/x becomes -home-clawbox-x. Returns null until the run has a
 * session id, which arrives with the first stream event.
 *
 * The file exists and grows WHILE the run works, which is what makes a live
 * preview possible rather than only a post-mortem.
 */
export function transcriptPath(run: Pick<CodingRun, "sessionId" | "directory">): string | null {
  if (!run.sessionId) return null;
  const configDir = process.env.CLAUDE_DS_CONFIG_DIR || path.join(homeDir(), ".claude-ds");
  return path.join(configDir, "projects", run.directory.replace(/\//g, "-"), `${run.sessionId}.jsonl`);
}

/** The owner's effort level. Anything unrecognised reads as the default. */
export async function getEffort(): Promise<CodingEffort> {
  const raw = await configGet(CODING_AGENT_EFFORT_CONFIG_KEY);
  return isEffort(raw) ? raw : DEFAULT_EFFORT;
}

export async function setEffort(effort: string): Promise<CodingEffort> {
  if (!isEffort(effort)) {
    throw new CodingAgentError("invalid", `Effort must be one of: ${EFFORT_LEVELS.join(", ")}.`);
  }
  await configSet(CODING_AGENT_EFFORT_CONFIG_KEY, effort);
  return effort;
}


/** The owner's turn ceiling, clamped to something the CLI will accept. */
export async function getMaxTurns(): Promise<number> {
  const raw = await configGet(CODING_AGENT_TURNS_CONFIG_KEY);
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_TURNS;
  return Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.round(raw)));
}

export async function setMaxTurns(turns: unknown): Promise<number> {
  if (typeof turns !== "number" || !Number.isFinite(turns)) {
    throw new CodingAgentError("invalid", "Steps must be a number.");
  }
  const n = Math.round(turns);
  if (n < MIN_MAX_TURNS || n > MAX_MAX_TURNS) {
    throw new CodingAgentError("invalid", `Steps must be between ${MIN_MAX_TURNS} and ${MAX_MAX_TURNS}.`);
  }
  await configSet(CODING_AGENT_TURNS_CONFIG_KEY, n);
  return n;
}

/** The owner's token ceiling, or null when they have not set one. */
export async function getTokenLimit(): Promise<number | null> {
  const raw = await configGet(CODING_AGENT_TOKENS_CONFIG_KEY);
  return typeof raw === "number" && Number.isFinite(raw) && raw >= MIN_TOKEN_LIMIT ? Math.round(raw) : null;
}

export async function setTokenLimit(limit: number | null): Promise<number | null> {
  if (limit === null) {
    await configSet(CODING_AGENT_TOKENS_CONFIG_KEY, undefined);
    return null;
  }
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new CodingAgentError("invalid", "The token limit must be a number, or empty for no limit.");
  }
  const n = Math.round(limit);
  if (n < MIN_TOKEN_LIMIT) {
    throw new CodingAgentError("invalid", `A token limit below ${MIN_TOKEN_LIMIT.toLocaleString("en-US")} would stop almost every run before it started.`);
  }
  await configSet(CODING_AGENT_TOKENS_CONFIG_KEY, n);
  return n;
}


  /**
 * Folder names directly inside the owner's default project folder.
 *
 * The assistant could only ever see code projects — the 15 under
 * data/code-projects — so a folder the owner made themselves in ~/Projects
 * was invisible and could only be reached by typing its absolute path.
 * Names only: this is a picker, not a file listing.
 */
export async function listProjectFolders(): Promise<string[]> {
  const base = await getDefaultDirectory();
  if (!base) return [];
  try {
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .slice(0, 100);
  } catch {
    return [];
  }
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

/** The absolute path of `binary` on the runner's PATH, or null. */
export async function findExecutableOnPath(binary: string, pathValue: string = runnerPath()): Promise<string | null> {
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export async function checkReadiness(): Promise<CodingHarnessReadiness> {
  const [wrapperInstalled, claudePath, setprivPath, token] = await Promise.all([
    isExecutableFile(wrapperPath()),
    findExecutableOnPath("claude"),
    findExecutableOnPath(CAPABILITY_DROP_COMMAND),
    configGet("clawai_token"),
  ]);
  const claudeInstalled = claudePath !== null;
  const capabilityDropAvailable = setprivPath !== null;
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
  if (!capabilityDropAvailable) {
    problems.push(`${CAPABILITY_DROP_COMMAND} (part of util-linux) is missing, and without it a run would inherit the web server's network capabilities. Install util-linux.`);
  }
  return {
    ready: problems.length === 0,
    wrapperInstalled,
    claudeInstalled,
    clawaiConnected,
    capabilityDropAvailable,
    problems,
  };
}

export async function getCodingAgentStatus(): Promise<CodingAgentStatus> {
  const [enabled, readiness, defaultDirectory, effort, maxTurns, tokenLimit, projectFolders] = await Promise.all([
    isCodingAgentEnabled(),
    checkReadiness(),
    getDefaultDirectory(),
    getEffort(),
    getMaxTurns(),
    getTokenLimit(),
    listProjectFolders(),
  ]);
  return {
    enabled,
    defaultDirectory,
    ready: enabled && readiness.ready,
    readiness,
    running: runningCount(),
    harnessCommand: CODING_HARNESS_COMMAND,
    maxTaskChars: MAX_TASK_CHARS,
    effort,
    // Always include whatever is actually set. A box that stored "high"
    // before the picker narrowed to three would otherwise show a row with
    // nothing selected, and the owner could not tell what was in force.
    effortLevels: OFFERED_EFFORT_LEVELS.includes(effort)
      ? OFFERED_EFFORT_LEVELS
      : (EFFORT_LEVELS.filter((l) => OFFERED_EFFORT_LEVELS.includes(l) || l === effort) as readonly CodingEffort[]),
    projectFolders,
    maxTurns,
    minMaxTurns: MIN_MAX_TURNS,
    maxMaxTurns: MAX_MAX_TURNS,
    tokenLimit,
    minTokenLimit: MIN_TOKEN_LIMIT,
    runIdleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
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
    deniedActions: Array.isArray(raw.deniedActions)
      ? raw.deniedActions.filter((d): d is string => typeof d === "string")
      : [],
    effort: isEffort(raw.effort) ? raw.effort : DEFAULT_EFFORT,
    // A record written before this field existed, or one left by a restart,
    // has no live sub-agents by definition.
    subagentsActive: 0,
    // A record loaded from disk has none out by definition.
    activeSubagents: [],
    subagentsTotal: typeof raw.subagentsTotal === "number" ? raw.subagentsTotal : 0,
    subagentsByType: (raw.subagentsByType && typeof raw.subagentsByType === "object")
      ? (raw.subagentsByType as Record<string, number>) : {},
    commit: typeof raw.commit === "string" ? raw.commit : null,
    modelsUsed: Array.isArray(raw.modelsUsed)
      ? raw.modelsUsed.filter((m): m is string => typeof m === "string") : [],
    maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : DEFAULT_MAX_TURNS,
    tokensUsed: typeof raw.tokensUsed === "number" ? raw.tokensUsed : 0,
    tokenLimit: typeof raw.tokenLimit === "number" ? raw.tokenLimit : null,
    thinkingTokens: typeof raw.thinkingTokens === "number" ? raw.thinkingTokens : 0,
    lastActivityAt: typeof raw.lastActivityAt === "number" ? raw.lastActivityAt : 0,
    retries: typeof raw.retries === "number" ? raw.retries : 0,
    permissionDenials: typeof raw.permissionDenials === "number" ? raw.permissionDenials : 0,
    resumable: raw.resumable === true,
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
  /** Rolling idle check — see RUN_IDLE_TIMEOUT_MS. */
  timeout: NodeJS.Timeout;
  killTimer: NodeJS.Timeout | null;
  stopRequested: boolean;
  timedOut: boolean;
  sawResult: boolean;
  /** Whether "Thinking…" has already been said once. */
  sawThinking: boolean;
  stderr: string;
  /**
   * Files a Write/Edit has ASKED for, by tool_use id, not yet confirmed.
   *
   * A real run reported /tmp/check_html.py among its changed files when the
   * write had in fact been refused: the list was built from what the model
   * asked to do, and a request is not an outcome. Nothing lands in
   * filesTouched now until the tool_result comes back without an error.
   */
  pendingFiles: Map<string, string>;
  /**
   * Whether the run ever ASKED to write, confirmed or not.
   *
   * filesTouched holds only confirmed writes, which is right for reporting and
   * wrong for the retry gate: a run killed between the request and its result
   * may have written the file anyway, and a retry would then start from a
   * half-finished edit. Reporting takes the strict answer, the gate takes the
   * cautious one.
   */
  sawWriteAttempt: boolean;
  /**
   * tool_use ids of sub-agents that have started and not yet reported back.
   * Ids rather than a counter: a tool_result can arrive out of order, and a
   * duplicate must not decrement twice.
   */
  openSubagents: Map<string, ActiveSubagent>;
  /** Resolved once at start, so a retry does not need an async lookup. */
  setprivPath: string;
  /** What this run was spawned with — a retry must match, not re-read. */
  settings: { effort: CodingEffort; maxTurns: number };
  /** A shell command ran whose effects cannot be proven read-only. */
  commandMayHaveSideEffects: boolean;
}

/** Newest first. `null` until first use. */
let runs: CodingRun[] | null = null;
const live = new Map<string, LiveRun>();
const waiters = new Map<string, Set<() => void>>();
let flushTimer: NodeJS.Timeout | null = null;
let dirty = false;
let exitHookInstalled = false;
/** Records loadRuns() settled as failed because the previous server died with them. */
let repairedAtLoad = 0;

/**
 * Load the store, and settle anything the previous web server left behind.
 * `live` is empty when this process starts, so every "running" record on disk
 * belongs to a process that no longer exists — systemd kills the whole cgroup
 * when clawbox-setup restarts at the end of an update.
 */
function loadRuns(): CodingRun[] {
  if (runs) return runs;
  runs = readAll();
  repairedAtLoad = 0;
  for (const run of runs) {
    if (run.status === "running" && !live.has(run.id)) {
      run.status = "failed";
      run.error = "The ClawBox web server restarted while this run was in progress. Start it again.";
      run.completedAt = Date.now();
      repairedAtLoad += 1;
    }
  }
  if (repairedAtLoad > 0) {
    try {
      writeAll(runs);
    } catch (err) {
      console.error("[coding-agent] could not repair the runs file:", err instanceof Error ? err.message : err);
    }
  }
  return runs;
}

/**
 * Called from the boot hook so a stale "running" run is settled before anyone
 * asks. Returns how many were settled — the one signal an operator gets that
 * a restart killed work in progress.
 */
export function reconcileAfterRestart(): number {
  loadRuns();
  return repairedAtLoad;
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
  return {
    ...run,
    filesTouched: [...run.filesTouched],
    progress: [...run.progress],
    deniedActions: [...run.deniedActions],
    activeSubagents: run.activeSubagents.map((a) => ({ ...a })),
    subagentsByType: { ...run.subagentsByType },
    modelsUsed: [...run.modelsUsed],
  };
}

export function getRun(id: string): CodingRun | null {
  const run = loadRuns().find((r) => r.id === id);
  return run ? cloneRun(run) : null;
}

export function listRuns(limit = MAX_RUNS_KEPT): CodingRun[] {
  return loadRuns().slice(0, Math.max(0, limit)).map(cloneRun);
}

/**
 * Forget the finished runs. Returns how many were removed.
 *
 * A run still in flight is KEPT, whatever the caller asked for: it is the only
 * handle on a live process — the record the stop route looks up, and the one
 * the boot sweep settles if the server dies. Dropping it would leave a coding
 * agent working in a folder with nothing on the device that knows about it.
 *
 * Owner-only at the route, for the same reason the switch is: these records
 * are the account of what the assistant did with a delegated shell, and the
 * party they describe is not the party who should be able to erase them.
 */
export function clearFinishedRuns(): number {
  const list = loadRuns();
  const keep = list.filter((r) => r.status === "running");
  const removed = list.length - keep.length;
  if (removed === 0) return 0;
  // Mutate the array the module hands out rather than replacing the binding,
  // so every existing reader sees the same list.
  list.length = 0;
  list.push(...keep);
  persist(true);
  console.error(`[coding-agent] cleared ${removed} finished run(s) at the owner's request`);
  return removed;
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

  // Both roots as normalised absolute paths. Every filesystem call below is
  // made on a path that has been `path.resolve`d and checked to start with
  // one of these — the shape a static analyser recognises as contained — on
  // top of the realpath re-check that catches symlinks.
  const projectsRoot = path.resolve(CONFIG_ROOT, "data", "code-projects");
  const home = path.resolve(homeDir());

  if (projectId) {
    if (!validateProjectId(projectId)) throw new CodingAgentError("invalid", "Invalid project id.");
    const dir = path.resolve(projectPath(projectId));
    if (!dir.startsWith(projectsRoot + path.sep)) throw new CodingAgentError("invalid", "Invalid project id.");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      throw new CodingAgentError("not_found", "There is no code project with that id on this ClawBox.");
    }
    if (!stat.isDirectory()) throw new CodingAgentError("not_found", "There is no code project with that id on this ClawBox.");
    return { directory: await projectFolder(dir, projectsRoot, projectId), projectId };
  }

  if (!directory) {
    // The owner's default, if they set one. Re-validated by falling through
    // into the same checks below — a folder that stopped being allowed since
    // it was set (deleted, moved, replaced by a symlink out of the home) is
    // refused now, not trusted because it passed once.
    const fallback = await getDefaultDirectory();
    if (!fallback) {
      throw new CodingAgentError("invalid", "Give a code project id or a folder to work in.");
    }
    return resolveWorkingDirectory({ directory: fallback });
  }
  if (directory.length > MAX_DIRECTORY_CHARS) {
    throw new CodingAgentError("invalid", "The folder path is too long.");
  }
  if (!path.isAbsolute(directory)) {
    // A bare name means a folder in the owner's default directory. Without
    // this, working on a folder they already have — ~/Projects/my-app —
    // required the assistant to know and type the whole absolute path, and
    // nothing told it the folder existed.
    const base = await getDefaultDirectory();
    if (!base) {
      throw new CodingAgentError("invalid", "The folder must be an absolute path, or a folder name inside your default project folder.");
    }
    if (directory.includes("/") || directory.includes("\\") || directory === "." || directory === "..") {
      throw new CodingAgentError("invalid", "Give a single folder name, or an absolute path.");
    }
    return resolveWorkingDirectory({ directory: path.join(base, directory) });
  }
  const normalized = path.resolve(directory);

  // A code project's folder is always fine, wherever the checkout lives (a
  // dev box keeps it under the working directory, not the home). Spelling it
  // as a path rather than an id still records which project it was.
  if (normalized.startsWith(projectsRoot + path.sep)) {
    const id = path.relative(projectsRoot, normalized).split(path.sep)[0];
    return { directory: await projectFolder(normalized, projectsRoot, id), projectId: validateProjectId(id) ? id : null };
  }

  if (!normalized.startsWith(home + path.sep)) {
    throw new CodingAgentError("invalid", "The working folder must be inside the ClawBox home directory.");
  }
  const real = await realDirectory(normalized);
  const realHome = await fs.promises.realpath(home).catch(() => home);
  // A symlink may lead anywhere; the folder it leads to has to pass the same test.
  if (!isInside(real, realHome)) {
    throw new CodingAgentError("invalid", "The working folder must be inside the ClawBox home directory.");
  }
  // Not the home itself: `acceptEdits` auto-approves every edit UNDER the
  // working folder, and under the home that includes ~/.bashrc and friends.
  if (real === realHome) {
    throw new CodingAgentError("invalid", "Use a folder inside the home directory, not the home directory itself.");
  }
  if (isProtectedFilePath(real)) {
    throw new CodingAgentError("invalid", "That folder holds credentials or ClawBox's own state and cannot be a working folder.");
  }
  for (const sub of DENIED_HOME_SUBTREES) {
    if (isInside(real, path.join(realHome, sub))) {
      throw new CodingAgentError("invalid", "That folder holds credentials or ClawBox's own state and cannot be a working folder.");
    }
  }
  const checkout = await fs.promises.realpath(CONFIG_ROOT).catch(() => path.resolve(CONFIG_ROOT));
  const realProjects = path.join(checkout, "data", "code-projects");
  if (isInside(real, realProjects) && real !== realProjects) {
    // A symlink into the projects folder: a project after all.
    const id = path.relative(realProjects, real).split(path.sep)[0];
    return { directory: real, projectId: validateProjectId(id) ? id : null };
  }
  if (isInside(real, checkout)) {
    throw new CodingAgentError(
      "invalid",
      "The ClawBox OS checkout itself is off limits. Use a code project or another folder in the home directory.",
    );
  }
  return { directory: real, projectId: null };
}

/** The real path of a folder under the projects root; a symlink that leads out of it is refused. */
async function projectFolder(dir: string, projectsRoot: string, id: string): Promise<string> {
  const real = await realDirectory(dir);
  const realRoot = await fs.promises.realpath(projectsRoot).catch(() => projectsRoot);
  if (!isInside(real, realRoot) || real === realRoot) {
    throw new CodingAgentError("invalid", `The folder of project "${id}" leads outside the projects directory and cannot be used.`);
  }
  return real;
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
  "The task text may carry copy-paste artifacts. If a detail is plainly garbled — a nonsense number, a broken word — ship the sensible correction and note it in your final report; do not reproduce an obvious error verbatim.",
  "Unless you have been given full access, run ONE command per Bash call. Chaining with ; or && , pipes, redirection, subshells and heredocs are all refused, however harmless the parts look — split them into separate calls instead of retrying the combined form.",
  "When sub-agents are available to you, use them: hand searching and mapping to the explorer, running builds and tests to the tester, and a last read-through to the reviewer before you report done. Do the writing yourself.",
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
export function buildRunArgs(opts: { resumeSessionId?: string | null; maxTurns?: number }): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--permission-mode", "acceptEdits",
    "--setting-sources", "user",
    "--max-turns", String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
    "--append-system-prompt", HEADLESS_BRIEF,
  ];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // The three tool flags are variadic and swallow any positional that follows,
  // which is why the task travels on stdin and these come last.
  args.push("--tools", toolsFor(true));
  // The Agent tool with nothing to delegate to is a tool that never fires.
  args.push("--agents", JSON.stringify(SUBAGENT_DEFINITIONS));
  {
    // "Bash(*)" — allow EVERY command — rather than withholding the lists.
    // Withholding grants nothing: in headless -p mode the allow-list is what
    // approves a command, and with no list at all every Bash call just waits
    // for an approval nobody is there to give (verified on the box: curl was
    // still denied with the lists absent). The FILE rules still ship, and a
    // deny rule outranks any allow, so the credential stores stay closed.
    // Full access is about commands, not secrets.
    args.push("--allowedTools", "Bash(*)");
    args.push("--disallowedTools", ...fileDenyRules());
  }
  return args;
}

/** The environment a run gets — and nothing else. Exported for the contract test. */
export function buildRunEnv(opts: { effort?: CodingEffort } = {}): Record<string, string> {
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
  // The owner's setting wins over anything inherited: this is the knob the
  // Coding Agent app writes, and a stale shell variable must not override it.
  if (opts.effort) env.CLAUDE_DS_EFFORT = opts.effort;
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

/**
 * Commands that inspect the project without changing it.
 *
 * `commandsRun === 0` was too blunt for the retry gate: the real authentication
 * failure can arrive after Claude Code has only run `ls -la`, leaving no state
 * that makes a fresh attempt unsafe. Keep this deliberately narrower than the
 * Bash allow-list. Shell composition/redirection and commands such as npm,
 * Python, git commit, mkdir or cp remain side-effecting because proving their
 * behaviour from a command string is not possible.
 */
export function isReadOnlyInspectionCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed || /[;&|<>`\n\r]|\$\(/.test(trimmed)) return false;
  return /^(?:pwd|ls|cat|head|tail|wc|grep)(?:\s|$)/.test(trimmed)
    || /^git\s+(?:status|diff|log)(?:\s|$)/.test(trimmed);
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  /** system/thinking_tokens: reasoning tokens so far. */
  estimated_tokens?: number;
  /** `user` events carry tool_result blocks; that is how a sub-agent reports back. */
  session_id?: string;
  model?: string;
  message?: { content?: unknown; usage?: unknown };
  result?: unknown;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  permission_denials?: unknown;
  /** result event: per-model token breakdown, keyed by model name. */
  modelUsage?: unknown;
  errors?: unknown;
}

/** How many refused actions a run keeps. Enough to see the pattern. */
const MAX_DENIALS_KEPT = 5;
const MAX_DENIAL_CHARS = 160;

/**
 * One refused action, as the owner should read it. Claude Code sends
 * `{ tool_name, tool_use_id, tool_input }`; the useful part is the tool and
 * the one field that says what it was pointed at.
 */
function describeDenial(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "an action";
  const e = entry as { tool_name?: unknown; tool_input?: unknown };
  const tool = typeof e.tool_name === "string" && e.tool_name ? e.tool_name : "tool";
  const input = (e.tool_input && typeof e.tool_input === "object" ? e.tool_input : {}) as Record<string, unknown>;
  const target = ["command", "file_path", "notebook_path", "path", "pattern"]
    .map((k) => input[k])
    .find((v): v is string => typeof v === "string" && v !== "");
  return `${tool}: ${target ?? "(no details)"}`.slice(0, MAX_DENIAL_CHARS);
}

/** Exported for the test: this parses a payload the device does not control. */
export const describeDenialForTests = describeDenial;

/** One line of `--output-format stream-json`. */
function handleEvent(run: CodingRun, state: LiveRun, event: StreamEvent): void {
  if (typeof event.session_id === "string" && event.session_id && !run.sessionId) run.sessionId = event.session_id;

  // ANY event is a sign of life, whatever it is.
  run.lastActivityAt = Date.now();

  // Claude Code reports reasoning progress before it has anything to say. It
  // is the only signal that separates "thinking hard" from "hung", and a run
  // on `effort: max` can sit here for minutes on the first turn.
  if (event.type === "system" && event.subtype === "thinking_tokens") {
    const total = typeof event.estimated_tokens === "number" ? event.estimated_tokens : 0;
    if (total > run.thinkingTokens) run.thinkingTokens = total;
    // One line, not one per event: these arrive continuously and would drown
    // the progress feed. The live count is on the record for anyone watching.
    if (!state.sawThinking) {
      state.sawThinking = true;
      pushProgress(run, "Thinking…");
    }
    return;
  }

  if (event.type === "system" && event.subtype === "init") {
    if (typeof event.model === "string" && event.model) run.model = event.model;
    pushProgress(run, `Started${run.model ? ` with ${run.model}` : ""}`);
    return;
  }

  if (event.type === "assistant") {
    // Every request pays for the input it carries, so input is summed per turn
    // even though the conversation repeats — that is what a bill counts.
    const usage = event.message?.usage;
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      run.tokensUsed += n("input_tokens") + n("output_tokens")
        + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
      if (run.tokenLimit !== null && run.tokensUsed >= run.tokenLimit && !state.stopRequested) {
        // The CLI has no flag for this, so the device stops the run itself.
        // Marked resumable: the work is real, it simply ran out of room —
        // the same shape as a step ceiling.
        state.stopRequested = true;
        run.resumable = true;
        run.error = `Stopped at the token limit (${run.tokensUsed.toLocaleString("en-US")} of ${run.tokenLimit.toLocaleString("en-US")}). Raise the limit or resume with a narrower task.`;
        pushProgress(run, "Token limit reached");
        console.error(`[coding-agent] ${run.id} hit its token limit at ${run.tokensUsed}`);
        killTree(state.child, "SIGTERM");
        state.killTimer = setTimeout(() => killTree(state.child, "SIGKILL"), STOP_GRACE_MS);
        state.killTimer.unref();
        return;
      }
    }
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
            if (!isReadOnlyInspectionCommand(input.command)) state.commandMayHaveSideEffects = true;
            pushProgress(run, `$ ${typeof input.command === "string" ? input.command : ""}`);
            break;
          case "Write":
          case "Edit":
          case "NotebookEdit": {
            const file = relativeToRun(run, input.file_path ?? input.notebook_path);
            // Asked for, not yet done — confirmed when its tool_result lands.
            state.sawWriteAttempt = true;
            if (file && typeof block.id === "string" && block.id) state.pendingFiles.set(block.id, file);
            pushProgress(run, `${block.name} ${file ?? ""}`);
            break;
          }
          case "Task":
          case SUBAGENT_TOOL: {
            // A sub-agent is out. Its id is what tells us when it comes back.
            const what = typeof input.description === "string" ? input.description : "";
            const kind = typeof input.subagent_type === "string" ? input.subagent_type : "";
            if (typeof block.id === "string" && block.id) {
              state.openSubagents.set(block.id, {
                type: kind || "sub-agent",
                description: what.slice(0, 120),
                startedAt: Date.now(),
              });
            }
            run.subagentsTotal += 1;
            const typeKey = kind || "sub-agent";
            run.subagentsByType[typeKey] = (run.subagentsByType[typeKey] ?? 0) + 1;
            run.subagentsActive = state.openSubagents.size;
            run.activeSubagents = [...state.openSubagents.values()];
            pushProgress(run, `Sub-agent started${kind ? ` (${kind})` : ""}${what ? `: ${what}` : ""}`);
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

  // A tool_result closes whatever it answers. Only sub-agent ids are tracked,
  // so every other tool_result falls through harmlessly.
  if (event.type === "user") {
    const raw = event.message?.content;
    const content = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const done = state.openSubagents.get(block.tool_use_id);
      if (done && state.openSubagents.delete(block.tool_use_id)) {
        run.subagentsActive = state.openSubagents.size;
        run.activeSubagents = [...state.openSubagents.values()];
        pushProgress(run, `Sub-agent finished${done.type !== "sub-agent" ? ` (${done.type})` : ""}`);
      }
      const pending = state.pendingFiles.get(block.tool_use_id);
      if (pending !== undefined) {
        state.pendingFiles.delete(block.tool_use_id);
        // A refusal comes back as an error result; only a clean one counts.
        if (block.is_error !== true) noteFile(run, pending);
      }
    }
    return;
  }

  if (event.type === "result") {
    state.sawResult = true;
    if (typeof event.num_turns === "number") run.numTurns = event.num_turns;
    if (typeof event.total_cost_usd === "number") run.costUsd = event.total_cost_usd;
    // Which models actually did work — the main run and every sub-agent.
    if (event.modelUsage && typeof event.modelUsage === "object") {
      run.modelsUsed = Object.keys(event.modelUsage as Record<string, unknown>).sort();
    }
    if (Array.isArray(event.permission_denials)) {
      run.permissionDenials = event.permission_denials.length;
      run.deniedActions = event.permission_denials.slice(0, MAX_DENIALS_KEPT).map(describeDenial);
    }
    const text = typeof event.result === "string" ? event.result.trim() : "";
    if (text) run.summary = text.slice(0, MAX_SUMMARY_CHARS);
    switch (event.subtype) {
      case "success":
        run.status = event.is_error ? "failed" : "completed";
        if (event.is_error && !run.error) run.error = (text || "Claude Code reported an error.").slice(0, MAX_ERROR_CHARS);
        break;
      // The two ceilings are the ONLY failures a resume can help with: the
      // session did real work and simply ran out of room.
      case "error_max_turns":
        run.status = "failed";
        run.resumable = true;
        run.error = `Stopped after ${run.numTurns || run.maxTurns} steps without finishing. Resume it with a narrower task, raise the step limit, or split the work.`;
        break;
      case "error_max_budget_usd":
        run.status = "failed";
        run.resumable = true;
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

/**
 * Failures worth ONE automatic retry.
 *
 * Observed on a real box: a run dies in four seconds with "Failed to
 * authenticate. API Error: Attention Required! | Cloudflare" while the same
 * request from the same box with the same token succeeds immediately before
 * and after. Concurrency, payload size, the restricted environment and the
 * capability drop were each tested and each ruled out; the upstream cause is
 * still unidentified.
 *
 * What IS certain is the device's part: it turned one transient upstream
 * hiccup into a dead run and told the owner their box was offline. Claude
 * Code retries ordinary API errors itself, but treats an auth failure as
 * final — reasonably, since a bad key will never come good. Here the key is
 * fine, so the run is worth starting again.
 *
 * Deliberately narrow: an auth/transport shape, and nothing that could be a
 * real refusal of the work.
 */
const TRANSIENT_FAILURE_RE =
  /failed to authenticate|attention required|cloudflare|502 bad gateway|503|504|gateway time-?out|econnreset|etimedout|enotfound|socket hang up|fetch failed/i;

export function isTransientFailure(error: string | null): boolean {
  return typeof error === "string" && TRANSIENT_FAILURE_RE.test(error);
}

/**
 * Commit what the run changed, in its own folder.
 *
 * Fire-and-forget and never allowed to throw: a run that did its work is
 * finished whether or not the history was recorded, and the owner is told
 * either way.
 */
function recordRunWork(run: CodingRun): void {
  if (run.filesTouched.length === 0) return;
  void commitRunWork({
    directory: run.directory,
    runId: run.id,
    task: run.task,
    summary: run.summary,
  })
    .then((outcome) => {
      if (outcome.committed) {
        run.commit = outcome.sha;
        pushProgress(run, `Committed as ${outcome.sha}${outcome.initialized ? " (new repository)" : ""}`);
        console.error(`[coding-agent] ${run.id} committed ${outcome.sha}`);
      } else if (outcome.reason !== "no_changes") {
        pushProgress(run, `Not committed: ${outcome.detail ?? outcome.reason}`);
        console.error(`[coding-agent] ${run.id} not committed: ${outcome.reason}`);
      }
      persist(true);
    })
    .catch((err: unknown) => {
      console.error("[coding-agent] commit failed:", err instanceof Error ? err.message : err);
    });
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
  // The run's process tree is gone, so nothing it spawned is still working —
  // whatever the stream did or did not say about each sub-agent.
  state.openSubagents.clear();
  run.subagentsActive = 0;
  run.activeSubagents = [];
  if (run.status === "running") {
    if (state.stopRequested) {
      run.status = "stopped";
      run.error = run.error ?? "Stopped before it finished.";
    } else if (state.timedOut) {
      run.status = "failed";
      run.error = `Stopped after ${Math.round(RUN_IDLE_TIMEOUT_MS / 60_000)} minutes with no sign of life. The run was not making progress.`;
    } else {
      run.status = "failed";
      const tail = stderrTail(state.stderr);
      run.error = tail || `Claude Code exited with code ${exitCode ?? "unknown"} before reporting a result.`;
    }
  }
  // A stop that raced the final message keeps "completed": the work is done.
  run.exitCode = exitCode;
  run.completedAt = Date.now();
  clearInterval(state.timeout);
  if (state.killTimer) clearTimeout(state.killTimer);
  live.delete(run.id);

  // One automatic restart when the upstream blinked and the run got nowhere.
  //
  // The guards are what make this safe rather than a loop: once only, only a
  // transient shape, only a run the owner did not stop, and only one that
  // changed NOTHING — no files and no command that may have side effects. A
  // read-only inspection such as `ls -la` is safe and must not suppress the
  // recovery. A run that may have edited something must never be silently
  // repeated, because the second attempt starts from the first one's leftovers.
  //
  // A FRESH session, never a resume: Claude Code persists the failure in the
  // session and replays it, which is how one bad run became two identical
  // ones on this box. See CodingRun.resumable.
  if (
    run.status === "failed"
    && run.retries === 0
    && !state.stopRequested
    && !state.timedOut
    && isTransientFailure(run.error)
    && run.filesTouched.length === 0
    && !state.sawWriteAttempt
    && !state.commandMayHaveSideEffects
  ) {
    {
      run.retries = 1;
      run.status = "running";
      run.completedAt = null;
      run.exitCode = null;
      run.error = null;
      run.sessionId = null;
      run.numTurns = 0;
      run.subagentsTotal = 0;
      pushProgress(run, "The provider did not answer; starting over in a fresh session");
      persist(true);
      console.error(`[coding-agent] ${run.id} retrying once after a transient upstream failure`);
      try {
        spawnRun(run, null, state.setprivPath, state.settings);
        return;
      } catch (err) {
        // The retry could not even start; fall through and report the
        // original shape of failure rather than losing the run.
        run.status = "failed";
        run.completedAt = Date.now();
        run.error = `Retry could not start: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_ERROR_CHARS);
      }
    }
  }

  pushProgress(run, `Finished: ${run.status}`);
  persist(true);
  wakeWaiters(run.id);
  console.error(`[coding-agent] ${run.id} ${run.status} after ${Math.round((run.completedAt - run.startedAt) / 1000)}s (${run.numTurns} turns)`);
  // History first, then the notice: by the time the owner is told a run
  // finished, its work is already recoverable.
  void recordRunWork(run);
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

/**
 * The argv the box actually spawns: `setpriv`, the capability-dropping flags,
 * then the wrapper and its own arguments. Exported for the contract test —
 * this prefix is a security boundary, not a detail.
 */
export function buildSpawnArgv(setprivPath: string, claudeArgs: string[]): { bin: string; argv: string[] } {
  return { bin: setprivPath, argv: [...CAPABILITY_DROP_ARGS, wrapperPath(), ...claudeArgs] };
}

function spawnRun(
  run: CodingRun,
  resumeSessionId: string | null,
  setprivPath: string,
  settings: { effort: CodingEffort; maxTurns: number },
): void {
  const { bin, argv } = buildSpawnArgv(setprivPath, buildRunArgs({ resumeSessionId, maxTurns: settings.maxTurns }));
  const child = spawn(bin, argv, {
    cwd: run.directory,
    // Deliberately NOT process.env: see the header. The cast is only because
    // this repo's ProcessEnv augmentation insists on NODE_ENV, which a run has
    // no use for.
    env: buildRunEnv({ effort: settings.effort }) as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state: LiveRun = {
    child,
    openSubagents: new Map<string, ActiveSubagent>(),
    pendingFiles: new Map<string, string>(),
    sawWriteAttempt: false,
    sawThinking: false,
    setprivPath,
    settings,
    commandMayHaveSideEffects: false,
    // A rolling check, not a deadline: a run that keeps producing events is
    // allowed to work for as long as it needs.
    timeout: setInterval(() => {
      const idleFor = Date.now() - run.lastActivityAt;
      if (idleFor < RUN_IDLE_TIMEOUT_MS) return;
      state.timedOut = true;
      killTree(child, "SIGTERM");
      state.killTimer = setTimeout(() => killTree(child, "SIGKILL"), STOP_GRACE_MS);
      state.killTimer.unref();
    }, IDLE_CHECK_MS),
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
    throw new CodingAgentError("disabled", "The coding agent is switched off. The owner can turn it on in the Coding Agent app on the ClawBox desktop.");
  }
  const readiness = await checkReadiness();
  if (!readiness.ready) {
    throw new CodingAgentError("not_ready", readiness.problems.join(" "));
  }
  // Resolved again rather than carried out of checkReadiness: this path is what
  // strips the web server's network capabilities off the run, and a run must
  // never start without it — not even if the binary vanished a moment ago.
  const setprivPath = await findExecutableOnPath(CAPABILITY_DROP_COMMAND);
  if (!setprivPath) {
    throw new CodingAgentError(
      "not_ready",
      `${CAPABILITY_DROP_COMMAND} (part of util-linux) is missing, and without it a run would inherit the web server's network capabilities. Install util-linux.`,
    );
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
    // A session poisoned by an authentication or transport failure REPLAYS
    // that failure on every resume — Claude Code persists it in the session,
    // so resuming is a re-enactment, not a retry. Measured on a real box: a
    // transient upstream error at 09:01 was resumed at 09:05 into the same
    // session and failed identically, which is how a passing cloud hiccup
    // became a permanently broken project.
    //
    // So the work carries on in a FRESH session instead. The task text is the
    // caller's and says what to continue; what is lost is the old
    // conversation, which was worthless anyway — it contains one failed
    // request. Refusing outright would be worse: it would leave the owner
    // with a project that can never be resumed.
    resumeSessionId = previous.resumable ? previous.sessionId : null;
  } else {
    ({ directory, projectId } = await resolveWorkingDirectory(input));
  }

  const list = loadRuns();
  const active = list.filter((r) => r.status === "running");
  if (active.length >= MAX_CONCURRENT_RUNS) {
    throw new CodingAgentError("busy", `A coding run is already in progress (${active[0].id}). Wait for it or stop it first.`);
  }

  // Read once, here: a run keeps the settings it started with even if the
  // owner changes them while it works.
  const [effort, maxTurns, tokenLimit] = await Promise.all([
    getEffort(), getMaxTurns(), getTokenLimit(),
  ]);

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
    deniedActions: [],
    effort,
    subagentsActive: 0,
    activeSubagents: [],
    subagentsTotal: 0,
    subagentsByType: {},
    modelsUsed: [],
    commit: null,
    maxTurns,
    tokensUsed: 0,
    tokenLimit,
    thinkingTokens: 0,
    lastActivityAt: Date.now(),
    retries: 0,
    resumable: false,
    progress: [],
    exitCode: null,
  };
  if (resumeSessionId) pushProgress(run, "Resuming the previous session");
  else if (resumeRunId) pushProgress(run, `Starting fresh: ${resumeRunId} did not fail in a way a resume can fix`);

  list.unshift(run);
  // Never drop a running run; trim the oldest finished ones.
  while (list.length > MAX_RUNS_KEPT) {
    const idx = findLastFinished(list);
    if (idx < 0) break;
    list.splice(idx, 1);
  }
  persist(true);
  console.error(`[coding-agent] ${run.id} started by ${run.source} in ${run.directory}`);
  try {
    spawnRun(run, resumeSessionId, setprivPath, { effort, maxTurns });
  } catch (err) {
    // The record is already on disk as "running". If spawn throws SYNCHRONOUSLY
    // — a cwd that vanished between the check and here, a setpriv that is not
    // executable — nothing would ever settle it: `live` has no entry, so the
    // boot sweep is the only thing that would, and until the next restart the
    // one-run-at-a-time rule answers every later run with "busy". Settle it
    // here, then report the failure to the caller.
    run.status = "failed";
    run.error = `Could not start ${CODING_HARNESS_COMMAND}: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_ERROR_CHARS);
    run.completedAt = Date.now();
    persist(true);
    wakeWaiters(run.id);
    console.error(`[coding-agent] ${run.id} failed to spawn:`, err instanceof Error ? err.message : err);
    throw new CodingAgentError("not_ready", run.error);
  }
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
  repairedAtLoad = 0;
  runs = null;
}
