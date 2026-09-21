// ── OpenClaw's internal routing envelopes ───────────────────────────────────
//
// When a background job finishes (image generation, a subagent task), OpenClaw
// feeds the result back into the conversation as a message with `role: "user"`
// and `provenance.kind: "inter_session"`. It is an instruction TO the agent, not
// something the person typed — it carries the raw task text, the session ids and
// a block explaining how the agent should treat the data.
//
// The gateway's own projection strips only the `[Inter-session message]` header
// for display and keeps the body, so OpenClaw's Control UI shows the whole thing.
// In the mascot chat it renders as a wall of orange text attributed to the user,
// directly above the picture it produced. Nobody needs to read it.
//
// Matched on the gateway's own vocabulary (see `input-provenance` in the
// installed openclaw dist) rather than invented markers.

/** The header OpenClaw prefixes onto a routed message. */
const INTER_SESSION_HEADER = "[Inter-session message]";

/** The fixed sentence OpenClaw appends explaining the routing. */
const INTER_SESSION_EXPLANATION =
  "This content was routed by OpenClaw from another session or internal tool.";

/** How a completion envelope opens, whether the job succeeded or failed. */
const BACKGROUND_TASK_OPENING = /^\s*A background task (?:completed|failed)\b/i;

/**
 * True if this message is OpenClaw talking to itself rather than a person
 * talking to the agent.
 *
 * `provenance` is the authoritative signal and is checked first; the text
 * markers are the fallback for a projection that has already dropped it (the
 * gateway strips the header on some display paths). Both are required to be
 * distinctive enough that a person quoting one cannot trip it by accident —
 * hence matching the full explanation sentence, not the word "routed".
 */
export function isInternalRoutingMessage(raw: unknown, text: string): boolean {
  if (raw && typeof raw === "object") {
    const provenance = (raw as { provenance?: unknown }).provenance;
    if (provenance && typeof provenance === "object") {
      const kind = (provenance as { kind?: unknown }).kind;
      if (kind === "inter_session") return true;
    }
  }
  if (!text) return false;
  if (text.includes(INTER_SESSION_HEADER)) return true;
  if (text.includes(INTER_SESSION_EXPLANATION)) return true;
  // A completion envelope that reached us with both markers already stripped is
  // still recognisable by its opening plus the machine fields it always names.
  return BACKGROUND_TASK_OPENING.test(text) && /\bsession_key:/.test(text);
}

/**
 * True if `text` is an envelope reporting that image generation FAILED.
 *
 * Worth singling out because a failed job produces no picture: without this the
 * "Generating image…" banner would sit there until its timeout, long after the
 * agent had already explained the failure.
 */
export function isFailedImageGenerationNotice(text: string): boolean {
  if (!text) return false;
  if (!/image[_\s-]?gener/i.test(text)) return false;
  return /\bstatus:\s*failed\b/i.test(text) || /\bimage generation task failed\b/i.test(text);
}
