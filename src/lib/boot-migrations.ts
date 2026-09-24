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
 * unit test without a config store on disk. The two imports below are the
 * exception that proves it — a wallpaper id and the fail-closed edition rule
 * are constants, not readers: nothing on disk answers them, and copying them
 * here is exactly the drift `builtin-wallpapers.ts` exists to prevent.
 */

import {
  brandingHarness,
  CLAWBOX_WALLPAPER_ID,
  HERMES_WALLPAPER_ID,
  LOBSTER_ORBITAL_WALLPAPER,
} from "@/lib/builtin-wallpapers";
import { PREFERENCE_KEY_PREFIX } from "@/lib/preference-schema";

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
 * Both halves are independent: a store that will not give up the key must not
 * keep the log file on disk, and a log file that cannot be removed must not
 * leave the consent behind. So both are ATTEMPTED whatever the other does.
 *
 * Independent is not the same as best-effort, though. `runBootMigrations`
 * marks a migration done the moment `run()` resolves, and a done migration is
 * never offered again — so swallowing a failure here would leave the consent
 * key, or the log file, on the box for the rest of its life. Whichever half
 * failed, the migration REJECTS once both have had their turn, which is this
 * register's channel for "ask me again at the next boot" (the wallpaper
 * migrations use it for an edition they cannot read). The half that succeeded
 * is idempotent, so the retry costs nothing.
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
      // The first failure, kept so the second half still gets its turn before
      // the migration rejects. `??=` rather than reassignment: the first cause
      // is the more useful one to print.
      let failure: unknown;
      try {
        await deps.set(REMOVED_CONSENT_KEY, undefined);
        changed = true;
      } catch (err) {
        console.error("[boot-migrations] Could not drop the removed feature's consent:", err instanceof Error ? err.message : err);
        failure ??= err;
      }
      try {
        if (await deps.removeFile(REMOVED_INCIDENTS_FILE)) changed = true;
      } catch (err) {
        console.error("[boot-migrations] Could not remove the incident log:", err instanceof Error ? err.message : err);
        failure ??= err;
      }
      if (failure !== undefined) throw failure;
      return changed;
    },
  };
}

/**
 * Bring the data of every webapp built before v4.0 back within its reach
 * (TASK-1150; src/lib/webapp-legacy-storage-migration.ts).
 *
 * v4.0 boxed webapps into an opaque origin and moved none of the data they
 * had saved on the ClawBox origin, so every such app opened empty. This copies
 * each app's old KV keys into its own namespace and records what it found —
 * the record is what switches the compatibility layer on, so no app is served
 * with the layer before its data has been moved. HERE because this register
 * is awaited before the server answers its first request.
 *
 * The migration is idempotent on its own record and deletes nothing; a run
 * that could not read the store, or whose copies did not read back, throws
 * and leaves no record, which is this register's "ask again at the next boot".
 */
export function legacyWebappStorageMigration(deps: {
  migrate: () => { ran: boolean; apps: number; copied: number };
}): BootMigration {
  return {
    id: "webapp-legacy-storage",
    label: "copied the data of webapps built before v4.0 into each app's own storage namespace",
    run: async () => {
      const result = deps.migrate();
      if (result.ran) console.log(`[boot-migrations] webapp storage: ${result.apps} app(s) checked, ${result.copied} old key(s) copied`);
      return result.ran && result.copied > 0;
    },
  };
}

/**
 * The box-wide wallpaper selection, spelled the way the STORE holds it.
 *
 * `wp_id` is a preference, and a preference wears the `pref:` prefix that
 * POST /setup-api/preferences puts on it before `config-store` ever sees it
 * (src/lib/preference-schema.ts). A migration reading the bare `wp_id` would
 * find nothing on every box in the world, answer "nothing to do", and be
 * marked done — silently, once, for ever.
 */
export const WALLPAPER_STORE_KEY = `${PREFERENCE_KEY_PREFIX}wp_id`;

/**
 * The one value the wallpaper migrations move a box OFF, and the reason they
 * are safe.
 *
 * Both editions opened on the ClawBox crab before either had a brand of its
 * own — Hermes until 2026-08-11 (`3af5726c`), OpenClaw until 2026-09-15
 * (`bf96c228`) — and the desktop of the day PERSISTED whatever it opened on:
 * the harness probe seeded `wp_id` and the next appearance write sent it to
 * the box-wide store. So this id in `wp_id` is what "was updated before the
 * brand landed, and has never chosen since" looks like from here.
 *
 * Nothing else is touched. Not an absent key (that box already PAINTS the new
 * default — `renderedWallpaperId(null, …)` — so there is nothing to move), not
 * a `custom-<n>` the owner uploaded, not `deep-space`, not the other edition's
 * art, not the new default itself, and not a value this build cannot read.
 * The migration asks one question and acts on one answer.
 */
export const PRE_BRAND_WALLPAPER_ID = CLAWBOX_WALLPAPER_ID;

export interface WallpaperDefaultMigrationDeps {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  /**
   * The DEVICE's own answer to which edition it is, in the shape
   * `/setup-api/harness/active` gives the browser — `active` plus the
   * `activeKnown` that says whether `active` is a fact or the "openclaw"
   * fallback. Handed in, and read through {@link brandingHarness}, so the
   * one fail-closed rule the desktop paints by is the one this writes by.
   */
  harness: () => Promise<{ active?: string | null; activeKnown?: boolean } | null>;
}

/**
 * Move a box that is still wearing the pre-brand default onto the wallpaper
 * this edition has shipped as its default since.
 *
 * WHY IT IS SAFE TO RUN AT ALL. The desktop only ever paints a default; the
 * value in `wp_id` was written by a build that did not yet draw that line, and
 * a box on the old picture today has no way back to its edition's own art short
 * of somebody opening Settings. That is the whole of the repair.
 *
 * WHY IT MAY REFUSE TO ANSWER. `brandingHarness` gives null for every state
 * that means NOBODY HAS SAID YET — the edition lock unreadable, a licensed
 * `dual` box whose config store could not be read — and that null is not
 * permission to guess: both of those reads fall back to "openclaw", so a guess
 * taken here writes ClawBox art across a Hermes customer's screen, box-wide and
 * permanently. It is also not a reason to record the question as asked, because
 * the boot that hits it is not a rare one: `install.sh` truncates and rewrites
 * the edition lock on EVERY update, and the update's second half holds the
 * config store open under post_update — so the first boot carrying this change
 * is exactly the boot most likely to land in the gap. So it THROWS, which is
 * the register's one channel for "ask me again": {@link runBootMigrations}
 * logs it, leaves it unmarked, runs the rest, and the next boot tries again.
 * Nothing escapes to the boot — that guarantee lives in the runner, not here.
 *
 * A store that will not answer takes the same path and for the same reason: a
 * migration marked done against a store that could not be read is a box left on
 * the old picture with no second chance.
 *
 * EVERY OTHER ANSWER IS FINAL. The other edition, an absent key, an uploaded
 * picture, a deliberate `deep-space`, a box already on the new default — all of
 * them are "asked and answered", recorded, and never asked again. The marker
 * records the QUESTION, which is the only thing that stops the next boot
 * undoing a choice the owner makes tomorrow.
 */
function wallpaperDefaultMigration(
  spec: { id: string; label: string; edition: string; to: string },
  deps: WallpaperDefaultMigrationDeps,
): BootMigration {
  return {
    id: spec.id,
    label: spec.label,
    run: async () => {
      const harness = brandingHarness(await deps.harness());
      if (harness === null) {
        throw new Error(
          "the device has named no edition, so its branding would be a guess; asking again at the next boot",
        );
      }
      // Not this edition's box. A real answer, so it is recorded: the question
      // is settled and re-asking it at every boot for the life of the device
      // buys nothing.
      if (harness !== spec.edition) return false;
      const saved = await deps.get(WALLPAPER_STORE_KEY);
      if (saved !== PRE_BRAND_WALLPAPER_ID) return false;
      await deps.set(WALLPAPER_STORE_KEY, spec.to);
      return true;
    },
  };
}

/** OpenClaw: the crab picture a pre-2026-09-15 box still holds → Lobster Orbital. */
export function openclawWallpaperDefaultMigration(deps: WallpaperDefaultMigrationDeps): BootMigration {
  return wallpaperDefaultMigration(
    {
      id: "wallpaper-default-openclaw",
      label: `moved this box off the wallpaper it was updated with onto the OpenClaw default (${LOBSTER_ORBITAL_WALLPAPER.id})`,
      edition: "openclaw",
      to: LOBSTER_ORBITAL_WALLPAPER.id,
    },
    deps,
  );
}

/**
 * Hermes: the same, to the Hermes art.
 *
 * A Hermes box holding the crab has been PAINTING the Hermes picture since the
 * built-in list was scoped to the edition (`d0d96507`) — the other product's
 * art is not in its list, so `renderedWallpaperId` already falls back. What is
 * repaired here is the store still naming artwork the owner's 2026-09-06 ruling
 * says a Hermes device must not carry: a selection that matches nothing in its
 * own Appearance grid, and the picture the box would wear again the moment
 * anything widened that list.
 */
export function hermesWallpaperDefaultMigration(deps: WallpaperDefaultMigrationDeps): BootMigration {
  return wallpaperDefaultMigration(
    {
      id: "wallpaper-default-hermes",
      label: `moved this box off the wallpaper it was updated with onto the Hermes default (${HERMES_WALLPAPER_ID})`,
      edition: "hermes",
      to: HERMES_WALLPAPER_ID,
    },
    deps,
  );
}
