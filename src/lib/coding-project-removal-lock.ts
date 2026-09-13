/**
 * The two-sided exclusion between REMOVING a project and STARTING a run in it.
 *
 * WHY IT IS ITS OWN MODULE, and a leaf one that imports nothing but `path`.
 * Both sides have to read the SAME state: `deleteProject`
 * (coding-project-delete.ts) claims a folder, and `assertDirectoryFree`
 * (coding-agent.ts) refuses to let a run into one. Those two modules already
 * point one way — the delete library reads the run store — so putting the state
 * in either of them would close the loop, and a circular import whose value is
 * a module-level `Map` is exactly the kind that resolves to `undefined` on
 * whichever side happens to load second.
 *
 * WHY BOTH SIDES CLAIM, and not just the removal. A removal is not an instant,
 * and NEITHER IS A START. `assertDirectoryFree` passes synchronously, and then
 * `startRun` spends six awaits — the spawn tools, the folder, the settings, the
 * worktree, the auto-PR read, the secrets — before `insertRun` makes the run
 * visible to `listRuns()`. A removal that claimed the folder during that window
 * looked at the run store, saw NOTHING live, and moved the folder out from
 * under a run that was already committed to starting in it. Re-checking live
 * runs immediately before the move does not close that: the run is not in the
 * store to be found. So a start claims too, and the removal reads both.
 *
 * THE ORDERING IS THE PROOF. Each side WRITES its own claim and then READS the
 * other's, with no await in between:
 *
 *   - a start: `isProjectBeingRemoved` (read), then `beginRunStart` (write);
 *   - a removal: `beginProjectRemoval` (write), then `runStartingIn` (read).
 *
 * JavaScript runs one of those blocks to completion before the other begins, so
 * whichever goes second sees what the first wrote. Neither can conclude the
 * other is absent. That is what makes this an exclusion rather than two guesses
 * that usually agree.
 *
 * WHAT IT IS NOT. An IN-PROCESS exclusion, nothing more. It is not a filesystem
 * lock: another process with a shell in that folder knows nothing about it.
 * That is the same span `assertDirectoryFree` has always reasoned over — runs
 * live in the web server — and claiming wider would be claiming something this
 * box cannot enforce.
 */

import path from "path";

/**
 * Project folders a removal holds, and HOW MANY removals hold each.
 *
 * A count and not a flag: two removals of one folder can overlap — a
 * double-clicked Delete, a retry that raced its own first attempt — and with a
 * `Set` the first one to finish deleted the key while the second was still
 * copying, which let `assertDirectoryFree` admit a run into a folder that was
 * still being taken away.
 */
const removing = new Map<string, number>();

/** Folders a run START holds, counted for the same reason. */
const starting = new Map<string, number>();

/** Claim `key` in `held`, and answer the release, which is idempotent. */
function claim(held: Map<string, number>, key: string): () => void {
  held.set(key, (held.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(key) ?? 1) - 1;
    if (left > 0) held.set(key, left);
    else held.delete(key);
  };
}

/** Is `directory` at or under any key in `held`? */
function coveredBy(held: Map<string, number>, directory: string): boolean {
  if (!held.size || typeof directory !== "string" || !directory) return false;
  const dir = path.resolve(directory);
  for (const key of held.keys()) {
    if (dir === key || dir.startsWith(key + path.sep)) return true;
  }
  return false;
}

/** Claim a project for removal. Answers the release, which is idempotent. */
export function beginProjectRemoval(real: string): () => void {
  return claim(removing, path.resolve(real));
}

/**
 * Is this folder — or anything under it — inside a project being removed right
 * now? A run works at any depth inside its project, so the answer has to cover
 * the whole subtree and not just the folder that was claimed.
 */
export function isProjectBeingRemoved(directory: string): boolean {
  return coveredBy(removing, directory);
}

/**
 * Claim a folder for a run that is STARTING in it — taken the moment
 * `assertDirectoryFree` passes, released once the record is visible to
 * `listRuns()`. Answers the release, which is idempotent.
 */
export function beginRunStart(directory: string): () => void {
  return claim(starting, path.resolve(directory));
}

/**
 * Is a run starting in `root`, or anywhere under it, right now?
 *
 * The MIRROR of `isProjectBeingRemoved`, and the containment runs the other
 * way round: there the claim is the project and the question is a folder inside
 * it; here the claim is the run's own folder — which is a worktree somewhere
 * BELOW the project — and the question is the project that holds it. So a
 * removal asks about its own root and a claim under it counts.
 */
export function runStartingIn(root: string): boolean {
  if (!starting.size || typeof root !== "string" || !root) return false;
  const base = path.resolve(root);
  for (const key of starting.keys()) {
    if (key === base || key.startsWith(base + path.sep)) return true;
  }
  return false;
}

/** For tests: nothing is being removed and nothing is starting. */
export function _resetProjectRemovalsForTests(): void {
  removing.clear();
  starting.clear();
}
