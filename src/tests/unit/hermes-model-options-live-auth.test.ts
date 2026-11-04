import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2148 — `readLiveProviderAuth`, the read the provider sign-out's verify
 * step asks Hermes with (src/lib/provider-sign-out-hermes.ts). It must be a
 * live dashboard read of its own: the cached catalogue, or a load begun
 * before the sign-out's restart, can still carry the `authenticated: true`
 * from before — and it polls through a restart, so it must not spawn the
 * Hermes CLI the way a full catalogue rebuild does.
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

/** The dashboard answering with ClawBox AI's flag as given, OpenRouter's false. */
function dashboard(clawai: boolean) {
  dashboardFetchMock.mockImplementation(async (path: string) => {
    if (!path.startsWith("/api/model/options")) return { ok: true, status: 200, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        providers: [
          { slug: "clawai", name: "ClawBox AI", authenticated: clawai, is_user_defined: true, models: ["deepseek-v4-flash"] },
          { slug: "openrouter", name: "OpenRouter", authenticated: false, models: [] },
        ],
        provider: "openrouter",
        model: "openrouter/auto",
      }),
    };
  });
}

describe("readLiveProviderAuth — Hermes' own flag, read live", () => {
  let mod: typeof import("@/lib/hermes-model-options");

  beforeEach(async () => {
    vi.resetModules();
    dashboardFetchMock.mockReset();
    runHermesCliMock.mockReset();
    readFileMock.mockReset();
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    runHermesCliMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    mod = await import("@/lib/hermes-model-options");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("answers what the dashboard says now, not the catalogue cached before the change — and spawns no CLI", async () => {
    dashboard(true);
    const cached = await mod.getModelOptions();
    expect(cached.providers.find((row) => row.id === "clawai")?.authenticated).toBe(true);

    // The sign-out landed and Hermes restarted: the cached catalogue still says true.
    dashboard(false);
    const spawnsBefore = runHermesCliMock.mock.calls.length;
    const auth = await mod.readLiveProviderAuth();
    expect(auth).toEqual(new Map([["clawai", false], ["openrouter", false]]));
    expect(runHermesCliMock.mock.calls.length).toBe(spawnsBefore);
    expect((await mod.getModelOptions()).providers.find((row) => row.id === "clawai")?.authenticated).toBe(true);
  });

  it("is null while the dashboard does not answer", async () => {
    dashboardFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(await mod.readLiveProviderAuth()).toBeNull();
    dashboardFetchMock.mockReset();
    dashboardFetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await mod.readLiveProviderAuth()).toBeNull();
  });
});
