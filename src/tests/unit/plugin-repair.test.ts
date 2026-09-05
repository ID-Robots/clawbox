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
});
