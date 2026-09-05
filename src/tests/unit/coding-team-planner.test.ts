/**
 * The planner's answer, read strictly (src/lib/coding-team-planner.ts): a
 * fenced or bare JSON array of tasks becomes the plan; anything else fails
 * the team with a reason, and is never repaired into tasks the planner did
 * not write — each task becomes a worker with a shell.
 */
import { describe, expect, it } from "vitest";
import { MAX_TEAM_TASKS } from "@/lib/coding-team-board";
import { MAX_TASK_CHARS } from "@/lib/coding-agent";
import { parsePlan, PLANNER_BRIEF, replanTask } from "@/lib/coding-team-planner";

describe("parsePlan", () => {
  it("reads a bare array, and one fenced in prose", () => {
    const plan = [
      { task_description: "Scaffold index.html with the form", files_hint: ["index.html"] },
      { task_description: "Wire the totals in app.js", depends_on: ["t1"], files_hint: ["app.js"] },
    ];
    for (const text of [JSON.stringify(plan), `Here is the plan:\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\nGood luck.`]) {
      const out = parsePlan(text);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.tasks).toEqual([
        { task_description: "Scaffold index.html with the form", depends_on: [], files_hint: ["index.html"] },
        { task_description: "Wire the totals in app.js", depends_on: ["t1"], files_hint: ["app.js"] },
      ]);
    }
  });

  const refused = (reason: RegExp) => expect.objectContaining({ ok: false, reason: expect.stringMatching(reason) });

  it("refuses nothing, prose, broken JSON, a non-array, an empty plan and too many tasks", () => {
    expect(parsePlan(null)).toEqual(refused(/answered nothing/));
    expect(parsePlan("I could not decide.")).toEqual(refused(/no JSON array/));
    expect(parsePlan("[{task_description: oops}]")).toEqual(refused(/no JSON array/));
    expect(parsePlan('{"task_description": "x"}')).toEqual(refused(/no JSON array/));
    expect(parsePlan("[]")).toEqual(refused(/no tasks/));
    const many = Array.from({ length: MAX_TEAM_TASKS + 1 }, (_, i) => ({ task_description: `t${i}` }));
    expect(parsePlan(JSON.stringify(many))).toEqual(refused(/at most/));
  });

  it("finds the array behind prose that carries brackets of its own", () => {
    const plan = [{ task_description: "Scaffold", files_hint: ["index.html"] }];
    const text = `Plan [draft v2] for the goal:\n${JSON.stringify(plan)}\n[note: the second task can wait]`;
    const out = parsePlan(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.tasks).toEqual([{ task_description: "Scaffold", depends_on: [], files_hint: ["index.html"] }]);
    // A bracket inside a string does not end the array either.
    const tricky = [{ task_description: "Handle the [edge] case", files_hint: [] }];
    expect(parsePlan(`Here: ${JSON.stringify(tricky)}`)).toEqual(expect.objectContaining({ ok: true }));
  });

  it("refuses a task without a description, a dependency on itself, a later or a non-canonical task, and bad hint shapes", () => {
    expect(parsePlan(JSON.stringify([{ files_hint: [] }]))).toEqual(refused(/t1 has no task_description/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t1"] }]))).toEqual(refused(/t1 depends on t1/));
    // A dependency on a LATER task is fine — the board starts a task when what it waits for is done, whatever the order.
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t2"] }, { task_description: "b" }]))).toMatchObject({ ok: true });
    // One outside the plan, and a cycle, are not.
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t3"] }, { task_description: "b" }]))).toEqual(refused(/t1 depends on t3/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t2"] }, { task_description: "b", depends_on: ["t3"] }, { task_description: "c", depends_on: ["t1"] }]))).toEqual(refused(/t1 and t2 and t3 depend on each other/));
    expect(parsePlan(JSON.stringify([{ task_description: "a" }, { task_description: "b", depends_on: ["t01"] }]))).toEqual(refused(/t2 depends on t01/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: "t1" }]))).toEqual(refused(/depends_on is not a list/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", files_hint: [1] }]))).toEqual(refused(/files_hint is not a list/));
  });

  it("tells the planner the shape it must answer with, and that it may change nothing", () => {
    expect(PLANNER_BRIEF).toContain("ONLY a JSON array");
    expect(PLANNER_BRIEF).toContain("task_description");
    expect(PLANNER_BRIEF).toContain("depends_on");
    expect(PLANNER_BRIEF).toContain("files_hint");
    expect(PLANNER_BRIEF).toMatch(/change NOTHING/);
    expect(PLANNER_BRIEF).toContain(String(MAX_TEAM_TASKS));
  });
});

describe("replanTask", () => {
  it("quotes the answer that was not a plan, bounded, and stays inside the run route's cap", () => {
    const text = replanTask("Build it", "Sure! Here is my thinking…", "no JSON array");
    expect(text).toContain("Goal: Build it");
    expect(text).toContain("no JSON array");
    expect(text).toContain("Sure! Here is my thinking…");
    expect(text).toContain("ONLY the JSON array");
    expect(replanTask("Build it", null, "empty")).toContain("You answered nothing.");
    const long = replanTask("g".repeat(MAX_TASK_CHARS * 2), "y".repeat(MAX_TASK_CHARS), "r");
    expect(long.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});
