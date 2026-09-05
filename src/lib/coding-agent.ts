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
import { CONFIG_ROOT, DATA_DIR, get as configGet, getAll as configGetAll, set as configSet } from "@/lib/config-store";
import { ARTIFACT_RUN_ID_RE, artifactsDir, ensureArtifactsDir, removeArtifacts, writeRunReport } from "@/lib/coding-agent-artifacts";
import { type CodingRunStatus, isCodingRunStatus, isHeld, isLive } from "@/lib/coding-agent-status";
import { memAvailableMb } from "@/lib/mem-available";
import { CODING_HARNESS_COMMAND, CODING_HARNESS_WRAPPER_PATH } from "@/lib/coding-harness";
import { DATA_DIR_PUBLIC_SUBTREES, isInside, isProtectedFilePath, PROTECTED_HOME_DIRS } from "@/lib/file-guard";
import { MAX_PROJECT_NAME_LENGTH, projectPath, validateProjectId, WEBAPPS_DIR } from "@/lib/code-projects";
import { announceCodingAgent } from "@/lib/coding-agent-notify";
import {
  decideMerge,
  emptyChecks,
  isPrPending,
  isPrPhase,
  mergePullRequest,
  openPullRequest,
  // Aliased: this module's own MAX_WAIT_MS is the 120-second status-request
  // limit, a different ceiling for a different wait.
  MAX_WAIT_MS as PR_MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  readPullRequest,
  runBranchName,
  startRunBranch,
  type PrChecks,
  type PrState,
} from "@/lib/coding-pr";
import { commitRunWork, lastCommit, type LastCommit } from "@/lib/coding-git";
import { closeSessionsForRun } from "@/lib/browser-sessions";
import { ensureProjectIcon } from "@/lib/project-icon";
import { webappIconPath } from "@/lib/webapp-icon";

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
 * How hard Claude Code thinks per turn. The first five are the levels the
 * installed CLI accepts for `--effort` and the wrapper pins through
 * CLAUDE_DS_EFFORT — it warns and falls back to its default on anything
 * else, so the set is validated here rather than passed through.
 *
 * Higher is slower and costs more; on a Jetson the difference is felt.
 *
 * "ultracode" is not a thinking level but Claude Code's own mode on top of
 * one: xhigh effort plus a standing opt-in to orchestrate the work with its
 * Workflow tool (fan-out, adversarial verification). It is the default
 * because a delegated run is unattended — the owner is not watching to notice
 * it gave up early — and it is the most thorough setting the harness has.
 * The wrapper requests it with `--effort ultracode` instead of the env pin
 * the fixed levels use, because a pinned CLAUDE_CODE_EFFORT_LEVEL blocks the
 * mode ("clear it and ultracode takes over"). Checked on this box: a -p run
 * under the flag reports "Ultracode is on" and carries the Workflow tool.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
/**
 * The levels the app offers, as opposed to the ones the CLI accepts.
 *
 * Measured on this box, same prompt, deepseek-v4-pro[1m], reasoning tokens:
 *
 *     low 82   medium 94   high 102   xhigh 139   max 414
 *
 * The effort does reach the model — the request carries
 * output_config {"effort": "..."} and it changes with the flag — but low,
 * medium and high land within noise of each other. Offering six buttons
 * where three do the same thing teaches a false model of the machine, so the
 * picker shows the three that measurably differ, plus ultracode. All six stay
 * valid for anyone setting the config key directly.
 */
export const OFFERED_EFFORT_LEVELS: readonly CodingEffort[] = ["low", "xhigh", "max", "ultracode"];
export type CodingEffort = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: CodingEffort = "ultracode";
/** The one level the wrapper cannot pin through the environment — see EFFORT_LEVELS. */
export const ULTRACODE_EFFORT: CodingEffort = "ultracode";
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
/** Default agent turns before Claude Code stops itself (`error_max_turns`).
 *  The owner can change it; a long project needs more than a short one. */
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

/**
 * The owner's switch for the automatic review pass: when on, a run that
 * completed AND changed files is followed by ONE more run that resumes the
 * same session and adversarially reviews what was just delivered. Measured
 * on this box: an external judges-then-fix round lifted a delivered project
 * from 6.5 to 9, and a run's own reviewer sub-agent caught a shipped bug —
 * the review pass packages that as a switch. Off by default: it spends the
 * owner's plan on every completed run.
 */
export const CODING_AGENT_REVIEW_CONFIG_KEY = "coding_agent_review_pass";

/**
 * Has the owner been through the setup wizard?
 *
 * The wizard is what collects the consent and the two settings a delegated
 * shell needs, so the app shows it instead of the home page until this is
 * true. Reset clears it, which is the ONLY way back to the wizard — a run
 * failing, or the switch going off, must not restart onboarding.
 */
/**
 * Branch, open a pull request, wait for GitHub Actions, and merge when the
 * checks actually say so.
 *
 * Off by default, and owner-only like every other switch here: it is standing
 * consent for the box to push the agent's work to GitHub and merge it. The
 * guardrails that decide "actually say so" live in @/lib/coding-pr —
 * notably that a pull request with NO checks is never merged, because "every
 * check passed" is trivially true of zero checks.
 */
export const CODING_AGENT_AUTO_PR_CONFIG_KEY = "coding_agent_auto_pr";

export const CODING_AGENT_SETUP_CONFIG_KEY = "coding_agent_setup_complete";

/**
 * May a run draw its own pictures — and may the box draw the project's desktop
 * icon and its favicon while the run works?
 *
 * ON when the key is absent, unlike every other switch here, because this one
 * is not a consent: the icon pipeline already spends the same allowance on a
 * web app the agent creates (src/lib/webapp-icon.ts), and a project that ships
 * with a placeholder glyph is the thing the owner asked to stop seeing. What it
 * costs is bounded twice over — MAX_IMAGES_PER_RUN on the record, and the
 * proxy's own per-UTC-day allowance — so the switch is here for the owner who
 * would rather spend that allowance on the chat.
 */
export const CODING_AGENT_GEN_IMAGES_CONFIG_KEY = "coding_agent_generate_images";

/**
 * May a run have this box SPEAK for it — narration, a greeting, a sound cue —
 * written into its project as a WAV?
 *
 * ON when absent, for the same reason as the pictures. What it costs is
 * different, though, and the brief says so: synthesis is one box-wide slot
 * shared with the chat's spoken replies (withSpeechQueue), and the cloud voice
 * is billed per character.
 */
export const CODING_AGENT_GEN_AUDIO_CONFIG_KEY = "coding_agent_generate_audio";

/** Every key the reset clears. The switch is last: it is the consent, and a
 *  half-cleared box that is still switched on would be the one state where the
 *  wizard shows over a live delegated shell. */
export const CODING_AGENT_RESET_KEYS = [
  CODING_AGENT_DIR_CONFIG_KEY,
  CODING_AGENT_EFFORT_CONFIG_KEY,
  CODING_AGENT_TURNS_CONFIG_KEY,
  CODING_AGENT_TOKENS_CONFIG_KEY,
  CODING_AGENT_REVIEW_CONFIG_KEY,
  CODING_AGENT_AUTO_PR_CONFIG_KEY,
  CODING_AGENT_GEN_IMAGES_CONFIG_KEY,
  CODING_AGENT_GEN_AUDIO_CONFIG_KEY,
  CODING_AGENT_SETUP_CONFIG_KEY,
  CODING_AGENT_CONFIG_KEY,
] as const;

/**
 * Pictures and clips ONE run may ask this box for.
 *
 * Per RUN and on the record, never per process: finishRun respawns the same
 * record on a transient retry and the review pass resumes the same session, and
 * neither may buy the owner's daily allowance a second time. A model that keeps
 * asking is told how many it has left in every reply, which is what stops the
 * loop before the cap has to.
 */
export const MAX_IMAGES_PER_RUN = 20;
export const MAX_AUDIO_PER_RUN = 40;
export const MIN_TOKEN_LIMIT = 10_000;
export const MAX_TASK_CHARS = 4_000;
export const MAX_DIRECTORY_CHARS = 512;
/** Runs at once. A Jetson has one coding agent's worth of memory to spare,
 *  and two runs in one folder would edit each other's files. */
export const MAX_CONCURRENT_RUNS = 1;

/**
 * A coding TEAM may have several of its runs going at once — its workers in
 * their own git worktrees — up to this many, and only while the box has
 * `TEAM_SPAWN_MIN_AVAILABLE_MB` of MemAvailable to spare for each one after
 * the first. Measured on this Orin Nano (2026-09-05): a `claude -p` run is
 * ~210 MB resident two minutes in with its MCP server at ~60 MB, and grows
 * with its context; the guard is set for three of them beside the web
 * server, the gateway and the desktop's Chromium on a 7.6 GB board. A run
 * that is not the team's still waits for the team, and the team waits for
 * it: the one-run-at-a-time rule is between STRANGERS.
 */
export const MAX_TEAM_WORKERS = 3;
export const TEAM_SPAWN_MIN_AVAILABLE_MB = (() => {
  const raw = Number(process.env.CODING_TEAM_MIN_AVAILABLE_MB || 1_200);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1_200;
})();

/**
 * Whether one more run of `team` may start beside the runs already live.
 * The orchestrator asks this before it dispatches a worker, so a full board
 * or a tight box makes it WAIT rather than fail; assertCanSpawn asks it
 * again at the spawn, which is the gate. `starting` is how many of the
 * team's workers the orchestrator has dispatched that have not reached
 * their run yet (a worktree is being added): they hold a slot and a share
 * of the memory already, and a count of persisted runs alone would admit a
 * third worker beside two that are seconds from spawning.
 */
export async function teamSpawnSlot(team: RunTeam, starting = 0): Promise<{ ok: true } | { ok: false; reason: string; wait: boolean }> {
  const active = loadRuns().filter((r) => isLive(r.status));
  const stranger = active.find((r) => r.team?.id !== team.id);
  if (stranger) return { ok: false, wait: false, reason: `A coding run is already in progress (${stranger.id}). Wait for it or stop it first.` };
  const going = active.length + Math.max(0, starting);
  if (going >= MAX_TEAM_WORKERS) return { ok: false, wait: true, reason: `The team already has ${going} runs going.` };
  if (going >= 1 && TEAM_SPAWN_MIN_AVAILABLE_MB > 0) {
    const mb = await memAvailableMb();
    // No reading is no evidence of room: a box that cannot say how much
    // memory it has left is not one to start a second run on.
    if (mb === null) return { ok: false, wait: true, reason: `Cannot read the box's free memory, so no second run starts beside the ${going} going.` };
    if (mb < TEAM_SPAWN_MIN_AVAILABLE_MB) {
      return { ok: false, wait: true, reason: `Not enough free memory for another run beside the ${going} going (${mb} MB free, ${TEAM_SPAWN_MIN_AVAILABLE_MB} MB needed).` };
    }
  }
  return { ok: true };
}
/** Longest a status request may block waiting for a run to finish. */
export const MAX_WAIT_MS = 120_000;
/** Runs kept in data/coding-agent-runs.json, newest first. */
const MAX_RUNS_KEPT = 30;
/** Progress lines kept per run. */
const PROGRESS_KEEP = 60;
const MAX_PROGRESS_LINE_CHARS = 160;
/**
 * The plan Claude Code keeps through its TodoWrite tool, as much of it as a
 * card can show. Twenty items is more than any run on this box has planned;
 * a longer list is a run enumerating files, not planning, and the newest
 * twenty still say where it is.
 */
const MAX_TODOS = 20;
const MAX_TODO_CHARS = 160;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_ERROR_CHARS = 1_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_STDOUT_LINE_CHARS = 1_000_000;
const STOP_GRACE_MS = 3_000;
/** How often progress is flushed to disk while a run is busy. */
const FLUSH_INTERVAL_MS = 1_000;
/**
 * How long a settling run waits for its project picture. The generation itself
 * is allowed two minutes upstream, which is the right budget while a run works
 * and far too long once it has finished: past this the run settles and the
 * picture, if it arrives at all, arrives uncommitted.
 */
const SETTLE_ICON_BUDGET_MS = 20_000;

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
 *  the appliance is offline-first and the task is local code. The sub-agent
 *  tool is always on (SUBAGENT_DEFINITIONS gives it something to delegate to);
 *  the Workflow tool joins it under ultracode only — see WORKFLOW_TOOL. */
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
  /**
   * The agent a workflow's `agent()` runs when the script names no agentType.
   * Claude Code's built-in of this name is a full writer on the session's
   * model, and the brief's "every agent() must pass agentType" was ignored on
   * the first ultracode bench run (run-roo5mgvd, 2026-09-03: a four-agent
   * review workflow, all four on the tier model, none typed). A definition of
   * the same name in `--agents` shadows the built-in — measured on this box:
   * the default agent then runs on flash with these tools — so the omission
   * costs flash tokens and can edit nothing, instead of four pro readers.
   */
  "workflow-subagent": {
    description:
      "The agent a workflow runs when its agent() call names no agentType: "
      + "reads, runs checks, reports. Use proactively as a workflow's reader; "
      + "it never edits.",
    prompt:
      "You are one agent of a workflow. Read the files and run the checks you "
      + "were asked to, then report findings with file paths and line numbers, "
      + "or say plainly that you found nothing. Never edit a file.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "deepseek-v4-flash",
  },
} as const;

export type SubagentName = keyof typeof SUBAGENT_DEFINITIONS;

/**
 * Claude Code's dynamic-workflow tool — the orchestration half of ultracode.
 *
 * Ultracode is xhigh effort plus a standing opt-in to orchestrate the work
 * with this tool, and the CLI's own ultracode reminder tells the model to use
 * it on every substantive task. Until 2026-09-03 a run never had it: `--tools`
 * left it out — and even listed, a headless run cannot use it: the tool asks
 * "Review dynamic workflow before running", and in -p mode that question is
 * answered with a denial. The model gets it as an is_error tool_result,
 * retries the identical call (twice in the probe, two steps gone), and the
 * owner sees only a permission denial on the card. Pre-approved through
 * `--allowedTools Workflow` it works (measured on this box with the installed CLI: a workflow
 * launches in the background, reports task_started / task_progress /
 * task_notification on the stream, and each agent runs on the model its
 * agentType names). So the default effort was quietly half of itself: the
 * thinking, none of the fan-out. The fixed levels never get the tool — there
 * the owner did not opt into orchestration.
 */
export const WORKFLOW_TOOL = "Workflow";

/** The tools of a run that may only read — a team's planner. */
/**
 * The one place outside its folder a run may read: /tmp, where it puts what
 * it curls out of its own server or a build's log. Claude Code asks before
 * reading outside the working folder, and a headless run cannot answer, so
 * the ask became a refusal on the run's page ("Not allowed: Read
 * /tmp/…") for a file the run had written itself. `//` is Claude Code's
 * absolute-path prefix in a permission rule.
 */
export const TMP_READ_RULE = "Read(//tmp/**)";

export const READ_ONLY_TOOLS = `Read,Grep,Glob,${SUBAGENT_TOOL}`;

export function toolsFor(subagents: boolean, effort?: CodingEffort): string {
  const tools = subagents ? `${CLAUDE_TOOLS},${SUBAGENT_TOOL}` : CLAUDE_TOOLS;
  return effort === ULTRACODE_EFFORT ? `${tools},${WORKFLOW_TOOL}` : tools;
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
 * The ONE command deny-list a run is actually started with. Every command is
 * allowed (`Bash(*)`, see buildRunArgs) except killing by NAME and killing
 * every process: the box's own web server is a Next server, and on
 * 2026-09-05 a run's `pkill -f next-server`, meant for the dev server it had
 * started, took ClawBox down with it — systemd restarted the box's server,
 * which marked the run lost fourteen minutes in. A run ends what it started
 * by PID. A deny rule outranks any allow rule in Claude Code, so `Bash(*)`
 * cannot reach these.
 */
export const BASH_KILL_DENYLIST: readonly string[] = [
  "Bash(pkill:*)", "Bash(killall:*)", "Bash(fuser:*)",
  "Bash(kill -1:*)", "Bash(kill -9 -1:*)", "Bash(kill -15 -1:*)", "Bash(kill -TERM -1:*)", "Bash(kill -KILL -1:*)", "Bash(kill -s:*)",
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

// The status machine is owned by coding-agent-status.ts (the client and the
// MCP server read it too); re-exported here for the modules that always
// imported it from the runner.
export type { CodingRunStatus };
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
  filesTouched: string[];
  commandsRun: number;
  /** Set on an automatic review pass: the id of the run it reviews. */
  reviewOf: string | null;
  /**
   * Set on a run a coding TEAM spawned (src/lib/coding-team.ts): which team,
   * in which role, for which task. The board is the audit trail; this is the
   * run's own pointer back to it.
   */
  team: RunTeam | null;
  /**
   * A run that may only read: the team's planner. Its tools are Read, Grep,
   * Glob and the read-only helpers, and no command runs. Frozen at start
   * like the effort, so a retry cannot widen it.
   */
  readOnly: boolean;
  /** Words the team appended to the brief — the planner's or a worker's role. */
  extraBrief: string | null;
  /**
   * The pull request this run's work went into, once the auto-PR switch is on.
   *
   * A FIELD and not a new run status, on purpose. RUN_STATUSES is the persisted
   * allow-list, and readAll() drops any record whose status is not in it before
   * the next writeAll() rewrites the file — so an unrecognised status is a
   * silent DELETE of the run, not a hidden row. A field is forward- and
   * backward-compatible: normalizeRun gives an older record the default below,
   * and an older build ignores a field it does not know.
   */
  pr: PrState | null;
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
  /** The helpers that have finished, oldest first, the newest SUBAGENT_HISTORY_KEPT: what each did and how long it took. */
  subagents: FinishedSubagent[];
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
   * only for a run that had left nothing behind but inspection output and
   * convergent package-manager setup — see TRANSIENT_FAILURE_RE.
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
  /** When each progress line was recorded (ms since the epoch), one for one with `progress`. */
  progressAt: number[];
  /**
   * The run's OWN plan — the latest list Claude Code wrote with its TodoWrite
   * tool, whole, replacing the one before it.
   *
   * The progress feed says what tool the run just called; this says what it
   * is trying to do and how far along it is, in its own words. It is the
   * difference between "Read app.js" and "Wiring the game loop — 3 of 7
   * done", and it is what the owner asked to see while a run works. A run
   * that never plans has an empty list, and that is fine: the feed still
   * carries its steps.
   */
  todos: CodingTodo[];
  exitCode: number | null;
  /**
   * The media switches as they stood when this run STARTED, like `effort` and
   * `maxTurns`: the tools a run was given cannot appear or vanish under it
   * because the owner flipped a switch while it worked.
   */
  media: RunMedia;
  /** Pictures and clips this run has already been given, against the caps. */
  mediaGenerated: { images: number; audio: number };
  /**
   * The process group this run was spawned into, kept so a leftover server can
   * still be ended after the run itself has settled and `live` has forgotten
   * it. Null for a record that never spawned, or one from before this field.
   */
  pgid: number | null;
  /**
   * Something the run started is STILL RUNNING now that the run has finished.
   *
   * Not a fault: the orientation guide tells a run to leave a server listening
   * so its app can be reached from the desktop, so a naturally-finished run's
   * process group is deliberately not killed. The owner is told, and the run's
   * page offers to end it — which is the difference between a documented
   * pattern and a leak nobody can see.
   */
  leftover: boolean;
  /** Why the run's work could not be committed at settle — null when it was, or when there was nothing to commit. A team acts on it: a worker whose commit failed has no branch to merge. */
  commitError: string | null;
}

/** Which media a run may ask this box for — read once, at its start. */
export interface RunMedia {
  images: boolean;
  audio: boolean;
}

/** One item of the run's plan, as Claude Code's TodoWrite tool reports it. */
export interface CodingTodo {
  content: string;
  status: CodingTodoStatus;
  /** The present-tense form of the item — "Wiring the game loop" — when the
   *  tool sent one. The card shows it as "now" while the item is in progress. */
  activeForm?: string;
}

export type CodingTodoStatus = "pending" | "in_progress" | "completed";
const TODO_STATUSES: readonly CodingTodoStatus[] = ["pending", "in_progress", "completed"];

/** One sub-agent currently out, as the owner should read it. */
export interface ActiveSubagent {
  /** Which definition it is — explorer, tester, reviewer. */
  type: string;
  /** What it was asked to do, in the run's own words. */
  description: string;
  startedAt: number;
}

/** A helper that has come back — or was refused — with when, so the page can say how long it took. */
export interface FinishedSubagent extends ActiveSubagent {
  endedAt: number;
  refused: boolean;
}

/** How many finished helpers a run record keeps — the newest; the counts by type keep the total. */
export const SUBAGENT_HISTORY_KEPT = 40;

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
  /** What the device proposes when they have not chosen one: ~/Projects. */
  suggestedDirectory: string;
  /** enabled AND the harness is installed and connected — i.e. a run can start. */
  ready: boolean;
  readiness: CodingHarnessReadiness;
  running: number;
  /** The owner's switch for the automatic review pass after a completed run. */
  reviewPass: boolean;
  /** The owner's switch for branch -> pull request -> wait for checks -> merge. */
  autoPr: boolean;
  /** May a run draw pictures, and may the box draw the project's icon? */
  generateImages: boolean;
  /** May a run have this box speak a clip into its project? */
  generateAudio: boolean;
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
  /** False until the owner finishes the setup wizard — the app shows the
   *  wizard instead of the home page while it is. */
  setupComplete: boolean;
}

export interface StartRunInput {
  task: string;
  projectId?: string | null;
  directory?: string | null;
  resumeRunId?: string | null;
  source: CodingRunSource;
  /** Internal: set only by the automatic review pass, naming the run under review. */
  reviewOf?: string | null;
  /** Internal: set only by a coding team, for its planner and its workers. */
  team?: RunTeam | null;
  /** Internal: a read-only run (the team's planner). */
  readOnly?: boolean;
  /** Internal: appended to the headless brief — the role the team gave this run. */
  extraBrief?: string | null;
}

/** A run's place in a coding team. */
export interface RunTeam {
  id: string;
  role: "planner" | "worker" | "reviewer";
  taskId: string | null;
}

export type CodingAgentErrorKind = "disabled" | "not_ready" | "busy" | "invalid" | "not_found";

/** Thrown by startRun/stopRun; the routes map `kind` to a status code. */
export class CodingAgentError extends Error {
  constructor(readonly kind: CodingAgentErrorKind, message: string) {
    super(message);
    this.name = "CodingAgentError";
  }
}

/**
 * The HTTP status a route answers a CodingAgentError with — ONE table, so the
 * five routes that catch one cannot disagree. The three refusals are 409:
 * "the request cannot be satisfied as things stand" — the switch is off, the
 * harness is not ready, the slot is taken — which the MCP layer reads as
 * CONFLICT / do-not-retry (403 would read as "the device token was rejected",
 * 500 as "try again").
 */
export function httpStatusForCodingError(kind: CodingAgentErrorKind): number {
  switch (kind) {
    case "invalid": return 400;
    case "not_found": return 404;
    default: return 409;
  }
}

// ─── The owner's switch ──────────────────────────────────────────────────────

export async function isCodingAgentEnabled(): Promise<boolean> {
  return (await configGet(CODING_AGENT_CONFIG_KEY)) === true;
}

// Each setting is derived from its raw config value by a pure function, so a
// single read of config.json can answer the whole status (getCodingAgentStatus
// used to open the file eight times per poll) while the one-key getters below
// keep their names.

function defaultDirectoryFrom(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function effortFrom(raw: unknown): CodingEffort {
  return isEffort(raw) ? raw : DEFAULT_EFFORT;
}

function maxTurnsFrom(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_TURNS;
  return Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, Math.round(raw)));
}

function tokenLimitFrom(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= MIN_TOKEN_LIMIT ? Math.round(raw) : null;
}

export async function setCodingAgentEnabled(enabled: boolean): Promise<void> {
  await configSet(CODING_AGENT_CONFIG_KEY, enabled === true);
}

/** The owner's default working folder, or null when they have not set one. */
/**
 * The folder this device proposes for a run's work: ~/Projects.
 *
 * It is a SUGGESTION, not a default that silently takes effect — the wizard
 * pre-fills its field with this so the common case is one tap, and the owner
 * can browse to anything else before saving.
 */
export function suggestedDefaultDirectory(): string {
  return path.join(homeDir(), "Projects");
}

/**
 * Create the suggested folder if it is not there yet.
 *
 * A fresh box has no ~/Projects, so a wizard that pre-filled the path would
 * have saved a folder that does not exist and been refused. Called when the
 * owner actually saves a folder inside their own home — never for a path
 * outside it, where creating directories on someone's behalf is not this
 * feature's business.
 *
 * `recursive: true` also makes it a no-op when the folder already exists,
 * which is the usual case.
 */
async function ensureDirectoryInsideHome(directory: string): Promise<void> {
  const home = path.resolve(homeDir());
  const target = path.resolve(directory);
  // The lexical fence, on the very value mkdir is given — a resolved absolute
  // path tested against the home, which is the shape a static analyser
  // recognises as contained. The home itself is out too: it exists, and it is
  // never a working folder (resolveWorkingDirectory refuses it).
  if (!target.startsWith(home + path.sep)) return;
  // The fence that holds on disk: a symlink under the home may lead anywhere
  // (~/scratch → /), the lexical test cannot see it, and mkdir follows it —
  // ~/scratch/Projects would have created /Projects. So the nearest ancestor
  // that exists has to be inside the REAL home as well; what is missing above
  // it cannot be a link, and is what mkdir makes.
  if (!(await existingAncestorInside(target, home))) return;
  try {
    await fs.promises.mkdir(target, { recursive: true });
  } catch {
    // Leave it to resolveWorkingDirectory below to answer "does not exist" in
    // the owner's words; a failure here is not a different fact.
  }
}

/**
 * True when the deepest part of `target` that exists — the path itself, or
 * the nearest ancestor of it — really lies inside `home`, symlinks resolved on
 * both sides. Walks up until realpath answers; the root always does.
 */
async function existingAncestorInside(target: string, home: string): Promise<boolean> {
  const realHome = await fs.promises.realpath(home).catch(() => home);
  let probe = target;
  for (;;) {
    try {
      return isInside(await fs.promises.realpath(probe), realHome);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

export async function getDefaultDirectory(): Promise<string | null> {
  return defaultDirectoryFrom(await configGet(CODING_AGENT_DIR_CONFIG_KEY));
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
  // An absolute path, and only that. The resolver reads a bare name as a
  // folder INSIDE the current default — right when the assistant names a
  // run's folder, wrong for the setting that says where "inside" is: a name
  // typed here was looked for under the previous default and answered "does
  // not exist", and one that happened to exist there quietly moved the
  // default a level down.
  if (!path.isAbsolute(directory.trim())) {
    throw new CodingAgentError("invalid", `Give an absolute path, e.g. ${path.join(homeDir(), "Projects")}.`);
  }
  // Make it real before resolving. The wizard pre-fills ~/Projects, which a
  // fresh box does not have, and "that folder does not exist" is a strange
  // thing to tell someone who just accepted the folder the device proposed.
  // Fenced to the owner's home: outside it, a missing folder is still an error.
  await ensureDirectoryInsideHome(directory.trim());
  const { directory: resolved } = await resolveWorkingDirectory({ directory, asDefault: true });
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
  return effortFrom(await configGet(CODING_AGENT_EFFORT_CONFIG_KEY));
}

export async function setEffort(effort: string): Promise<CodingEffort> {
  if (!isEffort(effort)) {
    throw new CodingAgentError("invalid", `Effort must be one of: ${EFFORT_LEVELS.join(", ")}.`);
  }
  await configSet(CODING_AGENT_EFFORT_CONFIG_KEY, effort);
  return effort;
}

/** The owner's switch for the automatic review pass. Absent means OFF. */
export async function getReviewPass(): Promise<boolean> {
  return (await configGet(CODING_AGENT_REVIEW_CONFIG_KEY)) === true;
}

export async function setReviewPass(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") throw new CodingAgentError("invalid", "The review pass switch must be true or false.");
  await configSet(CODING_AGENT_REVIEW_CONFIG_KEY, on);
  return on;
}

export async function getAutoPr(): Promise<boolean> {
  return (await configGet(CODING_AGENT_AUTO_PR_CONFIG_KEY)) === true;
}

export async function setAutoPr(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The pull-request switch must be true or false.");
  }
  await configSet(CODING_AGENT_AUTO_PR_CONFIG_KEY, on);
  return on;
}

/** The two media switches. ON when absent — see their config keys. */
function generateImagesFrom(raw: unknown): boolean {
  return raw !== false;
}

function generateAudioFrom(raw: unknown): boolean {
  return raw !== false;
}

export async function getGenerateImages(): Promise<boolean> {
  return generateImagesFrom(await configGet(CODING_AGENT_GEN_IMAGES_CONFIG_KEY));
}

export async function setGenerateImages(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The picture switch must be true or false.");
  }
  await configSet(CODING_AGENT_GEN_IMAGES_CONFIG_KEY, on);
  return on;
}

export async function getGenerateAudio(): Promise<boolean> {
  return generateAudioFrom(await configGet(CODING_AGENT_GEN_AUDIO_CONFIG_KEY));
}

export async function setGenerateAudio(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") {
    throw new CodingAgentError("invalid", "The voice switch must be true or false.");
  }
  await configSet(CODING_AGENT_GEN_AUDIO_CONFIG_KEY, on);
  return on;
}

/** Record that the owner finished (or re-entered) the setup wizard. */
export async function setSetupComplete(done: unknown): Promise<boolean> {
  if (typeof done !== "boolean") {
    throw new CodingAgentError("invalid", "The setup flag must be true or false.");
  }
  await configSet(CODING_AGENT_SETUP_CONFIG_KEY, done);
  return done;
}

/**
 * Put every coding-agent setting back to factory and send the owner to the
 * wizard: the switch off, no default folder, effort/ceilings/review back to
 * their defaults.
 *
 * The run history goes too. It was left alone at first — an audit trail is not
 * a setting — but "start over" that leaves last week's runs listed under a
 * freshly-configured agent is not starting over: the owner finished the wizard
 * and was met by the run they had just reset away. Finished runs and their
 * evidence folders are dropped, exactly as the runs list's own Clear does;
 * anything HELD (live, paused, drafted) is kept, because those hold a
 * resumable session and are not history yet.
 *
 * Deliberately NOT included: the GitHub credential. It is a login the owner
 * made against another service, not a setting of this device, and Settings has
 * its own two-tap Sign out for it.
 *
 * @returns how many finished runs were cleared, so the caller can say so.
 */
export async function resetCodingAgentSetup(): Promise<number> {
  for (const key of CODING_AGENT_RESET_KEYS) {
    await configSet(key, undefined);
  }
  return clearFinishedRuns();
}

/** The owner's turn ceiling, clamped to something the CLI will accept. */
export async function getMaxTurns(): Promise<number> {
  return maxTurnsFrom(await configGet(CODING_AGENT_TURNS_CONFIG_KEY));
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
  return tokenLimitFrom(await configGet(CODING_AGENT_TOKENS_CONFIG_KEY));
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
  return (await readProjectFolders())?.names ?? [];
}

/**
 * The owner's folder and the names in it. Null when no folder is set; a
 * folder that is set but cannot be read answers with no names, so the caller
 * can still say WHICH folder it looked in.
 */
async function readProjectFolders(): Promise<{ base: string; names: string[] } | null> {
  const base = await getDefaultDirectory();
  if (!base) return null;
  return { base, names: await readFolderNames(base) };
}

/**
 * The one readdir behind every listing: the folder names directly inside
 * `base`, or none when it cannot be read.
 *
 * `isDirectory()` on the Dirent, deliberately: a symlink is never followed,
 * so a link out of the folder is not offered as a project in it.
 */
/** The most folders a listing names — the readdir's and the run store's alike. */
const MAX_PROJECT_FOLDERS = 100;

async function readFolderNames(base: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_PROJECT_FOLDERS);
  } catch {
    return [];
  }
}

/**
 * Where code projects live: the folders code_project_init scaffolds and a run
 * given a project id works in. The code project library keeps this path to
 * itself (its one exported path helper, projectPath, answers per id), and
 * resolveWorkingDirectory below spells it out again for the same reason — a
 * listing needs the folder, not one project in it.
 */
const CODE_PROJECTS_DIR = path.join(DATA_DIR, "code-projects");

/** Where a listed project comes from: the owner's folder, or data/code-projects. */
export type CodingProjectKind = "folder" | "codeProject";

/** One project of the owner's, as the Coding Agent app lists it. */
export interface CodingProject {
  /** The folder's name — the name a run is given. For a code project, its id. */
  folder: string;
  /** The absolute folder. */
  directory: string;
  kind: CodingProjectKind;
  /** From project.json when the folder is a code project; the folder name otherwise. */
  name: string;
  lastCommit: LastCommit | null;
  /** Registered on the desktop as a web app (data/webapps/<folder>/meta.json). */
  onDesktop: boolean;
  /**
   * The project's own icon, once one has been drawn for it — the URL the app
   * puts in an <img>, not a path. Null while there is none, which is what the
   * row draws its lettered placeholder for.
   */
  iconUrl: string | null;
  /** The newest run that worked in this folder, if any has. */
  latestRun: Pick<CodingRun, "id" | "status" | "task" | "startedAt" | "completedAt"> | null;
}

/**
 * The code project the Coding Agent app's Test-harness button runs its smoke
 * task in. The app keeps the same literal (HARNESS_TEST_PROJECT in
 * CodingAgentApp.tsx); the projects test holds the two together.
 */
export const HARNESS_TEST_PROJECT_ID = "harness-test";

/** A folder that may be a project, before describeProject has looked. */
interface ProjectCandidate {
  base: string;
  folder: string;
  kind: CodingProjectKind;
  /**
   * A folder directly under the project folder that a run has worked in.
   * Listed even without a `.git` of its own: every run happens in a folder
   * inside the project folder, and the owner asked for every such folder to
   * be a project — the run is how they find it again.
   */
  fromRun?: boolean;
}

/**
 * Every project the owner has, from both places one can be:
 *
 * - a folder directly inside their project folder with a `.git` DIRECTORY of
 *   its own. That test, and not "any folder", because a folder with its own
 *   history is what a run leaves behind (coding-git.ts commits every run's
 *   work) and what the owner can get back to. A `.git` FILE — a worktree or
 *   submodule pointer into somebody else's repository — is not counted, for
 *   the same reason the committer refuses such a folder;
 * - a code project under data/code-projects. That is where the New app
 *   wizard's handoff lands ("scaffold it as a code project"), and it can
 *   never be the owner's folder, because resolveWorkingDirectory refuses
 *   anything inside the checkout — so a list of the owner's folder alone
 *   could never show the app the wizard had just asked for. A code project
 *   counts once it has a project.json, which code_project_init writes before
 *   any run commits, so the app appears while it is being built and not only
 *   after.
 *
 * `directory` stays the owner's folder alone: it is what the empty state
 * names as the place to build in.
 *
 * Not the Test-harness button's scratch project: the app inits it for its
 * own smoke run, and a permanent "Harness Test" row beside the owner's real
 * projects read as one of them. The smoke run itself still shows, on the
 * app's home face with every run that belongs to no listed project.
 *
 * One `git log -1` per project, a few at a time: the app asks on its poll,
 * and a hundred concurrent spawns on a Jetson is a stall, not a listing.
 */
export async function listProjects(): Promise<{ directory: string | null; projects: CodingProject[] }> {
  const [folders, codeProjects] = await Promise.all([readProjectFolders(), readFolderNames(CODE_PROJECTS_DIR)]);
  const candidates: ProjectCandidate[] = [];
  if (folders) {
    // The folders runs have worked in, directly under the project folder: a
    // project by that run alone, `.git` or not. A run records the folder it
    // worked in symlink-resolved, so both spellings of the base are matched.
    // Never a dot-folder: that is state, not a project.
    const realBase = await fs.promises.realpath(folders.base).catch(() => folders.base);
    // Bounded like the readdir (readFolderNames keeps 100): the run store is
    // not a hard bound — held runs are never trimmed — and every folder here
    // costs a stat and a git log on every poll.
    const workedIn = new Set<string>();
    for (const run of loadRuns()) {
      if (workedIn.size >= MAX_PROJECT_FOLDERS) break;
      if (typeof run.directory !== "string") continue;
      for (const base of new Set([folders.base, realBase])) {
        if (!run.directory.startsWith(base + path.sep)) continue;
        const first = path.relative(base, run.directory).split(path.sep)[0];
        if (first && !first.startsWith(".")) workedIn.add(first);
      }
    }
    for (const folder of folders.names) {
      candidates.push({ base: folders.base, folder, kind: "folder", fromRun: workedIn.has(folder) });
    }
    for (const folder of workedIn) {
      if (!folders.names.includes(folder)) candidates.push({ base: folders.base, folder, kind: "folder", fromRun: true });
    }
  }
  for (const folder of codeProjects) {
    if (folder === HARNESS_TEST_PROJECT_ID) continue;
    candidates.push({ base: CODE_PROJECTS_DIR, folder, kind: "codeProject" });
  }
  const described = await mapLimit(candidates, 4, describeProject);

  // Once per real folder. config.json is a file the owner can edit, so the
  // project folder can be pointed at data/code-projects by hand, and every
  // project would then be listed twice. The owner's folder was described
  // first, so its row is the one kept.
  const seen = new Set<string>();
  const projects: CodingProject[] = [];
  for (const d of described) {
    if (!d || seen.has(d.real)) continue;
    seen.add(d.real);
    projects.push(d.project);
  }
  projects.sort((a, b) => (b.lastCommit?.date ?? 0) - (a.lastCommit?.date ?? 0) || a.name.localeCompare(b.name));
  return { directory: folders?.base ?? null, projects };
}

async function describeProject({ base, folder, kind, fromRun }: ProjectCandidate): Promise<{ project: CodingProject; real: string } | null> {
  const directory = path.join(base, folder);
  const [dotGit, metaName, self] = await Promise.all([
    fs.promises.stat(path.join(directory, ".git")).catch(() => null),
    projectNameOf(directory, folder),
    fromRun ? fs.promises.stat(directory).catch(() => null) : Promise.resolve(null),
  ]);
  const hasGit = dotGit?.isDirectory() === true;
  // A plain folder is a project by its history alone; a code project by its
  // project.json as well, since the scaffold comes before the first commit;
  // and a folder a run has worked in by that run, as long as it still exists.
  const workedIn = fromRun === true && self?.isDirectory() === true;
  if (!hasGit && !workedIn && !(kind === "codeProject" && metaName !== null)) return null;
  const [commit, onDesktop, hasIcon, real] = await Promise.all([
    // Only a folder with its own history is asked. `git log` in one without
    // walks UP to the nearest repository — for a code project, ClawBox's own
    // checkout — and would present the OS's last commit as the app's.
    hasGit ? lastCommit(directory) : Promise.resolve(null),
    isOnDesktop(folder),
    hasProjectIcon(folder),
    // A run records the folder it worked in symlink-resolved; match both
    // spellings so a project reached through a link still shows its run.
    fs.promises.realpath(directory).catch(() => directory),
  ]);
  // loadRuns() is newest first, so the first match is the latest run. A run
  // given a project id recorded the id as well as the folder.
  const run = loadRuns().find((r) =>
    r.directory === real || r.directory === directory || (kind === "codeProject" && r.projectId === folder),
  ) ?? null;
  return {
    real,
    project: {
      folder,
      directory,
      kind,
      name: metaName ?? folder,
      lastCommit: commit,
      onDesktop,
      iconUrl: hasIcon ? `/setup-api/apps/icon/${folder}` : null,
      latestRun: run
        ? { id: run.id, status: run.status, task: run.task, startedAt: run.startedAt, completedAt: run.completedAt }
        : null,
    },
  };
}

/**
 * The project's name from its project.json, bounded like a name the code
 * project library would accept — the file may have been written by hand —
 * or the folder's own name when the file has no usable one. Null when there
 * is no such file at all: that is what tells a code project from a folder
 * that merely sits under data/code-projects.
 */
async function projectNameOf(directory: string, folder: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readProjectJson(path.join(directory, "project.json"));
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const name = typeof parsed === "object" && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, MAX_PROJECT_NAME_LENGTH);
  } catch {
    // Not JSON, or not the shape expected: the folder's own name will do.
  }
  return folder;
}

/**
 * The most of a project.json this listing will read. code_project_init writes
 * a few hundred bytes; a delegated run can write anything into its folder,
 * and the app polls this listing — so a file it grew to gigabytes must not be
 * read into memory on every poll.
 */
const MAX_PROJECT_JSON_BYTES = 64 * 1024;

/**
 * project.json, read through one handle so the size checked is the size
 * read. Rejects when there is no such file (that is what tells a code
 * project from a plain folder under data/code-projects). A file over the
 * bound answers "" — which parses as nothing, so the folder's own name is
 * used, the same as for a file that is not JSON: it is still a project, it
 * just has no name this listing will trust.
 */
async function readProjectJson(file: string): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_PROJECT_JSON_BYTES) return "";
    // Never more than the bound, whatever the file grew to since the stat.
    const buf = Buffer.alloc(Math.min(size, MAX_PROJECT_JSON_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Whether the desktop knows this folder as a web app. A folder name that is
 * not a valid app id cannot be one, and is never spliced into a path under
 * data/webapps to find out.
 */
/**
 * Has a picture been drawn for this project (src/lib/project-icon.ts)?
 *
 * The same id rule as the desktop's, for the same reason: a folder name the
 * icon route would refuse is one no <img> could ever load, so it is never
 * spliced into a path under data/icons to find out.
 */
async function hasProjectIcon(folder: string): Promise<boolean> {
  if (!validateProjectId(folder)) return false;
  const icon = await fs.promises.stat(webappIconPath(folder)).catch(() => null);
  return icon?.isFile() === true;
}

async function isOnDesktop(folder: string): Promise<boolean> {
  if (!validateProjectId(folder)) return false;
  const meta = await fs.promises.stat(path.join(WEBAPPS_DIR, folder, "meta.json")).catch(() => null);
  return meta?.isFile() === true;
}

/** `Promise.all` with at most `limit` items in flight. Order is preserved. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
    // Chromium ships as a snap on this device; without /snap/bin a run's
    // `which chromium` answers "not installed" and the run burns minutes
    // stubbing out a browser it actually has (seen on run-3750zcwc).
    "/snap/bin",
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
  return readinessWith(await configGet("clawai_token"));
}

/** The readiness probe proper, given the ClawBox AI token the caller already read. */
async function readinessWith(token: unknown): Promise<CodingHarnessReadiness> {
  const [wrapperInstalled, claudePath, setprivPath] = await Promise.all([
    isExecutableFile(wrapperPath()),
    findExecutableOnPath("claude"),
    findExecutableOnPath(CAPABILITY_DROP_COMMAND),
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
  // One read of config.json for every setting the status carries — the app
  // polls this, and each getter above opens and parses the file on its own.
  const config = await configGetAll();
  const enabled = config[CODING_AGENT_CONFIG_KEY] === true;
  const defaultDirectory = defaultDirectoryFrom(config[CODING_AGENT_DIR_CONFIG_KEY]);
  const effort = effortFrom(config[CODING_AGENT_EFFORT_CONFIG_KEY]);
  const [readiness, projectFolders] = await Promise.all([
    readinessWith(config.clawai_token),
    defaultDirectory ? readFolderNames(defaultDirectory) : Promise.resolve([]),
  ]);
  return {
    enabled,
    defaultDirectory,
    suggestedDirectory: suggestedDefaultDirectory(),
    ready: enabled && readiness.ready,
    readiness,
    running: runningCount(),
    reviewPass: config[CODING_AGENT_REVIEW_CONFIG_KEY] === true,
    autoPr: config[CODING_AGENT_AUTO_PR_CONFIG_KEY] === true,
    generateImages: generateImagesFrom(config[CODING_AGENT_GEN_IMAGES_CONFIG_KEY]),
    generateAudio: generateAudioFrom(config[CODING_AGENT_GEN_AUDIO_CONFIG_KEY]),
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
    maxTurns: maxTurnsFrom(config[CODING_AGENT_TURNS_CONFIG_KEY]),
    minMaxTurns: MIN_MAX_TURNS,
    maxMaxTurns: MAX_MAX_TURNS,
    tokenLimit: tokenLimitFrom(config[CODING_AGENT_TOKENS_CONFIG_KEY]),
    minTokenLimit: MIN_TOKEN_LIMIT,
    runIdleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
    // An EXPLICIT flag always wins; `enabled` only stands in when there is no
    // flag at all.
    //
    // The fallback exists for a box configured before the wizard did, whose
    // owner must not be sent back through onboarding. But `flag === true ||
    // enabled` made the switch itself mean "finished", and the wizard turns the
    // switch on at step 2 so its last step has an agent to test — so the app
    // decided setup was complete mid-wizard and swapped the last step for the
    // home page about a second after it appeared.
    setupComplete: typeof config[CODING_AGENT_SETUP_CONFIG_KEY] === "boolean"
      ? config[CODING_AGENT_SETUP_CONFIG_KEY] === true
      : enabled,
  };
}

// ─── The runs store ──────────────────────────────────────────────────────────
//
// Same discipline as src/lib/email-pending.ts: one JSON file under DATA_DIR,
// written 0600 through a temp file and an atomic rename, a corrupt file read
// as empty. SYNC fs on purpose — an await between read and write is how two
// progress events from one run would lose each other's updates.

const RUNS_PATH = path.join(DATA_DIR, "coding-agent-runs.json");

// isCodingRun gates readAll, so the status check must know EVERY status
// persist() can write — a status it did not know made a restart silently
// DELETE the record (paused runs and drafts vanished, found the hard way).
// That is why the list lives in coding-agent-status.ts and nowhere else.
function isCodingRun(value: unknown): value is CodingRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && typeof v.task === "string"
    && typeof v.directory === "string"
    && isCodingRunStatus(v.status)
    && typeof v.startedAt === "number"
  );
}

/**
 * A stored `pr` blob, rebuilt field by field the way normalizeRun rebuilds
 * the run around it. One without a phase or a start is not a pull request and
 * is dropped; anything else wrong in it is repaired to its default rather
 * than trusted — a `number` that is not a number reached `gh pr view` as an
 * argument, and a count that was not a count reached the owner as
 * "undefined of undefined checks".
 */
function normalizeTeam(raw: unknown): RunTeam | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) return null;
  if (t.role !== "planner" && t.role !== "worker") return null;
  return { id: t.id, role: t.role, taskId: typeof t.taskId === "string" ? t.taskId : null };
}

function normalizePr(raw: unknown): PrState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Partial<Record<keyof PrState, unknown>>;
  if (!isPrPhase(v.phase) || typeof v.startedAt !== "number") return null;
  const checks = (typeof v.checks === "object" && v.checks !== null ? v.checks : {}) as Partial<Record<keyof PrChecks, unknown>>;
  const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);
  return {
    phase: v.phase,
    number: typeof v.number === "number" && Number.isInteger(v.number) && v.number > 0 ? v.number : null,
    url: typeof v.url === "string" ? v.url : null,
    branch: typeof v.branch === "string" ? v.branch : null,
    base: typeof v.base === "string" ? v.base : null,
    checks: { total: count(checks.total), passed: count(checks.passed), failed: count(checks.failed), pending: count(checks.pending) },
    detail: typeof v.detail === "string" ? v.detail : null,
    startedAt: v.startedAt,
    endedAt: typeof v.endedAt === "number" ? v.endedAt : null,
    // A verdict the record does not carry is not a pass: only `true` written
    // by this code counts, so a record from before the field merges nothing
    // on its own.
    reviewOk: v.reviewOk === true,
  };
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
    subagents: Array.isArray((raw as { subagents?: unknown }).subagents)
      ? ((raw as { subagents: unknown[] }).subagents).flatMap((s) => {
          const h = s as Record<string, unknown> | null;
          if (!h || typeof h.type !== "string" || typeof h.startedAt !== "number") return [];
          return [{
            type: h.type,
            description: typeof h.description === "string" ? h.description : "",
            startedAt: h.startedAt,
            endedAt: typeof h.endedAt === "number" ? h.endedAt : h.startedAt,
            refused: h.refused === true,
          }];
        }).slice(-SUBAGENT_HISTORY_KEPT)
      : [],
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
    reviewOf: typeof raw.reviewOf === "string" ? raw.reviewOf : null,
    team: normalizeTeam(raw.team),
    readOnly: raw.readOnly === true,
    extraBrief: typeof raw.extraBrief === "string" && raw.extraBrief ? raw.extraBrief : null,
    // Every field must be reconstructed here: normalizeRun builds a fresh
    // object field by field, so anything omitted survives in memory and
    // disappears the next time the file is read.
    pr: normalizePr(raw.pr),
    progress: Array.isArray(raw.progress) ? raw.progress.filter((p) => typeof p === "string") : [],
    // Only a list that matches the lines one for one is a list of their times;
    // a record from before the field has none, and the timeline says nothing.
    progressAt: (() => {
      const lines = Array.isArray(raw.progress) ? raw.progress.filter((p) => typeof p === "string").length : 0;
      const at = Array.isArray((raw as { progressAt?: unknown }).progressAt) ? ((raw as { progressAt: unknown[] }).progressAt) : [];
      return at.length === lines && at.every((n) => typeof n === "number") ? (at as number[]) : [];
    })(),
    todos: parseTodos(raw.todos) ?? [],
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
    // A record written before the media switches existed had neither tool, so
    // "off" is the truth about that run and not merely a safe default.
    media: normalizeMedia(raw.media),
    mediaGenerated: {
      images: countOf(raw.mediaGenerated?.images),
      audio: countOf(raw.mediaGenerated?.audio),
    },
    pgid: typeof raw.pgid === "number" && raw.pgid > 0 ? raw.pgid : null,
    leftover: raw.leftover === true,
    commitError: typeof raw.commitError === "string" ? raw.commitError : null,
  };
}

function normalizeMedia(raw: unknown): RunMedia {
  const value = (raw ?? {}) as Partial<RunMedia>;
  return { images: value.images === true, audio: value.audio === true };
}

function countOf(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
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
  /**
   * What the owner (or the token ceiling) asked this run to do: end for good,
   * or settle as paused with its session intact for resumeRun(). One field,
   * not two flags, because the two gestures are exclusive and the later
   * Stop overrides an earlier Pause — see requestEnd.
   */
  endRequested: "stop" | "pause" | null;
  timedOut: boolean;
  sawResult: boolean;
  /** The first init has been seen; any later one is the CLI continuing. */
  sawInit: boolean;
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
  /**
   * The API message billed last. The CLI streams one assistant event per
   * content block of a message, every one carrying the message's full usage
   * (measured on 2.1.259: thinking block, then the text or tool_use block,
   * identical usage on both) — billed per event, a turn cost double and the
   * owner's ceiling tripped at half its number. Per-message billing sums to
   * exactly the CLI's own modelUsage. A bounded set rather than the last id
   * alone: two helpers working at once interleave their events.
   */
  billedMessageIds: Set<string>;
  /**
   * Output tokens the assistant events of the current CLI segment reported.
   * Through the ClawBox AI proxy every assistant event says output_tokens 0
   * and the real number arrives only on the segment's result event (574 and
   * 9 in the probe), so the result bills the difference — and never twice on
   * a backend whose assistant events do carry it.
   */
  outputBilledInSegment: number;
  /** tool_use id → tokens already billed for that workflow, from its
   *  task_progress reports (cumulative totals; only the delta is billed). */
  helperBilled: Map<string, number>;
  /** Resolved once at start, so a retry does not need an async lookup. */
  setprivPath: string;
  /** What this run was spawned with — a retry must match, not re-read. */
  settings: { effort: CodingEffort; maxTurns: number };
  /** A shell command ran whose effects can be proven neither read-only nor safe to repeat. */
  commandMayHaveSideEffects: boolean;
  /**
   * The final result event's verdict, applied only when the process exits.
   *
   * A result event is USUALLY the stream's last word, but a resumed session
   * has been seen to emit a result-shaped event while the process kept
   * working (run-qqj1io65 showed "completed" mid-run, then worked three more
   * minutes). The process being gone is the only proof the run is over, so
   * finishRun applies this rather than the stream handler.
   */
  outcome: { status: "completed" | "failed"; error: string | null; resumable: boolean } | null;
}

/** Newest first. `null` until first use. */
let runs: CodingRun[] | null = null;
const live = new Map<string, LiveRun>();
const waiters = new Map<string, Set<() => void>>();
let flushTimer: NodeJS.Timeout | null = null;
let dirty = false;
let exitHookInstalled = false;

/**
 * Load the store. READ-ONLY on purpose: settling stale records lives in
 * reconcileAfterRestart(), called from the boot hook of the ONE process that
 * owns runs. When the settle lived here, any other process that imported this
 * module against the real root — a test worker, a script — would take a run
 * the live web server was still driving for a dead server's leftover and
 * stamp it failed on disk (measured on this box: run-0nxtbhb1, 2026-08-27).
 */
function loadRuns(): CodingRun[] {
  if (runs) return runs;
  runs = readAll();
  return runs;
}

/**
 * Settle anything the previous web server left behind, from the boot hook
 * (src/instrumentation.ts) — before anyone asks. `live` is empty when this
 * process starts, so every "running" record on disk belongs to a process that
 * no longer exists: systemd kills the whole cgroup when clawbox-setup
 * restarts at the end of an update. Returns how many were settled — the one
 * signal an operator gets that a restart killed work in progress.
 */
export function reconcileAfterRestart(): number {
  const list = loadRuns();
  let repaired = 0;
  let changed = false;
  for (const run of list) {
    // A recorded process group belonged to the cgroup this restart replaced, so
    // whatever it named is gone — and Linux is free to hand that number to
    // something else, which the Kill button would then signal in this run's
    // name. Forgetting it costs nothing: `spawnRun` records a fresh group, and
    // an offer to end a process nobody can still identify is worse than no
    // offer at all.
    if (run.pgid !== null || run.leftover) {
      run.pgid = null;
      run.leftover = false;
      changed = true;
    }
    if (run.status === "running" && !live.has(run.id)) {
      run.status = "failed";
      run.error = "The ClawBox web server restarted while this run was in progress. Start it again.";
      run.completedAt = Date.now();
      repaired += 1;
      changed = true;
    }
  }
  if (changed) {
    try {
      writeAll(list);
    } catch (err) {
      console.error("[coding-agent] could not repair the runs file:", err instanceof Error ? err.message : err);
    }
  }
  return repaired;
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
    progressAt: [...run.progressAt],
    deniedActions: [...run.deniedActions],
    activeSubagents: run.activeSubagents.map((a) => ({ ...a })),
    subagents: run.subagents.map((a) => ({ ...a })),
    subagentsByType: { ...run.subagentsByType },
    modelsUsed: [...run.modelsUsed],
    todos: run.todos.map((t) => ({ ...t })),
    // Nested, so it needs its own copy: a shared object here would let a route
    // holding a clone see the watcher's later writes — and mutate them.
    pr: run.pr ? { ...run.pr, checks: { ...run.pr.checks } } : null,
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
  // Paused runs hold a resumable session and drafts never ran — neither is
  // "finished", so the owner's clear-history sweep leaves them alone. A run
  // whose pull request is still being watched is not finished either: it has
  // SETTLED, but deleting it would take its evidence folder and leave a
  // watcher polling a record that no longer exists.
  const keep = list.filter((r) => isHeld(r.status) || isPrPending(r.pr));
  const removed = list.length - keep.length;
  if (removed === 0) return 0;
  for (const r of list) {
    if (!isHeld(r.status) && !isPrPending(r.pr)) removeArtifacts(r.id);
  }
  // Mutate the array the module hands out rather than replacing the binding,
  // so every existing reader sees the same list.
  list.length = 0;
  list.push(...keep);
  persist(true);
  console.error(`[coding-agent] cleared ${removed} finished run(s) at the owner's request`);
  return removed;
}

export function runningCount(): number {
  return loadRuns().filter((r) => isLive(r.status)).length;
}

/** The run executing right now, or null. (The record itself, not a clone: internal.) */
function activeRun(): CodingRun | null {
  return loadRuns().find((r) => isLive(r.status)) ?? null;
}

/**
 * The working folder of the run executing right now, or null. The browser
 * route uses it to scope file:// navigation to the page a run is building —
 * the ONLY file:// anything may open through the desktop browser.
 */
export function activeRunDirectory(): string | null {
  return activeRun()?.directory ?? null;
}

/** The id of the run in flight, or null — for evidence that lands server-side. */
export function activeRunId(): string | null {
  return activeRun()?.id ?? null;
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

// Owned by the artifacts leaf module (both sides of the runner validate ids);
// re-exported here under the name the routes have always imported.
export const RUN_ID_RE = ARTIFACT_RUN_ID_RE;

function normalizeTask(task: unknown): string {
  if (typeof task !== "string") throw new CodingAgentError("invalid", "A task is required.");
  const cleaned = task.replace(/\u0000/g, "").trim();
  if (!cleaned) throw new CodingAgentError("invalid", "A task is required.");
  if (cleaned.length > MAX_TASK_CHARS) {
    throw new CodingAgentError("invalid", `The task is too long: at most ${MAX_TASK_CHARS} characters.`);
  }
  return cleaned;
}

// Path containment is file-guard's one fence (every run-scoped file check
// uses it); re-exported under the name the browser route has always imported.
export { isInside };

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
  /**
   * Skip the project-folder rule: the one caller that needs to is
   * setDefaultDirectory, which validates the project folder ITSELF (and a
   * new one is never inside the old). A run never passes this.
   */
  asDefault?: boolean;
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
    // Every run happens in a folder INSIDE the project folder, never in the
    // project folder itself — a run's folder is a project the owner can find
    // again, and the project folder is the shelf they all sit on.
    throw new CodingAgentError("invalid", `Give a folder inside your project folder (${fallback}) — its name is enough — or a code project id.`);
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
  // The owner's rule: every run happens in a folder inside the project
  // folder, so every run's folder is listed under Projects. Only once a
  // project folder is set (a box without one keeps the home rule above), and
  // never for the setting that says where "inside" is (`asDefault`).
  if (!input.asDefault) {
    const base = await getDefaultDirectory();
    if (base) {
      const realBase = await fs.promises.realpath(base).catch(() => path.resolve(base));
      if (real === realBase) {
        throw new CodingAgentError("invalid", `Use a folder inside your project folder (${base}), not the project folder itself.`);
      }
      if (!isInside(real, realBase)) {
        throw new CodingAgentError("invalid", `The working folder must be inside your project folder (${base}), or be a code project.`);
      }
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
  // Learned from bench run run-g6vwqr9y (2026-08-27): the run's Edit on a
  // path outside its folder was denied, so it made the same change with
  // `sed -i` through Bash and reported success. A denial the tools enforce
  // must not be a puzzle Bash solves.
  "A denied file action is a DECISION by this device, not a flaky prompt: if Read, Write or Edit is refused for a path, do not touch that path by any other route — no sed, tee, redirection or scripts through Bash. Do the parts of the task that stay inside this folder, and report plainly which part was refused and why you left it undone.",
  "The task text may carry copy-paste artifacts. If a detail is plainly garbled — a nonsense number, a broken word — ship the sensible correction and note it in your final report; do not reproduce an obvious error verbatim.",
  "Verify efficiently: use browser_fill to set a form field by selector and browser_click on controls; never navigate a page one Tab or arrow key at a time — a whole step budget was once spent that way.",
  "The ClawBox checkout (/home/clawbox/clawbox), its data/ folder, your own run record and any session files are not yours to inspect: reads there are refused, and every attempt costs a step. Work inside your project folder and your evidence folder only.",
  "Unless you have been given full access, run ONE command per Bash call. Chaining with ; or && , pipes, redirection, subshells and heredocs are all refused, however harmless the parts look — split them into separate calls instead of retrying the combined form.",
  // Measured on bench runs run-y3i3y1lk and run-35aq5yh2 (2026-09-03): with
  // the softer "when sub-agents are available, use them" the tier model read,
  // tested and reviewed everything in its own thread and reported
  // subagentsTotal 0 every time — the helpers existed and were never named
  // as a step. So the protocol is spelled out as steps, with the reason.
  "Delegate instead of doing everything in one thread — the sub-agents are how a run stays fast and keeps its own context small: before you edit code that already exists here and you have not read, send the explorer to map it (an empty or freshly scaffolded folder has nothing to map — skip that); after each batch of changes, send the tester to run whatever check exists — the build, the tests, or a script you wrote; and before your final report, send the reviewer over your changes (name the files) and fix what it finds. Do the writing yourself: the explorer, tester and reviewer read, run and review, they never edit.",
  // The -p mechanics, measured on this box (2026-09-03): a helper is launched
  // in the background, the model's turn ends, and the CLI restarts the same
  // session with each result. Left unsaid, the model spent its steps asking
  // itself how to wait.
  "Sub-agents and workflows run in the background: launch independent ones together and keep working while they run; when nothing is left but waiting, end your turn with one line saying what is still out — you are restarted with each result as it arrives. Never poll for them, and never read their transcripts or session files.",
  "Verify your work where you can (run the build or the tests you have).",
  "The clawbox browser tools drive this device's own Chromium. You cannot see images — browser_view_local, browser_open and browser_screenshot save a screenshot into the run's evidence folder and answer with a written description of it; the interaction tools (click, type, keypress, scroll) answer briefly without one. When you build something with a visible result, open it with browser_view_local (it takes a file path in your folder) and read the description of what actually renders before you report done.",
  "Verify deliberately, not exhaustively: take a described screenshot at each state that matters and move on — never one per keystroke, and never watch a timer or animation run its course when a short interval proves the logic. A handful of screenshots is a verified app; fifty is a stalled one.",
  "You have a limited number of steps and every tool call spends one. Driving a page key by key through the browser is the fastest way to run out mid-task (measured: one run spent 103 steps on single keypresses and was cut off) — prove logic with a small script run by node instead, and spend the browser on ONE visual pass of the states that matter.",
  // Bench run run-droy3ws4 (2026-09-03) COPIED its checker into the evidence
  // folder and left the original in the project: the grep patterns inside it
  // ("TODO", "lorem ipsum") and the synopses it checked for then counted as
  // the project's own, and a 96-point site scored 54.
  "The folder named in CLAWBOX_RUN_ARTIFACTS_DIR is this run's evidence folder, shown to the owner with the run's details. Screenshots land there automatically; save test output there too, and MOVE any verification script you wrote there (mv, never a copy): a checker left behind in the project folder ships as part of the project.",
  "A short task is not a small task: deliver the complete, polished result the task implies — real styling, sensible edge handling, a finished feel — never a minimal stub.",
  // Bench run run-nmtf8v2o (2026-09-05): an eight-file site was written and
  // working inside six minutes, then fourteen more went on a screenshot of
  // every page and a review workflow over work already verified, and the
  // run was cut off before its report — the work was there, the account of
  // it never came, and two points went with it. One pass of verification is
  // the finish line, not the start of another.
  "Finish decisively: once the work is done and ONE verification pass — the tests you have, one visual pass of the states that matter, one review — has passed, write your report and stop. Do not review verified work a second time, re-screenshot pages already described, or start a workflow whose only job is to look again: a run that runs out of time before its report loses the report, and the report is what the owner reads.",
  // The same run added a hero picture and left a checker script beside an
  // "exactly these files" brief, and lost three points to files nobody asked
  // for; s-02's run (2026-09-05) spent five minutes searching the disk for a
  // file that was not where the task said it would be.
  "Deliver what the task names and nothing beside it: when it lists the files to produce, produce exactly those — no extra assets, pictures, notes or scripts, however nice; anything you make only to check your work goes to the evidence folder. When a file or folder the task relies on is not where the task says, look once where it points, then treat that step as undoable and report it — never search the disk for it.",
  "Your final message is delivered to the person who delegated the task. State what you changed (file names), how they can check it, and anything you could not finish.",
].join(" ");

/**
 * Added to the brief under ultracode only: what the Workflow tool is for on
 * this box. The CLI's own reminder says "use it on every substantive task;
 * token cost is not a constraint", and the inline reference it ships offers
 * writer fan-outs, worktree isolation and scriptPath re-runs — each of which
 * is wrong here: a run is single-writer by design (the record's changed
 * files and the review pass that hangs off them come from the main loop's
 * own edits; a workflow agent's writes would reach the commit — it stages
 * the whole folder — and nothing else), the
 * folder is not a git repository of its own, the session files are denied
 * paths where every Read costs a step, and the owner's ceilings do apply. So
 * this says what a workflow IS for on this box — many read-only helpers in
 * one step — and names the three traps by name.
 */
/**
 * The brief for a run that may only READ — a team's planner. The headless
 * brief describes Bash, the browser tools, the evidence folder and the
 * workflow fan-out, none of which such a run has; a model told about them
 * spends its steps on calls that are refused.
 */
export const READ_ONLY_BRIEF = [
  "You are running unattended on a ClawBox — a small Linux device on someone's desk — inside the folder you were started in, on behalf of the device's assistant.",
  "Nobody can answer questions, so make sensible assumptions and keep going. This is a READ-ONLY session: you have Read, Grep and Glob and the read-only helper agents, no shell, no browser and no way to write — do not try to edit, create or run anything; your ANSWER is your final message.",
  "Delegate reading to the explorer helper when a question spans many files, and keep your own context small. You have a limited number of steps and every tool call spends one.",
  "The task text may carry copy-paste artifacts; read past them. Your final message is delivered to the party that started you and is read by a program as well as a person: answer in exactly the form the task asks for, with nothing before or after it.",
].join(" ");

export const ULTRACODE_BRIEF = [
  "Ultracode is on and the Workflow tool is approved for this run: it is the one-step way to run many READ-ONLY helpers at once — map many files, verify many pages, review many changes — with agent(), parallel() and pipeline().",
  "Every agent() must pass agentType \"explorer\", \"tester\" or \"reviewer\" (never general-purpose, never a workflow inside a workflow, never isolation: \"worktree\" — this folder is not a git repository of its own), and the writing stays with you: shared code first, then the parts, then a workflow to check them all.",
  "The owner's step and token ceilings apply to this run and every token a workflow's agents spend is billed to it, whatever the reminder says about cost — size a workflow to the task: a task of one to three files needs no workflow at all (the explorer, tester and reviewer helpers are enough), a larger one at most ONE, launched when there are many things to check at once, never to review work you have already verified.",
  "A script's meta must be a plain object literal. If a workflow fails or returns nothing useful, send a narrower script inline — never scriptPath or resumeFromRunId, and never Read the script file, transcript or journal its result names: that folder is closed to you and each attempt costs a step.",
].join(" ");

/**
 * Added to the brief only for a run whose owner left the picture switch on.
 *
 * Three things have to be said, and each of them was learned somewhere else in
 * this file: what the tool actually costs (the ClawBox AI allowance is
 * per-UTC-day and 1/day on the free plan — see clawai-images.ts), that a
 * refusal naming the allowance is an answer and not a flake (a small model
 * retries a 429 forever otherwise), and that the project's own icon is drawn
 * for it — a run that drew its own would spend two pictures on one file and
 * then lose the race with `wx`.
 *
 * The last sentence forbids the substitute a capable model reaches for when it
 * cannot draw: rendering an SVG or a PIL canvas to PNG and calling it art. That
 * is not what the owner asked for and it looks like it.
 */
export const MEDIA_BRIEF_IMAGES = [
  "generate_image draws a real picture with this box's ClawBox AI plan and writes a PNG into your working folder — hero art, sprites, backgrounds, textures, a logo.",
  "Spend it on the handful of pictures that carry the project, never one per element: each costs the owner's daily allowance, and a refusal that names the allowance or the credential means carry on without pictures rather than retry.",
  "Do not fake one with an SVG-to-PNG script or a Python imaging library, and do not draw the project's own icon: this box draws favicon.png, favicon.ico and the desktop icon for you shortly after the run starts. Before you finish, check with Glob that favicon.png is there and link <link rel=\"icon\" href=\"favicon.png\"> from every page only then — when the allowance was spent or the drawing failed, the files never arrive, and a link to a file that is not there is a broken link in every page you ship.",
].join(" ");

/**
 * The audio half. Its costs are not the pictures' costs, so it says its own:
 * synthesis is ONE box-wide slot shared with the chat's spoken replies
 * (withSpeechQueue in voice-speak.ts), and Kokoro refuses outright when the
 * board is short of memory — which a run's own node build makes likely, and
 * which is a fact about the box rather than about the sentence.
 */
export const MEDIA_BRIEF_AUDIO = [
  "generate_audio speaks text in this box's own voice and writes a WAV into your working folder — narration, a greeting, a spoken cue.",
  "Keep the clips short and few: the box has one voice and the chat shares it, so \"busy\" or a memory refusal means try once more later and then carry on without sound.",
].join(" ");

const FILE_TOOLS = ["Read", "Edit", "Write"] as const;
/** Always denied under data/, whether or not they exist yet. */
// email-outcomes.json sits beside email-pending.json for the same reason: it
// names who the owner mailed and what about. A run has no business reading
// either, and a file that only exists once mail has been approved is exactly
// the kind that gets added to the store and forgotten here.
const DATA_SECRET_FILES = ["config.json", "kv.json", ".mcp-token", ".session-secret", "email-pending.json", "email-outcomes.json", "coding-agent-runs.json"];

/**
 * Claude Code's Read/Edit/Write rules for the paths a run must not open.
 * `//` = absolute path in that rule syntax (a single leading slash would mean
 * "relative to the project root").
 *
 * Neither the checkout nor its data/ is denied wholesale: a deny rule
 * outranks `acceptEdits`, and the run's own working folder is usually
 * data/code-projects/<id>, inside both. Instead every entry of each is denied
 * individually — data/ except its public subtrees (the same containment rule
 * file-guard applies to the ClawBox file tools), and the checkout except
 * data/ itself, whose entries the first pass already covered. Without the
 * second pass the brief's promise that the checkout is off limits held for
 * nothing but data/ and .env: src/, mcp/ and scripts/ were open to Read.
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
  /** Every entry of `dir` except those `keep` names, each by what it is now. */
  const denyEntries = (dir: string, fixed: readonly string[], keep: (entry: string) => boolean) => {
    const entries = new Set<string>(fixed);
    try {
      for (const entry of fs.readdirSync(dir)) entries.add(entry);
    } catch {
      // no such folder yet — the fixed list still applies
    }
    for (const entry of [...entries].sort()) {
      if (keep(entry)) continue;
      const abs = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        // listed but absent: treat as a file
      }
      if (isDir) denyTree(abs);
      else denyFile(abs);
    }
  };
  for (const sub of DENIED_HOME_SUBTREES) denyTree(path.join(home, sub));
  denyEntries(DATA_DIR, DATA_SECRET_FILES, (entry) => DATA_DIR_PUBLIC_SUBTREES.has(entry));
  denyEntries(CONFIG_ROOT, [".env"], (entry) => path.join(CONFIG_ROOT, entry) === DATA_DIR);
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

/**
 * The browser family a run may call through the clawbox MCP server — and the
 * ONLY MCP tools a run may call: --strict-mcp-config keeps other servers out,
 * the browser profile keeps the rest of the clawbox tool set unregistered,
 * and this allow-list is what approves the calls in headless mode.
 * Exported for the contract test.
 */
export const MCP_BROWSER_TOOLS = [
  "mcp__clawbox__browser_view_local",
  "mcp__clawbox__browser_open",
  "mcp__clawbox__browser_navigate",
  "mcp__clawbox__browser_screenshot",
  "mcp__clawbox__browser_close",
  "mcp__clawbox__browser_click",
  "mcp__clawbox__browser_type",
  "mcp__clawbox__browser_fill",
  "mcp__clawbox__browser_keypress",
  "mcp__clawbox__browser_scroll",
  // Not a browser tool, but registered in the same run profile: the written
  // description of a local image file, for models that cannot see pixels.
  "mcp__clawbox__describe_image",
] as const;

/**
 * The two media tools, by the switch that offers each.
 *
 * Kept apart from MCP_BROWSER_TOOLS rather than folded into it because they
 * are CONDITIONAL: a run whose owner switched pictures off is never told the
 * tool exists, which is the difference between a capability and a refusal the
 * model will spend steps arguing with.
 */
export const MCP_MEDIA_TOOLS: Record<keyof RunMedia, string> = {
  images: "mcp__clawbox__generate_image",
  audio: "mcp__clawbox__generate_audio",
};

/** Every MCP tool this run may call: the browser family, plus what it may draw and say. */
export function runMcpTools(media: RunMedia | undefined): string[] {
  const tools: string[] = [...MCP_BROWSER_TOOLS];
  if (media?.images) tools.push(MCP_MEDIA_TOOLS.images);
  if (media?.audio) tools.push(MCP_MEDIA_TOOLS.audio);
  return tools;
}

/**
 * The media the run's own MCP server registers, as its environment names it.
 *
 * A comma-separated list rather than two booleans so a run with neither gets
 * NO variable at all, which is what the server reads as "register nothing".
 * It carries no secret — see buildRunMcpConfig.
 */
export function runMediaEnv(media: RunMedia | undefined): string {
  return [media?.images ? "images" : null, media?.audio ? "audio" : null].filter(Boolean).join(",");
}

/**
 * The MCP config a run gets: the clawbox server in its browser-only profile.
 * No token in here — argv is world-readable in /proc, so the server reads
 * data/.mcp-token itself through its normal file fallback. Exported for the
 * contract test.
 */
export function buildRunMcpConfig(run: { id: string; directory: string; media?: RunMedia }): string {
  const media = runMediaEnv(run.media);
  return JSON.stringify({
    mcpServers: {
      clawbox: {
        command: path.join(homeDir(), ".bun", "bin", "bun"),
        args: ["run", path.join(CONFIG_ROOT, "mcp", "clawbox-mcp.ts")],
        env: {
          CLAWBOX_API_BASE: `http://127.0.0.1:${process.env.PORT || "80"}`,
          CLAWBOX_ROOT: CONFIG_ROOT,
          CLAWBOX_MCP_PROFILE: "browser",
          CLAWBOX_RUN_ARTIFACTS_DIR: artifactsDir(run.id),
          CLAWBOX_RUN_DIR: run.directory,
          ...(media ? { CLAWBOX_RUN_MEDIA: media } : {}),
        },
      },
    },
  });
}

/** The argv handed to the wrapper. Exported for the contract test. */
export function buildRunArgs(opts: { resumeSessionId?: string | null; maxTurns?: number; effort?: CodingEffort; readOnly?: boolean; extraBrief?: string | null; run?: { id: string; directory: string; media?: RunMedia } }): string[] {
  const brief = [
    // A read-only run has no Bash, no browser and no Write: the brief that
    // describes them would spend its steps on calls that are refused.
    opts.readOnly
      ? READ_ONLY_BRIEF
      : (opts.effort === ULTRACODE_EFFORT ? `${HEADLESS_BRIEF} ${ULTRACODE_BRIEF}` : HEADLESS_BRIEF),
    // Only for the run that HAS the tool: a brief that described a picture
    // tool to a run without one would spend steps on a call that is not there.
    // A read-only run holds no media tool either (runMcpTools is skipped for
    // it below), so it hears nothing about drawing or speaking.
    ...(opts.run?.media?.images && !opts.readOnly ? [MEDIA_BRIEF_IMAGES] : []),
    ...(opts.run?.media?.audio && !opts.readOnly ? [MEDIA_BRIEF_AUDIO] : []),
    // A team's role for this run — the planner's "answer with a JSON array",
    // a worker's "this is your task among these" — after the device's own
    // words, never instead of them.
    ...(opts.extraBrief ? [opts.extraBrief] : []),
  ].join(" ");
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--permission-mode", "acceptEdits",
    "--setting-sources", "user",
    "--max-turns", String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
    "--append-system-prompt", brief,
  ];
  // Ultracode travels as a flag, the fixed levels through the wrapper's env
  // pin (see EFFORT_LEVELS). The wrapper would add the flag itself from the
  // owner's stored setting, but a run records the effort it STARTED with, and
  // a resume after the owner changed the setting must keep it.
  if (opts.effort === ULTRACODE_EFFORT) args.push("--effort", ULTRACODE_EFFORT);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.run) {
    // Exactly one MCP server — ours, in its browser-only profile. Strict, so
    // servers an owner configured for their own interactive claude-ds
    // sessions (~/.claude-ds) never leak into a delegated run.
    args.push("--strict-mcp-config");
    args.push("--mcp-config", buildRunMcpConfig(opts.run));
    // acceptEdits only covers the working folder; without this, the run's own
    // Write into its evidence folder is denied — the brief's promise broken
    // (measured on run-yuyqta4t: pomodoro-verification.md refused).
    args.push("--add-dir", artifactsDir(opts.run.id));
  }
  // The three tool flags are variadic and swallow any positional that follows,
  // which is why the task travels on stdin and these come last.
  args.push("--tools", opts.readOnly ? READ_ONLY_TOOLS : toolsFor(true, opts.effort));
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
    // The Workflow tool is listed AND pre-approved under ultracode: listed
    // alone it is refused headlessly (see WORKFLOW_TOOL).
    // A read-only run has no Bash to approve and no browser to drive: it
    // reads, and the helpers it delegates to read.
    // `Read(//tmp/**)`: a run may READ what it put in /tmp — the HTML it
    // curled out of its own server, a build log — without a permission
    // prompt it cannot answer in headless mode. Reads only, and only there:
    // the deny rules below still win for anything secret, and a write
    // outside the folder is still refused.
    args.push("--allowedTools", ...(opts.readOnly ? [] : ["Bash(*)"]), ...(opts.effort === ULTRACODE_EFFORT ? [WORKFLOW_TOOL] : []), ...(opts.run && !opts.readOnly ? runMcpTools(opts.run.media) : []), TMP_READ_RULE);
    // The file rules, and the one command list that is enforced: nothing a
    // run runs may kill the box's own server by name (BASH_KILL_DENYLIST).
    args.push("--disallowedTools", ...fileDenyRules(), ...(opts.readOnly ? [] : BASH_KILL_DENYLIST));
  }
  return args;
}

/** The environment a run gets — and nothing else. Exported for the contract test. */
export function buildRunEnv(opts: { effort?: CodingEffort; artifactsDir?: string } = {}): Record<string, string> {
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
  // The run's evidence folder — the brief tells the run to save proof of its
  // work here, and the browser MCP layer saves screenshots into it.
  if (opts.artifactsDir) env.CLAWBOX_RUN_ARTIFACTS_DIR = opts.artifactsDir;
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

/** SIGTERM now, SIGKILL after the grace period if the tree is still there. */
function endProcess(state: LiveRun): void {
  killTree(state.child, "SIGTERM");
  if (state.killTimer) clearTimeout(state.killTimer);
  state.killTimer = setTimeout(() => killTree(state.child, "SIGKILL"), STOP_GRACE_MS);
  state.killTimer.unref();
}

/**
 * Is anything still alive in this process group? Signal 0 delivers nothing and
 * only asks the question — EPERM would mean "there, but not ours", which on a
 * box where every run is the same user does not happen and is still not "gone".
 */
function groupAlive(pgid: number | null): boolean {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * End a settled run's process group by its recorded pgid — the escalation the
 * kill path uses when nothing the run left is wanted, and the same thing the
 * owner's Kill button asks for on a run that deliberately left a server.
 *
 * Answers whether anything was there to signal. Never throws: this runs on the
 * settle path, where a failure to clean up must not change what the record says
 * about the run.
 */
export function killRunGroup(pgid: number | null): boolean {
  if (!groupAlive(pgid)) return false;
  const group = pgid as number;
  try {
    process.kill(-group, "SIGTERM");
  } catch {
    return false;
  }
  const hard = setTimeout(() => {
    try {
      if (groupAlive(group)) process.kill(-group, "SIGKILL");
    } catch {
      // gone between the check and the signal — which is the outcome wanted
    }
  }, STOP_GRACE_MS);
  hard.unref();
  return true;
}

/**
 * Everything a settled run holds that is not its record: the browser tab it
 * opened, its timers, and whatever it left running.
 *
 * The process group is the one decision here that is not obvious. On a NATURAL
 * completion it is deliberately left alone: the orientation guide tells a run
 * to leave its server listening so the app it built can be reached from the
 * desktop, and a settle that killed the group would break exactly the pattern
 * the device documents. So a finished run RECORDS what survived and the run's
 * page offers to end it; only an outcome where nothing the run left is wanted —
 * stopped, failed, timed out — escalates to the kill.
 */
function cleanupRunResources(run: CodingRun, state: LiveRun | null): void {
  if (state) {
    clearInterval(state.timeout);
    if (state.killTimer) clearTimeout(state.killTimer);
  }
  // The run's own tab, never the owner's: browser sessions are tagged with the
  // run that opened them and a run always gets a new page (browser-sessions.ts).
  void closeSessionsForRun(run.id).catch(() => {});
  if (run.status === "completed" || run.status === "paused") {
    run.leftover = groupAlive(run.pgid);
    if (run.leftover) {
      pushProgress(run, "Something this run started is still running — a server it left listening? The run's page can end it.");
      return;
    }
    // The group is gone, and the number that named it is now the kernel's to
    // hand to anybody. Forget it here for the same reason reconcileAfterRestart
    // forgets it across a restart: a record that keeps a recycled pid would let
    // the Kill button signal a stranger's process group in this run's name.
    run.pgid = null;
    return;
  }
  run.leftover = false;
  if (killRunGroup(run.pgid)) {
    pushProgress(run, "Ended what the run had left running");
  }
  run.pgid = null;
}

/**
 * The owner's Kill button: end whatever a settled run left behind.
 *
 * Only a settled run — a live one is Stop's business, and stopping is what
 * that gesture already means. A PAUSED run is refused for the opposite reason:
 * it is still the owner's to resume, and what it left listening is likely the
 * very thing the resumed run carries on against. Idempotent: a group that is
 * already gone answers `killed: false` rather than an error, because "nothing
 * is running" is the state the caller wanted either way.
 */
export function killRunLeftovers(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (isLive(run.status)) {
    throw new CodingAgentError("invalid", "That run is still going. Stop it instead; stopping ends everything it started.");
  }
  if (isHeld(run.status)) {
    throw new CodingAgentError("invalid", "That run is paused, not finished. Resume it, or stop it first.");
  }
  if (killRunGroup(run.pgid)) pushProgress(run, "The owner ended what the run had left running");
  run.leftover = false;
  // Signalled or already gone, the group this record named is finished with.
  // Keeping the number would leave a Kill button aimed at whatever the kernel
  // gives that pid to next.
  run.pgid = null;
  persist(true);
  return cloneRun(run);
}

function pushProgress(run: CodingRun, line: string): void {
  const cleaned = line.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  run.progress.push(cleaned.length > MAX_PROGRESS_LINE_CHARS ? `${cleaned.slice(0, MAX_PROGRESS_LINE_CHARS - 1)}…` : cleaned);
  // When it happened, kept in step with the line: the timeline shows it on hover.
  run.progressAt.push(Date.now());
  if (run.progress.length > PROGRESS_KEEP) run.progress.splice(0, run.progress.length - PROGRESS_KEEP);
  if (run.progressAt.length > run.progress.length) run.progressAt.splice(0, run.progressAt.length - run.progress.length);
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

/** What a media route learns when it asks for one of the run's slots. */
export type MediaReservation =
  | { ok: true; used: number; cap: number }
  | { ok: false; reason: "no_run" | "cap"; used: number; cap: number };

/**
 * Take one of the LIVE run's slots for `kind`, or refuse because they are all
 * spent — or because there is no longer a run to spend them.
 *
 * The counter moves HERE, before the generator is called, and not once the
 * bytes come back. The routes spend the owner's ClawBox AI allowance and the
 * box's voice between the two moments — seconds of it, when a clip waits in
 * withSpeechQueue — so a cap read from a snapshot and incremented afterwards
 * let two overlapping calls both pass a gate that had room for one. This
 * function is synchronous from the read to the write, which is what makes
 * "both passed" impossible; releaseRunMedia hands the slot back when nothing
 * was produced with it.
 */
export function reserveRunMedia(runId: string, kind: keyof RunMedia): MediaReservation {
  const cap = kind === "images" ? MAX_IMAGES_PER_RUN : MAX_AUDIO_PER_RUN;
  const run = loadRuns().find((r) => r.id === runId);
  // A stale bearer must not spend a settled record's allowance, and a run that
  // ended between the route's first look and this one is the same case.
  if (!run || !isLive(run.status)) return { ok: false, reason: "no_run", used: 0, cap };
  const used = run.mediaGenerated[kind];
  if (used >= cap) return { ok: false, reason: "cap", used, cap };
  run.mediaGenerated[kind] = used + 1;
  persist(true);
  return { ok: true, used: used + 1, cap };
}

/**
 * Hand back a slot the caller took and did not spend.
 *
 * Deliberately NOT live-gated, unlike the reservation: this only returns what
 * reserveRunMedia took while the run was live, and a run that settled while
 * its generator was working must not be left recorded as having used a
 * picture nobody ever drew.
 */
export function releaseRunMedia(runId: string, kind: keyof RunMedia): void {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run || run.mediaGenerated[kind] <= 0) return;
  run.mediaGenerated[kind] -= 1;
  persist(true);
}

/**
 * Record the file a media route just wrote for the LIVE run.
 *
 * The routes write it themselves, so nothing in the stream ever mentions it:
 * without this the run's changed-files list would omit the very assets the
 * owner is about to look at. The COUNTER is not touched here — reserveRunMedia
 * moved it before anything was spent, which is the only point at which two
 * overlapping calls cannot both pass one cap. Silent for anything that is not
 * the live run: a write that lands after the run settled — the audio route can
 * wait seconds in withSpeechQueue — must not edit a finished record.
 */
export function noteRunMedia(runId: string, file: string | null): void {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run || !isLive(run.status)) return;
  // Evidence is listed with the run in its own right, and counting it as work
  // made a review pass that changed nothing report a changed file and arm a
  // review of no work — the same reason the stream parser skips it.
  if (file && !isEvidencePath(run, file)) noteFile(run, relativeToRun(run, file));
  persist(true);
}

/** What a media route needs to know before it spends anything. Null when no run is live. */
export function activeRunMedia(): { id: string; directory: string; media: RunMedia; generated: { images: number; audio: number } } | null {
  const run = activeRun();
  if (!run) return null;
  return { id: run.id, directory: run.directory, media: run.media, generated: { ...run.mediaGenerated } };
}

/**
 * A path in the run's own evidence folder. relativeToRun leaves it absolute,
 * because that folder is never inside a working folder — resolveWorkingDirectory
 * keeps every run out of data/ except the code projects.
 */
function isEvidencePath(run: CodingRun, file: string): boolean {
  return path.isAbsolute(file) && isInside(file, artifactsDir(run.id));
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

/**
 * Setup commands a retry may safely repeat.
 *
 * Seen on a real box: a run died to a transient proxy failure seconds after
 * `npm install three esbuild ws`, and the side-effect guard turned that one
 * upstream blink into a dead run. A package install converges — a fresh
 * attempt re-runs it into the same node_modules and lockfile — so its
 * leftovers cannot mislead a second attempt the way a half-finished edit
 * can. Deliberately narrow, and per manager: yarn, pnpm and bun run the
 * package.json SCRIPT of that name for a subcommand they do not recognise
 * (verified on this box: bun 1.4.0 executed `"scripts": {"ping": ...}` for
 * `bun ping`), so each manager is granted only its own builtins. `npm run`,
 * `npx`, `uninstall` and everything else stay side-effecting, because
 * convergence cannot be proven from those strings.
 */
export function isRetrySafeSetupCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed || /[;&|<>`\n\r]|\$\(/.test(trimmed)) return false;
  return /^npm\s+(?:install|ci|add|ping)(?:\s|$)/.test(trimmed)
    || /^bun\s+(?:install|ci|add)(?:\s|$)/.test(trimmed)
    || /^(?:pnpm|yarn)\s+(?:install|add)(?:\s|$)/.test(trimmed)
    || /^(?:node|npm|pnpm|yarn|bun)\s+(?:--version|-v)\s*$/.test(trimmed);
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  /** system/thinking_tokens: reasoning tokens so far. */
  estimated_tokens?: number;
  /** `user` events carry tool_result blocks; that is how a sub-agent reports back. */
  session_id?: string;
  /** Set on events a SUB-AGENT produced; the main loop's events carry none. */
  parent_tool_use_id?: string;
  /** system/task_started, task_progress, task_notification: the tool_use the
   *  background task answers, and (on the notification) what it spent. */
  tool_use_id?: string;
  task_type?: string;
  usage?: unknown;
  model?: string;
  /** `id` is the API message: the CLI emits one assistant event PER CONTENT
   *  BLOCK of it (thinking, then text or tool_use), each with the same usage. */
  message?: { id?: unknown; content?: unknown; usage?: unknown };
  /** system/task_started: what the helper was asked, in the CLI's words. */
  description?: unknown;
  result?: unknown;
  is_error?: boolean;
  num_turns?: number;
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

/**
 * The `todos` a TodoWrite tool_use carries, or null when the payload is not a
 * list at all — the caller then leaves the plan it has alone rather than
 * replacing a good plan with nothing. A list with a broken item in it keeps
 * the items that read; the tool's shape is Claude Code's to change, and the
 * card must never crash on a field the model spelled differently.
 */
function parseTodos(raw: unknown): CodingTodo[] | null {
  if (!Array.isArray(raw)) return null;
  const cut = (s: string) => {
    const cleaned = s.replace(/\s+/g, " ").trim();
    return cleaned.length > MAX_TODO_CHARS ? `${cleaned.slice(0, MAX_TODO_CHARS - 1)}…` : cleaned;
  };
  const todos: CodingTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof t.content !== "string") continue;
    const content = cut(t.content);
    if (!content) continue;
    // An unknown status is "not done": the safe reading of a word we do not know.
    const status = (TODO_STATUSES as readonly unknown[]).includes(t.status) ? t.status as CodingTodoStatus : "pending";
    const activeForm = typeof t.activeForm === "string" ? cut(t.activeForm) : "";
    todos.push(activeForm ? { content, status, activeForm } : { content, status });
    if (todos.length >= MAX_TODOS) break;
  }
  return todos;
}

/** Exported for the test, for the same reason. */
export const parseTodosForTests = parseTodos;

/**
 * Add to the run's bill and stop it at the owner's ceiling. The CLI has no
 * flag for a token limit, so the device enforces it from the usage the stream
 * reports. Marked resumable: the work is real, it simply ran out of room —
 * the same shape as a step ceiling.
 */
function noteTokens(run: CodingRun, state: LiveRun, tokens: number): boolean {
  if (!(tokens > 0)) return false;
  run.tokensUsed += tokens;
  if (run.tokenLimit !== null && run.tokensUsed >= run.tokenLimit && state.endRequested === null) {
    state.endRequested = "stop";
    run.resumable = true;
    run.error = `Stopped at the token limit (${run.tokensUsed.toLocaleString("en-US")} of ${run.tokenLimit.toLocaleString("en-US")}). Raise the limit or resume with a narrower task.`;
    pushProgress(run, "Token limit reached");
    console.error(`[coding-agent] ${run.id} hit its token limit at ${run.tokensUsed}`);
    endProcess(state);
    return true;
  }
  return false;
}

/**
 * A workflow's agents never appear on the stream; the CLI reports the
 * workflow's cumulative spend on every task_progress and once more on its
 * task_notification. Bill the delta each time, so the owner's ceiling holds
 * WHILE a fan-out runs rather than after it, and a workflow the run was
 * stopped under has still been billed for what it did.
 */
function billWorkflowProgress(run: CodingRun, state: LiveRun, id: string, usage: unknown): boolean {
  const helper = state.openSubagents.get(id);
  if (!helper || helper.type !== WORKFLOW_SUBAGENT_TYPE) return false;
  const total = usage && typeof usage === "object" ? (usage as { total_tokens?: unknown }).total_tokens : undefined;
  if (typeof total !== "number") return false;
  const billed = state.helperBilled.get(id) ?? 0;
  if (total <= billed) return false;
  state.helperBilled.set(id, total);
  return noteTokens(run, state, total - billed);
}

/** The text of a tool_result, whether the CLI sent a string or text blocks. */
function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
}

/**
 * The installed Claude Code (2.1.259, measured 2026-09-03) launches
 * sub-agents and workflows in the BACKGROUND: the
 * tool_result that answers the Agent or Workflow call is only the launch
 * receipt ("Async agent launched successfully…", "Workflow launched in
 * background…") and the helper is still out. Its `task_notification` is what
 * closes it. Measured on this box, 2026-09-03: read as a completion, the
 * receipt made every helper "finished" the moment it started, so the card
 * never showed one working.
 */
function isBackgroundLaunchReceipt(block: Record<string, unknown>): boolean {
  if (block.is_error === true) return false;
  return /^\s*(Async agent launched|Workflow launched in background)/.test(toolResultText(block));
}

/** The sub-agent's "kind" a Workflow call gets: one helper of type "workflow". */
const WORKFLOW_SUBAGENT_TYPE = "workflow";
/** Message ids remembered for billing — a few turns of interleaved helpers. */
const BILLED_IDS_KEPT = 64;

function openSubagent(run: CodingRun, state: LiveRun, id: unknown, kind: string, what: string): void {
  if (typeof id === "string" && id) {
    state.openSubagents.set(id, { type: kind, description: what.slice(0, 120), startedAt: Date.now() });
  }
  run.subagentsTotal += 1;
  run.subagentsByType[kind] = (run.subagentsByType[kind] ?? 0) + 1;
  run.subagentsActive = state.openSubagents.size;
  run.activeSubagents = [...state.openSubagents.values()];
}

/**
 * Closes the helper `id` names, if it is still out. Answers which it was.
 * A REFUSED launch (an is_error tool_result — the CLI's "Review dynamic
 * workflow before running", or a sub-agent type it does not know) is taken
 * back out of the counts: a helper that never ran is not one that finished.
 */
function closeSubagent(run: CodingRun, state: LiveRun, id: string, refused = false): ActiveSubagent | null {
  const done = state.openSubagents.get(id);
  if (!done || !state.openSubagents.delete(id)) return null;
  state.helperBilled.delete(id);
  run.subagentsActive = state.openSubagents.size;
  run.activeSubagents = [...state.openSubagents.values()];
  // The record of it: what it did and how long it took, for the run's page.
  run.subagents = [...run.subagents.slice(-(SUBAGENT_HISTORY_KEPT - 1)), { ...done, endedAt: Date.now(), refused }];
  const noun = done.type === WORKFLOW_SUBAGENT_TYPE ? "Workflow" : "Sub-agent";
  const kind = done.type === WORKFLOW_SUBAGENT_TYPE || done.type === "sub-agent" ? "" : ` (${done.type})`;
  if (refused) {
    run.subagentsTotal = Math.max(0, run.subagentsTotal - 1);
    const left = (run.subagentsByType[done.type] ?? 1) - 1;
    if (left > 0) run.subagentsByType[done.type] = left;
    else delete run.subagentsByType[done.type];
    pushProgress(run, `${noun} refused${kind}`);
  } else {
    pushProgress(run, `${noun} finished${kind}`);
  }
  return done;
}

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
    // A -p run with a helper out is started AGAIN by the CLI when that
    // helper reports: a second init, and a second result when the model had
    // ended its turn (measured on 2.1.259) — or no result yet when it had
    // not (run-roo5mgvd: the notification and the init landed mid-turn).
    // Same session, same process: any init after the first is a
    // continuation, not a fresh start.
    pushProgress(run, state.sawInit
      ? "Continuing after a background helper finished"
      : `Started${run.model ? ` with ${run.model}` : ""}`);
    state.sawInit = true;
    return;
  }

  // The CLI's own words for a helper it just launched — for a workflow, the
  // description the parser could only guess at from the script.
  if (event.type === "system" && event.subtype === "task_started") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    const helper = id ? state.openSubagents.get(id) : undefined;
    if (helper && typeof event.description === "string" && event.description.trim()) {
      helper.description = event.description.trim().slice(0, 120);
      run.activeSubagents = [...state.openSubagents.values()];
    }
    return;
  }

  if (event.type === "system" && event.subtype === "task_progress") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (id) billWorkflowProgress(run, state, id, event.usage);
    return;
  }

  // A background helper came back (see isBackgroundLaunchReceipt). A
  // sub-agent's own turns were on this stream and billed as they came; a
  // workflow's were not — its notification carries the final total.
  if (event.type === "system" && event.subtype === "task_notification") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (!id) return;
    billWorkflowProgress(run, state, id, event.usage);
    closeSubagent(run, state, id);
    return;
  }

  if (event.type === "assistant") {
    // Every request pays for the input it carries, so input is summed per turn
    // even though the conversation repeats — that is what a bill counts. Per
    // MESSAGE, not per event: see LiveRun.lastBilledMessageId.
    const usage = event.message?.usage;
    const messageId = typeof event.message?.id === "string" && event.message.id ? event.message.id : null;
    if (usage && typeof usage === "object" && (messageId === null || !state.billedMessageIds.has(messageId))) {
      if (messageId !== null) {
        state.billedMessageIds.add(messageId);
        if (state.billedMessageIds.size > BILLED_IDS_KEPT) {
          const oldest = state.billedMessageIds.values().next().value;
          if (oldest !== undefined) state.billedMessageIds.delete(oldest);
        }
      }
      const u = usage as Record<string, unknown>;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      state.outputBilledInSegment += n("output_tokens");
      const stoppedNow = noteTokens(run, state, n("input_tokens") + n("output_tokens")
        + n("cache_creation_input_tokens") + n("cache_read_input_tokens"));
      if (stoppedNow) return;
    }
    // A helper's own turns (parent_tool_use_id set) are billed above and
    // nothing more: its words are not the run's words, its Bash is not the
    // run's command, and a tester's `npm test` must not mark the run as one
    // with side effects. The card already names the helper that is out.
    if (typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id) return;
    // numTurns stays the CLI's own number from the final result event.
    // A live per-event count was tried and measured 291 events against the
    // CLI's 38 turns on run-5vt51ppv — no event arithmetic reproduces the
    // CLI's definition, and a number that snaps from 272 to 38 at the finish
    // is worse than none. Progress bars use the run's TodoWrite plan instead.
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
            if (!isReadOnlyInspectionCommand(input.command) && !isRetrySafeSetupCommand(input.command)) state.commandMayHaveSideEffects = true;
            pushProgress(run, `$ ${typeof input.command === "string" ? input.command : ""}`);
            break;
          case "Write":
          case "Edit":
          case "NotebookEdit": {
            const file = relativeToRun(run, input.file_path ?? input.notebook_path);
            // Asked for, not yet done — confirmed when its tool_result lands.
            state.sawWriteAttempt = true;
            // A write into the run's own evidence folder — report.md, a test
            // log, the brief asks for both — is not project work: the folder
            // is listed with the run already, and counting it here made a
            // review pass that changed nothing say "1 file changed" and armed
            // a review pass of no work. It still shows in the feed below.
            if (file && !isEvidencePath(run, file) && typeof block.id === "string" && block.id) {
              state.pendingFiles.set(block.id, file);
            }
            pushProgress(run, `${block.name} ${file ?? ""}`);
            break;
          }
          case "Task":
          case SUBAGENT_TOOL: {
            // A sub-agent is out. Its id is what tells us when it comes back.
            const what = typeof input.description === "string" ? input.description : "";
            const kind = typeof input.subagent_type === "string" ? input.subagent_type : "";
            openSubagent(run, state, block.id, kind || "sub-agent", what);
            pushProgress(run, `Sub-agent started${kind ? ` (${kind})` : ""}${what ? `: ${what}` : ""}`);
            break;
          }
          case WORKFLOW_TOOL: {
            // A dynamic workflow: ONE helper of type "workflow" on the
            // record, by choice — its agents are not on this stream (their
            // spend arrives as task_progress totals, the models they used in
            // the final modelUsage), and a fan-out is one decision of the
            // run's, not twelve. Named after its script's own meta until
            // task_started brings the CLI's own description.
            const script = typeof input.script === "string" ? input.script : "";
            const what = /description\s*:\s*(['"`])((?:(?!\1).)*)\1/.exec(script)?.[2] ?? "";
            openSubagent(run, state, block.id, WORKFLOW_SUBAGENT_TYPE, what);
            pushProgress(run, `Workflow started${what ? `: ${what}` : ""}`);
            break;
          }
          case "Read":
            pushProgress(run, `Read ${relativeToRun(run, input.file_path) ?? ""}`);
            break;
          case "Glob":
          case "Grep":
            pushProgress(run, `${block.name} ${typeof input.pattern === "string" ? input.pattern : ""}`);
            break;
          case "TodoWrite": {
            // The run's plan, whole: TodoWrite always sends the full list, so
            // the newest one replaces the record's. One summary line in the
            // feed — the list itself lives on the record, where the card
            // draws it as a checklist rather than as twenty progress lines.
            const todos = parseTodos(input.todos);
            if (!todos) {
              pushProgress(run, block.name);
              break;
            }
            run.todos = todos;
            const done = todos.filter((t) => t.status === "completed").length;
            pushProgress(run, `Plan: ${todos.length} tasks, ${done} done`);
            break;
          }
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
      // A launch receipt is not a result: the helper stays out until its
      // task_notification (see isBackgroundLaunchReceipt). Anything else
      // closes it — a synchronous answer as finished, a refusal as refused.
      if (state.openSubagents.has(block.tool_use_id) && !isBackgroundLaunchReceipt(block as Record<string, unknown>)) {
        closeSubagent(run, state, block.tool_use_id, block.is_error === true);
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
    // A result per CLI segment: the first for the model's own turn, one more
    // each time it was restarted by a background helper (see the init
    // handler). num_turns and permission_denials are PER SEGMENT — the
    // second result of the probe said 1 turn and no denials — so they add
    // up; modelUsage and the summary are cumulative, and the last one wins.
    const continuation = state.sawResult;
    state.sawResult = true;
    if (typeof event.num_turns === "number") run.numTurns = continuation ? run.numTurns + event.num_turns : event.num_turns;
    // The segment's output, less what its assistant events already billed.
    if (event.usage && typeof event.usage === "object") {
      const out = (event.usage as { output_tokens?: unknown }).output_tokens;
      if (typeof out === "number" && out > state.outputBilledInSegment) noteTokens(run, state, out - state.outputBilledInSegment);
    }
    state.outputBilledInSegment = 0;
    // Which models actually did work — the main run and every sub-agent.
    if (event.modelUsage && typeof event.modelUsage === "object") {
      const usage = event.modelUsage as Record<string, unknown>;
      run.modelsUsed = Object.keys(usage).sort();
      // The CLI's own bill for everything the process ran — main loop,
      // sub-agents AND workflow agents, cache reads included — cumulative
      // across segments. The live sum above under-counts a workflow (its
      // task_progress totals leave out cache reads: measured 118k reported
      // against 540k in the agents' transcripts on run-roo5mgvd), so the
      // record is raised to the CLI's number here, never lowered.
      const total = Object.values(usage).reduce<number>((sum, m) => {
        if (!m || typeof m !== "object") return sum;
        const u = m as Record<string, unknown>;
        const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
        return sum + n("inputTokens") + n("outputTokens") + n("cacheReadInputTokens") + n("cacheCreationInputTokens");
      }, 0);
      // A result with helpers still out is a SEGMENT: the process runs on
      // and another segment follows, so the ceiling stays armed through it.
      // The last result — nothing out — is reconciliation only: the run has
      // reported its outcome, and crossing the ceiling here must not turn a
      // finished run into a device stop (noteTokens would, and finishRun
      // would then discard the outcome and settle it as stopped, resumable).
      if (total > run.tokensUsed) {
        if (state.openSubagents.size > 0) noteTokens(run, state, total - run.tokensUsed);
        else run.tokensUsed = total;
      }
    }
    if (Array.isArray(event.permission_denials)) {
      const described = event.permission_denials.map(describeDenial);
      run.permissionDenials = (continuation ? run.permissionDenials : 0) + event.permission_denials.length;
      run.deniedActions = (continuation ? [...run.deniedActions, ...described] : described).slice(0, MAX_DENIALS_KEPT);
    }
    const text = typeof event.result === "string" ? event.result.trim() : "";
    if (text) run.summary = text.slice(0, MAX_SUMMARY_CHARS);
    switch (event.subtype) {
      case "success":
        state.outcome = {
          status: event.is_error ? "failed" : "completed",
          error: event.is_error && !run.error ? (text || "Claude Code reported an error.").slice(0, MAX_ERROR_CHARS) : null,
          resumable: false,
        };
        break;
      // The two ceilings are the ONLY failures a resume can help with: the
      // session did real work and simply ran out of room.
      case "error_max_turns":
        state.outcome = {
          status: "failed",
          resumable: true,
          error: `Stopped after ${run.numTurns || run.maxTurns} steps without finishing. Resume it with a narrower task, raise the step limit, or split the work.`,
        };
        break;
      case "error_max_budget_usd":
        state.outcome = {
          status: "failed",
          resumable: true,
          error: "Stopped at the cost ceiling for one run. Resume it with a narrower task, or split the work.",
        };
        break;
      default: {
        const errors = Array.isArray(event.errors) ? event.errors.filter((e) => typeof e === "string").join("; ") : "";
        state.outcome = {
          status: "failed",
          resumable: false,
          error: (errors || text || "Claude Code stopped with an error.").slice(0, MAX_ERROR_CHARS),
        };
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
// unrecognized_model is in the transient set on evidence, not on its name:
// run-ssodhkys died to it minutes after run-5vt51ppv finished a whole build on
// the SAME model string via the same proxy — an entitlement flap upstream,
// the very shape this retry exists for.
const TRANSIENT_FAILURE_RE =
  /failed to authenticate|attention required|cloudflare|502 bad gateway|503|504|gateway time-?out|econnreset|etimedout|enotfound|socket hang up|fetch failed|unrecognized_model/i;

export function isTransientFailure(error: string | null): boolean {
  return typeof error === "string" && TRANSIENT_FAILURE_RE.test(error);
}

/**
 * Commit what the run changed, in its own folder.
 *
 * Never throws: a run that did its work is finished whether or not the
 * history was recorded, and the owner is told either way. Resolves once the
 * attempt is over, so what must follow the commit can wait for it.
 */
async function recordRunWork(run: CodingRun): Promise<void> {
  if (run.filesTouched.length === 0) return;
  try {
    const outcome = await commitRunWork({
      directory: run.directory,
      runId: run.id,
      task: run.task,
      summary: run.summary,
    });
    if (outcome.committed) {
      run.commit = outcome.sha;
      run.commitError = null;
      pushProgress(run, `Committed as ${outcome.sha}${outcome.initialized ? " (new repository)" : ""}`);
      console.error(`[coding-agent] ${run.id} committed ${outcome.sha}`);
    } else if (outcome.reason !== "no_changes") {
      // On the record, not only in the log: a team reads it before it
      // merges, since a worker whose commit failed has no branch to merge.
      run.commitError = (outcome.detail ?? outcome.reason).slice(0, MAX_ERROR_CHARS);
      pushProgress(run, `Not committed: ${outcome.detail ?? outcome.reason}`);
      console.error(`[coding-agent] ${run.id} not committed: ${outcome.reason}`);
    } else {
      run.commitError = null;
    }
    persist(true);
  } catch (err) {
    run.commitError = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
    persist(true);
    console.error("[coding-agent] commit failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * What follows a settled run, in this order: its work is committed, and only
 * then the review pass — it reads the delivered work as a diff, and starting
 * it before the commit landed would show it the PREVIOUS run's commit as
 * "what you just did".
 *
 * Never after the owner's own Stop or Pause. A run the owner asked to stop
 * can still settle "completed" — the final result event is applied ahead of
 * the stop so a stop that raced the finish keeps the work (see
 * LiveRun.outcome) — but the gesture still means "no more of this", and an
 * automatic follow-up seconds after they pressed Stop would be the box
 * overruling them.
 */
/**
 * Draw the project's icon and its favicons, while the run works.
 *
 * Fired at the START of a run rather than at its end, so the files are usually
 * on disk within fifteen seconds and the run can LINK to them — a favicon that
 * only appeared once the run had written every page would be a file nothing
 * references. Never for a review pass: it resumes in a folder that already had
 * its turn, and the icon is one per project, not one per run.
 *
 * Fire-and-forget on purpose: `ensureProjectIcon` never rejects, the box-wide
 * generation slot serialises a queue of creates, and a project without a
 * picture is cosmetic where a run that waited on one is not.
 */
async function drawProjectIcon(run: CodingRun): Promise<{ icon: string; favicon: boolean }> {
  const folder = run.projectId ?? path.basename(run.directory);
  const name = (await projectNameOf(run.directory, folder)) ?? folder;
  return ensureProjectIcon({
    id: folder,
    directory: run.directory,
    name,
    description: firstLineOf(run.task),
  });
}

/** The start-of-run hook: only when the owner left pictures on, never for a review, and never for a team's worker or reviewer — their folder is a worktree named after a task, not a project. */
function startProjectIcon(run: CodingRun): void {
  if (!run.media.images || run.reviewOf || (run.team && run.team.role !== "planner")) return;
  void drawProjectIcon(run).catch(() => {
    // ensureProjectIcon already logged; a missing icon never reaches the run.
  });
}

/** After the commit and the wake: the project's assets, the review pass, the pull request. */
async function reviewAndShip(run: CodingRun, ended: "stop" | "pause" | null): Promise<void> {
  await commitProjectAssets(run);
  const review = ended !== null ? "skipped" : await maybeStartReviewPass(run);
  // After the review pass is decided, not before: when one is starting, the
  // pull request waits for it, because the review's own commits belong in it.
  // Reached after the owner's Stop too — not to open anything then, but so the
  // pull request that was being prepared is settled rather than left pending.
  await maybeOpenPullRequest(run, ended, review);
}

/**
 * The last chance to give a project its icon, and the commit that ships it.
 *
 * A run that started before the picture could be drawn — an unlinked box that
 * was linked mid-run, a generation that lost the slot to a queue of creates —
 * would otherwise have written every page and left the favicon it links to
 * missing. So the same call is made once more at settle, and anything it wrote
 * is committed in its own right: `recordRunWork` has already run, so a favicon
 * that landed after it would sit uncommitted in the folder and the review pass
 * and the pull request would both go out without it.
 *
 * Never throws, like everything else on the settle path, and never waits on the
 * picture for longer than the picture is worth: the upstream call has a
 * two-minute budget of its own, and a slow image endpoint must not be able to
 * hold a finished run's review pass and pull request behind it. When the budget
 * runs out the generation is left running — it still lands the icon, just in a
 * later commit or none — and the run settles.
 */
async function commitProjectAssets(run: CodingRun): Promise<void> {
  if (!run.media.images || run.reviewOf) return;
  try {
    const drawn = await Promise.race([
      drawProjectIcon(run),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SETTLE_ICON_BUDGET_MS).unref?.()),
    ]);
    if (!drawn?.favicon) return;
    const outcome = await commitRunWork({
      directory: run.directory,
      runId: run.id,
      task: "Add the project's generated icon and favicon",
      summary: null,
    });
    if (outcome.committed) {
      run.commit = outcome.sha;
      pushProgress(run, `Added the generated favicon, committed as ${outcome.sha}`);
      persist(true);
    }
  } catch (err) {
    console.error("[coding-agent] project assets:", err instanceof Error ? err.message : err);
  }
}

/**
 * Open the pull request for a finished chain of runs, and start watching its
 * checks — or settle the pull request as never opened, when the chain did not
 * finish. Every way a chain can end through finishRun comes through here, and
 * the ways that do not (a spawn that failed, Stop on a paused run, a restart)
 * settle the phase themselves: a pull request left "opening" is pending for
 * good, which keeps its run out of the history sweeps and the desktop polling
 * for a change that is never coming.
 *
 * "Chain", not "run": with the review pass on, the LAST run to settle is the
 * review, and the branch and the work belong to the run it reviewed. So the
 * pull request is always attributed to the origin run, and this defers while a
 * review pass is running.
 */
async function maybeOpenPullRequest(finished: CodingRun, ended: "stop" | "pause" | null, review: ReviewPassOutcome): Promise<void> {
  try {
    // A review pass is running for this run — wait for it, and let the
    // review's own settle bring us back here. Only when one actually STARTED:
    // maybeStartReviewPass swallows its refusals (the switch off, the slot
    // taken, the harness gone), and deferring on the conditions alone left the
    // pull request waiting for a review that was never going to happen.
    if (review === "started") return;

    const origin = finished.reviewOf === null ? finished : loadRuns().find((r) => r.id === finished.reviewOf);
    if (!origin?.pr || origin.pr.phase !== "opening") return;
    const branch = origin.pr.branch ?? runBranchName(origin.id);

    // A pause is not the end of the chain: the run resumes IN PLACE — the
    // same record, the same branch — and its settle comes back here, so the
    // pull request stays "opening" through it. Settling it here closed the
    // pull request for good on the first pause, and the resumed run's
    // completion then found nothing left to open. A paused run is held, not
    // history (see isHeld), so this is not the pending-forever the sweeps
    // suffer from; the one way a paused run ends without coming back here —
    // Stop on it — settles the pull request in stopRun.
    if (finished.status === "paused") return;
    // The owner's Stop means no more of this — pushing their code to GitHub
    // seconds after they pressed it would be the box overruling them. A run
    // that completed under the gesture (the result raced the kill) is kept
    // "completed", but still not pushed.
    if (ended !== null) {
      settlePr(origin, "failed", `${ended === "pause" ? "Paused" : "Stopped"} before a pull request was opened. The work stays on ${branch}.`);
      return;
    }
    if (origin.status !== "completed") {
      settlePr(origin, "failed", `The run did not finish (${origin.status}), so no pull request was opened. The work stays on ${branch}.`);
      return;
    }
    if (!(await getAutoPr())) {
      settlePr(origin, "failed", `Pull requests were switched off while the run worked, so none was opened. The work stays on ${branch}.`);
      return;
    }
    if (!origin.pr.branch || !origin.pr.base) {
      settlePr(origin, "failed", "The run's branch was not recorded, so no pull request was opened.");
      return;
    }

    // Nothing was committed anywhere in the chain: there is no diff to review
    // and nothing to merge.
    if (!origin.commit && !finished.commit) {
      settlePr(origin, "blocked", "Nothing was committed, so there is no pull request to open.");
      return;
    }

    const opened = await openPullRequest({
      directory: origin.directory,
      branch: origin.pr.branch,
      base: origin.pr.base,
      title: firstLineOf(origin.task),
      body: prBody(origin, finished),
    });
    if (!opened.ok) {
      settlePr(origin, "failed", opened.detail);
      return;
    }

    // The review's verdict gates the merge as well as the checks: they answer
    // different questions, and a green suite over a review that failed is not
    // consent to merge. A review that was due and could not start is no
    // verdict either. Written on the record — see PrState.reviewOk.
    const reviewOk = finished.reviewOf !== null ? finished.status === "completed" : review !== "refused";
    origin.pr = {
      ...origin.pr,
      phase: "waiting",
      number: opened.number,
      url: opened.url,
      startedAt: Date.now(),
      reviewOk,
    };
    pushProgress(origin, `Opened pull request #${opened.number} into ${origin.pr.base}`);
    persist(true);
    console.error(`[coding-agent] ${origin.id} opened PR #${opened.number}`);

    watchPullRequest(origin.id);
  } catch (err) {
    console.error(`[coding-agent] pull request for ${finished.id} not opened:`, err instanceof Error ? err.message : err);
  }
}

/** First line of the task, trimmed to something a PR title can hold. */
function firstLineOf(task: string): string {
  const line = task.split("\n")[0].trim();
  return line.length > 72 ? `${line.slice(0, 69)}...` : line || "ClawBox coding agent";
}

function prBody(origin: CodingRun, last: CodingRun): string {
  const lines = [
    "Opened by the ClawBox coding agent.",
    "",
    `**Task**`,
    origin.task,
    "",
    `Run \`${origin.id}\`${origin.commit ? ` · commit \`${origin.commit}\`` : ""}`,
  ];
  if (last.reviewOf) lines.push(`Reviewed by run \`${last.id}\` (automatic review pass).`);
  if (origin.summary) lines.push("", "**Summary**", origin.summary);
  return lines.join("\n");
}

/** Record a terminal PR phase on the run and persist it. */
function settlePr(run: CodingRun, phase: "merged" | "blocked" | "failed", detail: string | null): void {
  if (!run.pr) return;
  run.pr = { ...run.pr, phase, detail, endedAt: Date.now() };
  pushProgress(run, phase === "merged" ? "Merged into the base branch" : `Not merged: ${detail ?? phase}`);
  persist(true);
}

/** Runs whose checks are being polled right now, so a restart or a second
 *  settle cannot start two watchers for one pull request. */
const prWatchers = new Set<string>();

/**
 * Poll a pull request's checks until they decide something.
 *
 * A timer in the web server, which CLAUDE.md calls the one long-lived ClawBox
 * process — so it is unref()'d (it must never hold the process open), capped by
 * PR_MAX_WAIT_MS (through decideMerge when the pull request can be read, and
 * here when it cannot), and single-instance per run. Everything it decides on
 * is read from the record each tick, the review verdict included, so a watcher
 * rebuilt after a restart decides exactly as the first one did.
 */
function watchPullRequest(runId: string): void {
  if (prWatchers.has(runId)) return;
  prWatchers.add(runId);

  const tick = async (): Promise<void> => {
    const run = loadRuns().find((r) => r.id === runId);
    if (!run?.pr || run.pr.phase !== "waiting") {
      prWatchers.delete(runId);
      return;
    }
    if (run.pr.number === null) {
      // A waiting pull request whose number is gone (a hand-edited or damaged
      // record) can never be read; settled, not left pending for good.
      settlePr(run, "failed", "The pull request's number was lost, so its checks cannot be read.");
      prWatchers.delete(runId);
      return;
    }
    // Captured before the record is reassigned below — the assignment is what
    // loses the null-narrowing TypeScript did on the guard above.
    const prNumber = run.pr.number;
    const snapshot = await readPullRequest(run.directory, prNumber);
    if ("error" in snapshot) {
      // A transient read says nothing, so the wait goes on — but under the
      // same ceiling a check that never completes gets. decideMerge, which
      // holds that ceiling, is never reached from here, and without this one
      // a `gh` that kept failing (a sign-in that expired, a box offline for
      // the evening) left the pull request "waiting" for good: pending in the
      // history, and polled again after every restart by the boot sweep.
      if (Date.now() - run.pr.startedAt >= PR_MAX_WAIT_MS) {
        settlePr(run, "blocked", `Gave up waiting: the pull request could not be read from GitHub. It may still be open. ${snapshot.error}`);
        prWatchers.delete(runId);
        return;
      }
      schedule();
      return;
    }
    run.pr = { ...run.pr, checks: snapshot.checks };
    persist(true);

    const verdict = decideMerge({ snapshot, waitedMs: Date.now() - run.pr.startedAt, reviewOk: run.pr.reviewOk });
    if (verdict.action === "wait") { schedule(); return; }
    if (verdict.action === "block") {
      settlePr(run, "blocked", verdict.detail);
      prWatchers.delete(runId);
      return;
    }
    const merged = await mergePullRequest(run.directory, prNumber);
    settlePr(run, merged.ok ? "merged" : "blocked", merged.ok ? null : merged.detail);
    prWatchers.delete(runId);
  };

  const schedule = () => {
    const timer = setTimeout(() => { void tick(); }, POLL_INTERVAL_MS);
    // Never hold the process open for a pull request.
    timer.unref?.();
  };

  schedule();
}

/**
 * Pick up pull requests left pending by a restart.
 *
 * Same reason the email approval poller is restarted at boot: a box that
 * reboots mid-wait would otherwise leave the run showing "waiting for checks"
 * forever, with nothing polling. One left "opening" on a run the restart
 * ended has no future at all — the settle that would have opened it died
 * with the previous server, and reconcileAfterRestart has already marked the
 * run that was still working failed — so it is settled here the way that run
 * was, with the branch named for the owner to push themselves. A paused
 * run's is left alone: the run is kept, and its resume opens it.
 */
export function resumePullRequestWatches(): void {
  for (const run of loadRuns()) {
    if (!isPrPending(run.pr) || !run.pr) continue;
    if (run.pr.phase === "waiting") {
      watchPullRequest(run.id);
    } else if (!isHeld(run.status)) {
      // Held, not live: a paused run survives the restart with its record
      // (see the restart reconciliation) and resumes in place, so its
      // "opening" pull request is still coming — settling it here meant the
      // resumed run completed with nothing left to open.
      settlePr(run, "failed", `The ClawBox web server restarted before the pull request was opened. The work stays on ${run.pr.branch ?? runBranchName(run.id)}.`);
    }
  }
}

/**
 * What the automatic review pass is asked to do. Fixed text, not the owner's:
 * the task is the same every time, and what varies — the work — is already in
 * the resumed session and the folder.
 */
const REVIEW_PASS_TASK =
  "Automatic review pass. Adversarially review the work you just delivered in this folder: read the diff of your"
  + " last commit (git show HEAD; if there is no commit, review the working tree), and hunt for real defects —"
  + " logic errors, broken edge cases, unsafe handling, anything your verification did not actually prove."
  + " For each defect you CONFIRM: fix it, re-run the relevant verification, and note it in your report."
  + " Do not restyle or refactor working code, and do not invent work: if nothing real is found, say so in one"
  + " line and finish. Update report.md in your evidence folder with what you checked, found, and fixed.";

/**
 * What became of the review pass after a run settled: a review run is now
 * working ("started"), none was due ("skipped"), or one was due and could not
 * start ("refused"). The pull request step needs the difference — it waits
 * only for a review that exists, and treats one that could not run as no
 * verdict rather than a pass.
 */
type ReviewPassOutcome = "started" | "skipped" | "refused";

/**
 * One automatic follow-up run when the owner has switched the review pass on.
 *
 * The guards make it a pass and never a loop: only after a run that COMPLETED
 * and touched files, and never after a run that is itself a review pass
 * (reviewOf set). startRun re-checks the owner's switch, readiness and the
 * one-run-at-a-time slot, so this can refuse for the same reasons any start
 * can — and a refusal is a logged line, never an error the settled run feels.
 */
async function maybeStartReviewPass(finished: CodingRun): Promise<ReviewPassOutcome> {
  if (finished.status !== "completed") return "skipped";
  if (finished.reviewOf !== null) return "skipped";
  if (finished.readOnly) return "skipped";
  // A team's worker is reviewed by the team's own reviewer, on the merged work.
  if (finished.team) return "skipped";
  if (finished.filesTouched.length === 0) return "skipped";
  try {
    if (!(await getReviewPass())) return "skipped";
  } catch {
    return "skipped";
  }
  try {
    const review = await startRun({
      task: REVIEW_PASS_TASK,
      resumeRunId: finished.id,
      source: finished.source,
      reviewOf: finished.id,
    });
    console.error(`[coding-agent] ${review.id} started as the automatic review pass of ${finished.id}`);
    return "started";
  } catch (err) {
    console.error(`[coding-agent] review pass of ${finished.id} not started:`, err instanceof Error ? err.message : err);
    return "refused";
  }
}

/**
 * What the CLI prints when `--effort ultracode` cannot be honoured — the two
 * messages the installed binary carries for it (dynamic workflows disabled;
 * xhigh restricted by the organisation).
 */
const ULTRACODE_REFUSED = /Ultracode needs dynamic workflows|Ultracode runs at xhigh effort, which is restricted/i;

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
    // The device's own stop — the token limit — has already written why on
    // the record. A result event that slipped out before the kill landed
    // must not turn that into "completed" with a "Stopped at the token
    // limit" error beside it: both at once, and the resume the error offers
    // hidden behind a status that says the work is done.
    const deviceStopped = state.endRequested === "stop" && run.error !== null;
    if (state.outcome && !deviceStopped) {
      // The result event's verdict, now that the process is actually gone.
      // Ahead of the stop branch so a stop that raced the final message
      // keeps "completed", as it always has — the OWNER's stop records no
      // error, so it is the one this reaches.
      run.status = state.outcome.status;
      if (state.outcome.resumable) run.resumable = true;
      if (state.outcome.error && !run.error) run.error = state.outcome.error;
    } else if (state.endRequested === "pause") {
      // Paused, not stopped: the session is intact and Resume respawns into
      // it. completedAt freezes the elapsed clock; resume clears it.
      run.status = "paused";
      run.resumable = true;
      run.error = null;
    } else if (state.endRequested === "stop") {
      run.status = "stopped";
      run.error = run.error ?? "Stopped before it finished.";
    } else if (state.timedOut) {
      run.status = "failed";
      run.error = `Stopped after ${Math.round(RUN_IDLE_TIMEOUT_MS / 60_000)} minutes with no sign of life. The run was not making progress.`;
    } else {
      run.status = "failed";
      const tail = stderrTail(state.stderr);
      run.error = ULTRACODE_REFUSED.test(state.stderr)
        // The CLI refuses the flag before the first turn when dynamic
        // workflows are off for this install or the plan does not allow
        // xhigh. Name the way out rather than echo its /config advice, which
        // the owner cannot follow from the app.
        ? `Claude Code refused ultracode on this box (${tail}). Pick Max effort in the Coding Agent settings and start the run again.`
        : tail || `Claude Code exited with code ${exitCode ?? "unknown"} before reporting a result.`;
    }
  }
  // A stop that raced the final message keeps "completed": the work is done.
  run.exitCode = exitCode;
  run.completedAt = Date.now();
  // Timers, the run's browser tab, and the verdict on what it left running.
  // Before the retry branch below, which respawns into a fresh state and a
  // fresh process group: a retry that inherited the first attempt's timers
  // would be judged idle on the first attempt's clock.
  cleanupRunResources(run, state);
  live.delete(run.id);

  // One automatic restart when the upstream blinked and the run got nowhere.
  //
  // The guards are what make this safe rather than a loop: once only, only a
  // transient shape, only a run the owner did not stop, and only one that
  // changed NOTHING — no files and no command that may have side effects. A
  // read-only inspection such as `ls -la` is safe and must not suppress the
  // recovery, and neither is a convergent setup step such as `npm install`:
  // a fresh attempt re-creates its leftovers rather than tripping over them.
  // A run that may have edited something must never be silently repeated,
  // because the second attempt starts from the first one's leftovers.
  //
  // A FRESH session, never a resume: Claude Code persists the failure in the
  // session and replays it, which is how one bad run became two identical
  // ones on this box. See CodingRun.resumable.
  if (
    run.status === "failed"
    && run.retries === 0
    && state.endRequested === null
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
      // The first attempt's closing words too: a 503 arrives as a result event
      // and lands in the summary, and the report is filed from the summary
      // once the run settles. Left in place, a second attempt that dies
      // without a result would file the first one's error as its report.
      run.summary = null;
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

  // The closing message becomes report.md beside the run's screenshots — for
  // a run that did not finish too, when it said anything, because a partial
  // account is what the owner reads before deciding whether to resume. After
  // the retry decision above, so a restarted run never files its first
  // attempt's words; never throwing, so the record settles regardless.
  if (run.summary) writeRunReport(run.id, run.summary);

  // The COMMIT before anyone is told. Waiters — the team orchestrator above
  // all — act on "finished" at once: a worker's worktree was merged and
  // removed the moment its run settled, while the commit was still on its
  // way, so the branch stayed at the scaffold and the reviewer rejected work
  // that had been done (team-8l9oudxd, t1 and t2, 2026-09-05). So the
  // record is committed first; "Finished" is said and the waiters woken only
  // once the work is recoverable; the assets, the review pass and the pull
  // request follow on their own, as before.
  const settled = run.status;
  void (async () => {
    await recordRunWork(run);
    pushProgress(run, settled === "paused" ? "Paused — resume to continue" : `Finished: ${settled}`);
    persist(true);
    wakeWaiters(run.id);
    console.error(`[coding-agent] ${run.id} ${settled} after ${Math.round(((run.completedAt ?? Date.now()) - run.startedAt) / 1000)}s (${run.numTurns} turns)`);
    // A team's worker or reviewer ends here: its worktree is the
    // orchestrator's to merge and remove the moment it is woken, its
    // review is the team's own reviewer's, and it never opens a pull
    // request — the assets, review pass and PR below would run in a folder
    // that is gone. The planner works in the project itself and keeps them.
    if (run.team && run.team.role !== "planner") return;
    await reviewAndShip(run, state.endRequested);
  })();
  // A pause is the owner's own gesture — no finish notice for it.
  if (run.status !== "paused") void announceCodingAgent(cloneRun(run)).catch((err: unknown) => {
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
  stdinText?: string,
): void {
  const { bin, argv } = buildSpawnArgv(setprivPath, buildRunArgs({ resumeSessionId, maxTurns: settings.maxTurns, effort: settings.effort, readOnly: run.readOnly, extraBrief: run.extraBrief, run: { id: run.id, directory: run.directory, media: run.media } }));
  // One evidence path everywhere — env, MCP config and --add-dir must never
  // disagree about where it is. Creation is best-effort: the MCP layer also
  // mkdirs lazily, so a failure here degrades evidence, never the run.
  const evidenceDir = artifactsDir(run.id);
  try {
    ensureArtifactsDir(run.id);
  } catch (err) {
    console.error(`[coding-agent] ${run.id}: no artifacts folder:`, err instanceof Error ? err.message : err);
  }
  const child = spawn(bin, argv, {
    cwd: run.directory,
    // Deliberately NOT process.env: see the header. The cast is only because
    // this repo's ProcessEnv augmentation insists on NODE_ENV, which a run has
    // no use for.
    env: buildRunEnv({ effort: settings.effort, artifactsDir: evidenceDir }) as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state: LiveRun = {
    child,
    openSubagents: new Map<string, ActiveSubagent>(),
    billedMessageIds: new Set<string>(),
    outputBilledInSegment: 0,
    helperBilled: new Map<string, number>(),
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
      endProcess(state);
    }, IDLE_CHECK_MS),
    killTimer: null,
    endRequested: null,
    timedOut: false,
    sawResult: false,
    sawInit: false,
    outcome: null,
    stderr: "",
  };
  state.timeout.unref();
  live.set(run.id, state);
  // `detached: true` makes the child its own process-group leader, so its pid
  // IS the group. Recorded now rather than derived at settle: by then the
  // child object is the only thing that still knows it, and a leftover server
  // has to be reachable after `live` has forgotten the run.
  run.pgid = typeof child.pid === "number" ? child.pid : null;
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
    // A resumed conversation remembers the PREVIOUS run's evidence folder and
    // was seen writing there (run-qqj1io65: screenshots filed under the old
    // run, Write into its own folder refused). The env and --add-dir already
    // name the new folder; the session's memory needs telling too.
    child.stdin?.end(stdinText ?? (resumeSessionId
      ? `${run.task}\n\n[ClawBox harness: this continuation is a NEW run. Its evidence folder is ${artifactsDir(run.id)} — save screenshots and report.md there, not in any previous run's folder.]`
      : run.task));
  } catch {
    // reported through the exit path
  }
}

// ─── Public operations ───────────────────────────────────────────────────────

export async function startRun(input: StartRunInput): Promise<CodingRun> {
  const task = normalizeTask(input.task);
  await assertCanSpawn(input.team ?? null);
  const setprivPath = await requireSetpriv();

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
    // A COMPLETED session is also safe to continue — it is not poisoned, it
    // simply finished — and continuing it is what carries the built-up context
    // into a follow-up ("fix these review findings", the automatic review
    // pass). A stopped run, or a failure that is not a ceiling, starts fresh.
    resumeSessionId = previous.resumable || previous.status === "completed" ? previous.sessionId : null;
  } else {
    ({ directory, projectId } = await resolveWorkingDirectory(input));
  }

  // Read once, here: a run keeps the settings it started with even if the
  // owner changes them while it works.
  const settings = await readRunSettings();
  const run = newRunRecord({
    task,
    directory,
    projectId,
    source: input.source,
    status: "running",
    settings,
    reviewOf: typeof input.reviewOf === "string" ? input.reviewOf : null,
    team: input.team ?? null,
    readOnly: input.readOnly === true,
    extraBrief: typeof input.extraBrief === "string" && input.extraBrief.trim() ? input.extraBrief.trim() : null,
  });
  if (run.reviewOf) pushProgress(run, `Automatic review pass of ${run.reviewOf}`);
  else if (resumeSessionId) pushProgress(run, "Resuming the previous session");
  else if (resumeRunId) pushProgress(run, `Starting fresh: ${resumeRunId} did not fail in a way a resume can fix`);

  // The run's own branch, made BEFORE any work happens.
  //
  // This is the only simple moment for it: commitRunWork commits to whatever
  // branch is checked out, so branching first puts the commits where a pull
  // request needs them and no history has to be rewritten afterwards. A review
  // pass is deliberately excluded — it resumes in the same folder and belongs
  // on the same branch, which it is already on.
  // A team's run is excluded too: a worker already sits on its own branch
  // in its own worktree (coding-team-worktree.ts), and a second branch
  // under it would take the commits away from the merge the team makes.
  if (!run.reviewOf && !run.readOnly && !run.team && (await getAutoPr())) {
    const branched = await startRunBranch({
      directory: run.directory,
      runId: run.id,
      // DATA_DIR is <clawbox>/data, so its parent is the checkout a run must
      // never branch — see startRunBranch.
      protectedRoot: path.dirname(DATA_DIR),
    });
    if (branched.ok) {
      run.pr = {
        phase: "opening",
        number: null,
        url: null,
        branch: branched.branch,
        base: branched.base,
        checks: emptyChecks(),
        detail: null,
        startedAt: Date.now(),
        endedAt: null,
        // No verdict yet; the one that counts is written when the pull
        // request opens, which is the only way into "waiting".
        reviewOk: true,
      };
      pushProgress(run, `Working on ${branched.branch}, for a pull request into ${branched.base}`);
    } else {
      // Not fatal: the work is worth doing on whatever branch this is. The
      // owner is told why there will be no pull request.
      run.pr = {
        phase: "failed",
        number: null,
        url: null,
        branch: null,
        base: null,
        checks: emptyChecks(),
        detail: branched.detail,
        startedAt: Date.now(),
        endedAt: Date.now(),
        reviewOk: false,
      };
      pushProgress(run, `No pull request: ${branched.detail}`);
    }
  }

  insertRun(loadRuns(), run);
  persist(true);
  console.error(`[coding-agent] ${run.id} started by ${run.source} in ${run.directory}`);
  startProjectIcon(run);
  spawnOrSettle(run, resumeSessionId, setprivPath, settings);
  return cloneRun(run);
}

/** The settings a run is spawned with, and the ceiling the device enforces itself. */
interface RunSettings {
  effort: CodingEffort;
  maxTurns: number;
  tokenLimit: number | null;
  generateImages: boolean;
  generateAudio: boolean;
}

async function readRunSettings(): Promise<RunSettings> {
  const [effort, maxTurns, tokenLimit, generateImages, generateAudio] = await Promise.all([
    getEffort(), getMaxTurns(), getTokenLimit(), getGenerateImages(), getGenerateAudio(),
  ]);
  return { effort, maxTurns, tokenLimit, generateImages, generateAudio };
}

/** A fresh run record: every counter at zero, nothing seen yet. */
function newRunRecord(fields: {
  task: string;
  directory: string;
  projectId: string | null;
  source: CodingRunSource;
  status: "running" | "draft";
  settings: RunSettings;
  reviewOf?: string | null;
  team?: RunTeam | null;
  readOnly?: boolean;
  extraBrief?: string | null;
}): CodingRun {
  const now = Date.now();
  return {
    id: newRunId(),
    task: fields.task,
    directory: fields.directory,
    projectId: fields.projectId,
    source: fields.source === "owner" ? "owner" : "agent",
    status: fields.status,
    startedAt: now,
    completedAt: null,
    sessionId: null,
    model: null,
    summary: null,
    error: null,
    numTurns: 0,
    filesTouched: [],
    commandsRun: 0,
    permissionDenials: 0,
    deniedActions: [],
    effort: fields.settings.effort,
    subagentsActive: 0,
    activeSubagents: [],
    subagents: [],
    subagentsTotal: 0,
    subagentsByType: {},
    modelsUsed: [],
    commit: null,
    maxTurns: fields.settings.maxTurns,
    tokensUsed: 0,
    tokenLimit: fields.settings.tokenLimit,
    thinkingTokens: 0,
    lastActivityAt: now,
    retries: 0,
    resumable: false,
    reviewOf: fields.reviewOf ?? null,
    team: fields.team ?? null,
    readOnly: fields.readOnly === true,
    extraBrief: fields.extraBrief ?? null,
    // No pull request until the aftermath opens one.
    pr: null,
    progress: [],
    progressAt: [],
    todos: [],
    exitCode: null,
    media: { images: fields.settings.generateImages, audio: fields.settings.generateAudio },
    mediaGenerated: { images: 0, audio: 0 },
    pgid: null,
    leftover: false,
    commitError: null,
  };
}

/**
 * Put a new record at the head of the list, newest first, and make room.
 * Never drops a held run (live, paused, drafted); trims the oldest finished
 * ones. A dropped record takes its evidence folder with it — unreachable
 * artifacts would sit on the flash forever.
 */
function insertRun(list: CodingRun[], run: CodingRun): void {
  list.unshift(run);
  while (list.length > MAX_RUNS_KEPT) {
    const idx = findLastFinished(list);
    if (idx < 0) break;
    removeArtifacts(list[idx].id);
    list.splice(idx, 1);
  }
}

/** The oldest run that is history — see isHeld for what is not, and
 *  isPrPending for the run that has settled but is still being watched. */
function findLastFinished(list: CodingRun[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!isHeld(list[i].status) && !isPrPending(list[i].pr)) return i;
  }
  return -1;
}

/**
 * Ask a live run to end: `stop` for good, `pause` to settle with its session
 * intact. A Stop after a Pause overrides it — the later gesture is the
 * decision — while a Pause after a Stop changes nothing, and neither is
 * signalled twice.
 */
function requestEnd(run: CodingRun, state: LiveRun, kind: "stop" | "pause"): void {
  if (state.endRequested === kind || (kind === "pause" && state.endRequested !== null)) return;
  state.endRequested = kind;
  pushProgress(run, kind === "stop" ? "Stop requested" : "Pause requested");
  endProcess(state);
  persist();
}

/** Idempotent: stopping a finished run just returns it. */
export function stopRun(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status === "paused") {
    // No process to signal — the pause already ended it. Stopping a paused
    // run is the owner closing the book on it.
    run.status = "stopped";
    run.error = "Stopped.";
    run.completedAt = run.completedAt ?? Date.now();
    // A pause left the group alone (a paused run may be resumed into the same
    // folder, and anything it started is still wanted); closing the book on it
    // is where that stops being true.
    cleanupRunResources(run, null);
    // The pull request the pause kept "opening" (see maybeOpenPullRequest)
    // ends here with the run: this path never reaches finishRun, so nothing
    // else would settle it.
    if (isPrPending(run.pr)) {
      settlePr(run, "failed", `Stopped before a pull request was opened. The work stays on ${run.pr?.branch ?? runBranchName(run.id)}.`);
    }
    persist(true);
    wakeWaiters(id);
    return cloneRun(run);
  }
  if (run.status !== "running") return cloneRun(run);
  const state = live.get(id);
  if (!state) {
    // On disk as running but not ours — a record from a previous process that
    // loadRuns() did not get to repair. Settle it here.
    run.status = "stopped";
    run.error = "Stopped.";
    run.completedAt = Date.now();
    cleanupRunResources(run, null);
    persist(true);
    wakeWaiters(id);
    return cloneRun(run);
  }
  requestEnd(run, state, "stop");
  return cloneRun(run);
}

/**
 * Ask a running run to PAUSE: the process ends gracefully, the record settles
 * as "paused" with its session intact, and resumeRun() respawns into it.
 * Idempotent the way stopRun is: pausing anything not running returns it.
 */
export function pauseRun(id: string): CodingRun {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status !== "running") return cloneRun(run);
  const state = live.get(id);
  if (!state) {
    // On disk as running but not ours — settle it as paused only if it has a
    // session to come back to; otherwise it is simply lost.
    run.status = run.sessionId ? "paused" : "failed";
    run.resumable = run.sessionId !== null;
    if (!run.sessionId) run.error = "The run was lost before it could be paused.";
    run.completedAt = Date.now();
    persist(true);
    wakeWaiters(id);
    return cloneRun(run);
  }
  requestEnd(run, state, "pause");
  return cloneRun(run);
}

/**
 * Starts and resumes under way, by run id.
 *
 * Both read the record's status synchronously and then AWAIT their gates —
 * the switch, readiness, setpriv, the folder — before flipping it to
 * "running" and spawning. Two POSTs for the same run arriving together both
 * saw "draft" (or "paused"), both passed, and both spawned: two processes
 * on one record. The first caller's transition is THE transition; a second
 * ask for the same run while it is under way gets the same promise, exactly
 * as a start of a run already running gets the running record back.
 */
const transitions = new Map<string, Promise<CodingRun>>();

function singleFlight(id: string, transition: () => Promise<CodingRun>): Promise<CodingRun> {
  const inFlight = transitions.get(id);
  if (inFlight) return inFlight;
  const pending = transition().finally(() => transitions.delete(id));
  transitions.set(id, pending);
  return pending;
}

/**
 * Resume a PAUSED run in place: the same record, the same session, picked up
 * where the transcript left off. Runs through the same gates a start does —
 * the owner's switch, readiness, the capability drop, one run at a time.
 */
export function resumeRun(id: string): Promise<CodingRun> {
  return singleFlight(id, () => resumeRunOnce(id));
}

async function resumeRunOnce(id: string): Promise<CodingRun> {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status === "running") return cloneRun(run);
  if (run.status !== "paused") {
    throw new CodingAgentError("invalid", "Only a paused run can be resumed in place. Start a new run instead.");
  }
  await assertCanSpawn(run.team ?? null);
  const setprivPath = await requireSetpriv();
  // The pause gap is not working time: shift the start forward by it, so the
  // elapsed clock and the ETA speak of effort, not of the night in between.
  if (run.completedAt !== null) run.startedAt += Math.max(0, Date.now() - run.completedAt);
  run.status = "running";
  run.completedAt = null;
  run.error = null;
  run.exitCode = null;
  run.lastActivityAt = Date.now();
  pushProgress(run, "Resumed by the owner");
  persist(true);
  console.error(`[coding-agent] ${run.id} resumed from pause`);
  startProjectIcon(run);
  // The session already holds the task; replaying it verbatim would read as
  // "start over". Say what actually happened instead.
  const continuation = run.sessionId
    ? `You were paused by the owner and are now resumed in the same session. Continue the task where the transcript leaves off; do not start over. Your evidence folder is ${artifactsDir(run.id)}.`
    : undefined;
  spawnOrSettle(run, run.sessionId, setprivPath, { effort: run.effort, maxTurns: run.maxTurns }, continuation);
  return cloneRun(run);
}

/** Drafts the list will hold; beyond this, start or discard one first. */
export const MAX_DRAFT_RUNS = 10;

/**
 * Create a run the owner will start LATER: the full record, validated the way
 * a start is (task, folder), but no process. It sits in the list as "draft"
 * until startDraftRun spawns it or deleteDraftRun discards it.
 */
export async function createDraftRun(input: StartRunInput): Promise<CodingRun> {
  const task = normalizeTask(input.task);
  if (loadRuns().filter((r) => r.status === "draft").length >= MAX_DRAFT_RUNS) {
    throw new CodingAgentError("invalid", `There are already ${MAX_DRAFT_RUNS} drafted runs. Start or discard one first.`);
  }
  const { directory, projectId } = await resolveWorkingDirectory(input);
  // Snapshot of today's settings for the card; re-read at start, because the
  // run keeps the settings it STARTS with, not the ones it was drafted under.
  const run = newRunRecord({ task, directory, projectId, source: input.source, status: "draft", settings: await readRunSettings() });
  pushProgress(run, "Drafted — start it when ready");
  insertRun(loadRuns(), run);
  persist(true);
  console.error(`[coding-agent] ${run.id} drafted by ${run.source} for ${run.directory}`);
  return cloneRun(run);
}

/** Start a drafted run now. The same gates and the same freshness rules as startRun. */
export function startDraftRun(id: string): Promise<CodingRun> {
  return singleFlight(id, () => startDraftRunOnce(id));
}

async function startDraftRunOnce(id: string): Promise<CodingRun> {
  const run = loadRuns().find((r) => r.id === id);
  if (!run) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (run.status === "running") return cloneRun(run);
  if (run.status !== "draft") throw new CodingAgentError("invalid", "Only a drafted run can be started this way.");
  await assertCanSpawn(run.team ?? null);
  const setprivPath = await requireSetpriv();
  // The folder must still be there — it was only checked when drafted.
  run.directory = await realDirectory(run.directory);
  // Settings are read at START: a run keeps what it starts with.
  const settings = await readRunSettings();
  run.effort = settings.effort;
  run.maxTurns = settings.maxTurns;
  run.tokenLimit = settings.tokenLimit;
  run.media = { images: settings.generateImages, audio: settings.generateAudio };
  run.status = "running";
  run.startedAt = Date.now();
  run.lastActivityAt = Date.now();
  pushProgress(run, "Started from a draft");
  persist(true);
  console.error(`[coding-agent] ${run.id} started from draft by ${run.source} in ${run.directory}`);
  startProjectIcon(run);
  spawnOrSettle(run, null, setprivPath, settings);
  return cloneRun(run);
}

/** Discard a draft. Only drafts: everything else is history and history stays. */
export function deleteDraftRun(id: string): void {
  const list = loadRuns();
  const idx = list.findIndex((r) => r.id === id);
  if (idx < 0) throw new CodingAgentError("not_found", "There is no coding run with that id.");
  if (list[idx].status !== "draft") {
    throw new CodingAgentError("invalid", "Only a draft can be deleted; finished runs are history.");
  }
  removeArtifacts(id);
  list.splice(idx, 1);
  persist(true);
}

/** The gates every spawn passes: the owner's switch, readiness, the slot. */
async function assertCanSpawn(team: RunTeam | null = null): Promise<void> {
  if (!(await isCodingAgentEnabled())) {
    throw new CodingAgentError("disabled", "The coding agent is switched off. The owner can turn it on in the Coding Agent app on the ClawBox desktop.");
  }
  const readiness = await checkReadiness();
  if (!readiness.ready) throw new CodingAgentError("not_ready", readiness.problems.join(" "));
  if (team) {
    // A team's own runs share the box, up to MAX_TEAM_WORKERS and the memory guard.
    const slot = await teamSpawnSlot(team);
    if (!slot.ok) throw new CodingAgentError("busy", slot.reason);
    return;
  }
  const active = loadRuns().filter((r) => isLive(r.status));
  if (active.length >= MAX_CONCURRENT_RUNS) {
    throw new CodingAgentError("busy", `A coding run is already in progress (${active[0].id}). Wait for it or stop it first.`);
  }
}

/**
 * setpriv, resolved fresh rather than carried out of checkReadiness: this
 * path is what strips the web server's network capabilities off the run, and
 * a run must never start without it — not even if the binary vanished a
 * moment ago.
 */
async function requireSetpriv(): Promise<string> {
  const setprivPath = await findExecutableOnPath(CAPABILITY_DROP_COMMAND);
  if (!setprivPath) {
    throw new CodingAgentError(
      "not_ready",
      `${CAPABILITY_DROP_COMMAND} (part of util-linux) is missing, and without it a run would inherit the web server's network capabilities. Install util-linux.`,
    );
  }
  return setprivPath;
}

/**
 * spawnRun, with a synchronous throw settling the record.
 *
 * The record is already on disk as "running". If spawn throws SYNCHRONOUSLY
 * — a cwd that vanished between the check and here, a setpriv that is not
 * executable — nothing would ever settle it: `live` has no entry, so the
 * boot sweep is the only thing that would, and until the next restart the
 * one-run-at-a-time rule answers every later run with "busy". Settle it
 * here, then report the failure to the caller.
 */
function spawnOrSettle(
  run: CodingRun,
  resumeSessionId: string | null,
  setprivPath: string,
  settings: { effort: CodingEffort; maxTurns: number },
  stdinText?: string,
): void {
  try {
    spawnRun(run, resumeSessionId, setprivPath, settings, stdinText);
  } catch (err) {
    run.status = "failed";
    run.error = `Could not start ${CODING_HARNESS_COMMAND}: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_ERROR_CHARS);
    run.completedAt = Date.now();
    // Nothing settles this run through finishRun either, so the tab a previous
    // attempt of the same record opened is closed here.
    cleanupRunResources(run, null);
    // The branch made for its pull request is already on the record. Nothing
    // settles the run through finishRun on this path, so the pull request is
    // ended here too, or it stays "opening" — pending — for good.
    if (isPrPending(run.pr)) {
      settlePr(run, "failed", `The run could not start, so no pull request was opened. Its branch ${run.pr?.branch ?? runBranchName(run.id)} is checked out.`);
    }
    persist(true);
    wakeWaiters(run.id);
    console.error(`[coding-agent] ${run.id} failed to spawn:`, err instanceof Error ? err.message : err);
    throw new CodingAgentError("not_ready", run.error);
  }
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
  transitions.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  dirty = false;
  runs = null;
}
