/** Undo / redo of the Screenshot editor (TASK-1475): an immutable past–present–future stack. */
import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createHistory,
  historyValues,
  pushHistory,
  redo,
  replacePresent,
  undo,
} from "@/lib/screenshot/history";

describe("screenshot history", () => {
  it("starts with nothing to undo or redo", () => {
    const history = createHistory("a");
    expect(history.present).toBe("a");
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it("walks back and forward through the steps", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b");
    history = pushHistory(history, "c");
    expect(history.present).toBe("c");

    history = undo(history);
    expect(history.present).toBe("b");
    expect(canRedo(history)).toBe(true);
    history = undo(history);
    expect(history.present).toBe("a");
    expect(canUndo(history)).toBe(false);

    history = redo(history);
    history = redo(history);
    expect(history.present).toBe("c");
    expect(canRedo(history)).toBe(false);
  });

  it("drops what was undone when a new step is recorded", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b");
    history = undo(history);
    history = pushHistory(history, "x");
    expect(history.present).toBe("x");
    expect(canRedo(history)).toBe(false);
    expect(undo(history).present).toBe("a");
  });

  it("does not record a step that changes nothing", () => {
    const doc = { n: 1 };
    const history = createHistory(doc);
    expect(pushHistory(history, doc)).toBe(history);
    expect(replacePresent(history, doc)).toBe(history);
  });

  it("replaces the present without adding a step", () => {
    let history = pushHistory(createHistory("a"), "b");
    history = replacePresent(history, "b2");
    expect(history.present).toBe("b2");
    expect(history.past).toEqual(["a"]);
    expect(undo(history).present).toBe("a");
  });

  it("never mutates the history it was given", () => {
    const first = createHistory("a");
    const second = pushHistory(first, "b");
    undo(second);
    expect(first).toEqual({ past: [], present: "a", future: [] });
    expect(second).toEqual({ past: ["a"], present: "b", future: [] });
  });

  it("forgets the oldest steps beyond the limit", () => {
    let history = createHistory(0);
    for (let i = 1; i <= 10; i++) history = pushHistory(history, i, 3);
    expect(history.past).toEqual([7, 8, 9]);
    expect(history.present).toBe(10);

    let long = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) long = pushHistory(long, i);
    expect(long.past).toHaveLength(HISTORY_LIMIT);
  });

  it("lists every value it still holds", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b");
    history = pushHistory(history, "c");
    history = undo(history);
    expect(historyValues(history)).toEqual(["a", "b", "c"]);
  });
});
