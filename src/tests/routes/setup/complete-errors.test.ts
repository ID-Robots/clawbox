import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({
  set: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getOrCreateSecret: vi.fn(),
  createSessionCookie: vi.fn(),
}));

import { set } from "@/lib/config-store";
import { createSessionCookie, getOrCreateSecret } from "@/lib/auth";

const mockSet = vi.mocked(set);
const mockGetOrCreateSecret = vi.mocked(getOrCreateSecret);
const mockCreateSessionCookie = vi.mocked(createSessionCookie);

describe("POST /setup-api/setup/complete error paths", () => {
  let completePost: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSet.mockResolvedValue();
    mockGetOrCreateSecret.mockResolvedValue("test-secret");
    mockCreateSessionCookie.mockReturnValue("signed-cookie");

    const mod = await import("@/app/setup-api/setup/complete/route");
    completePost = mod.POST;
  });

  it("still succeeds when auto-login cookie creation fails", async () => {
    mockGetOrCreateSecret.mockRejectedValueOnce(new Error("secret unavailable"));

    const response = await completePost();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rolls back and returns 500 when setup completion persistence fails", async () => {
    mockSet
      .mockRejectedValueOnce(new Error("write failed"))
      .mockRejectedValue(new Error("rollback failed"));

    const response = await completePost();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "write failed" });
    expect(mockSet).toHaveBeenNthCalledWith(1, "setup_complete", true);
    expect(mockSet).toHaveBeenNthCalledWith(2, "setup_complete", undefined);
    expect(mockSet).toHaveBeenNthCalledWith(3, "setup_completed_at", undefined);
  });
});
