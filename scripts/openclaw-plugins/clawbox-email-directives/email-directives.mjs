// The `EMAIL:<uid>` directive grammar, as JavaScript.
//
// THE THIRD OF THREE COPIES. The original is `src/lib/chat-email-refs.ts`
// (`splitEmailRefs`), which is what a ClawBox chat renders cards from;
// `scripts/hermes-plugins/hooks/clawbox_email_directives/email_directives.py`
// is the second. They cannot share a file — this one is loaded by a plugin
// inside the OpenClaw gateway's own Node process, that one by a Python plugin
// inside the Hermes agent's, and the original by a Next.js bundle. What they
// share is a case table: `src/tests/fixtures/email-directive-cases.ts` is run
// through all three by `src/tests/unit/email-directive-parity.test.ts`, so a
// change made to one and not the others fails a test rather than shipping.
//
// Plain `.mjs` with no imports and no dependencies, because it is COPIED into
// `~/.openclaw/plugins/` and loaded by whatever Node the gateway runs.

/** A directive line: `EMAIL:` at the very start of the (trimmed) line. */
const EMAIL_LINE_RE = /^email:\s*(.*)$/i;

/** Opening or closing marker of a fenced code block. */
const FENCE_RE = /^(?:```|~~~)/;

/** IMAP UIDs are 32-bit and start at 1. */
const MAX_UID = 4294967295;

/** Most cards shown under one reply, however many the agent named. */
const MAX_REFS = 25;

/**
 * `raw` without the directive lines a ClawBox chat would have turned into
 * cards — and with every other line, including a directive whose payload is not
 * a usable id, exactly where it was.
 */
export function stripEmailDirectives(raw) {
  return splitEmailRefs(raw).text;
}

/**
 * Splits `EMAIL:` directives out of assistant text.
 *
 * Recognised only at the start of a line and never inside a fenced code block,
 * so a reply that EXPLAINS the syntax still keeps it as text. A directive whose
 * payload is not a usable id is KEPT, for the same reason the chat window keeps
 * it: dropping the line would hide that the agent meant to point at something.
 */
export function splitEmailRefs(raw) {
  if (typeof raw !== "string") return { text: "", uids: [] };
  // Cheap bail-out, and the empty string's split is itself.
  if (!/email:/i.test(raw)) return { text: raw, uids: [] };

  const uids = [];
  const seen = new Set();
  const kept = [];
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
    if (uid === null) {
      kept.push(line);
      continue;
    }
    if (seen.has(uid)) continue;
    // Past the cap the line goes back to being TEXT rather than disappearing:
    // this function may remove a line only when the chat window would have
    // turned that line into a card.
    if (uids.length >= MAX_REFS) {
      kept.push(line);
      continue;
    }
    seen.add(uid);
    uids.push(uid);
  }

  // Removing a line from the middle of a reply leaves a hole; collapse the run
  // of blank lines behind it so the prose keeps its shape.
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, uids };
}

/** A UID, or null when the payload is not one. */
function parseUid(payload) {
  const value = unwrapQuoted(payload.trim());
  // Digits only: `+7`, `7.0`, `0x1f` and `7 or so` are all model output that
  // happens to start like a number, and `Number()` would take most of them.
  if (!/^[0-9]{1,10}$/.test(value)) return null;
  const uid = Number(value);
  if (!Number.isInteger(uid) || uid < 1 || uid > MAX_UID) return null;
  return uid;
}

/** Strips one layer of the quoting a model tends to wrap a value in. */
function unwrapQuoted(value) {
  for (const quote of ["`", '"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}
