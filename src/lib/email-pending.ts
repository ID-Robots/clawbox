// Outbound mail the agent wants to send and the owner has not agreed to yet.
//
// WHY A STORE AND NOT A PROMPT: there is no human in the loop at the moment the
// agent decides to send. ClawBox registers its MCP server into Hermes with
// `trust: full` (scripts/register-mcp.sh) because the appliance agent runs
// headless and one-shot — an approval prompt would have nobody to answer it and
// would hang the turn. So consent cannot be synchronous. It is made
// asynchronous instead: the send becomes a draft on disk, the agent is told so
// in the same breath, and the owner approves or deletes it in Settings → Email
// whenever they next look.
//
// This is the difference between the send budget in /email/send (a blast-radius
// limit — it bounds a runaway, it cannot stop the first message) and this file
// (actual consent — nothing reaches the wire without a click).
//
// STORAGE: data/email-pending.json, written 0600 via temp+rename, the same
// discipline config-store uses for the credentials themselves. It is a separate
// file rather than a config key because it is a queue with a lifecycle and a
// cap, and mixing it into the settings blob would put agent-supplied text into
// the file every settings read parses.
//
// WHAT IS IN IT: recipient, subject and body — text the agent composed, which
// on a bad day is text an ATTACKER composed via prompt injection. It is never
// executed, never re-parsed as configuration, and everything that renders it
// (the Settings strip, the MCP reply) treats it as untrusted content.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import { EMAIL_ADDRESS_RE } from "@/lib/smtp-client";

const PENDING_PATH = path.join(DATA_DIR, "email-pending.json");

/**
 * How many drafts may wait at once.
 *
 * When it is full, queueing FAILS rather than evicting the oldest. Evicting
 * would hand an injected agent a way to push a real draft out of the owner's
 * view by queueing twenty more — the queue would become a place things quietly
 * disappear from, which is the opposite of what it is for.
 */
export const MAX_PENDING = 20;

/**
 * What one message may be. Exported and imported by /setup-api/email/send
 * rather than restated there: the route checks them first so a caller hears
 * about a 30,000-character body before the send budget is spent, and this
 * module checks them again because it is the last step before a file write.
 * Two copies of the same numbers would drift into a route that accepts what
 * the queue then refuses.
 */
export const MAX_RECIPIENTS = 10;
export const MAX_SUBJECT_LEN = 200;
export const MAX_BODY_LEN = 20_000;

/**
 * The repertoire a stored draft may be made of.
 *
 * These two patterns are the whole answer to "what can end up in
 * email-pending.json". They are anchored and they name the characters that ARE
 * allowed instead of the ones that are not, so a draft reaches the disk only
 * when every character in it is one this file already knew about — the queue
 * never takes the caller's bytes on trust and writes them straight out.
 *
 * What they keep out is not cosmetic:
 *   - C0/C1 controls and DEL. The subject becomes a mail header and the body
 *     becomes the DATA section; both are also echoed back to the agent and
 *     rendered in Settings, where an ANSI escape is a way to make one draft
 *     read as another.
 *   - CR and LF in the SUBJECT specifically — a header value with a line break
 *     in it is a header injection. A body is allowed them; that is what a body
 *     is.
 *   - U+2028/U+2029, the bidi overrides and embeddings (U+202A-U+202E) and the
 *     bidi isolates (U+2066-U+2069), and U+FEFF: characters whose only effect
 *     here would be to make the approval prompt read differently from what
 *     gets sent.
 *
 * Everything else is allowed — every script, every emoji — because people
 * write mail in their own language. Zero-width joiners are deliberately still
 * in: they are load-bearing in Persian, in Hindi and in emoji sequences.
 */
const DRAFT_SUBJECT_RE = /^[\u0020-\u007e\u00a0-\u2027\u202f-\u2065\u206a-\ufefe\uff00-\uffff]+$/;
const DRAFT_BODY_RE = /^[\t\n\r\u0020-\u007e\u00a0-\u2027\u202f-\u2065\u206a-\ufefe\uff00-\uffff]+$/;

/** How much of the body the approvals strip shows before the owner opens it. */
export const PREVIEW_CHARS = 160;

export interface PendingEmail {
  id: string;
  to: string[];
  subject: string;
  body: string;
  /** Epoch ms. */
  createdAt: number;
}

/** What the Settings panel gets. Full body included — the owner is approving it. */
export interface PendingEmailView {
  id: string;
  to: string[];
  subject: string;
  preview: string;
  body: string;
  createdAt: number;
}

export type QueueResult =
  | { ok: true; draft: PendingEmail }
  | { ok: false; error: string; reason: "full" | "invalid" };

function readAll(): PendingEmail[] {
  try {
    if (!fs.existsSync(PENDING_PATH)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(PENDING_PATH, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingEmail);
  } catch {
    // A corrupt queue must not take the email feature down. An unreadable file
    // means "nothing is waiting", and the next queue rewrites it.
    return [];
  }
}

function isPendingEmail(value: unknown): value is PendingEmail {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && Array.isArray(v.to)
    && v.to.every((r) => typeof r === "string")
    && typeof v.subject === "string"
    && typeof v.body === "string"
    && typeof v.createdAt === "number"
  );
}

function writeAll(drafts: PendingEmail[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Same reasoning as config-store.writeConfig: fresh temp at 0600, chmod in
  // case a stale temp survived a crash at 0644, then atomic rename.
  const tmp = `${PENDING_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(drafts, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not break the queue
  }
  fs.renameSync(tmp, PENDING_PATH);
}

/**
 * Put a message in the queue instead of sending it.
 *
 * Validation is repeated here rather than trusted from the caller: this is the
 * last point before agent-composed text lands on disk, and the route that calls
 * it is not the only conceivable caller.
 */
export function queuePending(input: { to: string[]; subject: string; body: string }): QueueResult {
  // Built one recipient at a time rather than mapped in place: the list that
  // reaches the disk is the one this loop assembled out of strings it has just
  // checked, not the array the caller handed over. The address check is the
  // one the send route already applies — repeated here because this, not the
  // route, is the last point before the text lands in a file.
  const to: string[] = [];
  for (const raw of input.to) {
    const recipient = raw.trim();
    if (!recipient) continue;
    if (recipient.length > 254 || !EMAIL_ADDRESS_RE.test(recipient)) {
      return { ok: false, error: `"${recipient}" is not a valid email address`, reason: "invalid" };
    }
    to.push(recipient);
  }
  if (to.length === 0) return { ok: false, error: "A recipient is required", reason: "invalid" };
  if (to.length > MAX_RECIPIENTS) {
    return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients`, reason: "invalid" };
  }
  const subject = input.subject.trim();
  if (!subject) return { ok: false, error: "A subject is required", reason: "invalid" };
  // Reported apart from the empty case on purpose: an agent told a 30,000-
  // character body is "required" has no reason to shorten it and retries the
  // same input.
  if (subject.length > MAX_SUBJECT_LEN) {
    return {
      ok: false,
      error: `A subject may be at most ${MAX_SUBJECT_LEN} characters`,
      reason: "invalid",
    };
  }
  if (!DRAFT_SUBJECT_RE.test(subject)) {
    return {
      ok: false,
      error: "The subject has characters in it that this ClawBox will not put in a mail header",
      reason: "invalid",
    };
  }
  const body = input.body;
  if (!body) return { ok: false, error: "A message body is required", reason: "invalid" };
  if (body.length > MAX_BODY_LEN) {
    return {
      ok: false,
      error: `A message body may be at most ${MAX_BODY_LEN} characters`,
      reason: "invalid",
    };
  }
  if (!DRAFT_BODY_RE.test(body)) {
    return {
      ok: false,
      error: "The message body has control characters in it that this ClawBox will not store",
      reason: "invalid",
    };
  }

  const drafts = readAll();
  if (drafts.length >= MAX_PENDING) {
    return {
      ok: false,
      reason: "full",
      error: `${MAX_PENDING} messages are already waiting for approval. Approve or delete some in Settings → Email first.`,
    };
  }

  const draft: PendingEmail = {
    id: randomUUID(),
    to,
    subject,
    body,
    createdAt: Date.now(),
  };
  writeAll([...drafts, draft]);
  return { ok: true, draft };
}

/** Newest first — the owner wants to see what just arrived. */
export function listPending(): PendingEmailView[] {
  return readAll()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((d) => ({
      id: d.id,
      to: d.to,
      subject: d.subject,
      preview: d.body.slice(0, PREVIEW_CHARS),
      body: d.body,
      createdAt: d.createdAt,
    }));
}

export function countPending(): number {
  return readAll().length;
}

export function getPending(id: string): PendingEmail | null {
  return readAll().find((d) => d.id === id) ?? null;
}

/**
 * Take a draft OUT of the queue, returning it. One draft can only be claimed
 * once: approve reads-and-removes before it sends, so a double click (or a
 * retry) cannot send the same message twice.
 *
 * WHAT MAKES THAT TRUE, and why there is no lock: every step in here is
 * SYNCHRONOUS — readFileSync, then writeFileSync + renameSync — with no await
 * between the read and the write. One JS thread means a second request's call
 * cannot start until this one has returned, so two approvals of the same id
 * cannot both find the draft, and two writers cannot meet in the shared
 * `.tmp` path. One device runs one server process, so there is no writer
 * outside this one either.
 *
 * Which is to say: an await anywhere in here, or a move to fs/promises, would
 * silently remove the guarantee and let one approved message be sent twice.
 */
export function claimPending(id: string): PendingEmail | null {
  const drafts = readAll();
  const found = drafts.find((d) => d.id === id);
  if (!found) return null;
  writeAll(drafts.filter((d) => d.id !== id));
  return found;
}

/** Reject. Returns false when there was nothing with that id. */
export function removePending(id: string): boolean {
  const drafts = readAll();
  const next = drafts.filter((d) => d.id !== id);
  if (next.length === drafts.length) return false;
  writeAll(next);
  return true;
}

/** Used when the account is disconnected — drafts for a dead account are noise. */
export function clearPending(): void {
  try {
    if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
  } catch {
    // best-effort
  }
}
