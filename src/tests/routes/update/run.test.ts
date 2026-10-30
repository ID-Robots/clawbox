import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

vi.mock("@/lib/updater", () => ({
  startUpdate: vi.fn(),
  isUpdateCompleted: vi.fn(),
  releaseBusyWait: vi.fn(),
  updateInFlight: vi.fn(),
}));

// The busy gate's count (issue #1269): the gateway's WebSocket and the coding
// agent's store, never the real ones in a route test.
vi.mock("@/lib/update-busy-server", () => ({
  activeAgentWork: vi.fn(),
}));

// The /updating screen's "What's new" prefetch (TASK-1205): git and GitHub,
// which this route only ever fires and forgets.
vi.mock("@/lib/update-whats-new-server", () => ({
  prefetchUpdateWhatsNew: vi.fn(),
}));

import { startUpdate, isUpdateCompleted, releaseBusyWait, updateInFlight } from "@/lib/updater";
import { prefetchUpdateWhatsNew } from "@/lib/update-whats-new-server";
import { activeAgentWork } from "@/lib/update-busy-server";

const mockStartUpdate = vi.mocked(startUpdate);
const mockIsUpdateCompleted = vi.mocked(isUpdateCompleted);
const mockPrefetch = vi.mocked(prefetchUpdateWhatsNew);
const mockReleaseBusyWait = vi.mocked(releaseBusyWait);
const mockUpdateInFlight = vi.mocked(updateInFlight);
const mockActiveAgentWork = vi.mocked(activeAgentWork);
const IDLE = { agentRuns: 0, subagentRuns: 0, codingRuns: 0, total: 0 };

describe("POST /setup-api/update/run", () => {
  let updateRunPost: (req: Request) => Promise<Response>;
  let session: SessionFixture;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: JSON.stringify(body),
    });
  }

  function emptyRequest(): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { Cookie: session.cookie },
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    session = installSessionFixture();

    mockStartUpdate.mockReturnValue({ started: true });
    mockIsUpdateCompleted.mockResolvedValue(false);
    mockPrefetch.mockResolvedValue(undefined);
    mockReleaseBusyWait.mockReturnValue(false);
    mockUpdateInFlight.mockResolvedValue(false);
    mockActiveAgentWork.mockResolvedValue(IDLE);

    const mod = await import("@/app/setup-api/update/run/route");
    updateRunPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    session.cleanup();
  });

  it("starts an update successfully", async () => {
    const res = await updateRunPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.started).toBe(true);
    expect(mockStartUpdate).toHaveBeenCalled();
  });

  it("skips update when already completed", async () => {
    mockIsUpdateCompleted.mockResolvedValue(true);

    const res = await updateRunPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.started).toBe(false);
    expect(body.already_completed).toBe(true);
    expect(mockStartUpdate).not.toHaveBeenCalled();
  });

  it("forces update even when completed", async () => {
    mockIsUpdateCompleted.mockResolvedValue(true);

    const res = await updateRunPost(jsonRequest({ force: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.started).toBe(true);
    expect(mockStartUpdate).toHaveBeenCalled();
  });

  it("passes the owner's explicit downgrade override, and nothing short of a literal true", async () => {
    // "Back up and update anyway" (src/lib/harness-downgrade.ts): without it the
    // updater refuses a run that would install an older harness.
    await updateRunPost(jsonRequest({ force: true }));
    expect(mockStartUpdate).toHaveBeenLastCalledWith({ allowHarnessDowngrade: false, ignoreBusy: false });
    await updateRunPost(jsonRequest({ force: true, allowHarnessDowngrade: "true" }));
    expect(mockStartUpdate).toHaveBeenLastCalledWith({ allowHarnessDowngrade: false, ignoreBusy: false });
    await updateRunPost(jsonRequest({ force: true, allowHarnessDowngrade: true }));
    expect(mockStartUpdate).toHaveBeenLastCalledWith({ allowHarnessDowngrade: true, ignoreBusy: false });
  });

  describe("the busy gate (issue #1269)", () => {
    const BUSY = { agentRuns: 1, subagentRuns: 1, codingRuns: 1, total: 3 };

    it("refuses 409 with the counts while agent runs are active, and starts nothing", async () => {
      mockActiveAgentWork.mockResolvedValue(BUSY);
      const res = await updateRunPost(jsonRequest({ force: true }));
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toMatchObject({ busy: true, counts: BUSY, waitMs: 900_000 });
      expect(body.error).toMatch(/^3 agent runs are active.*ignoreBusy: true/);
      expect(mockStartUpdate).not.toHaveBeenCalled();
      expect(mockPrefetch).not.toHaveBeenCalled();
    });

    it("starts over active runs on the owner's \"Update anyway\" — a literal true only — and tells the run", async () => {
      mockActiveAgentWork.mockResolvedValue(BUSY);
      expect((await updateRunPost(jsonRequest({ force: true, ignoreBusy: "true" }))).status).toBe(409);
      expect(mockStartUpdate).not.toHaveBeenCalled();

      const res = await updateRunPost(jsonRequest({ force: true, ignoreBusy: true }));
      expect(res.status).toBe(200);
      expect(mockStartUpdate).toHaveBeenLastCalledWith({ allowHarnessDowngrade: false, ignoreBusy: true });
      // Not even asked: the owner has already chosen.
      expect(mockActiveAgentWork).toHaveBeenCalledTimes(1);
    });

    it("starts when nothing is active", async () => {
      const res = await updateRunPost(jsonRequest({ force: true }));
      expect(res.status).toBe(200);
      expect(mockActiveAgentWork).toHaveBeenCalledTimes(1);
      expect(mockStartUpdate).toHaveBeenCalledTimes(1);
    });

    it("ends a running update's wait on \"Update anyway\" instead of starting another", async () => {
      mockReleaseBusyWait.mockReturnValue(true);
      const res = await updateRunPost(jsonRequest({ ignoreBusy: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ started: false, busyReleased: true });
      expect(mockStartUpdate).not.toHaveBeenCalled();
    });

    it("does not answer busy for an update that is already running — that is startUpdate's to say", async () => {
      mockUpdateInFlight.mockResolvedValue(true);
      mockActiveAgentWork.mockResolvedValue(BUSY);
      mockStartUpdate.mockReturnValue({ started: false, error: "Update already in progress" });
      const res = await updateRunPost(jsonRequest({ force: true }));
      expect(res.status).toBe(200);
      expect(mockActiveAgentWork).not.toHaveBeenCalled();
      expect((await res.json()).error).toBe("Update already in progress");
    });
  });

  it("handles invalid JSON body gracefully", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: "not json",
    });

    const res = await updateRunPost(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.started).toBe(true);
    // Invalid JSON is treated as no body, so force=false
  });

  it("prefetches the What's new panel once the update has started, without waiting for it", async () => {
    // A prefetch that never settles must not hold the answer.
    mockPrefetch.mockReturnValue(new Promise(() => {}));

    const res = await updateRunPost(emptyRequest());

    expect((await res.json()).started).toBe(true);
    expect(mockPrefetch).toHaveBeenCalledTimes(1);
  });

  it("prefetches nothing when no update started", async () => {
    mockStartUpdate.mockReturnValue({ started: false, error: "An update is already running" });
    await updateRunPost(emptyRequest());
    mockIsUpdateCompleted.mockResolvedValue(true);
    await updateRunPost(emptyRequest());

    expect(mockPrefetch).not.toHaveBeenCalled();
  });

  it("returns 500 when startUpdate throws", async () => {
    mockStartUpdate.mockImplementation(() => {
      throw new Error("Update system unavailable");
    });

    const res = await updateRunPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Update system unavailable");
  });

  it("returns generic error for non-Error throws", async () => {
    mockStartUpdate.mockImplementation(() => {
      throw "unknown error";
    });

    const res = await updateRunPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to start update");
  });
});
