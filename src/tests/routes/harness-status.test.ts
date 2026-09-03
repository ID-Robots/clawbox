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
/** Every harness these tests name is up; health is not what they are about. */
const harnessHealthy = vi.fn(async (harness: string) => Boolean(harness));
vi.mock("@/lib/harness", () => ({
  getActiveHarness: () => getActiveHarness(),
  harnessHealthy: (h: string) => harnessHealthy(h),
  getEdition: () => "hermes",
  isSingleHarnessEdition: () => true,
  HARNESSES: {
    openclaw: { id: "openclaw", label: "OpenClaw" },
    hermes: { id: "hermes", label: "Hermes" },
  },
}));

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

async function get() {
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

    expect((await get()).shellScan.state).toBe("on");
  });

  it("says nothing about scanning on the OpenClaw harness, which has no scanner", async () => {
    getActiveHarness.mockResolvedValue("openclaw");

    const body = await get();

    expect(body.shellScan).toBeNull();
    expect(readShellScanStatus).not.toHaveBeenCalled();
  });
});
