import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-678 — a DEGRADED catalogue was cached as if it were an answer.
 *
 * `getModelOptions` served anything in `cached` for a full `FRESH_MS` (60 s)
 * without ever consulting `cached.stale`. On a cold process — every reboot —
 * the first read lands inside the ~11-12 s window where `clawbox-setup` is
 * answering and `clawbox-hermes-dashboard` is not yet up, so the payload is
 * built from Hermes' on-disk manifest (`openrouter` + `nous`, and nothing about
 * this device). That placeholder then WAS the catalogue for the next minute,
 * for every consumer: the chat header, the Settings panel, the MCP tools.
 *
 * `isDowngrade` does not help here — it compares against `previous = cached`,
 * and on a cold process there is nothing to compare against.
 *
 * A fallback is not an answer, so it does not earn an answer's freshness
 * window: the next read goes back to the dashboard.
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

/** The device this was reported on: configured on Codex. */
const DEVICE: Record<string, string> = {
  "model.provider": "openai-codex",
  "model.default": "gpt-5.6-sol",
  "agent.reasoning_effort": "medium",
};

/** How many times the live catalogue was asked for. */
function optionsCalls(): number {
  return dashboardFetchMock.mock.calls.filter(
    (c) => String(c[0]).startsWith("/api/model/options"),
  ).length;
}

function dashboardDown() {
  dashboardFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
}

/** The settled box: the codex row with the seven models it really lists. */
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
          total_models: 7,
          models: [
            "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
            "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
          ],
        }],
        provider: "openai-codex",
        model: "gpt-5.6-sol",
      }),
    };
  });
}

describe("hermes-model-options — a fallback must not be cached as an answer", () => {
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
    vi.clearAllMocks();
  });

  it("asks the dashboard again on the next read", async () => {
    dashboardDown();
    const first = await mod.getModelOptions();
    expect(first.source).toBe("catalog-file");
    expect(first.stale).toBe(true);
    expect(optionsCalls()).toBe(1);

    // The dashboard finished booting a second later. Nothing invalidates the
    // cache — nothing changed on the device — so recovery depends entirely on
    // this read not being answered from the placeholder.
    dashboardUp();
    const second = await mod.getModelOptions();

    expect(optionsCalls()).toBeGreaterThan(1);
    expect(second.source).toBe("dashboard");
    expect(second.providers.find((p) => p.id === "openai-codex")?.models).toHaveLength(7);
  });

  it("still spends nothing re-asking once a live answer is in hand", async () => {
    dashboardUp();
    const first = await mod.getModelOptions();
    expect(first.source).toBe("dashboard");
    const asked = optionsCalls();

    // A real answer keeps its full freshness window: this is the cache doing
    // its job, and the fix must not turn every read into a round-trip.
    await mod.getModelOptions();
    await mod.getModelOptions();

    expect(optionsCalls()).toBe(asked);
  });
});
