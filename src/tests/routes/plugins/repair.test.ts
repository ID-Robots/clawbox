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
vi.mock("@/lib/openclaw-deepseek-plugin", () => ({
  installDeepseekProviderPlugin: vi.fn(),
  // The core on the box, which a stale spec is moved onto (TASK-1088). Null by
  // default: most cases here are about a row written against THIS core.
  installedOpenclawRelease: vi.fn(),
}));
vi.mock("@/lib/plugin-repair", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plugin-repair")>("@/lib/plugin-repair");
  return {
    ...actual,
    readPluginRepairs: vi.fn(),
    clearPluginRepair: vi.fn(),
    clearPluginRepairUnlessRefiled: vi.fn(),
    setPluginRepairInProgress: vi.fn(),
    claimPluginRepair: vi.fn(),
  };
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
let installedRelease: Mock;
let readPluginRepairs: Mock;
let clearPluginRepair: Mock;
let clearUnlessRefiled: Mock;
let setInProgress: Mock;
let claimRepair: Mock;

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
  ({ installDeepseekProviderPlugin: installDeepseek, installedOpenclawRelease: installedRelease } =
    (await import("@/lib/openclaw-deepseek-plugin")) as unknown as {
      installDeepseekProviderPlugin: Mock;
      installedOpenclawRelease: Mock;
    });
  ({
    readPluginRepairs,
    clearPluginRepair,
    clearPluginRepairUnlessRefiled: clearUnlessRefiled,
    setPluginRepairInProgress: setInProgress,
    claimPluginRepair: claimRepair,
  } = (await import("@/lib/plugin-repair")) as unknown as {
    readPluginRepairs: Mock;
    clearPluginRepair: Mock;
    clearPluginRepairUnlessRefiled: Mock;
    setPluginRepairInProgress: Mock;
    claimPluginRepair: Mock;
  });
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
  clearUnlessRefiled.mockResolvedValue("cleared");
  setInProgress.mockResolvedValue(true);
  claimRepair.mockResolvedValue("claimed");
  installedRelease.mockResolvedValue(null);
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

  it("asks the registry again on a press, even when this core's build is on record as missing (TASK-1206)", async () => {
    // Every other path believes the recorded "no build for this core"; a person
    // pressing Retry is asking exactly that question again.
    readPluginRepairs.mockResolvedValue({
      deepseek: { id: "deepseek", stage: "install", reason: "r", atMs: 1, disabled: true, spec: "x" },
    });
    installDeepseek.mockResolvedValue({ installed: "clawhub:@openclaw/deepseek-provider@2026.8.1", failures: [], unavailable: false });
    stubExec(async () => ({ stdout: JSON.stringify({ plugin: { status: "loaded", activated: true } }) }));
    expect((await post({ pluginId: "deepseek" })).status).toBe(200);
    expect(installDeepseek).toHaveBeenCalledWith({ force: true, recheckUnavailable: true });
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
    expect(clearUnlessRefiled).not.toHaveBeenCalled();
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
    expect(clearUnlessRefiled).not.toHaveBeenCalled();
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
    // Cleared against the row it set out to repair (its `atMs`), so a row the
    // restart filed again is never the one removed — see the case below.
    expect(clearUnlessRefiled).toHaveBeenCalledWith("codex", 1);
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
    expect(clearUnlessRefiled).not.toHaveBeenCalled();
    // …and it stops saying "Repairing…": this press is over.
    expect(setInProgress).toHaveBeenLastCalledWith("codex", false);
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
    clearUnlessRefiled.mockRejectedValue(new Error("read-only filesystem"));
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
    expect(clearUnlessRefiled).toHaveBeenCalledWith("codex", 1);
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
    expect(clearUnlessRefiled).not.toHaveBeenCalled();
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

  it("INSTALLS a not-installed row rather than trying to enable a package that is not there", async () => {
    // TASK-738. The third stage records an entry a core bump stranded: the
    // core has no package for it at all, so `plugins enable` answers "Plugin
    // not found" and the badge could never clear. The branch used to be
    // `stage !== "install"`, which sent exactly this row to that verb.
    //
    // And this is the ONLY place the install happens: the updater switched the
    // entry off and never fetched anything, because consenting to the declared
    // capabilities of a plugin the owner did not choose is not the box's call.
    // Here it is his press.
    readPluginRepairs.mockResolvedValue({
      byteplus: {
        id: "byteplus",
        stage: "not-installed",
        reason: "plugin not installed: byteplus — install the official external plugin"
          + " with: openclaw plugins install @openclaw/byteplus-provider",
        atMs: 1,
        disabled: true,
        spec: "@openclaw/byteplus-provider",
      },
    });
    stubExec(async () => ({ stdout: JSON.stringify({ plugin: { id: "byteplus", status: "loaded", activated: true } }) }));

    const r = await post({ pluginId: "byteplus" });

    expect(r.status).toBe(200);
    expect(execCalls).toEqual([
      ["plugins", "install", "@openclaw/byteplus-provider", "--force", "--accept-capabilities"],
      ["plugins", "inspect", "byteplus", "--runtime", "--json"],
    ]);
    // And the entry ClawBox switched off is switched back on, or the package
    // comes back to a plugin that still cannot load.
    expect(runOpenclawConfigSet).toHaveBeenCalledWith(
      ['plugins.entries["byteplus"].enabled', "true", "--strict-json"],
    );
  });
});

// TASK-1088. A box that failed its V4.0 update against OpenClaw 2026.9.3 came
// out of the 2026.9.4 update with ChatGPT and ClawBox AI both "Needs repair",
// over rows filed against the OLD core. These are the ways the Retry on those
// rows could not recover them, or said it had when it had not.
describe("plugins/repair — a row an older core left (TASK-1088)", () => {
  it("installs the package built for the core that is on the box, not the one the row names", async () => {
    readPluginRepairs.mockResolvedValue(marker({ spec: "@openclaw/codex@2026.9.3" }));
    installedRelease.mockResolvedValue("2026.9.4");
    stubExec(async () => ({ stdout: LOADED }));

    const r = await post({ pluginId: "codex" });

    expect(r.status).toBe(200);
    // `@openclaw/codex@2026.9.3` on a 2026.9.4 runtime is the version skew the
    // pin exists to prevent, in the other direction.
    expect(execCalls[0]).toEqual([
      "plugins", "install", "@openclaw/codex@2026.9.4", "--force", "--accept-capabilities",
    ]);
  });

  it("repairs a consent row whose payload the core bump stranded as the install it is", async () => {
    // Payloads live in npm projects keyed to the core generation, so the new
    // core answers `plugins enable codex` with "Plugin not found" — and the
    // Retry used to run that same refused verb on every press, for ever.
    readPluginRepairs.mockResolvedValue(marker({ stage: "consent", spec: "@openclaw/codex@2026.9.3" }));
    installedRelease.mockResolvedValue("2026.9.4");
    stubExec(async (_cmd, args) => {
      if (args[1] === "enable") {
        throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "Plugin not found: codex" });
      }
      return { stdout: args[1] === "inspect" ? LOADED : "" };
    });

    const r = await post({ pluginId: "codex" });

    expect(r.status).toBe(200);
    expect(execCalls).toEqual([
      ["plugins", "enable", "codex", "--accept-capabilities"],
      ["plugins", "install", "@openclaw/codex@2026.9.4", "--force", "--accept-capabilities"],
      ["plugins", "inspect", "codex", "--runtime", "--json"],
    ]);
    expect(clearUnlessRefiled).toHaveBeenCalledWith("codex", 1);
  });

  it("does not escalate a consent refusal that is not a missing payload", async () => {
    readPluginRepairs.mockResolvedValue(marker({ stage: "consent" }));
    stubExec(async (_cmd, args) => {
      if (args[1] === "enable") throw Object.assign(new Error("Command failed"), { code: 1, stderr: "registry locked" });
      return { stdout: LOADED };
    });

    const r = await post({ pluginId: "codex" });

    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, code: "repair_failed" });
    expect(execCalls.some((args) => args[1] === "install")).toBe(false);
    // `plugins enable` writes `enabled: true` before it fails; the entry
    // ClawBox had switched off is put back off.
    expect(runOpenclawConfigSet).toHaveBeenLastCalledWith(
      ['plugins.entries["codex"].enabled', "false", "--strict-json"],
    );
  });

  it("keeps the badge when the restart's own boot script filed the row again", async () => {
    // The restart runs the boot script, which asks the core about this plugin
    // itself; when it still says no, it switches the plugin off again and
    // re-files the row with the cause. Clearing by id deleted that record: the
    // badge went and ChatGPT read "connected" while switched off.
    stubExec(async () => ({ stdout: LOADED }));
    clearUnlessRefiled.mockResolvedValue("refiled");

    const r = await post({ pluginId: "codex" });

    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, code: "refused_at_start" });
  });

  it("counts a row the boot script cleared itself as repaired", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    clearUnlessRefiled.mockResolvedValue("absent");

    const r = await post({ pluginId: "codex" });

    expect(await r.json()).toMatchObject({ ok: true, restarted: true, markerCleared: true });
  });

  it("says the row is being repaired while it runs, and stops saying so when it fails", async () => {
    stubExec(async () => ({ stdout: DISCOVERED_ONLY }));

    await post({ pluginId: "codex" });

    expect(claimRepair.mock.calls).toEqual([["codex"]]);
    expect(setInProgress.mock.calls).toEqual([["codex", false]]);
  });

  // TASK-1198. The stamp is what makes the NEXT press a 409, so a press that
  // leaves one behind locks the Retry for `PLUGIN_REPAIR_IN_PROGRESS_MS`. A
  // repair that THREW used to do exactly that: every branch ended the stamp
  // except the one nobody wrote.
  it("ends the stamp when the repair throws, and answers a failure rather than a 500", async () => {
    readPluginRepairs.mockResolvedValue({
      deepseek: { id: "deepseek", stage: "install", reason: "r", atMs: 1, disabled: true, spec: "x" },
    });
    installDeepseek.mockRejectedValue(new Error("ENOSPC: no space left on device"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await post({ pluginId: "deepseek" });

    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, code: "repair_failed" });
    expect(setInProgress.mock.calls).toEqual([["deepseek", false]]);
    expect(restartGateway).not.toHaveBeenCalled();
    expect(clearUnlessRefiled).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ends the stamp when the restart throws after a verified repair", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    restartGateway.mockRejectedValue(new Error("Unit is masked"));

    const r = await post({ pluginId: "codex" });

    expect(await r.json()).toMatchObject({ ok: true, restarted: false, markerCleared: false });
    expect(setInProgress.mock.calls).toEqual([["codex", false]]);
  });

  it("ends the stamp when the clear itself throws", async () => {
    stubExec(async () => ({ stdout: LOADED }));
    clearUnlessRefiled.mockRejectedValue(new Error("EROFS"));

    const r = await post({ pluginId: "codex" });

    expect(await r.json()).toMatchObject({ ok: true, markerCleared: false });
    expect(setInProgress.mock.calls).toEqual([["codex", false]]);
  });

  it.each(["cleared", "absent", "refiled"])(
    "leaves the stamp alone once the row itself is %s — it may be another press's by then",
    async (outcome) => {
      stubExec(async () => ({ stdout: LOADED }));
      clearUnlessRefiled.mockResolvedValue(outcome);

      await post({ pluginId: "codex" });

      expect(setInProgress).not.toHaveBeenCalled();
    },
  );

  it("refuses the press that lost the claim, even though the row read idle a moment earlier", async () => {
    // Two presses both read the row before either stamped it: the check and
    // the stamp are one step in the store, so exactly one of them starts.
    claimRepair.mockResolvedValue("busy");
    stubExec(async () => ({ stdout: LOADED }));

    const r = await post({ pluginId: "codex" });

    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, code: "repair_in_progress" });
    expect(execCalls).toEqual([]);
    expect(setInProgress).not.toHaveBeenCalled();
  });

  it("refuses a second press while a repair of the row is running", async () => {
    readPluginRepairs.mockResolvedValue(marker({ repairingSinceMs: Date.now() - 1_000 }));
    claimRepair.mockResolvedValue("busy");
    stubExec(async () => ({ stdout: LOADED }));

    const r = await post({ pluginId: "codex" });

    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, code: "repair_in_progress" });
    expect(execCalls).toEqual([]);
  });

  it("answers not_marked for a row cleared between the read and the claim", async () => {
    claimRepair.mockResolvedValue("absent");

    const r = await post({ pluginId: "codex" });

    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, code: "not_marked" });
    expect(execCalls).toEqual([]);
  });

  it("still repairs when the store cannot take the claim, but not over a stamp it read", async () => {
    claimRepair.mockRejectedValue(new Error("EROFS: read-only file system"));
    stubExec(async () => ({ stdout: LOADED }));
    expect((await post({ pluginId: "codex" })).status).toBe(200);

    readPluginRepairs.mockResolvedValue(marker({ repairingSinceMs: Date.now() - 1_000 }));
    expect((await post({ pluginId: "codex" })).status).toBe(409);
  });

  it("does not believe a stamp a killed repair left behind", async () => {
    readPluginRepairs.mockResolvedValue(marker({ repairingSinceMs: Date.now() - 60 * 60_000 }));
    stubExec(async () => ({ stdout: LOADED }));

    expect((await post({ pluginId: "codex" })).status).toBe(200);
  });

  it("lists a row being repaired as repairing, and only while the stamp is fresh", async () => {
    readPluginRepairs.mockResolvedValue({
      ...marker({ repairingSinceMs: Date.now() - 1_000 }),
      deepseek: {
        id: "deepseek", stage: "install", reason: "r", atMs: 2, disabled: true, spec: "",
        repairingSinceMs: Date.now() - 60 * 60_000,
      },
    });
    const body = await (await GET(new Request("http://x/setup-api/plugins/repair"))).json() as {
      repairs: Record<string, unknown>[];
    };
    expect(body.repairs).toEqual([
      { pluginId: "codex", stage: "install", reason: "offline", atMs: 1, repairing: true },
      { pluginId: "deepseek", stage: "install", reason: "r", atMs: 2 },
    ]);
  });
});
