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

  it("keeps owing it while SYSTEMD says the unit is still starting, past the clock backstop", async () => {
    dashboardDown();
    await mod.getModelOptions();
    unitStateMock.mockResolvedValue("starting");

    // Well past the clock backstop, well inside the unit's own start budget: a
    // loaded box still running its ExecStartPre is exactly the case a short
    // fixed grace calls broken.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + 10 * mod.PROBE_GRACE_MS);
    expect(10 * mod.PROBE_GRACE_MS).toBeLessThan(mod.UNIT_START_BUDGET_MS);

    expect(await mod.probeStillOwed()).toBe(true);
  });

  it("stops owing it once the unit's own start budget is spent", async () => {
    // `activating` is not a promise that an answer is coming, only that systemd
    // has not given up yet — and systemd DOES give up:
    // `TimeoutStartSec=300` in the shipped unit. An `activating` branch with no
    // clock at all makes the whole `checking` window unbounded, so the panel
    // that opened during a crash loop keeps being told "Checking..." for as long
    // as it stays open. The bound is the point of the state.
    dashboardDown();
    await mod.getModelOptions();
    unitStateMock.mockResolvedValue("starting");

    const realNow = Date.now();
    // Just inside the budget the unit file allows, then just past it.
    let offset = mod.UNIT_START_BUDGET_MS - 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => realNow + offset);
    expect(await mod.probeStillOwed()).toBe(true);

    offset = mod.UNIT_START_BUDGET_MS + 1_000;
    expect(await mod.probeStillOwed()).toBe(false);
  });

  it("owes nothing at all when the unit has failed, is masked, or is CRASH-LOOPING", async () => {
    dashboardDown();
    await mod.getModelOptions();
    // Inside the clock backstop, so only the unit state can produce this answer.
    // `down` is also what `activating`/`auto-restart` classifies as (see
    // `hermes-dashboard-control`), and that is the case that matters most here:
    // a dashboard restarting every 5 s since boot degrades on the first poll
    // instead of reading "Checking..." for as long as the panel stays open.
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

  it("does not degrade the moment a slow start FORKS, which is not the moment it answers", async () => {
    // The unit is `Type=simple`, so systemd says `active/running` when ExecStart
    // forks — with the web-dist build and the socket bind still ahead of it. The
    // socket clock therefore has to start when the unit STOPPED starting, not
    // when our first read failed, or a start-up that spent longer than the
    // backstop in ExecStartPre lands in `running` with its grace already spent
    // and flashes "Unknown" under the degraded banner for the last eleven
    // seconds of a perfectly healthy boot.
    dashboardDown();
    await mod.getModelOptions();
    unitStateMock.mockResolvedValue("starting");

    const realNow = Date.now();
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow + offset);

    // Forty seconds of ExecStartPre — well past the socket backstop, well inside
    // the unit's own start budget.
    offset = 40_000;
    expect(await mod.probeStillOwed()).toBe(true);

    // ...and now it forks.
    offset = 41_000;
    unitStateMock.mockResolvedValue("running");
    expect(await mod.probeStillOwed()).toBe(true);

    // The socket window is still bounded, just measured from the right moment.
    offset = 41_000 + mod.PROBE_GRACE_MS + 1_000;
    expect(await mod.probeStillOwed()).toBe(false);
  });

  it("gives the app's OWN dashboard bounce the same benefit as any other restart", async () => {
    // `bounceHermesDashboard` stops the dashboard so `Restart=always` brings it
    // back, and the unit then sits in activating/auto-restart for the whole
    // RestartSec=5. Reading that as "nothing is coming" paints the red banner
    // over a restart the owner's own click asked for.
    dashboardDown();
    await mod.getModelOptions();
    unitStateMock.mockResolvedValue("restarting");

    expect(await mod.probeStillOwed()).toBe(true);

    // Bounded, though: a crash loop is the same state seen for ever, and it must
    // reach the honest banner rather than spinning.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + mod.PROBE_GRACE_MS + 1_000);
    expect(await mod.probeStillOwed()).toBe(false);
  });

  it.each(["starting", "restarting", "running", "unknown"] as const)(
    "stops owing an answer past the worst case whatever systemd says (%s)",
    async (unit) => {
      // The property the whole state depends on: there is NO branch in which
      // `checking` outlives `MAX_CHECKING_WINDOW_MS`. An unbounded one turns the
      // honest "Checking..." into a permanent spinner — the same lie as the
      // degraded banner it replaces, pointing the other way — and it is what the
      // systemd branch shipped with before this test existed.
      dashboardDown();
      await mod.getModelOptions();
      unitStateMock.mockResolvedValue(unit);

      const realNow = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => realNow + mod.MAX_CHECKING_WINDOW_MS + 1_000);

      expect(await mod.probeStillOwed()).toBe(false);
    },
  );

  it("asks systemd once a second, not once a request", async () => {
    // Two panels mount this endpoint's hook on Settings -> AI and each re-asks
    // while a row is checking, so an unmemoised read forks `systemctl` several
    // times a second during exactly the window this feature exists for.
    dashboardDown();
    await mod.getModelOptions();
    unitStateMock.mockClear();

    await mod.probeStillOwed();
    await mod.probeStillOwed();
    await mod.probeStillOwed();
    expect(unitStateMock).toHaveBeenCalledTimes(1);

    // ...and the answer never outlives its second: the fact stays as current as
    // the client's fastest retry step.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + 2_000);
    await mod.probeStillOwed();
    expect(unitStateMock).toHaveBeenCalledTimes(2);
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

  it("does not open a debt on a failure a NEWER read has already disproved", async () => {
    // `load()` single-flights per MODE, so a plain load and an explicit refresh
    // really can be in flight together — and they settle out of order whenever
    // the plain one is an 8 s dashboard timeout from before the box came up and
    // the refresh lands the moment it does. That stale failure used to open a
    // debt against a dashboard that had just answered, and the panel then said
    // "Checking..." over a live box.
    let failTheFirstRead: () => void = () => {};
    const firstRead = new Promise<never>((_resolve, reject) => {
      failTheFirstRead = () => reject(new Error("connect ECONNREFUSED"));
    });
    dashboardUp();
    const answering = dashboardFetchMock.getMockImplementation()!;
    let asked = 0;
    dashboardFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/model/options") && ++asked === 1) return firstRead;
      return answering(path);
    });

    const plain = mod.getModelOptions();
    const refreshed = await mod.getModelOptions({ refresh: true });
    expect(refreshed.stale).toBe(false);

    failTheFirstRead();
    await plain;

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
