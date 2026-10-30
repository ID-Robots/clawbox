/**
 * The steps a run or a team is named by between being asked for and its
 * first piece of work (src/lib/coding-start-phase.ts), and the in-memory list
 * of starts on their way that the runs list carries as `starting`
 * (src/lib/coding-run-starts.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodingStarts, runRecordStartStep, teamStartStep } from "@/lib/coding-start-phase";
import {
  beginCodingStart,
  endCodingStart,
  failCodingStart,
  FAILED_START_TTL_MS,
  listCodingStarts,
  resetCodingStartsForTests,
  STALE_START_MS,
  stepCodingStart,
} from "@/lib/coding-run-starts";

describe("teamStartStep", () => {
  it("names each step on the way to the first worker off the board alone", () => {
    expect(teamStartStep({ status: "planning", tasks: [], runs: [] })).toBe("planner_starting");
    expect(teamStartStep({ status: "planning", tasks: [], runs: [{ role: "planner" }] })).toBe("planning");
    expect(teamStartStep({ status: "planning", tasks: [{ status: "pending" }], runs: [{ role: "planner" }] })).toBe("plan_ready");
    expect(teamStartStep({ status: "working", tasks: [{ status: "pending" }], runs: [{ role: "planner" }] })).toBe("worker_starting");
    expect(teamStartStep({ status: "working", tasks: [{ status: "in_progress" }], runs: [{ role: "planner" }, { role: "worker" }] })).toBeNull();
    // A one-task plan runs as one ordinary run, its lead.
    expect(teamStartStep({ status: "working", tasks: [{ status: "in_progress" }], runs: [{ role: "planner" }, { role: "lead" }] })).toBeNull();
  });

  it("says nothing for a team that is queued or over, and copes with a board that has no cast list", () => {
    for (const status of ["queued", "reviewing", "done", "failed", "stopped"]) {
      expect(teamStartStep({ status, tasks: [], runs: [] })).toBeNull();
    }
    expect(teamStartStep({ status: "planning" })).toBe("planner_starting");
    // A retired task is not a plan.
    expect(teamStartStep({ status: "planning", tasks: [{ status: "retired" }], runs: [{ role: "planner" }] })).toBe("planning");
  });
});

describe("runRecordStartStep", () => {
  it("is `agent` while a running record's harness has not spoken, and nothing after", () => {
    expect(runRecordStartStep({ status: "running", sessionId: null })).toBe("agent");
    expect(runRecordStartStep({ status: "running" })).toBe("agent");
    expect(runRecordStartStep({ status: "running", sessionId: "sess-1" })).toBeNull();
    expect(runRecordStartStep({ status: "running", sessionId: null, numTurns: 2 })).toBeNull();
    expect(runRecordStartStep({ status: "queued", sessionId: null })).toBeNull();
    expect(runRecordStartStep({ status: "completed", sessionId: null })).toBeNull();
  });
});

describe("readCodingStarts", () => {
  it("keeps what a card can draw and drops the rest", () => {
    expect(readCodingStarts(null)).toEqual([]);
    expect(readCodingStarts([
      null,
      { id: "" , requestedAt: 1 },
      { id: "run-a", requestedAt: "soon" },
      { id: "run-abc12345", kind: "weird", task: 7, requestedAt: 5, step: "teleporting", error: "", failedAt: "x" },
      { id: "start-1a2b3c4d", kind: "team", task: "Build it", projectId: "p", directory: "d", source: "owner", requestedAt: 9, step: "launching", error: "Not ready", failedAt: 10 },
    ])).toEqual([
      { id: "run-abc12345", kind: "run", task: "", projectId: null, directory: null, source: "agent", requestedAt: 5, step: "checking", error: null, failedAt: null },
      { id: "start-1a2b3c4d", kind: "team", task: "Build it", projectId: "p", directory: "d", source: "owner", requestedAt: 9, step: "launching", error: "Not ready", failedAt: 10 },
    ]);
  });
});

describe("the list of starts", () => {
  beforeEach(() => resetCodingStartsForTests());
  afterEach(() => resetCodingStartsForTests());

  it("lists a start at its first step, moves it forward only, and lets the record take over", () => {
    beginCodingStart({ id: "run-abc12345", task: "  Build an invoice reader  ", directory: "invoice", source: "agent", now: 1_000 });
    expect(listCodingStarts(1_000)).toEqual([
      { id: "run-abc12345", kind: "run", task: "Build an invoice reader", projectId: null, directory: "invoice", source: "agent", requestedAt: 1_000, step: "checking", error: null, failedAt: null },
    ]);
    stepCodingStart("run-abc12345", "launching");
    stepCodingStart("run-abc12345", "worktree");
    expect(listCodingStarts(1_000)[0].step).toBe("launching");
    endCodingStart("run-abc12345");
    expect(listCodingStarts(1_000)).toEqual([]);
  });

  it("keeps a failed start with the first line of its reason, past its end, until the time is up", () => {
    beginCodingStart({ id: "run-abc12345", task: "t", source: "owner", now: 1_000 });
    failCodingStart("run-abc12345", "\n  That folder is busy with run-zzzz0000.  \nIt will be free when that run ends.");
    stepCodingStart("run-abc12345", "launching");
    endCodingStart("run-abc12345");
    const [failed] = listCodingStarts();
    expect(failed).toMatchObject({ id: "run-abc12345", step: "checking", error: "That folder is busy with run-zzzz0000." });
    expect(listCodingStarts((failed.failedAt as number) + FAILED_START_TTL_MS + 1)).toEqual([]);
  });

  it("lists a refusal it never saw begin only when told what it was, and cuts a long reason", () => {
    failCodingStart("start-00000000", "nope");
    expect(listCodingStarts()).toEqual([]);
    failCodingStart("start-1a2b3c4d", "x".repeat(400), { kind: "team", task: "Build it", source: "owner", now: 5_000 });
    const [refused] = listCodingStarts(5_000);
    expect(refused).toMatchObject({ id: "start-1a2b3c4d", kind: "team", requestedAt: 5_000, failedAt: 5_000 });
    expect(refused.error?.length).toBeLessThanOrEqual(240);
    expect(refused.error?.endsWith("…")).toBe(true);
  });

  it("drops a start that lost its caller, keeps the newest twenty, and lists newest first", () => {
    beginCodingStart({ id: "run-stale000", task: "t", source: "agent", now: 0 });
    expect(listCodingStarts(STALE_START_MS + 1)).toEqual([]);
    for (let i = 0; i < 25; i++) beginCodingStart({ id: `run-${String(i).padStart(8, "0")}`, task: "t", source: "agent", now: 100 + i });
    const listed = listCodingStarts(200);
    expect(listed).toHaveLength(20);
    expect(listed[0].id).toBe("run-00000024");
    expect(listed[19].id).toBe("run-00000005");
  });
});
