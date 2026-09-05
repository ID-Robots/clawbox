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
//   * writes are atomic (temp file + rename in the same directory) and
//     RE-SECURE the file to 0600 — the temp, the `.bak` and, through the
//     rename, config.yaml itself — rather than preserving the mode it happens
//     to have, because nothing on the device narrows this file and the umask
//     that created it on some boxes did not (see `writeAtomically`);
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

async function readConfigText(file: string): Promise<{ text: string; existed: boolean }> {
  try {
    const text = await fs.readFile(file, "utf-8");
    return { text, existed: true };
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
      return { text: "", existed: false };
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

/**
 * `writeFile`'s `mode` is honoured only when it CREATES the file, and both
 * paths here can already exist — `.bak` is a stable name rewritten on every
 * merge write, and the temp carries this process's pid, which is reused after a
 * restart. Whatever mode either picked up first (an older build, a root run, a
 * different umask) would otherwise stick, on a full copy of config.yaml and on
 * the file that becomes it: this is where `TELEGRAM_BOT_TOKEN` and the provider
 * api_keys live on the Hermes edition. Best-effort, like every other chmod
 * here: a failed one must not turn a working save into an error.
 */
async function chmodBestEffort(file: string, mode: number): Promise<void> {
  await fs.chmod(file, mode).catch(() => {});
}

/**
 * `CONFIG_MODE` unconditionally, never the mode config.yaml happens to have —
 * the same doctrine `writeSecretJsonAtomically` applies to `openclaw.json`, and
 * for the same reason on the twin file.
 *
 * `~/.hermes/config.yaml` holds `TELEGRAM_BOT_TOKEN` and the provider
 * `api_key`s, nothing on the device narrows it (no writer in `install.sh`,
 * `install-x64.sh`, `scripts/` or `src/` chmods it), and Hermes' own installer
 * creates it under the service user's umask — so a box sitting at 0644 or 0664
 * keeps its credentials readable by every account on the device for ever.
 * Preserving the mode would make that box the one this fix never reaches, and
 * would give it a same-width `.bak` — a full copy of the credential file at a
 * stable path — on every merge write besides. The rename is what repairs the
 * file itself: it swaps in an inode this function created at 0600.
 *
 * A deliberate 0640 is narrowed too. That is the accepted cost on both twins:
 * there is no way to tell a mode an owner chose from one an umask left, and on
 * a single-owner appliance the credential file has no second reader to serve.
 */
async function writeAtomically(file: string, text: string, keepBackup: string | null): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (keepBackup !== null) {
    // Written before the rename so a crash mid-write still leaves the previous
    // revision on disk under a name a human can find — and REMOVED first, like
    // the temp below and for the same reason: `writeFile`'s `mode` is ignored
    // for a file that already exists, so a `.bak` an older build left at 0644
    // would hold this fresh copy of the credential file at that mode until the
    // chmod landed, and keep it there if the chmod failed.
    await fs.rm(`${file}.bak`, { force: true }).catch(() => {});
    await fs.writeFile(`${file}.bak`, keepBackup, { mode: CONFIG_MODE });
    await chmodBestEffort(`${file}.bak`, CONFIG_MODE);
  }
  const tmp = `${file}.clawbox-tmp-${process.pid}`;
  try {
    // A stale temp is removed rather than truncated, so its old mode cannot
    // hold the credential file for the length of the write or ride the rename.
    await fs.rm(tmp, { force: true });
    await fs.writeFile(tmp, text, { mode: CONFIG_MODE });
    await chmodBestEffort(tmp, CONFIG_MODE);
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
      const { text, existed } = await readConfigText(file);
      const next = patchText(text, patch);
      if (next !== text) {
        await writeAtomically(file, next, existed ? text : null);
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
 * the key is there carrying a value this reader cannot name, or the document is
 * one PyYAML REFUSES to load. Reading the value goes through
 * {@link getTopLevelScalar}, which answers from the column-0 lines alone rather
 * than parsing the document, so a shape the line editor does not model
 * elsewhere in the file (a sequence, a duplicate key, a nested block) is not a
 * refusal here — none of those is evidence about this key. A document PyYAML
 * will not load is the one exception, and it is not an exception to the
 * principle: Hermes' env bridge loads config.yaml with PyYAML, so when PyYAML
 * raises the bridge exports NOTHING and no line in the file is evidence about
 * the bot this box polls, this key's own included.
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
  } catch (err) {
    // `null` means "unset" to every caller (hermes-local-ai reads it as "this
    // leaf is not a scalar" and as "not applied yet"), and this signature has
    // no third state to give them. A value we could not RESOLVE is a different
    // fact, so it is at least said out loud rather than passing silently for a
    // key nobody set.
    if (err instanceof YamlEditUnsupported) {
      console.error(`[hermes-config-yaml] ${key} could not be resolved, reading as unset:`, err.message);
    }
    return null;
  }
}
