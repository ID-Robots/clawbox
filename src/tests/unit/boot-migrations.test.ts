/**
 * The one-shot migration runner (src/lib/boot-migrations.ts).
 *
 * The three facts that matter about a write the box makes on the owner's data
 * without being asked: it happens once, a failure is retried rather than
 * recorded, and nothing here can stop the boot.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  BOOT_MIGRATIONS_KEY,
  parseRanMigrations,
  dropRemovedConsentMigration,
  hermesWallpaperDefaultMigration,
  openclawWallpaperDefaultMigration,
  PRE_BRAND_WALLPAPER_ID,
  REMOVED_CONSENT_KEY,
  REMOVED_INCIDENTS_FILE,
  runBootMigrations,
  WALLPAPER_STORE_KEY,
  type BootMigration,
} from "@/lib/boot-migrations";
import { LOBSTER_ORBITAL_WALLPAPER } from "@/lib/builtin-wallpapers";

/** A config store in memory, with the two readers the runner is handed. */
function store(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    get: vi.fn(async (key: string) => values[key]),
    set: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) delete values[key];
      else values[key] = value;
    }),
  };
}

function migration(id: string, run: () => Promise<boolean>): BootMigration {
  return { id, label: `ran ${id}`, run };
}

describe("the marker", () => {
  it("reads a damaged one as 'nothing has run' rather than throwing", () => {
    expect(parseRanMigrations(undefined)).toEqual([]);
    expect(parseRanMigrations("drop-removed-consent")).toEqual([]);
    expect(parseRanMigrations({ ran: ["a"] })).toEqual([]);
    // A list with rubbish in it keeps the ids it does have: an id recorded by
    // an earlier build is still the record that the migration ran.
    expect(parseRanMigrations(["a", 7, "", null, "b"])).toEqual(["a", "b"]);
  });
});

describe("running the register", () => {
  it("runs a migration once and records it", async () => {
    const s = store();
    const run = vi.fn(async () => true);
    expect(await runBootMigrations([migration("one", run)], s)).toEqual(["one"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.values[BOOT_MIGRATIONS_KEY]).toEqual(["one"]);
  });

  it("does not run it again on the next boot", async () => {
    const s = store();
    const run = vi.fn(async () => true);
    await runBootMigrations([migration("one", run)], s);
    expect(await runBootMigrations([migration("one", run)], s)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("records one that changed NOTHING, so it never runs twice either", async () => {
    // The point of the rule: a migration that respects a later choice by the
    // owner would undo that choice at the next boot if "nothing to do" left it
    // unmarked.
    const s = store();
    const run = vi.fn(async () => false);
    await runBootMigrations([migration("quiet", run)], s);
    expect(s.values[BOOT_MIGRATIONS_KEY]).toEqual(["quiet"]);
    await runBootMigrations([migration("quiet", run)], s);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves a FAILED one unmarked, runs the rest, and retries it next boot", async () => {
    const s = store();
    const bad = vi.fn(async () => { throw new Error("nope"); });
    const good = vi.fn(async () => true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runBootMigrations([migration("bad", bad), migration("good", good)], s)).toEqual(["good"]);
      expect(s.values[BOOT_MIGRATIONS_KEY]).toEqual(["good"]);
      expect(good).toHaveBeenCalledTimes(1);
      await runBootMigrations([migration("bad", bad), migration("good", good)], s);
      expect(bad).toHaveBeenCalledTimes(2);
      expect(good).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("runs nothing at all when the marker cannot be read", async () => {
    // The safe direction: every migration here overwrites something the owner
    // may since have chosen, so an unreadable marker means "do nothing".
    const run = vi.fn(async () => true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ran = await runBootMigrations([migration("one", run)], {
        get: async () => { throw new Error("unreadable"); },
        set: async () => {},
      });
      expect(ran).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("adds new ids beside the ones already recorded", async () => {
    const s = store({ [BOOT_MIGRATIONS_KEY]: ["old"] });
    await runBootMigrations([migration("old", async () => true), migration("new", async () => true)], s);
    expect(s.values[BOOT_MIGRATIONS_KEY]).toEqual(["old", "new"]);
  });
});

describe("the removed feature cleanup", () => {
  it("drops the stored consent and the incident log", async () => {
    const s = store({ [REMOVED_CONSENT_KEY]: "auto", other: "kept" });
    const removeFile = vi.fn(async () => true);
    const changed = await dropRemovedConsentMigration({ set: s.set, removeFile }).run();
    expect(changed).toBe(true);
    expect(REMOVED_CONSENT_KEY in s.values).toBe(false);
    expect(s.values.other).toBe("kept");
    expect(removeFile).toHaveBeenCalledWith(REMOVED_INCIDENTS_FILE);
  });

  it("still drops the key when the log file cannot be removed, and the other way round", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Each half gets its turn whatever the other did — and the half that
      // could not run makes the migration REJECT, so the next boot retries it.
      const s = store({ [REMOVED_CONSENT_KEY]: "ask" });
      await expect(dropRemovedConsentMigration({
        set: s.set,
        removeFile: async () => { throw new Error("read-only"); },
      }).run()).rejects.toThrow("read-only");
      expect(REMOVED_CONSENT_KEY in s.values).toBe(false);

      const removeFile = vi.fn(async () => true);
      await expect(dropRemovedConsentMigration({
        set: async () => { throw new Error("unwritable"); },
        removeFile,
      }).run()).rejects.toThrow("unwritable");
      expect(removeFile).toHaveBeenCalledWith(REMOVED_INCIDENTS_FILE);
    } finally {
      errors.mockRestore();
    }
  });

  it("is not marked done while half of it keeps failing, and is marked once it lands", async () => {
    // The point of the rejection: `runBootMigrations` records a migration the
    // moment run() RESOLVES, and a recorded migration is never offered again.
    // Swallowing the failure would leave the consent key on the box for good.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = store({ [REMOVED_CONSENT_KEY]: "auto" });
      const failing = dropRemovedConsentMigration({
        set: s.set,
        removeFile: async () => { throw new Error("read-only"); },
      });
      await runBootMigrations([failing], { get: s.get, set: s.set });
      expect(parseRanMigrations(s.values[BOOT_MIGRATIONS_KEY])).not.toContain("drop-removed-consent");

      // The next boot, with the disk writable again.
      const removeFile = vi.fn(async () => true);
      const ran = await runBootMigrations(
        [dropRemovedConsentMigration({ set: s.set, removeFile })],
        { get: s.get, set: s.set },
      );
      expect(ran).toContain("drop-removed-consent");
      expect(parseRanMigrations(s.values[BOOT_MIGRATIONS_KEY])).toContain("drop-removed-consent");
      expect(removeFile).toHaveBeenCalledWith(REMOVED_INCIDENTS_FILE);
    } finally {
      errors.mockRestore();
    }
  });
});

/**
 * The v4 wallpaper defaults.
 *
 * A box updated before its edition's own brand landed persisted the picture it
 * opened on, and nothing but an owner opening Settings would ever move it off.
 * These two move it — once, on the box's own edition, and only from that one
 * value.
 */
describe("the v4 wallpaper defaults", () => {
  const NEW_OPENCLAW = LOBSTER_ORBITAL_WALLPAPER.id;
  const NEW_HERMES = "hermes";

  /** The device's own answer, in the shape /setup-api/harness/active gives. */
  function device(active: string, activeKnown = true) {
    return vi.fn(async () => ({ active, activeKnown }));
  }

  it("reads and writes the key the desktop actually writes", () => {
    // Unprefixed, this would find nothing on every box in the world, answer
    // "nothing to do", and be marked done — once, silently, for ever.
    expect(WALLPAPER_STORE_KEY).toBe("pref:wp_id");
    expect(PRE_BRAND_WALLPAPER_ID).toBe("clawbox");
  });

  it("moves an OpenClaw box off the picture it was updated with", async () => {
    const s = store({ [WALLPAPER_STORE_KEY]: PRE_BRAND_WALLPAPER_ID });
    const changed = await openclawWallpaperDefaultMigration({ ...s, harness: device("openclaw") }).run();
    expect(changed).toBe(true);
    expect(s.values[WALLPAPER_STORE_KEY]).toBe(NEW_OPENCLAW);
  });

  it("moves a Hermes box off it too, to its own art", async () => {
    const s = store({ [WALLPAPER_STORE_KEY]: PRE_BRAND_WALLPAPER_ID });
    const changed = await hermesWallpaperDefaultMigration({ ...s, harness: device("hermes") }).run();
    expect(changed).toBe(true);
    expect(s.values[WALLPAPER_STORE_KEY]).toBe(NEW_HERMES);
  });

  it("never touches a picture the owner uploaded", async () => {
    // `custom-<n>` lives in one browser's localStorage while `wp_id` is
    // box-wide: the boot hook cannot even see what it names.
    const s = store({ [WALLPAPER_STORE_KEY]: "custom-2" });
    expect(await openclawWallpaperDefaultMigration({ ...s, harness: device("openclaw") }).run()).toBe(false);
    expect(s.values[WALLPAPER_STORE_KEY]).toBe("custom-2");
    expect(s.set).not.toHaveBeenCalled();
  });

  it("never touches a deliberate choice of another built-in", async () => {
    for (const chosen of ["deep-space", "hermes"]) {
      const s = store({ [WALLPAPER_STORE_KEY]: chosen });
      expect(await openclawWallpaperDefaultMigration({ ...s, harness: device("openclaw") }).run()).toBe(false);
      expect(s.values[WALLPAPER_STORE_KEY]).toBe(chosen);
    }
    const hermesBox = store({ [WALLPAPER_STORE_KEY]: "deep-space" });
    expect(await hermesWallpaperDefaultMigration({ ...hermesBox, harness: device("hermes") }).run()).toBe(false);
    expect(hermesBox.values[WALLPAPER_STORE_KEY]).toBe("deep-space");
  });

  it("leaves a box that has never chosen alone — it already PAINTS the new default", async () => {
    const s = store();
    expect(await openclawWallpaperDefaultMigration({ ...s, harness: device("openclaw") }).run()).toBe(false);
    expect(WALLPAPER_STORE_KEY in s.values).toBe(false);
    expect(s.set).not.toHaveBeenCalled();
  });

  it("leaves a value it cannot read alone", async () => {
    const s = store({ [WALLPAPER_STORE_KEY]: 7 });
    expect(await openclawWallpaperDefaultMigration({ ...s, harness: device("openclaw") }).run()).toBe(false);
    expect(s.values[WALLPAPER_STORE_KEY]).toBe(7);
  });

  it("does nothing on a box already on the new default, and is still marked DONE", async () => {
    const s = store({ [WALLPAPER_STORE_KEY]: NEW_OPENCLAW });
    const harness = device("openclaw");
    const build = () => openclawWallpaperDefaultMigration({ get: s.get, set: s.set, harness });
    expect(await runBootMigrations([build()], s)).toEqual(["wallpaper-default-openclaw"]);
    expect(s.values[BOOT_MIGRATIONS_KEY]).toEqual(["wallpaper-default-openclaw"]);
    // A migration whose answer was "nothing to do" must not ask again for ever.
    expect(await runBootMigrations([build()], s)).toEqual([]);
    expect(harness).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the OTHER edition, and is still marked DONE", async () => {
    const s = store({ [WALLPAPER_STORE_KEY]: PRE_BRAND_WALLPAPER_ID });
    const harness = device("hermes");
    await runBootMigrations([openclawWallpaperDefaultMigration({ get: s.get, set: s.set, harness })], s);
    expect(s.values[WALLPAPER_STORE_KEY]).toBe(PRE_BRAND_WALLPAPER_ID);
    expect(s.values[BOOT_MIGRATIONS_KEY]).toEqual(["wallpaper-default-openclaw"]);
  });

  it("runs ONCE, and never undoes what the owner picks afterwards", async () => {
    const s = store({ [WALLPAPER_STORE_KEY]: PRE_BRAND_WALLPAPER_ID });
    const harness = device("openclaw");
    const build = () => openclawWallpaperDefaultMigration({ get: s.get, set: s.set, harness });
    expect(await runBootMigrations([build()], s)).toEqual(["wallpaper-default-openclaw"]);
    expect(s.values[WALLPAPER_STORE_KEY]).toBe(NEW_OPENCLAW);
    // The owner goes back to the old picture on purpose, and reboots.
    s.values[WALLPAPER_STORE_KEY] = PRE_BRAND_WALLPAPER_ID;
    expect(await runBootMigrations([build()], s)).toEqual([]);
    expect(s.values[WALLPAPER_STORE_KEY]).toBe(PRE_BRAND_WALLPAPER_ID);
  });

  it("records each id as it finishes, so half a boot still counts", async () => {
    const s = store({ [WALLPAPER_STORE_KEY]: PRE_BRAND_WALLPAPER_ID });
    const harness = device("openclaw");
    const ran = await runBootMigrations(
      [
        openclawWallpaperDefaultMigration({ get: s.get, set: s.set, harness }),
        hermesWallpaperDefaultMigration({ get: s.get, set: s.set, harness }),
      ],
      s,
    );
    expect(ran).toEqual(["wallpaper-default-openclaw", "wallpaper-default-hermes"]);
    // The OpenClaw one moved it; the Hermes one is not this box's and left it.
    expect(s.values[WALLPAPER_STORE_KEY]).toBe(NEW_OPENCLAW);
  });

  describe("while nobody has said which edition this is", () => {
    /**
     * The null of `brandingHarness` covers the probe that failed, the lock that
     * could not be read and the dual box whose store would not answer — and all
     * three fall back to "openclaw", so acting on one would write ClawBox art
     * across a Hermes customer's screen, box-wide and permanently. It is not an
     * answer, so it is not recorded: the next boot asks again.
     */
    const unknown = [
      ["the answer is a guess", async () => ({ active: "openclaw", activeKnown: false })],
      ["the field is missing", async () => ({ active: "openclaw" })],
      ["nothing answered at all", async () => null],
      ["the read itself failed", async () => { throw new Error("no lock"); }],
    ] as const;

    for (const [what, harness] of unknown) {
      it(`asks again at the next boot when ${what}`, async () => {
        const s = store({ [WALLPAPER_STORE_KEY]: PRE_BRAND_WALLPAPER_ID });
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const migration = openclawWallpaperDefaultMigration({ get: s.get, set: s.set, harness });
          // Nothing escapes to the boot, nothing is written, nothing is marked.
          await expect(runBootMigrations([migration], s)).resolves.toEqual([]);
          expect(s.values[WALLPAPER_STORE_KEY]).toBe(PRE_BRAND_WALLPAPER_ID);
          expect(s.values[BOOT_MIGRATIONS_KEY]).toBeUndefined();
          // ...and the box's edition becomes readable by the next boot.
          await runBootMigrations(
            [openclawWallpaperDefaultMigration({ get: s.get, set: s.set, harness: device("openclaw") })],
            s,
          );
          expect(s.values[WALLPAPER_STORE_KEY]).toBe(NEW_OPENCLAW);
        } finally {
          errors.mockRestore();
        }
      });
    }
  });

  it("asks again at the next boot when the STORE will not answer", async () => {
    // Marked done against a store that could not be read is a box left on the
    // old picture with no second chance — and post_update holds that store
    // open on exactly the boot this is meant to run.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = store();
      const unreadable = openclawWallpaperDefaultMigration({
        get: async () => { throw new Error("database is locked"); },
        set: s.set,
        harness: device("openclaw"),
      });
      await expect(runBootMigrations([unreadable], s)).resolves.toEqual([]);
      expect(s.values[BOOT_MIGRATIONS_KEY]).toBeUndefined();

      const unwritable = openclawWallpaperDefaultMigration({
        get: async () => PRE_BRAND_WALLPAPER_ID,
        set: async (key: string) => { if (key === WALLPAPER_STORE_KEY) throw new Error("read-only"); },
        harness: device("openclaw"),
      });
      await expect(runBootMigrations([unwritable], store())).resolves.toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("cannot stop the boot, or the migrations beside it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = store();
      const after = vi.fn(async () => true);
      const ran = await runBootMigrations(
        [
          openclawWallpaperDefaultMigration({
            get: s.get,
            set: s.set,
            harness: async () => { throw new Error("no lock"); },
          }),
          migration("after", after),
        ],
        s,
      );
      expect(ran).toEqual(["after"]);
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
});

/**
 * The register is driven above through plain functions with their readers
 * handed in. That it is actually WIRED — that both wallpaper migrations are in
 * the list, that the edition comes from the device's own resolver rather than a
 * hostname or the config store alone, and that none of it can stop the boot —
 * is pinned by reading the boot file, as the other hooks in it are.
 */
describe("the wiring into register()", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "instrumentation.ts"), "utf8");
  const call = source.indexOf("await runBootMigrations(");
  const block = source.slice(call, source.indexOf("\n    )", call));
  /** Everything the boot hook sets up between loading the register and walking it. */
  const preamble = source.slice(source.indexOf("require('./lib/boot-migrations')"), call);

  it("walks the register at boot, awaited", () => {
    expect(call).toBeGreaterThan(-1);
  });

  it("has both wallpaper migrations in the list", () => {
    expect(block).toContain("dropRemovedConsentMigration(");
    expect(block).toContain("openclawWallpaperDefaultMigration({ get, set, harness })");
    expect(block).toContain("hermesWallpaperDefaultMigration({ get, set, harness })");
  });

  it("reads and writes wp_id through the store the rest of the box uses", () => {
    expect(preamble).toContain("require('./lib/config-store')");
    expect(block).toContain("{ get, set }");
  });

  it("takes the edition from the DEVICE, once, and shares the one answer", () => {
    // Never a hostname, never a folder name, never the config store alone:
    // the same resolver `/setup-api/harness/active` answers with, and its
    // `defaulted` inverted into the `activeKnown` brandingHarness reads.
    expect(preamble).toContain("require('./lib/harness')");
    expect(preamble).toContain("getActiveHarnessSource()");
    expect(preamble).toContain("activeKnown: !defaulted");
    // One promise for the boot. The edition lock is truncated and rewritten by
    // every update, so two reads a moment apart can disagree — and two
    // migrations acting on two different editions is the one outcome here that
    // writes the wrong product's art to a box-wide key.
    expect(preamble).toContain("if (!harnessAnswer)");
  });

  it("cannot stop the boot", () => {
    const catchStart = source.indexOf("} catch (err) {", call);
    expect(source.slice(catchStart, catchStart + 200)).toMatch(/Could not run the one-shot migrations/);
  });
});
