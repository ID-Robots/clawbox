/**
 * The box's audit log: who signed in (or failed to), and every administrator
 * action — users added and removed, passwords reset and changed, the
 * organisation and sharing switches, the per-user limits, the owner's own
 * password, the factory reset, updates and runtime swaps (TASK-2446).
 * SERVER ONLY.
 *
 * ONE APPEND-ONLY FILE under the data directory, a JSON object per line,
 * written 0600 and never rewritten in place: nothing on the box offers to
 * edit or delete a line, and the owner reads it in Settings → System → Users
 * (`GET /setup-api/settings/audit-log`, the owner's session only). The Files
 * app never serves it (src/lib/file-guard.ts keeps data/ to itself).
 *
 * Bounded, because a box's disk is small and a password guesser is patient:
 * past AUDIT_LOG_MAX_BYTES the file is renamed to `<name>.1` (the one older
 * generation kept, replacing the previous) and a new one begins. A refusal at
 * the lockout gate (`/login-api` answering 429 before a password is looked
 * at) is not written at all — each of those is a request that was never
 * tried, and logging them would let anyone fill the log by asking.
 *
 * A record, never a gate: writing it never throws, and a write that fails is
 * one line in the journal, not a refused sign-in or a failed action.
 *
 * What a line never holds: a password, a cookie, a token, or a name somebody
 * typed at the sign-in screen that is not an account on this box (people type
 * their password into the name field) — that is logged as `actor: null`.
 */

import fs from "fs";
import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { createSerialLock } from "@/lib/serial-lock";

export const AUDIT_LOG_NAME = "audit-log.jsonl";
/** Past this the log is rotated to `<name>.1`. */
export const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** The most entries one read hands back. */
export const AUDIT_READ_MAX = 1000;
/** How much of each file's end a read looks at. */
const READ_TAIL_BYTES = 1024 * 1024;

export const AUDIT_EVENTS = [
  "login",
  "login_failed",
  "logout",
  "user_create",
  "user_remove",
  "user_password_reset",
  "password_change",
  "owner_password_change",
  "org_mode",
  "openclaw_sharing",
  "user_limits",
  "factory_reset",
  "update_start",
  "harness_swap",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export type AuditDetail = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  /** ISO time the line was written. */
  ts: string;
  event: AuditEvent;
  /** Who did it: a ClawBox username, or null for nobody this box knows (an unknown sign-in name, the agent's bearer). */
  actor: string | null;
  /** Whom or what it was done to (a username), when that is not the actor. */
  target?: string;
  /** The address the request came from, as far as the box can tell. */
  ip?: string;
  /** A few plain facts: the new value of a switch, the limits set, why a sign-in failed. */
  detail?: AuditDetail;
}

/** Resolved per call so a test can point CLAWBOX_ROOT at a temp dir before importing. */
export function auditLogPath(): string {
  return path.join(DATA_DIR, AUDIT_LOG_NAME);
}

const STRING_MAX = 200;
const DETAIL_KEYS_MAX = 12;

function cleanString(value: unknown, max = STRING_MAX): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanDetail(detail: unknown): AuditDetail | undefined {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const out: AuditDetail = {};
  let n = 0;
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (n >= DETAIL_KEYS_MAX) break;
    const name = cleanString(k, 40);
    if (!name) continue;
    if (v === null || typeof v === "boolean") out[name] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[name] = v;
    else if (typeof v === "string") out[name] = cleanString(v) ?? "";
    else continue;
    n++;
  }
  return n > 0 ? out : undefined;
}

/**
 * The address a request came from, as the box was told it: Cloudflare's
 * header on a tunnel request (production-server.js deletes it from anyone but
 * the local tunnel, scripts/proxy-peer.js), else the forwarded-for address
 * Next records for the socket. Characters of an address only.
 */
export function auditAddress(request: Request): string | undefined {
  const raw = request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
  const address = raw.replace(/^::ffff:/, "");
  return /^[0-9A-Fa-f:.]{2,64}$/.test(address) ? address : undefined;
}

/** The person a request speaks for (owner or user), or null — the agent's bearer, no session. */
export async function auditActorOf(request: Request): Promise<string | null> {
  try {
    const { personSession } = await import("@/lib/owner-session");
    return (await personSession(request))?.username ?? null;
  } catch {
    return null;
  }
}

const withLogLock = createSerialLock();

/**
 * Append one line. Never throws. `request`, when given, supplies the address
 * (and nothing else: the actor is the caller's to name).
 */
export async function recordAudit(
  entry: { event: AuditEvent; actor: string | null; target?: string; detail?: AuditDetail },
  request?: Request,
): Promise<void> {
  if (!(AUDIT_EVENTS as readonly string[]).includes(entry.event)) return;
  const line: AuditEntry = {
    ts: new Date().toISOString(),
    event: entry.event,
    actor: cleanString(entry.actor, 64) ?? null,
  };
  const target = cleanString(entry.target, 64);
  if (target) line.target = target;
  const ip = request ? auditAddress(request) : undefined;
  if (ip) line.ip = ip;
  const detail = cleanDetail(entry.detail);
  if (detail) line.detail = detail;
  const text = `${JSON.stringify(line)}\n`;
  await withLogLock(async () => {
    const file = auditLogPath();
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const size = await fs.promises.stat(file).then((s) => s.size, () => 0);
      if (size + Buffer.byteLength(text) > AUDIT_LOG_MAX_BYTES && size > 0) {
        await fs.promises.rename(file, `${file}.1`);
      }
      await fs.promises.appendFile(file, text, { mode: 0o600, flag: "a" });
    } catch (err) {
      console.error("[audit-log] could not write the audit log:", err instanceof Error ? err.message : err);
    }
  });
}

function parseLine(line: string): AuditEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ts !== "string" || typeof r.event !== "string" || !(AUDIT_EVENTS as readonly string[]).includes(r.event)) return null;
  const entry: AuditEntry = {
    ts: r.ts,
    event: r.event as AuditEvent,
    actor: typeof r.actor === "string" ? r.actor : null,
  };
  if (typeof r.target === "string") entry.target = r.target;
  if (typeof r.ip === "string") entry.ip = r.ip;
  const detail = cleanDetail(r.detail);
  if (detail) entry.detail = detail;
  return entry;
}

/** The well-formed entries at the end of one file, oldest first; whether older ones were left unread. */
async function tailEntries(file: string): Promise<{ entries: AuditEntry[]; cut: boolean }> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return { entries: [], cut: false };
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - READ_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let lines = buffer.toString("utf-8").split("\n");
    // A read that began mid-line drops that line's tail.
    if (start > 0) lines = lines.slice(1);
    const entries = lines.map((l) => l.trim()).filter(Boolean).map(parseLine).filter((e): e is AuditEntry => e !== null);
    return { entries, cut: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * The newest `limit` entries, newest first, from the log and its one older
 * generation. `more` says older entries exist that were not handed back.
 */
export async function readAuditLog({ limit = 200 }: { limit?: number } = {}): Promise<{ entries: AuditEntry[]; more: boolean }> {
  const want = Math.max(1, Math.min(AUDIT_READ_MAX, Math.floor(limit)));
  const file = auditLogPath();
  return withLogLock(async () => {
    const current = await tailEntries(file);
    let entries = current.entries;
    let more = current.cut;
    if (entries.length < want && !current.cut) {
      const older = await tailEntries(`${file}.1`);
      entries = [...older.entries, ...entries];
      more = older.cut;
    } else if (!more) {
      more = await fs.promises.stat(`${file}.1`).then(() => true, () => false);
    }
    if (entries.length > want) more = true;
    return { entries: entries.slice(-want).reverse(), more };
  });
}
