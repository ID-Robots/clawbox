import { describe, expect, it } from "vitest";
import { extractReasoningPanels, stripReasoningPanels } from "@/lib/hermes-reasoning-panel";

/**
 * The CLI's reasoning recap box, out of the chat bubble and out of the record.
 *
 * The fixtures are built from the REAL shape, not from a screenshot. In the
 * agent checkout on the bench box (`~/.hermes/hermes-agent/cli.py`, 2026-08-22)
 * the panel is printed from inside `HermesCLI.chat()` as
 *
 *   r_top = f"{_DIM}┌─{' Reasoning '}{'─' * max(r_fill - 1, 0)}┐{_RST}"
 *   r_bot = f"{_DIM}└{'─' * (w - 2)}┘{_RST}"
 *
 * and driven through prompt_toolkit's `print_formatted_text(ANSI(...))`. Piped
 * (which is how the route captures it) that printer was observed with `od -c`
 * to DROP the ANSI and to end every line with CRLF, so that is what `panel()`
 * below produces.
 *
 * The bar this has to clear is not "removes the box" — a regex can do that and
 * eat an answer on the way. It is "removes the box and can be shown never to
 * take an answer with it", which is what most of these are about.
 */

const CRLF = "\r\n";

/** The top frame at a plausible scrollback width. */
const TOP = `┌─ Reasoning ${"─".repeat(45)}┐`;
/** The bottom frame at the same width. */
const BOTTOM = `└${"─".repeat(58)}┘`;

/** One panel, exactly as the CLI prints it, CRLF included. */
function panel(...inner: string[]): string {
  return [TOP, ...inner, BOTTOM].join(CRLF);
}

/** The clamp line the CLI appends when thinking runs past ten lines. */
const CLAMPED = "  ... (12 more lines — /reasoning full to show)";

describe("stripReasoningPanels", () => {
  it("removes the panel the CLI prints above the answer", () => {
    const captured = [
      panel(
        "The user is asking what is in the picture. I should look at the",
        "attachment first and describe what I actually see, not guess.",
      ),
      "The picture shows a black cat asleep on a keyboard.",
    ].join(CRLF);

    expect(stripReasoningPanels(captured)).toBe(
      "The picture shows a black cat asleep on a keyboard.",
    );
  });

  it("removes a clamped panel, footer line and all", () => {
    const captured = [panel("First thought.", "Second thought.", CLAMPED), "42."].join(CRLF);
    const cleaned = stripReasoningPanels(captured);
    expect(cleaned).toBe("42.");
    expect(cleaned).not.toContain("/reasoning full");
  });

  it("removes every panel in a turn, not just the first", () => {
    // One turn can print both: the live-streamed box opened by
    // `_stream_reasoning_delta` and the post-response recap.
    const captured = [
      panel("Streamed thinking."),
      "Working on it.",
      panel("Recap thinking."),
      "Done — the file is removed.",
    ].join(CRLF);

    expect(stripReasoningPanels(captured)).toBe("Working on it.\nDone — the file is removed.");
  });

  it("still strips when the frame arrives wrapped in ANSI", () => {
    // Piped, prompt_toolkit drops the escapes — but `_DIM`/`_RST` are in the
    // producer, so a change at either end could put them back on the wire.
    const DIM = "\x1b[2;3m";
    const RST = "\x1b[0m";
    const captured = [
      `${DIM}${TOP}${RST}`,
      `${DIM}Thinking about it.${RST}`,
      `${DIM}${BOTTOM}${RST}`,
      "The answer.",
    ].join(CRLF);

    expect(stripReasoningPanels(captured)).toBe("The answer.");
  });

  it("falls back to the raw text when the reply is ONLY a panel", () => {
    // The turn's answer is not in the capture. Showing the monologue is poor;
    // showing an empty bubble is worse — it reads as the box saying nothing.
    const captured = panel("I should answer the question.", "Let me think.");
    const cleaned = stripReasoningPanels(captured);
    expect(cleaned).not.toBe("");
    expect(cleaned).toContain("I should answer the question.");
  });

  it("drops the rest of a panel that was never closed, and still answers something", () => {
    // The closer is printed before any answer text can be, so an open frame at
    // the end of a capture is a stream cut short mid-monologue.
    const captured = [TOP, "Thinking, and then the process died"].join(CRLF);
    const cleaned = stripReasoningPanels(captured);
    expect(cleaned).not.toBe("");
    expect(cleaned).toContain("Thinking, and then the process died");
  });

  it("leaves a reply with no panel exactly as it arrived", () => {
    const plain = `Sure — here is the list:${CRLF}${CRLF}1. one${CRLF}2. two`;
    expect(stripReasoningPanels(plain)).toBe(plain);
  });

  it("keeps a frame that is part of the answer, inside a fence", () => {
    // A reply that EXPLAINS the format, or pastes a session log, is an answer.
    const captured = ["Here is what that box looks like:", "```", TOP, "thinking", BOTTOM, "```"]
      .join(CRLF);
    const cleaned = stripReasoningPanels(captured);
    expect(cleaned).toContain(TOP);
    expect(cleaned).toContain(BOTTOM);
  });

  it("leaves the response box alone — it is drawn with different corners", () => {
    // The assistant's own panel is rounded (`╭ ╮ ╰ ╯`); only the square-cornered
    // reasoning frame is ours to remove.
    // Worded so the cheap bail-out cannot be what saves it: the frame
    // character and the label are both present, so this really is scanned.
    const captured = [
      `┌${"─".repeat(58)}┐`,
      `╭─ ⚕ Hermes ${"─".repeat(40)}╮`,
      "Reasoning about that took a while, but here is the answer.",
      `╰${"─".repeat(52)}╯`,
    ].join(CRLF);
    expect(stripReasoningPanels(captured)).toBe(captured.replace(/\r\n/g, "\n"));
  });

  it("does not strip on the word alone, or on a lone corner", () => {
    // Both halves of the cheap bail-out are present here, so the text is
    // scanned line by line — and nothing matches the frame, so every line
    // survives. The line endings do not: a scanned reply comes back with LF,
    // which is why the bail-out exists for the replies that skip the scan.
    const captured = `Reasoning about this is hard.${CRLF}┌ not a frame`;
    expect(stripReasoningPanels(captured)).toBe("Reasoning about this is hard.\n┌ not a frame");
  });

  it("answers an empty capture with an empty string rather than throwing", () => {
    expect(stripReasoningPanels("")).toBe("");
  });
});

/**
 * The same parser, asked for what it removed instead of only what it kept.
 *
 * This is the half that turns a strip into a feature: the monologue is handed
 * back so the bubble can offer it as a collapsed disclosure. The rules that
 * matter here are the ones that stop it being shown TWICE — once deduped out of
 * two emitters, and once by refusing to claim reasoning it has already returned
 * as the answer.
 */
describe("extractReasoningPanels", () => {
  it("hands back the answer and the thinking as separate values", () => {
    const captured = [panel("I should look at the attachment first."), "A black cat."].join(CRLF);
    expect(extractReasoningPanels(captured)).toEqual({
      text: "A black cat.",
      reasoning: "I should look at the attachment first.",
    });
  });

  it("returns ONE copy when both of the CLI's emitters printed the same thought", () => {
    // The streamed box and the post-response recap in one capture. Faithful to
    // the console, unreadable in a disclosure — so it is deduped.
    const thought = "The user said hey. Keep it short.";
    const captured = [panel(thought), panel(thought), "Hey!"].join(CRLF);
    const out = extractReasoningPanels(captured);
    expect(out.text).toBe("Hey!");
    expect(out.reasoning).toBe(thought);
  });

  it("keeps two DIFFERENT thoughts, in the order they were printed", () => {
    const captured = [panel("First I check."), panel("Now I answer."), "42."].join(CRLF);
    expect(extractReasoningPanels(captured).reasoning).toBe("First I check.\n\nNow I answer.");
  });

  it("claims no reasoning when there is no panel at all", () => {
    expect(extractReasoningPanels("Just an answer.")).toEqual({ text: "Just an answer." });
  });

  it("claims no reasoning when the panel WAS the whole reply", () => {
    // Rule 4. The capture is handed back as the answer because there is nothing
    // else to show — and reporting the same words as reasoning as well would
    // print them twice, which is the bug this change exists to end.
    const captured = panel("Only thinking, no answer.");
    const out = extractReasoningPanels(captured);
    expect(out.text).toBe(captured.replace(/\r\n/g, "\n"));
    expect(out).not.toHaveProperty("reasoning");
  });

  it("leaves the reply untouched when the frame was never closed", () => {
    // THE LIVE SHAPE on this hardware: the CLI opens the box and quiet mode
    // never closes it, so the answer sits under an open frame with no marker
    // separating the two. Nothing here can tell them apart, so nothing is
    // taken — the reply survives whole, and the panel is simply not offered.
    // (The agent's own record is what separates this turn; see
    // hermes-turn-record.test.ts.)
    const captured = [TOP, "Thinking out loud.", "The actual answer."].join(CRLF);
    const out = extractReasoningPanels(captured);
    expect(out.text).toContain("The actual answer.");
    expect(out).not.toHaveProperty("reasoning");
  });

  it("still refuses to read a panel inside a code fence", () => {
    // Fence safety is unchanged by the refactor: a reply that DOCUMENTS this
    // format keeps every line of it, and none of it is reported as thinking.
    const captured = ["Here is what it prints:", "```", TOP, "some thinking", BOTTOM, "```"].join(CRLF);
    const out = extractReasoningPanels(captured);
    expect(out.text).toBe(captured.replace(/\r\n/g, "\n"));
    expect(out).not.toHaveProperty("reasoning");
  });

  it("agrees with stripReasoningPanels on the answer, always", () => {
    const captures = [
      [panel("thinking"), "answer"].join(CRLF),
      "no panel here",
      panel("only thinking"),
      [TOP, "unclosed", "answer"].join(CRLF),
      "",
    ];
    for (const captured of captures) {
      expect(extractReasoningPanels(captured).text).toBe(stripReasoningPanels(captured));
    }
  });
});
