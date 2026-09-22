import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-1088 — a V4.0 System Update stopped dead at "Updating OpenClaw":
 *
 *   The device pins 2026.9.3, but ~/.openclaw/state/openclaw.sqlite uses
 *   schema 17 and this build supports only schema 16.
 *
 * OpenClaw migrates its state database FORWARD and never back, so a box whose
 * store a 2026.9.4 core has opened is on schema 17 for good, and every older
 * core refuses to open it. The refusal arrives from the pinned core's first CLI
 * call — from INSIDE `openclaw_install`, which is `failFast` and which has by
 * then already retired the working core and written the refusing one over it.
 * The owner is left with a box that has no assistant and a "Try again" that
 * walks into the same wall.
 *
 * Every number in that sentence is knowable before anything is touched: the pin
 * is on disk, the schema each pin supports is a table in updater.ts, and the
 * store's own version is a `PRAGMA user_version` away. So the run now asks
 * BEFORE its first step and refuses there, with both numbers named.
 *
 * What is pinned here is the whole shape of that guard, including the three
 * ways it must NOT fire: an unknown pin, a box with no store, and a store that
 * could not be read are each an unknown, and an update refused over an unknown
 * strands exactly the box an update is there to repair.
 */

vi.mock("@/lib/config-store", () => {
  const get = vi.fn();
  return {
    get,
    getKnown: vi.fn(async (key: string) => ({ value: await get(key), known: true })),
    set: vi.fn(),
    setMany: vi.fn(),
  };
});

vi.mock("child_process", () => ({ exec: vi.fn(), execFile: vi.fn() }));

// The store itself is `node:sqlite` over a file this box does not have. The
// seam is the two readers the pre-flight calls, which is also the seam the
// real ones are written to: "is there a store" and "what schema is it on".
vi.mock("@/lib/openclaw-state-store", () => ({
  statePath: vi.fn(),
  readStateSchemaVersion: vi.fn(),
}));

import { get, setMany } from "@/lib/config-store";
import * as childProcess from "child_process";
import { readStateSchemaVersion, statePath } from "@/lib/openclaw-state-store";
import * as updater from "@/lib/updater";

const mockGet = vi.mocked(get);
const mockSetMany = vi.mocked(setMany);
const mockStatePath = vi.mocked(statePath);
const mockSchema = vi.mocked(readStateSchemaVersion);

const DB = "/home/clawbox/.openclaw/state/openclaw.sqlite";

/** The pin the pre-flight compares against, without depending on this checkout's file. */
function pin(version: string) {
  process.env.OPENCLAW_PIN_VERSION = version;
}

/**
 * The device: a state store at `DB` on `schema`, or none at all. `null` schema
 * is a store that exists and could not be read — a different answer from "no
 * store", and the same verdict.
 */
function device({ store = true, schema }: { store?: boolean; schema: number | null }) {
  mockStatePath.mockReturnValue(store ? DB : null);
  mockSchema.mockReturnValue(schema);
}

/**
 * The network probe REFUSES. Every case that expects the pre-flight to stand
 * down then lands on the internet refusal instead — which is the proof it was
 * let through, and it settles rather than parking on a root step that never
 * answers. (The pre-flight runs before this probe, so a refused run never
 * reaches it.)
 */
function networkRefuses() {
  vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(new Error("ping: unreachable"), "", "");
    return undefined as never;
  }) as never);
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline");
  }));
}

const OFFLINE = /No internet connection/;

beforeEach(() => {
  updater.resetUpdateState();
  mockGet.mockReset();
  mockGet.mockResolvedValue(undefined as never);
  mockSetMany.mockReset();
  mockSetMany.mockResolvedValue(undefined as never);
  mockStatePath.mockReset();
  mockSchema.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  // The pin this PR ships. 2026.9.4 supports state schema 17.
  pin("2026.9.4");
  networkRefuses();
});

afterEach(() => {
  updater.resetUpdateState();
  delete process.env.OPENCLAW_PIN_VERSION;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(childProcess.execFile).mockReset();
});

/** Run an update to its settled verdict. */
async function runToVerdict(start: () => { started: boolean; error?: string }) {
  expect(start()).toEqual({ started: true });
  await vi.waitFor(() => expect(updater.getUpdateState().phase).toBe("failed"));
  return updater.getUpdateState();
}

describe("the schema each pinned core supports", () => {
  it("is the table read from the published tarballs", () => {
    // `OPENCLAW_STATE_SCHEMA_VERSION` in `dist/openclaw-state-db-contract-*.js`
    // of each npm tarball. Nothing derives these — a bump adds a row.
    expect(updater.openclawStateSchemaFor("2026.8.1")).toBe(15);
    expect(updater.openclawStateSchemaFor("2026.9.3")).toBe(16);
    expect(updater.openclawStateSchemaFor("2026.9.4")).toBe(17);
  });

  it("answers null rather than guessing for a version it has not been told about", () => {
    expect(updater.openclawStateSchemaFor("2026.9.5")).toBeNull();
    expect(updater.openclawStateSchemaFor("")).toBeNull();
    expect(updater.openclawStateSchemaFor(null)).toBeNull();
    expect(updater.openclawStateSchemaFor(undefined)).toBeNull();
  });

  it("reads a pin the way the pin file is written — trailing newline and all", () => {
    expect(updater.openclawStateSchemaFor("2026.9.4\n")).toBe(17);
  });
});

describe("an update refuses a state database newer than the core it would install", () => {
  it("fails before step 1, naming the store, its schema and the core's", async () => {
    device({ schema: 18 });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.error).toContain(DB);
    expect(state.error, "the store's own schema").toContain("state schema 18");
    expect(state.error, "what the pinned core supports").toContain("schema 17");
    expect(state.error).toContain("2026.9.4");
    // Actionable: what the owner can do, not only what went wrong.
    expect(state.error).toMatch(/refused before it changed anything/);
    expect(state.error).toMatch(/schema 18 or newer/);

    // NOTHING ran. `currentStepIndex: -1` is this file's "no step was reached",
    // the same position the internet refusal leaves, and every step is pending.
    expect(state.currentStepIndex).toBe(-1);
    expect(state.steps.every((s) => s.status === "pending")).toBe(true);
    // Ahead of the internet probe too, so the verdict is the schema, never the
    // network — the probe is the first thing after it and it never ran.
    expect(state.error).not.toMatch(OFFLINE);
    expect(vi.mocked(childProcess.execFile)).not.toHaveBeenCalled();
  });

  it("releases the desktop lock it took, so the box is not left on /updating", async () => {
    device({ schema: 18 });

    await runToVerdict(() => updater.startUpdate());

    await vi.waitFor(() =>
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ update_in_progress: undefined, update_lock_holder: undefined }),
      ));
  });

  it("says the same thing to the OpenClaw-only update, whose first step is the install", async () => {
    device({ schema: 20 });

    const state = await runToVerdict(() => updater.startOpenclawUpdate());

    expect(state.error).toContain("state schema 20");
    expect(state.error).toContain("schema 17");
    expect(state.currentStepIndex).toBe(-1);
  });

  it("tells the operator, in the log, why an update was never started", async () => {
    const err = vi.mocked(console.error);
    device({ schema: 18 });

    await runToVerdict(() => updater.startUpdate());

    expect(err.mock.calls.flat().join(" ")).toMatch(/state schema 18/);
  });
});

describe("and lets every other box through", () => {
  it("accepts a store on exactly the schema the pinned core supports", async () => {
    // The customer's box: schema 17 under the 2026.9.4 pin. This is the case
    // the pin bump exists for — it must not be refused by the guard that came
    // with it.
    device({ schema: 17 });

    const state = await runToVerdict(() => updater.startUpdate());

    expect(state.error, "a box on the target schema must update").toMatch(OFFLINE);
  });

  it("accepts an older store, which the new core migrates forward itself", async () => {
    device({ schema: 16 });
    expect((await runToVerdict(() => updater.startUpdate())).error).toMatch(OFFLINE);
  });

  it("accepts a device that has no state store at all", async () => {
    device({ store: false, schema: null });
    expect((await runToVerdict(() => updater.startUpdate())).error).toMatch(OFFLINE);
    // Not even asked for: no store, no question.
    expect(mockSchema).not.toHaveBeenCalled();
  });

  it("accepts a store it could not read, rather than refusing over an unknown", async () => {
    device({ schema: null });
    expect((await runToVerdict(() => updater.startUpdate())).error).toMatch(OFFLINE);
  });

  it("stands down — loudly — for a pin whose schema it does not know", async () => {
    // A future pin with no row in the table. Refusing here would block every
    // box in the fleet on a number nobody had recorded; the warning is how the
    // omission is found.
    pin("2026.9.9");
    device({ schema: 99 });

    expect((await runToVerdict(() => updater.startUpdate())).error).toMatch(OFFLINE);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toMatch(
      /no state schema recorded for the pinned OpenClaw 2026\.9\.9/,
    );
  });
});

/**
 * The reader the cases above stand in for, against a REAL SQLite file.
 *
 * The number it returns is the one an update is refused on, so "it reads the
 * pragma" is not enough to know on trust. The core takes the GREATER of
 * `PRAGMA user_version` and the `state.schema.contentVersion` row in
 * `config_machine_state` (`readStateSchemaContentVersion` in the published
 * 2026.9.4 bundle) and admits on that; a reader that asked only for the pragma
 * would clear a box the core will then refuse.
 */
describe("readStateSchemaVersion, against a real store", () => {
  let home: string;
  let real: typeof import("@/lib/openclaw-state-store");
  let sqlite: typeof import("node:sqlite") | null = null;

  beforeAll(async () => {
    real = await vi.importActual<typeof import("@/lib/openclaw-state-store")>("@/lib/openclaw-state-store");
    sqlite = (process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined) ?? null;
  });

  /**
   * A store at the state path, with the versions this case is about. Replaced
   * outright on every call, so a case that builds two stores gets two, rather
   * than a second `CREATE TABLE` against the first one's schema.
   */
  function store({ userVersion, contentVersion }: { userVersion: number; contentVersion?: string }) {
    mkdirSync(path.join(home, "state"), { recursive: true });
    const file = path.join(home, "state", "openclaw.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
    const db = new sqlite!.DatabaseSync(file);
    try {
      db.exec(`PRAGMA user_version = ${userVersion}`);
      if (contentVersion !== undefined) {
        db.exec("CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT");
        db.prepare("INSERT INTO config_machine_state (state_key, value_json) VALUES (?, ?)")
          .run("state.schema.contentVersion", contentVersion);
      }
    } finally {
      db.close();
    }
    return file;
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "clawbox-state-schema-"));
    // `stateDir()` honours this exactly as OpenClaw's own resolver does, so the
    // reader looks where this case put the file.
    process.env.OPENCLAW_STATE_DIR = home;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(home, { recursive: true, force: true });
  });

  it("is available at all: node:sqlite is what every OpenClaw store is read through", () => {
    // Stated rather than skipped. A silent skip here would turn the six cases
    // below into six passes on a runtime that cannot open a store.
    expect(sqlite?.DatabaseSync, `node:sqlite on Node ${process.versions.node}`).toBeTypeOf("function");
  });

  it("reads the pragma a migrated store carries", () => {
    store({ userVersion: 17 });
    expect(real.readStateSchemaVersion()).toBe(17);
  });

  it("takes the content version when the core committed ahead of the pragma", () => {
    store({ userVersion: 16, contentVersion: "17" });
    expect(real.readStateSchemaVersion(), "the number the core itself admits on").toBe(17);
  });

  it("never lets the content version drag the answer BELOW the pragma", () => {
    store({ userVersion: 17, contentVersion: "15" });
    expect(real.readStateSchemaVersion()).toBe(17);
  });

  it("ignores a marker that is not a version, rather than reading it as zero", () => {
    store({ userVersion: 17, contentVersion: '"seventeen"' });
    expect(real.readStateSchemaVersion()).toBe(17);
    store({ userVersion: 17, contentVersion: "{ not json" });
    expect(real.readStateSchemaVersion()).toBe(17);
  });

  it("answers null when there is no store to ask", () => {
    expect(real.statePath()).toBeNull();
    expect(real.readStateSchemaVersion()).toBeNull();
  });

  it("answers null — not a number — for a store it cannot open", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(path.join(home, "state"), { recursive: true });
    writeFileSync(path.join(home, "state", "openclaw.sqlite"), "this is not a database");
    expect(real.readStateSchemaVersion()).toBeNull();
  });
});
