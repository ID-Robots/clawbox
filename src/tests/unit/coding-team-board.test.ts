/**
 * The Shared Blackboard (src/lib/coding-team-board.ts): the roles the
 * brief names, enforced — only the planner posts, only the assigned worker
 * moves a task or submits a result, only the reviewer rules, only the owner
 * stops — with every accepted change in the audit log, and the board on
 * disk after each one.
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

type Lib = typeof import("@/lib/coding-team-board");
let lib: Lib;

const PLANNER = { kind: "planner" } as const;
const REVIEWER = { kind: "reviewer" } as const;
const OWNER = { kind: "owner" } as const;
const SYSTEM = { kind: "system" } as const;
const worker = (id: string) => ({ kind: "worker", id }) as const;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "team-board-"));
  vi.resetModules();
  lib = await import("@/lib/coding-team-board");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function board() {
  return lib.createBoard({ goal: "Build the invoice app", projectId: null, directory: "/home/clawbox/Projects/inv" }, OWNER);
}

describe("who may do what", () => {
  it("only the owner (or the orchestrator) creates a team", () => {
    expect(() => lib.createBoard({ goal: "x", projectId: null, directory: "/p" }, PLANNER)).toThrow(lib.BoardAccessError);
    expect(lib.createBoard({ goal: "x", projectId: null, directory: "/p" }, SYSTEM).status).toBe("planning");
  });

  it("only the planner posts tasks, numbered in order, with dependencies that exist", () => {
    const b = board();
    for (const who of [worker("run-aaaaaaaa"), REVIEWER, OWNER, SYSTEM]) {
      expect(() => lib.postTask(b, who, { task_description: "nope" })).toThrow(lib.BoardAccessError);
    }
    const t1 = lib.postTask(b, PLANNER, { task_description: "Scaffold the page", files_hint: ["index.html"] });
    const t2 = lib.postTask(b, PLANNER, { task_description: "Wire the form", depends_on: ["t1"] });
    expect([t1.task_id, t2.task_id]).toEqual(["t1", "t2"]);
    expect(t2.depends_on).toEqual(["t1"]);
    expect(() => lib.postTask(b, PLANNER, { task_description: "orphan", depends_on: ["t9"] })).toThrow(/not on the board/);
    expect(b.tasks).toHaveLength(2);
  });

  it("holds at most MAX_TEAM_TASKS tasks", () => {
    const b = board();
    for (let i = 0; i < lib.MAX_TEAM_TASKS; i++) lib.postTask(b, PLANNER, { task_description: `task ${i}` });
    expect(() => lib.postTask(b, PLANNER, { task_description: "one too many" })).toThrow(/at most/);
  });

  it("only the assigned worker moves its task, and only forward", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "do it" });
    // Unassigned: no worker may touch it.
    expect(() => lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "in_progress")).toThrow(/assigned to nobody/);
    // Assigned by the orchestrator (the planner's side of the protocol).
    expect(() => lib.assignTask(b, worker("run-aaaaaaaa"), "t1", "run-aaaaaaaa")).toThrow(lib.BoardAccessError);
    lib.assignTask(b, SYSTEM, "t1", "run-aaaaaaaa");
    // Another worker may not speak for it; the reviewer and the owner may not either.
    expect(() => lib.updateStatus(b, worker("run-bbbbbbbb"), "t1", "in_progress")).toThrow(/not to worker run-bbbbbbbb/);
    expect(() => lib.updateStatus(b, REVIEWER, "t1", "in_progress")).toThrow(lib.BoardAccessError);
    expect(() => lib.submitResult(b, OWNER, "t1", "x")).toThrow(lib.BoardAccessError);
    // The assigned worker: forward only.
    expect(() => lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "complete")).toThrow(/cannot go from pending to complete/);
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "in_progress");
    lib.submitResult(b, worker("run-aaaaaaaa"), "t1", "Built index.html; open it to check.");
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "complete");
    expect(() => lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "failed")).toThrow(/cannot go from complete/);
    expect(b.tasks[0]).toMatchObject({ status: "complete", result: "Built index.html; open it to check.", attempts: 1 });
  });

  it("only the reviewer rules; a rejection reopens the task once, then closes it", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "do it" });
    lib.assignTask(b, SYSTEM, "t1", "run-aaaaaaaa");
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "in_progress");
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "complete");
    expect(() => lib.reviewTask(b, worker("run-aaaaaaaa"), "t1", "accepted", "")).toThrow(lib.BoardAccessError);
    expect(() => lib.reviewTask(b, PLANNER, "t1", "accepted", "")).toThrow(lib.BoardAccessError);
    lib.reviewTask(b, REVIEWER, "t1", "rejected", "The form does not submit.");
    expect(b.tasks[0]).toMatchObject({ status: "pending", assigned_to: null, review: { verdict: "rejected" } });
    // Second attempt, rejected again: closed for good.
    lib.assignTask(b, SYSTEM, "t1", "run-bbbbbbbb");
    lib.updateStatus(b, worker("run-bbbbbbbb"), "t1", "in_progress");
    lib.updateStatus(b, worker("run-bbbbbbbb"), "t1", "complete");
    lib.reviewTask(b, REVIEWER, "t1", "rejected", "Still broken.");
    expect(b.tasks[0].status).toBe("rejected");
    expect(b.tasks[0].attempts).toBe(2);
  });

  it("only the owner stops a team, and no agent role changes the team's status", () => {
    const b = board();
    for (const who of [PLANNER, REVIEWER, worker("run-aaaaaaaa")]) {
      expect(() => lib.setTeamStatus(b, who, "stopped")).toThrow(lib.BoardAccessError);
      expect(() => lib.setTeamStatus(b, who, "done")).toThrow(lib.BoardAccessError);
    }
    lib.setTeamStatus(b, OWNER, "stopped", "Owner pressed Stop");
    expect(b.status).toBe("stopped");
  });
});

describe("the audit log and the file", () => {
  it("logs every accepted change with its actor and time, and writes the board 0600", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "do it" });
    lib.assignTask(b, SYSTEM, "t1", "run-aaaaaaaa");
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "in_progress");
    lib.raiseAlert(b, SYSTEM, "worker run-aaaaaaaa touched a file outside its hint", "t1");
    expect(b.log.map((e) => e.type)).toEqual(["team_created", "task", "task", "status_update", "alert"]);
    expect(b.log.every((e) => typeof e.ts === "number" && e.ts > 0)).toBe(true);
    expect(b.log[3].actor).toEqual(worker("run-aaaaaaaa"));
    expect(b.alerts).toBe(1);

    lib.saveBoard(b);
    const file = path.join(root, "data", "coding-team", `${b.id}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lib.loadBoard(b.id)?.tasks[0].status).toBe("in_progress");
    expect(lib.listBoards().map((x) => x.id)).toEqual([b.id]);
    expect(lib.loadBoard("team-nope")).toBeNull();
    expect(lib.loadBoard("../etc/passwd")).toBeNull();
  });

  it("caps the log, keeping the newest", () => {
    const b = board();
    for (let i = 0; i < lib.MAX_LOG_ENTRIES + 20; i++) lib.raiseAlert(b, SYSTEM, `alert ${i}`);
    expect(b.log).toHaveLength(lib.MAX_LOG_ENTRIES);
    expect(b.log[b.log.length - 1].message).toContain(`alert ${lib.MAX_LOG_ENTRIES + 19}`);
  });
});

describe("scheduling queries", () => {
  it("offers pending tasks whose dependencies are complete, in order, and knows when nothing can move", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "a" });
    lib.postTask(b, PLANNER, { task_description: "b", depends_on: ["t1"] });
    lib.postTask(b, PLANNER, { task_description: "c" });
    expect(lib.readyTasks(b).map((t) => t.task_id)).toEqual(["t1", "t3"]);
    expect(lib.isExhausted(b)).toBe(false);
    lib.assignTask(b, SYSTEM, "t1", "run-aaaaaaaa");
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "in_progress");
    expect(lib.isExhausted(b)).toBe(false);
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "failed");
    // t2 waits on a failed task forever; t3 is still ready.
    expect(lib.readyTasks(b).map((t) => t.task_id)).toEqual(["t3"]);
    lib.assignTask(b, SYSTEM, "t3", "run-bbbbbbbb");
    lib.updateStatus(b, worker("run-bbbbbbbb"), "t3", "in_progress");
    lib.updateStatus(b, worker("run-bbbbbbbb"), "t3", "complete");
    expect(lib.isExhausted(b)).toBe(true);
    expect(lib.allComplete(b)).toBe(false);
  });
});
