// TASK-452 — somewhere to actually PUT the API key a skill asks for.
//
// The store already knows: `/skills/inspect` returns each declared secret's
// label, its environment-variable name and the provider page that issues it,
// and SkillDetail renders all three. What it never had was an input. A customer
// who installed `official/security/1password` was told the skill needs
// `OP_SERVICE_ACCOUNT_TOKEN`, given a link to go and create one, and then left
// with nowhere on the device to type it — the skill silently does nothing.
//
// Hermes reads process environment from ~/.hermes/.env; that is where
// `hermes config set TELEGRAM_BOT_TOKEN` puts the Telegram token
// (src/lib/hermes-telegram.ts is the working precedent for the same idea). This
// module writes that file directly rather than through the CLI, because
// `hermes config set` routes only its OWN allowlisted keys to .env — an
// arbitrary skill's variable name is not on that list and would land in
// config.yaml, where nothing would ever read it as an environment variable.
//
// Rules that make a direct write safe:
//   * the KEY must look like an environment variable and nothing else, so a
//     value can never smuggle in a second assignment or a shell fragment;
//   * the VALUE may not contain a newline, so one secret is always one line;
//   * the file is rewritten whole from a parsed map, so a malformed pre-existing
//     line cannot be duplicated or half-edited;
//   * it is written 0600 through a temp file + rename, so a reader never sees a
//     half-written secrets file and no other account can read it;
//   * values are NEVER read back out to the browser — only whether a key is set.

import fs from 'fs/promises';
import path from 'path';

const HERMES_HOME =
  process.env.HERMES_HOME || path.join(process.env.HOME || '/home/clawbox', '.hermes');

export const HERMES_ENV_PATH = path.join(HERMES_HOME, '.env');

// The shape every declared skill secret uses (OP_SERVICE_ACCOUNT_TOKEN,
// BRAVE_API_KEY, …). Deliberately upper-snake only: a lowercase or dotted name
// is a config key, not an env var, and belongs in a different store.
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function isValidEnvKey(key: string): boolean {
  return typeof key === 'string' && ENV_KEY_RE.test(key);
}

const MAX_VALUE_LEN = 4096;

export function isValidEnvValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > MAX_VALUE_LEN) return false;
  // A newline would end the assignment and start a new one.
  return !/[\r\n\u0000]/.test(value);
}

const MAX_ENV_BYTES = 256 * 1024;

/**
 * Parse ~/.hermes/.env into a map, preserving nothing but the assignments.
 * Comments and blank lines are dropped on purpose: this file is a secret store
 * written by tooling, and round-tripping arbitrary text through a rewrite is
 * how half-edited files happen.
 */
export async function readHermesEnv(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let raw: string;
  try {
    const st = await fs.stat(HERMES_ENV_PATH);
    if (!st.isFile() || st.size > MAX_ENV_BYTES) return out;
    raw = await fs.readFile(HERMES_ENV_PATH, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!isValidEnvKey(key)) continue;
    out.set(key, unquote(trimmed.slice(eq + 1).trim()));
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1);
  }
  return value;
}

// Quote only when the raw form would be ambiguous. An unquoted token is what
// every existing hand-written .env on these devices looks like, and keeping the
// common case unquoted means a support engineer reading the file sees what they
// expect.
function quote(value: string): string {
  if (value === '') return '""';
  if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) return value;
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

function serialize(env: Map<string, string>): string {
  const lines = ['# Managed by ClawBox. One KEY=value per line.'];
  for (const key of Array.from(env.keys()).sort()) {
    lines.push(`${key}=${quote(env.get(key) as string)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function writeHermesEnv(env: Map<string, string>): Promise<void> {
  await fs.mkdir(HERMES_HOME, { recursive: true });
  const tmp = `${HERMES_ENV_PATH}.tmp-${process.pid}`;
  await fs.writeFile(tmp, serialize(env), { mode: 0o600 });
  await fs.rename(tmp, HERMES_ENV_PATH);
  // rename preserves the temp file's mode, but an .env that predates this code
  // may be 0644; make the final state explicit either way.
  await fs.chmod(HERMES_ENV_PATH, 0o600).catch(() => {});
}

/** Set one skill secret. Returns false when the key or value is not acceptable. */
export async function setHermesSecret(key: string, value: string): Promise<boolean> {
  if (!isValidEnvKey(key) || !isValidEnvValue(value)) return false;
  const env = await readHermesEnv();
  env.set(key, value);
  await writeHermesEnv(env);
  return true;
}

/** Clear one skill secret. Returns true when it existed and is now gone. */
export async function clearHermesSecret(key: string): Promise<boolean> {
  if (!isValidEnvKey(key)) return false;
  const env = await readHermesEnv();
  if (!env.delete(key)) return false;
  await writeHermesEnv(env);
  return true;
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
