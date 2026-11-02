/**
 * The copies of a credential a harness keeps BESIDE its live config, for the
 * provider sign-out (src/lib/provider-sign-out.ts).
 *
 * Both harnesses keep rotating whole-file copies of the config that holds the
 * keys, and a sign-out that only edits the live file leaves the key in them:
 *
 *  - OpenClaw: `openclaw.json.bak`, `.bak.1` … (one per config write, so the
 *    sign-out's own `config unset`s fill them with the states in between) and
 *    `openclaw.json.last-good`, which the gateway ROLLS BACK TO when a later
 *    config does not validate — a signed-out key coming back on its own.
 *  - Hermes: `backups/config/config.yaml.good.<stamp>` (its last good parses)
 *    and ClawBox's own `config.yaml.bak` (src/lib/hermes-config-yaml.ts).
 *
 * The value is what is removed, never the file: each copy stays a valid file
 * of its kind (`"apiKey": ""` in JSON, `api_key: ` — null — in YAML), so a
 * roll-back to it still starts, signed out. Only a value of a plain key shape
 * is handled ({@link isScrubbableSecret}): one with a quote, a backslash or a
 * space could be written escaped, and a text replace over it could miss or
 * break the file.
 *
 * SERVER ONLY.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Long enough that a match is the key and not a word, and nothing a replace could break. */
const SCRUBBABLE = /^[A-Za-z0-9._~+/=-]{8,512}$/;

export function isScrubbableSecret(value: unknown): value is string {
  return typeof value === "string" && SCRUBBABLE.test(value);
}

/**
 * The files in `dir` whose NAME `pattern` matches — the harness's own backup
 * names, never a listing of anything else. A folder that is not there holds
 * none; one that cannot be listed is reported, so the read-back can say it
 * could not check.
 */
export async function listCopies(dir: string, pattern: RegExp): Promise<{ files: string[]; unlisted: boolean }> {
  try {
    const names = await fs.readdir(dir);
    return { files: names.filter((name) => pattern.test(name)).sort().map((name) => path.join(dir, name)), unlisted: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { files: [], unlisted: false };
    return { files: [], unlisted: true };
  }
}

/**
 * Take every one of `secrets` out of each file that holds it, in place:
 * written beside it at 0600 and renamed over it, like every credential file
 * on the box. Never throws; a file it could not rewrite is the read-back's to
 * report.
 */
export async function scrubCopies(files: readonly string[], secrets: readonly string[]): Promise<void> {
  const wanted = secrets.filter(isScrubbableSecret);
  if (wanted.length === 0) return;
  for (const file of files) {
    try {
      const text = await fs.readFile(file, "utf8");
      let next = text;
      for (const secret of wanted) next = next.split(secret).join("");
      if (next === text) continue;
      const tmp = `${file}.clawbox-scrub-${process.pid}`;
      await fs.rm(tmp, { force: true });
      await fs.writeFile(tmp, next, { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn(`[provider-sign-out] could not clear a key from ${path.basename(file)}:`, err instanceof Error ? (err as NodeJS.ErrnoException).code ?? "error" : err);
    }
  }
}

/** Which of `files` still hold one of `secrets`, and which could not be read to say. */
export async function copiesHolding(
  files: readonly string[],
  secrets: readonly string[],
): Promise<{ holding: string[]; unreadable: string[] }> {
  const wanted = secrets.filter(isScrubbableSecret);
  const holding: string[] = [];
  const unreadable: string[] = [];
  if (wanted.length === 0) return { holding, unreadable };
  for (const file of files) {
    try {
      const text = await fs.readFile(file, "utf8");
      if (wanted.some((secret) => text.includes(secret))) holding.push(file);
    } catch (err) {
      // Rotated away between the listing and the read: nothing left to hold.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable.push(file);
    }
  }
  return { holding, unreadable };
}
