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
 * past AUDIT_LOG_MAX_BYTES the file is copied to `<name>.1` (the one older
 * generation kept, replacing the previous) and begins again. A refusal at
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
import { PEER_HEADER } from "../../scripts/proxy-peer.js";

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

/**
 * The characters a written field may hold: printable ASCII. What is written is
 * REBUILT from this alphabet character by character (the `rebuildUsername`
 * idiom, src/lib/clawbox-users.ts) — a control character becomes a space and
 * anything else outside it a `?` — so the line on disk is this module's own
 * string, never a request's that a check merely vouched for.
 */
const LINE_ALPHABET = " !#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~\"";

function rebuilt(value: unknown, max = STRING_MAX): string | undefined {
  if (typeof value !== "string") return undefined;
  let out = "";
  for (const ch of value) {
    if (out.length >= max) break;
    const at = LINE_ALPHABET.indexOf(ch);
    out += at >= 0 ? LINE_ALPHABET[at] : /[\u0000-\u001f\u007f]/.test(ch) ? " " : "?";
  }
  out = out.trim();
  return out || undefined;
}

/** A detail as it is written: plain values only, every string and number rebuilt. */
function writtenDetail(detail: unknown): AuditDetail | undefined {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const out: AuditDetail = {};
  let n = 0;
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (n >= DETAIL_KEYS_MAX) break;
    const name = rebuilt(k, 40);
    if (!name) continue;
    if (v === null) out[name] = null;
    else if (typeof v === "boolean") out[name] = v === true;
    else if (typeof v === "number" && Number.isFinite(v)) out[name] = Number(rebuilt(String(v), 32));
    else if (typeof v === "string") out[name] = rebuilt(v) ?? "";
    else continue;
    n++;
  }
  return n > 0 ? out : undefined;
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
 * The address a request came from, from headers a client cannot choose:
 * Cloudflare's on a tunnel request (production-server.js deletes it from every
 * peer but the local tunnel), else the socket's own peer, which the same guard
 * writes into `x-clawbox-peer` on every request (scripts/proxy-peer.js) over
 * anything a client sent. Never `X-Forwarded-For`: a LAN client sets that to
 * whatever it likes. Characters of an address only; none under `next dev`,
 * which has no such guard.
 */
export function auditAddress(request: Request): string | undefined {
  // `next dev` runs without production-server.js's guard, so both headers
  // are whatever a client sent: no address is better than a chosen one.
  if (process.env.NODE_ENV === "development") return undefined;
  const raw = request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get(PEER_HEADER)?.trim()
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

/**
 * One lock for every copy of this module the box loads: Next can give route
 * bundles their own module instances, and the reset's clear must wait for a
 * sign-in line queued from any of them. Kept on `globalThis` under a
 * registered symbol, like the chat counter (scripts/user-limits.js).
 */
const LOCK_KEY = Symbol.for("clawbox.auditLog.lock");
const withLogLock: ReturnType<typeof createSerialLock> = (() => {
  const g = globalThis as unknown as Record<symbol, ReturnType<typeof createSerialLock> | undefined>;
  let lock = g[LOCK_KEY];
  if (!lock) {
    lock = createSerialLock();
    g[LOCK_KEY] = lock;
  }
  return lock;
})();

/**
 * Append one line. Never throws. `request`, when given, supplies the address
 * (and nothing else: the actor is the caller's to name).
 */
export async function recordAudit(
  entry: { event: AuditEvent; actor: string | null; target?: string; detail?: AuditDetail },
  request?: Request,
): Promise<void> {
  if (!(AUDIT_EVENTS as readonly string[]).includes(entry.event)) return;
  const event = AUDIT_EVENTS[(AUDIT_EVENTS as readonly string[]).indexOf(entry.event)];
  const line: AuditEntry = {
    ts: new Date().toISOString(),
    event,
    actor: rebuilt(entry.actor, 64) ?? null,
  };
  const target = rebuilt(entry.target, 64);
  if (target) line.target = target;
  const ip = request ? rebuilt(auditAddress(request), 64) : undefined;
  if (ip) line.ip = ip;
  const detail = writtenDetail(entry.detail);
  if (detail) line.detail = detail;
  const text = `${JSON.stringify(line)}\n`;
  await withLogLock(async () => {
    // Sealed by a factory reset: only its own line is written until the box
    // restarts — a sign-in that resolved its account before the wipe and
    // finishes after it must not bring the previous owner's name back.
    if (sealState().sealed && line.event !== "factory_reset") return;
    const file = auditLogPath();
    let handle: fs.promises.FileHandle | null = null;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      // Opened ONCE and measured by its descriptor: the size checked is the
      // size of the file written, with nothing between the two to swap it.
      // Rotation goes through the same descriptor too — the full log is
      // copied out to `<name>.1` (the one older generation) and this one
      // truncated — rather than renamed and opened again by its path.
      handle = await fs.promises.open(file, "a+", 0o600);
      const { size } = await handle.stat();
      if (size > 0 && size + Buffer.byteLength(text) > AUDIT_LOG_MAX_BYTES) {
        const old = Buffer.alloc(size);
        const { bytesRead } = await handle.read(old, 0, size, 0);
        await fs.promises.writeFile(`${file}.1`, old.subarray(0, bytesRead), { mode: 0o600 });
        await handle.truncate(0);
      }
      await handle.write(text);
    } catch (err) {
      console.error("[audit-log] could not write the audit log:", err instanceof Error ? err.message : err);
    } finally {
      await handle?.close().catch(() => {});
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
  } catch (err) {
    // No log yet is an empty one; a log that is there but cannot be read is
    // a failure the owner is told about, never "nothing has been recorded".
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { entries: [], cut: false };
    throw err;
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

/**
 * Remove the log and its older generation for a factory reset, under the
 * same lock every write takes: a line queued before the reset (a sign-in at
 * that moment, carrying the previous owner's name and address) is written
 * first and removed with the rest, never left to recreate the file after the
 * data directory was wiped. The lock runs its work in the order it was asked.
 */
export async function clearAuditLogForReset(): Promise<void> {
  await withLogLock(async () => {
    // Sealed first: from here every write but the reset's own line is
    // dropped, including one from a request already past its checks.
    sealState().sealed = true;
    const file = auditLogPath();
    await fs.promises.rm(file, { force: true });
    await fs.promises.rm(`${file}.1`, { force: true });
  });
}

/** A factory reset that stopped short (no reboot follows): the log records again. */
export function unsealAuditLog(): void {
  sealState().sealed = false;
}

/** The seal a factory reset puts on the log until the box restarts — one for every module copy. */
function sealState(): { sealed: boolean } {
  const g = globalThis as unknown as Record<symbol, { sealed: boolean } | undefined>;
  const key = Symbol.for("clawbox.auditLog.sealed");
  let state = g[key];
  if (!state) {
    state = { sealed: false };
    g[key] = state;
  }
  return state;
}
