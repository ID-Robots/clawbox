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
import path, { untraced } from "@/lib/runtime-path";
import { randomBytes } from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import {
  MAX_TEAM_MESSAGE_CHARS,
  MAX_TEAM_MESSAGES_PER_RUN,
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
export const MAX_TASK_DESCRIPTION_CHARS = 2_000;
export const MAX_RESULT_CHARS = 6_000;
/** The lead (the `coding_team_dynamic` switch) may add this many tasks over a team's whole life… */
export const MAX_LEAD_ADDS = 3;
/** …and retire this many, each one still pending when it goes. */
export const MAX_LEAD_RETIRES = 2;
/** A worker's (and the lead's) view of the board is cut to this many characters, oldest lines first. */
export const MAX_DIGEST_CHARS = 2_500;
/** The planner's one-line reason for the team's shape, as the card shows it. */
export const MAX_RATIONALE_CHARS = 200;
/** Log lines of the kinds a teammate should hear about, quoted at the end of the digest. */
const DIGEST_LOG_LINES = 5;

export type TeamStatus = "planning" | "working" | "reviewing" | "done" | "failed" | "stopped";
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
  /** From the team's creation to its end — or to now, while it works. */
  wallMs: number;
  /** Team messages on the log (team_message), and of those: to the lead, to a sibling, and the ones the box could not hand on. */
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

const TEAM_STATUSES: readonly TeamStatus[] = ["planning", "working", "reviewing", "done", "failed", "stopped"];
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
  created_at: number;
  updated_at: number;
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
  type: "team_created" | "task" | "status_update" | "result" | "review" | "alert" | "team_status" | "message" | "shape" | "retire" | "final_review" | "note";
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
  /** The `coding_team_dynamic` switch as it stood when the team started: may a lead add or retire tasks while it runs? */
  dynamic: boolean;
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
  /** The figures, kept current on every save (`teamMetrics`). */
  metrics: TeamMetrics;
  createdAt: number;
  updatedAt: number;
  /** When the team settled (done, failed, stopped); null while it works. */
  finishedAt: number | null;
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
          return [run];
        })
      : [],
    tasks,
    log,
    alerts: typeof b.alerts === "number" ? b.alerts : 0,
    error: typeof b.error === "string" ? b.error : null,
    // A board from before the planner could shape a team has none: it ran the default.
    shape: normalizeShape(b.shape),
    dynamic: b.dynamic === true,
    lastLeadAt: typeof b.lastLeadAt === "number" && Number.isFinite(b.lastLeadAt) && b.lastLeadAt > 0 ? b.lastLeadAt : 0,
    finalReview: finalReview && typeof finalReview === "object" && (finalReview.verdict === "accepted" || finalReview.verdict === "rejected") && typeof finalReview.notes === "string"
      ? { verdict: finalReview.verdict, notes: finalReview.notes, at: typeof finalReview.at === "number" ? finalReview.at : 0 }
      : null,
    metrics: EMPTY_METRICS,
    createdAt: typeof b.createdAt === "number" ? b.createdAt : 0,
    updatedAt: typeof b.updatedAt === "number" ? b.updatedAt : 0,
    finishedAt: typeof b.finishedAt === "number" ? b.finishedAt : null,
  };
  // Worked out again rather than trusted from the file: they are the board's, not the file's.
  board.metrics = teamMetrics(board);
  return board;
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
    created_at: typeof t.created_at === "number" ? t.created_at : 0,
    updated_at: typeof t.updated_at === "number" ? t.updated_at : 0,
  };
}

// ─── Mutations (every one role-checked and logged) ───────────────────────────

export function createBoard(input: { goal: string; projectId: string | null; directory: string; source: TeamSource; dynamic?: boolean }, actor: Actor): TeamBoard {
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
    dynamic: input.dynamic === true,
    lastLeadAt: 0,
    finalReview: null,
    metrics: EMPTY_METRICS,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  append(board, { ts: now, actor, type: "team_created", message: `Team created for: ${firstLine(goal)}` });
  board.metrics = teamMetrics(board, now);
  return board;
}

/** The Planner sizes the team: how many workers side by side, and how the work is reviewed. Nobody else may, and only once. */
export function setShape(board: TeamBoard, actor: Actor, shape: TeamShape): TeamShape {
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
    message: `Team shaped: ${shape.parallelism} side by side, review ${shape.review}${rationale ? ` — ${firstLine(rationale, MAX_RATIONALE_CHARS)}` : ""}`,
    payload: { parallelism: shape.parallelism, review: shape.review },
  });
  return board.shape;
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

/** The Review Loop's verdict. A rejection puts the task back to pending for one more attempt. */
export function reviewTask(board: TeamBoard, actor: Actor, taskId: string, verdict: "accepted" | "rejected", notes: string): TeamTask {
  if (actor.kind !== "reviewer") throw new BoardAccessError(actor, "review", `Only the reviewer records a verdict; ${describeActor(actor)} may not.`);
  const task = requireTask(board, taskId);
  if (task.status !== "complete") throw new Error(`Task ${taskId} is ${task.status}; only a complete task is reviewed.`);
  const now = Date.now();
  task.review = { verdict, notes: notes.slice(0, 2_000), at: now };
  if (verdict === "rejected") {
    task.rejections += 1;
    task.status = task.attempts >= 2 ? "rejected" : "pending";
    task.assigned_to = null;
  }
  task.updated_at = now;
  append(board, { ts: now, actor, type: "review", task_id: taskId, message: `Task ${taskId} ${verdict}${notes ? `: ${firstLine(notes)}` : ""}`, payload: { verdict } });
  return task;
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
 * figures count; and a plan's text cut to fit its bound
 * (`clippedNote`), every cut on one line.
 */
export function postNote(board: TeamBoard, actor: Actor, text: string, taskId?: string, readOnlyRefusals?: number): void {
  if (actor.kind !== "system") throw new BoardAccessError(actor, "note", `Only the system writes a note; ${describeActor(actor)} may not.`);
  const now = Date.now();
  append(board, { ts: now, actor, type: "note", task_id: taskId, message: firstLine(text, 600), ...(readOnlyRefusals ? { payload: { readOnlyRefusals } } : {}) });
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
  if (isSettledTeamStatus(status)) board.finishedAt ??= now;
  append(board, { ts: now, actor, type: "team_status", message: `Team → ${status}${note ? `: ${firstLine(note)}` : ""}` });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Pending tasks whose dependencies are all out of the way, in posting order.
 * A RETIRED dependency is out of the way: the lead decided the goal does not
 * need it, so what waited on it does not wait forever.
 */
export function readyTasks(board: TeamBoard): TeamTask[] {
  const done = new Set(board.tasks.filter((t) => t.status === "complete" || t.status === "retired").map((t) => t.task_id));
  return board.tasks.filter((t) => t.status === "pending" && t.depends_on.every((d) => done.has(d)));
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

/** Done, failed or stopped: nothing more happens to the team. */
export function isSettledTeamStatus(status: TeamStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

/** Tools that only look. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch"]);
/** Shell commands that only look, as the first word of a command (`git` below, by its subcommand). */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(["ls", "cat", "head", "tail", "grep", "rg", "find", "ps", "pgrep", "wc", "stat", "file", "which", "echo", "pwd", "test", "[", "cd"]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set(["status", "log", "diff", "show"]);
/** `find` actions that run or write something. */
const FIND_WRITES = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
/** The runner cuts a refused action's text at this length (describeDenial, coding-agent.ts): a command that long may hide the rest. */
const DENIAL_TEXT_CUT = 160;

/**
 * True when a refused action, as the runner describes it (`Read: <path>`,
 * `Bash: <command>` — `CodingRun.deniedActions`), only LOOKED: a read-only
 * tool, or a shell command whose every part is a read-only command with no
 * redirection into a file and no substitution. Anything else — a write, an
 * edit, a command this cannot read to the end — is false: the team judges it
 * the way it always did.
 */
export function readOnlyDenial(action: string): boolean {
  const colon = action.indexOf(": ");
  if (colon <= 0) return false;
  const tool = action.slice(0, colon);
  if (READ_ONLY_TOOLS.has(tool)) return true;
  if (tool !== "Bash" || action.length >= DENIAL_TEXT_CUT) return false;
  // Output thrown away, or folded into the other stream, writes nothing.
  const command = action.slice(colon + 2).replace(/(?:(?:&>>?|\d?>>?)\s*\/dev\/null|\d?>&\d)(?=[\s;|&]|$)/g, " ");
  // Any other redirection writes a file; a substitution runs a command not seen here.
  if (/[>`]|\$\(|<\(/.test(command)) return false;
  const parts = command.split(/\|\|?|&&?|;|\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => {
    const words = part.split(/\s+/);
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
  if (action.length >= DENIAL_TEXT_CUT && found.index + found[0].length >= text.length) return false;
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
 * `HARNESS_STATE`) — or the same folders under this server's own home. A
 * refused READ of it is never a note (`readOnlyDenial` alone would make it
 * one): no worker's task is in there, and a look into other sessions'
 * transcripts stays an alert. A write there that was refused changed nothing
 * and is judged by `outsideFolderWriteDenial`, as before.
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

/** Nothing counted yet: the figures of a board that has only just been made. */
const EMPTY_METRICS: TeamMetrics = {
  plannerRuns: 0, workerRuns: 0, reviewerRuns: 0, leadRuns: 0,
  tasksPlanned: 0, tasksAdded: 0, tasksRetired: 0, tasksAcceptedFirstTry: 0, tasksRejected: 0,
  tokensUsed: 0, wallMs: 0,
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
  return {
    plannerRuns: agents.planner,
    workerRuns: agents.workers,
    reviewerRuns: agents.reviewers,
    leadRuns: agents.leads,
    tasksPlanned: board.tasks.filter((t) => t.origin !== "lead").length,
    tasksAdded: board.tasks.filter((t) => t.origin === "lead").length,
    tasksRetired: board.tasks.filter((t) => t.status === "retired").length,
    tasksAcceptedFirstTry: board.tasks.filter((t) => t.status === "complete" && t.review?.verdict === "accepted" && t.attempts === 1).length,
    tasksRejected: board.tasks.filter((t) => t.rejections > 0).length,
    tokensUsed: board.runs.reduce((sum, r) => sum + (typeof r.tokens === "number" && Number.isFinite(r.tokens) ? r.tokens : 0), 0),
    wallMs: board.createdAt > 0 ? Math.max(0, ended - board.createdAt) : 0,
    messagesSent: messages.length,
    messagesToLead: payloads.filter((p) => p?.to === "lead").length,
    messagesToSibling: payloads.filter((p) => p?.to === "sibling").length,
    messagesUndelivered: payloads.filter((p) => p?.delivered === false).length,
    readOnlyRefusals: board.log.reduce((sum, e) => {
      const n = e.type === "note" ? e.payload?.readOnlyRefusals : undefined;
      return sum + (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0);
    }, 0),
  };
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
