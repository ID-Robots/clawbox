/**
 * One-shot migrations, run once per box at the first boot that carries them.
 *
 * WHY A REGISTER AND NOT A HOOK EACH. A migration is a write the box makes on
 * the owner's data without being asked, so the two questions that matter about
 * every one of them are the same: has it run on THIS box, and what happened
 * when it did. A hook per migration answers neither in one place — each grows
 * its own marker key, its own logging and its own idea of what "already done"
 * means, and the fourth one is written by copying whichever of the first three
 * was nearest.
 *
 * THE MARKER IS A LIST OF IDS, not a schema number. A version counter says "the
 * box is at 4" and nothing about WHICH of the four ran: a box that updated
 * across two releases at once, or one whose migration failed halfway, cannot be
 * told from a box that is up to date. Ids are also what lets a migration be
 * removed from the code without renumbering the rest.
 *
 * ONCE, EVEN WHEN IT CHANGED NOTHING. The marker records that the question was
 * ASKED, not that something was written — otherwise a migration whose answer is
 * "nothing to do" runs again at every boot for ever, and one whose whole point
 * is to respect a later choice by the owner (see the wallpaper migration) would
 * undo that choice the next time the box restarts.
 *
 * NEVER THROWS, and never stops the boot. One migration that fails is logged
 * and left UNMARKED, so the next boot tries it again; the ones after it still
 * run. Nothing on the box waits for any of this.
 *
 * Its dependencies are handed in rather than imported, the way
 * `seedProcessTimeZone` takes its readers: the register is then walkable in a
 * unit test without a config store on disk.
 */

/** Where the ids of the migrations this box has already run are kept. */
export const BOOT_MIGRATIONS_KEY = "clawbox_boot_migrations";

export interface BootMigration {
  /**
   * Stable, and never reused: it is the whole of what "already run" means on a
   * box that has one of these recorded.
   */
  id: string;
  /** What the log says when it did something. Not shown to the owner. */
  label: string;
  /** Answers whether it actually changed anything, for the log line alone. */
  run: () => Promise<boolean>;
}

export interface BootMigrationDeps {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
}

/** The ids already recorded, and nothing else — a damaged marker reads as none. */
export function parseRanMigrations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Walk the register, run what this box has not run, and record each one as it
 * finishes.
 *
 * WRITTEN ONE AT A TIME rather than in a single write at the end: a box that
 * loses power between two migrations has the first one recorded, which is what
 * stops it being re-applied over an owner's later choice.
 *
 * Answers the ids that ran, for the caller's log and for the test.
 */
export async function runBootMigrations(
  migrations: readonly BootMigration[],
  deps: BootMigrationDeps,
): Promise<string[]> {
  let already: string[];
  try {
    already = parseRanMigrations(await deps.get(BOOT_MIGRATIONS_KEY));
  } catch (err) {
    // A marker that cannot be READ is not permission to migrate again: the
    // safe direction here is to do nothing, because every migration in this
    // register overwrites something the owner may since have chosen.
    console.error("[boot-migrations] Could not read the marker; skipping every migration this boot:", err instanceof Error ? err.message : err);
    return [];
  }
  const ran: string[] = [];
  for (const migration of migrations) {
    if (already.includes(migration.id)) continue;
    try {
      const changed = await migration.run();
      already = [...already, migration.id];
      await deps.set(BOOT_MIGRATIONS_KEY, already);
      ran.push(migration.id);
      if (changed) console.log(`[boot-migrations] ${migration.label}`);
    } catch (err) {
      // Left unmarked on purpose — the next boot tries it again — and the rest
      // of the register still runs.
      console.error(`[boot-migrations] ${migration.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return ran;
}

/**
 * The key the removed reporting programme kept the owner's consent under.
 *
 * The feature is gone (TASK-1012). Its key is not dead weight to leave lying
 * about: it is a stored CONSENT, and a box that keeps one for a feature it no
 * longer has would hand it straight back to anything that reads the store by
 * name later. Deleted on the first boot that carries this.
 */
export const REMOVED_CONSENT_KEY = "clawbox_improvement_program";

/** The error log it kept beside that consent, removed with it. */
export const REMOVED_INCIDENTS_FILE = "incidents.json";

/**
 * Take the removed programme's leftovers off a box that updated past it.
 *
 * Both halves are best-effort and independent: a store that will not give up
 * the key must not keep the log file on disk, and a log file that cannot be
 * removed must not leave the consent behind.
 */
export function dropRemovedConsentMigration(deps: {
  set: (key: string, value: unknown) => Promise<void>;
  removeFile: (name: string) => Promise<boolean>;
}): BootMigration {
  return {
    id: "drop-removed-consent",
    label: "removed the stored consent and error log of a feature this build no longer has",
    run: async () => {
      let changed = false;
      try {
        await deps.set(REMOVED_CONSENT_KEY, undefined);
        changed = true;
      } catch (err) {
        console.error("[boot-migrations] Could not drop the removed feature's consent:", err instanceof Error ? err.message : err);
      }
      try {
        if (await deps.removeFile(REMOVED_INCIDENTS_FILE)) changed = true;
      } catch (err) {
        console.error("[boot-migrations] Could not remove the incident log:", err instanceof Error ? err.message : err);
      }
      return changed;
    },
  };
}
