// `EMAIL_DRAFT:<id>` — "there is a draft waiting for your approval", as a line
// in the assistant's reply.
//
// HOW A DRAFT REACHES A CARD. The assistant creates the draft with whatever
// mail tool the owner granted it; that tool's result goes to the model and
// never to the chat (the same fact `chat-email-refs.ts` is built on). So the
// assistant calls ClawBox's `email_draft_card` tool, which answers with the
// exact line to end its reply with, and the chat lifts the line out and shows
// the send-approval card in its place (`chat-email-draft.tsx`).
//
// THE LINE CARRIES AN ID AND NOTHING ELSE. Recipients, subject and body are
// read by the server from the mail send backend when the card asks — never
// from the reply, so what the card shows is what the mailbox holds, whatever
// the assistant wrote around it.
//
// Same rules as `EMAIL:`: only at the start of a line, never inside a fenced
// code block, one layer of quotes forgiven, a payload that is not an id kept as
// text, repeats dropped. Deriving it at render time means a replayed turn draws
// the same card a live one did.

/** A directive line, case-insensitive, on the trimmed line. Linear: one class, no overlap. */
const DRAFT_LINE_RE = /^email_draft:([\s\S]*)$/i;

/** Opening or closing marker of a fenced code block. */
const FENCE_RE = /^(?:```|~~~)/;

/**
 * A draft id: what Microsoft Graph, Gmail and IMAP ids (and a Message-ID's
 * `local@host`) are made of, and nothing that could change a URL once encoded. The server checks the same
 * pattern (src/lib/mail-draft-backend.ts imports it from here).
 */
export const DRAFT_ID_RE = /^[A-Za-z0-9._~+/=:@-]{1,512}$/;

/** Most draft cards under one reply. */
export const MAX_DRAFT_REFS = 5;

export interface SplitDraftRefs {
  /** The reply with every directive line that became a card removed. */
  text: string;
  /** Draft ids, in the order the reply named them, without repeats. */
  draftIds: string[];
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

/** The draft id in a directive's payload, or null when it is not one. */
export function parseDraftId(payload: string): string | null {
  const value = unwrapQuoted(payload.trim());
  return DRAFT_ID_RE.test(value) ? value : null;
}

/** Splits `EMAIL_DRAFT:` directives out of assistant text. */
export function splitDraftRefs(raw: string): SplitDraftRefs {
  if (typeof raw !== "string") return { text: "", draftIds: [] };
  if (!/email_draft:/i.test(raw)) return { text: raw, draftIds: [] };

  const draftIds: string[] = [];
  const kept: string[] = [];
  let inFence = false;
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    // The whole line in quotes is forgiven too: the tool's own instruction
    // shows the line in backticks, and a model copies what it is shown.
    const match = inFence ? null : DRAFT_LINE_RE.exec(unwrapQuoted(trimmed));
    const id = match ? parseDraftId(match[1]) : null;
    // Not a directive, or one that names nothing usable: kept as text, so the
    // fact that the assistant meant to point at something is not hidden.
    if (id === null) {
      kept.push(line);
      continue;
    }
    if (draftIds.includes(id)) continue;
    if (draftIds.length >= MAX_DRAFT_REFS) {
      kept.push(line);
      continue;
    }
    draftIds.push(id);
  }
  if (kept.length === lines.length) return { text: raw, draftIds };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), draftIds };
}

/**
 * A last line still being typed that could become a draft directive: from
 * `EMAIL_` on (the letters before it are already held back by
 * `streamingEmailRefsText`). `[^\n]*$` and no trailing `[ \t]*`, so the
 * pattern stays linear in the length of the line.
 */
const PARTIAL_DRAFT_TAIL_RE = /(^|\n)[ \t]*(?:email_draft:[^\n]*|email_draf|email_dra|email_dr|email_d|email_)$/i;

/**
 * The reply as a STREAMING bubble should show it: without a draft directive,
 * finished or still arriving. The card appears when the turn ends and the
 * stored message is drawn; until then the id never flashes on screen.
 */
export function streamingDraftRefsText(raw: string): string {
  return splitDraftRefs(raw.replace(PARTIAL_DRAFT_TAIL_RE, "")).text;
}
