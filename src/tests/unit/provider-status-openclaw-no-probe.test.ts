import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-663 — the OpenClaw leg must not acquire a probe, and this is the test
 * that can tell.
 *
 * `probeStillOwed` is the only route from `provider-status` to the systemd
 * read, and the systemd read is over `clawbox-hermes-dashboard.service` — a
 * unit an OpenClaw box has deliberately STOPPED AND DISABLED as part of its
 * foreign-edition teardown. Forking `systemctl` over it on every
 * `/setup-api/providers/status` would be asking a question whose answer is
 * meaningless there, on the edition that is the majority of the fleet.
 *
 * The route suite covers the same ground with `@/lib/hermes-model-options`
 * module-mocked, which can pin that the predicate is not CALLED but can never
 * pin that nothing is SPAWNED — with the module replaced, no spawn is reachable
 * in that file at all, so the assertion would hold over a broken build. Here
 * the real `provider-status`, the real `hermes-model-options` and the real
 * `hermes-dashboard-control` are loaded and `child_process` is what is
 * replaced, so the count is a fact about the code rather than about the mock.
 *
 * TWO THINGS MAKE THE COUNT MEAN SOMETHING, and without either of them this
 * test is the same fixture-only assertion it replaces:
 *
 *   1. the probe debt is PRIMED first. `probeStillOwed` short-circuits to false
 *      on a process where no dashboard read has ever failed, before it reaches
 *      systemd at all — so on a cold module the fork is unreachable and "zero
 *      spawns" holds however badly the leg is wired. (Checked by mutation: with
 *      the probe deliberately spliced into `readOpenclawStatus`, the unprimed
 *      version of this test still passed.) A failed `getModelOptions()` opens
 *      the debt, which is a state a real dual-edition process reaches.
 *   2. the Hermes case below is the positive control: the same entry point,
 *      down the branch that DOES ask systemd, asserting the fork happens.
 */

const execFileMock = vi.hoisted(() => vi.fn());
const dashboardFetchMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ execFile: execFileMock, spawn: spawnMock }));
vi.mock("fs/promises", () => ({ default: { readFile: readFileMock }, readFile: readFileMock }));
vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: dashboardFetchMock,
  HERMES_DASHBOARD_UNIT: "clawbox-hermes-dashboard.service",
}));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" }) }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: vi.fn().mockResolvedValue(null),
  invalidateHermesConfigCache: vi.fn(),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(), HERMES_BIN: "/usr/bin/hermes" }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));

/** Every `systemctl` argv the module forked, so the claim can name the unit. */
function systemctlCalls(): string[][] {
  return execFileMock.mock.calls
    .filter(([bin]) => String(bin).includes("systemctl"))
    .map(([, args]) => args as string[]);
}

describe("readProviderStatus — the systemd read belongs to the Hermes leg alone", () => {
  let readProviderStatus: typeof import("@/lib/provider-status").readProviderStatus;
  let getActiveHarness: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Nothing on disk, nothing answering: the shape that makes a Hermes payload
    // stale, which is the only shape in which the probe is consulted at all.
    dashboardFetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: unknown) => {
      (cb as (e: Error | null, out: { stdout: string; stderr: string }) => void)(null, {
        stdout: "LoadState=loaded\nActiveState=activating\nSubState=start-pre\n",
        stderr: "",
      });
    });
    ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as {
      getActiveHarness: ReturnType<typeof vi.fn>;
    });
    const credentials = (await import("@/lib/harness/credentials")) as unknown as {
      hasClawaiToken: ReturnType<typeof vi.fn>;
    };
    credentials.hasClawaiToken.mockResolvedValue(false);
    const openclawConfig = (await import("@/lib/openclaw-config")) as unknown as {
      readConfig: ReturnType<typeof vi.fn>;
    };
    openclawConfig.readConfig.mockResolvedValue({});
    const store = (await import("@/lib/config-store")) as unknown as { get: ReturnType<typeof vi.fn> };
    store.get.mockResolvedValue(null);
    ({ readProviderStatus } = await import("@/lib/provider-status"));

    // Prime the debt — see (1) at the top. Without this the predicate answers
    // false before it ever reaches systemd and the assertion below is vacuous.
    const modelOptions = await import("@/lib/hermes-model-options");
    await modelOptions.getModelOptions();
    expect(await modelOptions.probeStillOwed()).toBe(true);

    // Past the unit-state memo, so a leg that asks systemd really does fork
    // rather than being answered from the second the priming call just paid
    // for. Well inside the start budget, so the answer itself is unchanged.
    const primedAt = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => primedAt + 2_000);
    execFileMock.mockClear();
  });

  afterEach(() => {
    // The `Date.now` spy above is per-test; leaving it installed would move the
    // clock for whatever runs next in this worker.
    vi.restoreAllMocks();
  });

  it("never forks systemctl over the Hermes unit an OpenClaw box has disabled", async () => {
    getActiveHarness.mockResolvedValue("openclaw");

    const summary = await readProviderStatus();

    expect(summary.harness).toBe("openclaw");
    expect(systemctlCalls()).toEqual([]);
    // ...and the state that would be the symptom of the probe leaking in here:
    // this reader answers from the config it just read, so every row is a
    // definite yes or no and none of them is ever "checking".
    expect(summary.providers.map((row) => row.state)).not.toContain("checking");
  });

  it("DOES fork it on the Hermes leg — the control that makes the count above a fact", async () => {
    getActiveHarness.mockResolvedValue("hermes");

    await readProviderStatus();

    const calls = systemctlCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("clawbox-hermes-dashboard.service");
  });
});
