import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-781 — the picker's model list never refreshed by itself.
 *
 * MEASURED on the Hermes box (Hermes v0.21.1): the Anthropic row served eleven
 * model ids written at 12:14, while the same credential listed thirteen live —
 * `claude-opus-5` and `claude-fable-5-1` were simply missing from the picker.
 * `GET /setup-api/hermes/models?refresh=1` re-fetched and both appeared.
 *
 * WHY IT COULD SIT THERE. Two caches, and nothing forcing either:
 *   - Hermes' own `provider_models_cache.json` has a 1 h TTL but a SEVEN DAY
 *     stale-serve window (`_PROVIDER_MODELS_STALE_SERVE_MAX`). Its background
 *     SWR refresh only rewrites the row when the live fetch comes back
 *     non-empty (`if live:` in `cached_provider_model_ids`), so one failed
 *     re-fetch carries the old ids forward — with the entry's `at` unmoved.
 *   - ClawBox's own layer (`hermes-model-options.ts`) only ever sends
 *     `refresh=true` to `/api/model/options` when a human clicks Refresh:
 *     `?refresh=1` on this route, and that is session-gated. Its background
 *     `load(false)` re-asks the dashboard but does NOT bust Hermes' disk cache,
 *     so it re-serves the same stale ids.
 *
 * So the list only ever moved when the owner clicked. That is the defect: a
 * user had to know to click Refresh — or re-sign-in — to see a model that
 * shipped a week ago.
 *
 * The two things this pins:
 *   1. Something that fires WITHOUT the owner forces a real re-fetch at least
 *      daily. The only thing on a running box that fires with nobody touching
 *      it is `clawbox-heartbeat.timer` — which is why the deferred language
 *      persona already rides it.
 *   2. The payload says how old the list is, calls it stale past 24 h, and says
 *      "not checked" rather than "old" where it cannot tell.
 *      `fetchedAt`/`stale` already in the payload cannot answer that: they
 *      describe ClawBox's own 60-second L1 cache, so a week-old catalogue
 *      reports `fetchedAt` = "two seconds ago", `stale: false`.
 */

const dashboardFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: dashboardFetchMock,
  __esModule: true,
}));

const runHermesCliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("fs/promises", () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

// The config store, in memory: this is where the last SUCCESSFUL forced refresh
// is remembered, and it has to survive a Next.js restart the way the provider
// verification marks beside it do.
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  }),
}));

const activeHarnessMock = vi.hoisted(() => vi.fn(async () => "hermes"));
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: activeHarnessMock,
}));

// The models route's self-repairs spawn `hermes`; they are not what is under
// test here.
vi.mock("@/lib/hermes-local-ai", () => ({ reconcileLocalAiWithHermes: vi.fn(async () => {}) }));
vi.mock("@/lib/hermes-clawai", () => ({ reconcileClawaiModelsWithHermes: vi.fn(async () => {}) }));

// Everything the heartbeat tick does that is not this. The tunnel is alive, so
// the route takes its ordinary path.
vi.mock("@/lib/language-persona", () => ({ applyDeferredLanguagePersona: vi.fn(async () => false) }));
vi.mock("@/lib/cloudflared", () => ({
  readTunnelUrl: vi.fn(async () => "https://example.trycloudflare.com"),
  startTunnelService: vi.fn(async () => ({ bootPersisted: true, bootPersistWarning: null })),
}));
vi.mock("@/lib/portal-heartbeat", () => ({ pushHeartbeatTick: vi.fn() }));
vi.mock("@/lib/tunnel-liveness", () => ({
  checkTunnelLiveness: vi.fn(async () => "alive"),
  mayRestart: vi.fn(() => true),
  markRestarted: vi.fn(),
}));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/internal-token", () => ({ isInternalRequest: vi.fn(() => true) }));

/** The device: Anthropic, and the two ids the box could not see. */
const LIVE_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-opus-5",
  "claude-fable-5-1",
];

const DEVICE: Record<string, string> = {
  "model.provider": "anthropic",
  "model.default": "claude-opus-4-8",
  "agent.reasoning_effort": "medium",
};

function dashboardUp() {
  dashboardFetchMock.mockImplementation(async (path: string) => {
    if (!String(path).startsWith("/api/model/options")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        providers: [{
          slug: "anthropic",
          name: "Anthropic",
          authenticated: true,
          source: "dashboard",
          total_models: LIVE_MODELS.length,
          models: LIVE_MODELS,
        }],
        provider: "anthropic",
        model: "claude-opus-4-8",
      }),
    };
  });
}

/** Every `/api/model/options` call that asked Hermes to bust its disk cache. */
function forcedRefreshCalls(): string[] {
  return dashboardFetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((p) => p.startsWith("/api/model/options") && p.includes("refresh=true"));
}

async function tick() {
  const mod = await import("@/app/setup-api/portal/heartbeat-tick/route");
  return mod.GET(new Request("http://127.0.0.1/setup-api/portal/heartbeat-tick"));
}

async function models() {
  const mod = await import("@/app/setup-api/hermes/models/route");
  const res = await mod.GET(new Request("http://127.0.0.1/setup-api/hermes/models"));
  return res.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.resetModules();
  store.clear();
  dashboardFetchMock.mockReset();
  runHermesCliMock.mockReset();
  readFileMock.mockReset();
  readFileMock.mockRejectedValue(new Error("ENOENT"));
  runHermesCliMock.mockImplementation(async (args: string[]) => ({
    stdout: DEVICE[args[2]] ?? "",
    stderr: "",
    code: 0,
  }));
  activeHarnessMock.mockResolvedValue("hermes");
  dashboardUp();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TASK-781 — the catalogue refreshes without the owner", () => {
  it("forces a re-fetch on the heartbeat when the list was last refreshed a day ago", async () => {
    // The box has been up for a week. The last time anything actually made
    // Hermes go and ask Anthropic what it serves was 25 hours ago.
    store.set("hermes_catalog_refreshed_at", {
      checkedAt: Date.now() - 25 * 60 * 60 * 1000,
      attemptedAt: Date.now() - 25 * 60 * 60 * 1000,
    });

    const res = await tick();
    expect(res.status).toBe(200);

    // ON BETA: zero, for ever. The tick knows nothing about the catalogue, and
    // no other unattended path on the box ever sends `refresh=true` — so the
    // eleven ids written at 12:14 stay in the picker until a human clicks
    // Refresh.
    //
    // Awaited with `waitFor`, not by the route: the tick fires this and moves
    // on, because its unit runs `curl --max-time 10` and the dead-tunnel repair
    // underneath already budgets 7.5 s of that for DNS.
    await vi.waitFor(() => expect(forcedRefreshCalls()).toHaveLength(1));
  });

  it("reports the catalogue's age, and calls it stale past a day", async () => {
    const checkedAt = Date.now() - 25 * 60 * 60 * 1000;
    store.set("hermes_catalog_refreshed_at", { checkedAt, attemptedAt: checkedAt });

    const body = await models();

    // ON BETA: both undefined. `fetchedAt` and `stale` are already in this
    // payload and cannot answer the question — they describe ClawBox's own
    // 60-second cache, so this week-old catalogue reports itself fresh.
    expect(body.catalogCheckedAt).toBe(checkedAt);
    expect(body.catalogStale).toBe(true);
    expect(body.stale).toBe(false);
  });

  it("says \"not checked\" — never \"old\" — for a catalogue nothing has refreshed yet", async () => {
    // A box in its first five minutes, or one restored from a backup, has no
    // recorded refresh and a list Hermes may have fetched moments ago. Painting
    // that stale is the false-failure class, and this route already refuses the
    // same shape one field away: `verified` stays null for a provider nothing
    // has exercised rather than reporting `false`.
    const body = await models();

    expect(body.catalogCheckedAt).toBeNull();
    expect(body.catalogStale).toBeNull();
  });

  it("calls a catalogue refreshed within the day fresh", async () => {
    const checkedAt = Date.now() - 60 * 60 * 1000;
    store.set("hermes_catalog_refreshed_at", { checkedAt, attemptedAt: checkedAt });

    const body = await models();

    expect(body.catalogCheckedAt).toBe(checkedAt);
    expect(body.catalogStale).toBe(false);
  });

  it("carries the age onto the scoped reply the picker reads", async () => {
    const checkedAt = Date.now() - 25 * 60 * 60 * 1000;
    store.set("hermes_catalog_refreshed_at", { checkedAt, attemptedAt: checkedAt });

    const mod = await import("@/app/setup-api/hermes/models/route");
    const res = await mod.GET(
      new Request("http://127.0.0.1/setup-api/hermes/models?provider=anthropic"),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.catalogCheckedAt).toBe(checkedAt);
    expect(body.catalogStale).toBe(true);
  });
});

describe("TASK-781 — the refresh is bounded and quiet", () => {
  it("does not remember a refresh that failed, and retries on a floor rather than every tick", async () => {
    dashboardFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await tick();
    // A dashboard that is down is not a failed heartbeat.
    expect(res.status).toBe(200);

    // A failure must not be recorded as a check — the catalogue is still as old
    // as it was, and saying otherwise would hide it for another day.
    await vi.waitFor(() => {
      const mark = store.get("hermes_catalog_refreshed_at") as {
        checkedAt: number | null;
        attemptedAt: number | null;
      };
      expect(mark.checkedAt).toBeNull();
      // ...but the attempt IS recorded, which is what spaces out the retries.
      expect(mark.attemptedAt).toBeGreaterThan(0);
    });
  });

  it("remembers a check that succeeded, and serves the models it brought back", async () => {
    const before = Date.now();
    await tick();

    await vi.waitFor(() => {
      const mark = store.get("hermes_catalog_refreshed_at") as { checkedAt: number };
      expect(mark.checkedAt).toBeGreaterThanOrEqual(before);
    });

    const body = await models();
    expect(body.catalogStale).toBe(false);
    // The two ids the owner could not see, in the list, with nothing clicked.
    const ids = (body.models as { id: string }[]).map((m) => m.id);
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-fable-5-1");
  });

  it("counts the owner's own Refresh click as a refresh", async () => {
    // The sibling call site. `?refresh=1` busts exactly the same Hermes disk
    // cache the daily driver does, so if only the driver recorded it, a box the
    // owner had just refreshed by hand would still report its list a day stale
    // — a false failure over an operation that succeeded.
    const stale = Date.now() - 30 * 60 * 60 * 1000;
    store.set("hermes_catalog_refreshed_at", { checkedAt: stale, attemptedAt: stale });

    const mod = await import("@/app/setup-api/hermes/models/route");
    const before = Date.now();
    const res = await mod.GET(new Request("http://127.0.0.1/setup-api/hermes/models?refresh=1"));

    const mark = store.get("hermes_catalog_refreshed_at") as { checkedAt: number };
    expect(mark.checkedAt).toBeGreaterThanOrEqual(before);

    // ...AND the very response that performed it says so. Reading the mark
    // beside the refresh instead of after it made the one action that fixes
    // staleness answer `catalogStale: true`.
    const refreshed = (await res.json()) as Record<string, unknown>;
    expect(refreshed.catalogStale).toBe(false);
    expect(refreshed.catalogCheckedAt).toBeGreaterThanOrEqual(before);

    const body = await models();
    expect(body.catalogStale).toBe(false);
  });

  it("forces nothing on an OpenClaw box", async () => {
    // There is no Hermes dashboard to ask. The tick still has to answer 200.
    activeHarnessMock.mockResolvedValue("openclaw");
    store.set("hermes_catalog_refreshed_at", { checkedAt: null, attemptedAt: null });

    const res = await tick();

    expect(res.status).toBe(200);
    // Settle every microtask the fire-and-forget could have queued before
    // concluding that nothing was asked.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forcedRefreshCalls()).toHaveLength(0);
  });

  // These are the gates themselves, driven with an explicit clock. The tick
  // tests above prove the WIRING; only here can the daily cadence and the retry
  // floor actually be exercised, because two ticks milliseconds apart are held
  // by the module's own pre-existing 10 s explicit-refresh throttle and would
  // pass with both gates deleted.
  it("says which of the five things it did", async () => {
    const { CATALOG_REFRESH_KEY, CATALOG_MAX_AGE_MS, refreshCatalogIfDue } =
      await import("@/lib/hermes-model-options");
    const now = Date.now();
    const due = now - CATALOG_MAX_AGE_MS - 1;

    activeHarnessMock.mockResolvedValue("openclaw");
    expect(await refreshCatalogIfDue(now)).toBe("skipped");

    activeHarnessMock.mockResolvedValue("hermes");
    // Checked a second ago: the daily cadence holds.
    store.set(CATALOG_REFRESH_KEY, { checkedAt: now - 1_000, attemptedAt: now - 1_000 });
    expect(await refreshCatalogIfDue(now)).toBe("not-due");

    // Due, but the driver itself tried a minute ago: the retry floor holds. A
    // box whose dashboard is down would otherwise sweep every authenticated
    // provider's /v1/models 288 times a day.
    store.set(CATALOG_REFRESH_KEY, { checkedAt: due, attemptedAt: now - 60_000 });
    expect(await refreshCatalogIfDue(now)).toBe("throttled");

    store.set(CATALOG_REFRESH_KEY, { checkedAt: due, attemptedAt: due });
    expect(await refreshCatalogIfDue(now)).toBe("refreshed");

    // A dashboard that will not answer is "failed", and leaves the age alone.
    dashboardFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    store.set(CATALOG_REFRESH_KEY, { checkedAt: due, attemptedAt: due });
    expect(await refreshCatalogIfDue(now)).toBe("failed");
    expect(store.get(CATALOG_REFRESH_KEY)).toEqual({ checkedAt: due, attemptedAt: now });
  });

  it("does not let the owner's failed Refresh throttle the unattended retry", async () => {
    // `attemptedAt` spaces out the DRIVER's retries and governs nothing else.
    // Stamped from the owner's click too, an owner hammering Refresh on a box
    // with a flaky dashboard would silently suppress, for an hour, the
    // automatic recovery they were trying to trigger.
    const { CATALOG_REFRESH_KEY, CATALOG_MAX_AGE_MS } =
      await import("@/lib/hermes-model-options");
    const due = Date.now() - CATALOG_MAX_AGE_MS - 1;
    store.set(CATALOG_REFRESH_KEY, { checkedAt: due, attemptedAt: due });
    dashboardFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const route = await import("@/app/setup-api/hermes/models/route");
    await route.GET(new Request("http://127.0.0.1/setup-api/hermes/models?refresh=1"));

    expect(store.get(CATALOG_REFRESH_KEY)).toEqual({ checkedAt: due, attemptedAt: due });
  });
});
