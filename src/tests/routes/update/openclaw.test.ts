import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

vi.mock("@/lib/updater", () => ({
  startOpenclawUpdate: vi.fn(),
}));

import { startOpenclawUpdate } from "@/lib/updater";

const mockStartOpenclawUpdate = vi.mocked(startOpenclawUpdate);

describe("POST /setup-api/update/openclaw", () => {
  let postOpenclawUpdate: () => Promise<Response>;
  let session: SessionFixture;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    session = installSessionFixture();

    mockStartOpenclawUpdate.mockReturnValue({ started: true });

    const mod = await import("@/app/setup-api/update/openclaw/route");
    // The owner's click: the route checks for a signed-in person itself.
    postOpenclawUpdate = () => mod.POST(new Request("http://localhost/setup-api/update/openclaw", {
      method: "POST",
      headers: { Cookie: session.cookie },
    }));
  });

  afterEach(() => {
    session.cleanup();
  });

  it("starts an OpenClaw update", async () => {
    const response = await postOpenclawUpdate();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ started: true });
  });

  it("returns 409 when an update is already running", async () => {
    mockStartOpenclawUpdate.mockReturnValueOnce({
      started: false,
      error: "Update already in progress",
    });

    const response = await postOpenclawUpdate();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      started: false,
      error: "Update already in progress",
    });
  });

  it("returns a specific 500 error when startup throws", async () => {
    mockStartOpenclawUpdate.mockImplementationOnce(() => {
      throw new Error("Systemd unavailable");
    });

    const response = await postOpenclawUpdate();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Systemd unavailable" });
  });

  it("returns the generic 500 error for non-Error throws", async () => {
    mockStartOpenclawUpdate.mockImplementationOnce(() => {
      throw "boom";
    });

    const response = await postOpenclawUpdate();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to start OpenClaw update" });
  });
});
