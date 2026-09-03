import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OTHER write paths that move the provider set.
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
 *
 * A site that must NOT reload belongs here just as much as one that must: the
 * last two are catalogue repairs that hang off `GET /setup-api/hermes/models`,
 * and the whole point of pinning them is that "no reload" is a decision with a
 * reason, not an omission nobody noticed.
 */

const rpcMock = vi.hoisted(() => vi.fn());
const cliMock = vi.hoisted(() => vi.fn());
const optionsMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const readConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
const storeGetMock = vi.hoisted(() => vi.fn<(key: string) => Promise<unknown>>(async () => null));
vi.mock("@/lib/config-store", () => ({ get: storeGetMock, setMany: vi.fn() }));
vi.mock("@/lib/hermes-config-yaml", () => ({
  patchHermesConfig: patchMock,
  readHermesConfigValue: readConfigMock,
}));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "local-token-xyz" }));
vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyRootUrl: () => "http://127.0.0.1",
  getLocalAiOpenAiBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/ollama/v1",
}));
const invalidateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-model-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-model-options")>()),
  getModelOptions: optionsMock,
  invalidateModelOptions: invalidateMock,
}));

import { applyCloudProviderKeyToHermes } from "@/lib/hermes-cloud-provider";
import {
  _resetLocalAiReconcileForTests,
  applyLocalAiToHermes,
  reconcileLocalAiWithHermes,
  removeLocalAiFromHermes,
} from "@/lib/hermes-local-ai";
import {
  _resetClawaiModelsReconcileForTests,
  reconcileClawaiModelsWithHermes,
} from "@/lib/hermes-clawai";

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
  storeGetMock.mockReset();
  storeGetMock.mockResolvedValue(null);
  invalidateMock.mockClear();
  _resetLocalAiReconcileForTests();
  _resetClawaiModelsReconcileForTests();
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

describe("declaring a catalogue Hermes' own pickers read", () => {
  // Both repairs run inside `GET /setup-api/hermes/models` — the route the
  // agent's own `ai_list_models` reads — so a `reload.mcp` from in here would
  // shut down the MCP child that is mid-tool-call. And neither moves the
  // provider SET the enum is built from: the provider already exists, only the
  // models it lists change. Invalidate the browser's catalogue, ask the agent
  // for nothing. This is the same rule `reconcileLocalAiWithHermes` already
  // followed by calling the INNER write.
  //
  // BOTH HALVES ARE ASSERTED, because "ask the agent for nothing" on its own is
  // also what a repair that invalidated NOTHING looks like: the browser would
  // keep serving the catalogue from before the write, and this suite — which
  // exists to own that population — would not notice.
  it("asks the agent for nothing when the ClawBox AI catalogue is declared", async () => {
    catalogueGrows(["openrouter", "clawai"], ["openrouter", "clawai"], "clawai");
    // ONE read of the whole `providers.clawai` block: Hermes decides what
    // `models:` means from its siblings, and the same entry carries the
    // `base_url` the orphan guard needs.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === "providers.clawai") {
        return {
          code: 0,
          stdout: JSON.stringify({
            base_url: "https://clawbox.com/api/ai",
            api_mode: "openai",
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(true);
    expect(reloadCount()).toBe(0);
    expect(invalidateMock).toHaveBeenCalled();
  });

  it("asks the agent for nothing when the local catalogue is declared", async () => {
    catalogueGrows(["openrouter", "clawlocal"], ["openrouter", "clawlocal"], "clawlocal");
    storeGetMock.mockImplementation(async (key: string) => {
      if (key === "local_ai_configured") return true;
      if (key === "local_ai_provider") return "ollama";
      if (key === "local_ai_model") return "ollama/qwen3:8b";
      return null;
    });
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === "providers.clawlocal.models"
        ? { code: 1, stdout: "", stderr: "config key not set" }
        : { code: 0, stdout: "http://127.0.0.1/setup-api/local-ai/ollama/v1\n", stderr: "" });
    await reconcileLocalAiWithHermes();
    expect(patchMock).toHaveBeenCalledWith({ set: { "providers.clawlocal.models": "qwen3:8b" } });
    expect(reloadCount()).toBe(0);
    expect(invalidateMock).toHaveBeenCalled();
  });
});
