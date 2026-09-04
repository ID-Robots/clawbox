// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useHermesModelOptions } from "@/hooks/useHermesModelOptions";

/**
 * TASK-678, the client half — two residuals from the #599 review.
 *
 * The catalogue's retry loop waits out the boot window: `clawbox-setup` logs
 * "Ready in 0ms" and starts serving while `clawbox-hermes-dashboard` needs
 * another 11-12 s (measured on the box). While it waits, the surfaces read as
 * LOADING rather than as "this provider has no models".
 *
 * (M1) The budget is not what its schedule looks like. A degraded read is
 * served from cache and the dashboard is re-asked BEHIND the request
 * (hermes-model-options.ts — awaiting it was tried in #599 and is wrong), so a
 * poll can only ever return what a PREVIOUS poll's refresh installed. The last
 * poll therefore cannot recover: the deciding one is the second-to-last. That
 * one rule is what the fixture below models, and it is why a client-side mock
 * that answers live as soon as the dashboard is up cannot see this at all.
 *
 * WHAT THE FIXTURE DOES NOT MODEL, deliberately: the WARM-cache half only. The
 * server's cold first read blocks on a live fetch (up to DASHBOARD_TIMEOUT_MS
 * plus an untimed login), its refresh is throttled to one a second measured
 * from `fetchedAt`, and `load()` is single-flight — so on a real box the first
 * few polls are cheaper and later than they are here. This suite pins the
 * CLIENT's timer arithmetic against that one server rule; the server's own
 * behaviour is pinned in hermes-model-options-downgrade / -stale-cache.
 *
 * (M2) On exhaustion the placeholder was installed with `error: null`, so a box
 * whose dashboard is never coming back rendered as a provider that simply has
 * these models. The rejected-request branch three lines below already reported
 * an error for the same fact; the degraded-200 branch did not.
 */

const PROVIDER = "openai-codex";

const STALE = {
  provider: PROVIDER,
  authenticated: null,
  models: [],
  defaultModel: "",
  current: "",
  savedElsewhere: null,
  source: "catalog-file",
  stale: true,
};

const LIVE = {
  provider: PROVIDER,
  authenticated: true,
  models: [{ id: "gpt-5.6-sol", description: "" }, { id: "gpt-5.4", description: "" }],
  defaultModel: "gpt-5.6-sol",
  current: "gpt-5.6-sol",
  savedElsewhere: null,
  source: "dashboard",
  stale: false,
};

/**
 * The box, as it actually behaves. A request while the cache holds a fallback
 * returns that fallback and kicks a refresh behind itself; the refresh succeeds
 * only once the dashboard is up, and what it installs is visible to the NEXT
 * request.
 */
function installBox(dashboardUpAfterMs: number | null): void {
  const bootedAt = Date.now();
  let cacheIsLive = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = cacheIsLive ? LIVE : STALE;
      if (!cacheIsLive && dashboardUpAfterMs !== null && Date.now() - bootedAt >= dashboardUpAfterMs) {
        cacheIsLive = true; // the background refresh landed, after this answer
      }
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
}

/** Run the whole retry schedule out, with room to spare. */
async function runOutTheBudget(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the catalogue retry budget covers a real boot", () => {
  it("recovers a dashboard that comes up at 20 s, past the measured 11-12 s window", async () => {
    installBox(20_000);
    const { result } = renderHook(() => useHermesModelOptions(PROVIDER));

    await runOutTheBudget();

    expect(result.current.scope?.stale).toBe(false);
    expect(result.current.scope?.models).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it("still recovers one that comes up inside the measured window", async () => {
    installBox(12_000);
    const { result } = renderHook(() => useHermesModelOptions(PROVIDER));

    await runOutTheBudget();

    expect(result.current.scope?.stale).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe("a dashboard that never comes back is reported, not rendered as an answer", () => {
  it("settles with an error instead of a silent placeholder", async () => {
    installBox(null);
    const { result } = renderHook(() => useHermesModelOptions(PROVIDER));

    await runOutTheBudget();

    // It has stopped loading — the retries are spent, and a box whose harness
    // is gone must not be polled for ever.
    expect(result.current.loading).toBe(false);
    // The fact that must reach the surfaces: this is not the box's catalogue.
    expect(result.current.scope?.stale).toBe(true);
    expect(result.current.error).toBeTruthy();
  });
});
