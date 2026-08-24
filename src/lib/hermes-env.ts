// Reading and writing ~/.hermes/.env from ClawBox.
//
// WHY THIS EXISTS AT ALL
//
// The Telegram integration writes its credential with `hermes config set
// TELEGRAM_BOT_TOKEN <token>` and that lands in ~/.hermes/.env. It is tempting
// to assume every Hermes env var works the same way. It does not.
//
// `hermes config set` routes a key to .env only when the key has no dot AND is
// either in a short hardcoded allowlist (TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN,
// SLACK_*, …) or ends in _API_KEY / _TOKEN / _SECRET (hermes_cli/config.py
// `_is_env_config_key`, read on a v0.20.5 device). No WHATSAPP_* key qualifies:
// WHATSAPP_ENABLED and WHATSAPP_MODE are listed in `_EXTRA_ENV_KEYS`, so Hermes
// knows them, but they still fail that routing test and fall through to the
// config.yaml branch — a different file, read-modify-written by
// scripts/register-mcp.sh and the dashboard-auth script, and collected into
// support bundles by `hermes dump`.
//
// So for those keys ClawBox has to be its own .env writer. This module mirrors
// hermes_cli/config.py `save_env_value` / `load_env` deliberately, so a value
// ClawBox writes reads back identically through Hermes' own parser:
//
//   * key names must match ^[A-Za-z_][A-Za-z0-9_]*$
//   * CR and LF are stripped from the value — a newline would forge a second
//     assignment
//   * a line is recognised as defining KEY in BOTH the `KEY=` and the
//     bash-compatible `export KEY=` form. Missing the export form is how
//     upstream got duplicate lines that resurrected old values on delete
//   * values are quoted only when they contain #, a quote, or whitespace, with
//     backslash and double-quote escaped (`_quote_env_value`)
//   * write via temp + atomic rename, preserving the existing file mode (0600
//     on a ClawBox) rather than unconditionally re-chmod'ing
//
// KNOWN HAZARD, stated rather than hidden: upstream takes no lock on .env (only
// config.yaml has one). Two writers racing — this module and an interactive
// `hermes setup` — can lose one side's write. Writes here are serialised
// in-process; a concurrent interactive provisioning run is not something either
// side can detect.

import fs from "fs/promises";
import path from "path";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Hermes' data root. Matches HERMES_HOME resolution in the CLI. */
export function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes");
}

export function hermesEnvPath(): string {
  return path.join(hermesHome(), ".env");
}

/** Strip the bash `export ` prefix, if present. */
function stripExport(line: string): string {
  const trimmed = line.trim();
  return trimmed.startsWith("export ") ? trimmed.slice(7).replace(/^\s+/, "") : trimmed;
}

/** Hermes' `_env_line_defines_key`: plain or `export`-prefixed assignment. */
export function envLineDefinesKey(line: string, key: string): boolean {
  return stripExport(line).startsWith(`${key}=`);
}

/** Inverse of quoteEnvValue, matching how Hermes' load_env unquotes. */
export function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      // Only the double-quoted form carries backslash escapes.
      return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Hermes' `_quote_env_value`, character for character. */
export function quoteEnvValue(value: string): string {
  if (value === "") return value;
  const needsQuoting =
    value.includes("#") ||
    value.includes('"') ||
    value.includes("'") ||
    value !== value.trim() ||
    /\s/.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Apply assignments to .env text: replace in place where the key already
 * exists, append otherwise, and delete the line for a `null` value.
 *
 * Pure, so ordering, quoting and the export-line rules are unit-testable
 * without touching a filesystem.
 */
export function applyEnvValues(existing: string, values: Record<string, string | null>): string {
  const normalized = existing.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized === "" ? [] : normalized.split("\n");
  // split("\n") on a trailing newline leaves a final "" — drop it and restore
  // the trailing newline at the end, so repeated writes don't grow blank lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const [key, rawValue] of Object.entries(values)) {
    if (!ENV_VAR_NAME_RE.test(key)) throw new Error(`Invalid environment variable name: ${key}`);

    // EVERY definition, not just the first. A .env can define the same key
    // twice — hand-edited, or appended to by two tools — and parseHermesEnv
    // (like Hermes' own load_env) lets the LAST one win on read. Touching only
    // the first therefore produced writes that read back unchanged, and
    // deletes that resurrected the older value from the line below: the exact
    // failure the export-line handling above already exists to prevent, just
    // reached by a different route. Rewrite at the first position so key order
    // in the file is stable, and drop the shadowing duplicates.
    const indexes: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (envLineDefinesKey(lines[i], key)) indexes.push(i);
    }
    // Remove back to front so the earlier indexes stay valid.
    for (let i = indexes.length - 1; i >= 1; i -= 1) lines.splice(indexes[i], 1);
    const index = indexes.length > 0 ? indexes[0] : -1;

    if (rawValue === null) {
      if (index >= 0) lines.splice(index, 1);
      continue;
    }

    const value = rawValue.replace(/[\r\n]/g, "");
    const serialized = `${key}=${quoteEnvValue(value)}`;
    if (index >= 0) lines[index] = serialized;
    else lines.push(serialized);
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Parse ~/.hermes/.env into a plain object, the way Hermes' load_env does:
 * comments and blanks skipped, `export ` stripped, split on the FIRST `=` so a
 * value containing `=` survives.
 *
 * A missing file is not an error — it means "nothing configured yet". Anything
 * else IS an error and is rethrown: an unreadable .env (EACCES after a
 * root-owned write, EIO on a failing eMMC) used to be flattened into the same
 * empty object, so readHermesWhatsappStatus reported `not_configured` with an
 * empty allowlist and the panel told the owner his channel was simply not set
 * up. A real fault has to reach the caller, which answers 500 and logs it.
 */
export async function readHermesEnv(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(hermesEnvPath(), "utf-8");
  } catch (err) {
    // ENOENT: no .env, or no ~/.hermes to hold one. ENOTDIR: a component of
    // the path is a file, so there is no ~/.hermes directory either. Both mean
    // "nothing configured yet" — the ordinary state of a non-Hermes box.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw err;
  }
  return parseHermesEnv(raw);
}

/** The pure half of readHermesEnv, so parsing is testable without a file. */
export function parseHermesEnv(raw: string): Record<string, string> {
  // Tolerate a BOM — Hermes reads with utf-8-sig for the same reason.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = stripExport(rawLine);
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_VAR_NAME_RE.test(key)) continue;
    out[key] = parseEnvValue(line.slice(eq + 1));
  }
  return out;
}

/** Read a single key, or null when unset. */
export async function getHermesEnvValue(key: string): Promise<string | null> {
  const env = await readHermesEnv();
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : null;
}

// One writer at a time within this process. Two Settings saves landing together
// would otherwise read the same base text and the second would drop the first.
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Merge `values` into ~/.hermes/.env (a `null` value deletes the key). Creates
 * the file at 0600 when absent and preserves the existing mode otherwise.
 */
export async function setHermesEnvValues(values: Record<string, string | null>): Promise<void> {
  const run = async () => {
    const envPath = hermesEnvPath();
    await fs.mkdir(path.dirname(envPath), { recursive: true });

    let existing = "";
    let mode = 0o600;
    try {
      existing = await fs.readFile(envPath, "utf-8");
      const stat = await fs.stat(envPath);
      mode = stat.mode & 0o777;
    } catch {
      // No .env yet — create one at 0600.
    }
    if (existing.charCodeAt(0) === 0xfeff) existing = existing.slice(1);

    const next = applyEnvValues(existing, values);
    const tmp = `${envPath}.clawbox.tmp`;
    // writeFile's `mode` is ignored when the path already exists (a stale temp
    // from a crash would keep its old, possibly wider, permissions), so chmod
    // explicitly before the rename rather than trusting the create flag.
    await fs.writeFile(tmp, next, { mode, encoding: "utf-8" });
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; a failed chmod must not break the write
    }
    try {
      await fs.rename(tmp, envPath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };

  const queued = writeChain.then(run, run);
  // Keep the chain alive even when this write fails, or every later write would
  // inherit the rejection.
  writeChain = queued.catch(() => undefined);
  return queued;
}

/**
 * Drop every definition of each key from .env text. A thin spelling of
 * applyEnvValues' delete mode (a `null` value), kept as its own name because
 * the email settings clear a whole group of keys at once and read better for
 * it. Like applyEnvValues it removes EVERY line defining a key, not just the
 * first, so a duplicate cannot resurrect a cleared credential.
 */
export function removeEnvValues(existing: string, keys: string[]): string {
  return applyEnvValues(existing, Object.fromEntries(keys.map((key) => [key, null])));
}

/** Delete `keys` from ~/.hermes/.env, sharing the single-writer chain. */
export async function clearHermesEnvValues(keys: string[]): Promise<void> {
  return setHermesEnvValues(Object.fromEntries(keys.map((key) => [key, null])));
}
