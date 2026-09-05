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

export type EditionName = "openclaw" | "hermes" | "dual";

// Overridable for tests only; production always reads the root-owned path.
// Redirecting it is not an edition-lock bypass: no request data flows into it,
// and "dual" additionally has to clear verifyDualLicense() against a key constant
// that is deliberately not env-overridable (see edition-license.ts) — so a
// redirected path can change the edition LABEL, never unlock the premium switcher.
const EDITION_FILE = process.env.CLAWBOX_EDITION_FILE || "/etc/clawbox/edition.env";

let cache: { mtimeMs: number; edition: EditionName } | null = null;

function normalizeEdition(raw: string | null | undefined): EditionName | null {
  const value = (raw || "").trim().toLowerCase();
  if (value === "openclaw" || value === "hermes" || value === "dual") return value;
  return null;
}

// Minimal systemd EnvironmentFile parser: `KEY=value`, optional `export`,
// optional surrounding quotes. Anything else in the file is ignored.
function parseEditionEnvFile(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?CLAWBOX_EDITION\s*=\s*(.*)$/.exec(line);
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
}

/**
 * The edition this device was installed as. Root-owned file first, environment
 * second, "openclaw" (the native, non-premium SKU) as the safe default.
 *
 * Cached by mtime — this is called per request from middleware, and the file
 * only changes when the installer re-bakes the lock.
 */
export function readEditionSource(): EditionSource {
  try {
    const stat = fs.statSync(EDITION_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs) return { edition: cache.edition, defaulted: false };
    const parsed = normalizeEdition(parseEditionEnvFile(fs.readFileSync(EDITION_FILE, "utf-8")));
    if (parsed) {
      cache = { mtimeMs: stat.mtimeMs, edition: parsed };
      return { edition: parsed, defaulted: false };
    }
  } catch {
    // No /etc/clawbox/edition.env (dev box, CI, pre-3.x install) — fall back to
    // the environment below rather than failing closed on an unrelated SKU.
  }
  const fromEnv = normalizeEdition(process.env.CLAWBOX_EDITION);
  return fromEnv ? { edition: fromEnv, defaulted: false } : { edition: "openclaw", defaulted: true };
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
