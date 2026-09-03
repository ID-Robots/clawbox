import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-663 — "nobody has answered yet" is not the same fact as "the answer is
 * bad", and something has to know which one this is.
 *
 * The dashboard is not up when this server is: `clawbox-setup` answers in 0 ms
 * and `clawbox-hermes-dashboard` needs another ~11-12 s, after every boot and
 * after every restart this app itself triggers. Every read inside that window
 * falls back to Hermes' on-disk manifest, which carries no auth state for any
 * row — and `/setup-api/providers/status` used to publish that as
 * `degraded: true` with every provider "Unknown", i.e. a healthy box reported
 * as broken for the whole boot.
 *
 * `probeStillOwed` is the fact that lets the route say "Checking…" instead. It
 * asks SYSTEMD, which owns the unit that starts the dashboard, and falls back
 * to a bounded clock only where systemd cannot answer — a plain "have we ever
 * succeeded?" would leave a dashboard that never comes back reading as "still
 * starting" for ever.
 */

const dashboardFetchMock = vi.fn();
const runHermesCliMock = vi.fn();
const readFileMock = vi.fn();
const unitStateMock = vi.fn();

vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: dashboardFetchMock,
  __esModule: true,
}));

vi.mock("@/lib/hermes-dashboard-control", () => ({
  hermesDashboardUnitState: unitStateMock,
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

describe("probeStillOwed — a dashboard that is still booting is not a dashboard that failed", () => {
  let mod: typeof import("@/lib/hermes-model-options");

  beforeEach(async () => {
    vi.resetModules();
    dashboardFetchMock.mockReset();
    runHermesCliMock.mockReset();
    readFileMock.mockReset();
    unitStateMock.mockReset();
    // The common case on a real box that cannot be asked: no systemd here.
    unitStateMock.mockResolvedValue("unknown");
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

  it("owes nothing before anything has failed — including on a process that never asked", async () => {
    expect(await mod.probeStillOwed()).toBe(false);

    dashboardUp();
    const live = await mod.getModelOptions();
    expect(live.stale).toBe(false);
    expect(await mod.probeStillOwed()).toBe(false);
  });

  it("owes an answer on the first failed read", async () => {
    dashboardDown();
    const payload = await mod.getModelOptions();

    expect(payload.stale).toBe(true);
    expect(await mod.probeStillOwed()).toBe(true);
  });

  it("keeps owing it for as long as SYSTEMD says the unit is still starting", async () => {
    dashboardDown();
    await mod.getModelOptions();
    unitStateMock.mockResolvedValue("starting");

    // Well past the clock backstop: a loaded box finishing a start-up migration
    // is exactly the case a fixed grace calls broken.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + 10 * mod.PROBE_GRACE_MS);

    expect(await mod.probeStillOwed()).toBe(true);
  });

  it("owes nothing at all when the unit has failed or is masked, however fresh the outage", async () => {
    dashboardDown();
    await mod.getModelOptions();
    // Inside the clock backstop, so only the unit state can produce this answer.
    unitStateMock.mockResolvedValue("down");

    expect(await mod.probeStillOwed()).toBe(false);
  });

  it("falls back to a BOUNDED clock where systemd cannot answer", async () => {
    dashboardDown();
    await mod.getModelOptions();
    expect(await mod.probeStillOwed()).toBe(true);

    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + mod.PROBE_GRACE_MS + 1_000);

    // A dead dashboard must stop reading as "still starting" — otherwise the
    // Providers panel spins for ever, which is the same lie as the degraded
    // banner it replaces, pointing the other way.
    expect(await mod.probeStillOwed()).toBe(false);
  });

  it("is read at CALL time, so a cached payload cannot report a window that has closed", async () => {
    dashboardDown();
    const first = await mod.getModelOptions();
    expect(first.source).toBe("catalog-file");
    expect(await mod.probeStillOwed()).toBe(true);

    // `getModelOptions` serves this same cached payload and refreshes behind the
    // request. Nothing about the payload changes — and the answer still flips,
    // because it is not the payload that carries it.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + mod.PROBE_GRACE_MS + 1_000);
    const second = await mod.getModelOptions();

    expect(second.source).toBe("catalog-file");
    expect(await mod.probeStillOwed()).toBe(false);
  });

  it("clears the debt on a live answer, so the NEXT outage gets a full window", async () => {
    dashboardDown();
    await mod.getModelOptions();

    // Past FRESH_MS so the next read really goes back to the dashboard, and past
    // the backstop so a debt that was NOT cleared would answer false here.
    const realNow = Date.now();
    let offset = 70_000;
    vi.spyOn(Date, "now").mockImplementation(() => realNow + offset);
    dashboardFetchMock.mockReset();
    dashboardUp();
    // A degraded read is served from cache and re-asks BEHIND the request, so
    // the live answer lands in the cache rather than in this return value.
    await mod.getModelOptions();
    await vi.waitFor(() => expect(mod.cachedModelOptions()?.stale).toBe(false));
    expect(await mod.probeStillOwed()).toBe(false);

    offset += 70_000;
    dashboardFetchMock.mockReset();
    dashboardDown();
    // Again served from cache with the re-ask behind it; the debt opens when
    // that attempt fails, which is what this waits for.
    await mod.getModelOptions();

    await vi.waitFor(async () => expect(await mod.probeStillOwed()).toBe(true));
  });
});
