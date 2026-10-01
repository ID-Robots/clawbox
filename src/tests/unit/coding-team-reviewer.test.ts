/**
 * The reviewer's verdict parser: strict the way the planner's is. A verdict
 * that is not what the reviewer said is never repaired into one.
 */
import { describe, expect, it } from "vitest";
import { MAX_TASK_CHARS } from "@/lib/coding-agent";
import { ANSWER_HEAD_CHARS, answerHead, FINAL_REVIEWER_BRIEF, MAX_NOTES_CHARS, MAX_REVIEW_FILES, parseVerdict, reviewerTask, REVIEWER_BRIEF, REVIEWER_NUDGE } from "@/lib/coding-team-reviewer";

describe("parseVerdict", () => {
  it("reads a bare object, a fenced one, and one buried in prose", () => {
    expect(parseVerdict('{"verdict":"accepted","notes":""}')).toEqual({ ok: true, verdict: { verdict: "accepted", notes: "" } });
    expect(parseVerdict('Here you go:\n```json\n{"verdict": "rejected", "notes": "index.html has no <title>"}\n```')).toEqual({ ok: true, verdict: { verdict: "rejected", notes: "index.html has no <title>" } });
    expect(parseVerdict('I looked at the files. {"verdict":"accepted","notes":"Fine, one nit: spacing."} Done.')).toEqual({ ok: true, verdict: { verdict: "accepted", notes: "Fine, one nit: spacing." } });
  });

  it("is not fooled by braces inside strings, and takes the first object that parses", () => {
    expect(parseVerdict('{"verdict":"accepted","notes":"the { in app.js is fine"}')).toMatchObject({ ok: true, verdict: { notes: "the { in app.js is fine" } });
    expect(parseVerdict('{"not":"this"} then {"verdict":"rejected","notes":"missing app.js"}')).toMatchObject({ ok: false });
  });

  it("refuses nothing, non-JSON, an unknown verdict, and a rejection without a reason", () => {
    expect(parseVerdict("")).toMatchObject({ ok: false, reason: expect.stringContaining("nothing") });
    expect(parseVerdict("looks good to me")).toMatchObject({ ok: false, reason: expect.stringContaining("no JSON object") });
    // An object inside an array is still the object the reviewer meant.
    expect(parseVerdict('[{"verdict":"accepted"}]')).toMatchObject({ ok: true, verdict: { verdict: "accepted", notes: "" } });
    expect(parseVerdict('{"verdict":"maybe","notes":"x"}')).toMatchObject({ ok: false, reason: expect.stringContaining("not accepted or rejected") });
    expect(parseVerdict('{"verdict":"rejected","notes":""}')).toMatchObject({ ok: false, reason: expect.stringContaining("without saying why") });
  });

  it("caps the notes", () => {
    const long = "x".repeat(MAX_NOTES_CHARS + 500);
    const out = parseVerdict(JSON.stringify({ verdict: "rejected", notes: long }));
    expect(out.ok && out.verdict.notes.length).toBe(MAX_NOTES_CHARS);
  });
});

describe("parseVerdict, however the answer is dressed (TASK-1323)", () => {
  it("reads a json-tagged fence before any other fence, in any case, after any prose", () => {
    const snippetFirst = 'The handler reads:\n```ts\nconst opts = { retries: 1 };\n```\nMy verdict:\n```JSON\n{"verdict": "accepted", "notes": ""}\n```';
    expect(parseVerdict(snippetFirst)).toEqual({ ok: true, verdict: { verdict: "accepted", notes: "" } });
    const quotedFirst = 'package.json has:\n```\n{"name": "site"}\n```\n\n```json\n{"verdict": "rejected", "notes": "No build script."}\n```';
    expect(parseVerdict(quotedFirst)).toEqual({ ok: true, verdict: { verdict: "rejected", notes: "No build script." } });
  });

  it("is not thrown by a stray quote in the prose before the object", () => {
    expect(parseVerdict('The worker wrote "done. {"verdict":"accepted","notes":"fine"}')).toEqual({ ok: true, verdict: { verdict: "accepted", notes: "fine" } });
    expect(parseVerdict('Checked on a 5" screen.\n\n{"verdict": "rejected", "notes": "The form overflows."}')).toEqual({ ok: true, verdict: { verdict: "rejected", notes: "The form overflows." } });
  });

  it("reads past a long answer full of code braces, and gives up — as no object, so re-asked — only on one built never to close", () => {
    const code = "if (ok) { render(form, opts".repeat(8_000);
    expect(parseVerdict(`${code}\n{"verdict":"accepted","notes":"ok"}`)).toEqual({ ok: true, verdict: { verdict: "accepted", notes: "ok" } });
    expect(parseVerdict(`${'{"a'.repeat(60_000)}\n{"verdict":"accepted","notes":"ok"}`)).toMatchObject({ ok: false, missing: true });
  });

  it("marks an answer with no object at all as missing — the one failure a re-ask can mend", () => {
    expect(parseVerdict("I reviewed it; all good.")).toEqual({ ok: false, reason: "The reviewer's answer holds no JSON object.", missing: true });
    expect(parseVerdict("  \n")).toEqual({ ok: false, reason: "The reviewer answered nothing.", missing: true });
    // A reviewer that only echoes the nudge back has still given no verdict.
    expect(parseVerdict(REVIEWER_NUDGE)).toMatchObject({ ok: false, missing: true });
    // An object that is there but wrong is what the reviewer said.
    expect(parseVerdict('{"verdict":"maybe","notes":"x"}')).not.toHaveProperty("missing");
    expect(parseVerdict('{"verdict":"rejected","notes":""}')).not.toHaveProperty("missing");
  });
});

describe("answerHead", () => {
  it("quotes the start of an answer on one line, at most ANSWER_HEAD_CHARS characters", () => {
    expect(answerHead("Looks\n\n  fine\tto me.")).toBe('"Looks fine to me."');
    expect(answerHead(null)).toBe('""');
    const head = answerHead("x".repeat(ANSWER_HEAD_CHARS * 3));
    expect(head).toBe(`"${"x".repeat(ANSWER_HEAD_CHARS - 1)}…"`);
    expect(head.length).toBe(ANSWER_HEAD_CHARS + 2);
  });
});

describe("the reviewer's brief and task", () => {
  it("tells the reviewer to change nothing and to answer only the JSON object", () => {
    expect(REVIEWER_BRIEF).toContain("Change NOTHING");
    expect(REVIEWER_BRIEF).toContain("ONLY a JSON object");
  });

  it("ends both briefs with the verdict as the last thing written, after any tool call (TASK-1323)", () => {
    for (const brief of [REVIEWER_BRIEF, FINAL_REVIEWER_BRIEF]) {
      expect(brief.endsWith("The verdict object is the LAST thing you write, after your last tool call and any team_message: no summary, sign-off or other prose follows it.")).toBe(true);
    }
    expect(REVIEWER_NUDGE).toMatch(/^Answer with the JSON verdict object only, nothing else/);
  });

  it("sends no message when the verdict is clear — the verdict is what the lead reads", () => {
    for (const brief of [REVIEWER_BRIEF, FINAL_REVIEWER_BRIEF]) {
      expect(brief).toContain("Send NO team_message when your verdict is clear");
      expect(brief).toMatch(/Only when it turns on .*sibling's output|Only when it turns on .*task's output/);
      expect(brief).toContain("a decision only the owner can take");
      expect(brief).toContain("never for progress or acknowledgements");
      expect(brief).toContain("team_message to the owner's assistant");
      expect(brief).not.toMatch(/team_message to the lead/);
    }
  });

  it("lists the task, the goal, the files and the worker's report", () => {
    const text = reviewerTask({ taskId: "t2", description: "Wire app.js", files: ["app.js", "index.html"], report: "Wired it.", goal: "Build the app" });
    expect(text).toContain("Review task t2: Wire app.js");
    expect(text).toContain("Team goal, for context: Build the app");
    expect(text).toContain("- app.js\n- index.html");
    expect(text).toContain("The worker's report:\nWired it.");
    expect(reviewerTask({ taskId: "t1", description: "d", files: [], report: "", goal: "g" })).toContain("changed no files");
  });

  it("names only so many changed files and counts the rest, and never exceeds the run route's cap", () => {
    const files = Array.from({ length: MAX_REVIEW_FILES + 15 }, (_, i) => `src/file-${i}.ts`);
    const text = reviewerTask({ taskId: "t3", description: "d", files, report: "r", goal: "g" });
    expect(text).toContain(`- src/file-${MAX_REVIEW_FILES - 1}.ts`);
    expect(text).not.toContain(`- src/file-${MAX_REVIEW_FILES}.ts`);
    expect(text).toContain("… and 15 more");
    const long = reviewerTask({ taskId: "t4", description: "d", files: [], report: "x".repeat(MAX_TASK_CHARS * 2), goal: "g" });
    expect(long.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});
