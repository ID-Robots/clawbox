/**
 * The planner's answer, read strictly (src/lib/coding-team-planner.ts): a
 * fenced or bare JSON array of tasks becomes the plan; anything else fails
 * the team with a reason, and is never repaired into tasks the planner did
 * not write — each task becomes a worker with a shell.
 */
import { describe, expect, it } from "vitest";
import { createBoard, MAX_LEAD_ADDS, MAX_LEAD_RETIRES, MAX_TASK_DESCRIPTION_CHARS, MAX_TEAM_TASKS, postMessage, postTask, type TaskStatus, type TeamBoard } from "@/lib/coding-team-board";
import { MAX_TASK_CHARS, MAX_TEAM_WORKERS } from "@/lib/coding-agent";
import { leadRoom, leadShouldRun, leadTask, MAX_LEAD_INBOX_CHARS, MAX_LEAD_NOTE_CHARS, parsePlan, parseReplan, PLANNER_BRIEF, REPLAN_BRIEF, replanContext, replanTask, type ReplanContext } from "@/lib/coding-team-planner";

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

  it("refuses a task without a description, a dependency on itself, on a later or a non-canonical task, and bad hint shapes", () => {
    expect(parsePlan(JSON.stringify([{ files_hint: [] }]))).toEqual(refused(/t1 has no task_description/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t1"] }]))).toEqual(refused(/t1 depends on t1/));
    // A dependency on a LATER task is refused: the plan is posted in order, and the board
    // takes a dependency only on a task already on it — posted, it failed the team.
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t2"] }, { task_description: "b" }]))).toEqual(refused(/Task t1 depends on t2, which is listed after it/));
    expect(parsePlan(JSON.stringify([{ task_description: "a" }, { task_description: "b", depends_on: ["t1"] }]))).toMatchObject({ ok: true });
    // One outside the plan, and a cycle, are not.
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t3"] }, { task_description: "b" }]))).toEqual(refused(/t1 depends on t3/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: ["t2"] }, { task_description: "b", depends_on: ["t3"] }, { task_description: "c", depends_on: ["t1"] }]))).toEqual(refused(/t1 and t2 and t3 depend on each other/));
    expect(parsePlan(JSON.stringify([{ task_description: "a" }, { task_description: "b", depends_on: ["t01"] }]))).toEqual(refused(/t2 depends on t01/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", depends_on: "t1" }]))).toEqual(refused(/depends_on is not a list/));
    expect(parsePlan(JSON.stringify([{ task_description: "a", files_hint: [1] }]))).toEqual(refused(/files_hint is not a list/));
  });

  it("tells the planner the shape it must answer with, and that it may change nothing", () => {
    expect(PLANNER_BRIEF).toContain("ONLY a JSON object");
    expect(PLANNER_BRIEF).toContain('"tasks"');
    expect(PLANNER_BRIEF).toContain("task_description");
    expect(PLANNER_BRIEF).toContain("depends_on");
    expect(PLANNER_BRIEF).toContain("files_hint");
    expect(PLANNER_BRIEF).toMatch(/change NOTHING/);
    expect(PLANNER_BRIEF).toContain(String(MAX_TEAM_TASKS));
    expect(PLANNER_BRIEF).toMatch(/depends_on names EARLIER tasks — listed before it/);
  });
});

describe("replanTask", () => {
  it("quotes the answer that was not a plan, bounded, and stays inside the run route's cap", () => {
    const text = replanTask("Build it", "Sure! Here is my thinking…", "no JSON array");
    expect(text).toContain("Goal: Build it");
    expect(text).toContain("no JSON array");
    expect(text).toContain("Sure! Here is my thinking…");
    expect(text).toContain("ONLY the JSON plan");
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

// ─── TASK-1099: the team's shape, and the lead ───────────────────────────────

describe("parsePlan — the shape", () => {
  const tasks = [
    { task_description: "Fix the off-by-one in pager.ts", files_hint: ["src/pager.ts"] },
  ];

  it("accepts the bare array (no shape: the default team) and the wrapped object, fenced or not", () => {
    expect(parsePlan(JSON.stringify(tasks))).toEqual({ ok: true, shape: null, tasks: [{ task_description: "Fix the off-by-one in pager.ts", depends_on: [], files_hint: ["src/pager.ts"] }] });
    const wrapped = { shape: { parallelism: 1, review: "final", rationale: "A one-file fix." }, tasks };
    for (const text of [JSON.stringify(wrapped), `The plan:\n\`\`\`json\n${JSON.stringify(wrapped, null, 2)}\n\`\`\`\nDone.`, `Plan [v1]: ${JSON.stringify(wrapped)} [end]`]) {
      const out = parsePlan(text);
      expect(out).toMatchObject({ ok: true, shape: { parallelism: 1, review: "final", rationale: "A one-file fix." } });
      if (out.ok) expect(out.tasks).toHaveLength(1);
    }
    // Wrapped with no shape, or a null one, is the default team too; the rationale may be left out.
    expect(parsePlan(JSON.stringify({ tasks }))).toMatchObject({ ok: true, shape: null });
    expect(parsePlan(JSON.stringify({ shape: null, tasks }))).toMatchObject({ ok: true, shape: null });
    expect(parsePlan(JSON.stringify({ shape: { parallelism: MAX_TEAM_WORKERS, review: "each" }, tasks }))).toMatchObject({ ok: true, shape: { parallelism: MAX_TEAM_WORKERS, review: "each", rationale: "" } });
    expect(parsePlan(JSON.stringify({ shape: { parallelism: 2, review: "none", rationale: "Independent files." }, tasks }))).toMatchObject({ ok: true, shape: { review: "none" } });
  });

  it("refuses a bad shape, naming every fault, and never falls back to the default for one", () => {
    const refusedWith = (shape: unknown) => parsePlan(JSON.stringify({ shape, tasks }));
    expect(refusedWith({ parallelism: 0, review: "each" })).toMatchObject({ ok: false, reason: expect.stringMatching(/parallelism is 0; it must be a whole number from 1 to 3/) });
    expect(refusedWith({ parallelism: MAX_TEAM_WORKERS + 1, review: "each" })).toMatchObject({ ok: false, reason: expect.stringMatching(/parallelism is 4/) });
    expect(refusedWith({ parallelism: 1.5, review: "each" })).toMatchObject({ ok: false, reason: expect.stringMatching(/parallelism is 1.5/) });
    expect(refusedWith({ parallelism: "2", review: "each" })).toMatchObject({ ok: false, reason: expect.stringMatching(/parallelism is "2"/) });
    expect(refusedWith({ review: "each" })).toMatchObject({ ok: false, reason: expect.stringMatching(/parallelism is null/) });
    expect(refusedWith({ parallelism: 2, review: "sometimes" })).toMatchObject({ ok: false, reason: expect.stringMatching(/review is "sometimes"; it must be "each", "final", "none"/) });
    expect(refusedWith({ parallelism: 2, review: "each", rationale: "r".repeat(201) })).toMatchObject({ ok: false, reason: expect.stringMatching(/rationale has 201 characters; the maximum is 200/) });
    expect(refusedWith({ parallelism: 2, review: "each", rationale: 7 })).toMatchObject({ ok: false, reason: expect.stringMatching(/rationale is not text/) });
    expect(refusedWith("serial")).toMatchObject({ ok: false, reason: expect.stringMatching(/shape is not an object/) });
    // A shape fault and a task fault are named together, like two task faults.
    const both = parsePlan(JSON.stringify({ shape: { parallelism: 9, review: "each" }, tasks: [{ files_hint: [] }] }));
    expect(both).toMatchObject({ ok: false, reason: expect.stringMatching(/parallelism is 9.*Task t1 has no task_description/) });
  });

  it("refuses an object that carries no tasks array", () => {
    expect(parsePlan(JSON.stringify({ shape: { parallelism: 1, review: "each" } }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no "tasks" array/) });
    expect(parsePlan(JSON.stringify({ shape: { parallelism: 1, review: "each" }, tasks: "t1" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no "tasks" array/) });
    expect(parsePlan(JSON.stringify({ shape: { parallelism: 1, review: "each" }, tasks: [] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no tasks/) });
  });

  it("tells the planner how to size the team: one-file fix, independent files, a migration", () => {
    expect(PLANNER_BRIEF).toContain('"shape"');
    expect(PLANNER_BRIEF).toMatch(/one-file fix is ONE task with parallelism 1 and review "final"/);
    expect(PLANNER_BRIEF).toMatch(/independent files may run in parallel/);
    expect(PLANNER_BRIEF).toMatch(/migration.*serially/);
    expect(PLANNER_BRIEF).toContain(`1 to ${MAX_TEAM_WORKERS}`);
  });
});

/** A board as the lead sees it: t1 done, the rest as given. */
function ctxOf(statuses: TaskStatus[], added = 0, retired = 0): ReplanContext {
  return { tasks: statuses.map((status, i) => ({ task_id: `t${i + 1}`, status })), added, retired };
}

describe("parseReplan — the lead's answer", () => {
  const task = (description: string, extra: Record<string, unknown> = {}) => ({ task_description: description, files_hint: ["x.ts"], ...extra });

  it("reads {} and a note alone as no change, fenced or bare", () => {
    const ctx = ctxOf(["complete", "pending"]);
    expect(parseReplan("{}", ctx)).toEqual({ ok: true, add: [], retire: [], note: "" });
    expect(parseReplan('The plan stands.\n```json\n{"note": "t2 still fits"}\n```', ctx)).toEqual({ ok: true, add: [], retire: [], note: "t2 still fits" });
    expect(parseReplan('{"add": [], "retire": [], "note": "x"}', ctx)).toMatchObject({ ok: true, add: [], retire: [] });
  });

  it("takes adds numbered after the board — depending on the board or on an earlier add — and retires of pending tasks", () => {
    const ctx = ctxOf(["complete", "pending", "pending"]);
    const out = parseReplan(JSON.stringify({
      add: [task("Add a favicon", { depends_on: ["t1"] }), task("Link the favicon", { depends_on: ["t4", "t2"] })],
      retire: ["t3", "t3"],
      note: "t1 already wrote the README",
    }), ctx);
    expect(out).toEqual({
      ok: true,
      add: [
        { task_description: "Add a favicon", depends_on: ["t1"], files_hint: ["x.ts"] },
        { task_description: "Link the favicon", depends_on: ["t4", "t2"], files_hint: ["x.ts"] },
      ],
      retire: ["t3"],
      note: "t1 already wrote the README",
    });
  });

  it("refuses more adds than the team has left, and a board over MAX_TEAM_TASKS", () => {
    const three = { add: [task("a"), task("b"), task("c")] };
    expect(parseReplan(JSON.stringify(three), ctxOf(["complete"]))).toMatchObject({ ok: true });
    expect(parseReplan(JSON.stringify({ add: [task("a"), task("b"), task("c"), task("d")] }), ctxOf(["complete"]))).toMatchObject({ ok: false, reason: expect.stringMatching(new RegExp(`adds 4 task\\(s\\); the lead adds at most ${MAX_LEAD_ADDS} over the team and has ${MAX_LEAD_ADDS} left`)) });
    // Two already added over the team's life: one left.
    expect(parseReplan(JSON.stringify({ add: [task("a"), task("b")] }), ctxOf(["complete", "pending", "pending"], 2))).toMatchObject({ ok: false, reason: expect.stringMatching(/has 1 left/) });
    const seven = ctxOf(["complete", "pending", "pending", "pending", "pending", "pending", "pending"]);
    expect(parseReplan(JSON.stringify({ add: [task("a"), task("b")] }), seven)).toMatchObject({ ok: false, reason: expect.stringMatching(/to the board's 7; a team holds at most 8/) });
  });

  it("refuses more retires than are left, and a retirement of anything but a pending task", () => {
    expect(parseReplan('{"retire": ["t2", "t3", "t4"]}', ctxOf(["complete", "pending", "pending", "pending"]))).toMatchObject({ ok: false, reason: expect.stringMatching(new RegExp(`retires 3 task\\(s\\); a team retires at most ${MAX_LEAD_RETIRES}`)) });
    expect(parseReplan('{"retire": ["t3"]}', ctxOf(["complete", "retired", "pending"], 0, 2))).toMatchObject({ ok: false, reason: expect.stringMatching(/has 0 left/) });
    for (const status of ["complete", "in_progress", "failed", "rejected", "retired"] as const) {
      expect(parseReplan('{"retire": ["t2"]}', ctxOf(["complete", status])), status).toMatchObject({ ok: false, reason: expect.stringMatching(new RegExp(`retires t2, which is ${status}; only a pending task may be retired`)) });
    }
    expect(parseReplan('{"retire": ["t9"]}', ctxOf(["complete", "pending"]))).toMatchObject({ ok: false, reason: expect.stringMatching(/t9, which is not on the board/) });
    expect(parseReplan('{"retire": "t2"}', ctxOf(["complete", "pending"]))).toMatchObject({ ok: false, reason: expect.stringMatching(/retire is not a list/) });
  });

  it("refuses new tasks that wait on each other in a cycle, on themselves, on nothing, on a later add, or on a task that failed", () => {
    const ctx = ctxOf(["complete", "pending", "failed"]);
    expect(parseReplan(JSON.stringify({ add: [task("a", { depends_on: ["t5"] }), task("b", { depends_on: ["t4"] })] }), ctx)).toMatchObject({ ok: false, reason: "Tasks t4 and t5 depend on each other." });
    expect(parseReplan(JSON.stringify({ add: [task("a", { depends_on: ["t4"] })] }), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/t4 depends on t4, which is not another task/) });
    expect(parseReplan(JSON.stringify({ add: [task("a", { depends_on: ["t7"] })] }), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/t4 depends on t7, which is not another task/) });
    expect(parseReplan(JSON.stringify({ add: [task("a", { depends_on: ["t04"] })] }), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/t4 depends on t04/) });
    // No cycle, but posted in order a task cannot wait on one listed after it.
    expect(parseReplan(JSON.stringify({ add: [task("a", { depends_on: ["t5"] }), task("b")] }), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/t4 depends on t5, which is listed after it/) });
    expect(parseReplan(JSON.stringify({ add: [task("a", { depends_on: ["t3"] })] }), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/t4 depends on t3, which is failed and will never complete/) });
  });

  it("refuses what is not an answer at all — never repairing it into one", () => {
    const ctx = ctxOf(["complete", "pending"]);
    expect(parseReplan(null, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/answered nothing/) });
    expect(parseReplan("The plan looks fine to me.", ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/no JSON object/) });
    expect(parseReplan('[{"task_description": "x"}]', ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/no JSON object/) });
    expect(parseReplan('{"tasks": [{"task_description": "x"}]}', ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/none of add, retire or note \(it has tasks\)/) });
    expect(parseReplan('{"add": {"task_description": "x"}}', ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/add is not a list/) });
    expect(parseReplan('{"note": 3}', ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/note is not text/) });
    expect(parseReplan(JSON.stringify({ add: [{ files_hint: [] }] }), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/t3 has no task_description/) });
    // One bad add refuses the whole answer, the good retire with it.
    expect(parseReplan(JSON.stringify({ retire: ["t2"], add: [{ task_description: "x".repeat(2001) }] }), ctx)).toMatchObject({ ok: false });
    // A long note is only shortened: it decides nothing.
    const long = parseReplan(JSON.stringify({ note: "n".repeat(MAX_LEAD_NOTE_CHARS + 50) }), ctx);
    expect(long.ok && long.note.length).toBe(MAX_LEAD_NOTE_CHARS);
  });
});

describe("the lead's view and words", () => {
  it("counts a task a worker is being started on as in progress, so it cannot be retired", () => {
    const board = { tasks: [
      { task_id: "t1", status: "complete", origin: "plan" },
      { task_id: "t2", status: "pending", origin: "plan" },
      { task_id: "t3", status: "pending", origin: "lead" },
      { task_id: "t4", status: "retired", origin: "plan" },
    ] } as unknown as Parameters<typeof replanContext>[0];
    const ctx = replanContext(board, new Set(["t2"]));
    expect(ctx).toEqual({ tasks: [
      { task_id: "t1", status: "complete" },
      { task_id: "t2", status: "in_progress" },
      { task_id: "t3", status: "pending" },
      { task_id: "t4", status: "retired" },
    ], added: 1, retired: 1 });
    expect(parseReplan('{"retire": ["t2"]}', ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/t2, which is in_progress/) });
    expect(leadRoom(ctx)).toEqual({ adds: MAX_LEAD_ADDS - 1, retires: MAX_LEAD_RETIRES - 1, retirable: ["t3"] });
    // Nothing pending: no retire to spend, whatever is left of the budget.
    expect(leadRoom(ctxOf(["complete", "in_progress"]))).toMatchObject({ retires: 0, retirable: [] });
    expect(leadRoom(ctxOf(["complete", "pending"], MAX_LEAD_ADDS, MAX_LEAD_RETIRES))).toMatchObject({ adds: 0, retires: 0 });
  });

  it("briefs the lead: read-only, the object it answers, and its bounds", () => {
    expect(REPLAN_BRIEF).toMatch(/You are the LEAD/);
    // Messages the team's runs sent "to the lead" are on the board it reads — the new ones in its inbox.
    expect(REPLAN_BRIEF).toMatch(/told the lead with team_message .* board you are given/);
    expect(REPLAN_BRIEF).toContain('listed in full under "Messages to the lead since your last turn:"');
    expect(REPLAN_BRIEF).toMatch(/one or more workers have just finished/);
    expect(PLANNER_BRIEF).toMatch(/team_message .* still answer with the JSON plan/);
    expect(REPLAN_BRIEF).toMatch(/change NOTHING/);
    expect(REPLAN_BRIEF).toContain("ONLY a JSON object");
    expect(REPLAN_BRIEF).toContain('"add"');
    expect(REPLAN_BRIEF).toContain('"retire"');
    expect(REPLAN_BRIEF).toContain(`at most ${MAX_LEAD_ADDS} tasks over the whole team`);
    expect(REPLAN_BRIEF).toContain(`At most ${MAX_LEAD_RETIRES} over the whole team`);
    // The planner's rules for writing a task are the lead's too.
    expect(REPLAN_BRIEF).toContain(`at most ${MAX_TASK_DESCRIPTION_CHARS} characters`);
  });

  it("has two tasks that share a contract say, in both, which owns it and that the other asks for it", () => {
    for (const brief of [PLANNER_BRIEF, REPLAN_BRIEF]) {
      expect(brief).toContain("When two tasks share a contract — an API shape, a schema, a module path — say in BOTH task_descriptions which task owns it");
      expect(brief).toMatch(/ask that task's worker for it with team_message \(to="sibling"\) rather than invent it/);
    }
  });

  it("gives the lead the settled task, its result, what it may change and the board — inside the cap", async () => {
    const { createBoard, postTask } = await import("@/lib/coding-team-board");
    const board = createBoard({ goal: "g".repeat(3_900), projectId: null, directory: "/p", source: "owner" }, { kind: "owner" });
    for (let i = 0; i < 6; i++) postTask(board, { kind: "planner" }, { task_description: `Task number ${i + 1} ${"d".repeat(1_500)}` });
    Object.assign(board.tasks[0], { status: "complete", result: `Did it. ${"r".repeat(5_000)}`, review: { verdict: "accepted", notes: "", at: 1 } });
    const text = leadTask(board, ["t1"], replanContext(board));
    expect(text.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
    expect(text).toMatch(/^Task t1 just settled \(complete, accepted\): Task number 1/);
    expect(text).toContain("Its worker's result:\nDid it.");
    // Six on the board: two more fit under MAX_TEAM_TASKS, whatever the lead's own budget.
    expect(text).toContain(`add ${MAX_TEAM_TASKS - 6} more task(s) (numbered from t7)`);
    expect(text).toContain("pending now: t2, t3, t4, t5, t6");
    expect(text).toContain("t2 [pending] — Task number 2");
    // The settled task is not in the digest twice.
    expect(text).not.toContain("t1 [complete]");
  });
});

// ─── TASK-1116: when the lead runs, and what it is shown ─────────────────────

const OWNER = { kind: "owner" } as const;
const PLANNER = { kind: "planner" } as const;
const worker = (id: string) => ({ kind: "worker", id }) as const;

/** A board of tasks t1… in the given states; run-aaaaaaaa is t1's worker, run-bbbbbbbb t2's. */
function boardOf(tasks: Array<{ status: TaskStatus; verdict?: "accepted" | "rejected"; result?: string; depends_on?: string[] }>): TeamBoard {
  const board = createBoard({ goal: "Build the invoice app", projectId: null, directory: "/p", source: "owner" }, OWNER);
  tasks.forEach((t, i) => {
    postTask(board, PLANNER, { task_description: `Task number ${i + 1}`, depends_on: t.depends_on });
    Object.assign(board.tasks[i], {
      status: t.status,
      result: t.result ?? (t.status === "pending" && !t.verdict ? null : `Did task ${i + 1}.`),
      review: t.verdict ? { verdict: t.verdict, notes: t.verdict === "rejected" ? "No <title>." : "", at: 1 } : null,
    });
  });
  board.runs.push({ id: "run-aaaaaaaa", role: "worker", taskId: "t1" }, { id: "run-bbbbbbbb", role: "worker", taskId: "t2" });
  return board;
}

const tell = (board: TeamBoard, from: string, text: string, at: number, to: "lead" | "owner_agent" = "lead") =>
  postMessage(board, worker(from), { from_run_id: from, to, text }, at);

describe("leadShouldRun — a lead run only when there is something to decide", () => {
  it("skips a batch accepted clean, with no message to the lead and no blocker", () => {
    const board = boardOf([{ status: "complete", verdict: "accepted" }, { status: "complete", verdict: "accepted" }, { status: "pending" }]);
    expect(leadShouldRun(board, ["t1", "t2"], 0)).toMatchObject({ run: false });
  });

  it("runs after a rejection — offered again or for good — and after a failure", () => {
    for (const [status, verdict] of [["pending", "rejected"], ["rejected", "rejected"], ["failed", undefined]] as const) {
      const board = boardOf([{ status: "complete", verdict: "accepted" }, { status, verdict }, { status: "pending" }]);
      expect(leadShouldRun(board, ["t1", "t2"], 0), status).toEqual({ run: true, why: status === "failed" ? "t2 failed" : "t2 was rejected" });
    }
  });

  it("runs for a message to the lead after sinceTs — not for one before it, nor for one to someone else", () => {
    const board = boardOf([{ status: "complete", verdict: "accepted" }, { status: "pending" }]);
    tell(board, "run-aaaaaaaa", "The spec names a logo.svg nobody makes.", 5_000);
    expect(leadShouldRun(board, ["t1"], 4_999)).toEqual({ run: true, why: "run-aaaaaaaa sent the lead a message" });
    expect(leadShouldRun(board, ["t1"], 5_000)).toMatchObject({ run: false });
    tell(board, "run-bbbbbbbb", "Done with the form.", 6_000, "owner_agent");
    expect(leadShouldRun(board, ["t1"], 5_000)).toMatchObject({ run: false });
  });

  it("runs when a worker's result names a blocker, on its first line or any other", () => {
    for (const result of [
      "BLOCKED: t3 needs the API key only the owner has.",
      "cannot find styles.css",
      "Built the form.\nMISSING: assets/logo.svg — no task makes it.",
      "Wired app.js.\n\n- Could not run the tests: there is no node here.",
      "Built the form.\nblocked: waiting on t1's form ids",
      "Built the form.\n\nNOT COMMITTED: fatal: cannot lock ref",
      "Built the form.\n\nMERGE CONFLICT: CONFLICT (content): Merge conflict in index.html",
      "Built the form.\n**BLOCKED**: t3 needs the owner's API key.",
      "Built the form.\n\n## Could not finish\n- Wiring the totals: app.js is not there yet.",
    ]) {
      const board = boardOf([{ status: "complete", verdict: "accepted", result }, { status: "pending" }]);
      expect(leadShouldRun(board, ["t1"], 0), result).toMatchObject({ run: true, why: expect.stringMatching(/^t1's result says: /) });
    }
    // The words inside a line, or inside a longer word, are not a blocker — and
    // neither is the report's "could not finish" section with nothing in it.
    for (const result of [
      "All done — nothing BLOCKED, nothing MISSING; I cannot see a gap.",
      "cannot-fail tests pass.",
      "MISSINGNO is the sprite's name.",
      "Changed index.html.\nCould not finish: nothing.",
      "Changed index.html.\n**Could not finish:** None.",
      "Changed index.html.\n\n## Could not finish\n\nNone — all of it is done.",
      "Changed index.html.\nCould not finish:\n- n/a",
    ]) {
      const fine = boardOf([{ status: "complete", verdict: "accepted", result }, { status: "pending" }]);
      expect(leadShouldRun(fine, ["t1"], 0), result).toMatchObject({ run: false });
    }
  });

  it("runs when nothing left can start and the goal is not complete — a dependency chain broke", () => {
    const broke = { run: true, why: "nothing left can start, and the goal is not complete" };
    // t2 failed on an earlier turn; t1, the last to settle, was clean.
    expect(leadShouldRun(boardOf([{ status: "complete", verdict: "accepted" }, { status: "failed" }]), ["t1"], 0)).toEqual(broke);
    // No pending task can start: t3 waits on t2, rejected for good.
    expect(leadShouldRun(boardOf([{ status: "complete", verdict: "accepted" }, { status: "rejected", verdict: "rejected" }, { status: "pending", depends_on: ["t2"] }]), ["t1"], 0)).toEqual(broke);
    // A worker still at work is not a broken chain.
    expect(leadShouldRun(boardOf([{ status: "complete", verdict: "accepted" }, { status: "in_progress" }]), ["t1"], 0)).toMatchObject({ run: false });
  });
});

describe("leadTask — the lead's batch and its inbox", () => {
  /** The inbox section of a lead's task text, up to the board's digest. */
  const inboxOf = (text: string) => {
    const from = text.indexOf("Messages to the lead since your last turn:");
    const to = text.indexOf("\n\nThe board (");
    return from < 0 ? "" : text.slice(from, to < 0 ? undefined : to);
  };

  it("lists every task of the batch with its status, verdict and result, and leaves them out of the digest", () => {
    const board = boardOf([
      { status: "complete", verdict: "accepted", result: "Built index.html." },
      { status: "pending", verdict: "rejected", result: "Built about.html." },
      { status: "failed", result: "The run ended failed." },
      { status: "pending" },
    ]);
    const text = leadTask(board, ["t1", "t2", "t3"], replanContext(board));
    expect(text).toMatch(/^Task t1 just settled \(complete, accepted\): Task number 1\n\nIts worker's result:\nBuilt index\.html\./);
    expect(text).toContain("Task t2 just settled (pending, rejected: No <title>.): Task number 2\n\nIts worker's result:\nBuilt about.html.");
    expect(text).toContain("Task t3 just settled (failed): Task number 3\n\nIts worker's result:\nThe run ended failed.");
    expect(text).toContain("t4 [pending] — Task number 4");
    for (const id of ["t1", "t2", "t3"]) expect(text).not.toContain(`${id} [`);
  });

  it("shares the room between several long results, inside the cap, keeping the lead's options and the goal", () => {
    const board = boardOf([
      ...[1, 2, 3].map((n) => ({ status: "complete" as const, verdict: "accepted" as const, result: `Result ${n} ${"r".repeat(5_000)}` })),
      { status: "pending" },
    ]);
    board.goal = "g".repeat(3_000);
    const text = leadTask(board, ["t1", "t2", "t3"], replanContext(board));
    expect(text.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
    for (const n of [1, 2, 3]) expect(text).toContain(`Its worker's result:\nResult ${n} rrr`);
    expect(text).toContain("pending now: t4");
    expect(text).toContain("Team goal: ggg");
  });

  it("gives the lead every message to it since its last turn, whole up to 600 characters, after the goal and before the board", () => {
    const board = boardOf([{ status: "complete", verdict: "accepted" }, { status: "pending" }]);
    tell(board, "run-aaaaaaaa", "An old note the lead has read.", 1_000);
    board.lastLeadAt = 2_000;
    const long = `The spec names assets/logo.svg and nobody makes it.${" More detail here.".repeat(40)}`;
    tell(board, "run-bbbbbbbb", long, 3_000);
    tell(board, "run-aaaaaaaa", "Only for the assistant.", 3_500, "owner_agent");
    board.runs.push({ id: "run-cccccccc", role: "planner", taskId: null });
    postMessage(board, PLANNER, { from_run_id: "run-cccccccc", to: "lead", text: "The goal says invoice;\nthe folder says quote." }, 4_000);
    const text = leadTask(board, ["t1"], replanContext(board));
    expect(long.length).toBeGreaterThan(600);
    expect(inboxOf(text)).toBe([
      "Messages to the lead since your last turn:",
      `- worker run-bbbbbbbb (task t2): ${long.slice(0, 599)}…`,
      "- planner run-cccccccc: The goal says invoice; the folder says quote.",
    ].join("\n"));
    expect(text.indexOf("Messages to the lead")).toBeGreaterThan(text.indexOf("Team goal:"));
    expect(text.indexOf("Messages to the lead")).toBeLessThan(text.indexOf("The board ("));
  });

  it("keeps the newest messages within 2,000 characters, and says how many older ones went", () => {
    const board = boardOf([{ status: "complete", verdict: "accepted" }, { status: "pending" }]);
    // Spaced past the per-run window: every one of them is a message the run was allowed.
    for (let i = 1; i <= 8; i++) tell(board, i % 2 ? "run-aaaaaaaa" : "run-bbbbbbbb", `Message ${i}: ${"m".repeat(500)}`, i * 400_000);
    const text = leadTask(board, ["t1"], replanContext(board));
    const inbox = inboxOf(text);
    expect(inbox.length).toBeLessThanOrEqual(MAX_LEAD_INBOX_CHARS);
    expect(inbox).toMatch(/^Messages to the lead since your last turn:\n\(\d older messages left out\)\n- /);
    expect(inbox).toContain("Message 8: ");
    expect(inbox).not.toContain("Message 1: ");
    expect(text.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
  });

  it("reads a board from before the inbox — no lastLeadAt — as a lead that has read nothing yet, and says when there is nothing", () => {
    const board = boardOf([{ status: "complete", verdict: "accepted" }, { status: "pending" }]);
    expect(inboxOf(leadTask(board, ["t1"], replanContext(board)))).toBe("Messages to the lead since your last turn: (none)");
    tell(board, "run-aaaaaaaa", "t2 needs the form ids first.", 1_000);
    const old = JSON.parse(JSON.stringify(board)) as Partial<TeamBoard>;
    delete old.lastLeadAt;
    const text = leadTask(old as TeamBoard, ["t1"], replanContext(old as TeamBoard));
    expect(inboxOf(text)).toBe("Messages to the lead since your last turn:\n- worker run-aaaaaaaa (task t1): t2 needs the form ids first.");
  });
});

describe("the planner's rule for integration tasks", () => {
  it("has a task that checks the others wait for EVERY one of them — the planner's and the lead's", () => {
    const rule = /verifies, integrates or reviews the other tasks' output must list EVERY task it checks in depends_on — never fewer/;
    expect(PLANNER_BRIEF).toMatch(rule);
    expect(REPLAN_BRIEF).toMatch(rule);
  });
});
