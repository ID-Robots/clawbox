/**
 * The one-shot migration runner (src/lib/boot-migrations.ts).
 *
 * The three facts that matter about a write the box makes on the owner's data
 * without being asked: it happens once, a failure is retried rather than
 * recorded, and nothing here can stop the boot.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BOOT_MIGRATIONS_KEY,
  parseRanMigrations,
  dropRemovedConsentMigration,
  REMOVED_CONSENT_KEY,
  REMOVED_INCIDENTS_FILE,
  runBootMigrations,
  type BootMigration,
} from "@/lib/boot-migrations";

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
      const s = store({ [REMOVED_CONSENT_KEY]: "ask" });
      await dropRemovedConsentMigration({
        set: s.set,
        removeFile: async () => { throw new Error("read-only"); },
      }).run();
      expect(REMOVED_CONSENT_KEY in s.values).toBe(false);

      const removeFile = vi.fn(async () => true);
      await dropRemovedConsentMigration({
        set: async () => { throw new Error("unwritable"); },
        removeFile,
      }).run();
      expect(removeFile).toHaveBeenCalledWith(REMOVED_INCIDENTS_FILE);
    } finally {
      errors.mockRestore();
    }
  });
});
