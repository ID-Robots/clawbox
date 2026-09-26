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
  type ReviewMode,
  type TeamBoard,
  type TeamTask,
  type UndeliveredNote,
  BoardAccessError,
  REVIEW_MODES,
  assignTask,
  postMessage,
  postNote,
  postTask,
  raiseAlert,
  recordFinalReview,
  retireTask,
  reviewTask,
  saveBoard,
  setShape,
  submitResult,
  updateStatus,
} from "@/lib/coding-team-board";
import { MAX_TEAM_MESSAGE_CHARS, NOTED_REFUSALS, TEAM_MESSAGE_TARGETS, type TeamMessageRefusal, type TeamMessageTarget } from "@/lib/coding-team-messages";

export type TeamMessage =
  | { type: "task"; task_description: string; depends_on?: string[]; files_hint?: string[]; origin?: "plan" | "lead"; note?: string }
  | { type: "shape"; parallelism: number; review: ReviewMode; rationale: string }
  | { type: "assign"; task_id: string; worker_id: string }
  | { type: "status_update"; task_id: string; status: "in_progress" | "complete" | "failed"; worker_id: string }
  | { type: "result"; task_id: string; result: string; worker_id: string }
  | { type: "review"; task_id: string; verdict: "accepted" | "rejected"; notes: string }
  | { type: "retire"; task_id: string; reason: string }
  | { type: "final_review"; verdict: "accepted" | "rejected"; notes: string }
  | { type: "alert"; reason: string; task_id?: string }
  /** A guardrail line that is not an alert (postNote): the system's only. */
  | { type: "note"; text: string; task_id?: string; read_only_refusals?: number }
  /**
   * A run of the team speaking (coding-team-messages.ts). `undelivered` is
   * set by the orchestrator for a message the box could not hand on — it is
   * still the run's message, logged as one, never as an alert.
   */
  | { type: "message"; from_run_id: string; to: TeamMessageTarget; to_run_id?: string; text: string; undelivered?: TeamMessageRefusal };

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
      if (msg.origin !== undefined && msg.origin !== "plan" && msg.origin !== "lead") return "A task's origin is plan or lead.";
      if (msg.note !== undefined && typeof msg.note !== "string") return "A task's note must be text.";
      return null;
    case "shape":
      if (typeof msg.parallelism !== "number" || !Number.isInteger(msg.parallelism) || msg.parallelism < 1) return "A shape's parallelism is a whole number of at least 1.";
      if (!(REVIEW_MODES as readonly unknown[]).includes(msg.review)) return `A shape's review is ${REVIEW_MODES.join(", ")}.`;
      if (typeof msg.rationale !== "string") return "A shape needs its rationale (may be empty).";
      return null;
    case "retire":
      if (typeof msg.task_id !== "string" || !TASK_ID.test(msg.task_id)) return "A retirement needs a task_id.";
      if (typeof msg.reason !== "string") return "A retirement needs its reason (may be empty).";
      return null;
    case "final_review":
      if (msg.verdict !== "accepted" && msg.verdict !== "rejected") return "A final review's verdict is accepted or rejected.";
      if (typeof msg.notes !== "string") return "A final review needs notes (may be empty).";
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
    case "note":
      if (typeof msg.text !== "string" || !msg.text.trim()) return "A note needs its text.";
      if (msg.read_only_refusals !== undefined && (typeof msg.read_only_refusals !== "number" || !Number.isInteger(msg.read_only_refusals) || msg.read_only_refusals < 0)) return "read_only_refusals is a whole number.";
      return null;
    case "message":
      if (typeof msg.from_run_id !== "string" || !RUN_ID.test(msg.from_run_id)) return "A team message needs from_run_id (a run id).";
      if (typeof msg.to !== "string" || !(TEAM_MESSAGE_TARGETS as readonly string[]).includes(msg.to)) return `A team message goes to ${TEAM_MESSAGE_TARGETS.join(", ")}.`;
      if (msg.to === "sibling" && (typeof msg.to_run_id !== "string" || !RUN_ID.test(msg.to_run_id))) return "A message to a sibling needs to_run_id (a run id).";
      if (typeof msg.text !== "string" || !msg.text.trim()) return "A team message needs text.";
      if (msg.text.length > MAX_TEAM_MESSAGE_CHARS) return `A team message is at most ${MAX_TEAM_MESSAGE_CHARS} characters.`;
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
    if (actor.kind === "worker" && message.type === "message" && message.from_run_id !== actor.id) {
      return this.refuse(actor, message, `worker ${actor.id} sent a team message as ${message.from_run_id}`);
    }
    let task: TeamTask | null = null;
    try {
      switch (message.type) {
        case "task": task = postTask(this.board, actor, message); break;
        case "shape": setShape(this.board, actor, { parallelism: message.parallelism, review: message.review, rationale: message.rationale }); break;
        case "assign": task = assignTask(this.board, actor, message.task_id, message.worker_id); break;
        case "status_update": task = updateStatus(this.board, actor, message.task_id, message.status); break;
        case "result": task = submitResult(this.board, actor, message.task_id, message.result); break;
        case "review": task = reviewTask(this.board, actor, message.task_id, message.verdict, message.notes); break;
        case "retire": task = retireTask(this.board, actor, message.task_id, message.reason); break;
        case "final_review": recordFinalReview(this.board, actor, message.verdict, message.notes); break;
        case "alert": raiseAlert(this.board, actor, message.reason, message.task_id); break;
        case "note": postNote(this.board, actor, message.text, message.task_id, message.read_only_refusals); break;
        case "message": postMessage(this.board, actor, message); break;
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

  /**
   * Refuse a message: log it as an alert, persist, throw. Public for the one
   * caller that has to refuse on grounds the board cannot see — the team's
   * message route (coding-team.ts), which knows whether a run is still live
   * and whether a sibling can still be told anything — so that refusal reads
   * on the board exactly like the ones the board makes itself.
   *
   * That caller passes its refusal's `code` too. A team message refused only
   * because its receiver had already finished (`NOTED_REFUSALS`) is a race,
   * not the sender's fault: the same line goes on the board as a NOTE with
   * who, to whom and why (`UndeliveredNote`, counted as undelivered), and the
   * team's alert count is not touched. It is refused all the same, and it is
   * on the sender's caps (`TeamRunRef.sentAt`) the way an undelivered message
   * is: no longer bounded by MAX_ALERTS, a run retrying there would otherwise
   * write notes without end and push the log's oldest entries out.
   */
  refuse(actor: Actor, message: TeamMessage, reason: string, code?: TeamMessageRefusal): never {
    const line = `Refused ${message.type} from ${actor.kind === "worker" ? `worker ${actor.id}` : actor.kind}: ${reason}`;
    const unreached = unreachedNote(actor, message, code);
    if (unreached) {
      const from = this.board.runs.find((r) => r.id === unreached.from);
      if (from) from.sentAt = [...(from.sentAt ?? []), Date.now()];
      postNote(this.board, { kind: "system" }, line, undefined, undefined, unreached);
    } else {
      raiseAlert(this.board, { kind: "system" }, line, "task_id" in message ? message.task_id : undefined);
    }
    saveBoard(this.board);
    throw new BoardAccessError(actor, message.type, reason);
  }
}

/**
 * The note a refusal leaves instead of an alert, or null when it is an alert:
 * only a well-formed team message, from a run of the team speaking as itself,
 * refused for a `NOTED_REFUSALS` code. Anything else — a malformed message, a
 * worker speaking as another run — is the alert it always was.
 */
function unreachedNote(actor: Actor, message: TeamMessage, code: TeamMessageRefusal | undefined): UndeliveredNote | null {
  if (!code || !NOTED_REFUSALS.includes(code) || message.type !== "message" || validateMessage(message) !== null) return null;
  if (actor.kind === "owner" || actor.kind === "system" || (actor.kind === "worker" && actor.id !== message.from_run_id)) return null;
  return { code, from: message.from_run_id, role: actor.kind, to: message.to, ...(message.to_run_id ? { toRunId: message.to_run_id } : {}) };
}
