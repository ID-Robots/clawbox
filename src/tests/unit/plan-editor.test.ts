/**
 * The Create planner's pure editing (src/lib/plan-editor.ts): lists that
 * continue and end, indenting, the toolbar's wraps and line styles, sections,
 * the plan check, and the `[image N]` tokens that follow the picture strip.
 */
import { describe, expect, it } from "vitest";
import {
  continueList,
  imageToken,
  indentLines,
  insertBlock,
  insertText,
  planChecks,
  planScore,
  renumberImageTokens,
  toggleLineStyle,
  wrapSelection,
} from "@/lib/plan-editor";

const at = (v: string) => [v, v.length, v.length] as const;

describe("continueList", () => {
  it("continues bullets, numbers and checkboxes, keeping the indent", () => {
    expect(continueList(...at("- a"))?.value).toBe("- a\n- ");
    expect(continueList(...at("  * a"))?.value).toBe("  * a\n  * ");
    expect(continueList(...at("9. a"))?.value).toBe("9. a\n10. ");
    expect(continueList(...at("3) a"))?.value).toBe("3) a\n4) ");
    expect(continueList(...at("- [x] done"))?.value).toBe("- [x] done\n- [ ] ");
  });

  it("ends the list on an empty item and leaves plain lines, selections and a caret before the marker alone", () => {
    expect(continueList(...at("- a\n- "))).toEqual({ value: "- a\n", selectionStart: 4, selectionEnd: 4 });
    expect(continueList(...at("plain"))).toBeNull();
    expect(continueList("- abc", 2, 4)).toBeNull();
    expect(continueList("- abc", 0, 0)).toBeNull();
  });

  it("puts the caret after the new marker", () => {
    const r = continueList(...at("- a"));
    expect(r?.selectionStart).toBe("- a\n- ".length);
  });
});

describe("indentLines", () => {
  it("indents and outdents every selected line, and lets Tab leave a plain line", () => {
    expect(indentLines("- a\n- b", 0, 7, false)?.value).toBe("  - a\n  - b");
    expect(indentLines("  - a\n  - b", 0, 11, true)?.value).toBe("- a\n- b");
    expect(indentLines("plain", 2, 2, false)).toBeNull();
  });
});

describe("toolbar", () => {
  it("wraps a selection, or inserts and selects a placeholder", () => {
    expect(wrapSelection("a b", 2, 3, "**", "**", "x")).toEqual({ value: "a **b**", selectionStart: 4, selectionEnd: 5 });
    expect(wrapSelection("", 0, 0, "`", "`", "code")).toEqual({ value: "`code`", selectionStart: 1, selectionEnd: 5 });
  });

  it("turns lines into a style, converts another style, and toggles it back off", () => {
    expect(toggleLineStyle("a\nb", 0, 3, "number").value).toBe("1. a\n2. b");
    expect(toggleLineStyle("- a\n- b", 0, 7, "check").value).toBe("- [ ] a\n- [ ] b");
    expect(toggleLineStyle("- a\n- b", 0, 7, "bullet").value).toBe("a\nb");
    expect(toggleLineStyle("Title", 0, 0, "heading").value).toBe("## Title");
    expect(toggleLineStyle("## Title", 0, 0, "heading").value).toBe("Title");
    expect(toggleLineStyle("", 0, 0, "bullet")).toEqual({ value: "- ", selectionStart: 2, selectionEnd: 2 });
  });

  it("inserts a section on lines of its own", () => {
    expect(insertBlock("Intro", 5, 5, "## Features\n- ").value).toBe("Intro\n\n## Features\n- ");
    expect(insertBlock("", 0, 0, "## Goal\n").value).toBe("## Goal\n");
    expect(insertText("ab", 1, 1, "X")).toEqual({ value: "aXb", selectionStart: 2, selectionEnd: 2 });
  });
});

describe("planChecks", () => {
  const DONE = ["Done when"];
  it("reads the goal, the features and when it is done; pictures are optional", () => {
    const empty = planChecks("", 0, DONE);
    expect(empty).toEqual({ goal: false, features: false, done: false, references: false });
    expect(planScore(empty)).toBe(0);
    const full = planChecks("An invoice generator for a small shop with customers.\n\n- Customers\n- Invoices\n\n## Done when\n- it prints", 1, DONE);
    expect(full).toEqual({ goal: true, features: true, done: true, references: true });
    expect(planScore(full)).toBe(3);
    // A checklist says when it is done, whatever the headings.
    expect(planChecks("- [ ] exports a PDF", 0, DONE).done).toBe(true);
  });
});

describe("image tokens", () => {
  it("removes a picture's tokens and renumbers the later ones, keeping indentation", () => {
    expect(imageToken(3)).toBe("[image 3]");
    expect(renumberImageTokens("See [image 1] and [image 2].\n  - [image 3] x", 2)).toBe("See [image 1] and.\n  - [image 2] x");
    expect(renumberImageTokens("[image 1] [image 2] ", 1)).toBe("[image 1] ");
    expect(renumberImageTokens("[image 1] ", 1)).toBe("");
  });
});
