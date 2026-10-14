import { beforeEach, describe, expect, it, vi } from "vitest";

const oc = vi.hoisted(() => ({
  openclawIsAbsent: vi.fn(() => false),
  readConfigStrict: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  runOpenclawConfigSetBatch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/openclaw-config", () => oc);

import { ensureMemoryWikiWiring, planMemoryWikiWiring, WIRING_KEYS } from "@/lib/prime-radiant/plugin-wiring";

const VAULT = "/srv/box/data/prime-radiant/vault";

function wired(extra: Record<string, unknown> = {}, vaultExtra: Record<string, unknown> = {}) {
  return {
    plugins: {
      entries: {
        "memory-wiki": { enabled: true, config: { vaultMode: "isolated", vault: { path: VAULT, ...vaultExtra }, ...extra } },
      },
    },
  };
}

beforeEach(() => {
  oc.openclawIsAbsent.mockReturnValue(false);
  oc.readConfigStrict.mockResolvedValue({});
  oc.runOpenclawConfigSetBatch.mockResolvedValue(undefined);
});

describe("memory-wiki wiring plan", () => {
  it("writes the three keys on a box that never configured the plugin", () => {
    expect(planMemoryWikiWiring({ gateway: { port: 1 } }, VAULT)).toEqual({
      state: "needs-write",
      vault: VAULT,
      writes: [
        { key: WIRING_KEYS.enabled, value: true },
        { key: WIRING_KEYS.vaultMode, value: "isolated" },
        { key: WIRING_KEYS.vaultPath, value: VAULT },
      ],
    });
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
    ]);
    expect(result).toMatchObject({ state: "wired", wrote: true });
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
