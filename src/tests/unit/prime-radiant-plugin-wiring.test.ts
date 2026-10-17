import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const oc = vi.hoisted(() => ({
  openclawIsAbsent: vi.fn(() => false),
  readConfigStrict: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  runOpenclawConfigSetBatch: vi.fn(async () => undefined),
}));
vi.mock("@/lib/openclaw-config", () => oc);

import { ensureMemoryWikiWiring, planMemoryWikiWiring, pluginVaultNow, vaultHoldsPages, WIRING_KEYS } from "@/lib/prime-radiant/plugin-wiring";

const VAULT = "/srv/box/data/prime-radiant/vault";

// memory-wiki's default vault (vault.path unset) is <state-dir>/wiki/main: a tmp state dir, never the real one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-wiring-"));
const prevStateDir = process.env.OPENCLAW_STATE_DIR;
process.env.OPENCLAW_STATE_DIR = path.join(tmp, "state");
const DEFAULT_VAULT = path.join(tmp, "state", "wiki", "main");
let folders = 0;

/** A folder laid out as `files` (relative path → text). */
function folder(files: Record<string, string>): string {
  const dir = path.join(tmp, `vault-${++folders}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** What the plugin creates in a vault it starts on, before anybody wrote a page. */
const SCAFFOLD = {
  "WIKI.md": "# Memory Wiki\n",
  "inbox.md": "# Inbox\n",
  "index.md": "# Index\n",
  "entities/index.md": "# Entities\n",
  "concepts/index.md": "# Concepts\n",
  "reports/open-questions.md": "# Open questions\n",
  ".openclaw-wiki/state.json": "{}",
};

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = prevStateDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

  it("holds the vault the plugin reads now to be empty only when nothing but its own scaffolding is there", async () => {
    expect(await vaultHoldsPages(path.join(tmp, "missing"))).toBe(false);
    expect(await vaultHoldsPages(folder(SCAFFOLD))).toBe(false);
    expect(await vaultHoldsPages(folder({ ...SCAFFOLD, "entities/globex.md": "# Globex\n" }))).toBe(true);
    // A source file, a note in a folder of its own: the owner's, whatever its name.
    expect(await vaultHoldsPages(folder({ "sources/acme-contract.pdf": "%PDF" }))).toBe(true);
    expect(await vaultHoldsPages(folder({ "notes/todo.txt": "call Globex" }))).toBe(true);
    // A file where the folder should be is not a vault to re-point.
    const file = path.join(folder({ "x.txt": "x" }), "x.txt");
    expect(await vaultHoldsPages(file)).toBe(true);
    // Unset: the plugin's default under the state dir; set: that path, ~/ expanded.
    expect(pluginVaultNow({ plugins: { entries: { "memory-wiki": { config: { vault: { path: "" } } } } } })).toBe(DEFAULT_VAULT);
    expect(pluginVaultNow(wired({}, { path: "relative/wiki" }))).toBeNull();
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
    const elsewhere = folder({ "entities/globex.md": "# Globex\n" });
    oc.readConfigStrict.mockResolvedValue(wired({}, { path: elsewhere }));
    expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "conflict", wrote: false });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    // Forced: the write lands and the read-back finds the vault where it was put.
    oc.readConfigStrict.mockReset();
    oc.readConfigStrict.mockResolvedValueOnce(wired({}, { path: elsewhere })).mockResolvedValueOnce(wired());
    expect(await ensureMemoryWikiWiring({ vault: VAULT, force: true })).toMatchObject({ state: "wired", wrote: true });
    expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledWith([[WIRING_KEYS.vaultPath, JSON.stringify(VAULT), "--json"]]);

    oc.runOpenclawConfigSetBatch.mockClear();
    oc.readConfigStrict.mockResolvedValue(wired({}, { scope: "agent" }));
    expect(await ensureMemoryWikiWiring({ vault: VAULT, force: true })).toMatchObject({ state: "conflict", wrote: false });
    expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("re-points a vault path set elsewhere only when that vault holds no pages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const empty of [folder(SCAFFOLD), path.join(tmp, "never-created")]) {
        oc.runOpenclawConfigSetBatch.mockClear();
        oc.readConfigStrict.mockReset();
        oc.readConfigStrict.mockResolvedValueOnce(wired({}, { path: empty })).mockResolvedValueOnce(wired());
        expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "wired", wrote: true });
        expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledWith([[WIRING_KEYS.vaultPath, JSON.stringify(VAULT), "--json"]]);
      }
      expect(warn).not.toHaveBeenCalled();

      // The owner's wiki: pages beside the plugin's scaffolding. Left alone, and said so.
      oc.runOpenclawConfigSetBatch.mockClear();
      const owners = folder({ ...SCAFFOLD, "concepts/globex-pricing.md": "# Globex pricing\n" });
      oc.readConfigStrict.mockReset();
      oc.readConfigStrict.mockResolvedValue(wired({}, { path: owners }));
      expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "conflict", conflicts: ["other-vault-path"], wrote: false });
      expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[prime-radiant] memory-wiki reads another vault that holds pages"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not re-point the plugin's default vault (vault.path unset) when it holds pages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      fs.mkdirSync(path.join(DEFAULT_VAULT, "syntheses"), { recursive: true });
      fs.writeFileSync(path.join(DEFAULT_VAULT, "syntheses", "acme-roadmap.md"), "# Acme roadmap\n");
      oc.readConfigStrict.mockResolvedValue({});
      const result = await ensureMemoryWikiWiring({ vault: VAULT });
      expect(result).toMatchObject({ state: "conflict", conflicts: ["other-vault-path"], wrote: false });
      expect(oc.runOpenclawConfigSetBatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);

      // Emptied (only what the plugin itself made): pointed at Prime Radiant's vault.
      fs.rmSync(DEFAULT_VAULT, { recursive: true, force: true });
      for (const [rel, text] of Object.entries(SCAFFOLD)) {
        fs.mkdirSync(path.dirname(path.join(DEFAULT_VAULT, rel)), { recursive: true });
        fs.writeFileSync(path.join(DEFAULT_VAULT, rel), text);
      }
      oc.readConfigStrict.mockReset();
      oc.readConfigStrict.mockResolvedValueOnce({}).mockResolvedValueOnce(wired());
      expect(await ensureMemoryWikiWiring({ vault: VAULT })).toMatchObject({ state: "wired", wrote: true });
      expect(oc.runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
      expect(pluginVaultNow({})).toBe(DEFAULT_VAULT);
    } finally {
      warn.mockRestore();
      fs.rmSync(DEFAULT_VAULT, { recursive: true, force: true });
    }
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
