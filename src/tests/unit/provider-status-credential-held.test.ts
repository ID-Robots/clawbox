/**
 * `credentialHeld` on the provider rows (src/lib/provider-status.ts): the one
 * fact that tells the two "needs sign-in" rows apart, so the provider list can
 * offer a sign-out of a refused credential that is still on the box — the
 * default ClawBox AI's included — and never of a default left with nothing to
 * remove (ClawBox AI's after its own sign-out).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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

let readProviderStatus: typeof import("@/lib/provider-status").readProviderStatus;
let getActiveHarness: Mock;
let hasClawaiToken: Mock;
let refused: Mock;
let readConfig: Mock;
let runHermesCli: Mock;
let getModelOptions: Mock;

beforeEach(async () => {
  vi.resetModules();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ hasClawaiToken } = (await import("@/lib/harness/credentials")) as unknown as { hasClawaiToken: Mock });
  ({ clawaiTokenRejectedByPortal: refused } = (await import("@/lib/clawbox-ai-portal-tier")) as unknown as { clawaiTokenRejectedByPortal: Mock });
  ({ readConfig } = (await import("@/lib/openclaw-config")) as unknown as { readConfig: Mock });
  ({ runHermesCli } = (await import("@/lib/hermes-cli")) as unknown as { runHermesCli: Mock });
  ({ getModelOptions } = (await import("@/lib/hermes-model-options")) as unknown as { getModelOptions: Mock });
  hasClawaiToken.mockResolvedValue(false);
  refused.mockReturnValue(false);
  runHermesCli.mockResolvedValue({ code: 1, stdout: "", stderr: "Config key not set: providers.clawai.api_key" });
  ({ readProviderStatus } = await import("@/lib/provider-status"));
});

afterEach(() => vi.clearAllMocks());

async function row(id: string) {
  return (await readProviderStatus()).providers.find((r) => r.id === id);
}

describe("credentialHeld — OpenClaw", () => {
  beforeEach(() => {
    getActiveHarness.mockResolvedValue("openclaw");
    readConfig.mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
      models: { providers: { deepseek: { baseUrl: "https://proxy" }, openrouter: { apiKey: "sk-or-placeholder-0123" } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    });
  });

  it("a refused ClawBox AI token on the default row is still held", async () => {
    refused.mockReturnValue(true);
    expect(await row("clawai")).toMatchObject({ state: "needs-reauth", isDefault: true, credentialHeld: true });
  });

  it("the default ClawBox AI row left with nothing holds none", async () => {
    readConfig.mockResolvedValue({
      models: { providers: { deepseek: { baseUrl: "https://proxy" } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    });
    expect(await row("clawai")).toMatchObject({ state: "needs-reauth", isDefault: true, credentialHeld: false });
  });

  it("a connected row holds its credential, an unconnected one does not", async () => {
    expect(await row("openrouter")).toMatchObject({ state: "connected", credentialHeld: true });
    expect(await row("google")).toMatchObject({ state: "disconnected", credentialHeld: false });
  });
});

describe("credentialHeld — Hermes", () => {
  beforeEach(() => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue({
      stale: false,
      current: { provider: "clawai", model: "" },
      providers: [
        { id: "clawai", name: "clawai", authenticated: true, isUserDefined: true, source: "user-config", total: 2, models: [] },
        { id: "openrouter", name: "OpenRouter", authenticated: true, isUserDefined: false, source: "canonical", total: 3, models: [] },
      ],
    });
  });

  it("the default ClawBox AI row after its sign-out holds none", async () => {
    expect(await row("clawai")).toMatchObject({ state: "needs-reauth", isDefault: true, credentialHeld: false });
  });

  it("a refused ClawBox AI token is still held", async () => {
    hasClawaiToken.mockResolvedValue(true);
    refused.mockReturnValue(true);
    expect(await row("clawai")).toMatchObject({ state: "needs-reauth", credentialHeld: true });
  });

  it("a provider the dashboard calls authenticated holds its credential", async () => {
    expect(await row("openrouter")).toMatchObject({ state: "connected", credentialHeld: true });
  });
});
