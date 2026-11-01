/**
 * The slim team's `card` and the runs route's `summaryLine` — what the chat's
 * cards read instead of a board or a result text (src/lib/coding-agent-slim.ts,
 * the 2026-10-30 redesign's step 3).
 */
import { describe, expect, it } from "vitest";
import { CARD_LINE_CHARS, firstSentence, runSummaryLine, TEAM_CARD_TASKS, teamCard } from "@/lib/coding-agent-slim";

const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  task_id: id,
  task_description: `${id}: do the thing\nwith a second line`,
  status,
  assigned_to: null,
  reviewRunId: null,
  review: null,
  ...extra,
});

describe("firstSentence", () => {
  it("takes the first sentence of the first non-empty line, without its heading or list mark", () => {
    expect(firstSentence("\n## Done\nAll good.")).toBe("Done");
    expect(firstSentence("- Added a settings drawer with three toggles. Choices persist.")).toBe("Added a settings drawer with three toggles.");
    expect(firstSentence("Wired the loop! Then tests")).toBe("Wired the loop!");
    expect(firstSentence("no sentence end here")).toBe("no sentence end here");
  });

  it("cuts a long sentence to the card's width with an ellipsis, and answers null for nothing", () => {
    const long = "x".repeat(400) + ".";
    const cut = firstSentence(long);
    expect(cut).toHaveLength(CARD_LINE_CHARS);
    expect(cut?.endsWith("…")).toBe(true);
    expect(firstSentence(null)).toBeNull();
    expect(firstSentence("")).toBeNull();
    expect(firstSentence("   \n  ")).toBeNull();
  });
});

describe("runSummaryLine", () => {
  it("prefers the full result text over the clipped summary, and answers null before there is one", () => {
    expect(runSummaryLine({ summary: "Short. More.", resultText: "Full text first. Second." })).toBe("Full text first.");
    expect(runSummaryLine({ summary: "Only the summary. More." })).toBe("Only the summary.");
    expect(runSummaryLine({ summary: null, resultText: null })).toBeNull();
    expect(runSummaryLine({})).toBeNull();
  });
});

describe("teamCard", () => {
  const team = {
    status: "working",
    tasks: [
      task("T1", "complete", { assigned_to: "run-00000002", reviewRunId: "run-00000004", review: { verdict: "accepted" as const } }),
      task("T2", "in_progress", { assigned_to: "run-00000003" }),
      task("T3", "pending"),
      task("T4", "retired"),
    ],
    runs: [
      { id: "run-00000001", role: "planner" as const, taskId: null },
      { id: "run-00000002", role: "worker" as const, taskId: "T1" },
      { id: "run-00000004", role: "reviewer" as const, taskId: "T1" },
      { id: "run-00000003", role: "worker" as const, taskId: "T2" },
    ],
    pr: { number: 12 },
    finalReview: null,
    error: null,
  };

  it("counts the tasks that can still be done, lists them in order with their verdicts and runs, and names the pull request", () => {
    const card = teamCard(team);
    expect(card.phase).toBe("working");
    expect(card.tasksDone).toBe(1);
    expect(card.tasksTotal).toBe(3);
    expect(card.tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
    expect(card.tasks[0]).toEqual({ id: "T1", title: "T1: do the thing", status: "complete", verdict: "accepted", workerRunId: "run-00000002", reviewerRunId: "run-00000004" });
    expect(card.tasks[2]).toMatchObject({ verdict: null, workerRunId: null, reviewerRunId: null });
    expect(card.prNumber).toBe(12);
    expect(card.resultLine).toBeNull();
  });

  it("marks the one worker still on its task active and every other run done", () => {
    const card = teamCard(team);
    expect(card.agents).toEqual([
      { role: "planner", runId: "run-00000001", state: "done" },
      { role: "worker", runId: "run-00000002", state: "done" },
      { role: "reviewer", runId: "run-00000004", state: "done" },
      { role: "worker", runId: "run-00000003", state: "active" },
    ]);
    // A reviewer is active while its task is complete and unruled.
    const reviewing = teamCard({ ...team, status: "reviewing", tasks: [task("T1", "complete", { reviewRunId: "run-00000004" })], runs: [team.runs[2]] });
    expect(reviewing.agents[0].state).toBe("active");
    // The planner is active only while the team plans; nothing is active once the team settled.
    expect(teamCard({ ...team, status: "planning", tasks: [], runs: [team.runs[0]] }).agents[0].state).toBe("active");
    expect(teamCard({ ...team, status: "done" }).agents.every((a) => a.state === "done")).toBe(true);
  });

  it("carries each agent's model from the cast list, and none it does not name", () => {
    const runs = [{ ...team.runs[0], model: "claude-opus-5-5" }, { ...team.runs[1], model: null }];
    expect(teamCard({ ...team, runs }).agents).toEqual([
      { role: "planner", runId: "run-00000001", state: "done", model: "claude-opus-5-5" },
      { role: "worker", runId: "run-00000002", state: "done" },
    ]);
  });

  it("answers the final review's first sentence when the team has one, else why it stopped, and caps the task list", () => {
    expect(teamCard({ ...team, status: "done", finalReview: { verdict: "accepted", notes: "Every task landed. Nothing left." } }).resultLine).toBe("Every task landed.");
    expect(teamCard({ ...team, status: "failed", error: "The planner gave no plan.\nmore" }).resultLine).toBe("The planner gave no plan.");
    const many = { ...team, tasks: Array.from({ length: TEAM_CARD_TASKS + 5 }, (_, i) => task(`T${i}`, "pending")) };
    const card = teamCard(many);
    expect(card.tasks).toHaveLength(TEAM_CARD_TASKS);
    expect(card.tasksTotal).toBe(TEAM_CARD_TASKS + 5);
  });

  it("copes with a board that has no cast list or pull request", () => {
    expect(teamCard({ status: "queued", tasks: [] })).toEqual({ phase: "queued", startStep: null, tasksDone: 0, tasksTotal: 0, tasks: [], prNumber: null, resultLine: null, agents: [] });
  });
});
