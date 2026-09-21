import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * On Hermes, `hermes model` reports `authenticated: true` for every
 * user-defined provider that has a base_url — it never looks for a key. The
 * ClawBox AI block is one of those, and it stays in config.yaml after the
 * token is gone. The status strip trusted that flag first, so a box with no
 * ClawBox AI credential anywhere read "ClawBox AI: Connected" while
 * /setup-api/hermes/clawai answered `hasToken: false` — the wizard then
 * opened its provider step on a "Connected" card with a "Get device code"
 * button underneath (seen on a test box, 2026-09-16).
 */

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ clawaiTokenRejectedByPortal: vi.fn(() => false) }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn(async () => ({})) }));
vi.mock("@/lib/hermes-model-options", () => ({ getModelOptions: vi.fn(), probeStillOwed: vi.fn(async () => false) }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/plugin-repair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugin-repair")>()),
  readPluginRepairs: vi.fn(async () => ({})),
}));
vi.mock("@/lib/provider-runnable", () => ({ readProviderRunnable: vi.fn(async () => new Map()) }));
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async () => null),
}));

const catalogue = (clawaiAuthenticated: boolean, currentProvider = "openrouter") => ({
  stale: false,
  current: { provider: currentProvider, model: "" },
  providers: [
    { id: "clawai", name: "clawai", authenticated: clawaiAuthenticated, isUserDefined: true, source: "user-config", total: 2, models: [] },
    { id: "openrouter", name: "OpenRouter", authenticated: false, isUserDefined: false, source: "canonical", total: 0, models: [] },
  ],
});

let readProviderStatus: typeof import("@/lib/provider-status").readProviderStatus;
let hasClawaiToken: Mock;
let runHermesCli: Mock;
let getModelOptions: Mock;

beforeEach(async () => {
  vi.resetModules();
  ((await import("@/lib/harness")) as unknown as { getActiveHarness: Mock }).getActiveHarness.mockResolvedValue("hermes");
  ({ hasClawaiToken } = (await import("@/lib/harness/credentials")) as unknown as { hasClawaiToken: Mock });
  ({ runHermesCli } = (await import("@/lib/hermes-cli")) as unknown as { runHermesCli: Mock });
  ({ getModelOptions } = (await import("@/lib/hermes-model-options")) as unknown as { getModelOptions: Mock });
  hasClawaiToken.mockResolvedValue(false);
  // `hermes config get` on an unset key: non-zero, "Config key not set".
  runHermesCli.mockResolvedValue({ code: 1, stdout: "", stderr: "Config key not set: providers.clawai.api_key" });
  getModelOptions.mockResolvedValue(catalogue(true));
  ({ readProviderStatus } = await import("@/lib/provider-status"));
});

afterEach(() => vi.clearAllMocks());

async function clawaiState() {
  const summary = await readProviderStatus();
  return summary.providers.find((p) => p.id === "clawai")?.state;
}

describe("ClawBox AI on Hermes is connected only when a credential exists", () => {
  it("is disconnected when the harness says authenticated but no token exists anywhere", async () => {
    expect(await clawaiState()).toBe("disconnected");
  });

  it("says NEEDS SIGN-IN, not connected, when that keyless block is also the active provider", async () => {
    // The box the owner saw: `model.provider: clawai`, no token anywhere, and
    // the card read "Connected" with a "Get device code" button under it.
    getModelOptions.mockResolvedValue(catalogue(true, "clawai"));
    const summary = await readProviderStatus();
    const row = summary.providers.find((p) => p.id === "clawai");
    expect(row?.isDefault).toBe(true);
    expect(row?.state).toBe("needs-reauth");
  });

  it("is connected on the store's token", async () => {
    hasClawaiToken.mockResolvedValue(true);
    expect(await clawaiState()).toBe("connected");
  });

  it("is connected on a key in the harness's own providers.clawai block (a migrated box)", async () => {
    runHermesCli.mockResolvedValue({ code: 0, stdout: "claw_" + "x".repeat(40) + "\n", stderr: "" });
    expect(await clawaiState()).toBe("connected");
    expect(runHermesCli).toHaveBeenCalledWith(["config", "get", "providers.clawai.api_key"], expect.anything());
  });

  it("is UNKNOWN, never needs-sign-in, when the harness could not be asked (a timed-out read)", async () => {
    getModelOptions.mockResolvedValue(catalogue(true, "clawai"));
    runHermesCli.mockResolvedValue({ code: null, stdout: "", stderr: "hermes config get timed out" });
    expect(await clawaiState()).toBe("unknown");
  });

  it("still reports the other rows from the harness's flag", async () => {
    getModelOptions.mockResolvedValue(catalogue(true, ""));
    const summary = await readProviderStatus();
    expect(summary.providers.find((p) => p.id === "openrouter")?.state).toBe("disconnected");
  });
});
