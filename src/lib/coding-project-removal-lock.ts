/**
 * Which project folders a removal is in the middle of.
 *
 * WHY IT IS ITS OWN MODULE, and a leaf one that imports nothing. Both sides of
 * a mutual exclusion have to read the SAME set: `deleteProject`
 * (coding-project-delete.ts) claims a folder, and `assertDirectoryFree`
 * (coding-agent.ts) refuses to let a run into one. Those two modules already
 * point one way — the delete library reads the run store — so putting the set
 * in either of them would close the loop, and a circular import whose value is
 * a module-level `Set` is exactly the kind that resolves to `undefined` on
 * whichever side happens to load second.
 *
 * WHAT IT IS FOR. A removal is not an instant: between the live-run check and
 * the folder actually going sit four git processes and, on a cross-device move,
 * a whole recursive copy. A run that STARTS inside that window finds nothing
 * live, begins writing, and the copy-then-remove then deletes a file written
 * after it was copied — gone from the original and never in the trash. Found by
 * an audit that inserted exactly that run.
 *
 * WHAT IT IS NOT. An in-process exclusion between a removal and a run START,
 * nothing more. It is not a filesystem lock: another process with a shell in
 * that folder knows nothing about it. That is the same span `assertDirectoryFree`
 * has always reasoned over — runs live in the web server — and claiming wider
 * would be claiming something this box cannot enforce.
 *
 * SYNCHRONOUS ON BOTH SIDES, deliberately. The claim has to be visible to any
 * check that runs after it with no await in between; that is what makes the two
 * an exclusion rather than two guesses that happen to agree.
 */

import path from "path";

const removing = new Set<string>();

/** Claim a project for removal. Answers the release, which is idempotent. */
export function beginProjectRemoval(real: string): () => void {
  const key = path.resolve(real);
  removing.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removing.delete(key);
  };
}

/**
 * Is this folder — or anything under it — inside a project being removed right
 * now? A run works at any depth inside its project, so the answer has to cover
 * the whole subtree and not just the folder that was claimed.
 */
export function isProjectBeingRemoved(directory: string): boolean {
  if (!removing.size || typeof directory !== "string" || !directory) return false;
  const dir = path.resolve(directory);
  for (const key of removing) {
    if (dir === key || dir.startsWith(key + path.sep)) return true;
  }
  return false;
}

/** For tests: nothing is being removed. */
export function _resetProjectRemovalsForTests(): void {
  removing.clear();
}
