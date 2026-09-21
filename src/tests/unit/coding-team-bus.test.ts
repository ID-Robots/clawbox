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
