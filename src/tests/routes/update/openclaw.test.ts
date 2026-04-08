import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/updater", () => ({
  startOpenclawUpdate: vi.fn(),
}));

import { startOpenclawUpdate } from "@/lib/updater";

const mockStartOpenclawUpdate = vi.mocked(startOpenclawUpdate);

describe("POST /setup-api/update/openclaw", () => {
  let postOpenclawUpdate: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockStartOpenclawUpdate.mockReturnValue({ started: true });

    const mod = await import("@/app/setup-api/update/openclaw/route");
    postOpenclawUpdate = mod.POST;
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
