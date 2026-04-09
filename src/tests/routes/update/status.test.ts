import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { UpdateState } from "@/lib/updater";

vi.mock("@/lib/updater", () => ({
  getUpdateState: vi.fn(),
  isUpdateCompleted: vi.fn(),
  checkContinuation: vi.fn(),
  getVersionInfo: vi.fn(),
}));

import { getUpdateState, isUpdateCompleted, checkContinuation, getVersionInfo } from "@/lib/updater";

const mockGetUpdateState = vi.mocked(getUpdateState);
const mockIsUpdateCompleted = vi.mocked(isUpdateCompleted);
const mockCheckContinuation = vi.mocked(checkContinuation);
const mockGetVersionInfo = vi.mocked(getVersionInfo);

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
    });

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

  it("returns completed state when update was completed", async () => {
    mockIsUpdateCompleted.mockResolvedValue(true);

    const res = await updateStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("completed");
    expect(body.steps.every((s: { status: string }) => s.status === "completed")).toBe(true);
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
});
