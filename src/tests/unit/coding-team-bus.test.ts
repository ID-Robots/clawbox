/**
 * The Message Bus (src/lib/coding-team-bus.ts): the brief's three message
 * shapes validated before anything touches the board, a worker refused
 * when it speaks as another worker, every refusal itself logged as an
 * alert, every accepted message persisted and delivered to subscribers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let root: string;
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, get DATA_DIR() { return path.join(root, "data"); } };
});

let boardLib: typeof import("@/lib/coding-team-board");
let busLib: typeof import("@/lib/coding-team-bus");

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "team-bus-"));
  vi.resetModules();
  boardLib = await import("@/lib/coding-team-board");
  busLib = await import("@/lib/coding-team-bus");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const W = { kind: "worker", id: "run-aaaaaaaa" } as const;

describe("the protocol", () => {
  it("names what is wrong with a malformed message, per kind", () => {
    const { validateMessage } = busLib;
    expect(validateMessage(null)).toMatch(/object/);
    expect(validateMessage({ type: "task" })).toMatch(/task_description/);
    expect(validateMessage({ type: "task", task_description: "x", depends_on: ["nope"] })).toMatch(/depends_on/);
    expect(validateMessage({ type: "status_update", task_id: "t1", status: "done", worker_id: "run-aaaaaaaa" })).toMatch(/in_progress, complete or failed/);
    expect(validateMessage({ type: "status_update", task_id: "t1", status: "complete" })).toMatch(/worker_id/);
    expect(validateMessage({ type: "result", task_id: "t1", worker_id: "run-aaaaaaaa" })).toMatch(/result text/);
    expect(validateMessage({ type: "review", task_id: "t1", verdict: "meh", notes: "" })).toMatch(/accepted or rejected/);
    expect(validateMessage({ type: "assign", task_id: "t1", worker_id: "bob" })).toMatch(/run id/);
    expect(validateMessage({ type: "party" })).toMatch(/Unknown/);
    expect(validateMessage({ type: "task", task_description: "x", depends_on: ["t1"], files_hint: ["a"] })).toBeNull();
    expect(validateMessage({ type: "result", task_id: "t1", result: "", worker_id: "run-aaaaaaaa" })).toBeNull();
  });
});

describe("sending", () => {
  it("applies an accepted message, persists the board and delivers it to subscribers", () => {
    const board = boardLib.createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    const bus = new busLib.TeamBus(board);
    const seen: string[] = [];
    bus.subscribe((d) => seen.push(`${d.actor.kind}:${d.message.type}`));

    const posted = bus.send({ kind: "planner" }, { type: "task", task_description: "Scaffold", files_hint: ["index.html"] });
    expect(posted.task?.task_id).toBe("t1");
    bus.send({ kind: "system" }, { type: "assign", task_id: "t1", worker_id: W.id });
    bus.send(W, { type: "status_update", task_id: "t1", status: "in_progress", worker_id: W.id });
    bus.send(W, { type: "result", task_id: "t1", result: "done", worker_id: W.id });
    bus.send(W, { type: "status_update", task_id: "t1", status: "complete", worker_id: W.id });
    bus.send({ kind: "reviewer" }, { type: "review", task_id: "t1", verdict: "accepted", notes: "" });
    expect(seen).toEqual(["planner:task", "system:assign", "worker:status_update", "worker:result", "worker:status_update", "reviewer:review"]);
    // On disk after every step.
    const onDisk = boardLib.loadBoard(board.id);
    expect(onDisk?.tasks[0]).toMatchObject({ status: "complete", result: "done", review: { verdict: "accepted" } });
    expect(onDisk?.log.map((e) => e.type)).toEqual(["team_created", "task", "task", "status_update", "result", "status_update", "review"]);
  });

  it("refuses a malformed message, a role that may not send it, and a worker speaking for another — each logged as an alert", () => {
    const board = boardLib.createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    const bus = new busLib.TeamBus(board);
    const delivered: string[] = [];
    bus.subscribe((d) => delivered.push(d.message.type));

    expect(() => bus.send({ kind: "planner" }, { type: "task" } as never)).toThrow(boardLib.BoardAccessError);
    expect(() => bus.send(W, { type: "task", task_description: "a worker's own task" })).toThrow(/Only the planner posts/);
    bus.send({ kind: "planner" }, { type: "task", task_description: "real" });
    bus.send({ kind: "system" }, { type: "assign", task_id: "t1", worker_id: W.id });
    expect(() => bus.send({ kind: "worker", id: "run-bbbbbbbb" }, { type: "status_update", task_id: "t1", status: "in_progress", worker_id: W.id }))
      .toThrow(/sent a message as run-aaaaaaaa/);
    expect(() => bus.send({ kind: "owner" }, { type: "review", task_id: "t1", verdict: "accepted", notes: "" })).toThrow(/Only the reviewer/);

    // Nothing refused reached a subscriber; every refusal is on the board.
    expect(delivered).toEqual(["task", "assign"]);
    const alerts = board.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts).toHaveLength(4);
    expect(alerts[0]).toMatch(/Refused task from planner: A task message needs task_description/);
    expect(alerts[1]).toMatch(/Refused task from worker run-aaaaaaaa: Only the planner posts/);
    expect(alerts[2]).toMatch(/Refused status_update from worker run-bbbbbbbb: worker run-bbbbbbbb sent a message as run-aaaaaaaa/);
    expect(alerts[3]).toMatch(/Refused review from owner/);
    expect(board.alerts).toBe(4);
    expect(boardLib.loadBoard(board.id)?.alerts).toBe(4);
  });

  it("logs a rule refusal — a status that cannot follow, a task that is not there — as an alert too", () => {
    const board = boardLib.createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    const bus = new busLib.TeamBus(board);
    bus.send({ kind: "planner" }, { type: "task", task_description: "real" });
    bus.send({ kind: "system" }, { type: "assign", task_id: "t1", worker_id: W.id });
    expect(() => bus.send(W, { type: "status_update", task_id: "t1", status: "complete", worker_id: W.id })).toThrow(/cannot go from pending to complete/);
    expect(() => bus.send({ kind: "system" }, { type: "assign", task_id: "t7", worker_id: W.id })).toThrow(/no task t7/);
    const alerts = board.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts).toEqual([
      expect.stringMatching(/Refused status_update from worker run-aaaaaaaa: Task t1 cannot go from pending to complete/),
      expect.stringMatching(/Refused assign from system: There is no task t7/),
    ]);
  });

  it("a subscriber that throws does not stop the others or the send", () => {
    const board = boardLib.createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    const bus = new busLib.TeamBus(board);
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((d) => seen.push(d.message.type));
    expect(bus.send({ kind: "planner" }, { type: "task", task_description: "x" }).task?.task_id).toBe("t1");
    expect(seen).toEqual(["task"]);
  });
});

describe("the lead's messages and the shape (TASK-1099)", () => {
  it("validates the shape, a retirement and a final review, and a task's origin", () => {
    const { validateMessage } = busLib;
    expect(validateMessage({ type: "shape", parallelism: 0, review: "each", rationale: "" })).toMatch(/at least 1/);
    expect(validateMessage({ type: "shape", parallelism: 2, review: "often", rationale: "" })).toMatch(/each, final, none/);
    expect(validateMessage({ type: "shape", parallelism: 2, review: "each" })).toMatch(/rationale/);
    expect(validateMessage({ type: "shape", parallelism: 2, review: "final", rationale: "" })).toBeNull();
    expect(validateMessage({ type: "retire", task_id: "t01", reason: "" })).toMatch(/task_id/);
    expect(validateMessage({ type: "retire", task_id: "t2" })).toMatch(/reason/);
    expect(validateMessage({ type: "retire", task_id: "t2", reason: "" })).toBeNull();
    expect(validateMessage({ type: "final_review", verdict: "fine", notes: "" })).toMatch(/accepted or rejected/);
    expect(validateMessage({ type: "final_review", verdict: "accepted", notes: "" })).toBeNull();
    expect(validateMessage({ type: "task", task_description: "x", origin: "boss" })).toMatch(/plan or lead/);
    expect(validateMessage({ type: "task", task_description: "x", origin: "lead", note: 3 })).toMatch(/note/);
  });

  it("applies them in the right role and refuses — and logs — the wrong one", () => {
    const board = boardLib.createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    const bus = new busLib.TeamBus(board);
    const seen: string[] = [];
    bus.subscribe((d) => seen.push(`${d.actor.kind}:${d.message.type}`));
    bus.send({ kind: "planner" }, { type: "shape", parallelism: 1, review: "final", rationale: "One file." });
    bus.send({ kind: "planner" }, { type: "task", task_description: "a" });
    bus.send({ kind: "planner" }, { type: "task", task_description: "b" });
    bus.send({ kind: "planner" }, { type: "task", task_description: "c", origin: "lead", note: "a gap" });
    const retired = bus.send({ kind: "planner" }, { type: "retire", task_id: "t2", reason: "not needed" });
    expect(retired.task).toMatchObject({ task_id: "t2", status: "retired" });
    bus.send({ kind: "reviewer" }, { type: "final_review", verdict: "accepted", notes: "" });
    expect(seen).toEqual(["planner:shape", "planner:task", "planner:task", "planner:task", "planner:retire", "reviewer:final_review"]);
    expect(boardLib.loadBoard(board.id)).toMatchObject({ shape: { parallelism: 1, review: "final" }, finalReview: { verdict: "accepted" }, tasks: [{ status: "pending" }, { status: "retired" }, { origin: "lead" }] });

    expect(() => bus.send(W, { type: "retire", task_id: "t1", reason: "" })).toThrow(/Only the planner retires/);
    expect(() => bus.send({ kind: "planner" }, { type: "retire", task_id: "t2", reason: "" })).toThrow(/t2 is retired/);
    expect(() => bus.send({ kind: "system" }, { type: "shape", parallelism: 2, review: "each", rationale: "" })).toThrow(/Only the planner shapes/);
    expect(() => bus.send({ kind: "owner" }, { type: "final_review", verdict: "rejected", notes: "no" })).toThrow(/Only the reviewer/);
    const alerts = board.log.filter((e) => e.type === "alert").map((e) => e.message);
    expect(alerts).toHaveLength(4);
    expect(alerts[0]).toMatch(/Refused retire from worker run-aaaaaaaa/);
  });
});

describe("a note (a guardrail line that is not an alert)", () => {
  it("is validated, applied for the system without touching the alert count, and refused — as an alert — from anyone else", () => {
    const { validateMessage } = busLib;
    expect(validateMessage({ type: "note", text: " " })).toMatch(/text/);
    expect(validateMessage({ type: "note", text: "x", read_only_refusals: 1.5 })).toMatch(/whole number/);
    expect(validateMessage({ type: "note", text: "x", read_only_refusals: -1 })).toMatch(/whole number/);
    expect(validateMessage({ type: "note", text: "x", task_id: "t1", read_only_refusals: 2 })).toBeNull();
    const board = boardLib.createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    const bus = new busLib.TeamBus(board);
    bus.send({ kind: "system" }, { type: "note", text: "Worker run-aaaaaaaa was refused 2 read-only action(s)", task_id: "t1", read_only_refusals: 2 });
    expect(board.alerts).toBe(0);
    expect(boardLib.loadBoard(board.id)).toMatchObject({ alerts: 0, metrics: { readOnlyRefusals: 2 } });
    expect(() => bus.send(W, { type: "note", text: "nothing to see", read_only_refusals: 5 })).toThrow(/Only the system writes a note/);
    expect(board.alerts).toBe(1);
    expect(board.metrics.readOnlyRefusals).toBe(2);
  });

  it("carries a plan's clip line too: no task, never an alert, never counted as a refusal — and nobody else's", () => {
    expect(busLib.validateMessage({ type: "note", text: "Task t3's description was cut from 2313 to 1987 characters." })).toBeNull();
    const board = boardLib.createBoard({ goal: "g", projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    const bus = new busLib.TeamBus(board);
    bus.send({ kind: "system" }, { type: "note", text: "Task t3's description was cut from 2313 to 1987 characters." });
    expect(board.alerts).toBe(0);
    expect(boardLib.loadBoard(board.id)).toMatchObject({ alerts: 0, metrics: { readOnlyRefusals: 0 } });
    expect(boardLib.loadBoard(board.id)?.log.at(-1)).toMatchObject({ type: "note", actor: { kind: "system" }, message: "Task t3's description was cut from 2313 to 1987 characters." });
    for (const actor of [W, { kind: "planner" } as const]) {
      expect(() => bus.send(actor, { type: "note", text: "hi" })).toThrow(/Only the system writes a note/);
    }
    expect(board.log.filter((e) => e.type === "note")).toHaveLength(1);
  });
});
