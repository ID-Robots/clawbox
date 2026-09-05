// Read-merge-write for ~/.hermes/config.yaml.
//
// WHY CLAWBOX WRITES THIS FILE ITSELF
//
// `hermes config set k v` re-serialises the whole config from its parsed tree.
// Everything that is not data — the "── Security ──" and "── Fallback Model ──"
// blocks Hermes itself ships, which are the only in-product documentation for
// secret redaction, tirith pre-exec scanning and provider failover — is dropped
// on the first call. Live on a QA box: 3175 bytes / 36 comment lines before,
// 1505 / 0 after ONE "save local model" in the ClawBox UI, and 1325 after the
// matching disable. The customer never ran a CLI command; they clicked a
// toggle.
//
// So: read the file, patch the handful of keys the product owns, write the rest
// back byte for byte (see yaml-block-edit.ts, which does the splicing), and keep
// the previous revision at config.yaml.bak. This is the same "ClawBox is its own
// writer for a Hermes file" arrangement hermes-env.ts already has for ~/.hermes/.env,
// and for the same reason: the CLI's own semantics are wrong for us.
//
// SAFETY RAILS
//
//   * every patch is verified by reading the keys back out of the patched text
//     before anything is written;
//   * a file shape the line editor does not understand (flow style, block
//     scalars, a sequence where we expect a mapping, duplicate or quoted keys)
//     falls back to `hermes config set` — comments lost, config intact, which is
//     the right way round;
//   * writes are atomic (temp file + rename in the same directory) and preserve
//     the existing mode, which is 0600 on a ClawBox;
//   * writes are serialised in-process.
//
// KNOWN HAZARD, stated rather than hidden: Hermes takes a lock on config.yaml
// and this module cannot participate in it (it is a Python `filelock`, i.e. a
// flock, which Node cannot take without a native module). A ClawBox write racing
// an interactive `hermes config set` in a shell can lose one side's change. The
// .bak is the recovery path. Every ClawBox write is a single rename, so a reader
// never sees a partial file.

import fs from "fs/promises";
import path from "path";

import { runHermesCli } from "@/lib/hermes-cli";
import { safeHermesFailureMessage } from "@/lib/hermes-cli-message";
import { invalidateHermesConfigCache } from "@/lib/hermes-config-cache";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { hermesHome } from "@/lib/hermes-env";
import { getTopLevelScalar, getYamlPath, setYamlPath, unsetYamlPath, YamlEditUnsupported } from "@/lib/yaml-block-edit";

export class HermesConfigWriteError extends Error {}

export interface HermesConfigPatch {
  /** Dotted key → scalar value. */
  set?: Record<string, string>;
  /** Dotted keys to remove, pruning any parent they empty. */
  unset?: string[];
}

export interface HermesConfigPatchResult {
  /** "merge" kept the comments; "cli" is the fallback that does not. */
  mode: "merge" | "cli";
  /** Path of the previous revision, when one was kept. */
  backupPath: string | null;
  /** Why the merge path was declined, for the log. */
  fallbackReason?: string;
}

export function hermesConfigPath(): string {
  return path.join(hermesHome(), "config.yaml");
}

const CONFIG_MODE = 0o600;

/** Serialises this process's writes; see the header note on the cross-process case. */
let writeChain: Promise<unknown> = Promise.resolve();

function splitKey(key: string): string[] {
  return key.split(".");
}

async function readConfigText(file: string): Promise<{ text: string; mode: number; existed: boolean }> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf-8"), fs.stat(file)]);
    return { text, mode: stat.mode & 0o777, existed: true };
  } catch (err) {
    // ENOENT: no config.yaml. ENOTDIR: a component of the path is a file, so
    // there is no ~/.hermes directory to hold one either. Both mean "nothing
    // configured yet" — and both have to be forgiven HERE, because readHermesEnv
    // already forgives them: a ~/.hermes that is a regular file otherwise left
    // the .env half of the reader saying `known: true` and this half saying
    // `known: false`, which is a permanent 503 on every approvals-bot save over
    // a path that holds nothing at all.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { text: "", mode: CONFIG_MODE, existed: false };
    }
    throw err;
  }
}

/** Apply the patch to `text`, then prove it reads back. */
function patchText(text: string, patch: HermesConfigPatch): string {
  let next = text;
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    next = setYamlPath(next, splitKey(key), value);
  }
  for (const key of patch.unset ?? []) {
    next = unsetYamlPath(next, splitKey(key));
  }

  for (const [key, value] of Object.entries(patch.set ?? {})) {
    const readBack = getYamlPath(next, splitKey(key));
    if (readBack !== value) {
      throw new YamlEditUnsupported(`verification failed for ${key}: read back ${JSON.stringify(readBack)}`);
    }
  }
  for (const key of patch.unset ?? []) {
    if (getYamlPath(next, splitKey(key)) !== null) {
      throw new YamlEditUnsupported(`verification failed unsetting ${key}`);
    }
  }
  return next;
}

async function writeAtomically(file: string, text: string, mode: number, keepBackup: string | null): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (keepBackup !== null) {
    // Written before the rename so a crash mid-write still leaves the previous
    // revision on disk under a name a human can find.
    await fs.writeFile(`${file}.bak`, keepBackup, { mode });
  }
  const tmp = `${file}.clawbox-tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, text, { mode });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function applyViaCli(patch: HermesConfigPatch): Promise<void> {
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    const r = await runHermesCli(["config", "set", key, value], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      // `HermesConfigWriteError` is re-wrapped by hermes-local-ai as
      // `HermesLocalApplyError` and returned to the browser as `{ error }`, so
      // this string is a save banner. A raw `hermes config set` stderr is
      // Python: a traceback here names /home/clawbox/.hermes on the customer's
      // screen. Same parser as every other `hermes` surface; raw goes to the
      // journal.
      console.error("[hermes-config-yaml] config set exit", r.code, r.stderr);
      throw new HermesConfigWriteError(
        safeHermesFailureMessage(r.stdout, r.stderr) || `Failed to set ${key} in the Hermes config`,
      );
    }
  }
  for (const key of patch.unset ?? []) {
    // `unset` on an absent key is a no-op, so a partial registration cleans up
    // as happily as a complete one.
    await runHermesCli(["config", "unset", key], { timeoutMs: 15_000 });
  }
}

/**
 * Patch the keys ClawBox owns, preserving everything else in the file.
 *
 * Throws {@link HermesConfigWriteError} only when the CLI fallback also fails —
 * an unreadable/unwritable config is a real failure the caller must surface.
 */
export async function patchHermesConfig(patch: HermesConfigPatch): Promise<HermesConfigPatchResult> {
  const run = async (): Promise<HermesConfigPatchResult> => {
    const file = hermesConfigPath();
    let fallbackReason: string | undefined;

    try {
      const { text, mode, existed } = await readConfigText(file);
      const next = patchText(text, patch);
      if (next !== text) {
        await writeAtomically(file, next, existed ? mode : CONFIG_MODE, existed ? text : null);
      }
      invalidateHermesConfigCache();
      return { mode: "merge", backupPath: existed && next !== text ? `${file}.bak` : null };
    } catch (err) {
      if (!(err instanceof YamlEditUnsupported)) {
        // A read or write error is not something the CLI would do better at —
        // it writes the same file, as the same user.
        //
        // And it is the COMMON leak on this path, not the rare one: the CLI
        // fallback below runs only for a file the merge cannot parse, while
        // every EACCES on config.yaml lands here, and Node writes the path into
        // the message it hands over —
        //
        //   EACCES: permission denied, open '/home/clawbox/.hermes/config.yaml'
        //
        // — which then became the save banner verbatim. `sanitizeErrorMessage`
        // is the repo's whitelist-by-shape; null from it means "say something
        // generic", never "say nothing", so the fixed sentence stands in.
        console.error("[hermes-config-yaml] merge write failed", err);
        throw new HermesConfigWriteError(
          sanitizeErrorMessage(err instanceof Error ? err.message : "")
            || "Failed to update the Hermes config",
        );
      }
      fallbackReason = err.message;
      console.warn(`[hermes-config-yaml] falling back to \`hermes config set\` (${fallbackReason})`);
    }

    await applyViaCli(patch);
    invalidateHermesConfigCache();
    return { mode: "cli", backupPath: null, fallbackReason };
  };

  const result = writeChain.then(run, run);
  // Keep the chain alive whatever this call does, so one failure does not
  // wedge every later write.
  writeChain = result.catch(() => {});
  return result;
}

/**
 * Read a TOP-LEVEL scalar, saying whether we could look at all.
 *
 * A missing config.yaml is not a failure — `readConfigText` answers `""` for
 * ENOENT, which is a box that has never been configured. Anything else (EACCES
 * after a root-run `hermes config set`, EIO, a directory at the path) is, and a
 * caller deciding whether a credential collides has to be able to tell the two
 * apart: see telegram-bot-identity.ts, where "we could not find out" is the
 * only answer allowed to make a save gate refuse.
 *
 * `known: false` therefore means "we could not look" — the file did not open,
 * or the key is there carrying a value this reader cannot name. Reading the
 * value goes through {@link getTopLevelScalar}, which answers from the column-0
 * lines alone rather than parsing the document, so a shape the line editor does
 * not model somewhere ELSE in the file cannot turn into a refusal here: only
 * this key's own value can.
 */
export async function readHermesConfigTopLevelScalar(
  key: string,
): Promise<{ value: string | null; known: boolean }> {
  try {
    const { text } = await readConfigText(hermesConfigPath());
    // `readable` carries the third state out: a key defined with a value this
    // reader cannot resolve is a credential the bridge still exports, so it is
    // "we could not look", never "there is no bot".
    const scalar = getTopLevelScalar(text, key);
    return { value: scalar.value, known: scalar.readable };
  } catch (err) {
    // The message only — this file holds credentials, and Node puts the failing
    // path into the error it hands over.
    console.error(
      "[hermes-config-yaml] config.yaml could not be read:",
      err instanceof Error ? err.message : err,
    );
    return { value: null, known: false };
  }
}

/** Read one dotted key straight from the file. Returns null when unset. */
export async function readHermesConfigValue(key: string): Promise<string | null> {
  try {
    const { text } = await readConfigText(hermesConfigPath());
    return getYamlPath(text, splitKey(key));
  } catch {
    return null;
  }
}
