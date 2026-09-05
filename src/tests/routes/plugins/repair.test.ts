import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  restartGateway: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
}));
vi.mock("@/lib/openclaw-deepseek-plugin", () => ({ installDeepseekProviderPlugin: vi.fn() }));
vi.mock("@/lib/plugin-repair", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plugin-repair")>("@/lib/plugin-repair");
  return { ...actual, readPluginRepairs: vi.fn(), clearPluginRepair: vi.fn() };
});

// The Retry behind Settings → "Needs repair" (TASK-606).
//
// Everything worth pinning here is a way of claiming a repair that did not
// happen, or of making one impossible:
//
//   * it must install the SPEC the boot script used — `plugins install codex`
//     resolves `@latest`, drifts ahead of the pinned runtime and crashes every
//     Codex chat, which is the bug the pin exists for;
//   * it must not accept "the CLI can see the package" as consent;
//   * it must put back the entry the boot script switched off, or the badge
//     goes and the plugin still never loads;
//   * and it must restart the gateway, which is what actually loads it.

let POST: (req: Request) => Promise<Response>;
let execFile: Mock;
let getActiveHarness: Mock;
let hasOwnerSession: Mock;
let restartGateway: Mock;
let runOpenclawConfigSet: Mock;
let installDeepseek: Mock;
let readPluginRepairs: Mock;
let clearPluginRepair: Mock;

// `promisify(execFile)` reads the custom symbol at MODULE LOAD, so the symbol
// has to be on the mock before the route is imported — a stub installed later
// is a stub the route never saw. The symbol is therefore wired once per test,
// in beforeEach, to a delegate this holds.
let execImpl: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
let execCalls: string[][];

function stubExec(impl: (cmd: string, args: string[]) => Promise<{ stdout: string }>) {
  execImpl = impl;
}

const LOADED = JSON.stringify({ plugin: { id: "codex", status: "loaded", activated: true } });
const DISCOVERED_ONLY = JSON.stringify({ plugin: { id: "codex", status: "loaded", activated: false } });

function marker(over: Record<string, unknown> = {}) {
  return {
    codex: {
      id: "codex",
      stage: "install",
      reason: "offline",
      atMs: 1,
      disabled: true,
      spec: "@openclaw/codex@2026.8.1",
      ...over,
    },
  };
}

function post(body: unknown) {
  return POST(new Request("http://x/setup-api/plugins/repair", { method: "POST", body: JSON.stringify(body) }));
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ execFile } = (await import("child_process")) as unknown as { execFile: Mock });
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ hasOwnerSession } = (await import("@/lib/owner-session")) as unknown as { hasOwnerSession: Mock });
  ({ restartGateway, runOpenclawConfigSet } =
    (await import("@/lib/openclaw-config")) as unknown as { restartGateway: Mock; runOpenclawConfigSet: Mock });
  ({ installDeepseekProviderPlugin: installDeepseek } =
    (await import("@/lib/openclaw-deepseek-plugin")) as unknown as { installDeepseekProviderPlugin: Mock });
  ({ readPluginRepairs, clearPluginRepair } =
    (await import("@/lib/plugin-repair")) as unknown as { readPluginRepairs: Mock; clearPluginRepair: Mock });
  execCalls = [];
  execImpl = async () => ({ stdout: "" });
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] =
    (cmd: string, args: string[]) => {
      execCalls.push(args);
      return execImpl(cmd, args);
    };
  getActiveHarness.mockResolvedValue("openclaw");
  hasOwnerSession.mockResolvedValue(true);
  restartGateway.mockResolvedValue(undefined);
  runOpenclawConfigSet.mockResolvedValue(undefined);
  clearPluginRepair.mockResolvedValue(true);
  readPluginRepairs.mockResolvedValue(marker());
  ({ POST } = await import("@/app/setup-api/plugins/repair/route"));
});

describe("plugins/repair — the Retry", () => {
  it("refuses the agent", async () => {
    hasOwnerSession.mockResolvedValue(false);
    expect((await post({ pluginId: "codex" })).status).toBe(403);
  });

  it("refuses a plugin the boot script never marked", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    const r = await post({ pluginId: "something-else" });
    expect(r.status).toBe(404);
    // The marker is the allow-list: without it this is "install whatever the
    // caller names", behind an owner cookie.
    expect(execCalls).toEqual([]);
  });

  it("installs the PINNED spec, with --force, and never the bare id", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(200);
    const install = execCalls.find((args) => args[1] === "install");
    expect(install).toEqual([
      "plugins", "install", "@openclaw/codex@2026.8.1", "--force", "--accept-capabilities",
    ]);
  });

  it("routes DeepSeek through its own installer, which knows the clawhub scheme", async () => {
    readPluginRepairs.mockResolvedValue({
      deepseek: { id: "deepseek", stage: "install", reason: "r", atMs: 1, disabled: true, spec: "x" },
    });
    installDeepseek.mockResolvedValue({ installed: "clawhub:@openclaw/deepseek-provider@2026.8.1", failures: [] });
    stubExec(async () => ({ stdout: JSON.stringify({ plugin: { status: "loaded", activated: true } }) }));
    const r = await post({ pluginId: "deepseek" });
    expect(r.status).toBe(200);
    expect(installDeepseek).toHaveBeenCalled();
    expect(execCalls.some((args) => args[1] === "install")).toBe(false);
  });

  it("refuses rather than guessing a spec for a marker written before the field existed", async () => {
    readPluginRepairs.mockResolvedValue(marker({ spec: "" }));
    stubExec(async () => ({ stdout: LOADED }));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "no_spec" });
    expect(execCalls).toEqual([]);
  });

  it("does NOT accept a plugin the harness merely discovered as repaired", async () => {
    // `status: loaded` with `activated: false` is exactly the state that
    // refuses gateway readiness: the package is there, its capability surface
    // is not accepted.
    stubExec(async () => ({ stdout: DISCOVERED_ONLY }));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(502);
    expect(clearPluginRepair).not.toHaveBeenCalled();
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
  });

  it("keeps the badge when the device could not be asked at all", async () => {
    stubExec(async (_cmd, args) => {
      if (args[1] === "inspect") throw new Error("timed out");
      return { stdout: "" };
    });
    const r = await post({ pluginId: "codex" });
    expect(await r.json()).toMatchObject({ code: "unverified" });
    expect(clearPluginRepair).not.toHaveBeenCalled();
  });

  it("puts back the entry the boot script switched off, then restarts", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith(['plugins.entries["codex"].enabled', "true", "--strict-json"]);
    expect(clearPluginRepair).toHaveBeenCalledWith("codex");
    expect(restartGateway).toHaveBeenCalled();
    expect(await r.json()).toMatchObject({ ok: true, restarted: true });
  });

  it("says the restart did not happen rather than folding it into the verdict", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    restartGateway.mockRejectedValue(new Error("gateway did not come back"));
    const r = await post({ pluginId: "codex" });
    expect(await r.json()).toMatchObject({ ok: true, restarted: false });
  });

  it("is inert on Hermes", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    expect((await post({ pluginId: "codex" })).status).toBe(404);
  });
});
