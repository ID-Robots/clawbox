import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The status route is what Settings → System reads. Until now it answered only
 * "which harness, is it up" — so a Hermes box running with pre-exec shell
 * scanning disabled looked exactly like a healthy one, on the dashboard and
 * everywhere else. It has to carry that fact.
 *
 * And it has to carry it ONLY where it means something: the OpenClaw harness
 * has no tirith, so reporting a missing scanner there would be a warning about
 * a component that box will never have.
 */

const getActiveHarness = vi.fn(async () => "hermes");
/** What the one resolution answers — the whole of what the route may use. */
const harnessSource = vi.fn(async () => ({
  active: await getActiveHarness(),
  defaulted: false,
  edition: "hermes" as string,
  locked: true,
}));
/** Every harness these tests name is up; health is not what they are about. */
const harnessHealthy = vi.fn(async (harness: string) => Boolean(harness));
vi.mock("@/lib/harness", () => ({
  // ONE call answers the harness, the edition AND the switcher state now, so
  // the response cannot be half about one edition and half about another —
  // and `locked` cannot cost a second licence verify across the awaits below.
  getActiveHarnessSource: async () => harnessSource(),
  getActiveHarness: () => getActiveHarness(),
  harnessHealthy: (h: string) => harnessHealthy(h),
  HARNESSES: {
    openclaw: { id: "openclaw", label: "OpenClaw" },
    hermes: { id: "hermes", label: "Hermes" },
  },
}));

/**
 * The response must be about ONE edition.
 *
 * `active`, `edition` and `locked` used to come from three reads of a file
 * `install.sh` rewrites on every update, taken across the health probes'
 * awaits: the route could answer `active: "hermes"` beside `edition: "openclaw"`
 * — a pair no real SKU can be in, since the openclaw edition is locked to its
 * own harness — and the Settings picker draws its badge from exactly that.
 */

interface ScanShape {
  state: string;
  reason: string;
  failOpen: boolean;
  scannerPath: string | null;
  retrySuppressedUntil: string | null;
}
const readShellScanStatus = vi.fn(
  async (): Promise<ScanShape> => ({
    state: "off",
    reason: "not-installed",
    failOpen: true,
    scannerPath: null,
    retrySuppressedUntil: null,
  }),
);
vi.mock("@/lib/hermes-shell-scan", () => ({
  readShellScanStatus: () => readShellScanStatus(),
}));

async function get(): Promise<{
  active: string;
  edition: string;
  locked: boolean;
  harnesses: { id: string }[];
  shellScan: { state: string; reason: string; scannerPath: string | null } | null;
}> {
  vi.resetModules();
  const mod = await import("@/app/setup-api/harness/status/route");
  return (await mod.GET()).json();
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveHarness.mockResolvedValue("hermes");
});

describe("GET /setup-api/harness/status — shell scanning posture", () => {
  it("reports that pre-exec shell scanning is off on a Hermes box", async () => {
    const body = await get();

    expect(body.shellScan).toMatchObject({ state: "off", reason: "not-installed", failOpen: true });
  });

  it("reports it as on when the scanner is there, so nothing warns on a healthy box", async () => {
    readShellScanStatus.mockResolvedValueOnce({
      state: "on",
      reason: "ok",
      failOpen: true,
      scannerPath: "/home/clawbox/.hermes/bin/tirith",
      retrySuppressedUntil: null,
    });

    expect((await get()).shellScan?.state).toBe("on");
  });

  it("says nothing about scanning on the OpenClaw harness, which has no scanner", async () => {
    getActiveHarness.mockResolvedValue("openclaw");

    const body = await get();

    expect(body.shellScan).toBeNull();
    expect(readShellScanStatus).not.toHaveBeenCalled();
  });
});

describe("GET /setup-api/harness/status — one edition per response", () => {
  it("reports the edition and the lock the harness was resolved WITH", async () => {
    // A licensed dual: unlocked, so both harnesses are probed and offered.
    harnessSource.mockResolvedValueOnce({
      active: "hermes",
      defaulted: false,
      edition: "dual",
      locked: false,
    });

    const body = await get();

    expect(body.edition).toBe("dual");
    expect(body.locked).toBe(false);
    expect(body.active).toBe("hermes");
    expect(body.harnesses.map((h: { id: string }) => h.id)).toEqual(["openclaw", "hermes"]);
  });

  it("probes only the active harness when that one resolution says locked", async () => {
    // The other half: on a locked device the other harness's runtime is not
    // installed, so probing it would report a missing gateway as a fault.
    harnessSource.mockResolvedValueOnce({
      active: "hermes",
      defaulted: false,
      edition: "hermes",
      locked: true,
    });

    const body = await get();

    expect(body.locked).toBe(true);
    expect(body.harnesses.map((h: { id: string }) => h.id)).toEqual(["hermes"]);
  });
});
