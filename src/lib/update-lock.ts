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

export async function setUpdateLock(): Promise<void> {
  try {
    await set(UPDATE_LOCK_KEY, true);
  } catch {
    // A lock that cannot be written must not stop the update it was protecting.
  }
}

export async function clearUpdateLock(): Promise<void> {
  try {
    await set(UPDATE_LOCK_KEY, undefined);
  } catch {
    // Nothing to do: the boot-time check clears it on the next start.
  }
}

export async function isUpdateLocked(): Promise<boolean> {
  try {
    return (await get(UPDATE_LOCK_KEY)) === true;
  } catch {
    return false;
  }
}
