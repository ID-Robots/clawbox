/**
 * The chat card's reading of a run's progress feed.
 *
 * The runner writes progress in the harness's vocabulary — a tool name, a
 * verb and a path, "$ command" — and the owner asked that the chat show
 * "mcp__clawbox__browser_screenshot" as a good-looking element instead. This
 * pins what each shape of line becomes, and that the raw MCP name never
 * survives, whatever the tool.
 */
import { describe, expect, it } from "vitest";
import { describeProgressLine } from "@/lib/coding-agent-progress";

describe("describeProgressLine", () => {
  describe("the browser tools, named the MCP way", () => {
    it("a screenshot is a Screenshot with a camera", () => {
      expect(describeProgressLine("mcp__clawbox__browser_screenshot")).toEqual({
        kind: "tool", label: "Screenshot", labelKey: "screenshot", icon: "photo_camera",
      });
    });

    it("looking at a local page", () => {
      expect(describeProgressLine("mcp__clawbox__browser_view_local")).toMatchObject({
        kind: "tool", labelKey: "lookingAtPage", label: "Looking at the page", icon: "visibility",
      });
    });

    it("opening and navigating are both 'opening a page'", () => {
      for (const name of ["browser_open", "browser_navigate"]) {
        expect(describeProgressLine(`mcp__clawbox__${name}`), name).toMatchObject({
          kind: "tool", labelKey: "openingPage", icon: "open_in_browser",
        });
      }
    });

    it("click, type, keypress and scroll are all 'driving the page'", () => {
      for (const name of ["browser_click", "browser_type", "browser_keypress", "browser_scroll"]) {
        expect(describeProgressLine(`mcp__clawbox__${name}`), name).toMatchObject({
          kind: "tool", labelKey: "drivingPage", icon: "touch_app",
        });
      }
    });

    it("closing the browser", () => {
      expect(describeProgressLine("mcp__clawbox__browser_close")).toMatchObject({ kind: "tool", labelKey: "closingPage" });
    });

    it("accepts the bare tool name too", () => {
      expect(describeProgressLine("browser_screenshot")).toMatchObject({ labelKey: "screenshot" });
    });

    it("NEVER shows the raw mcp__ name, even for a tool it does not know", () => {
      const d = describeProgressLine("mcp__clawbox__some_other_tool");
      expect(d.kind).toBe("tool");
      expect(d.label).not.toMatch(/mcp__/);
      expect(d.label).toBe("some other tool");
      expect(d.labelKey).toBeUndefined();
    });
  });

  describe("files", () => {
    it("Write x is a file step with the basename and a verb", () => {
      expect(describeProgressLine("Write style.css")).toEqual({
        kind: "file", label: "Writing", labelKey: "write", icon: "edit_document", detail: "style.css",
      });
    });

    it("keeps only the basename of a deep path", () => {
      expect(describeProgressLine("Edit src/components/app/index.tsx")).toMatchObject({
        kind: "file", labelKey: "edit", icon: "edit", detail: "index.tsx",
      });
    });

    it("Read x", () => {
      expect(describeProgressLine("Read index.html")).toMatchObject({ kind: "file", labelKey: "read", detail: "index.html" });
    });

    it("NotebookEdit reads as an edit", () => {
      expect(describeProgressLine("NotebookEdit notes.ipynb")).toMatchObject({ labelKey: "edit", detail: "notes.ipynb" });
    });

    it("a verb with no path is still a file step, with no detail", () => {
      const d = describeProgressLine("Write");
      expect(d).toMatchObject({ kind: "file", labelKey: "write" });
      expect(d.detail).toBeUndefined();
    });

    it("does not mistake a sentence that starts with a verb's letters", () => {
      expect(describeProgressLine("Reading the brief first")).toMatchObject({ kind: "text" });
      expect(describeProgressLine("Written by the run")).toMatchObject({ kind: "text" });
    });
  });

  describe("commands", () => {
    it("$ cmd is a command", () => {
      expect(describeProgressLine("$ node --check app.js")).toEqual({
        kind: "command", label: "node --check app.js", icon: "terminal",
      });
    });

    it("strips the device path prefix wherever it appears", () => {
      expect(describeProgressLine("$ node --check /home/clawbox/clawbox/data/code-projects/timer/app.js").label)
        .toBe("node --check data/code-projects/timer/app.js");
    });

    it("cuts a long command at about sixty characters with an ellipsis", () => {
      const long = `$ ${"x".repeat(200)}`;
      const d = describeProgressLine(long);
      expect(d.label.length).toBe(60);
      expect(d.label.endsWith("…")).toBe(true);
    });

    it("trims and collapses whitespace", () => {
      expect(describeProgressLine("  $   npm    test  ").label).toBe("npm test");
    });
  });

  describe("everything else is the run's own words", () => {
    it.each([
      "Now the JavaScript:",
      "Thinking…",
      "Started with claude-sonnet",
      "Sub-agent started (explorer): find the tests",
      "Finished: completed",
      "Grep useState",
    ])("%s", (line) => {
      expect(describeProgressLine(line)).toEqual({ kind: "text", label: line, icon: "notes" });
    });

    it("an empty line is empty text, not a crash", () => {
      expect(describeProgressLine("")).toEqual({ kind: "text", label: "", icon: "notes" });
      expect(describeProgressLine("   ")).toMatchObject({ kind: "text", label: "" });
    });
  });
});

describe("the run's plan", () => {
  it("'Plan: 7 tasks, 3 done' is a checklist chip carrying the two counts — never the English words", () => {
    // The card says the counts in the owner's language; a `detail` is shown
    // verbatim, and "Aufgaben 7 tasks, 3 done" was the one chip left in English.
    expect(describeProgressLine("Plan: 7 tasks, 3 done")).toEqual({
      kind: "tool", label: "Plan", labelKey: "plan", icon: "checklist", counts: { total: 7, done: 3 },
    });
    expect(describeProgressLine("Plan: 1 task, 0 done")).toMatchObject({ labelKey: "plan", counts: { total: 1, done: 0 } });
    expect(describeProgressLine("Plan: 7 tasks, 3 done").detail).toBeUndefined();
  });

  it("a plan line in any other shape is the run's own sentence, not a plan chip", () => {
    expect(describeProgressLine("Plan: rewrite the loop first")).toMatchObject({ kind: "text", icon: "notes" });
  });
});
