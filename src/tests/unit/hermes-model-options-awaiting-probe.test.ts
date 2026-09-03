import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-663 — "nobody has answered yet" is not the same fact as "the answer is
 * bad", and the payload has to carry the difference.
 *
 * The dashboard is not up when this server is: `clawbox-setup` answers in 0 ms
 * and `clawbox-hermes-dashboard` needs another ~11-12 s, after every boot and
 * after every restart this app itself triggers. Every read inside that window
 * falls back to Hermes' on-disk manifest, which carries no auth state for any
 * row — and `/setup-api/providers/status` used to publish that as
 * `degraded: true` with every provider "Unknown", i.e. a healthy box reported
 * as broken for the whole boot.
 *
 * `awaitingProbe` is the fact that lets the route say "Checking…" instead. It
 * is deliberately TIME-BOUNDED rather than a plain "have we ever succeeded?":
 * a dashboard that never comes back has to stop reading as "still starting".
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

/** Hermes' on-disk fallback manifest, in the shape the real one has. */
const DISK_CATALOG = JSON.stringify({
  providers: {
    openrouter: { models: [{ id: "openrouter/auto", description: "" }] },
    nous: { models: [{ id: "nous/hermes", description: "" }] },
  },
});

const DEVICE: Record<string, string> = {
  "model.provider": "openai-codex",
  "model.default": "gpt-5.6-sol",
  "agent.reasoning_effort": "medium",
};

/** Longer than PROBE_GRACE_MS, which is not exported — the bound is the
 *  module's business and this is the only thing a caller can observe. */
const PAST_THE_GRACE_MS = 40_000;

function dashboardDown() {
  dashboardFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
}

function dashboardUp() {
  dashboardFetchMock.mockImplementation(async (path: string) => {
    if (!path.startsWith("/api/model/options")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        providers: [{
          slug: "openai-codex",
          name: "OpenAI Codex",
          authenticated: true,
          source: "dashboard",
          total_models: 1,
          models: ["gpt-5.6-sol"],
        }],
        provider: "openai-codex",
        model: "gpt-5.6-sol",
      }),
    };
  });
}

describe("hermes-model-options — a dashboard that is still booting is not a dashboard that failed", () => {
  let mod: typeof import("@/lib/hermes-model-options");

  beforeEach(async () => {
    vi.resetModules();
    dashboardFetchMock.mockReset();
    runHermesCliMock.mockReset();
    readFileMock.mockReset();
    readFileMock.mockResolvedValue(DISK_CATALOG);
    runHermesCliMock.mockImplementation(async (args: string[]) => ({
      stdout: DEVICE[args[2]] ?? "",
      stderr: "",
      code: 0,
    }));
    mod = await import("@/lib/hermes-model-options");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("marks the first fallback as still owed an answer", async () => {
    dashboardDown();
    const payload = await mod.getModelOptions();

    expect(payload.stale).toBe(true);
    expect(payload.awaitingProbe).toBe(true);
  });

  it("drops the mark once the wait outlives a boot, so a dead box degrades", async () => {
    dashboardDown();
    expect((await mod.getModelOptions()).awaitingProbe).toBe(true);

    // The clock, not the timers: the module's single-flight and its background
    // refresh are promises, and freezing time around those tests the mock
    // rather than the module.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + PAST_THE_GRACE_MS);

    // The read is served from cache and the re-ask happens behind it — which is
    // exactly the ≤1 s lag the field's own doc comment describes, and it
    // converges without anything invalidating the cache.
    await mod.getModelOptions();
    await vi.waitFor(() => expect(mod.cachedModelOptions()?.awaitingProbe).toBe(false));
  });

  it("clears the debt on a live answer, so the NEXT outage gets a full window", async () => {
    dashboardUp();
    const live = await mod.getModelOptions();
    expect(live.stale).toBe(false);
    // Never set on a live payload — there is nothing outstanding.
    expect(live.awaitingProbe).toBeUndefined();

    // A restart this app itself triggers is the common case, and it must get
    // the whole window again rather than the remains of an older outage. Past
    // FRESH_MS so the next read really goes back to the dashboard.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + 70_000);
    dashboardFetchMock.mockReset();
    dashboardDown();

    // The 47-provider catalogue we already hold is not thrown away for a
    // 2-provider manifest, so what lands in the cache is the KEPT payload —
    // which still has to carry the debt this read just opened, or a dashboard
    // whose every later answer is a downgrade would spin for ever.
    await mod.getModelOptions();
    await vi.waitFor(() => expect(mod.cachedModelOptions()?.awaitingProbe).toBe(true));
    expect(mod.cachedModelOptions()?.degraded).toBe("dashboard-unreachable");
  });
});
