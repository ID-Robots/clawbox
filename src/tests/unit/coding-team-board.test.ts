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
  return lib.createBoard({ goal: "Build the invoice app", projectId: null, directory: "/home/clawbox/Projects/inv", source: "owner" }, OWNER);
}

describe("who may do what", () => {
  it("only the owner (or the orchestrator) creates a team", () => {
    expect(() => lib.createBoard({ goal: "x", projectId: null, directory: "/p", source: "owner" }, PLANNER)).toThrow(lib.BoardAccessError);
    expect(lib.createBoard({ goal: "x", projectId: null, directory: "/p", source: "agent" }, SYSTEM).status).toBe("planning");
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

  it("refuses a file that parses but is not a board — a task without depends_on, a status outside the machine", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "do it" });
    lib.saveBoard(b);
    const file = path.join(root, "data", "coding-team", `${b.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.tasks[0].depends_on;
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(lib.loadBoard(b.id)).toBeNull();
    raw.tasks[0].depends_on = [];
    raw.status = "dancing";
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(lib.loadBoard(b.id)).toBeNull();
    raw.status = "working";
    raw.tasks[0].task_id = "t01";
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(lib.loadBoard(b.id)).toBeNull();
    // Put right, it reads back — with the source it was saved with.
    raw.tasks[0].task_id = "t1";
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(lib.loadBoard(b.id)).toMatchObject({ status: "working", source: "owner", tasks: [{ task_id: "t1", depends_on: [] }] });
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

// ─── TASK-1099: the digest, the lead's changes, the shape, the figures ──────

/** A board whose t1 is done and accepted by the reviewer, t2 working, t3 waiting. */
function underway() {
  const b = board();
  lib.postTask(b, PLANNER, { task_description: "Scaffold index.html\nwith the form", files_hint: ["index.html"] });
  lib.postTask(b, PLANNER, { task_description: "Wire app.js", depends_on: ["t1"] });
  lib.postTask(b, PLANNER, { task_description: "Write the README" });
  lib.assignTask(b, SYSTEM, "t1", "run-aaaaaaaa");
  lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "in_progress");
  lib.submitResult(b, worker("run-aaaaaaaa"), "t1", "Built index.html;\n\nopen it.");
  lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "complete");
  lib.reviewTask(b, REVIEWER, "t1", "accepted", "");
  lib.assignTask(b, SYSTEM, "t2", "run-bbbbbbbb");
  lib.updateStatus(b, worker("run-bbbbbbbb"), "t2", "in_progress");
  return b;
}

describe("boardDigest", () => {
  it("is one line per other task, then the latest alerts and messages", () => {
    const b = underway();
    lib.raiseAlert(b, SYSTEM, "Worker run-bbbbbbbb touched files outside its task: secrets.env", "t2");
    expect(lib.boardDigest(b, "t3")).toBe([
      "t1 [complete] — Scaffold index.html with the form → Built index.html; open it.",
      "t2 [in_progress] — Wire app.js → (in progress)",
      "Latest alerts and messages:",
      "- reviewer: Task t1 accepted",
      "- system: ALERT: Worker run-bbbbbbbb touched files outside its task: secrets.env",
    ].join("\n"));
    // The reader's own task is left out; a task nobody started says so.
    expect(lib.boardDigest(b, "t1")).toContain("t3 [pending] — Write the README → (not started)");
    expect(lib.boardDigest(b, "t1")).not.toContain("t1 [");
    expect(lib.boardDigest(b, null)).toContain("t1 [complete]");
  });

  it("cuts each description at 160 and each result at 200, and quotes only the last 5 alerts or messages", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "d".repeat(500) });
    lib.assignTask(b, SYSTEM, "t1", "run-aaaaaaaa");
    lib.updateStatus(b, worker("run-aaaaaaaa"), "t1", "in_progress");
    lib.submitResult(b, worker("run-aaaaaaaa"), "t1", "r".repeat(500));
    for (let i = 1; i <= 8; i++) lib.raiseAlert(b, SYSTEM, `alert number ${i}`);
    const text = lib.boardDigest(b, null);
    const line = text.split("\n")[0];
    expect(line).toBe(`t1 [in_progress] — ${"d".repeat(159)}… → ${"r".repeat(199)}…`);
    const said = text.split("\n").filter((l) => l.startsWith("- "));
    expect(said).toHaveLength(5);
    expect(said[0]).toContain("alert number 4");
    expect(said[4]).toContain("alert number 8");
    // Status updates and results are not "messages": they are the task lines already.
    expect(text).not.toContain("→ in_progress");
  });

  it("stays within 2,500 characters on a full board, dropping the OLDEST lines first and saying so", () => {
    const b = board();
    let now = 1_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (let i = 1; i <= lib.MAX_TEAM_TASKS; i++) {
        now += 10;
        lib.postTask(b, PLANNER, { task_description: `Task ${i} ${"x".repeat(400)}` });
      }
      // Every task done in order, each later than the last; alerts after all of them.
      for (let i = 1; i <= lib.MAX_TEAM_TASKS; i++) {
        now += 10;
        const id = `t${i}`;
        const w = `run-${String(i).padStart(8, "a")}`;
        lib.assignTask(b, SYSTEM, id, w);
        lib.updateStatus(b, worker(w), id, "in_progress");
        lib.submitResult(b, worker(w), id, `Result ${i} ${"y".repeat(400)}`);
        lib.updateStatus(b, worker(w), id, "complete");
      }
      for (let i = 1; i <= 5; i++) { now += 10; lib.raiseAlert(b, SYSTEM, `late alert ${i} ${"z".repeat(300)}`); }
    } finally {
      spy.mockRestore();
    }
    const text = lib.boardDigest(b, null);
    expect(text.length).toBeLessThanOrEqual(lib.MAX_DIGEST_CHARS);
    expect(text).toMatch(/^\(\d+ older lines left out\)/);
    // The oldest tasks went first; the newest task and the newest alert stayed.
    expect(text).not.toContain("t1 [complete]");
    expect(text).toContain(`t${lib.MAX_TEAM_TASKS} [complete]`);
    expect(text).toContain("late alert 5");
    // A tighter room is honoured too, and a room of nothing is nothing.
    expect(lib.boardDigest(b, null, 900).length).toBeLessThanOrEqual(900);
    expect(lib.boardDigest(b, null, 0)).toBe("");
    // Never more than the cap, whatever is asked for.
    expect(lib.boardDigest(b, null, 99_999).length).toBeLessThanOrEqual(lib.MAX_DIGEST_CHARS);
  });

  it("quotes what the team's runs said with team_message — to the lead too — among its latest lines", () => {
    const b = underway();
    b.runs.push({ id: "run-bbbbbbbb", role: "worker", taskId: "t2" });
    lib.postMessage(b, worker("run-bbbbbbbb"), { from_run_id: "run-bbbbbbbb", to: "lead", text: "t2 needs the form ids from index.html first." });
    const text = lib.boardDigest(b, "t3");
    expect(text).toContain("- worker run-bbbbbbbb: worker run-bbbbbbbb → the lead: t2 needs the form ids from index.html first.");
    // After the reviewer's verdict it followed, newest last.
    expect(text.indexOf("Task t1 accepted")).toBeLessThan(text.indexOf("→ the lead"));
  });

  it("is empty for a team of one task with nothing said", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "The only task" });
    expect(lib.boardDigest(b, "t1")).toBe("");
  });
});

describe("the lead's changes: retired tasks and added ones", () => {
  it("retires only a PENDING task, only as the planner, at most MAX_LEAD_RETIRES times, and logs why", () => {
    const b = underway();
    for (const who of [SYSTEM, OWNER, REVIEWER, worker("run-aaaaaaaa")]) {
      expect(() => lib.retireTask(b, who, "t3", "no")).toThrow(lib.BoardAccessError);
    }
    expect(() => lib.retireTask(b, PLANNER, "t1", "done already")).toThrow(/t1 is complete; only a pending task is retired/);
    expect(() => lib.retireTask(b, PLANNER, "t2", "")).toThrow(/t2 is in_progress/);
    lib.retireTask(b, PLANNER, "t3", "t1 already wrote the README");
    expect(b.tasks[2]).toMatchObject({ status: "retired", assigned_to: null });
    expect(b.log[b.log.length - 1]).toMatchObject({ type: "retire", task_id: "t3", actor: PLANNER, message: "Task t3 retired by the lead: t1 already wrote the README" });
    expect(() => lib.retireTask(b, PLANNER, "t3", "again")).toThrow(/t3 is retired/);
    // Terminal: nobody assigns it or moves it.
    expect(() => lib.assignTask(b, SYSTEM, "t3", "run-cccccccc")).toThrow(/t3 is retired, not pending/);
    // The budget: two over the team's life.
    lib.postTask(b, PLANNER, { task_description: "four" });
    lib.postTask(b, PLANNER, { task_description: "five" });
    lib.retireTask(b, PLANNER, "t4", "");
    expect(() => lib.retireTask(b, PLANNER, "t5", "")).toThrow(new RegExp(`at most ${lib.MAX_LEAD_RETIRES}`));
  });

  it("neither blocks nor fails the team: a task waiting on a retired one may start, and a team whose others are complete is complete", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "a" });
    lib.postTask(b, PLANNER, { task_description: "b" });
    lib.postTask(b, PLANNER, { task_description: "c", depends_on: ["t2"] });
    lib.retireTask(b, PLANNER, "t2", "not needed");
    expect(lib.readyTasks(b).map((t) => t.task_id)).toEqual(["t1", "t3"]);
    for (const [id, w] of [["t1", "run-aaaaaaaa"], ["t3", "run-cccccccc"]] as const) {
      lib.assignTask(b, SYSTEM, id, w);
      lib.updateStatus(b, worker(w), id, "in_progress");
      lib.updateStatus(b, worker(w), id, "complete");
    }
    expect(lib.isExhausted(b)).toBe(true);
    expect(lib.allComplete(b)).toBe(true);
    // A board of nothing but retirements did nothing: not complete.
    const idle = board();
    lib.postTask(idle, PLANNER, { task_description: "a" });
    lib.retireTask(idle, PLANNER, "t1", "");
    expect(lib.allComplete(idle)).toBe(false);
  });

  it("takes at most MAX_LEAD_ADDS tasks from the lead, marked as its own, with its note on the record", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "planned" });
    for (let i = 0; i < lib.MAX_LEAD_ADDS; i++) {
      const t = lib.postTask(b, PLANNER, { task_description: `added ${i}`, origin: "lead", note: "t1 showed a gap" });
      expect(t.origin).toBe("lead");
    }
    expect(b.log[b.log.length - 1].message).toBe("Task t4 added by the lead: added 2 — t1 showed a gap");
    expect(() => lib.postTask(b, PLANNER, { task_description: "one more", origin: "lead" })).toThrow(new RegExp(`at most ${lib.MAX_LEAD_ADDS}`));
    // The planner's own tasks are not the lead's budget.
    expect(lib.postTask(b, PLANNER, { task_description: "planned too" }).origin).toBe("plan");
  });
});

describe("the shape and the final review", () => {
  it("is set once, by the planner, within bounds, and logged", () => {
    const b = board();
    expect(() => lib.setShape(b, SYSTEM, { parallelism: 1, review: "final", rationale: "" })).toThrow(lib.BoardAccessError);
    expect(() => lib.setShape(b, PLANNER, { parallelism: 0, review: "final", rationale: "" })).toThrow(/at least 1/);
    expect(() => lib.setShape(b, PLANNER, { parallelism: 1, review: "later" as never, rationale: "" })).toThrow(/each, final, none/);
    expect(() => lib.setShape(b, PLANNER, { parallelism: 1, review: "final", rationale: "r".repeat(201) })).toThrow(/too long/);
    lib.setShape(b, PLANNER, { parallelism: 1, review: "final", rationale: " One file. " });
    expect(b.shape).toEqual({ parallelism: 1, review: "final", rationale: "One file." });
    expect(b.log[b.log.length - 1]).toMatchObject({ type: "shape", message: "Team shaped: 1 side by side, review final — One file." });
    expect(() => lib.setShape(b, PLANNER, { parallelism: 2, review: "each", rationale: "" })).toThrow(/already has its shape/);
  });

  it("records the final review once, and only from the reviewer", () => {
    const b = board();
    expect(() => lib.recordFinalReview(b, PLANNER, "accepted", "")).toThrow(lib.BoardAccessError);
    lib.recordFinalReview(b, REVIEWER, "rejected", "The form never submits.");
    expect(b.finalReview).toMatchObject({ verdict: "rejected", notes: "The form never submits." });
    expect(b.log[b.log.length - 1].message).toBe("Final review rejected: The form never submits.");
    expect(() => lib.recordFinalReview(b, REVIEWER, "accepted", "")).toThrow(/already on record/);
  });
});

describe("teamMetrics", () => {
  it("works the figures out from a fixture board", () => {
    const b = board();
    b.createdAt = 1_000;
    b.runs = [
      { id: "run-plan0001", role: "planner", taskId: null, tokens: 1_200 },
      { id: "run-work0001", role: "worker", taskId: "t1", tokens: 5_000 },
      { id: "run-revw0001", role: "reviewer", taskId: "t1", tokens: 800 },
      { id: "run-lead0001", role: "lead", taskId: "t1", tokens: 300 },
      { id: "run-work0002", role: "worker", taskId: "t2", tokens: 4_000 },
      { id: "run-work0003", role: "worker", taskId: "t2" },
      { id: "run-revw0002", role: "reviewer", taskId: null, tokens: 700 },
    ];
    const task = (id: string, extra: Partial<import("@/lib/coding-team-board").TeamTask>) => ({
      task_id: id, task_description: id, assigned_to: null, status: "pending" as const, result: null, depends_on: [], files_hint: [], review: null,
      attempts: 0, worktree: null, branch: null, reviewRunId: null, origin: "plan" as const, rejections: 0, created_at: 1, updated_at: 1, ...extra,
    });
    b.tasks = [
      task("t1", { status: "complete", attempts: 1, review: { verdict: "accepted", notes: "", at: 1 } }),
      task("t2", { status: "complete", attempts: 2, rejections: 1, review: { verdict: "accepted", notes: "", at: 1 } }),
      task("t3", { status: "retired" }),
      task("t4", { status: "complete", attempts: 1, origin: "lead", review: { verdict: "accepted", notes: "", at: 1 } }),
      task("t5", { status: "rejected", attempts: 2, rejections: 2, review: { verdict: "rejected", notes: "no", at: 1 } }),
    ];
    b.status = "failed";
    b.finishedAt = 61_000;
    expect(lib.teamMetrics(b)).toEqual({
      plannerRuns: 1,
      workerRuns: 3,
      reviewerRuns: 2,
      leadRuns: 1,
      tasksPlanned: 4,
      tasksAdded: 1,
      tasksRetired: 1,
      tasksAcceptedFirstTry: 2,
      tasksRejected: 2,
      tokensUsed: 12_000,
      wallMs: 60_000,
    });
    expect(lib.teamAgents(b)).toEqual({ planner: 1, workers: 3, reviewers: 2, leads: 1, total: 7 });
    // A team at work: the clock runs to now.
    b.status = "working";
    b.finishedAt = null;
    expect(lib.teamMetrics(b, 31_000).wallMs).toBe(30_000);
  });

  it("stops the clock when the team settles, and keeps the figures on disk with the board", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "a" });
    expect(b.finishedAt).toBeNull();
    lib.setTeamStatus(b, SYSTEM, "done");
    expect(b.finishedAt).toBe(b.updatedAt);
    lib.saveBoard(b);
    const raw = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-team", `${b.id}.json`), "utf8"));
    expect(raw.metrics).toMatchObject({ tasksPlanned: 1, tasksAdded: 0, tokensUsed: 0 });
    expect(lib.loadBoard(b.id)).toMatchObject({ finishedAt: b.finishedAt, metrics: { tasksPlanned: 1 } });
  });

  it("reads a board from before the shape, the lead and the figures as the default team", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "do it" });
    lib.saveBoard(b);
    const file = path.join(root, "data", "coding-team", `${b.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of ["shape", "dynamic", "finalReview", "metrics", "finishedAt"]) delete raw[k];
    delete raw.tasks[0].origin;
    delete raw.tasks[0].rejections;
    raw.tasks[0].attempts = 2;
    raw.runs = [{ id: "run-aaaaaaaa", role: "worker", taskId: "t1" }, { id: "run-bbbbbbbb", role: "lead", taskId: "t1", tokens: 42 }, { id: "run-cccccccc", role: "boss", taskId: null }];
    fs.writeFileSync(file, JSON.stringify(raw));
    const read = lib.loadBoard(b.id)!;
    expect(read).toMatchObject({ shape: null, dynamic: false, finalReview: null, finishedAt: null });
    // A second attempt only follows a rejection: counted as one.
    expect(read.tasks[0]).toMatchObject({ origin: "plan", rejections: 1 });
    expect(read.runs).toEqual([{ id: "run-aaaaaaaa", role: "worker", taskId: "t1" }, { id: "run-bbbbbbbb", role: "lead", taskId: "t1", tokens: 42 }]);
    expect(read.metrics).toMatchObject({ workerRuns: 1, leadRuns: 1, tokensUsed: 42, tasksRejected: 1 });
    // A malformed shape is no shape, never half a one.
    raw.shape = { parallelism: "lots", review: "each" };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(lib.loadBoard(b.id)?.shape).toBeNull();
    raw.shape = { parallelism: 2, review: "final", rationale: "Two files." };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(lib.loadBoard(b.id)?.shape).toEqual({ parallelism: 2, review: "final", rationale: "Two files." });
  });
});
