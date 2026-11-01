/**
 * The Create planner's text editing, kept PURE so it is testable without a
 * browser (src/components/NewAppWizardCard.tsx draws it).
 *
 * The planner edits Markdown in a plain textarea — what the assistant reads,
 * what the run's whole-goal window renders back, and what a paste from
 * anywhere already is — and these helpers give it the keys of a text editor:
 * a list that continues itself on Enter and ends on an empty item, Tab and
 * Shift+Tab to indent a list, a toolbar that wraps a selection or turns the
 * selected lines into a list, a checklist, a heading or a quote.
 *
 * Every helper takes the text and the selection and returns the new text and
 * the new selection; the component applies both. Nothing here touches the
 * DOM.
 */

export interface EditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** A list item's leading part: indent, marker (`-`, `*`, `+`, `1.`, `1)`), an optional checkbox. */
const LIST_LINE = /^(\s*)([-*+]|\d{1,4}[.)])(\s+)(\[[ xX]\]\s+)?/;

const INDENT = "  ";

function lineStartOf(value: string, pos: number): number {
  return value.lastIndexOf("\n", pos - 1) + 1;
}

function lineEndOf(value: string, pos: number): number {
  const end = value.indexOf("\n", pos);
  return end === -1 ? value.length : end;
}

/**
 * Enter inside a list item: continue the list on the next line (the next
 * number, an unchecked box for a checklist), or — on an item with nothing
 * after its marker — end the list by clearing that marker. Null when the
 * caret is not on a list line, or a selection spans text: a plain new line.
 */
export function continueList(value: string, selectionStart: number, selectionEnd: number): EditResult | null {
  if (selectionStart !== selectionEnd) return null;
  const start = lineStartOf(value, selectionStart);
  const line = value.slice(start, lineEndOf(value, selectionStart));
  const m = LIST_LINE.exec(line);
  if (!m) return null;
  // The caret must be past the marker: Enter in front of it is a plain line.
  if (selectionStart - start < m[0].length) return null;
  const [whole, indent, marker, gap, box] = m;
  if (line.slice(whole.length).trim() === "") {
    // An empty item ends the list: the marker goes, the line stays.
    const next = value.slice(0, start) + value.slice(start + whole.length);
    return { value: next, selectionStart: start, selectionEnd: start };
  }
  const num = /^(\d+)([.)])$/.exec(marker);
  const nextMarker = num ? `${Number(num[1]) + 1}${num[2]}` : marker;
  const insert = `\n${indent}${nextMarker}${gap}${box ? "[ ] " : ""}`;
  const next = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
  const caret = selectionStart + insert.length;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}

/**
 * Tab / Shift+Tab: indent or outdent every line the selection touches by two
 * spaces. Null when the caret sits on a line that is not a list item and
 * nothing is selected — Tab then leaves the editor, as it should.
 */
export function indentLines(value: string, selectionStart: number, selectionEnd: number, outdent: boolean): EditResult | null {
  const start = lineStartOf(value, selectionStart);
  const end = lineEndOf(value, selectionEnd);
  const block = value.slice(start, end);
  if (selectionStart === selectionEnd && !LIST_LINE.test(block)) return null;
  const lines = block.split("\n");
  let firstDelta = 0;
  let total = 0;
  const changed = lines.map((l, i) => {
    let out: string;
    if (outdent) {
      const cut = l.startsWith(INDENT) ? INDENT.length : l.startsWith(" ") || l.startsWith("\t") ? 1 : 0;
      out = l.slice(cut);
      if (i === 0) firstDelta = -cut;
      total -= cut;
    } else {
      out = INDENT + l;
      if (i === 0) firstDelta = INDENT.length;
      total += INDENT.length;
    }
    return out;
  });
  const next = value.slice(0, start) + changed.join("\n") + value.slice(end);
  return {
    value: next,
    selectionStart: Math.max(start, selectionStart + firstDelta),
    selectionEnd: Math.max(start, selectionEnd + total),
  };
}

/**
 * Wrap the selection in `before`/`after` (bold, italic, inline code). With
 * nothing selected the placeholder is inserted and selected, so typing
 * replaces it.
 */
export function wrapSelection(value: string, selectionStart: number, selectionEnd: number, before: string, after: string, placeholder: string): EditResult {
  const selected = value.slice(selectionStart, selectionEnd) || placeholder;
  const next = value.slice(0, selectionStart) + before + selected + after + value.slice(selectionEnd);
  const s = selectionStart + before.length;
  return { value: next, selectionStart: s, selectionEnd: s + selected.length };
}

export type LineStyle = "bullet" | "number" | "check" | "heading" | "quote";

const STYLE_PREFIX: Record<Exclude<LineStyle, "number">, string> = {
  bullet: "- ",
  check: "- [ ] ",
  heading: "## ",
  quote: "> ",
};

/** What a line already starts with, in any of the line styles. */
const ANY_PREFIX = /^(\s*)(?:#{1,6}\s+|>\s?|(?:[-*+]|\d{1,4}[.)])\s+(?:\[[ xX]\]\s+)?)/;

/**
 * Turn every line the selection touches into one line style — or, when every
 * one of them already has it, take it off again (a toolbar button toggles).
 * A line in another style is converted rather than given a second marker.
 */
export function toggleLineStyle(value: string, selectionStart: number, selectionEnd: number, style: LineStyle): EditResult {
  const start = lineStartOf(value, selectionStart);
  const end = lineEndOf(value, selectionEnd);
  const lines = value.slice(start, end).split("\n");
  const has = (l: string) => {
    switch (style) {
      case "bullet": return /^\s*[-*+]\s+(?!\[[ xX]\])/.test(l);
      case "check": return /^\s*[-*+]\s+\[[ xX]\]\s+/.test(l);
      case "number": return /^\s*\d{1,4}[.)]\s+/.test(l);
      case "heading": return /^\s*#{1,6}\s+/.test(l);
      case "quote": return /^\s*>\s?/.test(l);
    }
  };
  const content = lines.filter((l) => l.trim() !== "");
  const remove = content.length > 0 && content.every(has);
  let n = 0;
  const changed = lines.map((l) => {
    if (l.trim() === "" && lines.length > 1) return l;
    const m = ANY_PREFIX.exec(l);
    const indent = m ? m[1] : (/^\s*/.exec(l)?.[0] ?? "");
    const body = m ? l.slice(m[0].length) : l.slice(indent.length);
    if (remove) return indent + body;
    n += 1;
    const prefix = style === "number" ? `${n}. ` : STYLE_PREFIX[style];
    // Headings and quotes are not nested: they start at the margin.
    return (style === "heading" || style === "quote" ? "" : indent) + prefix + body;
  });
  const joined = changed.join("\n");
  const next = value.slice(0, start) + joined + value.slice(end);
  // A single empty line just turned into a marker: the caret goes after it.
  if (selectionStart === selectionEnd && lines.length === 1) {
    const caret = start + joined.length;
    return { value: next, selectionStart: caret, selectionEnd: caret };
  }
  return { value: next, selectionStart: start, selectionEnd: start + joined.length };
}

/**
 * Insert a block (a section heading and its first item) at the caret, on
 * lines of its own: a blank line before it unless the text before already
 * ends in one, and the caret at the end of the block.
 */
export function insertBlock(value: string, selectionStart: number, selectionEnd: number, block: string): EditResult {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const lead = before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after === "" || after.startsWith("\n") ? "" : "\n";
  const next = before + lead + block + trail + after;
  const caret = before.length + lead.length + block.length;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}

/** Insert inline text at the caret, replacing any selection. */
export function insertText(value: string, selectionStart: number, selectionEnd: number, text: string): EditResult {
  const next = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
  const caret = selectionStart + text.length;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}

// ── The plan's health ────────────────────────────────────────────────────────

/** The planning sections the toolbar inserts, by id. */
export type PlanSection = "goal" | "features" | "screens" | "data" | "done" | "constraints";
export const PLAN_SECTIONS: readonly PlanSection[] = ["goal", "features", "screens", "data", "done", "constraints"];

/** The section a check stands for — what clicking an unmet check inserts. */
export interface PlanChecks {
  /** Enough words to say what the app is for. */
  goal: boolean;
  /** At least two list items: features, steps, requirements. */
  features: boolean;
  /** Says when it is done: a "done when"/acceptance section, or a checklist. */
  done: boolean;
  /** Pictures to build from — optional, never required. */
  references: boolean;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,4}[.)])\s+\S/;
const CHECK_ITEM = /^\s*[-*+]\s+\[[ xX]\]\s+\S/;

/**
 * How complete a brief is, as four checks the planner shows beside it. A
 * nudge, never a gate: Create works with all four unmet. `doneHeadings` are
 * the localized words a "Done when" heading may start with (the section the
 * toolbar inserts, in the owner's language, plus the English ones).
 */
export function planChecks(brief: string, imageCount: number, doneHeadings: readonly string[]): PlanChecks {
  const lines = brief.split("\n");
  const prose = lines.filter((l) => !/^\s*#/.test(l)).join(" ").replace(/\s+/g, " ").trim();
  const items = lines.filter((l) => LIST_ITEM.test(l)).length;
  const words = doneHeadings.map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hasDoneHeading = lines.some((l) => {
    const m = /^\s*#{1,6}\s+(.*)$/.exec(l);
    if (!m) return false;
    const h = m[1].trim().toLowerCase();
    return words.some((w) => h.startsWith(w));
  });
  return {
    goal: prose.length >= 40,
    features: items >= 2,
    done: hasDoneHeading || lines.some((l) => CHECK_ITEM.test(l)),
    references: imageCount > 0,
  };
}

/** How many of the three that matter are met (references are optional). */
export function planScore(checks: PlanChecks): number {
  return (checks.goal ? 1 : 0) + (checks.features ? 1 : 0) + (checks.done ? 1 : 0);
}

// ── Reference pictures ───────────────────────────────────────────────────────

/** The token a picture is referred to by in the brief: `[image 2]`. */
export function imageToken(n: number): string {
  return `[image ${n}]`;
}

/**
 * Renumber `[image N]` tokens after picture `removed` (1-based) is taken out:
 * the removed one's tokens go, every later one moves down by one, so the brief
 * and the strip keep naming the same pictures.
 */
export function renumberImageTokens(brief: string, removed: number): string {
  // A removed token takes ONE space with it — the one before it, or, at the
  // start of a line, the one after — so no double or leading space is left;
  // indentation and every other space stay exactly as typed.
  return brief.replace(/( ?)\[image (\d+)\]( ?)/g, (whole, before: string, d: string, after: string) => {
    const n = Number(d);
    if (n === removed) return before ? after : "";
    return n > removed ? before + imageToken(n - 1) + after : whole;
  });
}
