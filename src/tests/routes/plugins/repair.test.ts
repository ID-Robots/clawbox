import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  // The route resolves the binary through the repo's own resolver rather than
  // guessing a path; the tests pin the argv, not where the binary lives.
  findOpenclawBin: vi.fn(() => "/usr/bin/openclaw"),
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

let GET: (req: Request) => Promise<Response>;
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
  ({ GET, POST } = await import("@/app/setup-api/plugins/repair/route"));
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
    // The entry is put back so the runtime can be asked about the repaired
    // state, and switched off again when the answer is no — so what matters is
    // where it is LEFT, not that it was never touched. See the two cases at the
    // end of this file for the ordering that makes both halves necessary.
    expect(runOpenclawConfigSet.mock.calls.at(-1)?.[0]).toEqual(
      ['plugins.entries["codex"].enabled', "false", "--strict-json"],
    );
  });

  it("keeps the badge when the device could not be asked at all", async () => {
    stubExec(async (_cmd, args) => {
      if (args[1] === "inspect") throw new Error("timed out");
      return { stdout: "" };
    });
    const r = await post({ pluginId: "codex" });
    expect(await r.json()).toMatchObject({ code: "unverified" });
    expect(clearPluginRepair).not.toHaveBeenCalled();
    // AND THE ENTRY IS LEFT ON. "The box could not be asked" is not "the plugin
    // does not load" — the inspect module-loads every enabled plugin and times
    // out on exactly the box whose gateway has just failed to come back — so
    // switching it off here would take a working plugin down on a click that
    // changed nothing, with no boot path to put it back.
    expect(runOpenclawConfigSet.mock.calls.map(([args]) => (args as string[]).join(" "))).toEqual([
      'plugins.entries["codex"].enabled true --strict-json',
    ]);
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

  it("keeps the badge when the gateway did not come back", async () => {
    // The restart is what LOADS the repaired plugin. Until it happens the
    // plugin is installed, consented and enabled — and still not running — so
    // taking the badge away would tell the owner it is working. The repair
    // itself did happen, which is why this is not an error: `ok: true` with
    // `restarted: false` and the marker left in place, and the boot script
    // clears it itself on the next successful start.
    stubExec(async () => ({ stdout: LOADED }));
    restartGateway.mockRejectedValue(new Error("gateway did not come back"));
    const r = await post({ pluginId: "codex" });
    expect(await r.json()).toMatchObject({ ok: true, restarted: false, markerCleared: false });
    expect(clearPluginRepair).not.toHaveBeenCalled();
  });

  it("is inert on Hermes", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    expect((await post({ pluginId: "codex" })).status).toBe(404);
  });
  it("refuses a POST that another site's page fired at the box", async () => {
    // The owner's cookie rides on a cross-site POST, and `hasOwnerSession`
    // alone cannot tell the two apart. The blast radius is small — the marker
    // is the allow-list and the spec comes from it, so nothing attacker-chosen
    // reaches an argv — but a state-changing owner route that installs a
    // package and restarts the gateway should not be startable from anywhere.
    const r = await POST(new Request("http://box.local/setup-api/plugins/repair", {
      method: "POST",
      headers: { origin: "http://evil.example", host: "box.local" },
      body: JSON.stringify({ pluginId: "codex" }),
    }));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, code: "cross_origin" });
    expect(execCalls).toEqual([]);
  });

  it("allows the box's own page", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    const r = await POST(new Request("http://box.local/setup-api/plugins/repair", {
      method: "POST",
      headers: { origin: "http://box.local", host: "box.local" },
      body: JSON.stringify({ pluginId: "codex" }),
    }));
    expect(r.status).toBe(200);
  });

  it("answers unverified when the runtime inspection prints literal null", async () => {
    // `JSON.parse("null")` succeeds, so reading `.plugin` off it threw out of
    // POST as an unstructured 500 — where the route's own answer for "the box
    // could not be asked" is a 502 the panel already renders.
    stubExec(async (_cmd, args) => ({ stdout: args[1] === "inspect" ? "null" : "" }));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, code: "unverified" });
  });

  it("says the badge may still be there when the marker could not be cleared", async () => {
    // The repair DID happen, so this is not a failure — turning it into one
    // would be the false failure this card is full of. What the owner must not
    // get is a plain success over a badge that is still on screen.
    stubExec(async () => ({ stdout: LOADED }));
    clearPluginRepair.mockRejectedValue(new Error("read-only filesystem"));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, markerCleared: false });
  });
  it("puts the entry back BEFORE asking the runtime whether the repair worked", async () => {
    // `openclaw plugins install` deliberately leaves an entry whose
    // `plugins.entries.<id>.enabled` is explicitly `false` alone — and that is
    // exactly the state the boot script's own boot-without wrote. So the
    // install succeeds, the payload is back, and `plugins inspect --runtime`
    // still answers `status: "disabled"`: the Retry answered `repair_failed`
    // for ever on precisely the markers it exists to clear.
    readPluginRepairs.mockResolvedValue(marker({ stage: "install", disabled: true }));
    const reenabled = () => runOpenclawConfigSet.mock.calls.some(
      ([args]) => (args as string[])[0] === 'plugins.entries["codex"].enabled'
        && (args as string[])[1] === "true",
    );
    stubExec(async (_cmd, args) => ({
      stdout: args[1] === "inspect"
        ? (reenabled() ? LOADED : JSON.stringify({ plugin: { id: "codex", status: "disabled", activated: false } }))
        : "",
    }));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, pluginId: "codex" });
    expect(clearPluginRepair).toHaveBeenCalledWith("codex");
  });

  it("switches the entry back off when the plugin still does not load", async () => {
    // The re-enable is a step of the repair, not its verdict. If the runtime
    // still refuses the plugin, leaving the entry enabled would hand the next
    // boot the readiness refusal this whole card exists to end — so the box is
    // left exactly as it was found, badge and all.
    readPluginRepairs.mockResolvedValue(marker({ stage: "install", disabled: true }));
    stubExec(async (_cmd, args) => ({ stdout: args[1] === "inspect" ? DISCOVERED_ONLY : "" }));
    const r = await post({ pluginId: "codex" });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, code: "repair_failed" });
    expect(runOpenclawConfigSet.mock.calls.map(([args]) => (args as string[]).join(" "))).toEqual([
      'plugins.entries["codex"].enabled true --strict-json',
      'plugins.entries["codex"].enabled false --strict-json',
    ]);
    expect(clearPluginRepair).not.toHaveBeenCalled();
  });
  it("refuses the agent on the read too", async () => {
    // Same gate as the write. Middleware admits the MCP bearer to `/setup-api`,
    // and which of the box's plugins ClawBox had to switch off is the owner's
    // business, not the agent's.
    hasOwnerSession.mockResolvedValue(false);
    const r = await GET(new Request("http://x/setup-api/plugins/repair"));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, code: "owner_only" });
  });

  it("lists what needs repair, projected rather than passed through", async () => {
    readPluginRepairs.mockResolvedValue(marker());
    const r = await GET(new Request("http://x/setup-api/plugins/repair"));
    expect(r.status).toBe(200);
    // Never cached: the panel polls this to decide whether to draw a badge, and
    // a cached answer would keep one on a row that has since been repaired.
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const body = await r.json() as { ok: boolean; repairs: Record<string, unknown>[] };
    expect(body.ok).toBe(true);
    // The FIELDS THE PANEL DRAWS, and only those. `spec` and `disabled` are
    // this script's own bookkeeping — the install spec in particular names
    // internal package coordinates — and the browser has no use for either.
    expect(body.repairs).toEqual([
      { pluginId: "codex", stage: "install", reason: "offline", atMs: 1 },
    ]);
  });

  it("answers an empty list rather than an error on a box with nothing wrong", async () => {
    readPluginRepairs.mockResolvedValue({});
    const r = await GET(new Request("http://x/setup-api/plugins/repair"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, repairs: [] });
  });
  it("asks the registry by the plugin's bare id, whatever key the marker used", async () => {
    // `plugins enable` and `plugins inspect` look the id up in the registry
    // report, which keys plugins by their bare manifest id — so a row filed as
    // `@openclaw/discord` answered "plugin not found" on every press and the
    // badge never cleared. The CONFIG writes keep the literal key, because they
    // address the config by the key it carries.
    readPluginRepairs.mockResolvedValue({
      "@openclaw/discord": {
        id: "@openclaw/discord", stage: "consent", reason: "no", atMs: 1, disabled: true, spec: "",
      },
    });
    stubExec(async () => ({ stdout: JSON.stringify({ plugin: { id: "discord", status: "loaded", activated: true } }) }));
    const r = await post({ pluginId: "discord" });
    expect(r.status).toBe(200);
    expect(execCalls).toEqual([
      ["plugins", "enable", "discord", "--accept-capabilities"],
      ["plugins", "inspect", "discord", "--runtime", "--json"],
    ]);
    // …and the config is still addressed by the key openclaw.json carries.
    expect(runOpenclawConfigSet).toHaveBeenCalledWith(
      ['plugins.entries["@openclaw/discord"].enabled', "true", "--strict-json"],
    );
  });
});
