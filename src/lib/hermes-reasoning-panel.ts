// ── The CLI's reasoning recap box, out of the customer's chat bubble ────────
//
// `hermes chat -q … -Q` prints the model's internal monologue to STDOUT, above
// the answer, framed in a box-drawing panel:
//
//   ┌─ Reasoning ──────────────────────────────────┐
//   The user is asking about the picture. I should
//   ... (12 more lines — /reasoning full to show)
//   └──────────────────────────────────────────────┘
//   Here is what the picture shows: …
//
// The chat route reads that whole stream as "the reply", so every assistant
// bubble on a Hermes box opened with the monologue and — since the transcript
// landed — every stored exchange did too. A pre-existing stdout-handling gap
// that persistence made permanent.
//
// WHERE THE SHAPE COMES FROM, so the parser is matched to the producer rather
// than to one screenshot. In the agent checkout on the bench box
// (`~/.hermes/hermes-agent/cli.py`, 2026-08-22) the panel is emitted from two
// places, both inside `HermesCLI.chat()` — the very method a `-q` query runs:
//
//   r_label = " Reasoning "
//   r_top = f"{_DIM}┌─{r_label}{'─' * max(r_fill - 1, 0)}┐{_RST}"
//   r_bot = f"{_DIM}└{'─' * (w - 2)}┘{_RST}"
//
// one for the live-streamed box and one for the post-response recap, and
// `display.show_reasoning` defaults to TRUE. `_DIM`/`_RST` are ANSI, and the
// whole line goes through prompt_toolkit's `print_formatted_text(ANSI(...))`.
//
// Reproduced through that exact printer with stdout piped (the shape the route
// captures), `od -c`:
//
//   \r \n ┌ ─ ' ' R e a s o n i n g ' ' ─ ─ ─ ┐ \r \n l i n e … \r \n └ ─ … ┘ \r \n
//
// So two things are true of the real capture and both are in the parser below:
// the ANSI is GONE (prompt_toolkit drops it when the output is not a terminal)
// but may return if that ever changes, and every newline is a CRLF.
//
// NOT RENDERED ANYWHERE YET. Surfacing the monologue as a collapsible section
// under the reply is a real feature and a good one; this change only stops it
// being pasted into the answer. Reasoning is dropped here, not stashed.

/** ANSI SGR sequences, stripped before a line is MATCHED (never from output). */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * The opening frame: `┌─` + ` Reasoning ` + filler + `┐`.
 *
 * Anchored whole-line and required to close with `┐` on the same line, because
 * the one thing this must never do is eat an answer. A model that draws a box
 * in its reply has to reproduce the frame exactly, on a line of its own and
 * outside a code fence, before a single character of its text is dropped.
 */
const PANEL_TOP_RE = /^┌─+\s*Reasoning\s*─*┐$/;

/** The closing frame: `└` + filler + `┘`. */
const PANEL_BOTTOM_RE = /^└─+┘$/;

/** Opening or closing marker of a fenced code block (same rule as chat-media). */
const FENCE_RE = /^(?:```|~~~)/;

function bare(line: string): string {
  return line.replace(ANSI_RE, "").trim();
}

/**
 * The reply with every reasoning panel removed.
 *
 * Rules, in the order they matter:
 *
 *  1. A panel is only recognised OUTSIDE a fenced code block. A reply that
 *     explains this format — or pastes a session log into a fence — keeps it.
 *  2. Any number of panels, anywhere in the reply. The streamed box and the
 *     post-response recap can both appear in one turn.
 *  3. An UNCLOSED panel takes the rest of the text with it. The closing frame
 *     is printed before any answer text can be (`_close_reasoning_box` runs
 *     when content tokens start arriving), so an open frame with no closer
 *     means the capture was cut short mid-monologue — there is no answer under
 *     it to lose. Fence state is deliberately not tracked INSIDE a panel:
 *     reasoning text can contain a stray fence, and letting it toggle would
 *     make the panel's own end invisible.
 *  4. If all of that leaves nothing, the ORIGINAL text is returned. A reply
 *     that is only a panel is a turn whose answer we cannot see; showing the
 *     monologue is poor, and showing an empty bubble is worse — it reads as the
 *     box having said nothing at all.
 *
 * CRLF in, LF out — but only for a reply that actually carried a frame; the
 * bail-out below keeps every other reply byte-identical.
 */
export function stripReasoningPanels(raw: string): string {
  if (typeof raw !== "string" || !raw) return "";
  // Cheap and precise: no frame character and no label means nothing here can
  // match, and the reply is returned exactly as it arrived.
  if (!raw.includes("┌") || !raw.includes("Reasoning")) return raw;

  const kept: string[] = [];
  const lines = raw.split(/\r?\n/);
  let inFence = false;
  let inPanel = false;

  for (const line of lines) {
    const trimmed = bare(line);
    if (inPanel) {
      if (PANEL_BOTTOM_RE.test(trimmed)) inPanel = false;
      continue;
    }
    if (inFence) {
      if (FENCE_RE.test(trimmed)) inFence = false;
      kept.push(line);
      continue;
    }
    if (FENCE_RE.test(trimmed)) {
      inFence = true;
      kept.push(line);
      continue;
    }
    if (PANEL_TOP_RE.test(trimmed)) {
      inPanel = true;
      continue;
    }
    kept.push(line);
  }

  // Removing a block from the middle leaves a hole; collapse the run of blank
  // lines it left behind so the answer keeps its shape.
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || raw.trim();
}
