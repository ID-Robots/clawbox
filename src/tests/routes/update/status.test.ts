import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { UpdateState } from "@/lib/updater";

vi.mock("@/lib/updater", () => ({
  getUpdateState: vi.fn(),
  isUpdateCompleted: vi.fn(),
  checkContinuation: vi.fn(),
  getVersionInfo: vi.fn(),
}));

vi.mock("@/lib/build-identity", () => ({
  collectBuildIdentity: vi.fn(),
}));

import { getUpdateState, isUpdateCompleted, checkContinuation, getVersionInfo } from "@/lib/updater";
import { collectBuildIdentity } from "@/lib/build-identity";

const mockCollectBuildIdentity = vi.mocked(collectBuildIdentity);
const mockGetUpdateState = vi.mocked(getUpdateState);
const mockIsUpdateCompleted = vi.mocked(isUpdateCompleted);
const mockCheckContinuation = vi.mocked(checkContinuation);
const mockGetVersionInfo = vi.mocked(getVersionInfo);


/**
 * TASK-447 round 2, defect 1: this route synthesised "completed" — which the
 * System Update app renders as a green tick and "You're up to date" — on a box
 * whose build-identity was simultaneously telling the owner to run Update.
 * Versions cannot see it: package.json does not change commit-to-commit.
 */
const NO_DRIFT = {
  buildVsCheckout: "match" as const,
  checkoutVsPin: "match" as const,
  detected: false,
  reasons: [],
  codes: [] as never[],
};

const DRIFTED = {
  buildVsCheckout: "drift" as const,
  checkoutVsPin: "drift" as const,
  detected: true,
  reasons: ["This box is running a build made from 1dc29ef but the code on disk is d285cfd — run Update to realign."],
  codes: ["build-from-other-commit" as const],
};

function buildIdentity(drift: typeof NO_DRIFT | typeof DRIFTED) {
  return {
    build: null,
    deployedBuildId: null,
    checkout: { commit: null, shortCommit: null, branch: null, dirty: false, committedAt: null },
    pin: { branch: "beta", source: "pin-file" as const, commit: null, pinned: true },
    drift,
  };
}

describe("GET /setup-api/update/status", () => {
  let updateStatusGet: () => Promise<Response>;

  const defaultState: UpdateState = {
    phase: "idle" as const,
    steps: [
      { id: "check", status: "pending" as const, label: "Check for updates" },
      { id: "pull", status: "pending" as const, label: "Download updates" },
      { id: "build", status: "pending" as const, label: "Build" },
      { id: "restart", status: "pending" as const, label: "Restart" },
    ],
    currentStepIndex: 0,
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetUpdateState.mockReturnValue(defaultState);
    mockIsUpdateCompleted.mockResolvedValue(false);
    mockCheckContinuation.mockResolvedValue(false);
    mockGetVersionInfo.mockResolvedValue({
      clawbox: { current: "1.0.0", target: "1.1.0" },
      openclaw: { current: "0.5.0", target: "0.5.1" },
      edition: "openclaw", remote: { reachable: true },
    });
    mockCollectBuildIdentity.mockResolvedValue(buildIdentity(NO_DRIFT));

    const mod = await import("@/app/setup-api/update/status/route");
    updateStatusGet = mod.GET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns idle state with version info", async () => {
    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("idle");
    expect(body.targetVersion).toBe("1.1.0");
    expect(body.versions).toBeDefined();
  });

  it("returns completed state when update was completed and no updates are available", async () => {
    mockIsUpdateCompleted.mockResolvedValue(true);
    mockGetVersionInfo.mockResolvedValue({
      clawbox: { current: "1.1.0", target: null, updateAvailable: false },
      openclaw: { current: "0.5.1", target: null, updateAvailable: false },
      edition: "openclaw", remote: { reachable: true },
    });

    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("completed");
    expect(body.steps.every((s: { status: string }) => s.status === "completed")).toBe(true);
    expect(body.versions).toBeDefined();
  });

  it("returns idle version info when a newer update exists despite a stale completion flag", async () => {
    mockIsUpdateCompleted.mockResolvedValue(true);
    mockGetVersionInfo.mockResolvedValue({
      clawbox: { current: "1.0.0", target: "1.1.0", updateAvailable: true },
      openclaw: { current: "0.5.1", target: null, updateAvailable: false },
      edition: "openclaw", remote: { reachable: true },
    });

    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("idle");
    expect(body.targetVersion).toBe("1.1.0");
    expect(body.versions.clawbox.updateAvailable).toBe(true);
  });

  it("continues from post-restart state", async () => {
    // First call returns idle, checkContinuation runs, second call returns running
    mockGetUpdateState
      .mockReturnValueOnce(defaultState) // idle state triggers checkContinuation
      .mockReturnValueOnce({
        phase: "running" as const,
        steps: defaultState.steps.map(s => ({ ...s, status: "completed" as const })),
        currentStepIndex: defaultState.steps.length - 1,
      });
    mockCheckContinuation.mockResolvedValue(true);

    const res = await updateStatusGet();
    const body = await res.json();

    expect(mockCheckContinuation).toHaveBeenCalled();
    expect(body.phase).toBe("running");
  });

  it("returns running state directly", async () => {
    mockGetUpdateState.mockReturnValue({
      phase: "running" as const,
      steps: [
        { id: "check", status: "completed" as const, label: "Check for updates" },
        { id: "pull", status: "running" as const, label: "Download updates" },
        { id: "build", status: "pending" as const, label: "Build" },
        { id: "restart", status: "pending" as const, label: "Restart" },
      ],
      currentStepIndex: 1,
    });

    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("running");
    expect(body.steps[1].status).toBe("running");
  });

  it("returns error state", async () => {
    mockGetUpdateState.mockReturnValue({
      phase: "failed" as const,
      steps: defaultState.steps,
      error: "Build failed",
      currentStepIndex: 2,
    });

    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("failed");
    expect(body.error).toBe("Build failed");
  });

  it("returns 500 on exception", async () => {
    mockGetUpdateState.mockImplementation(() => {
      throw new Error("State read failed");
    });

    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("State read failed");
  });

  it("returns generic error for non-Error exceptions", async () => {
    mockGetUpdateState.mockImplementation(() => {
      throw "unknown error";
    });

    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Status check failed");
  });

  describe("drift outranks the completion flag", () => {
    beforeEach(() => {
      // The box the hardware pass produced: no version delta at all.
      mockIsUpdateCompleted.mockResolvedValue(true);
      mockGetVersionInfo.mockResolvedValue({
        clawbox: { current: "3.9.0", target: null, updateAvailable: false },
        openclaw: { current: "2026.7.1-2", target: null, updateAvailable: false },
        edition: "hermes", remote: { reachable: true },
      });
    });

    it("refuses to report 'completed' while the box is not running its own code", async () => {
      mockCollectBuildIdentity.mockResolvedValue(buildIdentity(DRIFTED));

      const body = await (await updateStatusGet()).json();

      expect(body.phase).toBe("idle");
      expect(body.steps.every((s: { status: string }) => s.status === "completed")).toBe(false);
    });

    it("says WHY, so the surface rendering it can offer the update with a reason", async () => {
      mockCollectBuildIdentity.mockResolvedValue(buildIdentity(DRIFTED));

      const body = await (await updateStatusGet()).json();

      expect(body.drift.detected).toBe(true);
      expect(body.drift.codes).toContain("build-from-other-commit");
    });

    it("still reports 'completed' on a healthy box", async () => {
      mockCollectBuildIdentity.mockResolvedValue(buildIdentity(NO_DRIFT));

      const body = await (await updateStatusGet()).json();

      expect(body.phase).toBe("completed");
    });

    it("does not fail the route when the drift read itself fails", async () => {
      // It shells out to git; a device that cannot answer must still get status.
      mockCollectBuildIdentity.mockRejectedValue(new Error("git: not a repository"));

      const res = await updateStatusGet();

      expect(res.status).toBe(200);
      expect((await res.json()).phase).toBe("completed");
    });
  });
});
