/**
 * The reviewer's verdict parser: strict the way the planner's is. A verdict
 * that is not what the reviewer said is never repaired into one.
 */
import { describe, expect, it } from "vitest";
import { MAX_TASK_CHARS } from "@/lib/coding-agent";
import { MAX_NOTES_CHARS, MAX_REVIEW_FILES, parseVerdict, reviewerTask, REVIEWER_BRIEF } from "@/lib/coding-team-reviewer";

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

describe("the reviewer's brief and task", () => {
  it("tells the reviewer to change nothing and to answer only the JSON object", () => {
    expect(REVIEWER_BRIEF).toContain("Change NOTHING");
    expect(REVIEWER_BRIEF).toContain("ONLY a JSON object");
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
