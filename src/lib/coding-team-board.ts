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
import path from "path";
import { randomBytes } from "crypto";
import { DATA_DIR } from "@/lib/config-store";

export const TEAM_DIR = path.join(DATA_DIR, "coding-team");
/** A planner may post this many tasks at most; a bigger plan is a bad plan on a box that runs one worker at a time. */
export const MAX_TEAM_TASKS = 8;
/** The audit log keeps this many entries; the oldest fall off. */
export const MAX_LOG_ENTRIES = 400;
export const MAX_GOAL_CHARS = 4_000;
export const MAX_TASK_DESCRIPTION_CHARS = 2_000;
export const MAX_RESULT_CHARS = 6_000;

export type TeamStatus = "planning" | "working" | "reviewing" | "done" | "failed" | "stopped";
export type TaskStatus = "pending" | "in_progress" | "complete" | "failed" | "rejected";
/** Who asked for the team: the person (a session cookie) or the assistant (the MCP bearer). */
export type TeamSource = "owner" | "agent";

const TEAM_STATUSES: readonly TeamStatus[] = ["planning", "working", "reviewing", "done", "failed", "stopped"];
const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "complete", "failed", "rejected"];

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
  created_at: number;
  updated_at: number;
}

/** One run's part in the team. */
export interface TeamRunRef {
  id: string;
  role: "planner" | "worker" | "reviewer";
  taskId: string | null;
}

/** Who worked on a team, counted from the board: the figure the card shows. */
export interface TeamAgents {
  planner: number;
  workers: number;
  reviewers: number;
  total: number;
}

export interface LogEntry {
  ts: number;
  actor: Actor;
  type: "team_created" | "task" | "status_update" | "result" | "review" | "alert" | "team_status";
  task_id?: string;
  message: string;
  payload?: Record<string, unknown>;
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
  createdAt: number;
  updatedAt: number;
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
  const tmp = `${file}.${process.pid}.tmp`;
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
    log.push(entry as unknown as LogEntry);
  }
  return {
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
          if (!ref || typeof ref.id !== "string" || (ref.role !== "planner" && ref.role !== "worker" && ref.role !== "reviewer")) return [];
          return [{ id: ref.id, role: ref.role as TeamRunRef["role"], taskId: typeof ref.taskId === "string" ? ref.taskId : null }];
        })
      : [],
    tasks,
    log,
    alerts: typeof b.alerts === "number" ? b.alerts : 0,
    error: typeof b.error === "string" ? b.error : null,
    createdAt: typeof b.createdAt === "number" ? b.createdAt : 0,
    updatedAt: typeof b.updatedAt === "number" ? b.updatedAt : 0,
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
    created_at: typeof t.created_at === "number" ? t.created_at : 0,
    updated_at: typeof t.updated_at === "number" ? t.updated_at : 0,
  };
}

// ─── Mutations (every one role-checked and logged) ───────────────────────────

export function createBoard(input: { goal: string; projectId: string | null; directory: string; source: TeamSource }, actor: Actor): TeamBoard {
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
    createdAt: now,
    updatedAt: now,
  };
  append(board, { ts: now, actor, type: "team_created", message: `Team created for: ${firstLine(goal)}` });
  return board;
}

/** The Planner posts a task. Nobody else may. */
export function postTask(
  board: TeamBoard,
  actor: Actor,
  input: { task_description: string; depends_on?: string[]; files_hint?: string[] },
): TeamTask {
  if (actor.kind !== "planner") throw new BoardAccessError(actor, "post_task", `Only the planner posts tasks; ${describeActor(actor)} may not.`);
  if (board.tasks.length >= MAX_TEAM_TASKS) throw new Error(`A team holds at most ${MAX_TEAM_TASKS} tasks.`);
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
    created_at: now,
    updated_at: now,
  };
  board.tasks.push(task);
  append(board, { ts: now, actor, type: "task", task_id: task.task_id, message: `Task ${task.task_id} posted: ${firstLine(description)}`, payload: { depends_on, files_hint: task.files_hint } });
  return task;
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
  append(board, { ts: now, actor, type: "team_status", message: `Team → ${status}${note ? `: ${firstLine(note)}` : ""}` });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Pending tasks whose dependencies are all complete, in posting order. */
export function readyTasks(board: TeamBoard): TeamTask[] {
  const done = new Set(board.tasks.filter((t) => t.status === "complete").map((t) => t.task_id));
  return board.tasks.filter((t) => t.status === "pending" && t.depends_on.every((d) => done.has(d)));
}

/** True when no task can make progress any more: every task is settled, or the only pending ones wait on a failed task. */
export function isExhausted(board: TeamBoard): boolean {
  if (board.tasks.some((t) => t.status === "in_progress")) return false;
  if (readyTasks(board).length > 0) return false;
  return true;
}

export function allComplete(board: TeamBoard): boolean {
  return board.tasks.length > 0 && board.tasks.every((t) => t.status === "complete" && t.review?.verdict !== "rejected");
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

/**
 * Who worked, from the board's cast list: the planner, every worker run
 * (an attempt is a new worker), every reviewer run. A board from before
 * the list is counted from its tasks and its assignment log instead.
 */
export function teamAgents(board: TeamBoard): TeamAgents {
  const planner = new Set<string>();
  const workers = new Set<string>();
  const reviewers = new Set<string>();
  for (const r of board.runs) {
    if (r.role === "planner") planner.add(r.id);
    else if (r.role === "worker") workers.add(r.id);
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
  return { planner: planner.size, workers: workers.size, reviewers: reviewers.size, total: planner.size + workers.size + reviewers.size };
}
