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
    // The lead's batch: every task it was given in full is left out.
    const batch = lib.boardDigest(b, ["t1", "t2"]);
    expect(batch).not.toMatch(/t[12] \[/);
    expect(batch).toContain("t3 [pending]");
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
    // What the runs said: two to a sibling (the ask and its one answer), one
    // to the lead, one to the assistant the box could not hand on, and one
    // whose payload could not be read back — sent, but to nobody in particular.
    const said = (from: string, payload: Record<string, unknown> | undefined) => ({ ts: 2, actor: worker(from), type: "message" as const, message: `worker ${from} → …`, payload });
    b.log.push(
      said("run-work0002", { from: "run-work0002", to: "sibling", toRunId: "run-work0001", text: "Which fields does the invoice schema have?" }),
      said("run-work0001", { from: "run-work0001", to: "sibling", toRunId: "run-work0002", text: "id, total, dueAt — in src/schema.ts." }),
      said("run-work0002", { from: "run-work0002", to: "lead", text: "t3 duplicates t2: both build the cart." }),
      { ts: 3, actor: PLANNER, type: "message", message: "planner → the assistant (not delivered: NO_SESSION): Stripe?", payload: { from: "run-plan0001", to: "owner_agent", text: "Stripe or PayPal?", delivered: false, code: "NO_SESSION" } },
      said("run-work0003", undefined),
      // Two workers refused only reads; a note read back with a payload that is not a count counts nothing.
      { ts: 4, actor: SYSTEM, type: "note", message: "Worker run-work0001 was refused 2 read-only action(s) …", payload: { readOnlyRefusals: 2 } },
      { ts: 5, actor: SYSTEM, type: "note", message: "Worker run-work0002 was refused 1 read-only action(s) …", payload: { readOnlyRefusals: 1 } },
      { ts: 6, actor: SYSTEM, type: "note", message: "?", payload: { readOnlyRefusals: "lots" } },
    );
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
      messagesSent: 5,
      messagesToLead: 1,
      messagesToSibling: 2,
      messagesUndelivered: 1,
      readOnlyRefusals: 3,
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
    expect(raw.metrics).toMatchObject({ tasksPlanned: 1, tasksAdded: 0, tokensUsed: 0, messagesSent: 0, messagesToLead: 0, messagesToSibling: 0, messagesUndelivered: 0 });
    expect(lib.loadBoard(b.id)).toMatchObject({ finishedAt: b.finishedAt, metrics: { tasksPlanned: 1 } });
  });

  it("counts the team messages postMessage wrote, and counts them again from the log read back", () => {
    const b = board();
    b.runs.push({ id: "run-aaaaaaaa", role: "worker", taskId: "t1" }, { id: "run-bbbbbbbb", role: "worker", taskId: "t2" });
    lib.postMessage(b, worker("run-aaaaaaaa"), { from_run_id: "run-aaaaaaaa", to: "sibling", to_run_id: "run-bbbbbbbb", text: "What does cart.ts export?" }, 1_000);
    lib.postMessage(b, worker("run-bbbbbbbb"), { from_run_id: "run-bbbbbbbb", to: "sibling", to_run_id: "run-aaaaaaaa", text: "addItem(sku, qty)", undelivered: "NOT_DELIVERED" }, 2_000);
    lib.postMessage(b, worker("run-bbbbbbbb"), { from_run_id: "run-bbbbbbbb", to: "lead", text: "t3 is already done by t2." }, 3_000);
    const counted = { messagesSent: 3, messagesToLead: 1, messagesToSibling: 2, messagesUndelivered: 1 };
    expect(lib.teamMetrics(b)).toMatchObject(counted);
    lib.saveBoard(b);
    expect(lib.loadBoard(b.id)!.metrics).toMatchObject(counted);
  });

  it("reads a board from before the shape, the lead and the figures as the default team", () => {
    const b = board();
    lib.postTask(b, PLANNER, { task_description: "do it" });
    lib.saveBoard(b);
    const file = path.join(root, "data", "coding-team", `${b.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of ["shape", "dynamic", "finalReview", "metrics", "finishedAt", "lastLeadAt"]) delete raw[k];
    delete raw.tasks[0].origin;
    delete raw.tasks[0].rejections;
    raw.tasks[0].attempts = 2;
    raw.runs = [{ id: "run-aaaaaaaa", role: "worker", taskId: "t1" }, { id: "run-bbbbbbbb", role: "lead", taskId: "t1", tokens: 42 }, { id: "run-cccccccc", role: "boss", taskId: null }];
    fs.writeFileSync(file, JSON.stringify(raw));
    const read = lib.loadBoard(b.id)!;
    expect(read).toMatchObject({ shape: null, dynamic: false, finalReview: null, finishedAt: null, lastLeadAt: 0 });
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
    // The lead's last turn: kept when it is a time, 0 when it is anything else.
    raw.lastLeadAt = "soon";
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(lib.loadBoard(b.id)?.lastLeadAt).toBe(0);
  });

  it("counts the read-only refusals postNote wrote, never as alerts, and counts them again from the log read back", () => {
    const b = board();
    lib.postNote(b, SYSTEM, "Worker run-aaaaaaaa was refused 2 read-only action(s) outside its folder: Read: /p/a; Glob: /p", "t1", 2);
    lib.postNote(b, SYSTEM, "A note that is about nothing refused.");
    expect(b.alerts).toBe(0);
    expect(b.log.filter((e) => e.type === "note").map((e) => e.task_id)).toEqual(["t1", undefined]);
    expect(lib.teamMetrics(b).readOnlyRefusals).toBe(2);
    lib.saveBoard(b);
    expect(lib.loadBoard(b.id)!.metrics.readOnlyRefusals).toBe(2);
    // The orchestrator's line alone: no run of the team writes one.
    for (const actor of [PLANNER, REVIEWER, OWNER, worker("run-aaaaaaaa")]) {
      expect(() => lib.postNote(b, actor, "all fine", "t1", 9)).toThrow(/Only the system writes a note/);
    }
    expect(lib.teamMetrics(b).readOnlyRefusals).toBe(2);
    // Not quoted to a teammate: the digest carries alerts and messages.
    expect(lib.boardDigest(b, null)).not.toContain("read-only");
  });

  it("keeps when the lead's last turn was written, from a new board's 0", () => {
    const b = board();
    expect(b.lastLeadAt).toBe(0);
    b.lastLeadAt = 1_234_567;
    lib.saveBoard(b);
    expect(lib.loadBoard(b.id)?.lastLeadAt).toBe(1_234_567);
  });
});

describe("readOnlyDenial", () => {
  it("knows the refusals the bench saw only looked: a probe of the project path, a ps", () => {
    for (const action of [
      "Glob: /home/clawbox/Projects/team-bench/team-refactor-modules",
      "Read: /home/clawbox/Projects/team-bench/units/index.html",
      "Read: /home/clawbox/Projects/team-bench/units/units.py",
      "Bash: ps -eo pid,cmd | grep '[s]erver\\.py' || echo …",
    ]) expect(lib.readOnlyDenial(action), action).toBe(true);
  });

  it("takes every tool that only looks, and a shell command whose every part only looks", () => {
    for (const action of [
      "Grep: TODO", "LS: /home/clawbox/Projects/site", "WebFetch: https://example.com", "WebSearch: vitest config", "Read: (no details)",
      "Bash: ls -la /home/clawbox/Projects/site",
      "Bash: cat index.html | head -20",
      "Bash: cd /home/clawbox/Projects/site && git status",
      "Bash: git -C /home/clawbox/Projects/site log --oneline -3",
      "Bash: git diff HEAD~1 -- app.js; git show HEAD:app.js",
      "Bash: find . -name '*.py' 2>/dev/null | wc -l",
      "Bash: test -f server.py && echo yes || echo no",
      "Bash: [ -d dist ] && ls dist >/dev/null 2>&1",
      "Bash: pgrep -f server.py &>/dev/null; rg -n TODO src; stat units.py; file units.py; which python3; pwd; tail -n 5 log.txt",
    ]) expect(lib.readOnlyDenial(action), action).toBe(true);
  });

  it("calls anything that may write a write: the file tools, a redirection, a writing command, a command it cannot read to the end", () => {
    for (const action of [
      "Write: /home/clawbox/Projects/site/index.html",
      "Edit: /home/clawbox/Projects/site/app.js",
      "NotebookEdit: /home/clawbox/Projects/site/a.ipynb",
      "Bash: rm -rf x",
      "Bash: cat a > b",
      "Bash: python3 build.py",
      "Bash: echo hi >> notes.txt",
      "Bash: ls >/dev/nullfile",
      "Bash: ls >&2file",
      "Bash: rg --pre rm TODO .",
      "Bash: rg --pre=./wipe.sh TODO",
      "Bash: cat a | tee b",
      "Bash: ls && mkdir out",
      "Bash: grep -l x src | xargs sed -i s/x/y/",
      "Bash: git status; npm install",
      "Bash: git checkout -- app.js",
      "Bash: git diff --output=patch.txt",
      "Bash: git -C .",
      "Bash: find . -name '*.pyc' -delete",
      "Bash: find . -exec rm {} ;",
      "Bash: echo $(rm -rf x)",
      "Bash: echo `touch x`",
      "Bash: cat <(node gen.js)",
      "Bash: sudo ls",
      "Bash: FOO=1 ls",
      "Bash: (no details)",
      "Bash: ",
      // At the runner's cut (160): the rest of the command is not on the record.
      `Bash: ls ${"a".repeat(151)}`,
      "tool: (no details)",
      "Read /no/colon",
      "",
    ]) expect(lib.readOnlyDenial(action), action).toBe(false);
  });

  // Bench, 2026-09-26: the harness points a run at its memory under its
  // project's state folder; the look there was refused, and was an alert.
  it("takes a listing of the run's own project-state folder: it only looks", () => {
    expect(lib.readOnlyDenial(`Bash: ls -la ${os.homedir()}/.claude-ds/projects/-home-clawbox-Projects-site`)).toBe(true);
  });

  // Bench, 2026-09-26: `M="$CLAWBOX_RUN_ARTIFACTS_DIR/mutation"; P=…` ran past
  // the runner's display cut, and its length alone made it an alert.
  it("reads a text longer than the runner's display cut part by part — the whole text a record keeps", () => {
    const probe = `Bash: M="$CLAWBOX_RUN_ARTIFACTS_DIR/mutation"; P=/home/clawbox/Projects/team-bench/team-api; ls -la "$M" 2>/dev/null; head -40 "$P/index.html" | grep -n app; git -C "$P" status --short; diff "$P/a.txt" "$M/a.txt"; readlink -f "$P" && du -sh "$P"`;
    expect(probe.length).toBeGreaterThan(lib.DENIAL_TEXT_CUT);
    expect(lib.readOnlyDenial(probe)).toBe(true);
    // Its display text, at exactly the cut: anything may follow.
    expect(lib.readOnlyDenial(probe.slice(0, lib.DENIAL_TEXT_CUT))).toBe(false);
    // A whole text at its own bound may be cut too.
    expect(lib.readOnlyDenial(`Bash: ls ${"a".repeat(lib.DENIAL_FULL_TEXT_CUT)}`.slice(0, lib.DENIAL_FULL_TEXT_CUT))).toBe(false);
    expect(lib.readOnlyDenial(`Bash: ls ${"a".repeat(lib.DENIAL_FULL_TEXT_CUT - 20)}`)).toBe(true);
  });

  it("still calls a long command a write when one part writes, however long the rest only looks", () => {
    const looks = `ls -la /home/clawbox/Projects/site; cat /home/clawbox/Projects/site/index.html | head -40; ${"grep -n x a.js; ".repeat(10)}`;
    expect(looks.length).toBeGreaterThan(lib.DENIAL_TEXT_CUT);
    for (const action of [
      `Bash: ${looks}rm -rf /home/clawbox/Projects/site/dist`,
      `Bash: ${looks}echo done > /home/clawbox/Projects/site/log.txt`,
      `Bash: ${looks}npm install`,
      `Bash: ${looks}PATH=/tmp/bin; ls`,
      `Write: /home/clawbox/Projects/site/${"a".repeat(200)}.html`,
    ]) expect(lib.readOnlyDenial(action), action).toBe(false);
  });

  it("takes a bare variable assignment, but none that steers the commands after it", () => {
    for (const action of ["Bash: M=/tmp/x; ls \"$M\"", "Bash: A=1 B=\"$HOME/x\"; cat \"$B\"", "Bash: dir=out && ls $dir"]) {
      expect(lib.readOnlyDenial(action), action).toBe(true);
    }
    for (const action of [
      "Bash: PATH=/tmp/bin; ls", "Bash: IFS=/; ls", "Bash: LD_PRELOAD=/tmp/x.so; ls", "Bash: GIT_EXTERNAL_DIFF=/tmp/x; git diff",
      "Bash: PAGER=/tmp/x; git log", "Bash: path=/tmp; ls", "Bash: M=\"a b\"; ls", "Bash: M=$(rm x); ls", "Bash: FOO=1 ls",
    ]) expect(lib.readOnlyDenial(action), action).toBe(false);
  });
});

describe("outsideFolderWriteDenial", () => {
  const WT = ["/p/.clawbox/worktrees/t2-1"];

  it("takes a write the runner refused outside the worker's worktree, and keeps one inside it", () => {
    expect(lib.outsideFolderWriteDenial("Write: /tmp/x.py", WT)).toBe(true);
    expect(lib.outsideFolderWriteDenial("Write: /p/.clawbox/worktrees/t2-1/a.js", WT)).toBe(false);
    expect(lib.outsideFolderWriteDenial("Bash: echo hi > /tmp/o", WT)).toBe(true);
    // In place: the project is the worker's folder.
    expect(lib.outsideFolderWriteDenial("Edit: /p/index.html", ["/p"])).toBe(false);
  });

  it("knows the scratch places the bench saw: /tmp, the harness's memory folder, /var", () => {
    for (const action of [
      "Write: /tmp/t2_check_contacts.py",
      "Write: /home/clawbox/.claude-ds/projects/-p/memory/notes.md",
      "Edit: /var/tmp/x.txt",
      "MultiEdit: /tmp/a.js",
      "NotebookEdit: /tmp/n.ipynb",
      "Bash: cat > /tmp/check.py << 'EOF'",
      "Bash: python3 -c \"open('/tmp/x','w').write('1')\"",
      "Bash: echo hi>/tmp/o",
      "Bash: mkdir -p /tmp/t2 && cp a.js /tmp/t2/",
      // `..` walks out of the worktree.
      "Write: /p/.clawbox/worktrees/t2-1/../../../tmp/x",
      // A sibling's worktree is not this worker's.
      "Write: /p/.clawbox/worktrees/t2-10/a.js",
    ]) expect(lib.outsideFolderWriteDenial(action, WT), action).toBe(true);
  });

  it("is false for a write inside any of the folders, a tool that only looks, no absolute path, a path the runner's cut ran into, or no folder", () => {
    for (const [action, folders] of [
      ["Write: /p/.clawbox/worktrees/t2-1", WT],
      ["Edit: /p/.clawbox/worktrees/t2-1/src/app.js", WT],
      ["Bash: cd /p/.clawbox/worktrees/t2-1 && rm -rf dist", WT],
      // A worktree worker's write at the project itself: its folders are both.
      ["Write: /p/index.html", ["/p/.clawbox/worktrees/t2-1", "/p"]],
      ["Read: /tmp/x.py", WT],
      ["Glob: /tmp", WT],
      ["mcp__clawbox__browser_open: /tmp/x", WT],
      ["Bash: rm -rf dist", WT],
      ["Bash: echo hi > ~/notes.txt", WT],
      ["Bash: curl https://example.com/x -o out.html", WT],
      ["Write: (no details)", WT],
      ["Write /tmp/no-colon", WT],
      ["", WT],
      // At the runner's cut (160), mid-path: it may have gone on into the project.
      [`Bash: ${"x".repeat(140)} > /home/clawbox/Projects/site/out.txt`.slice(0, 160), ["/home/clawbox/Projects/site"]],
      ["Write: /tmp/x.py", []],
      ["Write: /tmp/x.py", ["relative/dir"]],
    ] as Array<[string, string[]]>) expect(lib.outsideFolderWriteDenial(action, folders), action).toBe(false);
  });

  it("still takes a long command whose path ends before the runner's cut", () => {
    expect(lib.outsideFolderWriteDenial(`Bash: cat > /tmp/check.py << 'EOF' ${"x".repeat(140)}`.slice(0, 160), WT)).toBe(true);
  });
});

describe("harnessStateDenial", () => {
  it("knows the harness's own state in a home folder, however the action names it", () => {
    for (const action of [
      "Read: /home/clawbox/.claude-ds/projects/-home-clawbox-Projects-site/sess-1.jsonl",
      "Read: /home/clawbox/.claude/projects/-p/memory/MEMORY.md",
      "Glob: /home/clawbox/.claude-ds",
      "Grep: /root/.claude/settings.json",
      "Bash: cat ~/.claude-ds/projects/-p/sess.jsonl",
      "Bash: ls $HOME/.claude/projects",
      "Bash: ls ${HOME}/.claude-ds/",
      "Bash: grep -r token \"/home/clawbox/.claude-ds/.credentials.json\"",
      // Its own write there too — the team judges a write by where it went, not by this.
      "Write: /home/clawbox/.claude-ds/projects/-p/memory/notes.md",
      `Read: ${os.homedir()}/.claude-ds/projects/x.jsonl`,
    ]) expect(lib.harnessStateDenial(action), action).toBe(true);
  });

  it("is false for a project's own .claude folder, a lookalike name, and anything else", () => {
    for (const action of [
      "Read: /home/clawbox/Projects/site/.claude/commands/build.md",
      "Read: /home/clawbox/Projects/site/.clawbox/worktrees/t1-1/index.html",
      "Read: /home/clawbox/.claude-notes/todo.md",
      "Read: /home/clawbox/.claudex/x",
      "Glob: /home/clawbox/Projects",
      "Bash: ps -eo pid,cmd",
      "Read: (no details)",
      "no colon /home/clawbox/.claude-ds",
      "",
    ]) expect(lib.harnessStateDenial(action), action).toBe(false);
  });
});

describe("ownHarnessStateDenial", () => {
  const HOME = os.homedir();
  const STATE = `${HOME}/.claude-ds`;
  const P = "/home/clawbox/Projects/site";
  const W = `${P}/.clawbox/worktrees/t1-1`;
  const OWN = { stateDir: STATE, folders: [W, P], sessionId: "sess-own" };
  const MINE = `${STATE}/projects/-home-clawbox-Projects-site`;
  const MINE_WT = `${STATE}/projects/-home-clawbox-Projects-site--clawbox-worktrees-t1-1`;

  it("names the slug the harness gives a folder", () => {
    expect(lib.harnessProjectSlug(P)).toBe("-home-clawbox-Projects-site");
    expect(lib.harnessProjectSlug(W)).toBe("-home-clawbox-Projects-site--clawbox-worktrees-t1-1");
  });

  it("takes a look into the run's own corner: its project's folder listed, its memory, its own transcript — however the home is written", () => {
    for (const action of [
      `Bash: ls -la ${MINE}`,
      `Bash: ls -la ${MINE}/`,
      `Bash: ls ${MINE_WT}/memory/ 2>/dev/null || echo none`,
      `LS: ${MINE}`,
      `Glob: ${MINE_WT}`,
      `Read: ${MINE}/memory/MEMORY.md`,
      `Grep: ${MINE}/memory`,
      "Bash: cat ~/.claude-ds/projects/-home-clawbox-Projects-site/memory/MEMORY.md",
      "Bash: head \"$HOME/.claude-ds/projects/-home-clawbox-Projects-site/memory/notes.md\"",
      "Bash: ls ${HOME}/.claude-ds/projects/-home-clawbox-Projects-site",
      `Read: ${MINE_WT}/sess-own.jsonl`,
      `Read: ${MINE_WT}/sess-own/subagents/agent-1.jsonl`,
      `Bash: ls ${MINE}/memory && ls ${MINE_WT}`,
      // Its own memory, written: the team judges where a write went, and this is its own.
      `Write: ${MINE}/memory/notes.md`,
    ]) expect(lib.ownHarnessStateDenial(action, OWN), action).toBe(true);
  });

  it("is false for anything of anyone else's there, a search through the folder, a way out, or a text that may be cut", () => {
    for (const action of [
      // The parent, another project, another session beside its own.
      `Bash: ls ${STATE}/projects`,
      `Bash: ls ${STATE}/projects/-home-clawbox-Projects-other/memory`,
      `Read: ${MINE}/sess-other.jsonl`,
      `Read: ${MINE}/sess-own.jsonl.bak`,
      `Bash: cat ${MINE}/*.jsonl`,
      // A search reads every transcript in the folder; so does a shell that runs one per file.
      `Grep: ${MINE}`,
      `Bash: grep -r token ${MINE}`,
      `Bash: find ${MINE} -exec cat {} +`,
      // Its own corner beside something that is not.
      `Bash: ls ${MINE}/memory; cat ${STATE}/.credentials.json`,
      `Bash: ls ${MINE} ${STATE}/settings.json`,
      // The settings, the credentials, another config folder, another home.
      `Read: ${STATE}/settings.json`,
      `Read: ${HOME}/.claude/projects/-home-clawbox-Projects-site/memory/MEMORY.md`,
      "Read: /home/someone-else-entirely/.claude-ds/projects/-home-clawbox-Projects-site/memory/MEMORY.md",
      // Ways out of the corner.
      `Read: ${MINE}/memory/../../-home-clawbox-Projects-other/sess.jsonl`,
      `Bash: cd ${MINE} && cat sess-other.jsonl`,
      `Bash: cd ${MINE}/memory && cat ../sess-other.jsonl`,
      // A `..` the shell makes out of a word that looks like it stays in the corner.
      `Bash: cat ${MINE}/memory/{..,}/{..,}/-home-clawbox-Projects-other/sess.jsonl`,
      `Bash: cat ${MINE}/memory/.''./sess-other.jsonl`,
      `Bash: cat "${MINE}/memory/."'.'/sess-other.jsonl`,
      `Bash: D=.; cat ${MINE}/memory/$D$D/sess-other.jsonl`,
      `Bash: cat ${MINE}/memory/.*/sess-other.jsonl`,
      `Bash: cat ${MINE}/memory/.\\./sess-other.jsonl`,
      // A write into the folder itself, beside the memory.
      `Write: ${MINE}/notes.md`,
      // Cut at the runner's display length, mid-slug: it may have gone on elsewhere.
      `Bash: ls -la ${MINE}${"x".repeat(200)}`.slice(0, lib.DENIAL_TEXT_CUT),
      // Nothing of the harness's at all.
      `Read: ${P}/index.html`,
      "Read: (no details)",
      "",
    ]) expect(lib.ownHarnessStateDenial(action, OWN), action).toBe(false);
  });

  it("is false with no folder to name the corner by, a state folder that is not absolute, or a session it does not know", () => {
    expect(lib.ownHarnessStateDenial(`Read: ${MINE}/memory/MEMORY.md`, { ...OWN, folders: [] })).toBe(false);
    expect(lib.ownHarnessStateDenial(`Read: ${MINE}/memory/MEMORY.md`, { ...OWN, folders: ["relative/site"] })).toBe(false);
    expect(lib.ownHarnessStateDenial(`Read: ${MINE}/memory/MEMORY.md`, { ...OWN, stateDir: ".claude-ds" })).toBe(false);
    expect(lib.ownHarnessStateDenial(`Read: ${MINE_WT}/sess-own.jsonl`, { ...OWN, sessionId: null })).toBe(false);
    // Another run's corner is not this one's.
    expect(lib.ownHarnessStateDenial(`Read: ${MINE}/memory/MEMORY.md`, { ...OWN, folders: ["/home/clawbox/Projects/other"] })).toBe(false);
  });
});
