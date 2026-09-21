// TASK-452 — somewhere to actually PUT the API key a skill asks for.
//
// The store already knows: `/skills/inspect` returns each declared secret's
// label, its environment-variable name and the provider page that issues it,
// and SkillDetail renders all three. What it never had was an input. A customer
// who installed `official/security/1password` was told the skill needs
// `OP_SERVICE_ACCOUNT_TOKEN`, given a link to go and create one, and then left
// with nowhere on the device to type it — the skill silently does nothing.
//
// ── What this module is, and what it is NOT ─────────────────────────────────
//
// It is the skill store's ALPHABET for a secret, and nothing else. The bytes go
// to ~/.hermes/.env through `hermes-env.ts`, which is the device's one writer
// for that file — the same one the email, WhatsApp, Discord and ClawAI settings
// use. That matters for a reason a real device proved:
//
// The first cut of this module was its own reader and writer. It parsed the
// file into a map and wrote the map back out, on the premise that ~/.hermes/.env
// is a secret store ClawBox owns. It is not: the installer creates it from
// Hermes' own 504-line template and `hermes config env-path` points customers at
// it. Saving ONE skill API key took the file from 24792 bytes to 372 — every
// live value survived, and all 116 of its commented-out key hints did not.
// `applyEnvValues` had been merge-writing that file correctly the whole time;
// the fork simply did not use it. A second writer also meant a second
// read-modify-write cycle outside `hermes-env.ts`'s single-writer chain, so a
// skill-secret save landing beside a Settings save could silently drop one.
//
// So: the rules below decide what a skill secret may look like, and
// `setHermesEnvValues` decides what happens to the file.

import {
  HermesEnvUnreadableError,
  clearHermesEnvValues,
  hermesEnvPath,
  readHermesEnv as readHermesEnvRecord,
  setHermesEnvValues,
} from '@/lib/hermes-env';
import fs from 'fs/promises';

export { HermesEnvUnreadableError } from '@/lib/hermes-env';

// The shape every declared skill secret uses (OP_SERVICE_ACCOUNT_TOKEN,
// BRAVE_API_KEY, …). Deliberately upper-snake only, and stricter than the
// `^[A-Za-z_][A-Za-z0-9_]*$` the .env writer itself accepts: a lowercase or
// dotted name is a config key, not an env var, and belongs in a different
// store.
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function isValidEnvKey(key: string): boolean {
  return typeof key === 'string' && ENV_KEY_RE.test(key);
}

// A secret is a credential some provider issued: an API key, a token, a service
// account string. Every one of those is printable ASCII on a single line.
//
// This is an allowlist of the whole accepted alphabet rather than a blacklist
// of the three characters that were known to hurt, and the difference matters
// twice over. A newline still cannot end the assignment and start a second one,
// but neither can any other C0 control byte reach a file that support engineers
// read with `cat` — an escape sequence inside a value can rewrite what their
// terminal shows them. Anchored end to end: a value is accepted whole or not at
// all, and the 4096-character cap is part of the same expression rather than
// a second check that could drift away from it.
const ENV_VALUE_RE = /^[\x20-\x7E]{1,4096}$/;

export function isValidEnvValue(value: string): boolean {
  return typeof value === 'string' && ENV_VALUE_RE.test(value);
}

/**
 * Every live assignment in ~/.hermes/.env, for lookup only.
 *
 * An ABSENT file is an empty map — that is a box with nothing configured yet,
 * and the shared reader already answers it that way. Anything else is a fault
 * and is raised, because "no keys are set" is the wrong answer twice over: it
 * has the customer retype a credential into a file nothing could read, and it
 * makes `clearHermesSecret` report a key as already gone when it never looked.
 */
export async function readHermesEnv(): Promise<Map<string, string>> {
  try {
    return new Map(Object.entries(await readHermesEnvRecord()));
  } catch (err) {
    throw err instanceof HermesEnvUnreadableError ? err : new HermesEnvUnreadableError('unreadable');
  }
}

/**
 * Set one skill secret, leaving the rest of ~/.hermes/.env alone.
 *
 * Returns false when the key or value is not acceptable. Throws
 * HermesEnvUnreadableError when the existing file cannot be read — the caller
 * must report that as a failure, never as a save.
 */
export async function setHermesSecret(key: string, value: string): Promise<boolean> {
  // Both alphabets are re-tested here, against the same anchored expressions
  // the exported predicates use, rather than being delegated to them. This is
  // the function that decides what may end up in the file, so the check belongs
  // on this line: a future caller that forgets to pre-validate, or a predicate
  // that grows a special case, cannot widen what reaches ~/.hermes/.env without
  // editing the write path itself.
  if (!ENV_KEY_RE.test(key) || !ENV_VALUE_RE.test(value)) return false;
  await setHermesEnvValues({ [key]: value });
  await tightenEnvMode();
  return true;
}

/** Clear one skill secret. Returns true when it existed and is now gone. */
export async function clearHermesSecret(key: string): Promise<boolean> {
  if (!isValidEnvKey(key)) return false;
  if (!(await readHermesEnv()).has(key)) return false;
  await clearHermesEnvValues([key]);
  return true;
}

/**
 * Never widen, but do narrow. `setHermesEnvValues` preserves whatever mode the
 * file already had, deliberately — it mirrors Hermes' own writer. That is the
 * right default for a settings file and the wrong one for the moment a
 * credential is first written into it: the installer's template arrives 0644 on
 * some boxes, and a world-readable file holding an API key is worth quietly
 * fixing. Best-effort: a failure here must not turn a stored key into an error.
 */
async function tightenEnvMode(): Promise<void> {
  const envPath = hermesEnvPath();
  try {
    const mode = (await fs.stat(envPath)).mode & 0o777;
    if (mode & 0o077) await fs.chmod(envPath, mode & 0o700);
  } catch {
    // The write succeeded; the permissions are a hardening, not the result.
  }
}

/**
 * Which of the asked-for keys are set — the ONLY thing this store ever tells
 * the browser about a secret. A value that has been stored is write-only from
 * the UI's point of view; there is no read path and no "reveal" affordance,
 * because nothing in the product needs one.
 */
export async function hermesSecretsPresent(keys: string[]): Promise<Record<string, boolean>> {
  const env = await readHermesEnv();
  const out: Record<string, boolean> = {};
  for (const key of keys.slice(0, 24)) {
    if (!isValidEnvKey(key)) continue;
    out[key] = (env.get(key) || '').length > 0;
  }
  return out;
}
