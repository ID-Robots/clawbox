import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The marker describes the OpenClaw half of a box; `readPluginRepairs` answers
// an empty map on Hermes (see its own note), so these cases pin the edition
// they are about rather than depending on whatever the dev machine resolves to.
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));

// The marker the boot script writes when it cannot install or consent a plugin
// (TASK-606), and the two questions every reader of it asks: what still needs
// repair, and which row does it belong to.
//
// Read through a temp CLAWBOX_ROOT, because DATA_DIR is resolved from it at
// import time — the same shape the config-store suites use.

let dir: string;

async function load() {
  vi.resetModules();
  return await import("@/lib/plugin-repair");
}

function write(rows: unknown) {
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(path.join(dir, "data", "plugin-repair.json"), JSON.stringify(rows), "utf-8");
}

// RESTORED, never deleted. `vitest.config.ts` pins CLAWBOX_ROOT to a temp dir
// for the whole run precisely so no suite touches real device state, and a
// `delete` here would hand every later file in this worker the production
// default.
let previousRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-marker-"));
  previousRoot = process.env.CLAWBOX_ROOT;
  process.env.CLAWBOX_ROOT = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = previousRoot;
});

describe("plugin-repair — what still needs repair", () => {
  it("is empty on a box that has never had a failure", async () => {
    const { readPluginRepairs } = await load();
    expect(await readPluginRepairs()).toEqual({});
  });

  it("is empty rather than an error on a file it cannot parse", async () => {
    // A badge invented from a parse error would send the owner repairing a
    // plugin that is fine; a missing one leaves the row exactly as it was.
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "plugin-repair.json"), "{ not json", "utf-8");
    const { readPluginRepairs } = await load();
    expect(await readPluginRepairs()).toEqual({});
  });

  it("drops a row that does not say what failed", async () => {
    write({ discord: { id: "discord" }, codex: { id: "codex", stage: "consent", reason: "nope" } });
    const { readPluginRepairs } = await load();
    expect(Object.keys(await readPluginRepairs())).toEqual(["codex"]);
  });

  it("clears one row and leaves the others", async () => {
    write({
      discord: { id: "discord", stage: "consent", reason: "a", atMs: 1, disabled: true },
      codex: { id: "codex", stage: "install", reason: "b", atMs: 2, disabled: false },
    });
    const { clearPluginRepair, readPluginRepairs } = await load();
    expect(await clearPluginRepair("discord")).toBe(true);
    expect(Object.keys(await readPluginRepairs())).toEqual(["codex"]);
    // Clearing what is not there is a no-op, not a rewrite.
    expect(await clearPluginRepair("discord")).toBe(false);
  });

  it("leaves the file behind rather than deleting it", async () => {
    write({ discord: { id: "discord", stage: "consent", reason: "a", atMs: 1, disabled: true } });
    const { clearPluginRepair } = await load();
    await clearPluginRepair("discord");
    // The boot script opens this by name; a delete would race a boot writing one.
    expect(existsSync(path.join(dir, "data", "plugin-repair.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, "data", "plugin-repair.json"), "utf-8"))).toEqual({});
  });
});

describe("plugin-repair — which row a failure belongs to", () => {
  it("matches a plugin under every spelling the registry keys it by", async () => {
    const { canonicalPluginId } = await load();
    for (const spelling of ["discord", "@openclaw/discord", "openclaw-discord"]) {
      expect(canonicalPluginId(spelling)).toBe("discord");
    }
    expect(canonicalPluginId("@openclaw/deepseek-provider")).toBe("deepseek");
  });

  it("puts the DeepSeek plugin on the ClawBox AI row and Codex on OpenAI", async () => {
    const { repairFor } = await load();
    const repairs = {
      deepseek: {
        id: "@openclaw/deepseek-provider",
        stage: "install" as const,
        reason: "r",
        atMs: 1,
        disabled: true,
        spec: "clawhub:@openclaw/deepseek-provider@2026.8.1",
      },
      codex: { id: "codex", stage: "consent" as const, reason: "r", atMs: 1, disabled: true, spec: "" },
    };
    // ClawBox AI rides the DeepSeek provider on every paired box, and the
    // OpenAI GPT row is served by the Codex harness plugin — two rows named
    // after what the owner sees rather than after the plugin behind them.
    expect(repairFor(repairs, "clawai")?.id).toBe("@openclaw/deepseek-provider");
    expect(repairFor(repairs, "deepseek")?.id).toBe("@openclaw/deepseek-provider");
    expect(repairFor(repairs, "openai")?.id).toBe("codex");
    expect(repairFor(repairs, "anthropic")).toBeNull();
  });
  it("clears the row under whatever spelling the boot script wrote it as", async () => {
    // `ensureChannelPlugin` enables the plugin under whichever key the registry
    // answered to, and the boot script marks it under that same configured key
    // — so the row can be `@openclaw/discord` while every caller here knows the
    // plugin as `discord`. An exact-key delete left the "Needs repair" badge up
    // on exactly the row it describes.
    write({
      "@openclaw/discord": { id: "@openclaw/discord", stage: "consent", reason: "no", atMs: 1, disabled: true },
      "@openclaw/deepseek-provider": {
        id: "@openclaw/deepseek-provider", stage: "install", reason: "no", atMs: 1, disabled: true,
      },
    });
    const { clearPluginRepair, readPluginRepairs } = await load();
    expect(await clearPluginRepair("discord")).toBe(true);
    // …and the provider suffix too, which is how the boot script's own
    // canonical id differs from the package name.
    expect(await clearPluginRepair("deepseek")).toBe(true);
    expect(await readPluginRepairs()).toEqual({});
  });

  it("still answers false when nothing matches, under any spelling", async () => {
    write({ discord: { id: "discord", stage: "consent", reason: "no", atMs: 1, disabled: true } });
    const { clearPluginRepair } = await load();
    expect(await clearPluginRepair("whatsapp")).toBe(false);
    expect(await clearPluginRepair("@openclaw/whatsapp")).toBe(false);
  });
});

/**
 * The updater's half of the same file (TASK-738).
 *
 * `scripts/gateway-pre-start.sh` has written this record since TASK-606; the
 * updater now writes one too, for an entry a core bump stranded. One file, one
 * shape, one Retry — so what matters here is that the server-side writer keeps
 * every other plugin's row and never sees a half-written file.
 */
describe("plugin-repair — recording a row from the server side", () => {
  const strandedRow = {
    id: "byteplus",
    stage: "not-installed" as const,
    reason: "plugin not installed: byteplus — install the official external plugin"
      + " with: openclaw plugins install @openclaw/byteplus-provider",
    disabled: true,
    spec: "@openclaw/byteplus-provider",
  };

  it("writes a row a reader can read back, on a box with no file yet", async () => {
    const { recordPluginRepair, readPluginRepairs } = await load();
    await recordPluginRepair(strandedRow);
    const rows = await readPluginRepairs();
    expect(rows.byteplus).toMatchObject(strandedRow);
    // Stamped by the writer, not passed in: a caller that forgot it would
    // otherwise file a row dated 1970 beside the boot script's own.
    expect(rows.byteplus.atMs).toBeGreaterThan(0);
  });

  it("keeps every other plugin's row", async () => {
    write({ discord: { id: "discord", stage: "consent", reason: "no", atMs: 1, disabled: true, spec: "" } });
    const { recordPluginRepair, readPluginRepairs } = await load();
    await recordPluginRepair(strandedRow);
    expect(Object.keys(await readPluginRepairs()).sort()).toEqual(["byteplus", "discord"]);
  });

  it("does not erase a spec the row already carries", async () => {
    // TASK-785. Each id had one writer while stating the whole row was safe;
    // the boot re-attempt made a second, and it cannot build every spec — the
    // ClawHub scheme is known only to the deepseek block. A re-file changes the
    // stage, never which package it is, so an empty spec keeps the old one.
    write({
      deepseek: {
        id: "deepseek",
        stage: "install",
        reason: "could not install",
        atMs: 1,
        disabled: true,
        spec: "clawhub:@openclaw/deepseek-provider@2026.8.1",
      },
    });
    const { recordPluginRepair, readPluginRepairs } = await load();
    await recordPluginRepair({
      id: "deepseek",
      stage: "install",
      reason: "still could not install",
      disabled: true,
      spec: "",
    });
    const rows = await readPluginRepairs();
    expect(rows.deepseek.spec).toBe("clawhub:@openclaw/deepseek-provider@2026.8.1");
    expect(rows.deepseek.reason).toBe("still could not install");
  });

  it("takes a new spec over the old one", async () => {
    write({
      deepseek: {
        id: "deepseek",
        stage: "install",
        reason: "could not install",
        atMs: 1,
        disabled: true,
        spec: "clawhub:@openclaw/deepseek-provider@2026.7.1",
      },
    });
    const { recordPluginRepair, readPluginRepairs } = await load();
    await recordPluginRepair({
      id: "deepseek",
      stage: "install",
      reason: "still could not install",
      disabled: true,
      spec: "clawhub:@openclaw/deepseek-provider@2026.8.1",
    });
    expect((await readPluginRepairs()).deepseek.spec)
      .toBe("clawhub:@openclaw/deepseek-provider@2026.8.1");
  });

  it("starts over on a file it cannot parse, exactly as the boot script does", async () => {
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data", "plugin-repair.json"), "{ not json", "utf-8");
    const { recordPluginRepair, readPluginRepairs } = await load();
    await recordPluginRepair(strandedRow);
    expect(Object.keys(await readPluginRepairs())).toEqual(["byteplus"]);
  });

  it("leaves no temp file behind", async () => {
    const { recordPluginRepair } = await load();
    await recordPluginRepair(strandedRow);
    expect(readFileSync(path.join(dir, "data", "plugin-repair.json"), "utf-8")).toContain("not-installed");
    // The staging file is the assertion, not the target: a rename that lands
    // is easy, and a `.tmp.<pid>.<uuid>` left in `data/` is what a failed one
    // used to leave behind for ever.
    expect(readdirSync(path.join(dir, "data"))).toEqual(["plugin-repair.json"]);
  });

  it("removes the staging file when the rename cannot land", async () => {
    // A read-only remount or a full partition, on exactly the box that can
    // least afford one stale temp file per boot. Mocked at the module rather
    // than spied: `fs/promises` is an ESM namespace and its exports cannot be
    // redefined in place.
    vi.doMock("fs/promises", async () => {
      const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
      const rename = async () => { throw new Error("EROFS: read-only file system"); };
      return { ...actual, default: { ...actual, rename }, rename };
    });
    try {
      const { recordPluginRepair } = await load();
      mkdirSync(path.join(dir, "data"), { recursive: true });
      await expect(recordPluginRepair(strandedRow)).rejects.toThrow("EROFS");
      expect(readdirSync(path.join(dir, "data"))).toEqual([]);
    } finally {
      vi.doUnmock("fs/promises");
    }
  });

  it("is read back as the third stage rather than dropped as an unknown one", async () => {
    // `parseEntry` accepts a closed set, and a row whose stage it does not know
    // is discarded whole — which would have made the badge disappear for
    // exactly the rows this card adds.
    write({ vydra: { id: "vydra", stage: "not-installed", reason: "no package", atMs: 5, disabled: true, spec: "" } });
    const { readPluginRepairs } = await load();
    expect((await readPluginRepairs()).vydra?.stage).toBe("not-installed");
  });

  it("knows which plugins have a Settings row of their own and which do not", async () => {
    const { pluginHasSettingsRow } = await load();
    expect(pluginHasSettingsRow("discord")).toBe(true);
    expect(pluginHasSettingsRow("@openclaw/deepseek-provider")).toBe(true);
    expect(pluginHasSettingsRow("byteplus")).toBe(false);
    expect(pluginHasSettingsRow("vydra")).toBe(false);
  });
});

// TASK-1088: the two fields the after-update retry and the "Repairing…" state
// add, and the clear that no longer deletes a failure filed while it ran.
describe("plugin-repair — a repair in flight, and one already spent (TASK-1088)", () => {
  const codex = {
    id: "codex", stage: "install", reason: "offline", atMs: 7, disabled: true, spec: "@openclaw/codex@2026.9.3",
  };

  it("reads a row written before the fields existed exactly as before", async () => {
    write({ codex });
    const { readPluginRepairs } = await load();
    expect((await readPluginRepairs()).codex).toEqual(codex);
  });

  it("stamps a row as being repaired without moving the atMs a clear compares against", async () => {
    write({ codex, deepseek: { ...codex, id: "deepseek", atMs: 9 } });
    const { readPluginRepairs, setPluginRepairInProgress, pluginRepairInProgress } = await load();

    expect(await setPluginRepairInProgress("@openclaw/codex", true, { retriedCore: "2026.9.4" })).toBe(true);
    const rows = await readPluginRepairs();
    expect(rows.codex.atMs).toBe(7);
    expect(rows.codex.retriedCore).toBe("2026.9.4");
    expect(pluginRepairInProgress(rows.codex)).toBe(true);
    expect(rows.deepseek.repairingSinceMs).toBeUndefined();

    expect(await setPluginRepairInProgress("codex", false)).toBe(true);
    const after = (await readPluginRepairs()).codex;
    expect(pluginRepairInProgress(after)).toBe(false);
    // The retry stays spent: ending the attempt does not give it back.
    expect(after.retriedCore).toBe("2026.9.4");
  });

  it("answers that there was nothing to stamp on a box with no such row", async () => {
    const { setPluginRepairInProgress } = await load();
    expect(await setPluginRepairInProgress("codex", true)).toBe(false);
  });

  it("hands a repair to exactly one of two callers that claim it at the same time", async () => {
    write({ codex });
    const { claimPluginRepair, readPluginRepairs, setPluginRepairInProgress } = await load();

    const outcomes = await Promise.all([claimPluginRepair("codex"), claimPluginRepair("@openclaw/codex")]);
    expect(outcomes.sort()).toEqual(["busy", "claimed"]);
    expect(typeof (await readPluginRepairs()).codex.repairingSinceMs).toBe("number");

    // A stamp a killed repair left behind past the ceiling does not hold the claim.
    write({ codex: { ...codex, repairingSinceMs: Date.now() - 21 * 60_000 } });
    expect(await claimPluginRepair("codex")).toBe("claimed");
    // Ending the repair gives the claim back; a row that is not there is said so.
    expect(await setPluginRepairInProgress("codex", false)).toBe(true);
    expect(await claimPluginRepair("codex")).toBe("claimed");
    expect(await claimPluginRepair("deepseek")).toBe("absent");
  });

  it("does not believe a stamp older than the ceiling, or one from the future", async () => {
    const { pluginRepairInProgress, PLUGIN_REPAIR_IN_PROGRESS_MS } = await load();
    const now = 1_000_000_000;
    const row = { ...codex, stage: "install" as const };
    expect(pluginRepairInProgress({ ...row, repairingSinceMs: now - 1_000 }, now)).toBe(true);
    expect(pluginRepairInProgress({ ...row, repairingSinceMs: now - PLUGIN_REPAIR_IN_PROGRESS_MS }, now)).toBe(false);
    expect(pluginRepairInProgress({ ...row, repairingSinceMs: now + 60_000 }, now)).toBe(false);
    expect(pluginRepairInProgress(row, now)).toBe(false);
  });

  it("keeps the spent retry across a re-file, and drops the in-progress stamp", async () => {
    write({ codex: { ...codex, retriedCore: "2026.9.4", repairingSinceMs: 5 } });
    const { readPluginRepairs, recordPluginRepair } = await load();

    await recordPluginRepair({ id: "codex", stage: "install", reason: "still refused", disabled: true, spec: "" });

    const row = (await readPluginRepairs()).codex;
    expect(row.retriedCore).toBe("2026.9.4");
    expect(row.repairingSinceMs).toBeUndefined();
    expect(row.spec).toBe("@openclaw/codex@2026.9.3");
    expect(row.reason).toBe("still refused");
  });

  it("clears the row it set out to repair", async () => {
    write({ codex, discord: { ...codex, id: "discord" } });
    const { readPluginRepairs, clearPluginRepairUnlessRefiled } = await load();
    expect(await clearPluginRepairUnlessRefiled("codex", 7)).toBe("cleared");
    expect(Object.keys(await readPluginRepairs())).toEqual(["discord"]);
  });

  it("leaves a row the restart's boot script filed again while the repair ran", async () => {
    // The restart that loads the repaired plugin runs the boot script, which
    // switches it off again and re-files the row when the core still refuses
    // it. That fresh row is the truth; deleting it was the badge going over a
    // plugin that stayed off.
    write({ codex: { ...codex, atMs: 99, reason: "refused at start" } });
    const { readPluginRepairs, clearPluginRepairUnlessRefiled } = await load();
    expect(await clearPluginRepairUnlessRefiled("codex", 7)).toBe("refiled");
    expect((await readPluginRepairs()).codex.reason).toBe("refused at start");
  });

  it("says a row the boot script cleared itself is gone", async () => {
    const { clearPluginRepairUnlessRefiled } = await load();
    expect(await clearPluginRepairUnlessRefiled("codex", 7)).toBe("absent");
  });
});
