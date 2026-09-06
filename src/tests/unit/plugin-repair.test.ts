import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(existsSync(path.join(dir, "data", "plugin-repair.json"))).toBe(true);
    expect(readFileSync(path.join(dir, "data", "plugin-repair.json"), "utf-8")).toContain("not-installed");
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
