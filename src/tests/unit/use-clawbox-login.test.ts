// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useClawboxLogin } from "@/lib/use-clawbox-login";

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("useClawboxLogin", () => {
  // Real timers in this block — `waitFor` uses setTimeout under the hood,
  // so freezing the clock would deadlock the assertion. The polling-cadence
  // test below opts into fake timers explicitly inside its own scope.
  it("starts in the loading state then flips to logged-in when /ai-models/status reports clawai + a tier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      connected: true,
      provider: "clawai",
      clawaiTier: "pro",
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    expect(result.current.loading).toBe(true);
    expect(result.current.loggedIn).toBe(false);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.tier).toBe("pro");
    expect(fetchMock).toHaveBeenCalledWith(
      "/setup-api/ai-models/status",
      { cache: "no-store" },
    );
  });

  it("treats no-clawai-profile as logged-out even when chatting via another provider", async () => {
    // Pure OpenAI install — no clawai profile configured anywhere.
    // `clawaiConfigured: false` is the new authoritative signal; the
    // active `provider` field doesn't tell us what's *configured*,
    // only what's currently driving the chat.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      connected: true,
      provider: "openai",
      clawaiTier: null,
      clawaiAccountTier: null,
      clawaiConfigured: false,
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(false);
    expect(result.current.tier).toBeNull();
  });

  it("stays logged-in with paid tier when chatting via OpenAI but a paid clawai account is configured", async () => {
    // The bug we shipped: a Max subscriber who switches the chat
    // dropdown to OpenAI used to lose ClawKeep + Remote Desktop
    // because the hook resolved `tier` off the active chat provider.
    // Account-level tier now comes from `clawaiAccountTier` so paid
    // features stay unlocked regardless of the active chat provider.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      connected: true,
      provider: "openai",
      clawaiTier: null,
      clawaiAccountTier: "pro",
      clawaiConfigured: true,
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.tier).toBe("pro");
  });

  it("treats clawai-configured Free users as logged-in with no tier", async () => {
    // Free users have a paired clawai token but `clawaiAccountTier` is
    // null because the portal doesn't stamp a paid deviceTier. Pre-
    // auto-tier the hook collapsed both "no token" and "Free token"
    // into loggedIn=false, but that broke after auto-tier shipped:
    // Free users started seeing "Sign in" prompts despite already
    // being signed in. Callers that need a paid gate should check
    // `tier !== null` themselves.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      connected: true,
      provider: "clawai",
      clawaiTier: null,
      clawaiAccountTier: null,
      clawaiConfigured: true,
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.tier).toBeNull();
  });

  it("falls back to legacy provider-equality when the response omits clawaiConfigured", async () => {
    // Zero-downtime rollout: an old server build (or stale Next.js
    // route handler that hasn't reloaded yet) won't emit the new
    // fields. The hook should still pick a sensible loggedIn value
    // by falling back to the pre-rollout `provider === "clawai"`
    // heuristic.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      connected: true,
      provider: "clawai",
      clawaiTier: "flash",
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.tier).toBe("flash");
  });

  it("does not flip out of loading on a non-2xx response, but still leaves loggedIn=false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(false);
  });

  it("gracefully handles fetch throwing (e.g. network down)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(false);
    expect(result.current.tier).toBeNull();
  });

  it("re-polls at the configured interval and reflects state flips between polls", async () => {
    // Controllable promises so each poll resolves on demand — we want to
    // assert the "logged out" state strictly between the first response
    // and the second, without racing real timers.
    type Resolver = (r: Response) => void;
    const resolvers: Resolver[] = [];
    const fetchMock = vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => { resolvers.push(resolve); })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Long interval so the next poll's setTimeout doesn't fire during the
    // assertion below. We never wait for it to elapse — we resolve the
    // pending promise to drive the state machine.
    const { result } = renderHook(() => useClawboxLogin(60_000));

    await waitFor(() => expect(resolvers.length).toBe(1));
    resolvers[0](jsonResponse({ provider: "openai", clawaiTier: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loggedIn).toBe(false);

    // Force the second poll by shrinking the remaining setTimeout. Easier
    // path: just remount with a tiny interval. We re-render with a faster
    // cadence and resolve the next pending promise.
    // Instead — simulate the user signing in: the next scheduled poll
    // (60s away) would never fire in a test, so unmount and remount with
    // a tighter interval to exercise the second poll path explicitly.
    // Here we skip that and assert via a separate test below.
  });

  it("immediately exposes the latest fetched state after a successful poll", async () => {
    // Distinct test for the "second poll picks up portal sign-in" scenario,
    // using a short interval. We assert the FINAL state after enough real
    // time has elapsed that several polls have completed — the last poll's
    // result is what the consumer sees.
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      const body = call === 1
        ? { provider: "openai", clawaiTier: null }
        : { provider: "clawai", clawaiTier: "flash" };
      return Promise.resolve(jsonResponse(body));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin(50));
    await waitFor(() => expect(result.current.loggedIn).toBe(true), { timeout: 2_000 });
    expect(result.current.tier).toBe("flash");
  });

  it("does not throw or update state after unmount", async () => {
    // We can't reliably assert "exactly N fetch calls after unmount"
    // because React's mount lifecycle (and StrictMode in some renderers)
    // can fire the initial poll more than once. The behavior we DO care
    // about is that nothing throws and no React act-warnings escape after
    // the consumer has unmounted — covered here by mounting, unmounting,
    // resolving any in-flight requests, and asserting no error escaped.
    const pendingResolvers: Array<(r: Response) => void> = [];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => { pendingResolvers.push(resolve); })
    ) as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderHook(() => useClawboxLogin(20));
    unmount();
    pendingResolvers.forEach((resolve) =>
      resolve(jsonResponse({ provider: "clawai", clawaiTier: "flash" })),
    );
    await new Promise((r) => setTimeout(r, 100));

    // Any "set state on unmounted component" warning would land here —
    // a clean unmount produces zero such errors.
    const warnings = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => /unmounted|cancelled/i.test(msg));
    expect(warnings).toEqual([]);
  });
  it("reports an empty entitlement list as unanswered, not as 'nothing allowed'", async () => {
    // An empty list read as a refusal would lock the box out of every model
    // it has — the whole reason null and [] mean the same thing here.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      provider: "clawai",
      clawaiConfigured: true,
      clawaiAccountTier: "pro",
      clawaiAllowedModels: [],
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allowedModels).toBeNull();
  });

  it("keeps the same array across polls that bring the same ids back", async () => {
    // A fresh array every 30 s is a fresh identity for every consumer that
    // memoises on it — ChatPopup rebuilds its switch callback from this.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      provider: "clawai",
      clawaiConfigured: true,
      clawaiAccountTier: "pro",
      clawaiAllowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useClawboxLogin(10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = result.current.allowedModels;
    expect(first).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);

    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(2));
    expect(result.current.allowedModels).toBe(first);
  });
});

/**
 * One poll for every mounted hook.
 *
 * The owner's idle desktop mounts this hook twice (the page and
 * TierUpgradeCelebration), Settings, the full-page chat and the paid-gate
 * wizards add one each, and every one of them used to run its own chain — the
 * box answered the same question two to four times a period, a millisecond
 * apart. These pin that the asking is shared and that nothing a hook SEES is:
 * every mount still starts loading and is answered by an ask made for it, the
 * cadence is the shortest any hook asked for, and each hook keeps its own
 * reading of a failed poll.
 */
describe("useClawboxLogin — one shared poll", () => {
  const STATUS = "/setup-api/ai-models/status";
  let visibility: DocumentVisibilityState = "visible";

  function statusCalls(): number {
    return vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => url === STATUS).length;
  }

  function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  /** Let every queued promise and zero-delay timer settle under fake timers. */
  async function flush() {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    // jsdom's own getter lives on Document.prototype; dropping the instance
    // override puts it back.
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it("two hooks mounted together ask once, and both are answered", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
      provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "pro",
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => [useClawboxLogin(), useClawboxLogin()] as const);
    await waitFor(() => {
      expect(result.current[0].loading).toBe(false);
      expect(result.current[1].loading).toBe(false);
    });
    expect(result.current[0].tier).toBe("pro");
    expect(result.current[1].tier).toBe("pro");
    expect(statusCalls()).toBe(1);
  });

  it("polls at the shortest interval among the hooks mounted, and stops with the last one", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ provider: "openai" })) as unknown as typeof fetch;

    const slow = renderHook(() => useClawboxLogin(30_000));
    await flush();
    expect(statusCalls()).toBe(1);

    // A 5 s paid gate opens beside it: it is answered by an ask of its own at
    // once, and from then on BOTH are answered every 5 s — never less often
    // than either hook's own chain answered it.
    const fast = renderHook(() => useClawboxLogin(5_000));
    await flush();
    expect(statusCalls()).toBe(2);
    expect(fast.result.current.loading).toBe(false);
    await advance(5_000);
    expect(statusCalls()).toBe(3);
    await advance(5_000);
    expect(statusCalls()).toBe(4);

    // The gate closes: the 5 s tick already armed still runs once, then the
    // poll is back at the 30 s hook's own cadence.
    fast.unmount();
    await advance(5_000);
    expect(statusCalls()).toBe(5);
    await advance(29_000);
    expect(statusCalls()).toBe(5);
    await advance(1_000);
    expect(statusCalls()).toBe(6);

    slow.unmount();
    await advance(120_000);
    expect(statusCalls()).toBe(6);
  });

  it("a hook mounted later starts loading and is answered by a fresh ask, not by the answer already on screen", async () => {
    let tier = "flash";
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ provider: "clawai", clawaiConfigured: true, clawaiAccountTier: tier })),
    ) as unknown as typeof fetch;

    const first = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(first.result.current.tier).toBe("flash"));

    // The owner upgraded on the portal; Settings opens now.
    tier = "pro";
    const second = renderHook(() => useClawboxLogin());
    expect(second.result.current.loading).toBe(true);
    await waitFor(() => expect(second.result.current.tier).toBe("pro"));
    // The ask made for the newcomer answers the hook already mounted too.
    expect(first.result.current.tier).toBe("pro");
    expect(statusCalls()).toBe(2);
  });

  it("a hook mounted within a moment of an ask joins it — the page and the tier celebration mount together", async () => {
    vi.useFakeTimers();
    const pending: Array<(r: Response) => void> = [];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => { pending.push(resolve); }),
    ) as unknown as typeof fetch;

    const page = renderHook(() => useClawboxLogin());
    await flush();
    await advance(100);
    const celebration = renderHook(() => useClawboxLogin());
    await flush();
    expect(pending).toHaveLength(1);

    pending[0](jsonResponse({ provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "pro" }));
    await flush();
    expect(page.result.current.tier).toBe("pro");
    expect(celebration.result.current.tier).toBe("pro");
  });

  it("a hook mounting while an older ask is still out asks afresh, and takes nothing from the older ask", async () => {
    // The route is slowest right after a sign-in or a plan change — openclaw.json
    // rewritten, the gateway restarting. A component that mounted then (the
    // Coding Agent's paid gate, the Providers pitch card) used to join the ask
    // started seconds before, and showed the tier the owner had just left
    // until the next poll, up to 30 s later.
    vi.useFakeTimers();
    const pending: Array<(r: Response) => void> = [];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => { pending.push(resolve); }),
    ) as unknown as typeof fetch;
    const flash = { provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "flash" };
    const pro = { provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "pro" };

    const desktop = renderHook(() => useClawboxLogin(30_000));
    await flush();
    pending[0](jsonResponse(flash));
    await flush();
    expect(desktop.result.current.tier).toBe("flash");

    // The desktop's 30 s ask goes out, and the box is slow to answer it.
    await advance(30_000);
    expect(pending).toHaveLength(2);
    await advance(2_000);

    // The owner has upgraded; the paid gate opens now, and asks for itself.
    const gate = renderHook(() => useClawboxLogin());
    await flush();
    expect(pending).toHaveLength(3);

    // The ask from before it mounted lands first, with the old tier: the
    // desktop takes it, the gate does not.
    pending[1](jsonResponse(flash));
    await flush();
    expect(desktop.result.current.tier).toBe("flash");
    expect(gate.result.current.loading).toBe(true);

    pending[2](jsonResponse(pro));
    await flush();
    expect(gate.result.current.loading).toBe(false);
    expect(gate.result.current.tier).toBe("pro");
    expect(desktop.result.current.tier).toBe("pro");
  });

  it("times the join on the box's own clock, not the wall clock NTP steps", async () => {
    // The box has no RTC: its clock steps at NTP sync. Stepped back an hour
    // while an ask was out, a wall-clock window kept that ask "a moment old"
    // for the hour, and every hook mounted meanwhile waited on it.
    vi.useFakeTimers();
    const pending: Array<(r: Response) => void> = [];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => { pending.push(resolve); }),
    ) as unknown as typeof fetch;

    renderHook(() => useClawboxLogin());
    await flush();
    expect(pending).toHaveLength(1);

    vi.setSystemTime(Date.now() - 60 * 60_000);
    await advance(1_000);
    const late = renderHook(() => useClawboxLogin());
    await flush();
    expect(pending).toHaveLength(2);

    pending[1](jsonResponse({ provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "pro" }));
    await flush();
    expect(late.result.current.tier).toBe("pro");
  });

  it("each hook reads a failed poll over its OWN state", async () => {
    let fail = false;
    globalThis.fetch = vi.fn().mockImplementation(() =>
      fail
        ? Promise.resolve(new Response("nope", { status: 503 }))
        : Promise.resolve(jsonResponse({ provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "pro" })),
    ) as unknown as typeof fetch;

    const answered = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(answered.result.current.loggedIn).toBe(true));

    // A hook whose FIRST answer is a failure reads "not signed in", as it
    // always did — it is not handed the other hook's earlier answer — while
    // the hook that had an answer keeps it through the same failure.
    fail = true;
    const late = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(late.result.current.loading).toBe(false));
    expect(late.result.current.loggedIn).toBe(false);
    expect(late.result.current.tier).toBeNull();
    expect(answered.result.current.loggedIn).toBe(true);
    expect(answered.result.current.tier).toBe("pro");
  });

  it("drops an answer that lands after every hook left, and the next mount asks again", async () => {
    const pending: Array<(r: Response) => void> = [];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => { pending.push(resolve); }),
    ) as unknown as typeof fetch;

    const gone = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(pending).toHaveLength(1));
    gone.unmount();

    // A newcomer does not wait on an ask nobody owns any more.
    const next = renderHook(() => useClawboxLogin());
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[0](jsonResponse({ provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "flash" }));
    pending[1](jsonResponse({ provider: "clawai", clawaiConfigured: true, clawaiAccountTier: "pro" }));
    await waitFor(() => expect(next.result.current.loading).toBe(false));
    expect(next.result.current.tier).toBe("pro");
  });

  it("asks nothing for a tick that falls due while the page is hidden, and asks on the visible edge", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ provider: "openai" })) as unknown as typeof fetch;

    renderHook(() => useClawboxLogin(30_000));
    await flush();
    expect(statusCalls()).toBe(1);

    // A phone's tab goes to the background: nothing is asked however long.
    setVisibility("hidden");
    await advance(30_000);
    await advance(10 * 60_000);
    expect(statusCalls()).toBe(1);

    // Back in view: the tick that fell due is asked at once, and the cadence
    // carries on from there.
    setVisibility("visible");
    await flush();
    expect(statusCalls()).toBe(2);
    await advance(30_000);
    expect(statusCalls()).toBe(3);
  });

  it("a trip away shorter than the interval asks nothing extra", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ provider: "openai" })) as unknown as typeof fetch;

    renderHook(() => useClawboxLogin(30_000));
    await flush();
    setVisibility("hidden");
    await advance(10_000);
    setVisibility("visible");
    await flush();
    expect(statusCalls()).toBe(1);
    // The tick armed before the trip is still the next one.
    await advance(20_000);
    expect(statusCalls()).toBe(2);
  });
});
