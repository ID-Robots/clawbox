import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: vi.fn(() => "/usr/bin/openclaw"),
  runOpenclawConfigSet: vi.fn(),
}));
vi.mock("@/lib/openclaw-deepseek-plugin", () => ({
  installDeepseekProviderPlugin: vi.fn(),
  installedOpenclawRelease: vi.fn(),
}));

// TASK-1088: the retry the 2026.9.4 update owes the rows 2026.9.3 left.
//
// The customer box: its V4.0 update stopped against OpenClaw 2026.9.3, whose
// core refused the schema-17 store, so the boot script could install neither
// Codex nor the DeepSeek provider ClawBox AI runs on — it switched both off and
// filed both as "Needs repair". The update that lands 2026.9.4 removes the
// cause and, before this, looked at neither row again: the gateway came up
// healthy WITHOUT the two plugins, so there was no refusal in its journal for
// the updater's repair to act on.
//
// The marker here is the REAL file (a temp CLAWBOX_ROOT); the CLI and the
// config writer are a small in-memory box, so what is asserted is what the box
// ends up in, not which mocks were called.

let dir: string;
let previousRoot: string | undefined;
let execFile: Mock;
let runOpenclawConfigSet: Mock;
let installDeepseek: Mock;

/** The box: which entries are on, which packages are on disk, what the CLI refuses. */
interface Box {
  entries: Record<string, boolean>;
  installed: Record<string, string>;
  refuseInstall: Map<string, string>;
  refuseEnable: Map<string, string>;
  /** Plugins the runtime reports as loaded-but-not-activated even when on and installed. */
  inert: Set<string>;
  execCalls: string[][];
  configWrites: string[][];
  events: string[];
  /** Whether the gateway is running — the updater's quiesce STOPS it, and only a restart starts it. */
  gatewayUp: boolean;
}
let box: Box;

const RELEASE = "2026.9.4";

function markerPath(): string {
  return path.join(dir, "data", "plugin-repair.json");
}

function writeMarker(rows: Record<string, unknown>) {
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(markerPath(), JSON.stringify(rows, null, 2));
}

type Row = {
  id: string; stage: string; reason: string; atMs: number; disabled: boolean; spec: string;
  retriedCore?: string; repairingSinceMs?: number;
};

function marker(): Record<string, Row> {
  return existsSync(markerPath()) ? JSON.parse(readFileSync(markerPath(), "utf-8")) : {};
}

const CODEX_ROW: Row = {
  id: "codex",
  stage: "install",
  reason: "The ChatGPT (Codex) plugin could not be installed. The device may be offline, or the package registry unreachable.",
  atMs: 1,
  disabled: true,
  spec: "@openclaw/codex@2026.9.3",
};
const DEEPSEEK_ROW: Row = {
  id: "deepseek",
  stage: "install",
  reason: "The DeepSeek provider plugin, which ClawBox AI runs on, could not be installed.",
  atMs: 2,
  disabled: true,
  spec: "clawhub:@openclaw/deepseek-provider@2026.9.3",
};

function cliError(stderr: string): Error {
  return Object.assign(new Error(`Command failed\n${stderr}`), { code: 1, stdout: "", stderr });
}

function pluginOfSpec(spec: string): string {
  const name = spec.replace(/^clawhub:/, "").replace(/@[^@/]+$/, "");
  return name.replace(/^@openclaw\//, "").replace(/-provider$/, "");
}

async function load() {
  vi.resetModules();
  ({ execFile } = (await import("child_process")) as unknown as { execFile: Mock });
  ({ runOpenclawConfigSet } = (await import("@/lib/openclaw-config")) as unknown as { runOpenclawConfigSet: Mock });
  const deepseek = (await import("@/lib/openclaw-deepseek-plugin")) as unknown as {
    installDeepseekProviderPlugin: Mock;
    installedOpenclawRelease: Mock;
  };
  installDeepseek = deepseek.installDeepseekProviderPlugin;
  // `promisify(execFile)` reads the custom symbol at MODULE LOAD, so it goes on
  // the mock before the runner is imported.
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] =
    async (_cmd: string, args: string[]) => {
      box.execCalls.push(args);
      const [, verb, subject] = args;
      if (verb === "install") {
        const refusal = box.refuseInstall.get(subject);
        if (refusal) throw cliError(refusal);
        box.installed[pluginOfSpec(subject)] = subject;
        return { stdout: "Installed. Restart the gateway to load plugins.", stderr: "" };
      }
      if (verb === "enable") {
        const refusal = box.refuseEnable.get(subject);
        if (refusal) throw cliError(refusal);
        box.entries[subject] = true;
        return { stdout: "", stderr: "" };
      }
      if (verb === "inspect") {
        const on = box.entries[subject] === true && !!box.installed[subject];
        const activated = on && !box.inert.has(subject);
        return { stdout: JSON.stringify({ plugin: { id: subject, status: on ? "loaded" : "disabled", activated } }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
  runOpenclawConfigSet.mockImplementation(async (args: string[]) => {
    box.configWrites.push(args);
    const match = /^plugins\.entries\["(.+)"\]\.enabled$/.exec(args[0]);
    if (!match) throw new Error(`unexpected config write ${args[0]}`);
    box.entries[match[1]] = args[1] === "true";
  });
  installDeepseek.mockImplementation(async (options: { force?: boolean } = {}) => {
    box.execCalls.push(["deepseek-installer", options.force ? "--force" : ""]);
    const refusal = box.refuseInstall.get("deepseek");
    if (refusal) return { installed: null, failures: [`clawhub:@openclaw/deepseek-provider@${RELEASE}: ${refusal}`] };
    box.installed.deepseek = `clawhub:@openclaw/deepseek-provider@${RELEASE}`;
    return { installed: `clawhub:@openclaw/deepseek-provider@${RELEASE}`, failures: [] };
  });
  return await import("@/lib/plugin-repair-after-update");
}

/** The updater's hooks, against the in-memory box. */
function hooks(overrides: {
  release?: string | null;
  /** What the restart's gateway pre-start does before the gateway is up. */
  onRestart?: (attempt: number) => Promise<void> | void;
  /** Make the gateway not come back on these restart attempts (1-based). */
  notReadyOn?: number[];
} = {}) {
  let restarts = 0;
  const release = vi.fn(async () => (overrides.release === undefined ? RELEASE : overrides.release));
  return {
    release,
    // As `withGatewayQuiesced` does it: masked and STOPPED, and the mask lifted
    // afterwards WITHOUT starting it again.
    quiesce: async <T>(operation: () => Promise<T>): Promise<T> => {
      box.events.push("quiesce");
      box.gatewayUp = false;
      try {
        return await operation();
      } finally {
        box.events.push("unquiesce");
      }
    },
    restartAndVerify: vi.fn(async () => {
      restarts += 1;
      box.events.push(`restart:${restarts}`);
      await overrides.onRestart?.(restarts);
      if (overrides.notReadyOn?.includes(restarts)) throw new Error("OpenClaw gateway still offline");
      box.gatewayUp = true;
    }),
    log: vi.fn(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-after-update-"));
  previousRoot = process.env.CLAWBOX_ROOT;
  process.env.CLAWBOX_ROOT = dir;
  box = {
    entries: { codex: false, deepseek: false },
    installed: {},
    refuseInstall: new Map(),
    refuseEnable: new Map(),
    inert: new Set(),
    execCalls: [],
    configWrites: [],
    events: [],
    gatewayUp: true,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = previousRoot;
});

describe("after a core update — the rows an older core left", () => {
  it("repairs ChatGPT and ClawBox AI on the new core, and clears them only after the gateway came back", async () => {
    writeMarker({ codex: CODEX_ROW, deepseek: DEEPSEEK_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const h = hooks();
    // While it runs, the rows say so — and the retry is already spent.
    let seenDuringRepair: Record<string, Row> = {};
    const inner = h.quiesce;
    h.quiesce = async (operation) => {
      seenDuringRepair = marker();
      return inner(operation);
    };

    const result = await retryPluginRepairsAfterCoreUpdate(h);

    expect(result).toEqual({ release: RELEASE, repaired: ["codex", "deepseek"], failed: [] });
    // The package built for the core on the box, not the one the row named.
    expect(box.execCalls).toContainEqual([
      "plugins", "install", "@openclaw/codex@2026.9.4", "--force", "--accept-capabilities",
    ]);
    expect(box.execCalls).toContainEqual(["deepseek-installer", "--force"]);
    expect(box.entries).toEqual({ codex: true, deepseek: true });
    expect(marker()).toEqual({});
    expect(seenDuringRepair.codex.repairingSinceMs).toEqual(expect.any(Number));
    expect(seenDuringRepair.codex.retriedCore).toBe(RELEASE);
    expect(seenDuringRepair.deepseek.retriedCore).toBe(RELEASE);
    // Installed with the gateway stopped, THEN restarted and proved.
    expect(box.events).toEqual(["quiesce", "unquiesce", "restart:1"]);
    expect(box.gatewayUp).toBe(true);
  });

  it("writes nothing to openclaw.json but the two entries' enabled bits — never the credentials or the provider choice", async () => {
    writeMarker({ codex: CODEX_ROW, deepseek: DEEPSEEK_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();

    await retryPluginRepairsAfterCoreUpdate(hooks());

    expect(box.configWrites.map((args) => args[0]).sort()).toEqual([
      'plugins.entries["codex"].enabled',
      'plugins.entries["deepseek"].enabled',
    ]);
  });

  it("is a no-op the second time: a resumed update does nothing twice", async () => {
    writeMarker({ codex: CODEX_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    await retryPluginRepairsAfterCoreUpdate(hooks());
    box.execCalls = [];

    const h = hooks();
    const again = await retryPluginRepairsAfterCoreUpdate(h);

    expect(again.repaired).toEqual([]);
    expect(box.execCalls).toEqual([]);
    // A healthy box pays one file read: not even the release is asked.
    expect(h.release).not.toHaveBeenCalled();
    expect(h.restartAndVerify).not.toHaveBeenCalled();
  });

  it("re-files a failure with the core's own words, switched off, and does not retry it again on this core", async () => {
    writeMarker({ codex: CODEX_ROW });
    box.refuseInstall.set("@openclaw/codex@2026.9.4", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@openclaw%2fcodex");
    const { retryPluginRepairsAfterCoreUpdate } = await load();

    const result = await retryPluginRepairsAfterCoreUpdate(hooks());

    expect(result).toEqual({ release: RELEASE, repaired: [], failed: ["codex"] });
    const row = marker().codex;
    expect(row.disabled).toBe(true);
    expect(row.retriedCore).toBe(RELEASE);
    expect(row.repairingSinceMs).toBeUndefined();
    expect(row.spec).toBe("@openclaw/codex@2026.9.4");
    expect(row.reason).toBe(
      "The ChatGPT (Codex) plugin was retried after the OpenClaw 2026.9.4 update and could not be reinstalled, "
      + "so it stays switched off. openclaw plugins install exited 1: "
      + "npm error 404 Not Found - GET https://registry.npmjs.org/@openclaw%2fcodex",
    );
    expect(box.entries.codex).toBe(false);

    // BOUNDED: the same core does not buy it a second attempt…
    box.execCalls = [];
    const h = hooks();
    await retryPluginRepairsAfterCoreUpdate(h);
    expect(box.execCalls).toEqual([]);
    expect(h.restartAndVerify).not.toHaveBeenCalled();

    // …and the next core does.
    box.refuseInstall.clear();
    const next = await retryPluginRepairsAfterCoreUpdate(hooks({ release: "2026.9.5" }));
    expect(next.repaired).toEqual(["codex"]);
    expect(box.execCalls[0]).toEqual([
      "plugins", "install", "@openclaw/codex@2026.9.5", "--force", "--accept-capabilities",
    ]);
  });

  it("does not claim a plugin the runtime will not activate, and puts it back off", async () => {
    writeMarker({ deepseek: DEEPSEEK_ROW });
    box.inert.add("deepseek");
    const { retryPluginRepairsAfterCoreUpdate } = await load();

    const h = hooks();
    const result = await retryPluginRepairsAfterCoreUpdate(h);

    expect(result.failed).toEqual(["deepseek"]);
    expect(box.entries.deepseek).toBe(false);
    expect(marker().deepseek.reason).toContain("was reinstalled but the core does not report it loaded");
    // Nothing to load — but the quiesce stopped the gateway, so it is brought
    // back up, without the plugin.
    expect(h.restartAndVerify).toHaveBeenCalledTimes(1);
    expect(box.gatewayUp).toBe(true);
  });

  it("never leaves the gateway stopped when every retry failed", async () => {
    // The updater's quiesce stops the gateway and lifts the mask without
    // starting it; an early return here ended the update with no gateway.
    writeMarker({ codex: CODEX_ROW, deepseek: DEEPSEEK_ROW });
    box.refuseInstall.set("@openclaw/codex@2026.9.4", "npm error code ETIMEDOUT");
    box.refuseInstall.set("deepseek", "clawhub registry answered 503");
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const h = hooks();

    const result = await retryPluginRepairsAfterCoreUpdate(h);

    expect(result.failed).toEqual(["codex", "deepseek"]);
    expect(box.events).toEqual(["quiesce", "unquiesce", "restart:1"]);
    expect(box.gatewayUp).toBe(true);
    expect(box.entries).toEqual({ codex: false, deepseek: false });
  });

  it("puts the plugins back off when the gateway does not come back with them, and says so", async () => {
    writeMarker({ codex: CODEX_ROW, deepseek: DEEPSEEK_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const h = hooks({ notReadyOn: [1] });

    const result = await retryPluginRepairsAfterCoreUpdate(h);

    expect(result.repaired).toEqual([]);
    expect(result.failed.sort()).toEqual(["codex", "deepseek"]);
    expect(box.entries).toEqual({ codex: false, deepseek: false });
    for (const row of Object.values(marker())) {
      expect(row.disabled).toBe(true);
      expect(row.retriedCore).toBe(RELEASE);
      expect(row.reason).toContain("the gateway did not report ready with it switched on, so it was switched off again");
    }
    // …and the gateway is brought back WITHOUT them, as the update found it.
    expect(box.events).toEqual(["quiesce", "unquiesce", "restart:1", "quiesce", "unquiesce", "restart:2"]);
  });

  it("leaves a row the restart's own boot script filed again as that boot filed it", async () => {
    writeMarker({ codex: CODEX_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const { recordPluginRepair } = await import("@/lib/plugin-repair");
    const h = hooks({
      onRestart: async () => {
        // The pre-start asked the core itself, got no, switched it off again.
        box.entries.codex = false;
        await recordPluginRepair({
          id: "codex", stage: "consent", disabled: true, spec: "@openclaw/codex@2026.9.4",
          reason: "The ChatGPT (Codex) plugin is installed but its capabilities could not be accepted.",
        });
      },
    });

    const result = await retryPluginRepairsAfterCoreUpdate(h);

    expect(result).toEqual({ release: RELEASE, repaired: [], failed: ["codex"] });
    const row = marker().codex;
    expect(row.reason).toContain("capabilities could not be accepted");
    // Still spent on this core, whoever wrote the row last.
    expect(row.retriedCore).toBe(RELEASE);
  });

  it("counts a row the restart's boot script cleared itself as repaired", async () => {
    writeMarker({ codex: CODEX_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const { clearPluginRepair } = await import("@/lib/plugin-repair");

    const result = await retryPluginRepairsAfterCoreUpdate(hooks({ onRestart: async () => { await clearPluginRepair("codex"); } }));

    expect(result.repaired).toEqual(["codex"]);
    expect(marker()).toEqual({});
  });

  it("repairs a consent row whose payload the core bump stranded as the install it is", async () => {
    writeMarker({ codex: { ...CODEX_ROW, stage: "consent" } });
    box.refuseEnable.set("codex", "Plugin not found: codex");
    const { retryPluginRepairsAfterCoreUpdate } = await load();

    const result = await retryPluginRepairsAfterCoreUpdate(hooks());

    expect(result.repaired).toEqual(["codex"]);
    expect(box.execCalls.map((args) => args.slice(0, 3).join(" "))).toEqual([
      "plugins enable codex",
      "plugins install @openclaw/codex@2026.9.4",
      "plugins inspect codex",
    ]);
  });

  it("installs Codex at the core's own pin for a row filed before rows carried a spec", async () => {
    writeMarker({ codex: { ...CODEX_ROW, spec: "" } });
    const { retryPluginRepairsAfterCoreUpdate } = await load();

    expect((await retryPluginRepairsAfterCoreUpdate(hooks())).repaired).toEqual(["codex"]);
    expect(box.execCalls[0]).toEqual([
      "plugins", "install", "@openclaw/codex@2026.9.4", "--force", "--accept-capabilities",
    ]);
  });

  it("leaves alone what the owner switched off, the channels, and plugins nobody on the box chose", async () => {
    writeMarker({
      codex: { ...CODEX_ROW, disabled: false },
      discord: { ...CODEX_ROW, id: "discord", spec: "@openclaw/discord@2026.9.3" },
      byteplus: { ...CODEX_ROW, id: "byteplus", stage: "not-installed", spec: "@openclaw/byteplus-provider" },
      deepseek: { ...DEEPSEEK_ROW, stage: "not-installed" },
    });
    const before = marker();
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const h = hooks();

    const result = await retryPluginRepairsAfterCoreUpdate(h);

    expect(result.repaired).toEqual([]);
    expect(box.execCalls).toEqual([]);
    expect(h.release).not.toHaveBeenCalled();
    expect(marker()).toEqual(before);
  });

  it("leaves a row another repair is already running alone", async () => {
    writeMarker({ codex: { ...CODEX_ROW, repairingSinceMs: Date.now() - 5_000 } });
    const { retryPluginRepairsAfterCoreUpdate } = await load();

    await retryPluginRepairsAfterCoreUpdate(hooks());

    expect(box.execCalls).toEqual([]);
  });

  it("stands down, and says so, when the installed release cannot be read", async () => {
    writeMarker({ codex: CODEX_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const h = hooks({ release: null });

    const result = await retryPluginRepairsAfterCoreUpdate(h);

    expect(result).toEqual({ release: null, repaired: [], failed: [] });
    expect(box.execCalls).toEqual([]);
    expect(marker().codex).toEqual(CODEX_ROW);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("left to the Retry in Settings"));
  });

  it("stops saying 'Repairing…' when the gateway could not be quiesced at all", async () => {
    writeMarker({ codex: CODEX_ROW });
    const { retryPluginRepairsAfterCoreUpdate } = await load();
    const h = hooks();
    h.quiesce = async () => { throw new Error("could not mask the gateway"); };

    await expect(retryPluginRepairsAfterCoreUpdate(h)).rejects.toThrow("could not mask the gateway");
    expect(marker().codex.repairingSinceMs).toBeUndefined();
    expect(box.execCalls).toEqual([]);
  });
});
