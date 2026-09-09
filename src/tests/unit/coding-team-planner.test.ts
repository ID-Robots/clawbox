/**
 * The planner's answer, read strictly (src/lib/coding-team-planner.ts): a
 * fenced or bare JSON array of tasks becomes the plan; anything else fails
 * the team with a reason, and is never repaired into tasks the planner did
 * not write — each task becomes a worker with a shell.
 */
import { describe, expect, it } from "vitest";
import { MAX_TASK_DESCRIPTION_CHARS, MAX_TEAM_TASKS } from "@/lib/coding-team-board";
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


it("never mistakes a truncated outer plan's nested depends_on array for the plan", () => {
  const plan = JSON.stringify([{ task_description: "Backend", depends_on: [], files_hint: ["src"] }, { task_description: "Frontend" }]);
  expect(parsePlan(plan.slice(0, -8))).toMatchObject({ ok: false, reason: expect.stringMatching(/no JSON array/) });
});

it("accepts a full plan above the display-summary limit and names precise schema violations", () => {
  const tasks = Array.from({ length: 5 }, () => ({ task_description: "x".repeat(1800), depends_on: [] }));
  expect(parsePlan(JSON.stringify(tasks))).toMatchObject({ ok: true });
  tasks[2].task_description = "x".repeat(2001);
  expect(parsePlan(JSON.stringify(tasks))).toMatchObject({ ok: false, reason: expect.stringMatching(/t3.*2001.*2000/) });
  expect(PLANNER_BRIEF).toContain("2000");
  expect(PLANNER_BRIEF).toContain("parallel");
});

describe("a plan whose faults must all be fixed at once", () => {
  const over = (extra: number) => "x".repeat(MAX_TASK_DESCRIPTION_CHARS + extra);

  it("names every over-long task_description in one reason, with how much each must lose", () => {
    // Seen on two devices: the board died on t1's length alone, so the planner
    // never learned t2 was over too and spent its one retry half-informed.
    const out = parsePlan(JSON.stringify([
      { task_description: over(541), files_hint: ["a.ts"] },
      { task_description: "fine", files_hint: ["b.ts"] },
      { task_description: over(13), files_hint: ["c.ts"] },
    ]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("Task t1");
    expect(out.reason).toContain("Task t3");
    expect(out.reason).toContain("must lose at least 541");
    expect(out.reason).toContain("must lose at least 13");
    expect(out.reason).not.toContain("Task t2");
  });

  it("names faults of different kinds together, not just the first one it meets", () => {
    const out = parsePlan(JSON.stringify([
      { task_description: over(1), files_hint: ["a.ts"] },
      { task_description: "", files_hint: ["b.ts"] },
      { task_description: "ok", depends_on: ["t9"], files_hint: ["c.ts"] },
      { task_description: "ok", files_hint: "not-a-list" },
    ]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("must lose at least 1");
    expect(out.reason).toContain("Task t2 has no task_description");
    expect(out.reason).toContain("Task t3 depends on t9");
    expect(out.reason).toContain("Task t4's files_hint is not a list");
  });

  it("reports both a bad depends_on and a bad files_hint on the same task", () => {
    const out = parsePlan(JSON.stringify([{ task_description: "ok", depends_on: [7], files_hint: "nope" }]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("Task t1's depends_on is not a list of task ids");
    expect(out.reason).toContain("Task t1's files_hint is not a list of paths");
  });

  it("counts the rest instead of printing an unbounded wall of faults", () => {
    const out = parsePlan(JSON.stringify(Array.from({ length: 8 }, () => ({ task_description: over(7), files_hint: [] }))));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("Task t6");
    expect(out.reason).not.toContain("Task t7");
    expect(out.reason).toContain("and 2 further faults");
  });

  it("still refuses the whole plan rather than dropping the tasks that were too long", () => {
    // The parser repairs nothing: a plan with one bad task is not silently
    // delivered as a smaller plan, because each task becomes a worker.
    const out = parsePlan(JSON.stringify([
      { task_description: "fine", files_hint: [] },
      { task_description: over(1), files_hint: [] },
    ]));
    expect(out.ok).toBe(false);
  });

  it("accepts a description exactly at the limit", () => {
    const out = parsePlan(JSON.stringify([{ task_description: "y".repeat(MAX_TASK_DESCRIPTION_CHARS), files_hint: [] }]));
    expect(out.ok).toBe(true);
  });
});
