/**
 * The Shared Blackboard of a coding TEAM — the multi-agent shape of the
 * coding agent (owner's brief, 2026-09-04): a Planner decomposes a goal into
 * tasks, Workers take them and post results, a Review Loop checks them.
 *
 * This module is the structured, ACCESS-CONTROLLED shared state the brief
 * asks for. It knows nothing about processes: it holds a team's goal, its
 * tasks and an append-only audit log, and it refuses every mutation the
 * caller's ROLE is not allowed to make —
 *
 *   - only the Planner posts tasks,
 *   - only the Worker a task is assigned to moves its status or submits its
 *     result,
 *   - only the Reviewer records a verdict,
 *   - only the Owner (or the orchestrator acting for the owner) stops a team.
 *
 * Every accepted mutation is appended to `log` with the actor, the time and
 * the message it came from, so the board IS the audit trail. Nothing here is
 * ever mutated in place by a caller: `coding-team-bus.ts` is the one writer,
 * and it goes through these functions.
 *
 * Persisted one JSON file per team under `data/coding-team/`, 0600, written
 * to a temp name and renamed so a reader never sees half a board.
 */

import fs from "fs";
import os from "os";
import type { CiFailure } from "@/lib/coding-ci";
import { emptyTokenBreakdown, readTokenBreakdown, type TokenBreakdown } from "@/lib/coding-agent";
import { isOfferedEffort, type CodingEffort } from "@/lib/coding-effort";
import { CODING_PROVIDERS, isCodingProvider, type CodingProvider } from "@/lib/coding-provider";
import { isSettledTeamStatus, type TeamStatus } from "@/lib/coding-team-status";
import { MODEL_ROLES, type ModelRole } from "@/lib/coding-role-models";
import path, { untraced } from "@/lib/runtime-path";
import { randomBytes } from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import {
  MAX_TEAM_MESSAGE_CHARS,
  MAX_TEAM_MESSAGES_PER_RUN,
  RUN_ID_RE,
  TEAM_MESSAGE_TARGETS,
  teamMessageAllowance,
  type TeamMessageRefusal,
  type TeamMessageTarget,
} from "@/lib/coding-team-messages";

export const TEAM_DIR = path.join(DATA_DIR, "coding-team");
/** A planner may post this many tasks at most; a bigger plan is a bad plan on a box that runs one worker at a time. */
export const MAX_TEAM_TASKS = 8;
/** The audit log keeps this many entries; the oldest fall off. */
export const MAX_LOG_ENTRIES = 400;
export const MAX_GOAL_CHARS = 4_000;
/**
 * A task description is the WHOLE brief its worker gets (TASK_RULES): the
 * verify and commit steps and the goal's constraints live in it. At 2,000, 5
 * of 6 descriptions of one live team were cut before their verify step;
 * `workerTask` builds the worker's text to TEAM_TASK_CHARS, so this fits.
 */
export const MAX_TASK_DESCRIPTION_CHARS = 6_000;
export const MAX_RESULT_CHARS = 6_000;
/** The lead (the `coding_team_dynamic` switch) may add this many tasks over a team's whole life… */
export const MAX_LEAD_ADDS = 3;
/** …and retire this many, each one still pending when it goes. */
export const MAX_LEAD_RETIRES = 2;
/** A worker's (and the lead's) view of the board is cut to this many characters, oldest lines first. */
export const MAX_DIGEST_CHARS = 2_500;
/** The planner's one-line reason for the team's shape, as the card shows it. */
export const MAX_RATIONALE_CHARS = 200;
/** One list of the planner's repo map holds this many entries… */
export const MAX_REPO_MAP_ITEMS = 12;
/** …each at most this long… */
export const MAX_REPO_MAP_ITEM_CHARS = 200;
/** …and the whole map, as a worker's brief carries it, at most this long. */
export const MAX_REPO_MAP_CHARS = 2_000;
/**
 * Above this share of a plan's hinted files being shared with another task,
 * the tasks "mostly overlap": they would queue on the same files, merge into
 * each other's conflicts, and each pay to read what the others read — one run
 * would do the same work once (`teamAdvice`).
 */
export const OVERLAP_ADVICE_SHARE = 0.6;
/** Log lines of the kinds a teammate should hear about, quoted at the end of the digest. */
const DIGEST_LOG_LINES = 5;

/**
 * `queued`: asked for while another team was working — persisted, and started
 * by the box itself in the order asked once the teams ahead of it settle
 * (coding-team.ts startNextQueuedTeam). Neither working nor settled.
 */
export type { TeamStatus };
/**
 * `retired` is the lead's: a pending task it decided the goal no longer
 * needs. Terminal, and neither a failure nor a block — a task that waited on
 * it may start, and a team whose other tasks are complete is done.
 */
export type TaskStatus = "pending" | "in_progress" | "complete" | "failed" | "rejected" | "retired";
/** Who asked for the team: the person (a session cookie) or the assistant (the MCP bearer). */
export type TeamSource = "owner" | "agent";
/**
 * How the team's work is reviewed: a reviewer run per task (`each`, the
 * shape every team had before the planner could say), ONE reviewer run over
 * the merged result at the end (`final`), or only the rule — no refusal, no
 * stray file — with no reviewer run at all (`none`).
 */
export type ReviewMode = "each" | "final" | "none";
export const REVIEW_MODES: readonly ReviewMode[] = ["each", "final", "none"];

/** The team's size and review, as the planner chose them for this goal. */
export interface TeamShape {
  /** How many workers may run side by side; the orchestrator caps it by the box's own slots. */
  parallelism: number;
  review: ReviewMode;
  /** Why, in a line — shown on the card. */
  rationale: string;
}

/**
 * The planner's compact map of the parts of the project the goal touches: the
 * files, where the code starts, how it is tested, and what bites. Put on the
 * board once and handed to every worker and reviewer in its brief, so a team
 * of three does not pay for the same exploration three more times.
 */
export interface RepoMap {
  files: string[];
  entryPoints: string[];
  testCommands: string[];
  gotchas: string[];
}

/**
 * Why a single run would have been cheaper than this team (`teamAdvice`):
 * the plan has one task, or its tasks' files mostly overlap — `overlap` is
 * the share of the plan's hinted files another task names too, in percent.
 * `catchAll`: the planned tasks that name every file the others own
 * (`catchAllTasks`) — on an overlap verdict only, and only when there are any.
 */
export interface TeamAdvice {
  reason: "one_task" | "overlap";
  overlap: number;
  catchAll?: string[];
}

/** Tokens the team's runs spent, by the role they ran in. */
export interface RoleTokens {
  planner: number;
  worker: number;
  reviewer: number;
  lead: number;
}

/** Tokens the team's runs spent by kind, by the role they ran in. */
export type RoleTokenBreakdown = Record<keyof RoleTokens, TokenBreakdown>;

/** Tokens the team's runs spent, by the account that paid for them (each run's own provider). */
export type ProviderTokens = Record<CodingProvider, number>;

/** The one reviewer run over the merged result, in the `final` review mode. */
export interface FinalReview {
  verdict: "accepted" | "rejected";
  notes: string;
  at: number;
}

/**
 * What a team cost and how its shape fitted the goal — the figures a bench
 * compares shapes by. Worked out from the board alone (`teamMetrics`), so a
 * board on disk and the one in memory can never disagree about them.
 */
export interface TeamMetrics {
  plannerRuns: number;
  workerRuns: number;
  reviewerRuns: number;
  leadRuns: number;
  /** Tasks in the planner's plan. */
  tasksPlanned: number;
  /** Tasks the lead added while the team ran. */
  tasksAdded: number;
  tasksRetired: number;
  /** Tasks accepted on their first attempt. */
  tasksAcceptedFirstTry: number;
  /** Tasks rejected at least once — by the reviewer, the rule, or a merge that failed. */
  tasksRejected: number;
  /** Tokens every run of the team spent, from each run's own record. */
  tokensUsed: number;
  /** The same tokens by role: what the planner, the workers, the reviewers and the lead each cost. */
  tokensByRole: RoleTokens;
  /**
   * The same tokens by the four ways a provider bills them — fresh input,
   * output, cache written, cache read — summed from each run's own
   * breakdown (`TeamRunRef.tokenBreakdown`), in total and by role. A run on a
   * board from before the field has none: its tokens are in `tokensUsed` and
   * in neither of these, which then read as zeros.
   */
  tokenBreakdown: TokenBreakdown;
  tokenBreakdownByRole: RoleTokenBreakdown;
  /**
   * The same tokens by the provider each run was paid from (`TeamRunRef.provider`)
   * — a team whose roles sit on different accounts costs each its own share.
   * A run on a board from before the field names no provider: its tokens are
   * in `tokensUsed` and in neither of these.
   */
  tokensByProvider: ProviderTokens;
  /** From the team's creation to its end — or to now, while it works. */
  wallMs: number;
  /**
   * Team messages on the log (team_message), and of those: to the lead, to a
   * sibling, and the ones that never reached anybody — the box could not hand
   * them on (a `message` entry), or the sibling had already finished (a
   * `note`, `UndeliveredNote`). A message the SENDER got wrong is an alert and
   * is in none of these.
   */
  messagesSent: number;
  messagesToLead: number;
  messagesToSibling: number;
  messagesUndelivered: number;
  /**
   * Refused actions that changed nothing — they only looked (`readOnlyDenial`),
   * wrote outside the worker's folders (`outsideFolderWriteDenial`), or aimed
   * at the project's own path and were answered with a retry hint at the
   * worker's worktree (`CodingDenial.worktreePath`): on the log as notes,
   * never alerts, never a rejection.
   */
  readOnlyRefusals: number;
}

const TEAM_STATUSES: readonly TeamStatus[] = ["queued", "planning", "working", "reviewing", "done", "failed", "stopped"];
const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "complete", "failed", "rejected", "retired"];
const RUN_ROLES: readonly TeamRunRef["role"][] = ["planner", "worker", "reviewer", "lead"];

/** Who is making a change. The kind is what the board checks; a worker's id is the run it is. */
export type Actor =
  | { kind: "planner" }
  | { kind: "worker"; id: string }
  | { kind: "reviewer" }
  | { kind: "owner" }
  | { kind: "system" };

/** The brief's Task Message, plus what the orchestrator needs to schedule it. */
export interface TeamTask {
  task_id: string;
  task_description: string;
  /** The worker (a run id) the task is assigned to, or null while unassigned. */
  assigned_to: string | null;
  status: TaskStatus;
  result: string | null;
  /** Task ids that must be complete before this one may start. */
  depends_on: string[];
  /** Files the planner expects the task to touch; the deviation monitor reads it. */
  files_hint: string[];
  /** The reviewer's verdict on the result, once there is one. */
  review: { verdict: "accepted" | "rejected"; notes: string; at: number } | null;
  attempts: number;
  /** The worker's own worktree and branch for the current attempt (coding-team-worktree.ts), or null when the worker works in place. */
  worktree: string | null;
  branch: string | null;
  /** The reviewer run that ruled on the current attempt, once there is one. */
  reviewRunId: string | null;
  /** Who put the task on the board: the planner's plan, or the lead while the team ran. */
  origin: "plan" | "lead";
  /** How many times the task was rejected — by the reviewer, the rule, or a merge that failed. */
  rejections: number;
  /**
   * How many of its `attempts` were HELD rather than judged (`holdTask`): a
   * dependency of it was rejected or reopened after it had started, so the
   * attempt was stopped or its result set aside through no fault of its own.
   * Never counted against the task's two tries (`countedAttempts`).
   */
  holds: number;
  /** Why the task is back to pending after a hold, until a worker takes it again — the next worker is told. */
  hold: TaskHold | null;
  /**
   * How many of its `attempts` the team's pull request sent it back for, its
   * CI red (`reopenForCi`) — bounded by the team's own CI rounds
   * (MAX_TEAM_CI_ROUNDS), never against the task's two tries.
   */
  ciReoffers: number;
  /**
   * How many of its `attempts` the team stopped itself (`reopenAfterStop`):
   * its worker was held — paused — past RUN_BUDGET_MS with nobody resuming
   * it. Offered once more, never against the task's two tries; a board from
   * before the field reads as 0.
   */
  budgetReoffers: number;
  created_at: number;
  updated_at: number;
}

/** A task set back because a task it depends on was rejected or reopened (`holdTask`). */
export interface TaskHold {
  /** The dependency that was reopened. */
  dependency: string;
  /** What happened to it, in a line — the reviewer's notes, the suite's failure. */
  reason: string;
  /** What the hold did to the task: its running attempt stopped, or its finished result set aside. */
  was: "in_progress" | "complete";
  at: number;
}

/** A task's attempts that count toward its two tries — its holds are not its own failures. */
export function countedAttempts(task: Pick<TeamTask, "attempts" | "holds"> & { ciReoffers?: number; budgetReoffers?: number }): number {
  return Math.max(0, task.attempts - (task.holds ?? 0) - (task.ciReoffers ?? 0) - (task.budgetReoffers ?? 0));
}

/**
 * The pull request a team opened because its goal asked for one
 * (coding-team.ts teamPullRequest) — the ORCHESTRATOR's, never a worker's:
 * opened from the team's branch once every task is accepted, the suite is
 * green and the final review passed, its checks watched, its CI failures
 * re-offered to the tasks they point at in bounded rounds, and merged only
 * when the goal asks for the merge and every check passes.
 *
 *   checks        — opened or updated; its checks are running
 *   failed_checks — red: tasks re-offered with the failure, a fix coming
 *   green         — every check passed; the goal asked for no merge
 *   merged        — merged by the orchestrator
 *   left_open     — not merged, and why (`detail`): a conflict, a hold label, no checks at all
 *   failed        — still red after MAX_TEAM_CI_ROUNDS rounds, or could not be read
 */
export interface TeamPr {
  number: number;
  url: string;
  branch: string;
  base: string;
  phase: "checks" | "failed_checks" | "green" | "merged" | "left_open" | "failed";
  checks: { total: number; passed: number; failed: number; pending: number };
  /** The goal asks for the merge — read once, when the pull request was opened. */
  merge: boolean;
  /** Rounds of re-offered tasks its red CI has had. */
  ciRounds: number;
  /** Its last red CI, read. */
  failure: CiFailure | null;
  detail: string | null;
  openedAt: number;
  updatedAt: number;
}

const TEAM_PR_PHASES: readonly TeamPr["phase"][] = ["checks", "failed_checks", "green", "merged", "left_open", "failed"];

/**
 * Accepted: complete AND ruled accepted — by the reviewer, or by the rule a
 * shape without a reviewer runs on. `complete` alone is not enough: a task is
 * complete the moment its worker settles, before its review, and a dependent
 * dispatched then was built on work the reviewer went on to reject (seen live,
 * 2026-10-10).
 */
export function isAccepted(task: Pick<TeamTask, "status" | "review">): boolean {
  return task.status === "complete" && task.review?.verdict === "accepted";
}

/** One run's part in the team. */
export interface TeamRunRef {
  id: string;
  role: "planner" | "worker" | "reviewer" | "lead";
  taskId: string | null;
  /**
   * When this run sent each of its team messages (coding-team-messages.ts) —
   * what its caps are counted from. On the cast list rather than read back out
   * of the log, because the log drops its oldest entries and a cap that forgot
   * a message would hand the run another one. Absent on a board from before.
   */
  sentAt?: number[];
  /** Tokens the run spent, from its record once it settled; absent before. */
  tokens?: number;
  /**
   * The same tokens by kind, from the record's own `tokenBreakdown` once it
   * settled; absent before, and on a board from before the field.
   */
  tokenBreakdown?: TokenBreakdown;
  /**
   * The account the run was paid from, and its model there — from its record
   * when it started, the model brought up to what answered once it settled;
   * null where the provider's plan chose and nothing said which. `modelRole`
   * is the role its model choice was made for: `planner` for the lead too.
   * Each ABSENT on a board from before.
   */
  provider?: CodingProvider;
  model?: string | null;
  modelRole?: ModelRole;
}

/** A model id as a run ref keeps it: what a record could carry, never a page of text. */
const MAX_REF_MODEL_CHARS = 120;

/** A run ref's model off disk or a record: the id, null for "the plan's", undefined for nothing readable. */
export function refModel(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  return id && id.length <= MAX_REF_MODEL_CHARS && !/\s/.test(id) ? id : undefined;
}

/** Who worked on a team, counted from the board: the figure the card shows. */
export interface TeamAgents {
  planner: number;
  workers: number;
  reviewers: number;
  leads: number;
  total: number;
}

export interface LogEntry {
  ts: number;
  actor: Actor;
  type: "team_created" | "task" | "status_update" | "result" | "review" | "alert" | "team_status" | "message" | "shape" | "retire" | "final_review" | "note" | "hold" | "ci" | "budget" | "pr" | "repo_map";
  task_id?: string;
  message: string;
  payload?: Record<string, unknown>;
}

/**
 * A `message` entry's payload: who sent it, to whom, and the words — whole,
 * because the board is where the lead reads it. `delivered: false` (with the
 * box's `code`) is a message the run sent that the box had no way to hand on:
 * no chat session, an edition with no such path. Absent means delivered.
 */
export interface TeamMessagePayload {
  from: string;
  to: TeamMessageTarget;
  toRunId?: string;
  text: string;
  delivered?: false;
  code?: TeamMessageRefusal;
}

/**
 * A `note` entry's `undelivered` payload: a team message that never reached
 * its receiver because the receiver had already finished (`NOTED_REFUSALS`) —
 * who sent it, in which role, to whom, and why. The figures count it as an
 * undelivered message and the card words it in the reader's language. The
 * words themselves are not kept: nobody read them, and the sender was told.
 */
export interface UndeliveredNote {
  code: TeamMessageRefusal;
  from: string;
  role: TeamRunRef["role"];
  to: TeamMessageTarget;
  toRunId?: string;
}

export interface TeamBoard {
  id: string;
  goal: string;
  projectId: string | null;
  directory: string;
  /**
   * Who started it. An owner's team is the owner's to read and stop: the
   * MCP bearer — the assistant, and so anything that prompt-injected it —
   * may only see and stop the teams it started itself, the way an
   * owner-sourced run answers 403 to the bearer.
   */
  source: TeamSource;
  status: TeamStatus;
  /** The planner's run, once it started. */
  plannerRunId: string | null;
  /** The team's own branch in the project, and the branch it forked from — null while the team works in place (a code project). */
  branch: string | null;
  base: string | null;
  /** Every run that worked for the team, in order, with its role — the audit's cast list. */
  runs: TeamRunRef[];
  tasks: TeamTask[];
  log: LogEntry[];
  alerts: number;
  error: string | null;
  /** The shape the planner gave the team, or null — then it runs the way every team did before (all the slots, a reviewer per task). */
  shape: TeamShape | null;
  /** The planner's map of what the goal touches, once it gave one; null on a board from before, or a plan without one. */
  repoMap: RepoMap | null;
  /**
   * The plan had ONE task, so it ran as one ordinary run — no team branch, no
   * worktree, no reviewer run of the team's — and the board followed it.
   */
  singleRun: boolean;
  /** The `coding_team_dynamic` switch as it stood when the team started: may a lead add or retire tasks while it runs? */
  dynamic: boolean;
  /**
   * The effort the team was ASKED for (the route's `effort`, the assistant's
   * `coding_team_run`), one of OFFERED_EFFORT_LEVELS — absent when the owner's
   * setting decides, as on every board from before 2026-10-30. The
   * orchestrator hands it to every member run as its input effort; a reading
   * role's cap and the read-only clamp still apply there (a planner asked for
   * ultracode runs at xhigh).
   */
  effort?: CodingEffort;
  /**
   * When the lead's last turn was written (ms): its inbox, and the message
   * that calls it back, are what was said to the lead after this. Set only
   * once that turn gave a usable answer — a lead that failed or answered
   * nothing usable leaves its inbox unread. 0 before its first such turn —
   * and on a board from before the lead had an inbox.
   */
  lastLeadAt: number;
  /** The one review over the merged result (review mode `final`), once it ruled. */
  finalReview: FinalReview | null;
  /** The pull request the goal asked for, once the orchestrator opened it; null for a team whose goal asked for none. */
  pr: TeamPr | null;
  /** The figures, kept current on every save (`teamMetrics`). */
  metrics: TeamMetrics;
  /**
   * The team's runs held back right now until the box has a free slot for
   * them (`teamSpawnSlot`: the owner's limit, the team's own, the memory
   * guard). Absent while nothing waits, and on a settled team.
   */
  slotWaits?: SlotWait[];
  createdAt: number;
  updatedAt: number;
  /** When the team settled (done, failed, stopped); null while it works. */
  finishedAt: number | null;
}

/** One of the team's runs waiting for a free slot on the box: which, why, since when (ms). */
export interface SlotWait {
  role: TeamRunRef["role"];
  taskId: string | null;
  reason: string;
  since: number;
}

export class BoardAccessError extends Error {
  constructor(readonly actor: Actor, readonly action: string, message: string) {
    super(message);
    this.name = "BoardAccessError";
  }
}

export function describeActor(actor: Actor): string {
  return actor.kind === "worker" ? `worker ${actor.id}` : actor.kind;
}

export function newTeamId(): string {
  const bytes = randomBytes(6);
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return `team-${n.toString(36).padStart(8, "0").slice(-8)}`;
}

export const TEAM_ID_RE = /^team-[a-z0-9]{8}$/;
/** t1 … t999, the way the board numbers them — never `t01`, which is not a task on any board. */
export const TASK_ID_RE = /^t[1-9][0-9]{0,2}$/;

// ─── Persistence ─────────────────────────────────────────────────────────────

function boardPath(id: string): string {
  const m = /^team-([a-z0-9]{8})$/.exec(id);
  if (!m) throw new Error(`Not a team id: ${id}`);
  // Built from the match, never from the input, and checked to sit directly
  // under TEAM_DIR before any read or write — the containment guard inline on
  // the very value that reaches the sink, which is what a scanner can follow
  // (the browse route learned this the same way).
  const file = path.resolve(TEAM_DIR, `team-${m[1]}.json`);
  const rel = path.relative(TEAM_DIR, file);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) throw new Error(`Not a team id: ${id}`);
  return file;
}

export function saveBoard(board: TeamBoard): void {
  fs.mkdirSync(TEAM_DIR, { recursive: true, mode: 0o700 });
  const file = boardPath(board.id);
  // The one writer, so the figures on disk are never older than the board they describe.
  board.metrics = teamMetrics(board);
  const tmp = untraced(`${file}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadBoard(id: string): TeamBoard | null {
  if (!TEAM_ID_RE.test(id)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(boardPath(id), "utf8")) as unknown;
    return normalizeBoard(raw);
  } catch {
    return null;
  }
}

export function listBoards(): TeamBoard[] {
  let names: string[];
  try {
    names = fs.readdirSync(TEAM_DIR);
  } catch {
    return [];
  }
  const out: TeamBoard[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const board = loadBoard(name.slice(0, -".json".length));
    if (board) out.push(board);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * A board read back from disk, field by field — a file that parses is not
 * yet a board: a task without `depends_on` would throw in readyTasks, a
 * status outside the machine would never settle. Anything malformed is
 * null, never repaired into a team that runs.
 */
function normalizeBoard(raw: unknown): TeamBoard | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== "string" || !TEAM_ID_RE.test(b.id)) return null;
  if (typeof b.goal !== "string" || typeof b.directory !== "string") return null;
  if (typeof b.status !== "string" || !(TEAM_STATUSES as readonly string[]).includes(b.status)) return null;
  if (!Array.isArray(b.tasks) || !Array.isArray(b.log)) return null;
  const tasks: TeamTask[] = [];
  for (const t of b.tasks as unknown[]) {
    const task = normalizeTask(t);
    if (!task) return null;
    tasks.push(task);
  }
  const log: LogEntry[] = [];
  for (const e of b.log as unknown[]) {
    if (!e || typeof e !== "object") return null;
    const entry = e as Record<string, unknown>;
    const actor = entry.actor as Record<string, unknown> | undefined;
    if (typeof entry.ts !== "number" || typeof entry.type !== "string" || typeof entry.message !== "string") return null;
    if (!actor || typeof actor.kind !== "string") return null;
    if (entry.type === "message") {
      // Re-read, never trusted: this payload is rendered on the card as the
      // words a run said. One that is not a message loses its payload and
      // keeps its line — the audit trail is not repaired, and not dropped.
      const payload = messagePayload(entry.payload);
      log.push({ ...(entry as unknown as LogEntry), ...(payload ? { payload: payload as unknown as Record<string, unknown> } : { payload: undefined }) });
      continue;
    }
    log.push(entry as unknown as LogEntry);
  }
  const finalReview = b.finalReview as Record<string, unknown> | null | undefined;
  // Only an unsettled team has a run waiting; one that is not a wait is dropped.
  const slotWaits = Array.isArray(b.slotWaits) && !isSettledTeamStatus(b.status as TeamStatus)
    ? (b.slotWaits as unknown[]).flatMap((w): SlotWait[] => {
        const wait = w as Record<string, unknown> | null;
        if (!wait || !(RUN_ROLES as readonly unknown[]).includes(wait.role) || typeof wait.reason !== "string" || typeof wait.since !== "number") return [];
        return [{ role: wait.role as SlotWait["role"], taskId: typeof wait.taskId === "string" ? wait.taskId : null, reason: wait.reason, since: wait.since }];
      })
    : [];
  const board: TeamBoard = {
    id: b.id,
    goal: b.goal,
    projectId: typeof b.projectId === "string" ? b.projectId : null,
    directory: b.directory,
    source: b.source === "agent" ? "agent" : "owner",
    status: b.status as TeamStatus,
    plannerRunId: typeof b.plannerRunId === "string" ? b.plannerRunId : null,
    branch: typeof b.branch === "string" ? b.branch : null,
    base: typeof b.base === "string" ? b.base : null,
    runs: Array.isArray(b.runs)
      ? (b.runs as unknown[]).flatMap((r) => {
          const ref = r as Record<string, unknown> | null;
          if (!ref || typeof ref.id !== "string" || !(RUN_ROLES as readonly unknown[]).includes(ref.role)) return [];
          const sentAt = Array.isArray(ref.sentAt)
            ? (ref.sentAt as unknown[]).filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-MAX_TEAM_MESSAGES_PER_RUN)
            : [];
          const run: TeamRunRef = { id: ref.id, role: ref.role as TeamRunRef["role"], taskId: typeof ref.taskId === "string" ? ref.taskId : null, ...(sentAt.length ? { sentAt } : {}) };
          if (typeof ref.tokens === "number" && Number.isFinite(ref.tokens) && ref.tokens >= 0) run.tokens = ref.tokens;
          // Leniently, figure by figure: a bad one reads as 0, a field that is no breakdown as none.
          if (ref.tokenBreakdown && typeof ref.tokenBreakdown === "object" && !Array.isArray(ref.tokenBreakdown)) run.tokenBreakdown = readTokenBreakdown(ref.tokenBreakdown);
          // Who paid and on what: each re-read on its own, absent when the
          // file has none this box could have written — a board from before.
          if (isCodingProvider(ref.provider)) run.provider = ref.provider;
          const model = refModel(ref.model);
          if (model !== undefined) run.model = model;
          // A ref from before 2026-10-30 may say `bulk`: that was a worker's run.
          const modelRole = ref.modelRole === "bulk" ? "worker" : ref.modelRole;
          if ((MODEL_ROLES as readonly unknown[]).includes(modelRole)) run.modelRole = modelRole as ModelRole;
          return [run];
        })
      : [],
    tasks,
    log,
    alerts: typeof b.alerts === "number" ? b.alerts : 0,
    error: typeof b.error === "string" ? b.error : null,
    // A board from before the planner could shape a team has none: it ran the default.
    shape: normalizeShape(b.shape),
    repoMap: normalizeRepoMap(b.repoMap),
    singleRun: b.singleRun === true,
    dynamic: b.dynamic === true,
    // Re-read, never trusted: a level this box does not offer is dropped, and
    // the team runs on the owner's setting as a board without one does.
    ...(isOfferedEffort(b.effort) ? { effort: b.effort } : {}),
    lastLeadAt: typeof b.lastLeadAt === "number" && Number.isFinite(b.lastLeadAt) && b.lastLeadAt > 0 ? b.lastLeadAt : 0,
    finalReview: finalReview && typeof finalReview === "object" && (finalReview.verdict === "accepted" || finalReview.verdict === "rejected") && typeof finalReview.notes === "string"
      ? { verdict: finalReview.verdict, notes: finalReview.notes, at: typeof finalReview.at === "number" ? finalReview.at : 0 }
      : null,
    pr: normalizeTeamPr(b.pr),
    metrics: EMPTY_METRICS,
    ...(slotWaits.length ? { slotWaits } : {}),
    createdAt: typeof b.createdAt === "number" ? b.createdAt : 0,
    updatedAt: typeof b.updatedAt === "number" ? b.updatedAt : 0,
    finishedAt: typeof b.finishedAt === "number" ? b.finishedAt : null,
  };
  // Worked out again rather than trusted from the file: they are the board's, not the file's.
  board.metrics = teamMetrics(board);
  return board;
}

/**
 * A repo map as the planner gave it or as a file holds it, bounded: every
 * list cut to MAX_REPO_MAP_ITEMS entries of MAX_REPO_MAP_ITEM_CHARS on one
 * line each, blanks and repeats dropped, and the lists cut from the end until
 * the rendered map fits MAX_REPO_MAP_CHARS. Advice, not a contract: what is not
 * text is left out, never a reason to refuse a plan. Null when nothing is left.
 * Takes the planner's snake_case (`entry_points`) and the board's camelCase.
 */
export function normalizeRepoMap(raw: unknown): RepoMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const list = (...keys: string[]): string[] => {
    const value = keys.map((k) => r[k]).find((v) => v !== undefined);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      const line = clip(oneLine(item), MAX_REPO_MAP_ITEM_CHARS);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= MAX_REPO_MAP_ITEMS) break;
    }
    return out;
  };
  const map: RepoMap = {
    files: list("files"),
    entryPoints: list("entryPoints", "entry_points"),
    testCommands: list("testCommands", "test_commands"),
    gotchas: list("gotchas"),
  };
  // Over the bound, the longest list gives up its last entry first: one long
  // list of files must not push out the one test command.
  const lists = [map.files, map.entryPoints, map.testCommands, map.gotchas];
  while (repoMapText(map).length > MAX_REPO_MAP_CHARS) {
    const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    if (!longest.length) break;
    longest.pop();
  }
  return lists.some((l) => l.length) ? map : null;
}

/**
 * The map as a run's brief carries it — one line per list, the lists that
 * are empty left out. "" for no map.
 */
export function repoMapText(map: RepoMap | null): string {
  if (!map) return "";
  const lines = [
    map.files.length ? `Files: ${map.files.join("; ")}` : "",
    map.entryPoints.length ? `Entry points: ${map.entryPoints.join("; ")}` : "",
    map.testCommands.length ? `Test commands: ${map.testCommands.join("; ")}` : "",
    map.gotchas.length ? `Gotchas: ${map.gotchas.join("; ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** A shape read back from disk: the planner's fields, or null — never a half-shape that would schedule oddly. */
function normalizeShape(raw: unknown): TeamShape | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.parallelism !== "number" || !Number.isInteger(s.parallelism) || s.parallelism < 1) return null;
  if (!(REVIEW_MODES as readonly unknown[]).includes(s.review)) return null;
  return { parallelism: s.parallelism, review: s.review as ReviewMode, rationale: typeof s.rationale === "string" ? s.rationale.slice(0, MAX_RATIONALE_CHARS) : "" };
}

function messagePayload(raw: unknown): TeamMessagePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.from !== "string" || typeof p.text !== "string") return null;
  if (typeof p.to !== "string" || !(TEAM_MESSAGE_TARGETS as readonly string[]).includes(p.to)) return null;
  return {
    from: p.from,
    to: p.to as TeamMessageTarget,
    ...(typeof p.toRunId === "string" ? { toRunId: p.toRunId } : {}),
    text: p.text.slice(0, MAX_TEAM_MESSAGE_CHARS),
    ...(p.delivered === false ? { delivered: false as const, ...(typeof p.code === "string" ? { code: p.code as TeamMessageRefusal } : {}) } : {}),
  };
}

function normalizeTask(raw: unknown): TeamTask | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.task_id !== "string" || !TASK_ID_RE.test(t.task_id)) return null;
  if (typeof t.task_description !== "string") return null;
  if (typeof t.status !== "string" || !(TASK_STATUSES as readonly string[]).includes(t.status)) return null;
  if (!Array.isArray(t.depends_on) || !t.depends_on.every((d) => typeof d === "string" && TASK_ID_RE.test(d))) return null;
  const review = t.review as Record<string, unknown> | null | undefined;
  if (review !== null && review !== undefined) {
    if (typeof review !== "object" || (review.verdict !== "accepted" && review.verdict !== "rejected") || typeof review.notes !== "string") return null;
  }
  return {
    task_id: t.task_id,
    task_description: t.task_description,
    assigned_to: typeof t.assigned_to === "string" ? t.assigned_to : null,
    status: t.status as TaskStatus,
    result: typeof t.result === "string" ? t.result : null,
    depends_on: t.depends_on as string[],
    files_hint: Array.isArray(t.files_hint) ? (t.files_hint as unknown[]).filter((f): f is string => typeof f === "string") : [],
    review: review ? { verdict: review.verdict as "accepted" | "rejected", notes: review.notes as string, at: typeof review.at === "number" ? review.at : 0 } : null,
    attempts: typeof t.attempts === "number" ? t.attempts : 0,
    worktree: typeof t.worktree === "string" ? t.worktree : null,
    branch: typeof t.branch === "string" ? t.branch : null,
    reviewRunId: typeof t.reviewRunId === "string" ? t.reviewRunId : null,
    origin: t.origin === "lead" ? "lead" : "plan",
    // A board from before the count: a task only goes round again after a
    // rejection, so a second attempt, or a rejection on record, is one.
    rejections: typeof t.rejections === "number" && Number.isInteger(t.rejections) && t.rejections >= 0
      ? t.rejections
      : (t.status === "rejected" || (typeof t.attempts === "number" && t.attempts > 1) || review?.verdict === "rejected" ? 1 : 0),
    // A board from before holds had none.
    holds: typeof t.holds === "number" && Number.isInteger(t.holds) && t.holds >= 0 ? t.holds : 0,
    hold: normalizeHold(t.hold),
    ciReoffers: typeof t.ciReoffers === "number" && Number.isInteger(t.ciReoffers) && t.ciReoffers >= 0 ? t.ciReoffers : 0,
    budgetReoffers: typeof t.budgetReoffers === "number" && Number.isInteger(t.budgetReoffers) && t.budgetReoffers >= 0 ? t.budgetReoffers : 0,
    created_at: typeof t.created_at === "number" ? t.created_at : 0,
    updated_at: typeof t.updated_at === "number" ? t.updated_at : 0,
    // A task's `role` (`bulk`, until 2026-10-30) is not read back: every task is a worker's.
  };
}

/** A team's pull request off disk, or null — every field checked: its number and branch reach `gh`. */
function normalizeTeamPr(raw: unknown): TeamPr | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.number !== "number" || !Number.isInteger(p.number) || p.number <= 0) return null;
  if (typeof p.url !== "string" || typeof p.branch !== "string" || typeof p.base !== "string") return null;
  if (!(TEAM_PR_PHASES as readonly unknown[]).includes(p.phase)) return null;
  const c = p.checks && typeof p.checks === "object" ? p.checks as Record<string, unknown> : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const f = p.failure && typeof p.failure === "object" ? p.failure as Record<string, unknown> : null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 40) : []);
  return {
    number: p.number,
    url: p.url,
    branch: p.branch,
    base: p.base,
    phase: p.phase as TeamPr["phase"],
    checks: { total: n(c.total), passed: n(c.passed), failed: n(c.failed), pending: n(c.pending) },
    merge: p.merge === true,
    ciRounds: n(p.ciRounds),
    failure: f && typeof f.prNumber === "number"
      ? { prNumber: f.prNumber, at: n(f.at), checks: strings(f.checks), tests: strings(f.tests), files: strings(f.files), excerpt: typeof f.excerpt === "string" ? f.excerpt.slice(0, 4_000) : "", unread: strings(f.unread) }
      : null,
    detail: typeof p.detail === "string" ? p.detail.slice(0, 1_000) : null,
    openedAt: n(p.openedAt),
    updatedAt: n(p.updatedAt),
  };
}

function normalizeHold(raw: unknown): TaskHold | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.dependency !== "string" || !TASK_ID_RE.test(h.dependency) || typeof h.reason !== "string") return null;
  return {
    dependency: h.dependency,
    reason: h.reason.slice(0, MAX_HOLD_REASON_CHARS),
    was: h.was === "in_progress" ? "in_progress" : "complete",
    at: typeof h.at === "number" ? h.at : 0,
  };
}

/** A hold's reason, as the board keeps it and the next worker reads it. */
export const MAX_HOLD_REASON_CHARS = 600;

// ─── Mutations (every one role-checked and logged) ───────────────────────────

export function createBoard(input: { goal: string; projectId: string | null; directory: string; source: TeamSource; dynamic?: boolean; effort?: CodingEffort | null }, actor: Actor): TeamBoard {
  if (actor.kind !== "owner" && actor.kind !== "system") {
    throw new BoardAccessError(actor, "create", `Only the owner starts a team; ${describeActor(actor)} may not.`);
  }
  const goal = input.goal.trim();
  if (!goal) throw new Error("A team needs a goal.");
  if (goal.length > MAX_GOAL_CHARS) throw new Error(`The goal is too long (${goal.length} > ${MAX_GOAL_CHARS} characters).`);
  const now = Date.now();
  const board: TeamBoard = {
    id: newTeamId(),
    goal,
    projectId: input.projectId,
    directory: input.directory,
    source: input.source,
    status: "planning",
    plannerRunId: null,
    branch: null,
    base: null,
    runs: [],
    tasks: [],
    log: [],
    alerts: 0,
    error: null,
    shape: null,
    repoMap: null,
    singleRun: false,
    dynamic: input.dynamic === true,
    ...(input.effort ? { effort: input.effort } : {}),
    lastLeadAt: 0,
    finalReview: null,
    pr: null,
    metrics: EMPTY_METRICS,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  append(board, { ts: now, actor, type: "team_created", message: `Team created for: ${firstLine(goal)}` });
  board.metrics = teamMetrics(board, now);
  return board;
}

/**
 * The Planner sizes the team: how many workers side by side, and how the work
 * is reviewed. Nobody else may, and only once. `boxWidth` is how many runs the
 * box lets go at once (the owner's Settings): the log line says so when the
 * shape asks for more than that, since the extra workers only wait for a seat.
 */
export function setShape(board: TeamBoard, actor: Actor, shape: TeamShape, boxWidth?: number): TeamShape {
  if (actor.kind !== "planner") throw new BoardAccessError(actor, "shape", `Only the planner shapes the team; ${describeActor(actor)} may not.`);
  if (board.shape) throw new Error("The team already has its shape.");
  if (!Number.isInteger(shape.parallelism) || shape.parallelism < 1) throw new Error("A team's parallelism is a whole number of at least 1.");
  if (!REVIEW_MODES.includes(shape.review)) throw new Error(`A team's review is ${REVIEW_MODES.join(", ")}.`);
  const rationale = shape.rationale.trim();
  if (rationale.length > MAX_RATIONALE_CHARS) throw new Error(`The shape's rationale is too long (${rationale.length} > ${MAX_RATIONALE_CHARS}).`);
  const now = Date.now();
  board.shape = { parallelism: shape.parallelism, review: shape.review, rationale };
  append(board, {
    ts: now,
    actor,
    type: "shape",
    message: `Team shaped: ${shape.parallelism} side by side${typeof boxWidth === "number" && boxWidth < shape.parallelism ? ` (the box allows ${boxWidth} at once)` : ""}, review ${shape.review}${rationale ? ` — ${firstLine(rationale, MAX_RATIONALE_CHARS)}` : ""}`,
    payload: { parallelism: shape.parallelism, review: shape.review },
  });
  return board.shape;
}

/** The Planner maps the parts of the project the goal touches. Nobody else may, and only once. */
export function setRepoMap(board: TeamBoard, actor: Actor, raw: unknown): RepoMap {
  if (actor.kind !== "planner") throw new BoardAccessError(actor, "repo_map", `Only the planner maps the project; ${describeActor(actor)} may not.`);
  if (board.repoMap) throw new Error("The team already has its repo map.");
  const map = normalizeRepoMap(raw);
  if (!map) throw new Error("The repo map is empty.");
  board.repoMap = map;
  const counts = [
    map.files.length ? `${map.files.length} file(s)` : "",
    map.entryPoints.length ? `${map.entryPoints.length} entry point(s)` : "",
    map.testCommands.length ? `${map.testCommands.length} test command(s)` : "",
    map.gotchas.length ? `${map.gotchas.length} gotcha(s)` : "",
  ].filter(Boolean);
  append(board, { ts: Date.now(), actor, type: "repo_map", message: `Repo map: ${counts.join(", ")}` });
  return map;
}

/**
 * The Planner posts a task. Nobody else may. A task the LEAD adds while the
 * team runs is posted the same way, in the planner's name, with `origin:
 * "lead"` — and at most MAX_LEAD_ADDS of those over the team's life.
 */
export function postTask(
  board: TeamBoard,
  actor: Actor,
  input: { task_description: string; depends_on?: string[]; files_hint?: string[]; origin?: "plan" | "lead"; note?: string },
): TeamTask {
  if (actor.kind !== "planner") throw new BoardAccessError(actor, "post_task", `Only the planner posts tasks; ${describeActor(actor)} may not.`);
  if (board.tasks.length >= MAX_TEAM_TASKS) throw new Error(`A team holds at most ${MAX_TEAM_TASKS} tasks.`);
  const origin = input.origin === "lead" ? "lead" : "plan";
  if (origin === "lead" && board.tasks.filter((t) => t.origin === "lead").length >= MAX_LEAD_ADDS) {
    throw new Error(`The lead may add at most ${MAX_LEAD_ADDS} tasks to a team.`);
  }
  const description = input.task_description.trim();
  if (!description) throw new Error("A task needs a description.");
  if (description.length > MAX_TASK_DESCRIPTION_CHARS) throw new Error(`A task description is too long (${description.length} > ${MAX_TASK_DESCRIPTION_CHARS}).`);
  const known = new Set(board.tasks.map((t) => t.task_id));
  const depends_on = [...new Set((input.depends_on ?? []).filter((d) => typeof d === "string" && TASK_ID_RE.test(d)))];
  const unknown = depends_on.filter((d) => !known.has(d));
  if (unknown.length) throw new Error(`A task depends on tasks that are not on the board: ${unknown.join(", ")}.`);
  const now = Date.now();
  const task: TeamTask = {
    task_id: `t${board.tasks.length + 1}`,
    task_description: description,
    assigned_to: null,
    status: "pending",
    result: null,
    depends_on,
    files_hint: (input.files_hint ?? []).filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()).slice(0, 40),
    review: null,
    attempts: 0,
    worktree: null,
    branch: null,
    reviewRunId: null,
    origin,
    rejections: 0,
    holds: 0,
    hold: null,
    ciReoffers: 0,
    budgetReoffers: 0,
    created_at: now,
    updated_at: now,
  };
  board.tasks.push(task);
  const note = (input.note ?? "").trim();
  append(board, {
    ts: now,
    actor,
    type: "task",
    task_id: task.task_id,
    message: origin === "lead"
      ? `Task ${task.task_id} added by the lead: ${firstLine(description)}${note ? ` — ${firstLine(note, 200)}` : ""}`
      : `Task ${task.task_id} posted: ${firstLine(description)}`,
    payload: { depends_on, files_hint: task.files_hint, ...(origin === "lead" ? { origin, note } : {}) },
  });
  return task;
}

/**
 * The lead retires a task the goal no longer needs — in the planner's name,
 * like every change to the plan. Only a task still PENDING (nobody has
 * started it), and at most MAX_LEAD_RETIRES over the team's life.
 */
export function retireTask(board: TeamBoard, actor: Actor, taskId: string, reason: string): TeamTask {
  if (actor.kind !== "planner") throw new BoardAccessError(actor, "retire", `Only the planner retires tasks; ${describeActor(actor)} may not.`);
  const task = requireTask(board, taskId);
  if (task.status !== "pending") throw new Error(`Task ${taskId} is ${task.status}; only a pending task is retired.`);
  if (board.tasks.filter((t) => t.status === "retired").length >= MAX_LEAD_RETIRES) {
    throw new Error(`A team retires at most ${MAX_LEAD_RETIRES} tasks.`);
  }
  const now = Date.now();
  task.status = "retired";
  task.assigned_to = null;
  task.updated_at = now;
  const why = reason.trim();
  append(board, { ts: now, actor, type: "retire", task_id: taskId, message: `Task ${taskId} retired by the lead${why ? `: ${firstLine(why, 200)}` : ""}`, payload: { note: why } });
  return task;
}

/** The one review over the merged result (review mode `final`): only the reviewer, only once. */
export function recordFinalReview(board: TeamBoard, actor: Actor, verdict: "accepted" | "rejected", notes: string): FinalReview {
  if (actor.kind !== "reviewer") throw new BoardAccessError(actor, "final_review", `Only the reviewer records a verdict; ${describeActor(actor)} may not.`);
  if (board.finalReview) throw new Error("The team's final review is already on record.");
  const now = Date.now();
  board.finalReview = { verdict, notes: notes.slice(0, 2_000), at: now };
  board.updatedAt = now;
  append(board, { ts: now, actor, type: "final_review", message: `Final review ${verdict}${notes ? `: ${firstLine(notes)}` : ""}`, payload: { verdict } });
  return board.finalReview;
}

/**
 * The orchestrator (acting as the system) hands a pending task to a worker:
 * the one assignment step the brief's protocol leaves to the planner's side.
 */
export function assignTask(board: TeamBoard, actor: Actor, taskId: string, workerId: string): TeamTask {
  if (actor.kind !== "planner" && actor.kind !== "system") {
    throw new BoardAccessError(actor, "assign", `Only the planner assigns tasks; ${describeActor(actor)} may not.`);
  }
  const task = requireTask(board, taskId);
  if (task.status !== "pending") throw new Error(`Task ${taskId} is ${task.status}, not pending.`);
  const now = Date.now();
  task.assigned_to = workerId;
  task.attempts += 1;
  // The hold is answered: the worker taking it now was told why in its task text.
  task.hold = null;
  task.updated_at = now;
  append(board, { ts: now, actor, type: "task", task_id: taskId, message: `Task ${taskId} assigned to ${workerId} (attempt ${task.attempts})` });
  return task;
}

/** The brief's Status Update: only the assigned worker, only forward. */
export function updateStatus(board: TeamBoard, actor: Actor, taskId: string, status: "in_progress" | "complete" | "failed"): TeamTask {
  const task = requireTask(board, taskId);
  requireAssignedWorker(actor, task, "update_status");
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    pending: ["in_progress"],
    in_progress: ["complete", "failed"],
    complete: [],
    failed: [],
    rejected: [],
    retired: [],
  };
  if (!allowed[task.status].includes(status)) throw new Error(`Task ${taskId} cannot go from ${task.status} to ${status}.`);
  const now = Date.now();
  task.status = status;
  task.updated_at = now;
  append(board, { ts: now, actor, type: "status_update", task_id: taskId, message: `Task ${taskId} → ${status}`, payload: { status, worker_id: actor.kind === "worker" ? actor.id : null } });
  return task;
}

/** The brief's Result Submission: only the assigned worker. */
export function submitResult(board: TeamBoard, actor: Actor, taskId: string, result: string): TeamTask {
  const task = requireTask(board, taskId);
  requireAssignedWorker(actor, task, "submit_result");
  const now = Date.now();
  task.result = result.length > MAX_RESULT_CHARS ? `${result.slice(0, MAX_RESULT_CHARS)}…` : result;
  task.updated_at = now;
  append(board, { ts: now, actor, type: "result", task_id: taskId, message: `Task ${taskId} result: ${firstLine(result)}`, payload: { worker_id: actor.kind === "worker" ? actor.id : null } });
  return task;
}

/**
 * The Review Loop's verdict. A rejection puts the task back to pending for one
 * more attempt — counted without its holds, which were never its own doing.
 */
export function reviewTask(board: TeamBoard, actor: Actor, taskId: string, verdict: "accepted" | "rejected", notes: string): TeamTask {
  if (actor.kind !== "reviewer") throw new BoardAccessError(actor, "review", `Only the reviewer records a verdict; ${describeActor(actor)} may not.`);
  const task = requireTask(board, taskId);
  if (task.status !== "complete") throw new Error(`Task ${taskId} is ${task.status}; only a complete task is reviewed.`);
  const now = Date.now();
  task.review = { verdict, notes: notes.slice(0, 2_000), at: now };
  if (verdict === "rejected") {
    task.rejections += 1;
    task.status = countedAttempts(task) >= 2 ? "rejected" : "pending";
    task.assigned_to = null;
  }
  task.updated_at = now;
  append(board, { ts: now, actor, type: "review", task_id: taskId, message: `Task ${taskId} ${verdict}${notes ? `: ${firstLine(notes)}` : ""}`, payload: { verdict } });
  return task;
}

/**
 * A task its review just sent back that gets NO further attempt — the one run
 * of a plan run as a single run (coding-team.ts runAsSingleRun) was every
 * attempt there is — closed as `rejected` for good, rather than left pending
 * on a team that has settled. The system's alone; the review's line already
 * says why.
 */
export function closeRejected(board: TeamBoard, actor: Actor, taskId: string): TeamTask {
  if (actor.kind !== "system") throw new BoardAccessError(actor, "close_rejected", `Only the system closes a rejected task; ${describeActor(actor)} may not.`);
  const task = requireTask(board, taskId);
  if (task.review?.verdict !== "rejected" || (task.status !== "pending" && task.status !== "rejected")) {
    throw new Error(`Task ${taskId} is ${task.status}; only a task its review rejected is closed.`);
  }
  task.status = "rejected";
  task.assigned_to = null;
  task.updated_at = Date.now();
  board.updatedAt = task.updated_at;
  return task;
}

/**
 * HOLD a task that started on a dependency which has since been rejected or
 * reopened: the system's, and only for a task that really depends on it and
 * that started — a running attempt (the orchestrator stops its worker and
 * sets its work aside first) or a finished one (its result is set aside; what
 * it merged stays on the team's branch for the next attempt to build on).
 *
 * Back to pending, unassigned and unreviewed, so it starts again only once the
 * dependency is accepted again (`readyTasks`) — on the new merged state. The
 * attempt is counted as a HOLD, never against the task's two tries, and the
 * why goes on the board and into the next worker's task text.
 */
export function holdTask(board: TeamBoard, actor: Actor, taskId: string, dependency: string, reason: string): TeamTask {
  if (actor.kind !== "system") throw new BoardAccessError(actor, "hold", `Only the system holds a task; ${describeActor(actor)} may not.`);
  const task = requireTask(board, taskId);
  if (task.status !== "in_progress" && task.status !== "complete") throw new Error(`Task ${taskId} is ${task.status}; only a task that started is held.`);
  if (!task.depends_on.includes(dependency)) throw new Error(`Task ${taskId} does not depend on ${dependency}.`);
  const was = task.status;
  const why = firstLine(reason.trim(), MAX_HOLD_REASON_CHARS);
  const now = Date.now();
  task.status = "pending";
  task.assigned_to = null;
  task.review = null;
  task.holds += 1;
  task.hold = { dependency, reason: why, was, at: now };
  task.updated_at = now;
  append(board, {
    ts: now,
    actor,
    type: "hold",
    task_id: taskId,
    message: `Task ${taskId} held: its dependency ${dependency} was reopened${why ? ` (${firstLine(why, 200)})` : ""}. ${was === "in_progress" ? "Its worker was stopped and its work set aside" : "Its result is set aside"}; it starts again on the new merged state once ${dependency} is accepted.`,
    payload: { dependency, was },
  });
  return task;
}

/**
 * The team's pull request came back RED: a task its failure points at goes
 * back to pending with the failure as its notes — the system's, never a
 * reviewer's (nobody judged the work), and never against the task's two tries
 * (`ciReoffers`; the team's CI rounds are the bound). Its next worker reads
 * the failure as "a previous attempt was rejected"; what started on it is
 * held, as for any reopening.
 */
export function reopenForCi(board: TeamBoard, actor: Actor, taskId: string, notes: string): TeamTask {
  if (actor.kind !== "system") throw new BoardAccessError(actor, "ci_reopen", `Only the system re-offers a task for the team's CI; ${describeActor(actor)} may not.`);
  const task = requireTask(board, taskId);
  if (task.status !== "complete") throw new Error(`Task ${taskId} is ${task.status}; only a complete task is re-offered for the CI.`);
  const now = Date.now();
  task.review = { verdict: "rejected", notes: notes.slice(0, 2_000), at: now };
  task.rejections += 1;
  task.ciReoffers += 1;
  task.status = "pending";
  task.assigned_to = null;
  task.updated_at = now;
  append(board, { ts: now, actor, type: "ci", task_id: taskId, message: `Task ${taskId} re-offered for the pull request's failing checks: ${firstLine(notes)}` });
  return task;
}

/**
 * The team STOPPED a worker itself — held (paused) past RUN_BUDGET_MS with
 * nobody resuming it — and offers the task once more: back to pending with
 * the why as its notes, the system's (nobody judged the work), never against
 * the task's two tries (`budgetReoffers`; the orchestrator offers it once).
 * Its next worker reads the why as "a previous attempt was rejected".
 */
export function reopenAfterStop(board: TeamBoard, actor: Actor, taskId: string, notes: string): TeamTask {
  if (actor.kind !== "system") throw new BoardAccessError(actor, "budget_reopen", `Only the system re-offers a task it stopped; ${describeActor(actor)} may not.`);
  const task = requireTask(board, taskId);
  if (task.status !== "in_progress") throw new Error(`Task ${taskId} is ${task.status}; only a task at work is re-offered after a stop.`);
  const now = Date.now();
  task.review = { verdict: "rejected", notes: notes.slice(0, 2_000), at: now };
  task.budgetReoffers += 1;
  task.status = "pending";
  task.assigned_to = null;
  task.updated_at = now;
  append(board, { ts: now, actor, type: "budget", task_id: taskId, message: `Task ${taskId} re-offered after the team stopped its worker: ${firstLine(notes)}` });
  return task;
}

/** The orchestrator records where the team's pull request stands — opened, checked, re-offered, merged. The system's alone. */
export function recordTeamPr(board: TeamBoard, actor: Actor, pr: TeamPr, note: string): TeamPr {
  if (actor.kind !== "system") throw new BoardAccessError(actor, "pr", `Only the system records the team's pull request; ${describeActor(actor)} may not.`);
  const now = Date.now();
  board.pr = { ...pr, updatedAt: now };
  board.updatedAt = now;
  append(board, { ts: now, actor, type: "pr", message: firstLine(note, 600), payload: { number: pr.number, phase: pr.phase } });
  return board.pr;
}

/** A guardrail spoke: recorded, counted, never silent. */
export function raiseAlert(board: TeamBoard, actor: Actor, reason: string, taskId?: string): void {
  const now = Date.now();
  board.alerts += 1;
  board.updatedAt = now;
  append(board, { ts: now, actor, type: "alert", task_id: taskId, message: `ALERT: ${firstLine(reason, 300)}` });
}

/**
 * A guardrail line that is NOT an alert: on the record, never counted toward
 * the team's alert ceiling. Only the system (the orchestrator) writes one —
 * today, a worker whose every refusal only LOOKED (`readOnlyDenial`) or wrote
 * outside its folders (`outsideFolderWriteDenial`), with how many, which the
 * figures count; a plan's text cut to fit its bound (`clippedNote`), every
 * cut on one line; a reviewer asked once more for the verdict its answer
 * lacked (`verdictOf`, TASK-1323); and a team message whose receiver had
 * already finished (`undelivered`, from `TeamBus.refuse`), which the figures
 * count too.
 */
export function postNote(board: TeamBoard, actor: Actor, text: string, taskId?: string, readOnlyRefusals?: number, undelivered?: UndeliveredNote): void {
  if (actor.kind !== "system") throw new BoardAccessError(actor, "note", `Only the system writes a note; ${describeActor(actor)} may not.`);
  const now = Date.now();
  const payload = { ...(readOnlyRefusals ? { readOnlyRefusals } : {}), ...(undelivered ? { undelivered } : {}) };
  append(board, { ts: now, actor, type: "note", task_id: taskId, message: firstLine(text, 600), ...(Object.keys(payload).length ? { payload } : {}) });
}

/**
 * A note's `undelivered` payload read back, or null — for any other entry, and
 * for one whose payload is not the shape `postNote` writes: a board file is
 * re-read, never trusted, and a malformed one is a line, not a figure.
 */
export function undeliveredNoteOf(entry: Pick<LogEntry, "type" | "payload">): UndeliveredNote | null {
  if (entry.type !== "note") return null;
  const u = entry.payload?.undelivered as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  if (typeof u.code !== "string" || typeof u.from !== "string" || !RUN_ID_RE.test(u.from)) return null;
  if (!(RUN_ROLES as readonly unknown[]).includes(u.role)) return null;
  if (typeof u.to !== "string" || !(TEAM_MESSAGE_TARGETS as readonly string[]).includes(u.to)) return null;
  if (u.toRunId !== undefined && (typeof u.toRunId !== "string" || !RUN_ID_RE.test(u.toRunId))) return null;
  return {
    code: u.code as TeamMessageRefusal,
    from: u.from,
    role: u.role as TeamRunRef["role"],
    to: u.to as TeamMessageTarget,
    ...(typeof u.toRunId === "string" ? { toRunId: u.toRunId } : {}),
  };
}

/**
 * A run of the team says something — to a sibling run, to the lead (this
 * board), or to the box's main agent. Only a run on the cast list, in the role
 * it is listed with, may: a worker speaking as another run is refused the way
 * the bus refuses a worker's status update carrying another id. The caps are
 * checked here too, on the timestamps the cast list keeps, so no caller can
 * log a message the run was not allowed to send.
 *
 * Never an alert, and never a change to the alert count: a message is how a
 * run ASKS, and a team that stopped because its workers asked would punish
 * exactly the behaviour this channel exists for.
 */
export function postMessage(
  board: TeamBoard,
  actor: Actor,
  input: { from_run_id: string; to: TeamMessageTarget; to_run_id?: string; text: string; undelivered?: TeamMessageRefusal },
  now = Date.now(),
): TeamRunRef {
  if (actor.kind !== "planner" && actor.kind !== "worker" && actor.kind !== "reviewer") {
    throw new BoardAccessError(actor, "message", `Only a run of the team sends a team message; ${describeActor(actor)} may not.`);
  }
  const from = board.runs.find((r) => r.id === input.from_run_id);
  if (!from || from.role !== actor.kind || (actor.kind === "worker" && actor.id !== input.from_run_id)) {
    throw new BoardAccessError(actor, "message", `${describeActor(actor)} may not send a message as ${input.from_run_id}: that is not its run on this team.`);
  }
  if (!(TEAM_MESSAGE_TARGETS as readonly string[]).includes(input.to)) throw new Error(`A team message goes to ${TEAM_MESSAGE_TARGETS.join(", ")}.`);
  let toRunId: string | undefined;
  if (input.to === "sibling") {
    toRunId = input.to_run_id;
    if (!toRunId) throw new Error("A message to a sibling names its run.");
    if (toRunId === from.id) throw new Error("A run does not send a message to itself.");
    if (!board.runs.some((r) => r.id === toRunId)) throw new Error(`${toRunId} is not a run of this team.`);
  }
  const text = input.text.trim();
  if (!text) throw new Error("A team message needs some text.");
  if (text.length > MAX_TEAM_MESSAGE_CHARS) throw new Error(`A team message is at most ${MAX_TEAM_MESSAGE_CHARS} characters.`);
  const allowance = teamMessageAllowance(from.sentAt ?? [], now);
  if (!allowance.ok) throw new Error(`${from.id} has no team message left ${allowance.scope === "run" ? "in this run" : "in this window"}.`);
  from.sentAt = [...(from.sentAt ?? []), now];
  const whom = input.to === "sibling" ? toRunId : input.to === "lead" ? "the lead" : "the assistant";
  const payload: TeamMessagePayload = {
    from: from.id,
    to: input.to,
    ...(toRunId ? { toRunId } : {}),
    text,
    ...(input.undelivered ? { delivered: false as const, code: input.undelivered } : {}),
  };
  append(board, {
    ts: now,
    actor,
    type: "message",
    ...(from.taskId ? { task_id: from.taskId } : {}),
    message: `${from.role} ${from.id} → ${whom}${input.undelivered ? ` (not delivered: ${input.undelivered})` : ""}: ${firstLine(text)}`,
    payload: payload as unknown as Record<string, unknown>,
  });
  return from;
}

export function setTeamStatus(board: TeamBoard, actor: Actor, status: TeamStatus, note?: string): void {
  if (status === "stopped" && actor.kind !== "owner" && actor.kind !== "system") {
    throw new BoardAccessError(actor, "stop", `Only the owner stops a team; ${describeActor(actor)} may not.`);
  }
  if (actor.kind === "worker" || actor.kind === "planner" || actor.kind === "reviewer") {
    throw new BoardAccessError(actor, "team_status", `${describeActor(actor)} may not change the team's status.`);
  }
  const now = Date.now();
  board.status = status;
  if (status === "failed" && note) board.error = note;
  board.updatedAt = now;
  if (isSettledTeamStatus(status)) {
    board.finishedAt ??= now;
    // Nothing of a settled team waits for anything.
    delete board.slotWaits;
  }
  append(board, { ts: now, actor, type: "team_status", message: `Team → ${status}${note ? `: ${firstLine(note)}` : ""}` });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Pending tasks whose dependencies are all out of the way, in posting order.
 * Out of the way means ACCEPTED (`isAccepted`) — never merely complete: a
 * finished task waiting on its reviewer may still be rejected, and a dependent
 * started on it would build on work that does not stand. A RETIRED dependency
 * is out of the way too: the lead decided the goal does not need it, so what
 * waited on it does not wait forever.
 */
export function readyTasks(board: TeamBoard): TeamTask[] {
  return board.tasks.filter((t) => t.status === "pending" && waitingOn(board, t).length === 0);
}

/** The dependencies of `task` that are not out of the way yet (`readyTasks`), in its own order. */
export function waitingOn(board: Pick<TeamBoard, "tasks">, task: Pick<TeamTask, "depends_on">): string[] {
  return task.depends_on.filter((d) => {
    const dep = board.tasks.find((t) => t.task_id === d);
    return !dep || (dep.status !== "retired" && !isAccepted(dep));
  });
}

/**
 * The dependencies of `task` that will never be accepted — failed, or rejected
 * for good — with their status: what a pending task that never ran was waiting
 * on, said when the team ends.
 */
export function blockedBy(board: Pick<TeamBoard, "tasks">, task: Pick<TeamTask, "depends_on">): Array<{ task_id: string; status: TaskStatus }> {
  return task.depends_on.flatMap((d) => {
    const dep = board.tasks.find((t) => t.task_id === d);
    return dep && (dep.status === "failed" || dep.status === "rejected") ? [{ task_id: d, status: dep.status }] : [];
  });
}

/**
 * The tasks a reopened `taskId` sets back: every task that depends on it
 * directly and that has STARTED (running, or finished whatever its review
 * said), in posting order. A task further down the chain is set back when the
 * one it depends on is held — the hold is itself a reopening.
 */
export function startedDependents(board: Pick<TeamBoard, "tasks">, taskId: string): TeamTask[] {
  return board.tasks.filter((t) => t.depends_on.includes(taskId) && (t.status === "in_progress" || t.status === "complete"));
}

/** True when no task can make progress any more: every task is settled, or the only pending ones wait on a failed task. */
export function isExhausted(board: TeamBoard): boolean {
  if (board.tasks.some((t) => t.status === "in_progress")) return false;
  if (readyTasks(board).length > 0) return false;
  return true;
}

/** Every task is complete and not rejected — or retired, which is neither a failure nor a gap. At least one did the work. */
export function allComplete(board: TeamBoard): boolean {
  return board.tasks.some((t) => t.status === "complete")
    && board.tasks.every((t) => t.status === "retired" || (t.status === "complete" && t.review?.verdict !== "rejected"));
}

/** Done, failed or stopped: nothing more happens to the team (src/lib/coding-team-status.ts, disk-free so the client can ask too). */
export { isSettledTeamStatus };

/** Tools that only look. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch"]);
/** Shell commands that only look, as the first word of a command (`git` below, by its subcommand). */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "find", "ps", "pgrep", "wc", "stat", "file", "which", "echo", "pwd", "test", "[", "cd",
  "diff", "cmp", "realpath", "readlink", "basename", "dirname", "du", "true", "false",
]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set(["status", "log", "diff", "show"]);
/** `find` actions that run or write something. */
const FIND_WRITES = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
/** A bare `NAME=value` word: a shell variable, set for the parts after it. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Variables that steer which program the parts after them run, or how: never set by a command that only looks. */
const STEERING_VARIABLE = /^(?:PATH|IFS|CDPATH|HOME|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|GLOBIGNORE|PS4|PROMPT_COMMAND|LD_\w*|DYLD_\w*|GIT_\w*|\w*PAGER|LESS\w*|RIPGREP_\w*|GREP_\w*)$/i;
/** The runner cuts a refused action's display text at this length (MAX_DENIAL_CHARS, coding-agent.ts): a text that long may hide the rest. */
export const DENIAL_TEXT_CUT = 160;
/** The runner bounds a refused action's whole text (`CodingDenial.fullText`, MAX_DENIAL_FULL_CHARS in coding-agent.ts) at this length. */
export const DENIAL_FULL_TEXT_CUT = 2000;

/**
 * True when a refused action's text may not be all of it: a display text at
 * exactly the runner's cut, or a whole text at its bound. Between the two, a
 * text can only be a record's `fullText`, and that is the whole action.
 */
function mayBeCut(action: string): boolean {
  return action.length === DENIAL_TEXT_CUT || action.length >= DENIAL_FULL_TEXT_CUT;
}

/**
 * True when a refused action, as the runner describes it (`Read: <path>`,
 * `Bash: <command>` — `CodingDenial.fullText` where the record keeps it, else
 * its `text`), only LOOKED: a read-only tool, or a shell command whose every
 * part is a read-only command, or a bare variable assignment, with no
 * redirection into a file and no substitution — however long it is. Anything
 * else — a write, an edit, a command the runner cut, so this cannot read it to
 * the end — is false: the team judges it the way it always did.
 */
export function readOnlyDenial(action: string): boolean {
  const colon = action.indexOf(": ");
  if (colon <= 0) return false;
  const tool = action.slice(0, colon);
  if (READ_ONLY_TOOLS.has(tool)) return true;
  if (tool !== "Bash" || mayBeCut(action)) return false;
  // Output thrown away, or folded into the other stream, writes nothing.
  const command = action.slice(colon + 2).replace(/(?:(?:&>>?|\d?>>?)\s*\/dev\/null|\d?>&\d)(?=[\s;|&]|$)/g, " ");
  // Any other redirection writes a file; a substitution runs a command not seen here.
  if (/[>`]|\$\(|<\(/.test(command)) return false;
  const parts = command.split(/\|\|?|&&?|;|\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => {
    const words = part.split(/\s+/);
    // `M="$CLAWBOX_RUN_ARTIFACTS_DIR/x"` alone names a place for the parts after
    // it and runs nothing. In front of a command (`FOO=1 ls`) it is that
    // command's environment, and below that is not a read-only command.
    if (words.every((w) => SHELL_ASSIGNMENT.test(w))) return words.every((w) => !STEERING_VARIABLE.test(w.slice(0, w.indexOf("="))));
    const word = words[0];
    let rest = words.slice(1);
    if (word === "git") {
      // `git -C <dir> log` is `git log` somewhere else.
      while (rest[0] === "-C" && rest.length > 2) rest = rest.slice(2);
      return READ_ONLY_GIT.has(rest[0]) && !rest.some((w) => w.startsWith("--output"));
    }
    if (!READ_ONLY_COMMANDS.has(word)) return false;
    // `rg --pre <cmd>` runs <cmd> on every file it searches.
    if (word === "rg") return !rest.some((w) => w.startsWith("--pre"));
    return word !== "find" || !rest.some((w) => FIND_WRITES.test(w));
  });
}

/** Tools that may write, as the runner names a refused one. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
/** An absolute path in a refused action's text: at its start, or after a space, a quote, `=`, `(`, `>` or `<`. */
const ABSOLUTE_PATH = /(?:^|[\s"'=(<>])(\/[^\s"'`;|&()<>]*)/;

/**
 * True when a refused WRITE — a file tool, or a shell command — was aimed
 * outside every one of the worker's `folders` (its worktree, the project),
 * judged by the first absolute path in the action's text: a check script in
 * /tmp, a note in the harness's own memory folder. The refusal is the proof
 * it changed nothing, and nothing of the task's was there. No absolute path,
 * one inside a folder, or one the runner's cut may have ended early is false:
 * the team judges it the way it always did.
 */
export function outsideFolderWriteDenial(action: string, folders: readonly string[]): boolean {
  const colon = action.indexOf(": ");
  if (colon <= 0 || !WRITE_TOOLS.has(action.slice(0, colon))) return false;
  const roots = folders.filter((f) => path.posix.isAbsolute(f)).map((f) => path.posix.resolve(f));
  const text = action.slice(colon + 2);
  const found = ABSOLUTE_PATH.exec(text);
  if (!roots.length || !found) return false;
  // Cut by the runner mid-path: the rest may have gone on inside a folder.
  if (mayBeCut(action) && found.index + found[0].length >= text.length) return false;
  const target = path.posix.resolve(found[1]);
  return roots.every((root) => {
    const rel = path.posix.relative(root, target);
    return rel === ".." || rel.startsWith("../");
  });
}

/**
 * The harness's own state in a home folder — `~/.claude` and `~/.claude-ds`:
 * its settings and OAuth token, and under `projects/` every session's
 * transcripts and notes — named at the start of the text, after a space, a
 * quote, `=`, `(`, `<` or `>`, as `~`, `$HOME`, `/root` or `/home/<user>`.
 */
const HARNESS_STATE = /(?:^|[\s"'=(<>])(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[^/\s"'`;|&()<>]+)\/\.claude(?:-ds)?(?=$|[/\s"'`;|&()<>])/;

/**
 * True when a refused action, as the runner describes it, named the
 * harness's own state (`~/.claude-ds/projects/…` and the rest of
 * `HARNESS_STATE`) — or the same folders under this server's own home. No
 * worker's task is in there: a refusal that named it is an alert, a look or a
 * write (`readOnlyDenial` and `outsideFolderWriteDenial` alone would make
 * either a note), unless it named nothing but the run's OWN corner of it
 * (`ownHarnessStateDenial`).
 */
export function harnessStateDenial(action: string): boolean {
  const colon = action.indexOf(": ");
  if (colon <= 0) return false;
  const text = action.slice(colon + 2);
  if (HARNESS_STATE.test(text)) return true;
  const home = path.posix.resolve(os.homedir());
  if (home === "/") return false;
  for (const dir of [".claude", ".claude-ds"]) {
    const root = `${home}/${dir}`;
    for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
      const before = at === 0 ? "" : text[at - 1];
      const after = text[at + root.length] ?? "";
      if ((before === "" || /[\s"'=(<>]/.test(before)) && (after === "" || /[/\s"'`;|&()<>]/.test(after))) return true;
    }
  }
  return false;
}

/** Where the harness keeps one run's own state: its config folder (`harnessStateDir`), the folders it worked in, its session. */
export interface OwnHarnessState {
  /** Absolute: `<home>/.claude-ds`, or `<home>/.claude` for a run on an Anthropic account. */
  stateDir: string;
  /** The run's working folder, and for a worker in a worktree the project too — the harness files its memory under the repository's root. */
  folders: readonly string[];
  sessionId?: string | null;
}

/** The folder the harness keeps a working folder's state in, under `projects/`: every character but a letter or a digit a `-` (as `transcriptPath`, coding-agent.ts). */
export function harnessProjectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/** A path-like word of a refused action's text, after its start, a space, a quote, `=`, `(`, `<` or `>`. */
const PATH_WORD = /(^|[\s"'=(<>])([^\s"'`;|&()<>=]+)/g;
/** What looks at a folder's entries without reading them; the folder itself counts as the run's own only for these. */
const LISTS_ENTRIES: ReadonlySet<string> = new Set(["LS", "Glob", "Read", "ls", "stat", "test", "[", "file", "du", "find", "realpath", "readlink"]);
/** Where a shell word ends: the text's end, a space, or an operator. */
const SHELL_WORD_END = /^(?:$|[\s;|&)<>])/;
/** What a shell expands inside a word — `{..,}`, `$D$D`, `.\.` — any of which can turn a path in the run's corner into `..`. */
const SHELL_EXPANDS = /[$`\\{}]/;
/** A dot-glob (`.*`, `.?`, `.[.]`), which the shell may match to `..`. */
const DOT_GLOB = /^\.[^/]*[*?[]/;

/**
 * True when a refused action named the harness's state ONLY in the run's own
 * corner of it: under its own config folder, `projects/<slug>` of a folder it
 * worked in (`harnessProjectSlug`) — that folder's `memory/`, the run's own
 * session transcript, and the folder itself for a read-only command that only
 * lists it. The harness tells the run it keeps its memory there and the
 * sandbox refuses it anyway (bench, 2026-09-26: a worker's `ls` of it cost a
 * correct task a whole second attempt); a look there saw nothing of anyone
 * else's.
 *
 * Every other mention leaves this false: another project's folder, another
 * session's transcript beside the run's own, a search through the folder, the
 * settings and the credential store, another home, a `..` — written, or made
 * by the shell out of a word (`{..,}`, `.''.`, `$D$D`, `.*`) —, a shell that
 * `cd`s in and names the rest by relative paths. So does a text the runner may
 * have cut, which may name more past the cut.
 */
export function ownHarnessStateDenial(action: string, own: OwnHarnessState): boolean {
  const colon = action.indexOf(": ");
  if (colon <= 0 || mayBeCut(action) || !path.posix.isAbsolute(own.stateDir)) return false;
  const home = path.posix.resolve(os.homedir());
  const projects = path.posix.join(path.posix.resolve(own.stateDir), "projects");
  const slugs = new Set(own.folders.filter((f) => path.posix.isAbsolute(f)).map((f) => harnessProjectSlug(path.posix.resolve(f))));
  if (home === "/" || slugs.size === 0) return false;
  const tool = action.slice(0, colon);
  const text = action.slice(colon + 2);
  if (/(?:^|[\s"'=(<>/])\.\.(?=$|[/\s"'`;|&()<>])/.test(text)) return false;
  const onlyLooks = readOnlyDenial(action);
  const session = own.sessionId ? [own.sessionId, `${own.sessionId}.jsonl`] : [];
  let mine = 0;
  const parts = tool === "Bash" ? text.split(/(\|\|?|&&?|;|\n)/) : [text];
  const rest = parts.map((part, i) => {
    // The separators the split kept, as they were.
    if (i % 2 === 1) return part;
    const command = tool === "Bash" ? part.trim().split(/\s+/)[0] : tool;
    // A shell in there names what it reads next by a relative path: left for `harnessStateDenial` to see.
    if (command === "cd" || command === "pushd") return part;
    return part.replace(PATH_WORD, (word: string, lead: string, token: string, at: number) => {
      // Only a whole word: a quote that splices more on (`memory/.''./x`) makes it another path.
      const next = part.slice(at + word.length);
      const quoted = lead === "\"" || lead === "'";
      if (!(quoted ? next.startsWith(lead) && SHELL_WORD_END.test(next.slice(1)) : SHELL_WORD_END.test(next))) return word;
      const named = token.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
      if (!path.posix.isAbsolute(named)) return word;
      const segments = path.posix.relative(projects, path.posix.normalize(named)).split("/");
      if (segments.some((s) => SHELL_EXPANDS.test(s) || DOT_GLOB.test(s))) return word;
      const [slug, entry, ...more] = segments;
      if (!slugs.has(slug)) return word;
      const corner = entry === undefined || entry === ""
        ? onlyLooks && LISTS_ENTRIES.has(command)
        : entry === "memory" || (session.includes(entry) && (entry === own.sessionId || more.length === 0));
      if (!corner) return word;
      mine += 1;
      return lead;
    });
  }).join("");
  return mine > 0 && !harnessStateDenial(`${tool}: ${rest}`);
}

/**
 * The board, compact, for a worker (or the lead) to read in its task text:
 * one line per task — `t3 [status] — <description> → <result>` — then the
 * latest alerts and messages (what the team's runs said with team_message —
 * to the lead among them —, reviews, retirements). The task named by
 * `forTaskId` is left out: its reader has it in full already — the lead
 * names every task of the batch it was called for.
 *
 * Bounded at `maxChars` (MAX_DIGEST_CHARS at most). Over the bound, the
 * OLDEST lines go first — a task line is as old as its last change, a log
 * line as old as its entry — and a line at the top says how many went.
 */
export function boardDigest(board: TeamBoard, forTaskId: string | readonly string[] | null, maxChars: number = MAX_DIGEST_CHARS): string {
  const max = Math.max(0, Math.min(MAX_DIGEST_CHARS, Math.floor(maxChars)));
  const known = typeof forTaskId === "string" ? [forTaskId] : (forTaskId ?? []);
  const tasks = board.tasks
    .filter((t) => !known.includes(t.task_id))
    .map((t) => ({
      at: t.updated_at,
      text: `${t.task_id} [${t.status}] — ${clip(oneLine(t.task_description), 160)} → ${t.result ? clip(oneLine(t.result), 200) : t.status === "in_progress" ? "(in progress)" : "(not started)"}`,
    }));
  const said = board.log
    .filter((e) => e.type === "alert" || e.type === "message" || e.type === "review" || e.type === "retire" || e.type === "final_review")
    .slice(-DIGEST_LOG_LINES)
    .map((e) => ({ at: e.ts, text: `- ${describeActor(e.actor)}: ${clip(oneLine(e.message), 200)}` }));
  const LOG_HEADER = "Latest alerts and messages:";
  const render = (keptTasks: typeof tasks, keptSaid: typeof said, dropped: number): string => {
    const lines: string[] = [];
    if (dropped > 0) lines.push(`(${dropped} older ${dropped === 1 ? "line" : "lines"} left out)`);
    lines.push(...keptTasks.map((l) => l.text));
    if (keptSaid.length) lines.push(LOG_HEADER, ...keptSaid.map((l) => l.text));
    return lines.join("\n");
  };
  const keptTasks = [...tasks];
  const keptSaid = [...said];
  let dropped = 0;
  let text = render(keptTasks, keptSaid, dropped);
  while (text.length > max && keptTasks.length + keptSaid.length > 0) {
    // The oldest of the two lists' oldest lines; on a tie the task line, which
    // the log line after it is likely about.
    const oldestTask = keptTasks.reduce((best, l, i) => (best < 0 || l.at < keptTasks[best].at ? i : best), -1);
    const logFirst = keptSaid.length > 0 && (oldestTask < 0 || keptSaid[0].at < keptTasks[oldestTask].at);
    if (logFirst) keptSaid.shift();
    else keptTasks.splice(oldestTask, 1);
    dropped += 1;
    text = render(keptTasks, keptSaid, dropped);
  }
  return text.length > max ? clip(text, max) : text;
}

/** Every provider at nothing spent. */
function noProviderTokens(): ProviderTokens {
  return Object.fromEntries(CODING_PROVIDERS.map((p) => [p, 0])) as ProviderTokens;
}

/** Every role at nothing spent, by kind. */
function noRoleBreakdown(): RoleTokenBreakdown {
  return { planner: emptyTokenBreakdown(), worker: emptyTokenBreakdown(), reviewer: emptyTokenBreakdown(), lead: emptyTokenBreakdown() };
}

/** Nothing counted yet: the figures of a board that has only just been made. */
const EMPTY_METRICS: TeamMetrics = {
  plannerRuns: 0, workerRuns: 0, reviewerRuns: 0, leadRuns: 0,
  tasksPlanned: 0, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 0, tasksRejected: 0,
  tokensUsed: 0, tokensByRole: { planner: 0, worker: 0, reviewer: 0, lead: 0 }, tokensByProvider: noProviderTokens(), wallMs: 0,
  tokenBreakdown: emptyTokenBreakdown(), tokenBreakdownByRole: noRoleBreakdown(),
  messagesSent: 0, messagesToLead: 0, messagesToSibling: 0, messagesUndelivered: 0,
  readOnlyRefusals: 0,
};

/** The team's figures, from the board alone. `now` ends the clock of a team still at work. */
export function teamMetrics(board: TeamBoard, now: number = Date.now()): TeamMetrics {
  const agents = teamAgents(board);
  const ended = board.finishedAt ?? (isSettledTeamStatus(board.status) ? board.updatedAt : now);
  // Counted from the log, as it stands: an entry whose payload could not be
  // read back is still a message sent, just not one to anybody in particular.
  const messages = board.log.filter((e) => e.type === "message");
  const payloads = messages.map((e) => e.payload as Partial<TeamMessagePayload> | undefined);
  // A message to a sibling that had finished is a note, not a message entry —
  // still one the run sent, and one nobody got.
  const unreached = board.log.map(undeliveredNoteOf).filter((u): u is UndeliveredNote => u !== null);
  return {
    plannerRuns: agents.planner,
    workerRuns: agents.workers,
    reviewerRuns: agents.reviewers,
    leadRuns: agents.leads,
    tasksPlanned: board.tasks.filter((t) => t.origin !== "lead").length,
    tasksAdded: board.tasks.filter((t) => t.origin === "lead").length,
    tasksRetired: board.tasks.filter((t) => t.status === "retired").length,
    tasksAcceptedFirstTry: board.tasks.filter((t) => t.status === "complete" && t.review?.verdict === "accepted" && countedAttempts(t) === 1).length,
    tasksRejected: board.tasks.filter((t) => t.rejections > 0).length,
    tokensUsed: board.runs.reduce((sum, r) => sum + runTokens(r), 0),
    tokensByRole: board.runs.reduce<RoleTokens>((by, r) => ({ ...by, [r.role]: by[r.role] + runTokens(r) }), { planner: 0, worker: 0, reviewer: 0, lead: 0 }),
    tokenBreakdown: board.runs.reduce((sum, r) => withRunBreakdown(sum, r), emptyTokenBreakdown()),
    tokenBreakdownByRole: board.runs.reduce<RoleTokenBreakdown>((by, r) => ({ ...by, [r.role]: withRunBreakdown(by[r.role], r) }), noRoleBreakdown()),
    // Each run on the account it was paid from; one from before the field is on none.
    tokensByProvider: board.runs.reduce<ProviderTokens>((by, r) => (r.provider ? { ...by, [r.provider]: by[r.provider] + runTokens(r) } : by), noProviderTokens()),
    wallMs: board.createdAt > 0 ? Math.max(0, ended - board.createdAt) : 0,
    messagesSent: messages.length + unreached.length,
    messagesToLead: payloads.filter((p) => p?.to === "lead").length + unreached.filter((u) => u.to === "lead").length,
    messagesToSibling: payloads.filter((p) => p?.to === "sibling").length + unreached.filter((u) => u.to === "sibling").length,
    messagesUndelivered: payloads.filter((p) => p?.delivered === false).length + unreached.length,
    readOnlyRefusals: board.log.reduce((sum, e) => {
      const n = e.type === "note" ? e.payload?.readOnlyRefusals : undefined;
      return sum + (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0);
    }, 0),
  };
}

/** One run's tokens as the figures count them: what its record said once it settled, 0 before. */
function runTokens(r: TeamRunRef): number {
  return typeof r.tokens === "number" && Number.isFinite(r.tokens) && r.tokens >= 0 ? r.tokens : 0;
}

/** A sum with one run's breakdown added: each finite, non-negative figure it holds; none, or a bad one, adds 0. */
function withRunBreakdown(sum: TokenBreakdown, r: TeamRunRef): TokenBreakdown {
  const own = readTokenBreakdown(r.tokenBreakdown);
  return { input: sum.input + own.input, output: sum.output + own.output, cacheCreation: sum.cacheCreation + own.cacheCreation, cacheRead: sum.cacheRead + own.cacheRead };
}

/** Path hints compared: no `./`, no trailing slash, forward slashes. */
function hintKey(hint: string): string {
  return hint.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Do two hints name overlapping files: the same path, or one a folder holding the other? */
function hintsOverlap(a: string, b: string): boolean {
  const x = hintKey(a);
  const y = hintKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Whether a SINGLE run would be cheaper than this team, and why — or null.
 *
 * A team pays for a planner, a reviewer per task and a worktree per worker on
 * top of the work; that is money well spent only when the work splits. Two
 * plans where it does not: ONE task (the team's whole machinery around one
 * run's worth of work — which is why such a plan now runs as one run), and
 * tasks whose `files_hint` mostly overlap (OVERLAP_ADVICE_SHARE of the hinted
 * files named by another task too): they cannot run side by side without
 * merging into each other, so they run in a queue, each worker re-reading what
 * the last one changed. Judged on the PLAN — the tasks the planner posted, not
 * the ones a lead added later — and only where at least two tasks name files.
 */
export function teamAdvice(board: Pick<TeamBoard, "tasks">): TeamAdvice | null {
  const planned = board.tasks.filter((t) => t.origin !== "lead");
  if (planned.length === 1) return { reason: "one_task", overlap: 100 };
  const share = overlapShare(planned);
  if (share === null || share < OVERLAP_ADVICE_SHARE) return null;
  const catchAll = catchAllTasks(planned);
  return { reason: "overlap", overlap: Math.round(share * 100), ...(catchAll.length ? { catchAll } : {}) };
}

/** The share of the hinted files of `tasks` that another of them names too — null where fewer than two tasks name files. */
function overlapShare(tasks: readonly Pick<TeamTask, "files_hint">[]): number | null {
  const hinted = tasks.filter((t) => t.files_hint.some((h) => hintKey(h)));
  if (hinted.length < 2) return null;
  let total = 0;
  let shared = 0;
  for (const task of hinted) {
    const others = hinted.filter((t) => t !== task).flatMap((t) => t.files_hint);
    for (const hint of task.files_hint) {
      if (!hintKey(hint)) continue;
      total += 1;
      if (others.some((o) => hintsOverlap(hint, o))) shared += 1;
    }
  }
  return total === 0 ? null : shared / total;
}

/** Does hint `a` name what hint `b` names: the same path, or a folder holding it? */
function hintCovers(a: string, b: string): boolean {
  const x = hintKey(a);
  const y = hintKey(b);
  return Boolean(x && y) && (x === y || y.startsWith(`${x}/`));
}

/**
 * The planned tasks whose `files_hint` names every file each OTHER hinted
 * planned task names — with at least two such others. A task like that makes
 * every file of the plan "shared" on its own, whatever the rest split into: a
 * planner that could not tell the work apart hedged with one (a blind plan's
 * "integrate everything" task), and so does an honest plan whose last task
 * ties the others together. Which of the two it is, `catchAllLeftOut` says.
 */
export function catchAllTasks(tasks: readonly TeamTask[]): string[] {
  const hinted = tasks.filter((t) => t.origin !== "lead" && t.files_hint.some((h) => hintKey(h)));
  return hinted
    .filter((task) => {
      const others = hinted.filter((t) => t !== task);
      return others.length >= 2 && others.every((o) => o.files_hint.every((h) => !hintKey(h) || task.files_hint.some((mine) => hintCovers(mine, h))));
    })
    .map((t) => t.task_id);
}

/**
 * The plan measured with its catch-all tasks (`catchAllTasks`) left out:
 * `overlapWithout` is the overlap of the rest in percent (null where too few
 * tasks are left to judge), `runsLast` says every catch-all task waits —
 * directly or through another task — on every other planned task. Both
 * together (`leftOut`) is an INTEGRATION step: it runs after the work it
 * names, never beside it, so its files conflict with nothing, and the plan
 * runs as the team it is.
 */
export function catchAllLeftOut(board: Pick<TeamBoard, "tasks">, catchAll: readonly string[]): { overlapWithout: number | null; runsLast: boolean; leftOut: boolean } {
  const planned = board.tasks.filter((t) => t.origin !== "lead");
  const share = overlapShare(planned.filter((t) => !catchAll.includes(t.task_id)));
  const runsLast = catchAll.length > 0 && catchAll.every((id) => {
    const waits = waitsOnTransitively(planned, id);
    return planned.every((t) => t.task_id === id || waits.has(t.task_id));
  });
  return {
    overlapWithout: share === null ? null : Math.round(share * 100),
    runsLast,
    leftOut: runsLast && (share === null || share < OVERLAP_ADVICE_SHARE),
  };
}

/** Every task `taskId` waits on, directly or through another. */
function waitsOnTransitively(tasks: readonly Pick<TeamTask, "task_id" | "depends_on">[], taskId: string): Set<string> {
  const seen = new Set<string>();
  const next = [...(tasks.find((t) => t.task_id === taskId)?.depends_on ?? [])];
  while (next.length) {
    const id = next.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(...(tasks.find((t) => t.task_id === id)?.depends_on ?? []));
  }
  return seen;
}

/**
 * What a planner says when it could not read the project: the words its brief
 * tells it to write then ("source not inspected" — a contract with
 * coding-team-planner.ts PLANNER_BRIEF), and the ways a model says so unasked.
 */
const BLIND_PLAN = /source not inspected|not inspected|no source (was )?read|could not (read|inspect)|unable to (read|inspect)|tools? (were|was|are) unavailable/i;

/**
 * Why a parsed plan reads as written WITHOUT reading the project — or null.
 * Its repo map, its shape's rationale and the prose around its JSON are read;
 * the tasks are not (a task may well ask its worker to inspect something).
 * A plan like that hedges: every repo-map entry "source not inspected", and a
 * catch-all task naming every file because the planner could not tell the
 * work apart.
 */
export function blindPlanReason(answer: string | null | undefined, repoMap: RepoMap | null, shape: TeamShape | null): string | null {
  const said: string[] = [];
  const entries = repoMap ? [...repoMap.files, ...repoMap.entryPoints, ...repoMap.testCommands, ...repoMap.gotchas] : [];
  const hits = entries.map((e) => BLIND_PLAN.exec(e)?.[0]).filter((m): m is string => Boolean(m));
  if (hits.length) said.push(`its repo map says "${hits[0]}" (${hits.length} of ${entries.length} entries)`);
  const rationale = shape ? BLIND_PLAN.exec(shape.rationale) : null;
  if (rationale) said.push(`its shape's rationale says "${rationale[0]}"`);
  const prose = BLIND_PLAN.exec(planProse(answer ?? ""));
  if (prose) said.push(`its answer says "${prose[0]}"`);
  return said.length ? said.join("; ") : null;
}

/** A planner's answer without its JSON: fenced blocks out, and every top-level bracket that parses as JSON. */
function planProse(answer: string): string {
  const text = answer.replace(/```[\s\S]*?(?:```|$)/g, " ");
  let prose = "";
  let from = 0;
  for (const [start, end] of jsonSpans(text)) {
    prose += `${text.slice(from, start)} `;
    from = end + 1;
  }
  return prose + text.slice(from);
}

/**
 * The top-level `[…]` and `{…}` spans of `text` that parse as JSON, in order.
 * Strings are skipped only INSIDE a bracket: a quote in the prose around the
 * plan must not swallow the plan's own opening bracket.
 */
function jsonSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const open: string[] = [];
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && open.length) inString = true;
    else if (ch === "[" || ch === "{") {
      if (!open.length) start = i;
      open.push(ch);
    } else if ((ch === "]" || ch === "}") && open.length) {
      if ((ch === "]") !== (open.pop() === "[")) {
        open.length = 0;
        continue;
      }
      if (open.length) continue;
      try {
        JSON.parse(text.slice(start, i + 1));
        spans.push([start, i]);
      } catch {
        // Prose in brackets, not JSON: it stays prose.
      }
    }
  }
  return spans;
}

// ─── Internals ───────────────────────────────────────────────────────────────

function requireTask(board: TeamBoard, taskId: string): TeamTask {
  const task = board.tasks.find((t) => t.task_id === taskId);
  if (!task) throw new Error(`There is no task ${taskId} on this board.`);
  return task;
}

function requireAssignedWorker(actor: Actor, task: TeamTask, action: string): void {
  if (actor.kind !== "worker") {
    throw new BoardAccessError(actor, action, `Only a worker updates a task; ${describeActor(actor)} may not.`);
  }
  if (task.assigned_to !== actor.id) {
    throw new BoardAccessError(actor, action, `Task ${task.task_id} is assigned to ${task.assigned_to ?? "nobody"}, not to worker ${actor.id}.`);
  }
}

function append(board: TeamBoard, entry: LogEntry): void {
  board.log.push(entry);
  if (board.log.length > MAX_LOG_ENTRIES) board.log.splice(0, board.log.length - MAX_LOG_ENTRIES);
  board.updatedAt = entry.ts;
}

function firstLine(text: string, max = 160): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Every run of whitespace, line breaks included, as one space: a digest line is one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Who worked, from the board's cast list: the planner, every worker run
 * (an attempt is a new worker), every reviewer run, every lead run. A board
 * from before the list is counted from its tasks and its assignment log instead.
 */
export function teamAgents(board: TeamBoard): TeamAgents {
  const planner = new Set<string>();
  const workers = new Set<string>();
  const reviewers = new Set<string>();
  const leads = new Set<string>();
  for (const r of board.runs) {
    if (r.role === "planner") planner.add(r.id);
    else if (r.role === "worker") workers.add(r.id);
    else if (r.role === "lead") leads.add(r.id);
    else reviewers.add(r.id);
  }
  if (board.runs.length === 0) {
    if (board.plannerRunId) planner.add(board.plannerRunId);
    for (const e of board.log) {
      const m = e.type === "task" && e.actor.kind === "system" ? /assigned to (run-[a-z0-9]+)/.exec(e.message) : null;
      if (m) workers.add(m[1]);
    }
    for (const t of board.tasks) {
      if (t.assigned_to) workers.add(t.assigned_to);
      if (t.reviewRunId) reviewers.add(t.reviewRunId);
    }
  }
  return {
    planner: planner.size,
    workers: workers.size,
    reviewers: reviewers.size,
    leads: leads.size,
    total: planner.size + workers.size + reviewers.size + leads.size,
  };
}
