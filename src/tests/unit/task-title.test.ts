/**
 * @vitest-environment node
 *
 * One title for a task, wherever it is shown. Bench cycle 1 (2026-09-05)
 * committed "Coding agent: # Paginate the inventory API" and put the same
 * heading marks in the PR title, the run's row and the MCP status — four
 * copies of a first-line function, none of which knew Markdown.
 */
import { describe, expect, it } from "vitest";
import { taskTitle } from "@/lib/task-title";

describe("taskTitle", () => {
  it("takes the first non-empty line", () => {
    expect(taskTitle("Add a dark mode toggle\nand keep it accessible", 80)).toBe("Add a dark mode toggle");
    expect(taskTitle("\n\n  Second line is first  \nthird", 80)).toBe("Second line is first");
  });

  it("strips a Markdown heading's marks, opening and closing, and bold wrapping", () => {
    expect(taskTitle("# Paginate the inventory API\n\nDetails", 80)).toBe("Paginate the inventory API");
    expect(taskTitle("### Fix the footer ###", 80)).toBe("Fix the footer");
    expect(taskTitle("**Ship the invoice page**", 80)).toBe("Ship the invoice page");
    // A hash that is not a heading stays: "#1" is an issue number, and a
    // closing hash comes off a heading only.
    expect(taskTitle("#1 blocker: fix login", 80)).toBe("#1 blocker: fix login");
    expect(taskTitle("Add #hashtag support", 80)).toBe("Add #hashtag support");
    expect(taskTitle("Deploy #", 80)).toBe("Deploy #");
    expect(taskTitle("Fix issue #12", 80)).toBe("Fix issue #12");
  });

  it("cuts a long line with an ellipsis inside the cap", () => {
    const long = "x".repeat(100);
    expect(taskTitle(long, 72)).toBe(`${"x".repeat(71)}…`);
    expect(taskTitle(long, 72)).toHaveLength(72);
    expect(taskTitle("short", 72)).toBe("short");
  });

  it("answers empty for nothing, so each caller keeps its own fallback", () => {
    expect(taskTitle("", 80)).toBe("");
    expect(taskTitle("\n \n", 80)).toBe("");
    expect(taskTitle("# ", 80)).toBe("");
    expect(taskTitle(undefined as unknown as string, 80)).toBe("");
  });
});
