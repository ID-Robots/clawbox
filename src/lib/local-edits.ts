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
 * The web server runs as the checkout's owner, so the script runs as that
 * account here, exactly as install.sh runs it through `runuser`.
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import path from "./runtime-path";

const execFile = promisify(execFileCb);

/** Where the edits went, and the sentence the owner is shown. */
export interface SavedLocalEdits {
  /** The dated directory, or `git-stash` when the copy could not be written. */
  savedTo: string;
  message: string;
}

const WARN_LINE = /^CLAWBOX-WARN\[local-edits-saved\]:\s*(.+)$/m;
const SAVED_LINE = /^CLAWBOX-LOCAL-EDITS:\s*(.+)$/m;

/** The helper's own `Error:` line, which says what could not be saved. */
function errorLine(stderr: string): string | undefined {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^Error:/.test(l));
}

/**
 * Save the local edits in `projectDir`, if it has any.
 *
 * Resolves `null` when the tree has nothing to save. REJECTS when there are
 * edits and they could not be saved anywhere (the script's exit 3) or the
 * script could not run: the caller must then stop rather than reset, because a
 * stopped update can be run again and reset-away work cannot be recovered.
 */
export async function preserveLocalEdits(
  projectDir: string,
  script: string = path.join(projectDir, "scripts", "preserve-local-edits.sh"),
): Promise<SavedLocalEdits | null> {
  let stdout = "";
  try {
    ({ stdout } = await execFile("/bin/bash", [script, projectDir], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      errorLine(String(e.stderr ?? ""))
        ?? `The update could not save this box's local code changes, so it stopped before resetting them: ${e.message ?? String(err)}`,
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
