import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

vi.mock("@/lib/updater", () => ({
  startUpdate: vi.fn(),
  isUpdateCompleted: vi.fn(),
}));

// The /updating screen's "What's new" prefetch (TASK-1205): git and GitHub,
// which this route only ever fires and forgets.
vi.mock("@/lib/update-whats-new-server", () => ({
  prefetchUpdateWhatsNew: vi.fn(),
}));

import { startUpdate, isUpdateCompleted } from "@/lib/updater";
import { prefetchUpdateWhatsNew } from "@/lib/update-whats-new-server";

const mockStartUpdate = vi.mocked(startUpdate);
const mockIsUpdateCompleted = vi.mocked(isUpdateCompleted);
const mockPrefetch = vi.mocked(prefetchUpdateWhatsNew);

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
