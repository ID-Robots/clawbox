import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-678, second half — an invalidation must not disarm the downgrade guard.
 *
 * `load()` compares a new payload against `cached`, and
 * `invalidateModelOptions()` sets `cached = null`. Every write that changes the
 * device's credentials or selection calls it (the provider-key route, the
 * clawai link, the models route), so a dashboard blip landing in that window
 * had nothing to compare against: the 2-provider on-disk manifest installed
 * itself over a 48-provider catalogue and was served with `degraded` unset —
 * indistinguishable, to every consumer, from a box that genuinely has two
 * providers.
 *
 * The fix is NOT to serve the old payload back. After an invalidation the
 * device's selection has just changed, and the cached payload's `current` is
 * pre-write — serving it would be wrong at exactly the moment the guard fires.
 * What survives the invalidation is a BASELINE: how good the last answer was,
 * and when. A payload that is worse than the baseline is still served, with the
 * fresh selection the fallback carries, and it says so.
 */

const dashboardFetchMock = vi.fn();
const runHermesCliMock = vi.fn();
const readFileMock = vi.fn();

vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: dashboardFetchMock,
  __esModule: true,
}));

vi.mock("@/lib/hermes-cli", () => ({
  runHermesCli: runHermesCliMock,
}));

vi.mock("fs/promises", () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

function dashboardEnvelope(count: number) {
  return {
    providers: Array.from({ length: count }, (_, i) => ({
      slug: `provider${i}`,
      name: `Provider ${i}`,
      authenticated: true,
      total_models: 1,
      source: "dashboard",
      models: [{ id: `provider${i}/model-a`, description: "" }],
    })),
    current: { provider: "provider0", model: "provider0/model-a" },
  };
}

function dashboardOk(count: number) {
  dashboardFetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => dashboardEnvelope(count),
  });
}

function dashboardDown() {
  dashboardFetchMock.mockRejectedValueOnce(new Error("timed out"));
}

/** Hermes' on-disk fallback manifest — the real one holds exactly 2 providers. */
const DISK_CATALOG = JSON.stringify({
  providers: {
    openrouter: { models: [{ id: "openrouter/auto", description: "" }] },
    nous: { models: [{ id: "nous/hermes", description: "" }] },
  },
});

describe("hermes-model-options — an invalidation keeps the downgrade baseline", () => {
  let mod: typeof import("@/lib/hermes-model-options");

  beforeEach(async () => {
    vi.resetModules();
    dashboardFetchMock.mockReset();
    runHermesCliMock.mockReset();
    readFileMock.mockReset();
    runHermesCliMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    readFileMock.mockResolvedValue(DISK_CATALOG);
    mod = await import("@/lib/hermes-model-options");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("says the thin catalogue is degraded when a credential write meets a dashboard blip", async () => {
    dashboardOk(48);
    expect((await mod.getModelOptions()).providers).toHaveLength(48);

    // A provider key is saved: every such route drops the cache.
    mod.invalidateModelOptions();

    dashboardDown();
    const after = await mod.getModelOptions();

    // The fallback IS served — its `current` is the post-write selection, which
    // the dropped payload's no longer is.
    expect(after.source).toBe("catalog-file");
    expect(after.providers).toHaveLength(2);
    // …but the box knows it had 48 a moment ago and must not present 2 as the
    // truth. This is the assertion that fails on beta.
    expect(after.degraded).toBe("dashboard-unreachable");
  });

  it("drops the marker as soon as the dashboard answers again", async () => {
    dashboardOk(48);
    await mod.getModelOptions();
    mod.invalidateModelOptions();
    dashboardDown();
    expect((await mod.getModelOptions()).degraded).toBe("dashboard-unreachable");

    dashboardOk(48);
    const recovered = await mod.getModelOptions({ refresh: true });
    expect(recovered.source).toBe("dashboard");
    expect(recovered.providers).toHaveLength(48);
    expect(recovered.degraded).toBeUndefined();
  });

  it("does not call a cold box degraded — there is no better answer to have lost", async () => {
    dashboardDown();
    const cold = await mod.getModelOptions();
    expect(cold.source).toBe("catalog-file");
    expect(cold.degraded).toBeUndefined();
  });

  it("does not resurrect the pre-write selection", async () => {
    dashboardOk(48);
    await mod.getModelOptions();
    mod.invalidateModelOptions();
    // The CLI is the post-write store; the fallback reads it.
    runHermesCliMock.mockImplementation(async (args: string[]) => ({
      stdout: args.includes("model.provider") ? "anthropic" : "",
      stderr: "",
      code: 0,
    }));
    dashboardDown();

    const after = await mod.getModelOptions();
    expect(after.current.provider).toBe("anthropic");
    expect(after.current.provider).not.toBe("provider0");
  });
});
