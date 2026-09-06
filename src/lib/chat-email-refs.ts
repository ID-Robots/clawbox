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

/**
 * A directive line: `EMAIL:` at the very start of the (trimmed) line.
 *
 * `[\s\S]` AND NOT `\s*(.*)`: the two overlap on the space character and `$`
 * (no `m` flag) only matches at the end of the input, so `\s*(.*)$` was
 * quadratic on a line starting `email:` with a long run of spaces and a `\r`,
 * `\u2028` or `\u2029` held back from its end — `.` cannot cross those three,
 * so the engine tried every split of the spaces between the two quantifiers.
 * One character class cannot backtrack against itself. Dropping the `\s*`
 * changes nothing else: `parseEmailUid` trims the payload before reading it.
 *
 * This is the shared grammar — the same change is in the OpenClaw plugin's
 * `email-directives.mjs` and the Hermes plugin's `email_directives.py`, and
 * `src/tests/unit/email-directive-parity.test.ts` holds all three to it.
 */
const EMAIL_LINE_RE = /^email:([\s\S]*)$/i;

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

  const lines = raw.split("\n");
  for (const line of lines) {
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
    const uid = parseEmailUid(match[1]);
    // A directive that names nothing usable is kept as text rather than
    // silently swallowed: dropping the line would hide the fact that the agent
    // meant to point at something.
    if (uid === null) {
      kept.push(line);
      continue;
    }
    // A repeat is dropped: the card is already on screen, and a second one
    // would only duplicate it.
    if (seen.has(uid)) continue;
    // Past the cap the line goes back to being TEXT rather than disappearing.
    // Same rule as an unusable payload above — this function may remove a line
    // only when it has turned that line into a card.
    if (uids.length >= MAX_REFS) {
      kept.push(line);
      continue;
    }
    seen.add(uid);
    uids.push(uid);
  }

  // Removing a line from the middle of a reply leaves a hole; collapse the run
  // of blank lines behind it so the prose keeps its shape.
  //
  // ONLY WHEN A LINE ACTUALLY WENT. The bail-out above already returns `raw`
  // untouched for a reply with no `email:` in it; without this the SAME reply
  // with the word in it somewhere came back trimmed and re-spaced instead, so
  // two otherwise identical replies were delivered differently because one of
  // them mentioned an address. This function may change a reply only when it
  // removed something from it — the rule the rest of it already follows.
  if (kept.length === lines.length) return { text: raw, uids };
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, uids };
}

/**
 * A UID, or null when the payload is not one.
 *
 * Exported because a directive is no longer the only way one arrives: a card on
 * the gateway's own Control UI chat is a LINK back into this chat
 * (`control-ui-email-directives.ts`, TASK-700), and the id it carries has to be
 * read by the same rule the directive is read by rather than by a second one
 * written next to `useSearchParams`.
 */
export function parseEmailUid(payload: string): number | null {
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

/**
 * A last line that is still being typed and could still become a directive:
 * every prefix of `EMAIL:<digits>` from its first letter on, alone on its line.
 *
 * The letters matter as much as the digits. Deltas arrive token-sized, so
 * `EMAIL` lands a frame before its colon does, and matching only from the colon
 * left the word itself on screen for that frame — the likelier half of the very
 * flash this is here to stop. The opening quote is here for the same reason:
 * `unwrapQuoted` accepts three kinds and this module's own instruction writes
 * the id in backticks, so without it `EMAIL:`4471`` sat on screen as text until
 * its closing quote landed and then vanished.
 *
 * Nine digits UNQUOTED, ten inside a quote that has not closed. Unquoted, a
 * tenth digit settles the line either way: within `MAX_UID` the parser already
 * makes a card from it, and past `MAX_UID` it can never make one, so in neither
 * case is it still being typed. Quoted is different — the payload cannot be
 * read at all until the closing quote lands, so ``EMAIL:`1000000000`` is a
 * directive mid-arrival; at nine digits it sat on screen as text until its
 * quote closed, and an interrupt kept it. Eleven digits is nobody's id.
 *
 * A prefix rule cannot be exact, and this one errs towards HIDING: a last line
 * that is only `E`, or the word `Email:` before a prose address, is held back
 * for a frame and then appears. That way round is invisible. The other way
 * round is the id on screen, which is the whole complaint.
 */
const PARTIAL_DIRECTIVE_TAIL_RE =
  /(^|\n)[ \t]*(?:email:[ \t]*["'`][ \t]*\d{0,10}|email:[ \t]*\d{0,9}|email|emai|ema|em|e)[ \t]*$/i;

/**
 * The reply as a STREAMING bubble should show it.
 *
 * `splitEmailRefs` deliberately keeps a directive line whose payload is not a
 * usable id, so a finished message never silently loses the fact that the agent
 * meant to point at something. Half-arrived, that same rule puts the line on
 * screen for a frame — `EMAIL` before its colon, `EMAIL:` before its digits —
 * and then takes it away again: exactly the flash the strip exists to prevent.
 *
 * So a trailing line still being typed is asked about rather than matched:
 * complete it into a directive and put it back through the parser. Lifted out
 * when completed means a directive is arriving, and it is hidden; kept — a code
 * fence, or the cap — means it stays, which is where it will still be once it
 * has finished arriving, so the kept branch never flashes. The parser's own
 * fence, id and cap rules are what answer, so this holds no second copy of
 * them.
 *
 * The probe id has to be one the reply has NOT used. Completing with a fixed
 * `1` made the probe a duplicate whenever the agent had already named message
 * 1 — the parser drops a repeat, the count the probe is read by never moves,
 * and the half-typed line showed. That is the first mail a fresh box ever
 * received.
 *
 * Live bubbles only. A stored message keeps every unusable line it had, bar the
 * one `dropUnfinishedDirective` takes off the end of an interrupted turn.
 */
export function streamingEmailRefsText(raw: string): string {
  return splitEmailRefs(dropUnfinishedDirective(raw)).text;
}

/**
 * The buffer as an INTERRUPTED turn should be stored: without the directive it
 * was in the middle of writing, if it was in the middle of writing one.
 *
 * Stop appends whatever had streamed so far, and the render keeps a directive
 * whose payload is not a usable id as text — so a Stop landing between `EMAIL`
 * and its digits left a bare `EMAIL:` line in the transcript for good. That is
 * the same stray id this module exists to remove, in the turn that is now worth
 * keeping. What it buys is STORED == LAST SHOWN: a half-written directive can
 * never become a card, and the bubble was already hiding it, so the stored turn
 * ends up as the last thing the owner actually saw. The prefix rule is not
 * exact and that is its cost — a prose line ending `Email:` is dropped from an
 * interrupted turn too, having been hidden from the bubble for the same
 * reason. The two staying in step is the property worth having.
 *
 * Only a trailing one, and only when completing it would make a NEW card — the
 * same question `streamingEmailRefsText` asks, asked once here so the bubble and
 * the transcript cannot answer it differently. A finished directive is left
 * alone: it is what the cards are made from.
 */
export function dropUnfinishedDirective(raw: string): string {
  if (!PARTIAL_DIRECTIVE_TAIL_RE.test(raw)) return raw;
  const settled = splitEmailRefs(raw);
  const probe = `$1EMAIL:${unusedUid(settled.uids)}`;
  const probed = splitEmailRefs(raw.replace(PARTIAL_DIRECTIVE_TAIL_RE, probe));
  // Not `$1`: the newline goes with the line, or an interrupted reply keeps a
  // blank one where the directive was. Exactly one, so a directive the model
  // separated from its prose with a blank line leaves a trailing "\n"; the
  // bubble is derived from this same call, so the two still agree, and markdown
  // renders it as nothing.
  return probed.uids.length > settled.uids.length ? raw.replace(PARTIAL_DIRECTIVE_TAIL_RE, "") : raw;
}

/** The smallest id the reply has not already named. At most MAX_REFS + 1. */
function unusedUid(taken: number[]): number {
  const used = new Set(taken);
  let uid = 1;
  while (used.has(uid)) uid += 1;
  return uid;
}
