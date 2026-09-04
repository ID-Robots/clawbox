import { get, set } from "./config-store";

/**
 * "An update owns this box right now" — persisted, so a surface that is NOT the
 * updater's own process can read it.
 *
 * `updateInFlight()` in updater.ts already answers this question, and answers it
 * better: it also knows about a run that has rebooted the box and is waiting for
 * its second half. But it reads module-level state in the process that is
 * running the update, and the middleware is not that reader — it reads
 * data/config.json off the disk with `fs` (it already does, for setup_complete),
 * because it must answer before any route handler is entered.
 *
 * So this is the disk half of the same fact, and the two are kept in step at the
 * four points where a run starts and the one where it ends.
 *
 * It deliberately OUTLIVES the reboot the update performs. The web server is
 * killed mid-run by do_rebuild and the flag is still set when the box comes
 * back, which is correct: post_update, gateway_verify and verify_build_identity
 * are still to come, and the desktop must stay locked through them. What clears
 * it is the run FINISHING — or, if the box came back with nothing to resume,
 * the boot-time continuation check, so a crashed update cannot lock the desktop
 * for ever.
 */
export const UPDATE_LOCK_KEY = "update_in_progress";

/** Where the owner is sent while the box updates. */
export const UPDATING_PAGE = "/updating";

/**
 * Take the lock. Answers whether it was actually taken.
 *
 * A failure is REPORTED and does not stop the update. Refusing to update a box
 * because a courtesy lock could not be written would be the worse outcome by
 * some way: config.json being unwritable is exactly the kind of state an update
 * exists to repair, and the desktop being reachable during one is a smaller
 * harm than a box that can no longer be fixed. But it is said out loud, because
 * silently running an update with the desktop unlocked is not something anyone
 * should have to infer from behaviour.
 */
export async function setUpdateLock(): Promise<boolean> {
  try {
    await set(UPDATE_LOCK_KEY, true);
    return true;
  } catch (err) {
    console.warn(
      "[Updater] Could not lock the desktop for this update - it stays reachable while the update runs:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Release it. A failure here leaves the desktop redirected to /updating, which
 * is why it is reported too — and why it is recoverable without anyone doing
 * anything clever: the next boot finds no update to resume and clears the flag
 * (resumeContinuation in updater.ts).
 */
export async function clearUpdateLock(): Promise<boolean> {
  try {
    await set(UPDATE_LOCK_KEY, undefined);
    return true;
  } catch (err) {
    console.warn(
      "[Updater] Could not release the desktop lock - the next start will clear it:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export async function isUpdateLocked(): Promise<boolean> {
  try {
    return (await get(UPDATE_LOCK_KEY)) === true;
  } catch {
    return false;
  }
}
