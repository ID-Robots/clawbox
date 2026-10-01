/**
 * The Files app's selection rules (TASK-1273) and the move guards they feed
 * (TASK-1274), as plain functions: what a click, a Ctrl/⌘-click and a
 * Shift-click do, and which folders a selection may be dropped on.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  canMoveInto,
  clickSelection,
  isInsideOrSame,
  parentOf,
  selectAll,
  type FilesSelection,
} from "@/lib/files-selection";

const ORDER = ["a", "b", "c", "d", "e"];
const ids = (s: FilesSelection) => [...s.ids].sort();
const click = (s: FilesSelection, id: string, mods: Partial<{ range: boolean; toggle: boolean }> = {}) =>
  clickSelection(s, ORDER, id, { range: false, toggle: false, ...mods });

describe("clickSelection", () => {
  it("a plain click selects just that item and anchors there", () => {
    const s = click(selectAll(ORDER), "c");
    expect(ids(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  it("Ctrl/⌘-click toggles one item and leaves the rest alone", () => {
    let s = click(EMPTY_SELECTION, "b");
    s = click(s, "d", { toggle: true });
    expect(ids(s)).toEqual(["b", "d"]);
    s = click(s, "b", { toggle: true });
    expect(ids(s)).toEqual(["d"]);
    expect(s.anchor).toBe("b");
  });

  it("Shift-click selects the range from the anchor, in either direction, replacing the rest", () => {
    let s = click(EMPTY_SELECTION, "b");
    s = click(s, "d", { range: true });
    expect(ids(s)).toEqual(["b", "c", "d"]);
    // The anchor stays put, so a second Shift-click re-draws from it.
    s = click(s, "a", { range: true });
    expect(ids(s)).toEqual(["a", "b"]);
    expect(s.anchor).toBe("b");
  });

  it("Ctrl/⌘-Shift-click adds the range to what was selected", () => {
    let s = click(EMPTY_SELECTION, "a");
    s = click(s, "d", { toggle: true });
    s = click(s, "e", { range: true, toggle: true });
    expect(ids(s)).toEqual(["a", "d", "e"]);
  });

  it("Shift-click with no anchor (or one that left the list) is a plain click", () => {
    expect(ids(click(EMPTY_SELECTION, "c", { range: true }))).toEqual(["c"]);
    const stale: FilesSelection = { ids: new Set(["gone"]), anchor: "gone" };
    expect(ids(click(stale, "c", { range: true }))).toEqual(["c"]);
  });

  it("selectAll takes everything shown", () => {
    expect(ids(selectAll(ORDER))).toEqual(ORDER);
    expect(selectAll([]).ids.size).toBe(0);
  });
});

describe("move guards", () => {
  it("parentOf", () => {
    expect(parentOf("a/b/c.txt")).toBe("a/b");
    expect(parentOf("c.txt")).toBe("");
  });

  it("isInsideOrSame is by whole segments", () => {
    expect(isInsideOrSame("a/b", "a/b")).toBe(true);
    expect(isInsideOrSame("a/b/c", "a/b")).toBe(true);
    expect(isInsideOrSame("a/bc", "a/b")).toBe(false);
    expect(isInsideOrSame("a", "a/b")).toBe(false);
  });

  it("canMoveInto: never into itself or below itself, and not a no-op", () => {
    expect(canMoveInto(["a/b"], "c")).toBe(true);
    expect(canMoveInto(["a/b"], "a/b")).toBe(false);
    expect(canMoveInto(["a/b"], "a/b/x")).toBe(false);
    // Already there: dropping on its own folder moves nothing.
    expect(canMoveInto(["a/b.txt"], "a")).toBe(false);
    // Part of the selection is elsewhere: that part can go.
    expect(canMoveInto(["a/b.txt", "c/d.txt"], "a")).toBe(true);
    expect(canMoveInto([], "a")).toBe(false);
  });
});
