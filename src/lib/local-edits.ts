/**
 * Save the checkout's local edits before the updater resets them away.
 *
 * The in-app update ends its hard-sync with `git reset --hard` and `git clean
 * -fd` (updater.ts `updateClawBoxAndReboot`), after install.sh's own resets in
 * step 1. An owner who had edited a file in the ClawBox checkout used to lose
 * the edit there with no trace and no word. scripts/preserve-local-edits.sh —
 * the same script install.sh runs before ITS resets — copies tracked changes
 * (as a patch) and untracked, non-ignored files to a dated directory outside
 * the tree first, and this reads back where it put them so the owner is told
 * on the update's own result card. TASK-1316.
 *
 * The script this runs is the one THIS BUILD carries, not the tree's. By the
 * time the restart step asks, step 1 has already moved the tree to the update
 * target — `main`, an older release, whatever a downgrade or a channel switch
 * names — and a tree from before TASK-1316 has no scripts/preserve-local-edits.sh
 * at all. Reading it from there failed E2E Install's switch to main at exactly
 * this step ("…preserve-local-edits.sh: No such file or directory"), over a
 * clean tree with nothing to save. So next.config.ts bakes the script's text
 * into the build (its `env` block, which Next inlines at build time), the tree's
 * copy is only the next source, and with neither the edits still go into the
 * checkout's own git stash. A missing helper never stops an update; edits that
 * fit nowhere still do.
 *
 * The web server runs as the checkout's owner, so the script runs as that
 * account here, exactly as install.sh runs it through `runuser`.
 */
import { execFile as execFileCb } from "child_process";
import { stat } from "fs/promises";
import { promisify } from "util";
import path from "./runtime-path";

const execFile = promisify(execFileCb);

const RUN_OPTIONS = { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 };

/** Where the edits went, and the sentence the owner is shown. */
export interface SavedLocalEdits {
  /** The dated directory, or `git-stash` when the copy could not be written. */
  savedTo: string;
  message: string;
}

/** Which copies of the script to run. Tests name them; the updater does not. */
export interface PreserveScriptSources {
  /**
   * The script's TEXT as this build carries it. Default: the copy next.config.ts
   * baked in. `null` stands for a build that carries none.
   */
  buildCopy?: string | null;
  /** The tree's copy, by path. Default: `<projectDir>/scripts/preserve-local-edits.sh`. */
  treeCopy?: string;
}

const WARN_LINE = /^CLAWBOX-WARN\[local-edits-saved\]:\s*(.+)$/m;
const SAVED_LINE = /^CLAWBOX-LOCAL-EDITS:\s*(.+)$/m;
const STOPPED = "The update could not save this box's local code changes, so it stopped before resetting them";

/**
 * This build's copy of scripts/preserve-local-edits.sh. Written as the literal
 * member expression `process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH` on purpose:
 * that is the form Next replaces with the text at build time. Nothing sets it
 * at runtime, so a build without it — a test, a `next dev` started before the
 * config had it — reads `undefined` and moves to the next source.
 */
export function bakedPreserveScript(): string | null {
  const text = process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH;
  return typeof text === "string" && text.trim() ? text : null;
}

/** The helper's own `Error:` line, which says what could not be saved. */
function errorLine(stderr: string): string | undefined {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^Error:/.test(l));
}

/**
 * Why a run failed, in a line — WITHOUT execFile's own "Command failed: …",
 * which quotes the whole argv: for the build's copy that is the entire script,
 * and it would land on the owner's result card.
 */
function failureDetail(err: unknown): string {
  const e = err as { stderr?: unknown; code?: unknown; signal?: unknown };
  const last = String(e.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (last) return last;
  if (typeof e.code === "number") return `exit status ${e.code}`;
  if (typeof e.code === "string") return e.code;
  if (typeof e.signal === "string") return `stopped by ${e.signal}`;
  return "unknown error";
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Neither the build nor the tree has the script. Still no reason to stop: a
 * clean tree has nothing to lose, and edits go into the checkout's own stash,
 * which every reset the update performs leaves alone — the script's own
 * fallback, and SAID, like it. Only edits the stash cannot take either stop
 * the update.
 */
async function stashLocalEdits(projectDir: string): Promise<SavedLocalEdits | null> {
  const git = (args: string[]) =>
    execFile("git", ["-c", `safe.directory=${projectDir}`, "-C", projectDir, ...args], RUN_OPTIONS);
  let status: string;
  try {
    ({ stdout: status } = await git(["status", "--porcelain", "--untracked-files=all"]));
  } catch (err) {
    throw new Error(`${STOPPED}: could not read the local changes in ${projectDir} (${failureDetail(err)})`);
  }
  if (!String(status ?? "").trim()) return null;
  // The script's stamp: 20260929T162140Z.
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  const label = `clawbox-update ${stamp}`;
  try {
    // The identity is given rather than inherited: a stash is a commit, and the
    // clawbox account on a box has no git identity of its own.
    await git([
      "-c", "user.name=ClawBox updater", "-c", "user.email=updater@clawbox.invalid",
      "stash", "push", "--include-untracked",
      "--message", `${label}: local edits the updater had no copy of scripts/preserve-local-edits.sh to save`,
    ]);
  } catch (err) {
    throw new Error(
      `Error: ${projectDir} has local changes that could not be saved to git stash (${failureDetail(err)}) — nothing was reset.`,
    );
  }
  return {
    savedTo: "git-stash",
    message: `This box had local changes to its code. They were kept in the code's git stash ("${label}") before the update reset the code — run: git -C ${projectDir} stash list`,
  };
}

/**
 * Save the local edits in `projectDir`, if it has any.
 *
 * Resolves `null` when the tree has nothing to save. REJECTS when there are
 * edits and they could not be saved anywhere (the script's exit 3) or the
 * script failed: the caller must then stop rather than reset, because a
 * stopped update can be run again and reset-away work cannot be recovered.
 */
export async function preserveLocalEdits(
  projectDir: string,
  sources: PreserveScriptSources = {},
): Promise<SavedLocalEdits | null> {
  const buildCopy = sources.buildCopy === undefined ? bakedPreserveScript() : sources.buildCopy;
  const treeCopy = sources.treeCopy ?? path.join(projectDir, "scripts", "preserve-local-edits.sh");
  let argv: string[];
  if (buildCopy) {
    // `bash -c <text> <$0> <$1>`: the script never locates itself, so it runs
    // the same from here as from the file.
    argv = ["-c", buildCopy, "preserve-local-edits.sh", projectDir];
  } else if (await isFile(treeCopy)) {
    argv = [treeCopy, projectDir];
  } else {
    console.warn(`[Updater] No copy of preserve-local-edits.sh in this build or in ${projectDir}; local edits, if any, go to git stash`);
    return stashLocalEdits(projectDir);
  }

  let stdout = "";
  try {
    ({ stdout } = await execFile("/bin/bash", argv, RUN_OPTIONS));
  } catch (err) {
    throw new Error(
      errorLine(String((err as { stderr?: unknown }).stderr ?? "")) ?? `${STOPPED}: ${failureDetail(err)}`,
    );
  }
  const text = String(stdout ?? "");
  const savedTo = SAVED_LINE.exec(text)?.[1]?.trim();
  if (!savedTo) return null;
  return {
    savedTo,
    message: WARN_LINE.exec(text)?.[1]?.trim()
      ?? `This box had local changes to its code. They were saved to ${savedTo} before the update reset the code.`,
  };
}
