// Where the device edition actually comes from.
//
// The edition is a PROPERTY OF THE INSTALL, not of the process environment: it
// is baked at install time into a root-owned file, /etc/clawbox/edition.env
// (root:root 0644, `CLAWBOX_EDITION=<edition>`). Reading that file directly —
// rather than trusting process.env — is what makes the lock real:
//
//   - clawbox-setup.service loads `EnvironmentFile=-/home/clawbox/clawbox/.env`,
//     which the clawbox user can write (SSH, the in-UI terminal, the agent's
//     run_command) and which systemd lets OVERRIDE `Environment=`. Combined
//     with the NOPASSWD `systemctl restart clawbox-setup` in the sudoers file,
//     the customer could otherwise append CLAWBOX_EDITION=dual and flip the SKU.
//   - the updater unit (clawbox-root-update@.service) runs steps in a different
//     environment again, so env alone is not even consistent across the box.
//
// process.env stays as a FALLBACK so dev machines, CI and unit tests (where
// /etc/clawbox does not exist) keep working exactly as before.

import fs from "fs";
// Relative, not "@/": the MCP stdio process imports this module (mcp/tsconfig.json).
import path from "./runtime-path";

export type EditionName = "openclaw" | "hermes" | "dual";

/**
 * The lock value of a box that carries BOTH harnesses and has not been told
 * which one to run yet — the unified image, before the owner picks an agent in
 * the setup wizard (TASK-1149, reports/clawbox/unified-image-design-2026-09.md).
 *
 * Deliberately NOT an EditionName: nothing harness-specific runs while it is
 * set, so no reader may treat it as a SKU. `readEditionSource` reports it as
 * the defaulted "openclaw" answer plus `unselected: true`, which every existing
 * caller already handles as "nobody said" — the swap refuses, the client never
 * pins it, the boot-time migrations defer.
 */
export const UNSELECTED_EDITION = "unselected";

// Overridable for tests only; production always reads the root-owned path.
// Redirecting it is not an edition-lock bypass: no request data flows into it,
// and "dual" additionally has to clear verifyDualLicense() against a key constant
// that is deliberately not env-overridable (see edition-license.ts) — so a
// redirected path can change the edition LABEL, never unlock the premium switcher.
const EDITION_FILE = process.env.CLAWBOX_EDITION_FILE || "/etc/clawbox/edition.env";

/** The directory the lock lives in; the edition step's root-owned markers sit beside it. */
export function editionLockDir(): string {
  return path.dirname(EDITION_FILE);
}

type LockValue = EditionName | typeof UNSELECTED_EDITION;

let cache: { mtimeMs: number; edition: LockValue; hint: EditionHint | null } | null = null;

function normalizeEdition(raw: string | null | undefined): EditionName | null {
  const value = (raw || "").trim().toLowerCase();
  if (value === "openclaw" || value === "hermes" || value === "dual") return value;
  return null;
}

function normalizeLockValue(raw: string | null | undefined): LockValue | null {
  const value = (raw || "").trim().toLowerCase();
  return value === UNSELECTED_EDITION ? UNSELECTED_EDITION : normalizeEdition(value);
}

/** Which agent the box was prepared for, while it is still `unselected`. */
export type EditionHint = "openclaw" | "hermes";

function normalizeHint(raw: string | null | undefined): EditionHint | null {
  const value = (raw || "").trim().toLowerCase();
  return value === "openclaw" || value === "hermes" ? value : null;
}

// Minimal systemd EnvironmentFile parser: `KEY=value`, optional `export`,
// optional surrounding quotes. Anything else in the file is ignored.
function parseEnvValue(raw: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`);
  for (const line of raw.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return null;
}

/** Which edition, and whether anything on this device actually said so. */
export interface EditionSource {
  edition: EditionName;
  /**
   * True when NEITHER the root-owned lock nor `CLAWBOX_EDITION` named an
   * edition, so `edition` is this module's own "openclaw" default.
   *
   * That default was chosen for "which SKU is this", where guessing the
   * non-premium answer is the safe way to be wrong. It is the wrong default for
   * "which credential stores can exist on this box", where it means a Hermes
   * device with a missing lock file — a pre-3.x install, a partial image, a
   * provisioning step that has not run — silently claims to have no Hermes
   * store. A caller asking the second question has to be able to see that the
   * answer was a guess; see telegram-bot-identity.ts.
   */
  defaulted: boolean;
  /**
   * Present (and true) only when the root-owned lock reads `unselected`: a
   * unified-image box whose owner has not picked an agent yet. `edition` is
   * then the "openclaw" default and `defaulted` is true, so a caller that does
   * not know this flag treats the box as one nobody named — which it is.
   */
  unselected?: true;
  /**
   * With `unselected` only: the agent the box was prepared for
   * (`CLAWBOX_EDITION_HINT` in the lock), which the wizard preselects. A hint
   * never locks anything.
   */
  hint?: EditionHint;
}

/**
 * The edition this device was installed as. Root-owned file first, environment
 * second, "openclaw" (the native, non-premium SKU) as the safe default.
 *
 * `unselected` is honoured from the LOCK only, never from the environment: the
 * clawbox-writable .env must not be able to put a provisioned box back in
 * front of the edition step.
 *
 * Cached by mtime — this is called per request from middleware, and the file
 * only changes when the installer re-bakes the lock.
 */
export function readEditionSource(): EditionSource {
  try {
    const parsed = readEditionLock();
    if (parsed?.edition === UNSELECTED_EDITION) {
      return {
        edition: "openclaw",
        defaulted: true,
        unselected: true,
        ...(parsed.hint ? { hint: parsed.hint } : {}),
      };
    }
    if (parsed) return { edition: parsed.edition, defaulted: false };
  } catch {
    // No /etc/clawbox/edition.env (dev box, CI, pre-3.x install), or one that
    // cannot be opened — fall back to the environment below rather than
    // failing closed on an unrelated SKU.
  }
  const fromEnv = normalizeEdition(process.env.CLAWBOX_EDITION);
  return fromEnv ? { edition: fromEnv, defaulted: false } : { edition: "openclaw", defaulted: true };
}

/** True while the box has both harnesses and no chosen agent (the lock reads `unselected`). */
export function isEditionUnselected(): boolean {
  return readEditionSource().unselected === true;
}

/**
 * The edition the lock file names, read through the descriptor it was checked
 * on: opened once with O_NOFOLLOW (a symlink fails to open at all, ELOOP), then
 * `fstat` on that same open file supplies the mtime for the cache and the read
 * comes from it too. Statting the path and then reading the path again would
 * leave a gap in which the entry could be swapped for something else.
 *
 * Null when the lock is not a regular file or names no edition; throws when it
 * cannot be opened or read, which the caller treats the same as missing.
 */
function readEditionLock(): { edition: LockValue; hint: EditionHint | null } | null {
  const fd = fs.openSync(/* turbopackIgnore: true */ EDITION_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (cache && cache.mtimeMs === stat.mtimeMs) return { edition: cache.edition, hint: cache.hint };
    const raw = fs.readFileSync(fd, "utf-8");
    const edition = normalizeLockValue(parseEnvValue(raw, "CLAWBOX_EDITION"));
    if (!edition) return null;
    // The hint means something only before the choice; a locked box ignores it.
    const hint = edition === UNSELECTED_EDITION ? normalizeHint(parseEnvValue(raw, "CLAWBOX_EDITION_HINT")) : null;
    cache = { mtimeMs: stat.mtimeMs, edition, hint };
    return { edition, hint };
  } finally {
    fs.closeSync(fd);
  }
}

export function readEdition(): EditionName {
  return readEditionSource().edition;
}

/**
 * True when this device runs the Hermes harness — the `hermes` SKU (Hermes
 * only) and the premium `dual` SKU (both harnesses).
 *
 * Mirrors install.sh's `has_hermes_harness()`, and must keep mirroring it: the
 * updater uses this to decide whether to dispatch `install.sh --step
 * hermes_edition`, so a device where the two disagree would either skip its own
 * provisioning or run a step that immediately returns.
 *
 * Deliberately NOT the negation of `openclawIsAbsent()`: `dual` has both
 * harnesses, so "runs Hermes" and "has no OpenClaw" are different questions.
 */
export function hasHermesHarness(): boolean {
  const edition = readEdition();
  return edition === "hermes" || edition === "dual";
}
