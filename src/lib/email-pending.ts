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

const MAX_RECIPIENTS = 10;
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 20_000;
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
  const to = input.to.map((r) => r.trim()).filter(Boolean);
  if (to.length === 0) return { ok: false, error: "A recipient is required", reason: "invalid" };
  if (to.length > MAX_RECIPIENTS) {
    return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients`, reason: "invalid" };
  }
  const subject = input.subject.trim();
  if (!subject || subject.length > MAX_SUBJECT_LEN) {
    return { ok: false, error: "A subject is required", reason: "invalid" };
  }
  if (!input.body || input.body.length > MAX_BODY_LEN) {
    return { ok: false, error: "A message body is required", reason: "invalid" };
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
    body: input.body,
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
