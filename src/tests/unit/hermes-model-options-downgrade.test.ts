import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed catalogue refresh must not replace a good catalogue with a thin one.
 *
 * `buildPayload` falls back to Hermes' on-disk manifest whenever the dashboard
 * is unreachable or slower than the 8 s timeout, and `load()` used to install
 * whatever came back as the shared cache, unconditionally. On the QA box that
 * turned one transient timeout into 47 providers becoming 2 — and, because
 * `?refresh=1` was reachable pre-auth, gave an attacker a way to trigger it.
 * TASK-446.
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

/** A dashboard envelope carrying `count` providers, each with one model. */
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

describe("hermes-model-options — a failed refresh must not poison the cache", () => {
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

  it("keeps the healthy dashboard catalogue when a refresh cannot reach the dashboard", async () => {
    dashboardOk(47);
    const healthy = await mod.getModelOptions();
    expect(healthy.source).toBe("dashboard");
    expect(healthy.providers).toHaveLength(47);

    // The refresh finds the dashboard down and falls back to the 2-provider
    // disk manifest. Before the fix that payload became the cache.
    dashboardDown();
    const refreshed = await mod.getModelOptions({ refresh: true });

    expect(refreshed.providers).toHaveLength(47);
    expect(refreshed.source).toBe("dashboard");
    expect(refreshed.degraded).toBe("dashboard-unreachable");
  });

  it("leaves the next plain read on the good catalogue, not the fallback", async () => {
    dashboardOk(47);
    await mod.getModelOptions();
    dashboardDown();
    await mod.getModelOptions({ refresh: true });

    // No further dashboard call: the cache is still fresh AND still good.
    const after = await mod.getModelOptions();
    expect(after.providers).toHaveLength(47);
    expect(after.source).toBe("dashboard");
  });

  it("still installs a dashboard payload that legitimately shrank", async () => {
    // A provider losing its key is a real change, not a degradation — same
    // source rank, so it must land.
    dashboardOk(47);
    await mod.getModelOptions();

    dashboardOk(3);
    const refreshed = await mod.getModelOptions({ refresh: true });

    expect(refreshed.providers).toHaveLength(3);
    expect(refreshed.degraded).toBeUndefined();
  });

  it("serves the disk fallback when there is no better cache to keep", async () => {
    // Cold start with a dead dashboard: the fallback is the best available
    // answer and must still be returned rather than an error.
    dashboardDown();
    const cold = await mod.getModelOptions();

    expect(cold.source).toBe("catalog-file");
    expect(cold.providers).toHaveLength(2);
    expect(cold.stale).toBe(true);
  });

  it("reports credential presence and verification as separate fields", async () => {
    // Hermes' `authenticated` means "a key is set", never "the key works", so a
    // consumer must not be able to read one as the other. TASK-446.
    dashboardOk(1);
    const payload = await mod.getModelOptions();

    expect(payload.providers[0].authenticated).toBe(true);
    expect(payload.providers[0].verified).toBeNull();
  });
});

describe("hermes-model-options — an invalidation keeps the downgrade baseline", () => {
  /**
   * TASK-678, second half. `load()` compares a new payload against `cached`,
   * and `invalidateModelOptions()` sets `cached = null`. Every route that
   * changes a credential or the selection calls it, so a dashboard blip landing
   * in that window had nothing to compare against: the 2-provider disk manifest
   * installed itself over a 48-provider catalogue and was served with
   * `degraded` unset — a box that had just lost 46 providers, presenting two as
   * its catalogue.
   *
   * The fix is NOT to serve the old payload back. After an invalidation the
   * selection has just changed and the cached payload's `current` is pre-write.
   * What survives is a BASELINE: how good the last answer was, and when.
   */
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
    vi.useRealTimers();
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

  it("keeps saying so through the refresh that follows, and through a second write", async () => {
    // The baseline is RAISED, never lowered. Without that the thin payload this
    // branch caches becomes the baseline on the very next background refresh,
    // the marker is stripped while the dashboard is still down, and a second
    // credential write in the same outage lands unguarded again.
    vi.useFakeTimers();
    dashboardOk(48);
    await mod.getModelOptions();
    mod.invalidateModelOptions();
    dashboardDown();
    expect((await mod.getModelOptions()).degraded).toBe("dashboard-unreachable");

    // Past DEGRADED_REFRESH_GAP_MS, so the next read books the refresh a
    // degraded cache books once a second.
    vi.setSystemTime(Date.now() + 1_100);
    dashboardDown();
    await mod.getModelOptions();
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.cachedModelOptions()?.degraded).toBe("dashboard-unreachable");

    // And the second write of the same outage is still guarded.
    mod.invalidateModelOptions();
    dashboardDown();
    expect((await mod.getModelOptions()).degraded).toBe("dashboard-unreachable");
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

  it("does not resurrect the pre-write selection (a guard — beta passes this too)", async () => {
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
