// TASK-452 — ClawBox's own record of skill installs that the owner had to
// confirm past a security warning.
//
// Hermes keeps ~/.hermes/skills/.hub/audit.log, but that file records what the
// INSTALLER did ("INSTALL simple-english official:builtin dangerous sha256:…")
// — it has no idea a human was shown a warning and clicked through it, because
// on the box that never happened: the trust tier said `allow` and nobody was
// asked. Krasi's ruling turns that into an explicit owner decision, and an
// explicit decision is only meaningful if it leaves a trace.
//
// One JSON object per line, newest last, at
// <CLAWBOX_ROOT>/data/skill-install-audit.log. Line-delimited rather than a
// JSON array so an append is a single atomic-ish write and a truncated tail
// costs one record instead of the file.
//
// The log holds a decision, not a secret: skill id, verdict, which capabilities
// the owner was warned about, and when. It is never served to the browser.

import fs from 'fs/promises';
import path from 'path';
import { getSystemUsername } from '@/lib/auth';
import type { CapabilityId, FindingSeverity } from '@/lib/hermes-skill-capabilities';

const DATA_ROOT = path.join(
  process.env.CLAWBOX_ROOT ||
    (process.env.NODE_ENV === 'development' ? process.cwd() : '/home/clawbox/clawbox'),
  'data',
);

const AUDIT_PATH = path.join(DATA_ROOT, 'skill-install-audit.log');

// A confirmation is a rare, deliberate act; even a pathological device writes a
// handful a day. Rotate at a size that keeps months of history but cannot grow
// without bound on a Jetson's eMMC.
const MAX_BYTES = 512 * 1024;

export interface SkillAuditRecord {
  /** ISO-8601, UTC. */
  at: string;
  action:
    | 'install-confirmed'
    | 'install-refused'
    /** The device's own installer refused it outright — no confirmation overrides this one. */
    | 'install-blocked-by-device'
    | 'install-incomplete'
    | 'install-name-conflict';
  /** Registry identifier the owner asked for. */
  id: string;
  /** Resolved skill name / lock key, when the install got far enough to have one. */
  name?: string;
  source?: string;
  trust?: string;
  verdict?: string;
  findingCount?: number;
  capabilities?: CapabilityId[];
  severities?: Partial<Record<FindingSeverity, number>>;
  /** Files the install could not obtain (the incomplete-install case). */
  missingFiles?: string[];
  /** The bundled skill an install would have shadowed. */
  conflictsWith?: string;
  /**
   * WHO confirmed. A ClawBox has exactly one owner account and the store is
   * behind the session cookie, so the device's own account name is the honest
   * answer — inventing a per-request identity the product does not have would
   * make the field look more precise than it is.
   */
  actor: string;
}

/** Everything except `at` and `actor`, which this module fills in. */
export type SkillAuditInput = Omit<SkillAuditRecord, 'at' | 'actor'>;

/**
 * Append one decision to the audit log.
 *
 * Never throws: an audit write that fails must not turn a successful install
 * into an error the owner cannot act on. A failure is logged to the server
 * console, which is where the rest of this route family reports.
 */
export async function auditSkillInstall(input: SkillAuditInput): Promise<void> {
  const record: SkillAuditRecord = {
    at: new Date().toISOString(),
    actor: getSystemUsername(),
    ...input,
  };
  try {
    await fs.mkdir(DATA_ROOT, { recursive: true });
    await rotateIfLarge();
    await fs.appendFile(AUDIT_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error('[hermes skills audit] could not write', err);
  }
}

async function rotateIfLarge(): Promise<void> {
  try {
    const st = await fs.stat(AUDIT_PATH);
    if (st.size < MAX_BYTES) return;
  } catch {
    return; // no file yet — nothing to rotate
  }
  // One generation back is enough: the log is a compliance trail for a single
  // device, not a shipped telemetry stream.
  await fs.rename(AUDIT_PATH, `${AUDIT_PATH}.1`).catch(() => {});
}

/** Read the log back, newest first. Used by the tests and by support. */
export async function readSkillAuditLog(limit = 100): Promise<SkillAuditRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(AUDIT_PATH, 'utf8');
  } catch {
    return [];
  }
  const out: SkillAuditRecord[] = [];
  for (const line of raw.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SkillAuditRecord);
    } catch {
      continue; // a torn tail line costs one record, not the file
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Test seam: where the log lives on this device. */
export const SKILL_AUDIT_PATH = AUDIT_PATH;
