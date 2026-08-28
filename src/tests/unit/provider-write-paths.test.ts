import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OTHER four write paths that move the provider set.
 *
 * The customer-facing pair (`/setup-api/hermes/provider-key` and the OAuth
 * completion) is pinned in src/tests/routes/hermes/provider-mcp-refresh.test.ts.
 * These are the rest of what
 *
 *   grep -rn "invalidateModelOptions()" src mcp --include=*.ts | grep -v /tests/
 *
 * finds — every place that already tells the BROWSER the catalogue moved, which
 * is exactly the population that has to tell the running agent too. Wiring four
 * of six is how #514 came back as a residual in the first place.
 */

const rpcMock = vi.hoisted(() => vi.fn());
const cliMock = vi.hoisted(() => vi.fn());
const optionsMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const readConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn(async () => null), setMany: vi.fn() }));
vi.mock("@/lib/hermes-config-yaml", () => ({
  patchHermesConfig: patchMock,
  readHermesConfigValue: readConfigMock,
}));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "local-token-xyz" }));
vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyRootUrl: () => "http://127.0.0.1",
  getLocalAiOpenAiBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/ollama/v1",
}));
vi.mock("@/lib/hermes-model-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-model-options")>()),
  getModelOptions: optionsMock,
  invalidateModelOptions: vi.fn(),
}));

import { applyCloudProviderKeyToHermes } from "@/lib/hermes-cloud-provider";
import { applyLocalAiToHermes, removeLocalAiFromHermes } from "@/lib/hermes-local-ai";

function payload(ids: string[], current = "openrouter") {
  return {
    providers: ids.map((id) => ({
      id,
      name: id,
      authenticated: true,
      verified: null,
      isUserDefined: false,
      source: "dashboard",
      total: 1,
      models: [{ id: `${id}-model`, description: "" }],
    })),
    current: { provider: current, model: `${current}-model` },
    reasoning: "",
    fetchedAt: Date.now(),
    source: "dashboard" as const,
    stale: false,
  };
}

/** Answer the "before" read with `first`, every later read with `second`. */
function catalogueGrows(first: string[], second: string[], current = "openrouter") {
  let seen = 0;
  optionsMock.mockImplementation(async () => payload(seen++ === 0 ? first : second, current));
}

function reloadCount(): number {
  return rpcMock.mock.calls.filter((call) => call[0] === "reload.mcp").length;
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ status: "ok" });
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  optionsMock.mockReset();
  patchMock.mockReset();
  patchMock.mockResolvedValue(undefined);
  readConfigMock.mockReset();
  readConfigMock.mockResolvedValue(null);
});

describe("saving a cloud provider key through the OpenClaw-shaped panel", () => {
  it("re-advertises the providers the agent may switch to", async () => {
    catalogueGrows(["openrouter"], ["openrouter", "anthropic"], "openrouter");
    await applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: "sk-abcdefgh" });
    expect(reloadCount()).toBe(1);
  });

  it("asks for nothing when hermes refused the key", async () => {
    // `hermes auth add` failed, so nothing was credentialed — and the catalogue
    // says so. The set is what decides, not the fact that a call threw.
    catalogueGrows(["openrouter"], ["openrouter"]);
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "nope" });
    await expect(
      applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: "sk-abcdefgh" }),
    ).rejects.toThrow();
    expect(reloadCount()).toBe(0);
  });

  it("still re-advertises when the key landed and a LATER step threw", async () => {
    // The credential is stored first, and selecting the provider or the model
    // can still fail after it. The provider is credentialed by then and the
    // agent's enum is already stale, so reconciling only on success would be
    // this PR's own bug one level up.
    catalogueGrows(["openrouter"], ["openrouter", "anthropic"], "openrouter");
    cliMock.mockImplementation(async (args: string[]) =>
      args[0] === "auth"
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "could not select" },
    );
    await expect(
      applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: "sk-abcdefgh" }),
    ).rejects.toThrow();
    expect(reloadCount()).toBe(1);
  });
});

describe("turning the local model on and off", () => {
  it("re-advertises the providers when the local one is registered", async () => {
    catalogueGrows(["openrouter"], ["openrouter", "local"], "openrouter");
    await applyLocalAiToHermes({ provider: "ollama", model: "gemma4:e2b", makeDefault: false });
    expect(reloadCount()).toBe(1);
  });

  it("re-advertises the providers when the local one is removed", async () => {
    // The stale enum pointing the other way: an `ai_set_provider` value the
    // device no longer serves, which `/setup-api/hermes/models` answers with
    // "Unknown provider".
    catalogueGrows(["openrouter", "local"], ["openrouter"], "openrouter");
    await removeLocalAiFromHermes();
    expect(reloadCount()).toBe(1);
  });

  it("costs nothing when the set did not actually move", async () => {
    catalogueGrows(["openrouter", "local"], ["openrouter", "local"], "openrouter");
    await applyLocalAiToHermes({ provider: "ollama", model: "gemma4:e2b", makeDefault: false });
    expect(reloadCount()).toBe(0);
  });
});
