/**
 * The Message Bus of a coding team: the ONE way anything changes the
 * blackboard, and the protocol every message must follow.
 *
 * The brief names three message kinds — Task, Status Update, Result — and
 * two rules: every message is timestamped and logged, and only the Planner
 * assigns while only Workers update status or submit results. This module
 * validates a message's SHAPE (the fields the brief lists, with their types
 * and sizes) and then applies it through `coding-team-board.ts`, which
 * enforces the ROLE. A message that fails either is refused with a reason
 * and is still logged as an alert, because a party sending what it may not
 * send is exactly what the audit trail exists to show.
 *
 * Subscribers hear every accepted message; the orchestrator is one, the UI
 * (through the board file) another. In-process on purpose: workers are
 * child processes with no path to this bus except through the orchestrator
 * that spawned them, which is the isolation the brief asks for.
 */

import {
  type Actor,
  type TeamBoard,
  type TeamTask,
  BoardAccessError,
  assignTask,
  postTask,
  raiseAlert,
  reviewTask,
  saveBoard,
  submitResult,
  updateStatus,
} from "@/lib/coding-team-board";

export type TeamMessage =
  | { type: "task"; task_description: string; depends_on?: string[]; files_hint?: string[] }
  | { type: "assign"; task_id: string; worker_id: string }
  | { type: "status_update"; task_id: string; status: "in_progress" | "complete" | "failed"; worker_id: string }
  | { type: "result"; task_id: string; result: string; worker_id: string }
  | { type: "review"; task_id: string; verdict: "accepted" | "rejected"; notes: string }
  | { type: "alert"; reason: string; task_id?: string };

export interface Delivered {
  ts: number;
  actor: Actor;
  message: TeamMessage;
  task: TeamTask | null;
}

export type Subscriber = (delivered: Delivered, board: TeamBoard) => void;

const TASK_ID = /^t[1-9][0-9]{0,2}$/;
const RUN_ID = /^run-[a-z0-9]{8}$/;

/** The shape check: a plain-English reason, or null when the message is well formed. */
export function validateMessage(m: unknown): string | null {
  if (!m || typeof m !== "object") return "A message must be an object.";
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case "task":
      if (typeof msg.task_description !== "string" || !msg.task_description.trim()) return "A task message needs task_description.";
      if (msg.depends_on !== undefined && (!Array.isArray(msg.depends_on) || !msg.depends_on.every((d) => typeof d === "string" && TASK_ID.test(d)))) return "depends_on must be a list of task ids.";
      if (msg.files_hint !== undefined && (!Array.isArray(msg.files_hint) || !msg.files_hint.every((f) => typeof f === "string"))) return "files_hint must be a list of paths.";
      return null;
    case "assign":
      if (typeof msg.task_id !== "string" || !TASK_ID.test(msg.task_id)) return "assign needs a task_id.";
      if (typeof msg.worker_id !== "string" || !RUN_ID.test(msg.worker_id)) return "assign needs a worker_id (a run id).";
      return null;
    case "status_update":
      if (typeof msg.task_id !== "string" || !TASK_ID.test(msg.task_id)) return "A status update needs a task_id.";
      if (msg.status !== "in_progress" && msg.status !== "complete" && msg.status !== "failed") return "A status update's status is in_progress, complete or failed.";
      if (typeof msg.worker_id !== "string" || !RUN_ID.test(msg.worker_id)) return "A status update needs the worker_id.";
      return null;
    case "result":
      if (typeof msg.task_id !== "string" || !TASK_ID.test(msg.task_id)) return "A result needs a task_id.";
      if (typeof msg.result !== "string") return "A result needs its result text.";
      if (typeof msg.worker_id !== "string" || !RUN_ID.test(msg.worker_id)) return "A result needs the worker_id.";
      return null;
    case "review":
      if (typeof msg.task_id !== "string" || !TASK_ID.test(msg.task_id)) return "A review needs a task_id.";
      if (msg.verdict !== "accepted" && msg.verdict !== "rejected") return "A review's verdict is accepted or rejected.";
      if (typeof msg.notes !== "string") return "A review needs notes (may be empty).";
      return null;
    case "alert":
      if (typeof msg.reason !== "string" || !msg.reason.trim()) return "An alert needs a reason.";
      return null;
    default:
      return `Unknown message type ${String(msg.type)}.`;
  }
}

export class TeamBus {
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly board: TeamBoard) {}

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  /**
   * Validate, apply, persist, deliver. Returns the delivered record, or
   * throws — after logging an alert on the board — when the message is
   * malformed or the actor may not send it. A worker's message must carry
   * its own id: a worker speaking for another is the deviation the brief's
   * guardrails are about.
   */
  send(actor: Actor, message: TeamMessage): Delivered {
    const shape = validateMessage(message);
    if (shape) return this.refuse(actor, message, shape);
    if (actor.kind === "worker" && "worker_id" in message && message.worker_id !== actor.id) {
      return this.refuse(actor, message, `worker ${actor.id} sent a message as ${message.worker_id}`);
    }
    let task: TeamTask | null = null;
    try {
      switch (message.type) {
        case "task": task = postTask(this.board, actor, message); break;
        case "assign": task = assignTask(this.board, actor, message.task_id, message.worker_id); break;
        case "status_update": task = updateStatus(this.board, actor, message.task_id, message.status); break;
        case "result": task = submitResult(this.board, actor, message.task_id, message.result); break;
        case "review": task = reviewTask(this.board, actor, message.task_id, message.verdict, message.notes); break;
        case "alert": raiseAlert(this.board, actor, message.reason, message.task_id); break;
      }
    } catch (err) {
      // A role refusal and a rule refusal ("t1 cannot go from complete to
      // failed", "no such task") are both messages the board would not
      // take: each is logged as an alert and refused the same way, so no
      // caller learns of one only from a thrown Error the log never saw.
      if (err instanceof Error) return this.refuse(actor, message, err.message);
      throw err;
    }
    saveBoard(this.board);
    const delivered: Delivered = { ts: Date.now(), actor, message, task };
    for (const fn of this.subscribers) {
      try { fn(delivered, this.board); } catch { /* a subscriber's failure is its own */ }
    }
    return delivered;
  }

  private refuse(actor: Actor, message: TeamMessage, reason: string): never {
    raiseAlert(this.board, { kind: "system" }, `Refused ${message.type} from ${actor.kind === "worker" ? `worker ${actor.id}` : actor.kind}: ${reason}`, "task_id" in message ? message.task_id : undefined);
    saveBoard(this.board);
    throw new BoardAccessError(actor, message.type, reason);
  }
}
