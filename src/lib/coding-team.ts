/**
 * A coding TEAM: the multi-agent shape of the coding agent (owner's brief,
 * 2026-09-04), v0.
 *
 *   Planner  → posts tasks to the Blackboard (coding-team-board.ts)
 *   Workers  → take tasks, execute, post results
 *   Reviewer → checks each result (v0: a rule; v1: the review pass)
 *   Bus      → the one way any of them changes the board (coding-team-bus.ts)
 *
 * Every agent here IS a coding run (src/lib/coding-agent.ts) — the sandbox
 * the device already has: capability drop, Bash allow/deny lists, file deny
 * rules, folder containment, step and token ceilings. The planner is a run
 * that may only read; a worker is an ordinary run whose task is one board
 * task with the team's context around it. The orchestrator is this module,
 * in the web server: it starts runs one at a time (the runner's own rule on
 * a Jetson), listens for them to settle, and speaks on the bus in the role
 * the message belongs to — as the planner when posting the plan it parsed,
 * as the worker when relaying that worker's outcome, as the reviewer when
 * ruling, as the system when assigning and when a guardrail spoke.
 *
 * Guardrails (v0): the board refuses any message its sender's role may not
 * send and logs the refusal; a worker that hit a permission denial, or that
 * touched files outside its task's files_hint, raises an ALERT (refusals of
 * read-only actions alone are a NOTE, and the task stays clean — as are the
 * ones on the project's own path that the runner answered with a retry hint
 * at the worker's worktree; a look into the harness's state never is); after
 * MAX_ALERTS the team stops — unless every task is accepted by then. Not
 * counted, though alerted: a reviewer that could not start, a merge
 * conflict, a refused action (each already a rejection, offered once more);
 * a reviewer waiting for room is neither. Strays outside a task's files and
 * reviewers that give no verdict count. A failed task fails the
 * team unless other tasks can still run; a task the reviewer rejects is
 * re-posted once. A worker's branch that comes home empty has what the
 * worker left uncommitted in its worktree committed first; still empty while
 * its own run's record names files it wrote there, it is rejected (NO
 * CHANGE) — never accepted by rule, whatever the review mode. One that wrote
 * nothing — a check, a review, whatever files its task names to read — goes
 * on as before, with a note.
 *
 * The team's SHAPE is the planner's to choose per goal (TASK-1099): how many
 * workers run side by side (never more than the box's own slots) and how the
 * work is reviewed — a reviewer per task, one over the merged result, or the
 * rule alone. Whatever the shape, a team whose project has its own test suite
 * is never "done" while that suite is red on the merged result (TASK-1321,
 * `suiteGate`): the failing tests go back as a rejection, the tasks they point
 * at are offered once more, and a suite still red after that fails the team.
 * Every worker reads a bounded digest of the whole board. With
 * the owner's `coding_team_dynamic` switch on, the planner comes back as the
 * LEAD once per batch of settled workers — only when there is something to
 * decide — and may add or retire a few tasks; with it off, no lead run is
 * ever started. The team's figures (runs per role, tasks
 * planned/added/retired/accepted/rejected, tokens, wall time) are on the
 * board.
 *
 * Every role's runs start on the provider and model the owner chose for it
 * (src/lib/coding-role-models.ts), and each run's line in the cast list keeps
 * its own, so the team's tokens split by provider. A team whose planner,
 * workers or reviewers sit on an account that cannot run is refused before
 * anything is made (`not_ready`). A task the plan marks `bulk` — token-heavy,
 * not critical — gets a worker on the bulk role's model; when that account
 * cannot run, an ordinary worker takes it, and a note says so.
 *
 * A team lives in this process; its board is on disk after every message.
 * A team the web server was restarted under is settled as failed on the
 * next read, with the reason, never left "working" forever.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "@/lib/runtime-path";
import {
  CodingAgentError,
  getAutoPr,
  getMaxParallelRuns,
  getRun,
  getTeamDynamic,
  harnessStateDir,
  isCodingAgentEnabled,
  MAX_TASK_CHARS,
  MAX_TEAM_WORKERS,
  noteTeamMessageSent,
  queueRunMessage,
  readTokenBreakdown,
  resolveWorkingDirectory,
  SlotsFullError,
  startRun,
  stopRun,
  suiteSandbox,
  teamRoleModelMap,
  teamSpawnSlot,
  waitForRun,
  type CodingRun,
  type CodingRunSource,
  type RunTeam,
  type TeamRoleModelMap,
} from "@/lib/coding-agent";
import { isCodingProvider, type CodingProvider } from "@/lib/coding-provider";
import { MODEL_ROLES, type ModelRole } from "@/lib/coding-role-models";
import { RUNNER_STEP } from "@/lib/coding-agent-progress";
import { onBatteryPower, teamWorkerCap } from "@/lib/coding-run-cpu";
import { RunMessageError, teammatePrefix } from "@/lib/coding-run-messages";
import {
  normalizeTeamMessage,
  ownerAgentMessage,
  rateLimitedError,
  RUN_ID_RE,
  TEAM_MESSAGE_TARGETS,
  TEAM_ROLES,
  teamMessageAllowance,
  TeamMessageError,
  type TeamMessageRefusal,
  type TeamMessageTarget,
  type TeamRole,
} from "@/lib/coding-team-messages";
import { buildCommitMessage } from "@/lib/coding-git";
import { addWorkerWorktree, changedFiles, committableFiles, ensureTeamBranch, harvestWorktree, isGeneratedArtifact, mergeWorkerBranch, removeWorktree } from "@/lib/coding-team-worktree";
import { hintInFolder, toFolderPaths } from "@/lib/coding-worktree-paths";
import { answerHead, FINAL_REVIEWER_BRIEF, finalReviewerTask, finalReviewRoom, NOT_REVIEWED, parseVerdict, ranNothing, REVIEWER_BRIEF, REVIEWER_NUDGE, reviewerTask, SHELL_REVIEWER_BRIEF, shellReviewerTask, testEvidence, type Verdict } from "@/lib/coding-team-reviewer";
import { runProjectSuite, suiteFailure, suiteNote, suiteRejection } from "@/lib/coding-team-suite";
import { ciFailureLine, ciFixNotes, goalWantsMerge, goalWantsPullRequest, MAX_TEAM_CI_ROUNDS, readCiFailure, type CiFailure } from "@/lib/coding-ci";
import { decideMerge, markPullRequestReady, mergePullRequest, openPullRequest, readPullRequest } from "@/lib/coding-pr";
import { pushBranch, readFailedCheckLogs, readReviewSnapshot } from "@/lib/coding-review";
import { isLive, isSettled } from "@/lib/coding-agent-status";
import {
  allComplete,
  blockedBy,
  BoardAccessError,
  boardDigest,
  countedAttempts,
  createBoard,
  harnessStateDenial,
  isExhausted,
  isSettledTeamStatus,
  listBoards,
  loadBoard,
  MAX_DIGEST_CHARS,
  outsideFolderWriteDenial,
  ownHarnessStateDenial,
  readOnlyDenial,
  readyTasks,
  refModel,
  repoMapText,
  saveBoard,
  setTeamStatus,
  startedDependents,
  teamAdvice,
  teamAgents,
  teamMetrics,
  TEAM_ID_RE,
  waitingOn,
  type Actor,
  type ReviewMode,
  type SlotWait,
  type TeamAdvice,
  type TeamAgents,
  type TeamBoard,
  type TeamPr,
  type TeamRunRef,
  type TeamTask,
} from "@/lib/coding-team-board";

/**
 * The board as the routes and the app read it: with who worked, counted, the
 * figures as of now, whether a single run would have been cheaper
 * (`teamAdvice`), and — while it waits — its place in the queue.
 */
export type TeamView = TeamBoard & { agents: TeamAgents; advice: TeamAdvice | null; queuePosition?: number };
import { TeamBus, type Delivered, type TeamMessage } from "@/lib/coding-team-bus";
import { clippedNote, leadRoom, leadShouldRun, leadTask, parsePlan, parseReplan, PLANNER_BRIEF, providerWords, REPLAN_BRIEF, replanContext, replanTask, withTeamModels } from "@/lib/coding-team-planner";

/** A team stops after this many alerts: something is going wrong repeatedly. */
export const MAX_ALERTS = 3;
/** The rejection of a worker whose branch came home empty though its run wrote files in its worktree. */
export const NO_CHANGE = "NO CHANGE: the worker's branch has no commit; redo the task and commit your files.";
/** How long the orchestrator waits on one run per poll; the runner caps a wait anyway. */
const WAIT_SLICE_MS = 60_000;
/** How long the loop waits for a slot (memory, the cap) before looking again. */
const SLOT_WAIT_MS = 15_000;
/** How often a run that is HELD (paused by the owner) is looked at again. */
const HELD_POLL_MS = 2_000;
/**
 * How often a run of the team waiting for room — the team's own slots, the
 * owner's limit on runs at once, the memory guard — asks again: a planner,
 * a reviewer, a lead, and a worker while none of the team's is going.
 */
const ROOM_POLL_MS = 3_000;
/** A planner, a worker, a reviewer or a lead that has not settled by then is stopped. */
export const RUN_BUDGET_MS = 60 * 60_000;
/** A teammate at work is named by its run and its task's first line, cut here. */
const TEAMMATE_QUOTE_CHARS = 160;

export const WORKER_BRIEF = [
  "You are ONE WORKER of a small coding team. The task you were given is one part of a larger goal; other workers do the other parts in their own sessions, before or after you.",
  "Do your task and only your task: do not redo, undo or 'improve' the parts that belong to others, and stay inside the files your task names unless the task cannot be done otherwise — say so in your report if you had to.",
  "Scratch files go in your evidence folder only — never in /tmp, never beside the project. A write anywhere else is refused, and a refused write counts against your task.",
  "Your files count only once they are committed on your branch: the runner commits what you changed when you finish, and a `git add` and `git commit` of your files in your own folder before your final message is welcome.",
  "Your final message is read by the team's reviewer and quoted to the next worker: state what you changed (file names), how it can be checked, and anything you could not finish.",
  "Message a SIBLING with team_message (to=\"sibling\", its run id is in your task text under 'Teammates at work now') when your task needs a file, a name, a schema or an API shape that a teammate owns and that is not in your folder yet: ask for exactly that, in one message. If a teammate's message asks you for such a thing, answer it once with the exact answer (file name, field names, function signature) — that is the one reply that is not an acknowledgement.",
  "Message the LEAD (to=\"lead\") when a task on the board is wrong for the goal: it is already done, it duplicates yours, or it cannot be done as written.",
  "Message the owner's assistant (to=\"owner_agent\") only for a decision only the owner can take.",
  "Never send a team_message for progress reports — what you did belongs in your final message — and never to acknowledge a message a teammate sent you.",
].join(" ");

export interface StartTeamInput {
  goal: string;
  projectId?: string | null;
  directory?: string | null;
  source: CodingRunSource;
}

interface LiveTeam {
  board: TeamBoard;
  bus: TeamBus;
  stopRequested: boolean;
  /** Every run of the team still going — several workers at once. */
  currentRunIds: Set<string>;
  /**
   * Team messages on their way to the assistant's chat, per sending run: the
   * one delivery that awaits, counted against the caps while it does so two
   * sends in flight cannot both take the last slot.
   */
  pendingMessages: Map<string, number>;
  /**
   * Alerts that do not count toward MAX_ALERTS: a reviewer that could not
   * start is a review missed, not the team's work going wrong. Two of them
   * and one real alert failed a team whose every deliverable was on disk
   * (bench, 2026-09-22). Nor do a merge conflict and a refused action: each
   * is already a rejection offered once more, and two conflicts and one
   * refused command stopped a team whose integration worker had every
   * check green (night run, 2026-10-29).
   */
  uncountedAlerts: number;
  /**
   * When the lead's last two turns that got a run were written (ms), older
   * first. A turn that decided nothing leaves its inbox unread
   * (`board.lastLeadAt`), and what was in it calls the lead back ONCE: a
   * message from before the older one was put to two leads already. Called
   * after every batch instead, a lead that never answers would cost an alert
   * each time, until MAX_ALERTS stopped a team whose work was fine.
   */
  leadTurnsAt: [number, number];
  /**
   * Tasks whose worker is being stopped because a dependency of theirs was
   * rejected or reopened after they started (`holdDependents`): the task is
   * set back once its worker settles, its work set aside unmerged.
   */
  held: Map<string, { dependency: string; reason: string }>;
  /**
   * How many workers may run side by side right now: the plan's shape within
   * the box's slots, ONE while the box is on battery. A worker's CPU budget is
   * shared by this many (`StartRunInput.cpuShare`).
   */
  workerSlots: number;
  done: Promise<void>;
}

const live = new Map<string, LiveTeam>();

/**
 * Teams that may wait at once behind the one working. One team works at a
 * time — the box has one shell budget — and a queue is a promise to start
 * each of them unattended, in order; beyond this the caller is told to wait.
 */
export const MAX_QUEUED_TEAMS = 5;
/** How soon a queued team is looked at again when its turn came while the coding agent was switched off. */
const TEAM_QUEUE_RETRY_MS = 60_000;
let teamQueueRetry: NodeJS.Timeout | null = null;

/** Planner runs a team will pay for before giving up on getting an array. */
const MAX_PLANNER_ATTEMPTS = 3;

const SYSTEM: Actor = { kind: "system" };
const PLANNER: Actor = { kind: "planner" };
const REVIEWER: Actor = { kind: "reviewer" };
const OWNER: Actor = { kind: "owner" };
const worker = (id: string): Actor => ({ kind: "worker", id });

// ─── Public API ──────────────────────────────────────────────────────────────

export function activeTeamId(): string | null {
  for (const [id, team] of live) if (!isSettledStatus(team.board.status)) return id;
  return null;
}

/**
 * Start a team on a goal — or QUEUE it, while another team is working (one
 * team at a time: the box has one shell budget) or others already wait: the
 * board is saved `queued` and started by the box itself, in the order asked,
 * when the teams ahead of it settle (`startNextQueuedTeam`), across a restart
 * too. Refuses while the switch is off, for a folder a run could not be
 * pointed at, and past MAX_QUEUED_TEAMS waiting.
 */
export async function startTeam(input: StartTeamInput): Promise<TeamView> {
  if (!(await isCodingAgentEnabled())) {
    throw new CodingAgentError("disabled", "The coding agent is switched off. Turn it on in the Coding Agent app first.");
  }
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) throw new CodingAgentError("invalid", "A team needs a goal.");
  if (goal.length > MAX_TASK_CHARS) throw new CodingAgentError("invalid", `The goal is too long (${goal.length} > ${MAX_TASK_CHARS} characters).`);
  const { directory, projectId } = await resolveWorkingDirectory({ projectId: input.projectId ?? null, directory: input.directory ?? null });
  // Before anything is made or spawned: a team whose planner, workers or
  // reviewers sit on an account that cannot run would fail at its first run
  // of that role — the reviewer's, minutes in, after the work was paid for.
  await assertTeamRolesReady();
  // The lead's switch, as it stands NOW: kept on the board, so an owner who
  // flips it while this team works changes the next team, not this one. A
  // queued team reads it again when its turn comes.
  const dynamic = await getTeamDynamic();
  // Read after the last await, with the board made in the same synchronous
  // step: two asks arriving together cannot both find the box free.
  const busy = activeTeamId();
  const waiting = queuedBoards();
  if ((busy || waiting.length) && waiting.length >= MAX_QUEUED_TEAMS) {
    throw new CodingAgentError("busy", `There are already ${MAX_QUEUED_TEAMS} coding teams waiting on this ClawBox. Wait for the queue to move, or ask the owner to cancel one.`);
  }

  // The owner's team is created in the owner's name; the assistant's by the
  // system on its behalf — the audit says which, and the routes gate on it.
  const board = createBoard({ goal, projectId, directory, source: input.source, dynamic }, input.source === "owner" ? OWNER : SYSTEM);
  if (busy || waiting.length) {
    setTeamStatus(board, SYSTEM, "queued", busy ? `Waiting for team ${busy} to finish` : `Waiting behind ${waiting.length} queued team(s)`);
    saveBoard(board);
    return snapshot(board);
  }
  saveBoard(board);
  launchTeam(board);
  return snapshot(board);
}

/**
 * The roles a team cannot do without. Not `bulk`: a bulk task whose account
 * cannot run is worked by an ordinary worker instead (`bulkMayRun`).
 */
const REQUIRED_ROLES: readonly ModelRole[] = MODEL_ROLES.filter((r) => r !== "bulk");

/** "planner", "planner and reviewer", "planner, worker and reviewer". */
function andList(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What each role of a team starts on right now, or null when that cannot be read — never a reason to stop a team on its own. */
async function readTeamModels(): Promise<TeamRoleModelMap | null> {
  try {
    return await teamRoleModelMap();
  } catch (err) {
    console.error("[coding-team] could not read the team's role models:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Refuses a team, `not_ready`, when its planner, its workers or its reviewers
 * resolve to a provider that cannot run right now — naming the roles, the
 * provider and why, one sentence per provider: a planner and a reviewer on
 * the same unconnected account are one problem, not two. The readiness is the
 * spawn gate's own (`teamRoleModelMap`). A map that cannot be read refuses
 * nothing: every run is still judged at its own spawn.
 */
async function assertTeamRolesReady(): Promise<void> {
  const map = await readTeamModels();
  if (!map) return;
  const blocked = new Map<CodingProvider, { roles: ModelRole[]; problems: string[] }>();
  for (const role of REQUIRED_ROLES) {
    const r = map[role];
    if (!r || r.ready) continue;
    const entry = blocked.get(r.provider) ?? { roles: [], problems: [] };
    entry.roles.push(role);
    for (const p of r.problems) if (p.trim() && !entry.problems.includes(p.trim())) entry.problems.push(p.trim());
    blocked.set(r.provider, entry);
  }
  if (!blocked.size) return;
  const sentences = [...blocked].map(([provider, { roles, problems }]) =>
    `The team's ${andList(roles)} ${roles.length === 1 ? "runs" : "run"} on ${providerWords(provider)} (${provider}), which cannot run right now: ${problems.join(" ") || "it is not ready."}`);
  const roles = [...blocked.values()].flatMap((b) => b.roles);
  throw new CodingAgentError(
    "not_ready",
    `${sentences.join(" ")} Connect it, or choose another provider for the ${andList(roles)} under Team models in the Coding Agent settings.`,
  );
}

/** The board's orchestrator, in this process, from its planner to its verdict; the next queued team once it settles. */
function launchTeam(board: TeamBoard): void {
  const bus = new TeamBus(board);
  const team: LiveTeam = { board, bus, stopRequested: false, currentRunIds: new Set(), pendingMessages: new Map(), uncountedAlerts: 0, leadTurnsAt: [0, 0], held: new Map(), workerSlots: 1, done: Promise.resolve() };
  // A task reopened — rejected, sent back by the suite, or itself held — sets
  // back whatever started on it, wherever the reopening came from.
  bus.subscribe((delivered) => holdDependents(team, delivered));
  live.set(board.id, team);
  team.done = runTeam(team, board.source)
    .catch((err) => {
      if (!isSettledStatus(board.status)) {
        setTeamStatus(board, SYSTEM, "failed", err instanceof Error ? err.message : String(err));
        saveBoard(board);
      }
    })
    .finally(() => {
      // Kept in the map only while it works; a settled team is read from disk.
      if (isSettledStatus(board.status)) live.delete(board.id);
      // The box is free: the queue's next team, in its turn.
      void startNextQueuedTeam().catch((err) => {
        console.error("[coding-team] could not start the next queued team:", err instanceof Error ? err.message : err);
      });
    });
}

/** The queued boards in the order they start in: the order they were asked for. */
function queuedBoards(): TeamBoard[] {
  return listBoards().filter((b) => b.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Start the oldest QUEUED team, when no team is working — after a team
 * settles, and at boot (src/instrumentation.ts), since the queue is on disk.
 * With the coding agent switched off it keeps its place and is looked at
 * again in a minute. Answers the team it started, or null.
 */
export async function startNextQueuedTeam(): Promise<TeamView | null> {
  if (activeTeamId() || !queuedBoards().length) return null;
  if (!(await isCodingAgentEnabled())) {
    if (!teamQueueRetry) {
      teamQueueRetry = setTimeout(() => {
        teamQueueRetry = null;
        void startNextQueuedTeam().catch(() => undefined);
      }, TEAM_QUEUE_RETRY_MS);
      teamQueueRetry.unref?.();
    }
    return null;
  }
  const dynamic = await getTeamDynamic();
  // Looked at again after the awaits, and launched in the same synchronous
  // step: two settles racing here must not start two teams.
  if (activeTeamId()) return null;
  const next = queuedBoards()[0];
  if (!next) return null;
  next.dynamic = dynamic;
  setTeamStatus(next, SYSTEM, "planning", "Its turn in the queue came");
  saveBoard(next);
  launchTeam(next);
  return snapshot(next);
}

/**
 * Take a team out of the queue before it starts — the OWNER's gesture alone
 * (the stop route lets only the owner's session reach it; the MCP bearer may
 * queue a team and read the queue, never cancel). A team no longer queued is
 * answered as it is.
 */
export function cancelQueuedTeam(id: string): TeamView {
  const board = live.get(id)?.board ?? loadBoard(id);
  if (!board) throw new CodingAgentError("not_found", "There is no coding team with that id.");
  if (board.status !== "queued") return snapshot(board);
  setTeamStatus(board, OWNER, "stopped", "Canceled by the owner before it started");
  saveBoard(board);
  return snapshot(board);
}

/** Stop a team: the owner's gesture. The worker in flight is stopped too. */
export function stopTeam(id: string): TeamView {
  const team = live.get(id);
  if (!team) {
    const board = loadBoard(id);
    if (!board) throw new CodingAgentError("not_found", "There is no coding team with that id.");
    if (isSettledStatus(board.status)) return snapshot(board);
    // Nothing is running: taking it out of the queue is the owner's (cancelQueuedTeam).
    if (board.status === "queued") {
      throw new CodingAgentError("invalid", "That team is queued and has not started. Only the owner can cancel a queued team, from the Coding Agent app.");
    }
    // A team from before a restart: settle it now.
    setTeamStatus(board, SYSTEM, "failed", "The web server restarted while the team was working.");
    saveBoard(board);
    return snapshot(board);
  }
  team.stopRequested = true;
  for (const runId of team.currentRunIds) {
    try { stopRun(runId); } catch { /* already settled */ }
  }
  if (!isSettledStatus(team.board.status)) {
    setTeamStatus(team.board, OWNER, "stopped", "Stopped by the owner");
    saveBoard(team.board);
  }
  return snapshot(team.board);
}

export function getTeam(id: string): TeamView | null {
  if (!TEAM_ID_RE.test(id)) return null;
  const team = live.get(id);
  if (team) return snapshot(team.board);
  const board = loadBoard(id);
  if (!board) return null;
  return snapshot(settleOrphan(board));
}

export function listTeams(limit = 20): TeamView[] {
  const boards = listBoards();
  // The queue's order once per list, from the boards already read — not one
  // directory scan per queued team.
  const queue = boards.filter((b) => b.status === "queued").sort((a, b) => a.createdAt - b.createdAt).map((b) => b.id);
  return boards.slice(0, limit).map((b) => live.get(b.id)?.board ?? settleOrphan(b)).map((b) => snapshot(b, queue));
}

/** The team a run belongs to, for the run page's chip. */
export function teamOfRun(run: Pick<CodingRun, "team">): TeamView | null {
  return run.team ? getTeam(run.team.id) : null;
}

// ─── Team messages (coding-team-messages.ts) ─────────────────────────────────

/** How long the assistant's chat gets to take a message; the MCP client waits longer. */
export const OWNER_AGENT_TIMEOUT_MS = 10_000;

export interface TeamMessageInput {
  teamId: unknown;
  fromRunId: unknown;
  /** The role the sending run's environment claims; checked against the board. */
  role: unknown;
  to: unknown;
  toRunId?: unknown;
  text: unknown;
}

export interface TeamMessageSent {
  to: TeamMessageTarget;
  toRunId: string | null;
  /**
   * sibling: true when the receiving harness has it in this turn, false when
   * it is queued for that run's next turn. lead and owner_agent: true.
   */
  delivered: boolean;
  /** owner_agent: the chat session it was posted into. */
  sessionKey?: string;
  at: number;
  /** Messages the sending run may still send. */
  left: number;
}

/**
 * A run of a live team says something to a sibling, to the lead or to the
 * box's main agent — `POST /setup-api/coding-agent/team/message`, reached
 * from the run's own MCP server (`team_message`).
 *
 * The sender is checked against the BOARD, not believed: it must be on the
 * cast list in the role it claims, its record must say the same team and role,
 * and it must be running. A run speaks only as itself — the rule the bus holds
 * a worker's status update to — and the variables its MCP server was started
 * with are its name, not a pass.
 *
 * Every refusal of the SENDER's (the text, the claim, the target, the caps) is
 * logged on the board as an alert through the bus, like any message the bus
 * would not take, and throws a TeamMessageError with its code. A sibling that
 * had already finished (SETTLED — a late answer racing its end) is logged as a
 * note and counted as undelivered, never an alert, and throws too. A message the
 * BOX could not hand on (no chat session, the Hermes edition, a gateway that
 * refused it) is logged as an undelivered message instead — never an alert —
 * and throws its code too. A delivered message is a `message` entry on the
 * board, a line on the sender's own feed, and, for a sibling, a queued message
 * on the receiver's record prefixed with who sent it. Nothing is forwarded on
 * from there: a run that receives a message is told not to answer it just to
 * acknowledge it, and the lead never answers at all.
 */
export async function sendTeamMessage(input: TeamMessageInput): Promise<TeamMessageSent> {
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const fromRunId = typeof input.fromRunId === "string" ? input.fromRunId.trim() : "";
  const role = typeof input.role === "string" ? input.role.trim() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const toRunId = typeof input.toRunId === "string" && input.toRunId.trim() ? input.toRunId.trim() : null;
  if (!TEAM_ID_RE.test(teamId) || !RUN_ID_RE.test(fromRunId)) throw new TeamMessageError("INVALID", "A team message names its team (teamId) and the run sending it (fromRunId).");
  if (!(TEAM_ROLES as readonly string[]).includes(role)) throw new TeamMessageError("INVALID", `role is one of ${TEAM_ROLES.join(", ")}.`);
  if (!(TEAM_MESSAGE_TARGETS as readonly string[]).includes(to)) throw new TeamMessageError("INVALID", `to is one of ${TEAM_MESSAGE_TARGETS.join(", ")}.`);
  const target = to as TeamMessageTarget;
  const sender = role as TeamRole;
  if (target === "sibling" && (!toRunId || !RUN_ID_RE.test(toRunId))) {
    throw new TeamMessageError("INVALID", "A message to a sibling names its run: toRunId, e.g. run-ab12cd34.");
  }

  const team = live.get(teamId);
  if (!team) {
    if (!loadBoard(teamId)) throw new TeamMessageError("NOT_FOUND", "There is no coding team with that id.");
    throw new TeamMessageError("SETTLED", `Team ${teamId} is no longer working; there is nobody left to tell.`);
  }
  const { board, bus } = team;
  if (isSettledStatus(board.status)) throw new TeamMessageError("SETTLED", `Team ${teamId} is no longer working; there is nobody left to tell.`);

  const actor: Actor = sender === "worker" ? worker(fromRunId) : sender === "planner" ? PLANNER : REVIEWER;
  const draft: TeamMessage = {
    type: "message",
    from_run_id: fromRunId,
    to: target,
    ...(target === "sibling" && toRunId ? { to_run_id: toRunId } : {}),
    text: typeof input.text === "string" ? input.text : "",
  };
  // The sender's refusals: on the board as an alert — the bus's own words for
  // a message it would not take — then the code to the caller. A sibling that
  // had already finished (SETTLED) is the bus's to log as a note instead: a
  // late answer is a race, not the sender's fault. The caller hears either way.
  const refused = (code: TeamMessageRefusal, reason: string, nextAllowedAt: number | null = null): TeamMessageError => {
    try {
      bus.refuse(actor, draft, `${code}: ${reason}`, code);
    } catch {
      // refuse() always throws once the entry is logged; the caller gets the code.
    }
    return new TeamMessageError(code, reason, nextAllowedAt);
  };

  const ref = board.runs.find((r) => r.id === fromRunId);
  const run = getRun(fromRunId);
  if (!ref || ref.role !== sender || !run || run.team?.id !== teamId || run.team.role !== sender || !isLive(run.status)) {
    throw refused("FORBIDDEN", `${fromRunId} is not a running ${sender} of team ${teamId}; a run speaks only as itself.`);
  }
  let text: string;
  try {
    text = normalizeTeamMessage(input.text);
  } catch (err) {
    if (err instanceof TeamMessageError) throw refused(err.code, err.message);
    throw err;
  }
  draft.text = text;
  if (target === "sibling") {
    if (toRunId === fromRunId) throw refused("SELF", "A run does not send a message to itself.");
    if (!board.runs.some((r) => r.id === toRunId)) throw refused("NOT_IN_TEAM", `${toRunId} is not a run of team ${teamId}. ${reachable(board, fromRunId)}`);
  }
  // The caps before the receiver's state: a message to a sibling that has
  // finished is a note that counts against them (TeamBus.refuse), so a run
  // that keeps sending there meets RATE_LIMITED — an alert — instead of
  // writing notes until the log's oldest entries fall off.
  const now = Date.now();
  const pending = team.pendingMessages.get(fromRunId) ?? 0;
  const allowance = teamMessageAllowance([...(ref.sentAt ?? []), ...Array.from({ length: pending }, () => now)], now);
  if (!allowance.ok) {
    const limited = rateLimitedError(allowance);
    throw refused("RATE_LIMITED", limited.message, limited.nextAllowedAt);
  }
  if (target === "sibling") {
    const receiver = getRun(toRunId!);
    if (!receiver || isSettled(receiver.status)) throw refused("SETTLED", `${toRunId} has finished; there is nothing left to tell it.`);
  }

  // The delivery.
  let delivered = true;
  let sessionKey: string | undefined;
  let undelivered: { code: TeamMessageRefusal; reason: string } | null = null;
  team.pendingMessages.set(fromRunId, pending + 1);
  try {
    if (target === "sibling") {
      try {
        // Prefixed with the VERIFIED sender: the receiver's harness is told who
        // said it (runMessageTurn), and its page shows the same line.
        delivered = queueRunMessage(toRunId!, `${teammatePrefix(sender, fromRunId)} ${text}`).delivered;
      } catch (err) {
        if (err instanceof RunMessageError && err.code === "settled") throw refused("SETTLED", `${toRunId} has finished; there is nothing left to tell it.`);
        if (err instanceof RunMessageError && err.code === "queue_full") throw refused("QUEUE_FULL", `${toRunId} has not read the messages it already has; do not send it more until it has.`);
        if (err instanceof CodingAgentError && err.kind === "not_found") throw refused("NOT_IN_TEAM", `${toRunId} is not a run of team ${teamId}.`);
        throw err;
      }
    } else if (target === "owner_agent") {
      const posted = await postToOwnerAgent(teamId, sender, fromRunId, text);
      if (posted.ok) sessionKey = posted.sessionKey;
      else undelivered = posted;
    }
    // The lead: the board entry below IS the delivery.
  } finally {
    const left = (team.pendingMessages.get(fromRunId) ?? 1) - 1;
    if (left > 0) team.pendingMessages.set(fromRunId, left);
    else team.pendingMessages.delete(fromRunId);
  }

  // On the board — validated, capped, persisted, audit-logged — as the run's
  // message, delivered or not. The team's alert count is not touched. Logged
  // even if the team settled while the assistant's chat was being reached:
  // the message went, and the audit trail says so.
  try {
    bus.send(actor, { ...draft, ...(undelivered ? { undelivered: undelivered.code } : {}) });
  } catch (err) {
    if (err instanceof BoardAccessError) throw new TeamMessageError("FORBIDDEN", err.message);
    throw err;
  }
  if (undelivered) throw new TeamMessageError(undelivered.code, undelivered.reason);

  // …and on the sender's own feed, so its page shows what it said.
  try {
    noteTeamMessageSent(
      fromRunId,
      target === "sibling"
        ? RUNNER_STEP.teamMessageToRun(toRunId!, text)
        : target === "lead"
          ? RUNNER_STEP.teamMessageToLead(text)
          : RUNNER_STEP.teamMessageToAssistant(text),
    );
  } catch {
    // The feed is the page's copy; the board already holds the record.
  }
  return { to: target, toRunId: target === "sibling" ? toRunId : null, delivered, ...(sessionKey ? { sessionKey } : {}), at: now, left: allowance.left - 1 };
}

/**
 * The teammates a run could message right now, said in one sentence — the
 * answer a run that named the wrong one needs, since a worker only knows the
 * run ids its task text listed when it started.
 */
function reachable(board: TeamBoard, fromRunId: string): string {
  const others = board.runs.filter((r) => r.id !== fromRunId && isHeldRun(r.id));
  if (!others.length) return "No other run of the team is at work now; tell the lead instead.";
  return `Its runs at work now: ${others.map((r) => `${r.id} (${r.role}${r.taskId ? `, ${r.taskId}` : ""})`).join(", ")}.`;
}

function isHeldRun(runId: string): boolean {
  const run = getRun(runId);
  return run !== null && !isSettled(run.status);
}

/**
 * Post into the box's main agent's chat: the session the web chat is bound to,
 * on the OpenClaw gateway. Loaded lazily — the harness and the gateway link
 * are nothing the rest of the orchestrator needs.
 */
async function postToOwnerAgent(
  teamId: string,
  role: TeamRole,
  runId: string,
  text: string,
): Promise<{ ok: true; sessionKey: string } | { ok: false; code: TeamMessageRefusal; reason: string }> {
  const { getActiveHarness } = await import("@/lib/harness");
  if ((await getActiveHarness()) !== "openclaw") {
    return { ok: false, code: "UNSUPPORTED", reason: "This box's assistant runs on Hermes, which gives a coding run no way into its chat; tell the lead instead." };
  }
  const gateway = await import("@/lib/openclaw-gateway-ws");
  try {
    const { sessionKey } = await gateway.gatewayWsChatSendMain(ownerAgentMessage(teamId, role, runId, text), {
      idempotencyKey: randomUUID(),
      timeoutMs: OWNER_AGENT_TIMEOUT_MS,
    });
    return { ok: true, sessionKey };
  } catch (err) {
    if (err instanceof gateway.GatewayWsUnavailableError) {
      return { ok: false, code: "NO_SESSION", reason: "There is no assistant chat session to post into right now: the OpenClaw gateway is not answering. The message was not delivered." };
    }
    return { ok: false, code: "NOT_DELIVERED", reason: `The assistant's chat did not take the message: ${firstLine(err instanceof Error ? err.message : String(err), 200)}` };
  }
}

/** Tests only. */
export function _resetCodingTeamStateForTests(): void {
  live.clear();
  if (teamQueueRetry) clearTimeout(teamQueueRetry);
  teamQueueRetry = null;
}

// ─── The loop ────────────────────────────────────────────────────────────────

/**
 * The base the team whose branch this is forked from, as its board recorded
 * it: where a new team forks when it finds that branch still checked out
 * (`forkBase`), never from the branch itself.
 */
function recordedTeamBase(branch: string): string | null {
  return listBoards().find((b) => b.branch === branch)?.base ?? null;
}


async function runTeam(team: LiveTeam, source: CodingRunSource): Promise<void> {
  const { board, bus } = team;
  // What every role runs on and costs, after the brief: the planner weighs
  // which tasks to mark bulk by it. Read once, as the team begins.
  const models = await readTeamModels();
  const brief = () => withTeamModels(PLANNER_BRIEF, models);

  // 1. The planner: a read-only run whose final message is the plan — once
  //    the box has a slot for it. A box busy with other runs makes the team
  //    wait for one (the board says so), never fail.
  const plannerRole: RunTeam = { id: board.id, role: "planner", taskId: null };
  const planner = await startWhenRoom(team, plannerRole, () => 0, () => startRun({
    task: board.goal,
    projectId: board.projectId,
    directory: board.directory,
    source,
    team: plannerRole,
    readOnly: true,
    extraBrief: brief(),
  }));
  if (!planner) return;
  board.plannerRunId = planner.id;
  board.runs.push(castRef(planner, "planner", null));
  saveBoard(board);
  const planned = await settle(team, planner.id);
  if (team.stopRequested) return;
  if (!planned || planned.status !== "completed") {
    setTeamStatus(board, SYSTEM, "failed", `The planner did not finish: ${planned?.error ?? planned?.status ?? "no run"}.`);
    saveBoard(board);
    return;
  }
  let answer = planned.resultText ?? planned.summary;
  let plan = parsePlan(answer);
  // More than one correction, because one was not enough. On the box, a planner
  // told only to "shorten" a 2835-character description answered 3013 the second
  // time and the board died with no task ever posted — twice, on two devices.
  // Each ask now carries every fault, and text over its length bound is cut
  // rather than refused (a note on the log, not an alert); the budget is
  // small because a planner that cannot answer an array in three tries is
  // not going to on the fourth, and every try is a paid run.
  for (let attempt = 2; !plan.ok && attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
    // Once more, and for the plan alone: a planner that wrote its plan as
    // prose is asked to say it as the JSON the team reads. On the record as
    // an alert, so a team that needed another ask says so.
    bus.send(SYSTEM, { type: "alert", reason: `The planner's answer was not a plan (${plan.reason}); asking once more for the JSON plan (attempt ${attempt} of ${MAX_PLANNER_ATTEMPTS}).` });
    const reask = replanTask(board.goal, answer, plan.reason);
    const again = await startWhenRoom(team, plannerRole, () => 0, () => startRun({
      task: reask,
      projectId: board.projectId,
      directory: board.directory,
      source,
      team: plannerRole,
      readOnly: true,
      extraBrief: brief(),
    }));
    if (!again) return;
    board.runs.push(castRef(again, "planner", null));
    saveBoard(board);
    const replanned = await settle(team, again.id);
    if (team.stopRequested) return;
    if (replanned?.status !== "completed") {
      // A planner run that did not finish is not a wording problem, so it is
      // not re-asked: the team fails with what actually happened to it.
      plan = { ok: false, reason: `The planner did not finish its answer: ${replanned?.error ?? replanned?.status ?? "no run"}.` };
      break;
    }
    answer = replanned.resultText ?? replanned.summary;
    plan = parsePlan(answer);
  }
  if (!plan.ok) {
    setTeamStatus(board, SYSTEM, "failed", plan.reason);
    saveBoard(board);
    return;
  }

  // The shape first, when the planner gave one: it is the frame the tasks
  // are read in. No shape is the default team — every slot, a reviewer per task.
  if (plan.shape) bus.send(PLANNER, { type: "shape", ...plan.shape });
  // The planner's map of what the goal touches, before the tasks: every worker
  // and reviewer is handed it instead of exploring the project again.
  if (plan.repoMap) {
    const { files, entryPoints, testCommands, gotchas } = plan.repoMap;
    bus.send(PLANNER, { type: "repo_map", files, entry_points: entryPoints, test_commands: testCommands, gotchas });
  }
  for (const task of plan.tasks) bus.send(PLANNER, { type: "task", ...task });
  // Text over its bound was cut, not refused: one note says so — never an alert.
  if (plan.clipped) bus.send(SYSTEM, { type: "note", text: clippedNote(plan.clipped) });

  // ONE task is one run's worth of work, and so are tasks that mostly touch the
  // same files (`teamAdvice`): side by side they only conflict and queue on
  // each other — and saying so after the run helped nobody (night run,
  // 2026-10-29: 93-96% overlap on every team). Either runs as one ordinary run,
  // not inside the team's branch, worktree and reviewer machinery around it.
  const advice = teamAdvice(board);
  if ((plan.tasks.length === 1 && board.tasks.length === 1) || advice?.reason === "overlap") {
    await runAsSingleRun(team, board.tasks, source, advice?.reason === "overlap" ? advice.overlap : null);
    return;
  }

  // The team's own branch in a folder project: workers get worktrees off it
  // and their branches merge back into it. A code project sits inside the
  // ClawBox checkout under rules of its own, so its workers work in place,
  // one at a time, as v0 did.
  if (!board.projectId) {
    const branched = await ensureTeamBranch(board.directory, board.id, recordedTeamBase);
    if (!branched.ok) {
      setTeamStatus(board, SYSTEM, "failed", branched.detail);
      saveBoard(board);
      return;
    }
    board.branch = branched.branch;
    board.base = branched.base;
  }
  setTeamStatus(board, SYSTEM, "working");
  saveBoard(board);

  // 2. Workers: every task whose dependencies are done gets a worker as soon
  //    as the box has room for one (MAX_TEAM_WORKERS, the owner's limit on
  //    runs at once, the memory guard) and the planner's shape allows
  //    another beside the ones going, and they
  //    settle in whatever order they finish. In place (no team branch)
  //    there is one slot: two workers in one checkout write over each other.
  const inFlight = new Map<string, Promise<void>>();
  const plannedSlots = board.branch ? Math.max(1, Math.min(MAX_TEAM_WORKERS, board.shape?.parallelism ?? MAX_TEAM_WORKERS)) : 1;
  // On battery (src/lib/coding-run-cpu.ts) ONE worker at a time, read again
  // before every dispatch: an owner who unplugs mid-team gets the cap for the
  // workers still to start, and one who plugs back in gets the plan's shape.
  let onBattery = false;
  // Workers dispatched whose run is not persisted yet (a worktree being
  // added): a reservation the spawn slot counts beside the live runs, for
  // the next worker and for a sibling's reviewer alike, and ONLY until the
  // run is live — counted twice, two live workers would shut out a valid third.
  const starting = new Set<string>();
  // Workers the SPAWN refused for room after the look admitted them — the
  // two raced someone else's start: back to pending, unstarted, and the next
  // look comes after a pause rather than at once.
  const spawnRefusals: Array<{ taskId: string; reason: string }> = [];
  // Tasks whose worker settled and that the lead has not looked at yet —
  // only ever filled while the owner's switch was on when the team started.
  const leadAfter: string[] = [];
  // The project's own tests on the merged result (TASK-1321, `suiteGate`):
  // how many times they ran, the words the team fails with when they are
  // still red after the one re-attempt, and what they said when they passed.
  let suiteRounds = 0;
  let suiteFailed: string | null = null;
  let suitePassed: string | null = null;
  // The pull request the goal asks for (`teamPullRequest`) — opened by this
  // orchestrator, never a worker — and the rounds its red CI sends tasks back
  // through the loop for, bounded by MAX_TEAM_CI_ROUNDS. A team in place (no
  // branch of its own) has nothing to open one from.
  const asksPr = goalWantsPullRequest(board.goal);
  // Asked for, and there is no branch to open one from: said once, not skipped in silence.
  if (!board.branch && asksPr) {
    bus.send(SYSTEM, { type: "note", text: "The goal asks for a pull request, but this team works in place (a code project, no branch of its own), so none is opened: the work stays in the project." });
  }
  for (;;) {
    suiteFailed = null;
    // Each round of the work may send the suite's suspects back once.
    suiteRounds = 0;
    while (!team.stopRequested) {
      const counted = board.alerts - team.uncountedAlerts;
      // A team whose every task is accepted has nothing left to go wrong:
      // it goes on to its suite, review and verdict, whatever the count.
      if (counted >= MAX_ALERTS && !allComplete(board)) {
        setTeamStatus(board, SYSTEM, "failed", `Stopped after ${counted} alerts.`);
        saveBoard(board);
        break;
      }
      // The lead, before anything new starts: a pending task it retires must
      // not be handed to a worker while it is still deciding. The workers
      // already going go on meanwhile — and every one that settles while it
      // thinks waits for ONE next turn, not a turn each.
      const settledTasks = leadAfter.splice(0);
      if (settledTasks.length) {
        await leadTurn(team, settledTasks, source, () => new Set(inFlight.keys()), () => starting.size);
        continue;
      }
      const battery = await onBatteryPower();
      if (battery !== onBattery && plannedSlots > 1) {
        bus.send(SYSTEM, { type: "note", text: battery ? "The box is on battery: one worker at a time until it is plugged in again." : "The box is plugged in again: workers run side by side as planned." });
      }
      onBattery = battery;
      // Never more tasks in flight than the owner lets runs go at once, read
      // again each round: each task in flight holds one run at a time (its
      // worker, then its reviewer), so a task whose worker just settled keeps
      // the seat its reviewer needs — the team's next worker cannot take it —
      // and a worker's CPU share is for the runs that can really go together.
      const slots = Math.min(teamWorkerCap(plannedSlots, onBattery), await getMaxParallelRuns());
      team.workerSlots = slots;
      const ready = readyTasks(board).filter((t) => !inFlight.has(t.task_id));
      let waitingForRoom = false;
      // The worker this round leaves waiting for room, said on the board.
      let roomWait = spawnRefusals.splice(0).pop() ?? null;
      if (roomWait) waitingForRoom = true;
      for (const task of roomWait ? [] : ready) {
        if (inFlight.size >= slots) break;
        // Every worker asks, the first one too: the box is shared with runs
        // that are not the team's, and they may hold every slot. A worker
        // whose worktree is still being added has no persisted run yet, and
        // the reservation is how the look sees it.
        const slot = await teamSpawnSlot({ id: board.id, role: "worker", taskId: task.task_id }, starting.size);
        if (!slot.ok) {
          waitingForRoom = slot.wait;
          if (slot.wait) roomWait = { taskId: task.task_id, reason: slot.reason };
          // A refusal that is not "wait" goes on the board, or the team ends
          // with "never ran" and no why.
          else bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `No worker for ${task.task_id}: ${slot.reason}` });
          break;
        }
        starting.add(task.task_id);
        const work = workTask(team, task, source, starting, () => starting.delete(task.task_id))
          .then((settled) => {
            if (typeof settled === "object") {
              spawnRefusals.push({ taskId: task.task_id, reason: settled.room });
              return;
            }
            // Accepted, rejected or failed alike: the plan may need a look.
            if (settled && board.dynamic) leadAfter.push(task.task_id);
          })
          .catch((err) => {
            bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Task ${task.task_id} could not be worked: ${err instanceof Error ? err.message : String(err)}` });
          })
          .finally(() => { starting.delete(task.task_id); inFlight.delete(task.task_id); });
        inFlight.set(task.task_id, work);
      }
      setWorkerSlotWait(team, roomWait);
      if (inFlight.size === 0) {
        if (isExhausted(board)) {
          // Every task is in. Before the team may say "done", the project's
          // own tests on the merged result: red, the tasks the failure points
          // at go back for their normal re-attempt — once — and the loop goes
          // on (the lead, when there is one, looks first); red again, the team
          // fails with the failing tests named.
          if (allComplete(board)) {
            const gate = await suiteGate(team, suiteRounds++ === 0);
            if (team.stopRequested) break;
            if (gate.reoffered.length) {
              if (board.dynamic) leadAfter.push(...gate.reoffered);
              continue;
            }
            suiteFailed = gate.failed;
            suitePassed = gate.passed;
          }
          break;
        }
        if (!waitingForRoom) break;
        await sleep(ROOM_POLL_MS);
        continue;
      }
      // Something is working: wake on the first settle, or after a while to
      // try for another slot (memory frees up as a worker ends).
      await Promise.race([...inFlight.values(), sleep(SLOT_WAIT_MS)]);
    }
    await Promise.allSettled([...inFlight.values()]);
    if (team.stopRequested) return;
    if (isSettledStatus(board.status)) return;
    if (suiteFailed) {
      setTeamStatus(board, SYSTEM, "failed", suiteFailed);
      saveBoard(board);
      return;
    }

    // 3. The review over the merged result, when the planner asked for ONE
    //    rather than one per task — and only for work that is all there. Once:
    //    a CI round's fix is judged by the checks it was made for.
    if (allComplete(board) && board.shape?.review === "final" && !board.finalReview) {
      const verdict = await finalReview(team, source, suitePassed);
      if (team.stopRequested || isSettledStatus(board.status)) return;
      if (verdict?.verdict === "rejected") {
        setTeamStatus(board, SYSTEM, "failed", `The final review rejected the merged work: ${verdict.notes}`);
        saveBoard(board);
        return;
      }
    }

    // 4. The pull request the goal asks for — or, the way a single run
    //    publishes its work, the one the owner's pull-request switch asks
    //    for (read now, as a single run reads it when its own opens): workers
    //    never push, and a finished team left its work on a local branch
    //    (night run, 2026-10-29). Only once every task is accepted, the suite
    //    is green and the final review passed.
    if (!board.branch || !allComplete(board)) break;
    if (!asksPr && !board.pr && !(await getAutoPr())) break;
    const pr = await teamPullRequest(team, asksPr);
    if (pr === null || team.stopRequested) return;
    if (pr.kind === "reoffered") {
      if (board.dynamic) leadAfter.push(...pr.tasks);
      setTeamStatus(board, SYSTEM, "working", `Fixing what failed on pull request #${board.pr?.number ?? "?"}`);
      saveBoard(board);
      continue;
    }
    if (pr.kind === "failed") {
      // Published because the switch is on, not because the goal asked: what
      // became of it is said, and the team's accepted work is still done.
      if (!asksPr) {
        bus.send(SYSTEM, { type: "note", text: `${pr.detail} The work stays on ${board.branch}.` });
        break;
      }
      setTeamStatus(board, SYSTEM, "failed", pr.detail);
      saveBoard(board);
      return;
    }
    break;
  }

  // 5. The verdict on the team.
  if (allComplete(board)) {
    setTeamStatus(board, SYSTEM, "done");
  } else {
    const failed = board.tasks.filter((t) => t.status === "failed" || t.status === "rejected").map((t) => t.task_id);
    // A task that never ran is said with what it waited on: a dependency that
    // never got accepted is the whole reason, and "never ran" alone hid it.
    const blocked = board.tasks.filter((t) => t.status === "pending").map((t) => {
      const on = blockedBy(board, t);
      return on.length ? `${t.task_id} (waiting on ${on.map((d) => `${d.task_id}, ${d.status}`).join("; ")})` : t.task_id;
    });
    setTeamStatus(board, SYSTEM, "failed", `Tasks ${failed.join(", ") || "none"} failed${blocked.length ? `; ${blocked.join(", ")} never ran` : ""}.`);
  }
  saveBoard(board);
}

/**
 * A plan of ONE task — or of tasks that mostly touch the same files
 * (`overlap`, the share `teamAdvice` measured) — run as what it is: one
 * ordinary run in the project —
 * its own worktree and branch, the owner's review pass, deliverable check and
 * pull request, exactly as if the assistant had asked for a single run —
 * rather than the team's branch, a worker's worktree and a reviewer run around
 * one run's worth of work. The board follows it: the task is assigned to the
 * run, its result and outcome are relayed in its name, and the team settles
 * with it. The run is NOT a team run (no `team` on its record), so nothing
 * about how it settles differs from any other run the owner has seen.
 *
 * A box already running every run the owner allows makes it WAIT for a slot,
 * as a worker waits for room, up to the run budget — never fail for being
 * asked at a busy moment.
 */
async function runAsSingleRun(team: LiveTeam, tasks: readonly TeamTask[], source: CodingRunSource, overlap: number | null): Promise<void> {
  const { board, bus } = team;
  const [first] = tasks;
  const what = tasks.length === 1 ? "the plan's one task" : "the plan's tasks";
  board.singleRun = true;
  bus.send(SYSTEM, overlap === null
    ? { type: "note", task_id: first.task_id, text: "The plan has one task, so it runs as one ordinary run — no team branch, worktree or reviewer run around it; the run settles the owner's usual way." }
    : { type: "note", text: `${overlap}% of the files this plan's tasks name are named by another task too: side by side they would only conflict, so its ${tasks.length} tasks run as one ordinary run, in order — no team branch, worktrees or reviewer runs around it; the run settles the owner's usual way.` });
  setTeamStatus(board, SYSTEM, "working");
  saveBoard(board);

  let run: CodingRun | null = null;
  const waitingSince = Date.now();
  const who = { role: "worker" as const, taskId: first.task_id };
  while (!run) {
    if (team.stopRequested) return;
    try {
      run = await startRun({
        task: singleRunTask(board, tasks),
        projectId: board.projectId,
        directory: board.directory,
        source,
        extraBrief: repoMapBrief(board, null),
      });
    } catch (err) {
      if (err instanceof SlotsFullError && Date.now() - waitingSince < RUN_BUDGET_MS) {
        noteSlotWait(team, who, err.message);
        await sleep(SLOT_WAIT_MS);
        continue;
      }
      setTeamStatus(board, SYSTEM, "failed", `The run for ${what} could not start: ${err instanceof Error ? err.message : String(err)}`);
      saveBoard(board);
      return;
    }
  }
  clearSlotWait(team, who);
  const me = worker(run.id);
  for (const task of tasks) bus.send(SYSTEM, { type: "assign", task_id: task.task_id, worker_id: run.id });
  board.runs.push(castRef(run, "worker", first.task_id));
  saveBoard(board);
  for (const task of tasks) bus.send(me, { type: "status_update", task_id: task.task_id, status: "in_progress", worker_id: run.id });

  const settled = await settle(team, run.id);
  if (team.stopRequested) return;
  const ok = settled?.status === "completed";
  const result = settled?.summary?.trim() || settled?.error || (ok ? "(no summary)" : `The run ended ${settled?.status ?? "without a record"}.`);
  for (const task of tasks) {
    bus.send(me, { type: "result", task_id: task.task_id, result, worker_id: run.id });
    bus.send(me, { type: "status_update", task_id: task.task_id, status: ok ? "complete" : "failed", worker_id: run.id });
    if (ok) {
      bus.send(REVIEWER, { type: "review", task_id: task.task_id, verdict: "accepted", notes: "Ran as a single run: the run's own settle judged it — the owner's review pass, deliverable check and pull request, when switched on." });
    }
  }
  if (allComplete(board)) setTeamStatus(board, SYSTEM, "done");
  else setTeamStatus(board, SYSTEM, "failed", `The run for ${what} did not finish: ${settled?.error ?? settled?.status ?? "no run"}.`);
  saveBoard(board);
}

/**
 * One task's worker, from worktree to verdict. `starting` is the
 * orchestrator's live set of worker launches not persisted yet, handed on to
 * this task's reviewer; `onStarted` is called once the worker's run is
 * persisted — the reservation it held is released there.
 * True when a worker ran and its outcome is on the board (accepted, rejected
 * or failed); false when the team was stopped before that; `room` when the
 * spawn refused it for room — the task is still pending, unstarted.
 */
async function workTask(team: LiveTeam, task: TeamTask, source: CodingRunSource, starting: ReadonlySet<string>, onStarted?: () => void): Promise<boolean | { room: string }> {
  const { board, bus } = team;

  // Its own worktree and branch, when the team has a branch to fork from.
  let directory = board.directory;
  let worktree: { path: string; branch: string } | null = null;
  if (board.branch) {
    const made = await addWorkerWorktree(board.directory, board.id, task.task_id, task.attempts + 1);
    if (!made.ok) throw new Error(`No worktree for ${task.task_id}: ${made.detail}`);
    worktree = { path: made.path, branch: made.branch };
    directory = made.path;
  }
  // The owner may have stopped the team while the worktree was being made:
  // a run started now would have no id on the team yet, so Stop could not
  // reach it. Nothing starts; the worktree goes back. So may a dependency
  // have been reopened meanwhile (`holdDependents`): the task was picked as
  // ready and is not any more, and it waits again — unstarted, nothing lost.
  if (team.stopRequested) {
    if (worktree) await removeWorktree(board.directory, worktree.path);
    return false;
  }
  const current = board.tasks.find((t) => t.task_id === task.task_id);
  if (!current || current.status !== "pending" || waitingOn(board, current).length > 0) {
    if (worktree) await removeWorktree(board.directory, worktree.path, { dropBranch: worktree.branch });
    return false;
  }

  // A bulk task's worker starts on the bulk role's provider and model — while
  // that provider can run. When it cannot, the task is still worked, by an
  // ordinary worker, and the board says why.
  let bulk = current.role === "bulk" && await bulkMayRun(team, task.task_id);
  const startWorker = (asBulk: boolean) => startRun({
    task: workerTask(board, task, worktree?.path ?? null),
    projectId: worktree ? null : board.projectId,
    directory,
    source,
    team: { id: board.id, role: "worker", taskId: task.task_id, ...(asBulk ? { bulk: true } : {}) },
    extraBrief: withRepoMap(WORKER_BRIEF, board, worktree?.path ?? null),
    cpuShare: team.workerSlots,
  });
  let run: CodingRun;
  try {
    try {
      run = await startWorker(bulk);
    } catch (err) {
      // Its account went away between the look and the spawn: the same fallback.
      if (!bulk || !(err instanceof CodingAgentError) || err.kind !== "not_ready") throw err;
      bulk = false;
      bus.send(SYSTEM, { type: "note", task_id: task.task_id, text: bulkFallbackText(task.task_id, err.message) });
      run = await startWorker(false);
    }
  } catch (err) {
    // Refused for ROOM at the spawn: a start of someone else's took the slot
    // the look had seen. Not a failure of the task — nothing ran — so no
    // alert: its worktree and branch go back, and it waits for the next look.
    if (err instanceof CodingAgentError && err.wait) {
      if (worktree) await removeWorktree(board.directory, worktree.path, { dropBranch: worktree.branch });
      return { room: err.message };
    }
    if (worktree) await removeWorktree(board.directory, worktree.path);
    throw err;
  }
  onStarted?.();
  const me = worker(run.id);
  bus.send(SYSTEM, { type: "assign", task_id: task.task_id, worker_id: run.id });
  const row = board.tasks.find((t) => t.task_id === task.task_id);
  if (row) { row.worktree = worktree?.path ?? null; row.branch = worktree?.branch ?? null; row.reviewRunId = null; }
  board.runs.push(castRef(run, "worker", task.task_id));
  saveBoard(board);
  bus.send(me, { type: "status_update", task_id: task.task_id, status: "in_progress", worker_id: run.id });

  const settled = await settle(team, run.id);
  if (team.stopRequested) {
    if (worktree) await removeWorktree(board.directory, worktree.path);
    return false;
  }
  // HELD while it worked: a dependency was reopened under it and its worker
  // stopped. Nothing of it is merged — it was built on work that does not
  // stand — and the task goes back to wait for that dependency, the attempt
  // counted as a hold rather than against it.
  const held = team.held.get(task.task_id);
  if (held) {
    team.held.delete(task.task_id);
    if (worktree) await removeWorktree(board.directory, worktree.path);
    bus.send(SYSTEM, { type: "hold", task_id: task.task_id, dependency: held.dependency, reason: held.reason });
    return true;
  }
  const ok = settled?.status === "completed";
  let result = settled?.summary?.trim() || settled?.error || (ok ? "(no summary)" : `The run ended ${settled?.status ?? "without a record"}.`);

  // What the worker wrote and removed again before it settled — a probe page a
  // verifier made and deleted (bench, 2026-09-26) — is looked for now, while
  // its worktree is still there to look in.
  const vanished = settled ? vanishedFiles(settled.directory, settled.filesTouched) : new Set<string>();

  // The worker's commits come home. A merge git cannot do alone is not
  // guessed at: the task is REJECTED with the conflict named and offered
  // once more, and the next attempt starts from the merged state.
  let files: string[] = settled?.filesTouched ?? [];
  let fromBranch = false;
  let mergeRefusal: string | null = null;
  if (ok && settled?.commitError) {
    // The runner could not commit the worker's work — in a worktree there
    // is then nothing on the branch to merge, and in the project itself
    // (a code project, no team branch) the next worker would build on
    // uncommitted files. Rejected with the reason, offered once more,
    // whichever way the worker ran.
    mergeRefusal = `NOT COMMITTED: ${firstLine(settled.commitError, 300)}`;
    result = `${result}\n\n${mergeRefusal}`;
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Commit failed for ${task.task_id} (${run.id}): ${firstLine(settled.commitError, 200)}` });
  }
  if (worktree) {
    if (mergeRefusal) {
      // Nothing to merge; the worktree goes back below.
    } else if (ok) {
      // What the branch changed. A branch that came home EMPTY is harvested
      // before it is judged: what the worker left uncommitted in its
      // worktree goes on its branch, in the runner's own message shape —
      // the worktree is removed below, and its files with it (team-v0wcl4mj,
      // 2026-09-26: a worker's two files were never committed, the empty
      // branch was accepted by rule, and three tasks built against nothing).
      let diffed = await changedFiles(board.directory, worktree.branch);
      if (!diffed.length) {
        const harvested = await harvestWorktree(worktree.path, buildCommitMessage({ runId: run.id, task: settled.task, summary: settled.summary }));
        if (!harvested.ok) {
          mergeRefusal = `NOT COMMITTED: ${firstLine(harvested.detail, 300)}`;
          result = `${result}\n\n${mergeRefusal}`;
          bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Commit failed for ${task.task_id} (${run.id}): ${firstLine(harvested.detail, 200)}` });
        } else if (harvested.files.length) {
          const n = harvested.files.length;
          bus.send(SYSTEM, { type: "note", task_id: task.task_id, text: `Committed ${n} uncommitted file(s) the worker left behind (${run.id}): ${harvested.files.slice(0, 5).join(", ")}${n > 5 ? ", …" : ""}` });
          diffed = await changedFiles(board.directory, worktree.branch);
        }
      }
      if (!mergeRefusal) {
        // What it touched uncommitted is still what it touched.
        if (diffed.length) { files = diffed; fromBranch = true; }
        // An empty branch is judged by what the worker's own run says it
        // wrote in its worktree, never by the files its task names: a task
        // that only verifies, reviews or confirms names the files it READS,
        // and was rejected twice for an empty branch with every deliverable
        // on disk (bench, 2026-09-26, t5). What it wrote counts only where
        // git could have taken it: a scratch file it deleted, or a log the
        // project ignores, went missing from nowhere.
        const written = diffed.length ? [] : writtenFiles(settled.filesTouched ?? [], worktree.path);
        const missing = written.length ? await committableFiles(worktree.path, written) : [];
        if (missing.length) {
          mergeRefusal = NO_CHANGE;
          result = `${result}\n\n${NO_CHANGE}`;
          bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `No change from ${task.task_id} (${run.id}): its branch has no commit, though the worker wrote ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}` });
        } else {
          const merged = await mergeWorkerBranch(board.directory, worktree.branch, `Coding team ${board.id}: ${task.task_id} — ${firstLine(task.task_description, 72)}`);
          if (!merged.ok) {
            mergeRefusal = `${merged.conflict ? "MERGE CONFLICT" : "MERGE FAILED"}: ${firstLine(merged.detail, 300)}`;
            result = `${result}\n\n${mergeRefusal}`;
            // Workers side by side touch the same lines: a conflict is offered
            // again from the merged state, not the team going wrong.
            if (merged.conflict) team.uncountedAlerts += 1;
            bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `${merged.conflict ? "Merge conflict" : "Merge failed"} for ${task.task_id} (${run.id}): ${firstLine(merged.detail, 200)}` });
          } else if (!diffed.length) {
            // Nothing written, nothing left behind: a legitimate no-change
            // task, which goes on as it did before the rejection existed.
            bus.send(SYSTEM, { type: "note", task_id: task.task_id, text: `${task.task_id} changed no files (${run.id}): its branch is empty and its run wrote nothing git could commit.` });
          }
        }
      }
    }
    await removeWorktree(board.directory, worktree.path);
  }
  bus.send(me, { type: "result", task_id: task.task_id, result, worker_id: run.id });
  bus.send(me, { type: "status_update", task_id: task.task_id, status: ok ? "complete" : "failed", worker_id: run.id });
  if (mergeRefusal) {
    // Never accepted by rule, whatever the review mode: nothing of it was merged.
    const notes = mergeRefusal === NO_CHANGE
      ? NO_CHANGE
      : `${mergeRefusal} The work could not be ${mergeRefusal.startsWith("NOT COMMITTED") ? "committed" : "merged"}; redo the task on the current files.`;
    bus.send(REVIEWER, { type: "review", task_id: task.task_id, verdict: "rejected", notes });
    return true;
  }

  // Guardrails: what the worker did, against what it was asked. A worker
  // whose every refusal only LOOKED — a Glob of the project path from inside
  // its worktree, a `ps` — changed nothing: a note, not an alert, and the
  // task stays clean (bench, 2026-09-22/23: such refusals rejected merged,
  // correct work and failed teams on the alert ceiling). So did a refused
  // WRITE outside its folders — a check script in /tmp (bench, 2026-09-23):
  // the refusal is the proof. So did one the runner answered with a retry
  // hint — a read OR a write aimed at `<project>/<rel>` from the worktree,
  // where `<worktree>/<rel>` is (bench, 2026-09-23: a team failed on those
  // with every deliverable on disk): the write stays refused, the worker was
  // told where to retry, and the review judges what it made. A refused write
  // inside the worktree or the project is still an alert, and so is a refused
  // look into — or write to — the harness's own state, except the run's OWN
  // corner of it: its project's memory folder, which the harness itself
  // points it at (bench, 2026-09-26: a worker's `ls` there rejected correct,
  // verified work). Every refusal is judged by its whole text where the record
  // keeps one, so a long read-only probe is not an alert for its length. Only
  // when every refusal is judged: the run keeps the first few, and one it did
  // not keep may have been a write — unless the runner counted it among the
  // hinted ones.
  let refusedWrite = false;
  // A file it removed again merged nothing: judged by what it left. The
  // branch's own diff is what merged, a deletion it names included.
  const leftBehind = fromBranch ? files : files.filter((f) => !vanished.has(f));
  const strayed = settled ? outsideHint(leftBehind, task.files_hint) : [];
  if (settled) {
    if (settled.permissionDenials > 0) {
      const n = settled.permissionDenials;
      const folders = worktree ? [worktree.path, board.directory] : [board.directory];
      const outsideWrite = (a: string) => outsideFolderWriteDenial(a, folders);
      const own = { stateDir: harnessStateDir(settled.provider), folders: [settled.directory, ...folders], sessionId: settled.sessionId };
      // Each refusal on the record, with where the runner pointed the worker
      // instead; a record from before the structured list has its strings.
      const kept: Array<{ text: string; fullText?: string; worktreePath?: string }> = settled.denials?.length ? settled.denials : settled.deniedActions.map((text) => ({ text }));
      // Judged by all of it; named, below, by the cut the owner reads.
      const whole = (d: { text: string; fullText?: string }) => d.fullText ?? d.text;
      const hinted = kept.filter((d) => d.worktreePath);
      const others = kept.filter((d) => !d.worktreePath);
      const hintedCount = Math.max(settled.worktreeHints ?? 0, hinted.length);
      const judged = kept.length + (hintedCount - hinted.length) >= n;
      const harness = kept.some((d) => harnessStateDenial(whole(d)) && !ownHarnessStateDenial(whole(d), own));
      if (judged && !harness && others.every((d) => readOnlyDenial(whole(d)) || outsideWrite(whole(d)))) {
        const rest = others.length === 0 ? "" : others.every((d) => readOnlyDenial(whole(d))) ? "read-only" : "reads, or writes";
        const what = hintedCount > 0
          ? `action(s) that changed nothing — ${hintedCount} aimed at the project instead of its worktree, each answered with a retry hint at the worktree path${rest ? `; the rest ${rest} outside its folder` : ""}`
          : rest === "read-only" ? "read-only action(s) outside its folder" : "action(s) that changed nothing — reads, or writes outside its folder";
        const named = [...others.map((d) => d.text), ...hinted.map((d) => `${d.text} → ${d.worktreePath}`)].slice(0, 3).join("; ");
        bus.send(SYSTEM, { type: "note", task_id: task.task_id, text: `Worker ${run.id} was refused ${n} ${what}: ${named}`, read_only_refusals: n });
      } else {
        refusedWrite = true;
        // Refused is stopped: the task is rejected and offered once more,
        // and the refusal itself never counts toward the ceiling.
        team.uncountedAlerts += 1;
        const named = [...others.map((d) => d.text), ...hinted.map((d) => d.text)].slice(0, 3).join("; ");
        bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Worker ${run.id} was refused ${n} action(s): ${named}` });
      }
    }
    if (strayed.length) {
      bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Worker ${run.id} touched files outside its task: ${strayed.slice(0, 5).join(", ")}` });
    }
  }

  // The review loop: the rule first (v0 — a refused write or a stray file is a
  // rejection without a model), then the REVIEWER, a read-only run on the
  // merged work that answers a verdict. A review that was not done is not
  // an acceptance: a garbled answer falls back to the rule with an alert.
  // The planner's shape may ask for no reviewer here: `final` has one look
  // at the merged whole at the end, `none` trusts the rule alone.
  if (ok) {
    const clean = settled && !refusedWrite && strayed.length === 0;
    if (!clean) {
      bus.send(REVIEWER, { type: "review", task_id: task.task_id, verdict: "rejected", notes: "The worker was refused an action or strayed outside its files; the task is offered once more." });
      return true;
    }
    const mode: ReviewMode = board.shape?.review ?? "each";
    if (mode !== "each") {
      bus.send(REVIEWER, {
        type: "review",
        task_id: task.task_id,
        verdict: "accepted",
        notes: mode === "final" ? "Accepted by rule; the team's final review checks the merged result." : "Accepted by rule: the plan asked for no reviewer run.",
      });
      return true;
    }
    const verdict = await reviewTask(team, task, source, { files, report: result }, starting);
    if (team.stopRequested) return false;
    // Held while the reviewer read it: the verdict is on a result already set aside.
    if (!underReview(board, task.task_id)) return true;
    bus.send(REVIEWER, { type: "review", task_id: task.task_id, ...verdict });
  }
  return true;
}

/**
 * The reviewer's run and its verdict; the rule's acceptance when the run cannot say.
 *
 * A reviewer refused for ROOM — the team's slots are full, the memory guard
 * says not yet — WAITS for it, asking again every few seconds up to the run
 * budget: room frees as a sibling settles. Accepting by rule there skipped
 * the review of a task that only finished at a busy moment, and its alert
 * helped fail a team whose work was all verified (bench, 2026-09-22). Only a
 * refusal that cannot clear on its own — the switch off, an account that
 * cannot run — is "no reviewer": accepted by rule, with an alert the
 * ceiling does not count. Runs that are not the team's are room taken, and
 * waited out like any other.
 *
 * `starting` is the orchestrator's live set of worker launches: a sibling
 * whose worktree is still being added has no persisted run, and without its
 * reservation the memory guard would see no run going and let the reviewer
 * take the headroom that worker was dispatched against.
 */
async function reviewTask(team: LiveTeam, task: TeamTask, source: CodingRunSource, work: { files: string[]; report: string }, starting: ReadonlySet<string>): Promise<{ verdict: "accepted" | "rejected"; notes: string }> {
  const { board, bus } = team;
  const role: RunTeam = { id: board.id, role: "reviewer", taskId: task.task_id };
  // `resumeOf` names the reviewer run whose own session a re-ask continues
  // (verdictOf); `shell` is the review offered once more with a shell, in a
  // throwaway worktree of the merged work, after a first one that ran nothing.
  const start = async (resumeOf: string | null, shell?: { folder: string; said: string }): Promise<CodingRun | { reason: string; wait: boolean }> => {
    // The orchestrator's own look first, as for a worker; the spawn asks
    // again, and a refusal there that is still about room is the same wait.
    // The reservations are read on every ask: a launch lands while we wait.
    const room = await teamSpawnSlot(role, starting.size);
    if (!room.ok) return room;
    // The reviewer works in the project, on the merged work: a path the worker
    // wrote in its worktree — gone by now — is said in the project instead.
    const here = (text: string) => toFolderPaths(text, board.directory, shell?.folder ?? board.directory);
    const review = () => reviewerTask({ taskId: task.task_id, description: here(task.task_description), files: work.files, report: here(work.report), goal: board.goal });
    const brief = shell ? withRepoMap(SHELL_REVIEWER_BRIEF, board, shell.folder) : withRepoMap(REVIEWER_BRIEF, board, null);
    const readOnly = shell ? {} : { readOnly: true };
    try {
      return await startRun(resumeOf
        ? { task: REVIEWER_NUDGE, resumeRunId: resumeOf, source, team: role, ...readOnly, extraBrief: brief }
        : {
          task: shell ? shellReviewerTask(review(), shell.said) : review(),
          projectId: shell ? null : board.projectId,
          directory: shell?.folder ?? board.directory,
          source,
          team: role,
          ...readOnly,
          extraBrief: brief,
        });
    } catch (err) {
      return { reason: err instanceof Error ? err.message : String(err), wait: err instanceof CodingAgentError && err.wait };
    }
  };
  // A started run, or why none could start; null once the team is stopped.
  const launch = async (resumeOf: string | null, shell?: { folder: string; said: string }): Promise<CodingRun | { reason: string } | null> => {
    const waitingSince = Date.now();
    try {
      for (;;) {
        if (team.stopRequested) return null;
        const started = await start(resumeOf, shell);
        if ("id" in started) return started;
        if (!started.wait) return { reason: started.reason };
        if (Date.now() - waitingSince >= RUN_BUDGET_MS) {
          return { reason: `no room for ${Math.round(RUN_BUDGET_MS / 60_000)} minutes (${started.reason})` };
        }
        noteSlotWait(team, role, started.reason);
        await sleep(ROOM_POLL_MS);
      }
    } finally {
      clearSlotWait(team, role);
    }
  };
  const noReviewer = (reason: string): { verdict: "accepted"; notes: string } => {
    team.uncountedAlerts += 1;
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `No reviewer for ${task.task_id}: ${reason}` });
    return { verdict: "accepted", notes: "Accepted by rule: the reviewer could not start." };
  };

  const run = await launch(null);
  // Never posted: the caller drops the verdict of a stopped team.
  if (run === null) return { verdict: "accepted", notes: "The team was stopped before the review." };
  if (!("id" in run)) return noReviewer(run.reason);
  const row = board.tasks.find((t) => t.task_id === task.task_id);
  if (row) row.reviewRunId = run.id;
  board.runs.push(castRef(run, "reviewer", task.task_id));
  saveBoard(board);
  const settled = await settle(team, run.id);
  // Held meanwhile (`holdDependents` stops its reviewer too): nothing to rule on, and nothing to alert about.
  const dropped = { verdict: "accepted" as const, notes: "The task was held during its review." };
  if (!underReview(board, task.task_id)) return dropped;
  if (settled?.status !== "completed") {
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `The reviewer of ${task.task_id} (${run.id}) ended ${settled?.status ?? "without a record"}.` });
    return { verdict: "accepted", notes: "Accepted by rule: the reviewer did not finish." };
  }
  const answer = await verdictOf(team, settled, `The reviewer of ${task.task_id}`, task.task_id, launch);
  if (answer === null) return { verdict: "accepted", notes: "The team was stopped during the review." };
  if (!underReview(board, task.task_id)) return dropped;
  if (!answer.ok) {
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: answer.alert });
    return { verdict: "accepted", notes: `Accepted by rule: ${answer.reason}` };
  }
  // A verdict that says it ran nothing is not a review (night run, 2026-10-29:
  // "Static review only: no git, Biome or Jest could be run" was an
  // acceptance). Offered ONCE more with a shell, in a throwaway worktree of the
  // merged work; nothing run then either, the worker's own test evidence is
  // the only way in — labelled NOT REVIEWED — and without it the task goes back.
  const first = answer.verdict;
  if (!ranNothing(first.notes)) return first;
  bus.send(SYSTEM, { type: "note", task_id: task.task_id, text: `Not reviewed: the reviewer of ${task.task_id} (${run.id}) could not run git or the tests — it said ${answerHead(first.notes)}.${board.branch ? " Offering the review once more, with a shell in a checkout of the merged work." : ""}` });
  const second = board.branch ? await reviewWithShell(team, task, first.notes, launch) : null;
  if (team.stopRequested) return { verdict: "accepted", notes: "The team was stopped during the review." };
  if (!underReview(board, task.task_id)) return dropped;
  if (second && !ranNothing(second.notes)) return second;
  const evidence = testEvidence(work.report);
  if (evidence) return { verdict: "accepted", notes: `${NOT_REVIEWED}: accepted on the worker's own test evidence ("${evidence}"); no reviewer could run git or the tests.` };
  return { verdict: "rejected", notes: `${NOT_REVIEWED}: no reviewer could run git or the tests, and the worker's report shows no test run. Do the task again, run its tests and quote their result in your final message.` };
}

/**
 * The review offered once more, WITH a shell: a reviewer run that is not
 * read-only, in a throwaway worktree of the team's branch as it stands, where
 * it can run git and the task's checks — removed afterwards with its branch,
 * nothing of it merged. Its verdict, or null when it could not be had (said on
 * the board) or the team was stopped.
 */
async function reviewWithShell(
  team: LiveTeam,
  task: TeamTask,
  said: string,
  launch: (resumeOf: string | null, shell?: { folder: string; said: string }) => Promise<CodingRun | { reason: string } | null>,
): Promise<Verdict | null> {
  const { board, bus } = team;
  const made = await addWorkerWorktree(board.directory, board.id, `review-${task.task_id}`, task.attempts);
  if (!made.ok) {
    bus.send(SYSTEM, { type: "note", task_id: task.task_id, text: `No checkout for the second review of ${task.task_id}: ${firstLine(made.detail, 200)}` });
    return null;
  }
  const shell = { folder: made.path, said };
  try {
    const run = await launch(null, shell);
    if (run === null) return null;
    if (!("id" in run)) {
      bus.send(SYSTEM, { type: "note", task_id: task.task_id, text: `The second review of ${task.task_id} could not start: ${firstLine(run.reason, 200)}` });
      return null;
    }
    const row = board.tasks.find((t) => t.task_id === task.task_id);
    if (row) row.reviewRunId = run.id;
    board.runs.push(castRef(run, "reviewer", task.task_id));
    saveBoard(board);
    const settled = await settle(team, run.id);
    if (team.stopRequested || !underReview(board, task.task_id)) return null;
    if (settled?.status !== "completed") {
      bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `The second reviewer of ${task.task_id} (${run.id}) ended ${settled?.status ?? "without a record"}.` });
      return null;
    }
    const answer = await verdictOf(team, settled, `The second reviewer of ${task.task_id}`, task.task_id, (id) => launch(id, shell));
    if (answer === null) return null;
    if (!answer.ok) {
      bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: answer.alert });
      return null;
    }
    return answer.verdict;
  } finally {
    await removeWorktree(board.directory, made.path, { dropBranch: made.branch });
  }
}

/**
 * The verdict in a finished reviewer's answer, asked for ONCE more when the
 * answer carries no JSON object at all (TASK-1323). On the bench the
 * reviewer had done its review and only its closing words lacked the
 * object, and every such answer cost the team an alert and an acceptance by
 * rule. The re-ask continues the reviewer's own session with
 * `REVIEWER_NUDGE`, under the same budget as the review (`settle`), and is a
 * note on the board, never an alert; only a second answer without the
 * object is the alert, quoting how that answer began — or, when the re-ask
 * could not start or did not finish, how the first one did. An object that is
 * there but wrong is what the reviewer said: the alert at once, as before.
 *
 * `who` names the reviewer the way the board does; `reask` starts the
 * follow-up run on the settled one's id. Null once the team is stopped.
 */
async function verdictOf(
  team: LiveTeam,
  settled: CodingRun,
  who: string,
  taskId: string | null,
  reask: (runId: string) => Promise<CodingRun | { reason: string } | null>,
): Promise<{ ok: true; verdict: Verdict } | { ok: false; reason: string; alert: string } | null> {
  const { board, bus } = team;
  const first = settled.resultText ?? settled.summary;
  const parsed = parseVerdict(first);
  if (parsed.ok) return parsed;
  if (!parsed.missing) return { ok: false, reason: parsed.reason, alert: `${who} gave no verdict: ${parsed.reason}` };
  if (team.stopRequested) return null;
  bus.send(SYSTEM, { type: "note", ...(taskId ? { task_id: taskId } : {}), text: `${who} answered without a JSON verdict; asking it once more for the verdict alone. It answered: ${answerHead(first)}` });
  const again = await reask(settled.id);
  if (again === null) return null;
  // A re-ask that came to nothing leaves the first answer as the only clue, so
  // the alert quotes it too — last, so the board's cut of a long alert takes
  // the quote's tail, never what became of the re-ask.
  const said = first?.trim() ? ` It had answered: ${answerHead(first)}` : "";
  if (!("id" in again)) {
    return { ok: false, reason: parsed.reason, alert: `${who} gave no verdict: ${parsed.reason} Asked once more, it could not start: ${again.reason.trim().replace(/\.+$/, "")}.${said}` };
  }
  board.runs.push(castRef(again, "reviewer", taskId));
  saveBoard(board);
  const resettled = await settle(team, again.id);
  if (team.stopRequested) return null;
  if (resettled?.status !== "completed") {
    return { ok: false, reason: parsed.reason, alert: `${who} gave no verdict: ${parsed.reason} Asked once more, it (${again.id}) ended ${resettled?.status ?? "without a record"}.${said}` };
  }
  const second = resettled.resultText ?? resettled.summary;
  const reparsed = parseVerdict(second);
  if (reparsed.ok) return reparsed;
  if (!reparsed.missing) return { ok: false, reason: reparsed.reason, alert: `${who} gave no verdict: ${reparsed.reason}` };
  // Worded short: an alert is one line of 300 characters, and the quote is the point.
  return { ok: false, reason: reparsed.reason, alert: `${who} gave no verdict: asked twice, it answered ${second?.trim() ? `no JSON object — ${answerHead(second)}` : "nothing"}` };
}

/**
 * Review mode `final`: ONE read-only reviewer over the merged result, once
 * every task passed the rule. Its verdict goes on the board either way; a
 * review that could not be done falls back to the rule with an alert, as a
 * task's reviewer does. Null when the team was stopped meanwhile. `tests` is
 * what the project's own suite said when the harness ran it green on this
 * tree (`suiteGate`) — the reviewer may not run it.
 */
async function finalReview(team: LiveTeam, source: CodingRunSource, tests: string | null): Promise<{ verdict: "accepted" | "rejected"; notes: string } | null> {
  const { board, bus } = team;
  setTeamStatus(board, SYSTEM, "reviewing");
  saveBoard(board);
  const byRule = (why: string, alert: string) => {
    bus.send(SYSTEM, { type: "alert", reason: alert });
    const verdict = { verdict: "accepted" as const, notes: `Accepted by rule: ${why}` };
    bus.send(REVIEWER, { type: "final_review", ...verdict });
    return verdict;
  };
  const files = [...new Set(board.tasks.filter((t) => t.status === "complete").flatMap((t) => t.files_hint))];
  const where = { goal: board.goal, branch: board.branch, base: board.base, files, tests };
  let run: CodingRun;
  try {
    run = await startRun({
      // Workers' worktree paths in their results said in the project, where this reviewer reads: never longer.
      task: finalReviewerTask({ ...where, digest: toFolderPaths(boardDigest(board, null, Math.min(MAX_DIGEST_CHARS, finalReviewRoom(where))), board.directory, board.directory) }),
      projectId: board.projectId,
      directory: board.directory,
      source,
      team: { id: board.id, role: "reviewer", taskId: null },
      readOnly: true,
      extraBrief: withRepoMap(FINAL_REVIEWER_BRIEF, board, null),
    });
  } catch (err) {
    return byRule("the final reviewer could not start.", `No final reviewer: ${err instanceof Error ? err.message : String(err)}`);
  }
  board.runs.push(castRef(run, "reviewer", null));
  saveBoard(board);
  const settled = await settle(team, run.id);
  if (team.stopRequested) return null;
  if (settled?.status !== "completed") {
    return byRule("the final reviewer did not finish.", `The final reviewer (${run.id}) ended ${settled?.status ?? "without a record"}.`);
  }
  const reask = async (runId: string): Promise<CodingRun | { reason: string }> => {
    try {
      return await startRun({ task: REVIEWER_NUDGE, resumeRunId: runId, source, team: { id: board.id, role: "reviewer", taskId: null }, readOnly: true, extraBrief: withRepoMap(FINAL_REVIEWER_BRIEF, board, null) });
    } catch (err) {
      return { reason: err instanceof Error ? err.message : String(err) };
    }
  };
  const answer = await verdictOf(team, settled, "The final reviewer", null, reask);
  if (answer === null) return null;
  if (!answer.ok) return byRule(answer.reason, answer.alert);
  bus.send(REVIEWER, { type: "final_review", ...answer.verdict });
  return answer.verdict;
}

/**
 * The project's own test suite on the merged result, once every task is in
 * (TASK-1321; detection and reading in `coding-team-suite.ts`). A team signed
 * off "done" with its own suite red — 11 of 56 failing — because its workers
 * were accepted by rule "since the final review checks the merged result" and
 * the final reviewer is read-only: nobody ran the tests (team-59631zvn,
 * nano-lab1, 2026-09-30). So the harness runs them itself, in the checkout the
 * merges landed in, before the final review and before "done".
 *
 * No suite: nothing on the board, and the team finishes as it always did. A
 * suite that passed, or that could not be judged: one note. A RED suite is a
 * rejection by rule, the failing tests named — while `mayReoffer`, of every
 * task the failure points at (`suiteSuspects`), each offered once more through
 * the ordinary review loop and returned in `reoffered`; after that, or with no
 * task left to offer it to, `failed` holds the words the team fails with.
 * `passed` is what a green suite said, for the final reviewer.
 */
async function suiteGate(team: LiveTeam, mayReoffer: boolean): Promise<{ reoffered: string[]; failed: string | null; passed: string | null }> {
  const { board, bus } = team;
  const nothing = { reoffered: [], failed: null, passed: null };
  const suite = await runProjectSuite(board.directory, suiteSandbox);
  if (team.stopRequested || suite.kind === "none") return nothing;
  if (suite.kind !== "fail") {
    bus.send(SYSTEM, { type: "note", text: suiteNote(suite) });
    return { ...nothing, passed: suite.kind === "pass" ? `${suite.command} — ${suite.summary}` : null };
  }
  const suspects = mayReoffer ? suiteSuspects(board.tasks, suite.files) : [];
  bus.send(SYSTEM, { type: "note", text: suiteNote(suite, suspects.map((t) => t.task_id)) });
  if (!suspects.length) return { ...nothing, failed: suiteFailure(suite) };
  const notes = suiteRejection(suite);
  // Dependents first (a task is always posted after what it depends on): each
  // suspect gets the suite's own rejection, and a dependency rejected after
  // its dependents finds them pending already rather than holding them — a
  // hold is for the dependents the failure did NOT point at (holdDependents).
  for (const task of [...suspects].reverse()) {
    if (!underReview(board, task.task_id)) continue;
    bus.send(REVIEWER, { type: "review", task_id: task.task_id, verdict: "rejected", notes });
  }
  return { ...nothing, reoffered: suspects.map((t) => t.task_id) };
}

/**
 * The LEAD's turn after the workers of `taskIds` settled — every task that
 * settled since its last turn, in the order they did (only on a team started
 * with the `coding_team_dynamic` switch on): one short read-only run — the
 * planner's brief for writing tasks, the REPLAN_BRIEF for what it may do —
 * that reads the goal, the board's digest, those tasks' results and the
 * messages sent to the lead since its last turn, and answers `{ add, retire,
 * note }`. Every accepted change goes through the bus in the planner's name;
 * an answer that is not one, or that breaks a bound, is an alert and the
 * plan stands as it was — never repaired.
 *
 * No run is spent when there is nothing to decide: every task left is
 * complete, the team is stopping, the lead has no add and no retire left, or
 * the batch was accepted clean with no blocker and no message to the lead
 * (`leadShouldRun`) — skipped without a word on the board.
 * `dispatched` names the tasks a worker is going on or being started on —
 * the latter still read pending on the board and must not be retired from
 * under it. `reserved` counts the workers whose run is not persisted yet (a
 * worktree being added): the spawn slot must see them, or the lead could
 * take the seat a worker is seconds from filling.
 */
async function leadTurn(team: LiveTeam, taskIds: string[], source: CodingRunSource, dispatched: () => ReadonlySet<string>, reserved: () => number): Promise<void> {
  const { board, bus } = team;
  if (team.stopRequested || isSettledStatus(board.status)) return;
  if (board.tasks.every((t) => t.status === "complete" || t.status === "retired")) return;
  const room = leadRoom(replanContext(board, dispatched()));
  if (room.adds === 0 && room.retires === 0) return;
  // An unread message calls the lead back once, not after every batch (leadTurnsAt).
  if (!leadShouldRun(board, taskIds, Math.max(board.lastLeadAt, team.leadTurnsAt[0])).run) return;
  // The run is filed under the batch's latest task; the alerts name them all.
  const taskId = taskIds[taskIds.length - 1];
  const after = taskIds.join(", ");
  // What every role runs on now — read for each turn, before the seat is
  // taken: an account connected, or gone, since the plan is what it adds by.
  const models = await readTeamModels();
  // A seat beside the workers still going, and beside whatever else the box
  // runs: the room is waited out the way a worker's is; a refusal that
  // cannot clear by waiting is an alert.
  const lead: RunTeam = { id: board.id, role: "lead", taskId };
  // The inbox is written from what was said up to now; what is said after
  // waits for the next turn. It counts as read only once the lead gave an
  // answer the team can act on (below): a lead that failed, ran out of
  // budget or answered nothing usable leaves it unread — shown to every
  // later turn, and calling the next one back on its own once.
  let writtenAt = Date.now();
  let run: CodingRun | null;
  try {
    run = await startWhenRoom(team, lead, reserved, () => {
      writtenAt = Date.now();
      return startRun({
        task: leadTask(board, taskIds, replanContext(board, dispatched())),
        projectId: board.projectId,
        directory: board.directory,
        source,
        team: lead,
        readOnly: true,
        extraBrief: withTeamModels(REPLAN_BRIEF, models),
      });
    });
  } catch (err) {
    bus.send(SYSTEM, { type: "alert", task_id: taskId, reason: `No lead after ${after}: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (!run) return;
  team.leadTurnsAt = [team.leadTurnsAt[1], writtenAt];
  board.runs.push(castRef(run, "lead", taskId));
  saveBoard(board);
  const settled = await settle(team, run.id);
  if (team.stopRequested) return;
  if (settled?.status !== "completed") {
    bus.send(SYSTEM, { type: "alert", task_id: taskId, reason: `The lead after ${after} (${run.id}) ended ${settled?.status ?? "without a record"}; the plan is unchanged.` });
    return;
  }
  // Read against the board as it is NOW: workers went on while the lead thought.
  const replan = parseReplan(settled.resultText ?? settled.summary, replanContext(board, dispatched()));
  if (!replan.ok) {
    bus.send(SYSTEM, { type: "alert", task_id: taskId, reason: `The lead after ${after} gave no usable answer: ${replan.reason} The plan is unchanged.` });
    return;
  }
  // Saved on its own: an answer of `{}` sends nothing on the bus to save it.
  board.lastLeadAt = writtenAt;
  saveBoard(board);
  for (const id of replan.retire) {
    try {
      bus.send(PLANNER, { type: "retire", task_id: id, reason: replan.note });
    } catch {
      // Refused by the board: already on it as an alert.
    }
  }
  for (const task of replan.add) {
    try {
      bus.send(PLANNER, { type: "task", ...task, origin: "lead", note: replan.note });
    } catch {
      // Refused by the board: already on it as an alert.
    }
  }
  if (replan.clipped) bus.send(SYSTEM, { type: "note", text: clippedNote(replan.clipped) });
}

/** A pause that never keeps the process alive on its own: the loop's timer beside a race it may lose. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Start one of the team's runs once the box has room for it — the planner,
 * a re-asked planner, a lead. Asked first (`teamSpawnSlot`, the workers
 * still being started counted by `reserved`), then the spawn, whose own
 * refusal for room is the same wait: the look and the spawn may race a start
 * of someone else's. It waits as long as it takes, saying so on the board
 * (`noteSlotWait`) — the box frees slots as runs settle, and a team is never
 * failed for being asked at a busy moment. The owner's Stop ends the wait
 * (null). A refusal that cannot clear by waiting — the switch off, an
 * account that cannot run — is thrown, as before.
 */
async function startWhenRoom(team: LiveTeam, who: RunTeam, reserved: () => number, start: () => Promise<CodingRun>): Promise<CodingRun | null> {
  try {
    for (;;) {
      if (team.stopRequested) return null;
      const slot = await teamSpawnSlot(who, reserved());
      if (!slot.ok && !slot.wait) throw new CodingAgentError("busy", slot.reason);
      if (slot.ok) {
        try {
          return await start();
        } catch (err) {
          if (!(err instanceof CodingAgentError) || !err.wait) throw err;
          noteSlotWait(team, who, err.message);
        }
      } else {
        noteSlotWait(team, who, slot.reason);
      }
      await sleep(ROOM_POLL_MS);
    }
  } finally {
    clearSlotWait(team, who);
  }
}

/** "the planner", "the worker of t2", "the lead after t3". */
function slotWaitName(who: Pick<SlotWait, "role" | "taskId">): string {
  if (!who.taskId) return `the ${who.role}`;
  return who.role === "lead" ? `the lead after ${who.taskId}` : `the ${who.role} of ${who.taskId}`;
}

/**
 * On the board: `who` waits for a free slot on the box, and why — what
 * coding_team_status says for a team that waits, rather than a failure. One
 * note when the wait begins, and the board written then. A new reason only
 * updates the entry on the live board, which is what a live team is read
 * from: the memory guard's figure moves on nearly every look, and a board
 * file rewritten every few seconds of a long wait buys nothing.
 */
function noteSlotWait(team: LiveTeam, who: Pick<SlotWait, "role" | "taskId">, reason: string): void {
  const { board, bus } = team;
  // A refusal read after the owner's Stop: nothing of a stopped team waits.
  if (team.stopRequested || isSettledTeamStatus(board.status)) return;
  const waits = board.slotWaits ?? [];
  const at = waits.findIndex((w) => w.role === who.role && w.taskId === who.taskId);
  if (at >= 0) {
    waits[at] = { ...waits[at], reason };
    return;
  }
  waits.push({ role: who.role, taskId: who.taskId, reason, since: Date.now() });
  board.slotWaits = waits;
  bus.send(SYSTEM, { type: "note", ...(who.taskId ? { task_id: who.taskId } : {}), text: `Waiting for a free slot on the box before ${slotWaitName(who)} starts: ${reason}` });
  saveBoard(board);
}

/** `who` waits no more: it started, or never will. */
function clearSlotWait(team: LiveTeam, who: Pick<SlotWait, "role" | "taskId">): void {
  const { board } = team;
  const waits = board.slotWaits;
  if (!waits?.some((w) => w.role === who.role && w.taskId === who.taskId)) return;
  const left = waits.filter((w) => !(w.role === who.role && w.taskId === who.taskId));
  if (left.length) board.slotWaits = left;
  else delete board.slotWaits;
  saveBoard(board);
}

/** The worker the orchestrator's last round left waiting for room — at most one — or none. */
function setWorkerSlotWait(team: LiveTeam, wait: { taskId: string; reason: string } | null): void {
  for (const w of team.board.slotWaits ?? []) {
    if (w.role === "worker" && w.taskId !== wait?.taskId) clearSlotWait(team, w);
  }
  if (wait) noteSlotWait(team, { role: "worker", taskId: wait.taskId }, wait.reason);
}

/** Wait for a run to settle, in slices, honouring a stop and the budget; what it spent goes on the board. */
async function settle(team: LiveTeam, runId: string): Promise<CodingRun | null> {
  team.currentRunIds.add(runId);
  const started = Date.now();
  const spent = (run: CodingRun | null): CodingRun | null => {
    noteTokens(team.board, run);
    return run;
  };
  try {
    for (;;) {
      const run = await waitForRun(runId, WAIT_SLICE_MS);
      if (!run) return null;
      // SETTLED, not merely "no process": a PAUSED worker is held by the
      // owner and can still be resumed. Taking it as an outcome recorded
      // "The run ended paused." as the task's result, failed the task and
      // the team, and removed the worktree — while the run's own page went
      // on offering Resume into a folder that was no longer there. The
      // budget below is what ends a pause nobody comes back to.
      if (isSettled(run.status)) return spent(run);
      if (team.stopRequested) {
        try { stopRun(runId); } catch { /* raced with its own settle */ }
        return spent(getRun(runId));
      }
      if (Date.now() - started > RUN_BUDGET_MS) {
        team.bus.send(SYSTEM, { type: "alert", reason: `Run ${runId} outlived the team's budget and was stopped.` });
        try { stopRun(runId); } catch { /* raced */ }
        return spent(getRun(runId));
      }
      // waitForRun answers AT ONCE for a run that is not running, so a held
      // one (paused, a draft) would spin this loop; look again in a moment.
      if (!isLive(run.status)) await sleep(HELD_POLL_MS);
    }
  } finally {
    team.currentRunIds.delete(runId);
  }
}

/**
 * A settled run's tokens — the total and the same by kind — account and
 * model, from its own record, onto its line in the board's cast list: what
 * the team's metrics add up, by role and by provider. The model is brought up
 * to what ANSWERED (`answeredModel`).
 */
function noteTokens(board: TeamBoard, run: CodingRun | null): void {
  if (!run) return;
  const ref = board.runs.find((r) => r.id === run.id);
  if (!ref) return;
  const paid = runModelFields(run, answeredModel(run));
  const tokens = run.tokensUsed;
  const counted = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
  // Read as unknown: a record from before the field has none.
  const kinds = (run as { tokenBreakdown?: unknown }).tokenBreakdown;
  const breakdown = kinds && typeof kinds === "object" && !Array.isArray(kinds) ? readTokenBreakdown(kinds) : null;
  if (!counted && !paid && !breakdown) return;
  if (paid) Object.assign(ref, paid);
  if (counted) ref.tokens = tokens;
  if (breakdown) ref.tokenBreakdown = breakdown;
  saveBoard(board);
}

/**
 * A run's line in the board's cast list, with the account it was paid from,
 * its model there and the role its choice was made for, from the record its
 * start answered — so a team on several providers keeps each run's own.
 */
function castRef(run: CodingRun, role: TeamRunRef["role"], taskId: string | null): TeamRunRef {
  const paid = runModelFields(run, refModel(run.requestedModel) ?? null);
  return { id: run.id, role, taskId, ...(paid ?? {}) };
}

/** The provider, model and model role a ref keeps off a record — null for a record that names no provider it could have been paid from. */
function runModelFields(run: CodingRun, model: string | null): Pick<TeamRunRef, "provider" | "model" | "modelRole"> | null {
  if (!isCodingProvider(run.provider)) return null;
  // Read as unknown: a record from before the field has none.
  const role: unknown = run.modelRole;
  return {
    provider: run.provider,
    model,
    ...((MODEL_ROLES as readonly unknown[]).includes(role) ? { modelRole: role as ModelRole } : {}),
  };
}

/**
 * The model that did a settled run's work: what the CLI said its main loop
 * ran on, else what the run was started with, else the one model its usage
 * names — null where the provider's plan chose and nothing said which.
 */
function answeredModel(run: CodingRun): string | null {
  const used = Array.isArray(run.modelsUsed) && run.modelsUsed.length === 1 ? refModel(run.modelsUsed[0]) : undefined;
  return refModel(run.model) ?? refModel(run.requestedModel) ?? used ?? null;
}

/**
 * May this bulk task's worker start on the bulk role's provider? Yes while
 * that provider can run; when it cannot — or the map cannot be read — no, and
 * a note on the board says the task runs as an ordinary worker, and why.
 */
async function bulkMayRun(team: LiveTeam, taskId: string): Promise<boolean> {
  const map = await readTeamModels();
  const bulk = map?.bulk;
  if (bulk?.ready) return true;
  const why = bulk
    ? `${providerWords(bulk.provider)} cannot run right now: ${bulk.problems.join(" ") || "it is not ready."}`
    : "the team's role models could not be read.";
  team.bus.send(SYSTEM, { type: "note", task_id: taskId, text: bulkFallbackText(taskId, why) });
  return false;
}

/** The board's line for a bulk task worked by an ordinary worker. */
function bulkFallbackText(taskId: string, why: string): string {
  return `Task ${taskId} is marked bulk, but the bulk role's provider is unavailable — ${why.trim()} It runs as an ordinary worker, on the workers' model.`;
}

// ─── Words ───────────────────────────────────────────────────────────────────

/**
 * The planner's repo map as a worker's or a reviewer's brief carries it, said
 * in the reader's own folder (`toFolderPaths`) — a worker in its worktree must
 * never be handed the project's path. Null with no map.
 */
export function repoMapBrief(board: TeamBoard, folder: string | null): string | null {
  const text = repoMapText(board.repoMap);
  if (!text) return null;
  const said = folder && folder !== board.directory ? toFolderPaths(text, board.directory, folder) : text;
  return `Repo map — the team planner's map of the parts of this project the goal touches. Start from it instead of exploring the project again, and read further only where it is silent:\n${said}`;
}

/** A role's brief with the repo map after it, when the planner gave one. */
function withRepoMap(brief: string, board: TeamBoard, folder: string | null): string {
  const map = repoMapBrief(board, folder);
  return map ? `${brief}\n\n${map}` : brief;
}

/**
 * The task of the ONE run a one-task plan becomes: the owner's goal in their
 * own words — it is the whole of the work — and the planner's description of
 * it after, when it says more. A plan of tasks that mostly touch the same
 * files becomes one run too, and its tasks are listed in order after the goal.
 * Cut at the run route's cap from the end.
 */
export function singleRunTask(board: TeamBoard, tasks: readonly TeamTask[]): string {
  const goal = board.goal.trim();
  const parts = [goal];
  if (tasks.length === 1) {
    const [task] = tasks;
    const planned = task.task_description.trim();
    if (planned && planned !== goal) parts.push(`The team's planner wrote it up as: ${planned}`);
    if (task.files_hint.length) parts.push(`Files it is expected to touch: ${task.files_hint.join(", ")}`);
  } else {
    const steps = tasks.map((t, i) => `${i + 1}. ${t.task_description.trim()}${t.files_hint.length ? ` (files: ${t.files_hint.join(", ")})` : ""}`);
    parts.push(`The team's planner split it into ${tasks.length} parts that touch the same files, so they are all yours, in this one run, in this order:\n${steps.join("\n")}`);
  }
  const text = parts.join("\n\n");
  return text.length > MAX_TASK_CHARS ? `${text.slice(0, MAX_TASK_CHARS - 1)}…` : text;
}

/** Heads the board's digest in a worker's task text. */
const DIGEST_LABEL = "\n\nThe team's board — every other task, then the latest alerts and messages:\n";

/**
 * One worker's task text: its own task, the goal, where to work, why a
 * previous attempt was rejected — and the whole board, compact
 * (`boardDigest`), in whatever room that leaves inside the run route's cap.
 * `folder` is the worker's own worktree, when it has one.
 *
 * A worker in a worktree is told that folder as its ONLY one, and the
 * project folder is never named to it: every path in the text — the goal's,
 * a task description's, a previous rejection's, the board's, a sibling's
 * worktree — is said inside its own folder (`toFolderPaths`), and the files
 * its task names are given as absolute paths there (`hintInFolder`). Told
 * the project's path, or a hint it took as relative to the project, a
 * worker read and wrote `<project>/<file>`, was refused (the run is
 * contained to its worktree), and the refusal failed the task (bench,
 * 2026-09-22/23).
 */
export function workerTask(board: TeamBoard, task: TeamTask, folder: string | null = null): string {
  const own = folder && folder !== board.directory ? folder : null;
  const here = (text: string): string => (own ? toFolderPaths(text, board.directory, own) : text);
  // The task line comes FIRST: a run's commit subject and its row in the
  // app are the task text's first line, and "Team goal: …" four times over
  // told the owner nothing about which worker did what.
  const parts = [`Your task (${task.task_id} of ${board.tasks.length}): ${here(task.task_description)}`];
  // Right after the task line, ahead of a goal that may be long enough to
  // push it past the cut below.
  if (own) {
    parts.push(`Your folder: ${own} — your own working copy of the project, and the ONLY folder you work in. Read and write there and nowhere else; the files below are given with their full path in it.`);
  }
  parts.push(`Team goal: ${here(board.goal)}`);
  if (task.files_hint.length) {
    const files = own ? task.files_hint.map((f) => hintInFolder(f, board.directory, own)) : task.files_hint;
    parts.push(`Files this task is expected to touch: ${files.join(", ")}`);
  }
  const head = parts.join("\n\n");
  const rejected = task.attempts > 0 && task.review?.verdict === "rejected" ? `\n\nA previous attempt was rejected: ${here(task.review.notes)}` : "";
  // Held (`holdTask`): the attempt before this one stood on a dependency that
  // was reopened since — said with what became of it, so this attempt builds
  // on the dependency as it is NOW instead of repeating the last one.
  const held = task.hold
    ? `\n\nThis task was ${task.hold.was === "complete" ? "done" : "started"} before on top of ${task.hold.dependency}, which has since been reopened${task.hold.reason ? ` (${here(task.hold.reason)})` : ""} and is accepted again now. ${task.hold.was === "complete" ? `What that attempt merged is already in the files: check it against ${task.hold.dependency} as it stands now and redo what no longer fits.` : "That attempt was stopped before it finished and nothing of it was kept; work from the current files."}`
    : "";
  // Who else is at work, by the run id `team_message` needs: the one way a
  // worker learns which run to tell when it is blocked on a sibling's part.
  // LAST, because the text is cut at MAX_TASK_CHARS from the end: a list a
  // NOT_IN_TEAM refusal can also give must never push out a retry's reason.
  const working = board.tasks
    .filter((t) => t.task_id !== task.task_id && t.status === "in_progress" && t.assigned_to)
    .map((t) => `- ${t.assigned_to} on ${t.task_id}: ${firstLine(here(t.task_description), TEAMMATE_QUOTE_CHARS)}`);
  const teammates = working.length ? `\n\nTeammates at work now (reach one with team_message, to="sibling"):\n${working.join("\n")}` : "";
  // The board's digest takes the room the rest leaves, so it never pushes a
  // retry's reason or the teammates' run ids out of the text. Said in the
  // worker's folder it can grow (a worktree path is longer than the
  // project's): built once more for the room the growth leaves, and cut
  // only if that is still over.
  const room = MAX_TASK_CHARS - head.length - DIGEST_LABEL.length - rejected.length - held.length - teammates.length;
  let digest = room > 0 ? here(boardDigest(board, task.task_id, Math.min(MAX_DIGEST_CHARS, room))) : "";
  if (digest.length > room && room > 0) {
    const smaller = room - (digest.length - room);
    digest = smaller > 0 ? here(boardDigest(board, task.task_id, Math.min(MAX_DIGEST_CHARS, smaller))) : "";
    if (digest.length > room) digest = `${digest.slice(0, room - 1)}…`;
  }
  let text = `${head}${digest ? `${DIGEST_LABEL}${digest}` : ""}${rejected}${held}${teammates}`;
  if (text.length > MAX_TASK_CHARS) text = `${text.slice(0, MAX_TASK_CHARS - 1)}…`;
  return text;
}

/**
 * Files a worker touched that its task's hint does not cover (a hint names
 * files or folders). `scratch: false` counts a scratch-named file like any
 * other, for a caller that is not judging what a worker left behind.
 */
export function outsideHint(touched: string[], hint: string[], { scratch = true }: { scratch?: boolean } = {}): string[] {
  if (hint.length === 0) return [];
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const hints = hint.map(norm);
  // A build or an interpreter writes its own files beside the source it was
  // pointed at — a worker asked to edit calc.py cannot help CPython leaving
  // __pycache__/calc.cpython-310.pyc there. Counting that as straying failed
  // three correct tasks and killed a run on the alert ceiling (team-6rgz8cyx,
  // team-5oxkp7a9, 2026-09-06). It is noise, not a trespass. So is a scratch
  // file a worker made to check its work (`isScratchFile`).
  return touched
    .map(norm)
    .filter((f) => !isGeneratedArtifact(f) && !(scratch && isScratchFile(f)))
    .filter((f) => !hints.some((h) => f === h || f.startsWith(`${h}/`)));
}

/**
 * The files a worker in `folder` (its worktree) says it wrote there — its
 * run's `filesTouched`, relative to the run's folder and absolute outside it —
 * generated artifacts and `.clawbox/` aside: the harvest never commits those
 * either. Never the files its task's hint names, which a check-only task only
 * reads. Empty for a worker that wrote nothing in its worktree.
 */
export function writtenFiles(touched: string[], folder: string): string[] {
  const root = folder.replace(/\/+$/, "");
  const inside = (f: string): string | null => {
    const rel = f.startsWith("/") ? (f.startsWith(`${root}/`) ? f.slice(root.length + 1) : null) : f;
    if (rel === null) return null;
    const norm = rel.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    return norm && norm !== "." && norm !== ".." && !norm.startsWith("../") && !isGeneratedArtifact(norm) && !/^\.clawbox(\/|$)/.test(norm) ? norm : null;
  };
  return [...new Set(touched.map(inside).filter((f): f is string => f !== null))];
}

/**
 * A name nobody gives a deliverable: `__verify_probe.html`, `check.tmp`,
 * `.probe-1` — what a worker writes to try something and means to remove
 * (bench, 2026-09-26: a verifier's probe page counted as straying and cost a
 * correct task a second attempt). By the file's own name; a dunder name such
 * as `__init__.py` is source, not scratch.
 */
export function isScratchFile(file: string): boolean {
  const name = file.replace(/\/+$/, "").split("/").pop() ?? "";
  if (/^__\w+__(?:\.\w+)?$/.test(name)) return false;
  return name.startsWith("__") || name.endsWith(".tmp") || name.startsWith(".probe");
}

/**
 * The files of `touched` (relative to `dir`, as the runner records them) that
 * are no longer there. None when `dir` itself is not: a folder that is gone
 * says nothing about what the worker left in it.
 */
export function vanishedFiles(dir: string, touched: readonly string[]): Set<string> {
  const gone = new Set<string>();
  if (!path.isAbsolute(dir) || !fs.existsSync(dir)) return gone;
  for (const file of touched) {
    try {
      // lstat: a link the worker left is there, wherever it points.
      fs.lstatSync(path.resolve(dir, file));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") gone.add(file);
    }
  }
  return gone;
}

/**
 * The tasks a red suite goes back to: the complete tasks with an attempt left
 * (a rejection on the second one would end the task rather than retry it)
 * whose files the failure names — a traceback's frame, a failing spec's path —
 * or, when it names none of theirs, every one of them: a suite broken between
 * tasks is not any one task's to fix alone. A named file whose name says
 * scratch is still judged by the hints: a left-over probe that fails the suite
 * is not every task's.
 */
export function suiteSuspects(tasks: TeamTask[], named: string[]): TeamTask[] {
  const open = tasks.filter((t) => t.status === "complete" && countedAttempts(t) < 2);
  const pointed = open.filter((t) => named.some((f) => outsideHint([f], t.files_hint, { scratch: false }).length === 0));
  return pointed.length ? pointed : open;
}

/**
 * A task went back — its reviewer rejected it, the suite gate reopened it, or
 * it was itself held — so whatever STARTED on top of it is set back
 * (`startedDependents`): dispatch waits for an accepted dependency
 * (`readyTasks`), and a dependent that got going before the dependency fell
 * through must not finish, or stand, on work that does not.
 *
 *  - Running: its worker is stopped and the task held once that worker
 *    settles (`workTask`), its work never merged. Said on the board now.
 *  - Finished, reviewed or not: held at once, its result set aside, and a
 *    reviewer still reading it is stopped — its verdict is dropped.
 *
 * A hold is itself a reopening, so the subscriber this runs as carries it on
 * down the chain. Bounded by the chain: every hold starts at a counted
 * rejection, and a task has two of those at most.
 */
function holdDependents(team: LiveTeam, delivered: Delivered): void {
  const { board, bus } = team;
  const m = delivered.message;
  if (team.stopRequested || isSettledStatus(board.status)) return;
  const reopened = m.type === "review" && m.verdict === "rejected"
    ? { id: m.task_id, reason: `rejected — ${firstLine(m.notes, 300)}` }
    : m.type === "hold"
      ? { id: m.task_id, reason: `held, because its own dependency ${m.dependency} was reopened` }
      : m.type === "ci_reopen"
        ? { id: m.task_id, reason: `re-offered for the pull request's failing checks — ${firstLine(m.notes, 300)}` }
        : null;
  if (!reopened) return;
  for (const dependent of startedDependents(board, reopened.id)) {
    if (dependent.status === "in_progress") {
      if (team.held.has(dependent.task_id)) continue;
      team.held.set(dependent.task_id, { dependency: reopened.id, reason: reopened.reason });
      try {
        bus.send(SYSTEM, { type: "note", task_id: dependent.task_id, text: `Holding ${dependent.task_id}: its dependency ${reopened.id} was ${reopened.reason}. Its worker ${dependent.assigned_to ?? "(none)"} is being stopped; ${dependent.task_id} starts again once ${reopened.id} is accepted.` });
      } catch {
        // Refused by the board: already on it as an alert.
      }
      if (dependent.assigned_to) {
        try { stopRun(dependent.assigned_to); } catch { /* already settled */ }
      }
      continue;
    }
    const reviewer = dependent.reviewRunId;
    try {
      bus.send(SYSTEM, { type: "hold", task_id: dependent.task_id, dependency: reopened.id, reason: reopened.reason });
    } catch {
      // Refused by the board: already on it as an alert.
      continue;
    }
    if (reviewer && isHeldRun(reviewer)) {
      try { stopRun(reviewer); } catch { /* already settled */ }
    }
  }
}

// ─── The team's pull request ─────────────────────────────────────────────────

/** How often the team's pull request's checks are read, and how long one round's are waited for. */
let teamPrPollMs = 20_000;
let teamPrMaxWaitMs = 45 * 60_000;

/** Tests only: a pull request's checks are not waited on for real minutes. */
export function _setTeamPrTimingForTests(pollMs: number, maxWaitMs: number): void {
  teamPrPollMs = pollMs;
  teamPrMaxWaitMs = maxWaitMs;
}

/**
 * The pull request the team's goal asks for (`goalWantsPullRequest`, `asked`)
 * or the owner's pull-request switch publishes, as it does a single run's — the
 * ORCHESTRATOR's, never a worker's (a team's runs are refused every merge and
 * push: TEAM_MERGE_DENYLIST, the hook's merge guard). Reached only once every
 * task is accepted, the suite gate is green and the final review passed.
 *
 * Opened from the team's branch into the branch it forked from (or, on a later
 * round, the branch pushed again), then its checks are watched under the
 * single runs' own merge rules (`decideMerge`: a failed check, a conflict, a
 * hold label, no checks at all — each is a no). Then:
 *
 *  - RED: the failed jobs' logs are read (bounded), the failing tests and files
 *    named, and the tasks whose files_hint covers a failing file — every
 *    finished task when none does — go back to pending with the failure
 *    (`reopenForCi`, dependents first, what started on them held): answered
 *    `reoffered`, and the loop works them; after MAX_TEAM_CI_ROUNDS rounds the
 *    team fails with what still fails.
 *  - GREEN: merged when the goal asks for the merge (`goalWantsMerge`, read once,
 *    when it opened), else left open for the owner.
 *  - anything else that is not a merge: left open, and why.
 *
 * Null once the team was stopped.
 */
async function teamPullRequest(team: LiveTeam, asked: boolean): Promise<{ kind: "done" } | { kind: "reoffered"; tasks: string[] } | { kind: "failed"; detail: string } | null> {
  const { board, bus } = team;
  if (!board.branch || !board.base) return { kind: "done" };
  setTeamStatus(board, SYSTEM, "reviewing", board.pr ? `Pushing the fixes to pull request #${board.pr.number}` : asked ? "Opening the pull request the goal asks for" : "Publishing the team's branch as a pull request");
  saveBoard(board);
  const record = (pr: TeamPr, note: string): TeamPr => {
    bus.send(SYSTEM, { type: "pr", pr, note });
    return board.pr ?? pr;
  };
  let pr: TeamPr;
  if (!board.pr) {
    const opened = await openPullRequest({ directory: board.directory, branch: board.branch, base: board.base, title: teamPrTitle(board), body: teamPrBody(board) });
    if (team.stopRequested) return null;
    if (!opened.ok) return { kind: "failed", detail: asked ? `The goal asks for a pull request, and it could not be opened: ${opened.detail}` : `The team's pull request could not be opened: ${opened.detail}` };
    const now = Date.now();
    pr = record({
      number: opened.number, url: opened.url, branch: board.branch, base: board.base, phase: "checks",
      checks: { total: 0, passed: 0, failed: 0, pending: 0 }, merge: goalWantsMerge(board.goal), ciRounds: 0, failure: null, detail: null, openedAt: now, updatedAt: now,
    }, `Opened pull request #${opened.number} from ${board.branch} into ${board.base}${goalWantsMerge(board.goal) ? "; the goal asks for the merge, made once every check passes" : ""}.`);
  } else {
    const pushed = await pushBranch(board.directory, board.branch);
    if (team.stopRequested) return null;
    if (!pushed.ok) return { kind: "failed", detail: `The fixes could not be pushed to pull request #${board.pr.number}: ${pushed.detail}` };
    pr = record({ ...board.pr, phase: "checks", detail: null }, `Pushed round ${board.pr.ciRounds} of fixes to pull request #${board.pr.number}; its checks run again.`);
  }

  const startedAt = Date.now();
  // When this box marked a draft of it ready: the post-ready grace decideMerge
  // keeps, and the one ready it makes — a draft again after that is left open.
  let readyAt: number | null = null;
  for (;;) {
    await sleep(teamPrPollMs);
    if (team.stopRequested) return null;
    const snapshot = await readPullRequest(board.directory, pr.number);
    if (team.stopRequested) return null;
    if ("error" in snapshot) {
      if (Date.now() - startedAt < teamPrMaxWaitMs) continue;
      record({ ...pr, phase: "left_open", detail: snapshot.error }, `Pull request #${pr.number} could not be read from GitHub; it is left open. ${firstLine(snapshot.error, 300)}`);
      return { kind: "done" };
    }
    // Where its checks stand, on the board for the card — not a log line per poll.
    if (board.pr) {
      board.pr = { ...board.pr, checks: snapshot.checks, updatedAt: Date.now() };
      saveBoard(board);
      pr = board.pr;
    }
    const verdict = decideMerge({ snapshot, waitedMs: Math.min(Date.now() - startedAt, teamPrMaxWaitMs), reviewOk: true, sinceReadyMs: readyAt === null ? null : Date.now() - readyAt });
    if (verdict.action === "wait") {
      if (Date.now() - startedAt < teamPrMaxWaitMs) continue;
      record({ ...pr, phase: "left_open", detail: "Gave up waiting for its checks." }, `Pull request #${pr.number}: gave up waiting for its checks after ${Math.round(teamPrMaxWaitMs / 60_000)} minutes; it is left open.`);
      return { kind: "done" };
    }
    if (verdict.action === "ready") {
      // Somebody made a draft of it: readied once, and its checks waited on
      // again under the same ceiling. A ready GitHub refuses is left open.
      const readied = Date.now() - startedAt < teamPrMaxWaitMs
        ? await markPullRequestReady(board.directory, pr.number)
        : { ok: false as const, detail: "Gave up waiting for its checks." };
      if (team.stopRequested) return null;
      if (!readied.ok) {
        record({ ...pr, phase: "left_open", detail: readied.detail }, `Pull request #${pr.number} is a draft and could not be marked ready; it is left open. ${firstLine(readied.detail, 300)}`);
        return { kind: "done" };
      }
      readyAt = Date.now();
      continue;
    }
    if (verdict.action === "merge") {
      if (!pr.merge) {
        record({ ...pr, phase: "green" }, `Every check on pull request #${pr.number} passed. The goal did not ask for a merge, so it is left open for the owner.`);
        return { kind: "done" };
      }
      const merged = await mergePullRequest(board.directory, pr.number);
      if (!merged.ok) {
        record({ ...pr, phase: "left_open", detail: merged.detail }, `Pull request #${pr.number} is green but could not be merged: ${firstLine(merged.detail, 300)}`);
        return { kind: "done" };
      }
      record({ ...pr, phase: "merged" }, `Merged pull request #${pr.number}: every task accepted, the suite green, the final review passed and every check green.`);
      return { kind: "done" };
    }
    // Blocked. Failing checks: read, and the tasks they point at go back.
    if (snapshot.checks.failed > 0) {
      const failure = await readTeamCiFailure(board.directory, pr.number);
      if (team.stopRequested) return null;
      if (pr.ciRounds >= MAX_TEAM_CI_ROUNDS) {
        record({ ...pr, phase: "failed", failure }, `${ciFailureLine(failure)} — still red after ${MAX_TEAM_CI_ROUNDS} rounds of fixes.`);
        return { kind: "failed", detail: `The pull request's CI is still red after ${MAX_TEAM_CI_ROUNDS} rounds of fixes: ${ciFailureLine(failure)}.` };
      }
      const suspects = ciSuspects(board.tasks, failure.files);
      const round = pr.ciRounds + 1;
      record({ ...pr, phase: "failed_checks", failure, ciRounds: round }, `${ciFailureLine(failure)}. Offering ${suspects.map((t) => t.task_id).join(", ") || "nothing"} once more with the failure (round ${round} of ${MAX_TEAM_CI_ROUNDS}).`);
      const notes = ciFixNotes(failure, { push: false, excerptChars: TEAM_CI_EXCERPT_CHARS });
      // Dependents first, as the suite gate does: each suspect gets the
      // failure itself, and only what the failure did not point at is held.
      for (const task of [...suspects].reverse()) {
        if (!underReview(board, task.task_id)) continue;
        bus.send(SYSTEM, { type: "ci_reopen", task_id: task.task_id, notes });
      }
      return { kind: "reoffered", tasks: suspects.map((t) => t.task_id) };
    }
    record({ ...pr, phase: "left_open", detail: verdict.detail }, `Pull request #${pr.number} is left open: ${firstLine(verdict.detail, 300)}`);
    return { kind: "done" };
  }
}

/** The failure text a re-offered task's worker reads — shorter than a run's: the board keeps 2,000 characters of a rejection. */
const TEAM_CI_EXCERPT_CHARS = 900;

/** The team pull request's failing checks, read: their logs fetched (bounded), the tests and files named. */
async function readTeamCiFailure(dir: string, prNumber: number): Promise<CiFailure> {
  const snapshot = await readReviewSnapshot(dir, prNumber);
  const failed = "error" in snapshot ? [] : snapshot.checks.filter((c) => c.state === "fail");
  const logs = failed.length ? await readFailedCheckLogs(dir, failed) : [];
  return readCiFailure(prNumber, logs);
}

/**
 * The tasks a red CI goes back to: the finished tasks whose files_hint covers
 * a file the failure names — or, when it names none of theirs, every one of
 * them, as the suite gate does. Not limited by a task's two tries: the team's
 * CI rounds are the bound (`reopenForCi`).
 */
export function ciSuspects(tasks: TeamTask[], named: string[]): TeamTask[] {
  const open = tasks.filter((t) => t.status === "complete");
  const pointed = open.filter((t) => named.some((f) => outsideHint([f], t.files_hint, { scratch: false }).length === 0));
  return pointed.length ? pointed : open;
}

function teamPrTitle(board: TeamBoard): string {
  return `Coding team: ${firstLine(board.goal, 72)}`;
}

/** What the pull request says: the goal, each task and what came of it — redacted again where it is published (openPullRequest). */
function teamPrBody(board: TeamBoard): string {
  const tasks = board.tasks
    .filter((t) => t.status === "complete")
    .map((t) => `- ${t.task_id}: ${firstLine(t.task_description, 160)}${t.result ? ` — ${firstLine(t.result, 200)}` : ""}`);
  return [
    `Opened by ClawBox's coding team \`${board.id}\` for this goal:`,
    "",
    `> ${firstLine(board.goal, 600)}`,
    "",
    "Tasks, each accepted:",
    ...tasks,
  ].join("\n");
}

/** Is `taskId` still the finished result its reviewer is reading — not held, not reopened, since? */
function underReview(board: TeamBoard, taskId: string): boolean {
  return board.tasks.find((t) => t.task_id === taskId)?.status === "complete";
}

// ─── Internals ───────────────────────────────────────────────────────────────

function isSettledStatus(status: TeamBoard["status"]): boolean {
  return isSettledTeamStatus(status);
}

/** A board that says "working" with nobody working — the web server restarted under it. A queued one is not: it waits on disk for its turn. */
function settleOrphan(board: TeamBoard): TeamBoard {
  if (isSettledStatus(board.status) || live.has(board.id) || board.status === "queued") return board;
  setTeamStatus(board, SYSTEM, "failed", "The web server restarted while the team was working.");
  saveBoard(board);
  return board;
}

/** The board as the routes answer it, with the agent count worked out from it and the figures as of now (a working team's clock runs). */
function snapshot(board: TeamBoard, queue?: readonly string[]): TeamView {
  const at = board.status === "queued" ? (queue ?? queuedBoards().map((b) => b.id)).indexOf(board.id) : -1;
  return { ...(JSON.parse(JSON.stringify(board)) as TeamBoard), agents: teamAgents(board), metrics: teamMetrics(board), advice: teamAdvice(board), ...(at >= 0 ? { queuePosition: at + 1 } : {}) };
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
