// ── `EMAIL:` directives in assistant replies ─────────────────────────────────
//
// How a message the agent talked about becomes a message the owner can OPEN.
//
// The transcript carries the agent's prose, not the mailbox: a tool result goes
// to the model and never to this UI, so after "read my last five emails" the
// chat holds a summary and no way back to the mail it summarised. The agent
// names them instead, one directive line per message:
//
//   Here are your last two emails.
//   EMAIL:4471
//   EMAIL:4468
//
// This is the same mechanism `MEDIA:` already uses for generated pictures
// (chat-media.ts), deliberately: one convention for "the reply refers to
// something the chat should render", not two.
//
// THE DIRECTIVE CARRIES AN ID AND NOTHING ELSE. It is a number the client turns
// into a fetch against the owner's own mailbox, so the worst a wrong or
// mischievous id can do is open a different message the owner already has —
// and that fetch needs the owner's session, opens the mailbox read-only, and
// changes nothing. Nothing about the message's CONTENT travels in the reply
// text, which is what keeps a summary from quietly becoming a copy.
//
// The id is not trusted as a number, either: `email_list` returns UIDs, but a
// reply is model output, so anything that is not a plain positive integer in
// IMAP's UID range is left as text rather than turned into a card.

/** A directive line: `EMAIL:` at the very start of the (trimmed) line. */
const EMAIL_LINE_RE = /^email:\s*(.*)$/i;

/** Opening or closing marker of a fenced code block. */
const FENCE_RE = /^(?:```|~~~)/;

/** IMAP UIDs are 32-bit and start at 1. */
const MAX_UID = 4_294_967_295;

/** Most cards shown under one reply, however many the agent named. */
const MAX_REFS = 25;

export interface SplitEmailRefs {
  /** The reply with its directive lines removed — what the bubble shows. */
  text: string;
  /** The message ids the directives named, in order, without duplicates. */
  uids: number[];
}

/**
 * Splits `EMAIL:` directives out of assistant text.
 *
 * Recognised only at the start of a line and never inside a fenced code block,
 * so a reply that EXPLAINS the syntax still renders it as text — the same rule
 * `splitMediaDirectives` follows, and for the same reason.
 */
export function splitEmailRefs(raw: string): SplitEmailRefs {
  // Cheap bail-out: almost every reply carries no directive, and this also
  // covers the empty string, whose split is itself.
  if (!/email:/i.test(raw)) return { text: raw, uids: [] };

  const uids: number[] = [];
  const seen = new Set<number>();
  const kept: string[] = [];
  let inFence = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    const match = inFence ? null : EMAIL_LINE_RE.exec(trimmed);
    if (!match) {
      kept.push(line);
      continue;
    }
    const uid = parseUid(match[1]);
    // A directive that names nothing usable is kept as text rather than
    // silently swallowed: dropping the line would hide the fact that the agent
    // meant to point at something.
    if (uid === null) {
      kept.push(line);
      continue;
    }
    if (!seen.has(uid) && uids.length < MAX_REFS) {
      seen.add(uid);
      uids.push(uid);
    }
  }

  // Removing a line from the middle of a reply leaves a hole; collapse the run
  // of blank lines behind it so the prose keeps its shape.
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, uids };
}

/** A UID, or null when the payload is not one. */
function parseUid(payload: string): number | null {
  const value = unwrapQuoted(payload.trim());
  // Digits only: `+7`, `7.0`, `0x1f` and `7 or so` are all model output that
  // happens to start like a number, and `Number()` would take most of them.
  if (!/^\d{1,10}$/.test(value)) return null;
  const uid = Number(value);
  if (!Number.isInteger(uid) || uid < 1 || uid > MAX_UID) return null;
  return uid;
}

/** Strips one layer of the quoting a model tends to wrap a value in. */
function unwrapQuoted(value: string): string {
  for (const quote of ["`", '"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}
