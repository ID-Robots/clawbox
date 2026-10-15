import { beforeEach, describe, expect, it, vi } from "vitest";

const oc = vi.hoisted(() => ({
  openclawIsAbsent: vi.fn(() => false),
  readConfigStrict: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  runOpenclawConfigSetBatch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/openclaw-config", () => oc);

import { ensureMemoryWikiWiring, planMemoryWikiWiring, WIRING_KEYS } from "@/lib/prime-radiant/plugin-wiring";

const VAULT = "/srv/box/data/prime-radiant/vault";

/** The plugin a reader of the vault: its compile writers off. */
const READER = { ingest: { autoCompile: false }, render: { createBacklinks: false, createDashboards: false } };

function wired(extra: Record<string, unknown> = {}, vaultExtra: Record<string, unknown> = {}) {
  return {
    plugins: {
      entries: {
        "memory-wiki": { enabled: true, config: { vaultMode: "isolated", vault: { path: VAULT, ...vaultExtra }, ...READER, ...extra } },
      },
    },
  };
}

const READER_WRITES = [
  { key: WIRING_KEYS.autoCompile, value: false },
  { key: WIRING_KEYS.createBacklinks, value: false },
  { key: WIRING_KEYS.createDashboards, value: false },
];

beforeEach(() => {
  oc.openclawIsAbsent.mockReturnValue(false);
  oc.readConfigStrict.mockResolvedValue({});
  oc.runOpenclawConfigSetBatch.mockResolvedValue(undefined);
});

describe("memory-wiki wiring plan", () => {
  it("writes the six keys on a box that never configured the plugin", () => {
    expect(planMemoryWikiWiring({ gateway: { port: 1 } }, VAULT)).toEqual({
      state: "needs-write",
      vault: VAULT,
      writes: [
        { key: WIRING_KEYS.enabled, value: true },
        { key: WIRING_KEYS.vaultMode, value: "isolated" },
        { key: WIRING_KEYS.vaultPath, value: VAULT },
        ...READER_WRITES,
      ],
    });
    expect(WIRING_KEYS).toMatchObject({
      autoCompile: "plugins.entries.memory-wiki.config.ingest.autoCompile",
      createBacklinks: "plugins.entries.memory-wiki.config.render.createBacklinks",
      createDashboards: "plugins.entries.memory-wiki.config.render.createDashboards",
    });
  });

  // The live test: wired with only the first three keys, the plugin's first
  // wiki_status compiled the vault — a Related block on every page,
  // <folder>/index.md, reports/ — and the vault's lint held the nightly.
  it("switches the plugin's vault writers off on a box wired before they were known", () => {
    const old = wired();
    const cfg = old.plugins.entries["memory-wiki"].config as Record<string, unknown>;
    delete cfg.ingest;
    delete cfg.render;
    expect(planMemoryWikiWiring(old, VAULT)).toEqual({ state: "needs-write", vault: VAULT, writes: READER_WRITES });
    // Only the one still unset is written; the owner's other render choices are not ours.
    expect(planMemoryWikiWiring(wired({ render: { createBacklinks: false, createDashboards: false, preserveHumanBlocks: true } , ingest: { maxConcurrentJobs: 2 } }), VAULT)).toEqual({
      state: "needs-write",
      vault: VAULT,
      writes: [{ key: WIRING_KEYS.autoCompile, value: false }],
    });
  });

  it("reports a vault writer the owner switched on by hand as a conflict, once", () => {
    const plan = planMemoryWikiWiring(wired({ render: { createBacklinks: true, createDashboards: true } }), VAULT);
    expect(plan).toMatchObject({
      state: "conflict",
      conflicts: ["plugin-writes"],
      writes: [
        { key: WIRING_KEYS.createBacklinks, value: false },
        { key: WIRING_KEYS.createDashboards, value: false },
      ],
    });
    expect(planMemoryWikiWiring(wired({ ingest: { autoCompile: true } }), VAULT)).toMatchObject({ state: "conflict", conflicts: ["plugin-writes"] });
  });

  it("writes nothing when already wired, and keeps the owner's other plugin settings out of it", () => {
    expect(planMemoryWikiWiring(wired({ search: { corpus: "all" } }, { renderMode: "obsidian" }), VAULT)).toEqual({ state: "wired", vault: VAULT });
  });

  it("only writes what differs", () => {
    const cfg = wired();
    (cfg.plugins.entries["memory-wiki"] as { enabled: boolean | undefined }).enabled = undefined;
    expect(planMemoryWikiWiring(cfg, VAULT)).toMatchObject({ state: "needs-write", writes: [{ key: WIRING_KEYS.enabled, value: true }] });
  });

  it("reports the owner's own choices as conflicts instead of overwriting them", () => {
    expect(planMemoryWikiWiring(wired({ vaultMode: "bridge" }), VAULT)).toMatchObject({ state: "conflict", conflicts: ["other-vault-mode"] });
    expect(planMemoryWikiWiring(wired({}, { path: "/somewhere/else" }), VAULT)).toMatchObject({
      state: "conflict",
      conflicts: ["other-vault-path"],
    });
    expect(planMemoryWikiWiring(wired({}, { scope: "agent" }), VAULT)).toMatchObject({ state: "conflict", conflicts: ["agent-scope"] });
    const disabled = wired();
    disabled.plugins.entries["memory-wiki"].enabled = false;
    expect(planMemoryWikiWiring(disabled, VAULT)).toMatchObject({ state: "conflict", conflicts: ["plugin-disabled"] });
    expect(planMemoryWikiWiring({ plugins: { deny: ["memory-wiki"] } }, VAULT)).toMatchObject({ conflicts: ["plugin-denied"] });
    expect(planMemoryWikiWiring({ plugins: { allow: ["telegram"] } }, VAULT)).toMatchObject({ conflicts: ["plugin-not-allowed"] });
  });

  it("treats a ~/ path to the same folder as the same vault", () => {
    const home = process.env.HOME;
    process.env.HOME = "/srv/box";
    try {
      expect(planMemoryWikiWiring(wired({}, { path: "~/data/prime-radiant/vault" }), VAULT).state).toBe("wired");
    } finally {
      process.env.HOME = home;
    }
  });
});

describe("ensureMemoryWikiWiring", () => {
  it("makes one batched write, then re-reads", async () => {
    oc.readConfigStrict.mockResolvedValueOnce({}).mockResolvedValueOnce(wired());
    const result = await ensureMemoryWikiWiring({ vault: VAULT });
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledWith([
      [WIRING_KEYS.enabled, "true", "--json"],
      [WIRING_KEYS.vaultMode, '"isolated"', "--json"],
      [WIRING_KEYS.vaultPath, JSON.stringify(VAULT), "--json"],
      [WIRING_KEYS.autoCompile, "false", "--json"],
      [WIRING_KEYS.createBacklinks, "false", "--json"],
      [WIRING_KEYS.createDashboards, "false", "--json"],
    ]);
    expect(result).toMatchObject({ state: "wired", wrote: true });
  });

  it("leaves a vault writer the owner switched on alone unless forced", async () => {
    const owners = wired({ render: { createBacklinks: true, createDashboards: false } });
    oc.readConfigStrict.mockResolvedValue(owners);
    expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "conflict", conflicts: ["plugin-writes"], wrote: false });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    oc.readConfigStrict.mockReset();
    oc.readConfigStrict.mockResolvedValueOnce(owners).mockResolvedValueOnce(wired());
    expect(await ensureMemoryWikiWiring({ vault: VAULT, force: true })).toMatchObject({ state: "wired", wrote: true });
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledWith([[WIRING_KEYS.createBacklinks, "false", "--json"]]);
  });

  it("serialises two windows opening the app together: one write, the second plans against it", async () => {
    let config: Record<string, unknown> = {};
    oc.readConfigStrict.mockImplementation(async () => config);
    oc.runOpenclawConfigSetBatch.mockImplementation(async () => {
      // The CLI takes a while; the second caller must not read the config meanwhile.
      await new Promise((r) => setTimeout(r, 5));
      config = wired();
    });
    const [first, second] = await Promise.all([
      ensureMemoryWikiWiring({ vault: VAULT }),
      ensureMemoryWikiWiring({ vault: VAULT }),
    ]);
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ state: "wired", wrote: true });
    expect(second).toMatchObject({ state: "wired", wrote: false });
  });

  it("does not hand a failed write to the next caller", async () => {
    oc.readConfigStrict.mockResolvedValue({});
    oc.runOpenclawConfigSetBatch.mockRejectedValueOnce(new Error("gateway busy"));
    await expect(ensureMemoryWikiWiring({ vault: VAULT })).rejects.toThrow("gateway busy");
    oc.readConfigStrict.mockReset();
    oc.readConfigStrict.mockResolvedValueOnce({}).mockResolvedValueOnce(wired());
    expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "wired", wrote: true });
  });

  it("is idempotent: a wired box makes no write", async () => {
    oc.readConfigStrict.mockResolvedValue(wired());
    expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "wired", wrote: false });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("leaves a conflict alone unless forced, and never forces a deny-list or agent scope", async () => {
    oc.readConfigStrict.mockResolvedValue(wired({}, { path: "/somewhere/else" }));
    expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "conflict", wrote: false });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    // Forced: the write lands and the read-back finds the vault where it was put.
    oc.readConfigStrict.mockReset();
    oc.readConfigStrict.mockResolvedValueOnce(wired({}, { path: "/somewhere/else" })).mockResolvedValueOnce(wired());
    expect(await ensureMemoryWikiWiring({ vault: VAULT, force: true })).toMatchObject({ state: "wired", wrote: true });
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledWith([[WIRING_KEYS.vaultPath, JSON.stringify(VAULT), "--json"]]);

    oc.runOpenclawConfigSetBatch.mockClear();
    oc.readConfigStrict.mockResolvedValue(wired({}, { scope: "agent" }));
    expect(await ensureMemoryWikiWiring({ vault: VAULT, force: true })).toMatchObject({ state: "conflict", wrote: false });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("is unavailable, never an error, without OpenClaw or with an unreadable config", async () => {
    oc.openclawIsAbsent.mockReturnValue(true);
    expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "unavailable", reason: "no-openclaw", wrote: false });
    oc.openclawIsAbsent.mockReturnValue(false);
    oc.readConfigStrict.mockRejectedValue(new Error("EACCES"));
    expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "unavailable", reason: "config-unreadable" });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });
});
