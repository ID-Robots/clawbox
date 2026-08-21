// Writing ~/.hermes/.env ourselves — and why that is not laziness.
//
// `hermes config set KEY VALUE` is the documented, supported writer, and it is
// what src/lib/hermes-telegram.ts uses for TELEGRAM_BOT_TOKEN. But the CLI
// routes a key to .env only when it is in a hardcoded list or ends in
// _API_KEY / _TOKEN / _SECRET (hermes_cli/config.py `_is_env_config_key`,
// read on a v0.20.5 device). NO EMAIL_* key qualifies. `hermes config set
// EMAIL_PASSWORD …` therefore falls through to the config.yaml branch and
// writes a mailbox password as a plaintext top-level YAML scalar — into the
// same file scripts/register-mcp.sh and the dashboard-auth script
// read-modify-write, and that `hermes dump` collects into support bundles.
//
// So ClawBox writes .env directly, reproducing Hermes' own save_env_value
// semantics exactly (hermes_cli/config.py:4172-4265):
//   * reject an invalid variable name;
//   * strip CR/LF from the value (a newline would forge a second assignment);
//   * quote only when dotenv would otherwise misread the value, escaping
//     backslash and double-quote — the same _quote_env_value rules, because
//     Hermes reads this file with python-dotenv;
//   * match BOTH `KEY=` and `export KEY=` when replacing, so a later removal
//     cannot resurrect a stale exported value;
//   * write a temp file and rename over the target, preserving the existing
//     file mode (0600 on a ClawBox) rather than widening it.
//
// KNOWN HAZARD, stated rather than hidden: upstream takes no lock on .env
// (only config.yaml has one). Two writers racing — this module and an
// interactive `hermes setup` — can lose one side's write. Writes here are
// serialized in-process; a concurrent interactive provisioning run is not
// something either side can detect.

import fs from "fs/promises";
import path from "path";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes");
}

export function hermesEnvPath(): string {
  return path.join(hermesHome(), ".env");
}

/** Hermes' _quote_env_value, character for character. */
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

/** Hermes' _env_line_defines_key: plain or `export`-prefixed assignment. */
export function envLineDefinesKey(line: string, key: string): boolean {
  let stripped = line.trim();
  if (stripped.startsWith("export ")) stripped = stripped.slice(7).replace(/^\s+/, "");
  return stripped.startsWith(`${key}=`);
}

/**
 * Apply a set of KEY=VALUE assignments to the .env text, replacing in place
 * where the key already exists and appending otherwise. Pure, so the ordering
 * and quoting rules are unit-testable without touching a filesystem.
 */
export function applyEnvValues(existing: string, values: Record<string, string>): string {
  const lines = existing === "" ? [] : existing.split("\n");
  // split("\n") on a trailing newline leaves a final "" — drop it and restore
  // the trailing newline at the end, so repeated writes don't grow blank lines.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();

  for (const [key, rawValue] of Object.entries(values)) {
    if (!ENV_VAR_NAME_RE.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const value = rawValue.replace(/[\r\n]/g, "");
    const serialized = `${key}=${quoteEnvValue(value)}`;
    const index = lines.findIndex((line) => envLineDefinesKey(line, key));
    if (index >= 0) lines[index] = serialized;
    else lines.push(serialized);
  }

  return `${lines.join("\n")}\n`;
}

/** Drop every assignment of the given keys (plain or `export`-prefixed). */
export function removeEnvValues(existing: string, keys: string[]): string {
  const lines = existing === "" ? [] : existing.split("\n");
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();
  const kept = lines.filter((line) => !keys.some((key) => envLineDefinesKey(line, key)));
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

// One writer at a time within this process. Two Settings saves landing together
// would otherwise read the same base text and the second would drop the first.
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Merge `values` into ~/.hermes/.env. Creates the file at 0600 when absent and
 * preserves the existing mode otherwise.
 */
export async function setHermesEnvValues(values: Record<string, string>): Promise<void> {
  return mutateEnv((existing) => applyEnvValues(existing, values));
}

/** Delete the given keys from ~/.hermes/.env, if present. */
export async function clearHermesEnvValues(keys: string[]): Promise<void> {
  return mutateEnv((existing) => removeEnvValues(existing, keys));
}

function mutateEnv(transform: (existing: string) => string): Promise<void> {
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

    const next = transform(existing);
    const tmp = `${envPath}.clawbox.tmp`;
    // mode on writeFile is ignored when the path already exists, so chmod after.
    await fs.writeFile(tmp, next, { mode, encoding: "utf-8" });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, envPath);
  };

  const queued = writeChain.then(run, run);
  // Keep the chain alive even when this write fails, or every later write
  // would inherit the rejection.
  writeChain = queued.catch(() => undefined);
  return queued;
}

/** Read the raw (unquoted) value of one key, or null. For status checks only. */
export async function getHermesEnvValue(key: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(hermesEnvPath(), "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!envLineDefinesKey(line, key)) continue;
    let stripped = line.trim();
    if (stripped.startsWith("export ")) stripped = stripped.slice(7).replace(/^\s+/, "");
    const value = stripped.slice(key.length + 1);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1);
    }
    return value;
  }
  return null;
}
