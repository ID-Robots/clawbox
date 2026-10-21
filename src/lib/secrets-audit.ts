/**
 * The secret store's audit trail: one JSON line per change to the owner's
 * secrets and per run they were handed to — `data/secrets-audit.log`.
 *
 * WHAT A LINE HOLDS: the time, the action, the name (or names), the scope, and
 * for a copy the place it was copied from; for a run, the run's id. NEVER a
 * value, its length, a hash of it or anything else derived from one. The entry
 * type below has no field a value could go in, and every name and scope is
 * re-checked against the store's own alphabet before it is written, so a caller
 * that passed something else gets a dropped field rather than a leaked one.
 *
 * WHY A FILE OF ITS OWN and not the journal alone. The routes already say what
 * they did on stderr, and that stays. But the journal rotates on the system's
 * schedule, is mixed with every other line the box prints and is what a support
 * bundle collects; the owner's question — "when did this key get copied, and
 * which runs were handed it?" — wants a short list of exactly these events that
 * outlives a reboot. The same discipline as the store beside it: 0600, under
 * `data/`, and on the coding agent's list of files a run may never read
 * (`DATA_SECRET_FILES` in src/lib/coding-agent.ts) — names are not values, but
 * which projects hold which credentials is the owner's to know.
 *
 * BOUNDED. Past `MAX_AUDIT_BYTES` the oldest half is dropped, so the file can
 * never fill the eMMC however many runs a box starts.
 *
 * NEVER THROWS. A change the owner made, or a run the box started, must not
 * fail because its log line could not be written; the failure is reported on
 * stderr instead, and the route's own journal line is still there.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { isDeviceSecretScope, isValidSecretScope, SECRET_NAME_RE } from "@/lib/project-secrets-shape";

export const SECRETS_AUDIT_FILE_NAME = "secrets-audit.log";

const AUDIT_PATH = path.join(DATA_DIR, SECRETS_AUDIT_FILE_NAME);

/** Where the trail lives. */
export function secretsAuditPath(): string {
  return AUDIT_PATH;
}

/** A quarter of a megabyte: years of owner changes, months of daily runs. */
export const MAX_AUDIT_BYTES = 256 * 1024;

export type SecretAuditAction =
  /** Copied from the main assistant ("Import from assistant"). */
  | "import"
  /** Typed in by the owner, new or replaced. */
  | "save"
  /** Ticked for a run's environment, or taken out of it. */
  | "tick"
  | "untick"
  /** Taken back by the owner, or with a deleted project's folder. */
  | "delete"
  /** Handed to a run as environment variables. */
  | "inject";

/** Where a copied value came from. Only the assistant, today. */
export type SecretImportSource = "hermes";

export interface SecretAuditEvent {
  action: SecretAuditAction;
  /** The one entry this is about… */
  name?: string;
  /** …or several, for a run's injection or a project's folder going. */
  names?: string[];
  scope?: string;
  source?: SecretImportSource;
  runId?: string;
  /** Why, when it was not the owner's own click — "project_deleted". */
  reason?: string;
}

/** A run id as the coding agent mints them: letters, digits and dashes. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REASON_RE = /^[a-z_]{1,32}$/;

function cleanScope(scope: unknown): string | undefined {
  return typeof scope === "string" && (isValidSecretScope(scope) || isDeviceSecretScope(scope)) ? scope : undefined;
}

function cleanName(name: unknown): string | undefined {
  return typeof name === "string" && SECRET_NAME_RE.test(name) ? name : undefined;
}

/** The line, built from re-checked fields only — see the header. */
export function auditLine(event: SecretAuditEvent, at: Date = new Date()): string {
  const line: Record<string, unknown> = { at: at.toISOString(), action: event.action };
  const name = cleanName(event.name);
  if (name) line.name = name;
  if (Array.isArray(event.names)) {
    const names = event.names.map(cleanName).filter((n): n is string => Boolean(n));
    if (names.length) line.names = names;
  }
  const scope = cleanScope(event.scope);
  if (scope) line.scope = scope;
  if (event.source === "hermes") line.source = event.source;
  if (typeof event.runId === "string" && RUN_ID_RE.test(event.runId)) line.runId = event.runId;
  if (typeof event.reason === "string" && REASON_RE.test(event.reason)) line.reason = event.reason;
  return `${JSON.stringify(line)}\n`;
}

/** Keep the newest half of the lines once the file has outgrown its bound. */
async function trimIfLarge(): Promise<void> {
  // Size and text from one open file, so the text is the file that was measured.
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(AUDIT_PATH, "r");
  } catch {
    return;
  }
  let text: string;
  try {
    if ((await handle.stat()).size <= MAX_AUDIT_BYTES) return;
    text = await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
  const keepFrom = text.length - Math.floor(MAX_AUDIT_BYTES / 2);
  // From the start of a whole line, so the kept half still parses line by line.
  const cut = text.indexOf("\n", Math.max(0, keepFrom));
  const kept = cut < 0 ? "" : text.slice(cut + 1);
  const tmp = untraced(`${AUDIT_PATH}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, kept, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, AUDIT_PATH);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** One append at a time, so a trim can never interleave with a write. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Append one event. Never throws — see the header. Resolves once the line is on
 * disk (or has failed), so a caller that awaits it can rely on the order.
 */
export function appendSecretAudit(event: SecretAuditEvent): Promise<void> {
  const work = async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(AUDIT_PATH, auditLine(event), { mode: 0o600 });
      // `mode` only applies when the append CREATES the file; this is for one
      // restored from an archive that lost the bits.
      await fs.chmod(AUDIT_PATH, 0o600);
      await trimIfLarge();
    } catch (err) {
      console.error("[secrets] could not write the secrets audit line:", err instanceof Error ? err.message : err);
    }
  };
  const next = chain.then(work, work);
  chain = next.then(() => undefined, () => undefined);
  return next;
}
