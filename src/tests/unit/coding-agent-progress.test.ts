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
import { estimateRunProgress, formatEta } from "@/lib/coding-agent-progress";
import { describeProgressLine, RUNNER_STEP } from "@/lib/coding-agent-progress";

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
      "Grep useState",
      // Close to a runner sentence, but not one of them: the patterns are
      // anchored, so an agent talking about its own run is still its words.
      "Started with a look at the tests, then wrote the route",
      "Committed as agreed with you earlier",
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

describe("estimateRunProgress", () => {

  const base = { status: "running", startedAt: 0 };

  it("reads the run's own plan: done over planned, a live item counting half", () => {
    const todos = [
      { status: "completed" }, { status: "completed" },
      { status: "in_progress" }, { status: "pending" },
    ];
    const est = estimateRunProgress({ ...base, todos }, 10 * 60_000);
    expect(est.fraction).toBeCloseTo(0.625, 3);
    // elapsed 10min at 62.5% → ~6min left
    expect(est.etaMs).toBe(Math.round((10 * 60_000 * 0.375) / 0.625));
  });

  it("draws nothing without a plan — step counts were measured misleading and withdrawn", () => {
    // 291 stream events vs the CLI's 38 turns on a real run: no event
    // arithmetic reproduces the CLI's definition, so no bar without todos.
    expect(estimateRunProgress(base, 60_000).fraction).toBeNull();
    const many = Array.from({ length: 10 }, () => ({ status: "completed" }));
    expect(estimateRunProgress({ ...base, todos: many }, 60_000).fraction).toBe(0.97); // capped while alive
  });

  it("suppresses the ETA while extrapolation is noise", () => {
    // Early fraction and early clock both gate it.
    const early = Array.from({ length: 20 }, (_, i) => ({ status: i === 0 ? "completed" : "pending" }));
    expect(estimateRunProgress({ ...base, todos: early }, 10 * 60_000).etaMs).toBeNull(); // 5%
    const todos = [{ status: "completed" }, { status: "pending" }];
    expect(estimateRunProgress({ ...base, todos }, 10_000).etaMs).toBeNull(); // < 30s elapsed
  });

  it("draws a full bar only for a completed run, nothing for the rest", () => {
    expect(estimateRunProgress({ ...base, status: "completed" }, 1).fraction).toBe(1);
    expect(estimateRunProgress({ ...base, status: "failed" }, 1).fraction).toBeNull();
    expect(estimateRunProgress({ ...base, status: "draft" }, 1).fraction).toBeNull();
    expect(estimateRunProgress({ ...base, todos: [] }, 1).fraction).toBeNull();
  });

  it("says minutes and hours, never seconds", () => {
    expect(formatEta(90_000)).toBe("2 min");
    expect(formatEta(30_000)).toBe("1 min");
    expect(formatEta(3_900_000)).toBe("1 h 5 min");
  });
});


/**
 * The runner's own sentences.
 *
 * They reached the run page as the English the runner wrote — "Started with
 * deepseek-v4-pro[1m]", "Thinking…", "Automatic review pass of run-xyz" —
 * between chips that were properly translated. The only handle a surface has
 * on a line is its text, so the writer (RUNNER_STEP, used by coding-agent.ts)
 * and the reader (describeProgressLine) live in one module and are pinned
 * together here: a reworded step that stopped matching would fall back to
 * English in silence, which is the defect itself.
 */
describe("the runner's own sentences are keyed", () => {
  it.each([
    [RUNNER_STEP.thinking, "thinking"],
    [RUNNER_STEP.continuing, "continuing"],
    [RUNNER_STEP.tokenLimit, "tokenLimit"],
    [RUNNER_STEP.resuming, "resuming"],
    [RUNNER_STEP.noRepository, "noRepository"],
    [RUNNER_STEP.merged, "merged"],
    [RUNNER_STEP.providerSilent, "providerSilent"],
    [RUNNER_STEP.paused, "paused"],
    [RUNNER_STEP.stopRequested, "stopRequested"],
    [RUNNER_STEP.pauseRequested, "pauseRequested"],
    [RUNNER_STEP.resumedByOwner, "resumedByOwner"],
    [RUNNER_STEP.drafted, "drafted"],
    [RUNNER_STEP.startedFromDraft, "startedFromDraft"],
    [RUNNER_STEP.leftoverRunning, "leftoverRunning"],
    [RUNNER_STEP.endedLeftovers, "endedLeftovers"],
    [RUNNER_STEP.ownerEndedLeftovers, "ownerEndedLeftovers"],
    [RUNNER_STEP.started(null), "started"],
    [RUNNER_STEP.started("deepseek-v4-pro[1m]"), "startedWith"],
    [RUNNER_STEP.reviewPass("run-gywqvpbg"), "reviewPass"],
    [RUNNER_STEP.startingFresh("run-abc"), "startingFresh"],
    [RUNNER_STEP.workingOnBranch("clawbox/run-1", "main"), "workingOnBranch"],
    [RUNNER_STEP.noPullRequest("no remote"), "noPullRequest"],
    [RUNNER_STEP.committed("4f21ab9", false), "committed"],
    [RUNNER_STEP.committed("4f21ab9", true), "committedNewRepository"],
    [RUNNER_STEP.committedByRun("4f21ab9"), "committedByRun"],
    [RUNNER_STEP.notCommitted("nothing staged"), "notCommitted"],
    [RUNNER_STEP.faviconCommitted("4f21ab9"), "faviconCommitted"],
    [RUNNER_STEP.pullRequestOpened(12, "beta"), "pullRequestOpened"],
    [RUNNER_STEP.notMerged("checks failed"), "notMerged"],
    [RUNNER_STEP.onDesktop("Angry Pigs", "angry-pigs", 4310), "onDesktop"],
    [RUNNER_STEP.notOnDesktop(4310, "nothing is listening"), "notOnDesktop"],
    [RUNNER_STEP.finished("completed"), "finished"],
    [RUNNER_STEP.helperStarted({ workflow: false, type: "explorer", what: "find the tests" }), "subagentStarted"],
    [RUNNER_STEP.helperStarted({ workflow: false, type: "", what: "search the tests" }), "subagentStarted"],
    [RUNNER_STEP.helperStarted({ workflow: true, type: "workflow", what: "review every page" }), "workflowStarted"],
    [RUNNER_STEP.helperSettled({ workflow: false, type: "explorer", refused: false }), "subagentFinished"],
    [RUNNER_STEP.helperSettled({ workflow: false, type: "sub-agent", refused: true }), "subagentRefused"],
    [RUNNER_STEP.helperSettled({ workflow: true, type: "workflow", refused: false }), "workflowFinished"],
    [RUNNER_STEP.helperSettled({ workflow: true, type: "workflow", refused: true }), "workflowRefused"],
    [RUNNER_STEP.dropped(41), "droppedSteps"],
  ])("%s", (line, key) => {
    expect(describeProgressLine(line).labelKey, line).toBe(key);
  });

  it("carries the values the translation needs, and keeps the English as the floor", () => {
    const started = describeProgressLine(RUNNER_STEP.started("deepseek-v4-pro[1m]"));
    expect(started.params).toEqual({ model: "deepseek-v4-pro[1m]" });
    expect(started.label).toBe("Started with deepseek-v4-pro[1m]");
    expect(describeProgressLine(RUNNER_STEP.reviewPass("run-abc")).params).toEqual({ id: "run-abc" });
    expect(describeProgressLine(RUNNER_STEP.committed("4f21ab9", true)).params).toEqual({ sha: "4f21ab9" });
    expect(describeProgressLine(RUNNER_STEP.pullRequestOpened(12, "beta")).params).toEqual({ number: 12, base: "beta" });
    expect(describeProgressLine(RUNNER_STEP.workingOnBranch("clawbox/run-1", "main")).params)
      .toEqual({ branch: "clawbox/run-1", base: "main" });
    expect(describeProgressLine(RUNNER_STEP.dropped(41)).params).toEqual({ count: 41 });
  });

  it("shows a helper's type and description beside the label, never inside it", () => {
    // The type is a name ("explorer") and the description the run's own
    // words: neither is translatable, and both have to survive.
    const out = describeProgressLine(RUNNER_STEP.helperStarted({ workflow: false, type: "explorer", what: "find the tests" }));
    expect(out.detail).toBe("(explorer) find the tests");
    expect(describeProgressLine(RUNNER_STEP.helperSettled({ workflow: false, type: "tester", refused: false })).detail).toBe("tester");
    expect(describeProgressLine(RUNNER_STEP.helperSettled({ workflow: false, type: "sub-agent", refused: false })).detail).toBeUndefined();
  });

  it("is drawn as the run's own words, not as a tool chip — only the wording changes", () => {
    // ProgressDescription["kind"] picks the chip's tone on three surfaces;
    // these lines have always read as the run talking.
    expect(describeProgressLine(RUNNER_STEP.thinking).kind).toBe("text");
    expect(describeProgressLine(RUNNER_STEP.merged).kind).toBe("text");
  });
});
