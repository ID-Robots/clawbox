/**
 * The slim shape of the Coding Agent app's live poll (src/lib/coding-agent-slim.ts):
 * a settled record loses its free text on the box and gets it back from the
 * record the app already holds; a live one is never touched.
 */
import { describe, expect, it } from "vitest";
import { mergeSlimRuns, mergeSlimTeams, runsSettledSinceHeld, SLIM_TASK_DESCRIPTION_CHARS, slimRun, slimTeam, teamsSettledSinceHeld } from "@/lib/coding-agent-slim";
import { isSettledTeamStatus } from "@/lib/coding-team-status";

const SETTLED = {
  id: "run-k3x9q2ab",
  status: "completed" as const,
  summary: "Added the toggle.",
  progress: ["Read index.html", "Wrote the toggle"],
  progressAt: [1, 2],
  resultText: "A long closing message",
  allowRules: ["Bash(git *)"],
  deniedActions: ["rm -rf"],
  denials: [{ tool: "Bash", at: 3 }],
  pr: { phase: "checks" },
  leftover: false,
};
const LIVE = { ...SETTLED, id: "run-live00001", status: "running" as const };

const TEAM = {
  id: "team-abcd1234",
  status: "done" as const,
  goal: "Ship it",
  log: [{ type: "note", message: "planned" }],
  tasks: [
    { task_id: "t1", task_description: "x".repeat(400), result: "did it", review: { verdict: "accepted", notes: "fine", at: 1 }, status: "complete" },
    { task_id: "t2", task_description: "short", result: null, review: null, status: "retired" },
  ],
};

describe("slimRun", () => {
  it("empties a settled run's free text and marks it slim, keeping everything else", () => {
    const slim = slimRun(SETTLED);
    expect(slim).toEqual({ ...SETTLED, slim: true, progress: [], progressAt: [], resultText: null, allowRules: [], deniedActions: [], denials: [] });
    expect(slim.summary).toBe(SETTLED.summary);
    expect(slim.pr).toEqual(SETTLED.pr);
    // The caller's record is left alone.
    expect(SETTLED.progress).toHaveLength(2);
  });

  it("sends a live run whole, the very same object", () => {
    expect(slimRun(LIVE)).toBe(LIVE);
    expect(slimRun({ ...LIVE, status: "paused" })).toEqual({ ...LIVE, status: "paused" });
  });

  it("adds no field a record did not carry", () => {
    const bare = { id: "run-bare00001", status: "failed" as const, progress: ["a"] };
    expect(slimRun(bare)).toEqual({ id: "run-bare00001", status: "failed", progress: [], slim: true });
  });
});

describe("slimTeam", () => {
  it("empties a settled board's log and its tasks' text, cutting the brief to a name", () => {
    const slim = slimTeam(TEAM);
    expect(slim.slim).toBe(true);
    expect(slim.log).toEqual([]);
    expect(slim.goal).toBe("Ship it");
    expect(slim.tasks[0].task_description).toHaveLength(SLIM_TASK_DESCRIPTION_CHARS);
    expect(slim.tasks[0].task_description.endsWith("…")).toBe(true);
    expect(slim.tasks[0].result).toBeNull();
    expect(slim.tasks[0].review).toEqual({ verdict: "accepted", notes: "", at: 1 });
    expect(slim.tasks[0].status).toBe("complete");
    expect(slim.tasks[1]).toEqual({ ...TEAM.tasks[1], result: null, review: null });
  });

  it("sends a team at work or queued whole", () => {
    for (const status of ["queued", "planning", "working", "reviewing"] as const) {
      const team = { ...TEAM, status };
      expect(slimTeam(team)).toBe(team);
      expect(isSettledTeamStatus(status)).toBe(false);
    }
    for (const status of ["done", "failed", "stopped"] as const) expect(isSettledTeamStatus(status)).toBe(true);
  });
});

describe("mergeSlimRuns", () => {
  it("keeps the held text under a slim record and takes the rest from the tick", () => {
    const tick = { ...slimRun(SETTLED), pr: { phase: "merged" }, leftover: true };
    const [merged] = mergeSlimRuns([SETTLED], [tick]);
    expect(merged).toEqual({ ...SETTLED, pr: { phase: "merged" }, leftover: true, slim: false });
  });

  it("uses a slim record as it is when nothing full is held, and a full record always", () => {
    const slim = slimRun(SETTLED);
    expect(mergeSlimRuns([], [slim])).toEqual([slim]);
    // A held slim record is no source of text either.
    expect(mergeSlimRuns([slim], [slim])).toEqual([slim]);
    // A full record over a held one: the full one, whatever was held.
    const fuller = { ...SETTLED, progress: ["more"] };
    expect(mergeSlimRuns([SETTLED], [fuller])).toEqual([fuller]);
    expect(mergeSlimRuns([SETTLED], [LIVE])).toEqual([LIVE]);
  });

  it("never lays a slim record over a held LIVE one, and names the run that settled since", () => {
    // The last live copy's progress lines are not the final ones: a run the
    // app held live that a tick brings back settled and slim must come
    // through as the slim record (empty, slim: true), for the whole read
    // the app then asks for — not as the live copy frozen under slim: false.
    const liveHeld = { ...SETTLED, status: "running" as const, progress: ["Read index.html"] };
    const settledSlim = slimRun(SETTLED);
    const [out] = mergeSlimRuns([liveHeld], [settledSlim]);
    expect(out).toBe(settledSlim);
    expect(out.slim).toBe(true);
    expect(runsSettledSinceHeld([liveHeld], [settledSlim])).toEqual([SETTLED.id]);
    // Held settled already, or new to the app: nothing to read again.
    expect(runsSettledSinceHeld([SETTLED], [settledSlim])).toEqual([]);
    expect(runsSettledSinceHeld([], [settledSlim])).toEqual([]);
    // A paused run is held too: not settled, so the same rule.
    const pausedHeld = { ...liveHeld, status: "paused" as const };
    expect(mergeSlimRuns([pausedHeld], [settledSlim])[0]).toBe(settledSlim);
    expect(runsSettledSinceHeld([pausedHeld], [settledSlim])).toEqual([SETTLED.id]);
  });

  it("keeps the tick's order and membership", () => {
    const other = { ...SETTLED, id: "run-other0001" };
    const out = mergeSlimRuns([SETTLED, other], [slimRun(other)]);
    expect(out.map((r) => r.id)).toEqual(["run-other0001"]);
    expect(out[0].progress).toEqual(SETTLED.progress);
  });
});

describe("mergeSlimTeams", () => {
  it("keeps the held log and task text under a slim board", () => {
    const tick = { ...slimTeam(TEAM), status: "done", goal: "Ship it" };
    const [merged] = mergeSlimTeams([TEAM], [tick]);
    expect(merged).toEqual({ ...TEAM, slim: false });
  });

  it("never lays a slim board over a held board at work, and names the team that settled since", () => {
    const working = { ...TEAM, status: "working" as const, log: [{ type: "note", message: "half way" }] };
    const doneSlim = slimTeam(TEAM);
    const [out] = mergeSlimTeams([working], [doneSlim]);
    expect(out).toBe(doneSlim);
    expect(out.log).toEqual([]);
    expect(teamsSettledSinceHeld([working], [doneSlim])).toEqual([TEAM.id]);
    expect(teamsSettledSinceHeld([TEAM], [doneSlim])).toEqual([]);
    expect(teamsSettledSinceHeld([{ ...TEAM, status: "queued" as const }], [{ ...TEAM, status: "working" as const }])).toEqual([]);
  });

  it("takes a task the held board did not have from the tick, and a full board as it is", () => {
    const grown = slimTeam({ ...TEAM, tasks: [...TEAM.tasks, { task_id: "t3", task_description: "new", result: null, review: null, status: "pending" }] });
    const [merged] = mergeSlimTeams([TEAM], [grown]);
    expect(merged.tasks.map((t) => t.task_id)).toEqual(["t1", "t2", "t3"]);
    expect(merged.tasks[0].result).toBe("did it");
    expect(merged.tasks[2].task_description).toBe("new");
    expect(mergeSlimTeams([TEAM], [TEAM])).toEqual([TEAM]);
    expect(mergeSlimTeams([], [slimTeam(TEAM)])).toEqual([slimTeam(TEAM)]);
  });
});
