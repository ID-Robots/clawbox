/**
 * The planner's answer, read strictly (src/lib/coding-team-planner.ts): a
 * fenced or bare JSON array of tasks becomes the plan; anything else fails
 * the team with a reason, and is never repaired into tasks the planner did
 * not write — each task becomes a worker with a shell.
 */
import { describe, expect, it } from "vitest";
import { MAX_TEAM_TASKS } from "@/lib/coding-team-board";
import { parsePlan, PLANNER_BRIEF } from "@/lib/coding-team-planner";

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

  it("refuses nothing, prose, broken JSON, a non-array, an empty plan and too many tasks", () => {
    expect(parsePlan(null)).toMatchObject({ ok: false, reason: /answered nothing/ });
    expect(parsePlan("I could not decide.")).toMatchObject({ ok: false, reason: /no JSON array/ });
    expect(parsePlan("[{task_description: oops}]")).toMatchObject({ ok: false, reason: /not valid JSON/ });
    expect(parsePlan('{"task_description": "x"}')).toMatchObject({ ok: false, reason: /no JSON array/ });
    expect(parsePlan("[]")).toMatchObject({ ok: false, reason: /no tasks/ });
    const many = Array.from({ length: MAX_TEAM_TASKS + 1 }, (_, i) => ({ task_description: `t${i}` }));
    expect(parsePlan(JSON.stringify(many))).toMatchObject({ ok: false, reason: /at most/ });
  });

  it("refuses a task without a description, a dependency on itself or a later task, and bad hint shapes", () => {
    expect(parsePlan(JSON.stringify([{ files_hint: [] }]))).toMatchObject({ ok: false, reason: /t1 has no task_description/ });
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t1"] }]))).toMatchObject({ ok: false, reason: /t1 depends on t1/ });
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t2"] }, { task_description: "b" }]))).toMatchObject({ ok: false, reason: /t1 depends on t2/ });
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: "t1" }]))).toMatchObject({ ok: false, reason: /depends_on is not a list/ });
    expect(parsePlan(JSON.stringify([{ task_description: "a", files_hint: [1] }]))).toMatchObject({ ok: false, reason: /files_hint is not a list/ });
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
