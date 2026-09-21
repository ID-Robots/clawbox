import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { RESOURCE_LIMITS } from "@/lib/resource-limits";

/**
 * The /setup-api/system/power-profile contract (TASK-455).
 *
 * Same shape as the desktop route's test, plus the one thing this route does
 * that the other doesn't: it echoes the memory guards back, so the Settings
 * card can state them instead of the UI carrying a third copy of the numbers.
 */

vi.mock("@/lib/system-profile", async () => {
  const actual = await vi.importActual<typeof import("@/lib/system-profile")>("@/lib/system-profile");
  return { ...actual, readPowerMode: vi.fn(), setPowerMode: vi.fn() };
});

import { GET, POST } from "@/app/setup-api/system/power-profile/route";
import { ProfileUnavailableError, readPowerMode, setPowerMode } from "@/lib/system-profile";

const mockRead = vi.mocked(readPowerMode);
const mockSet = vi.mocked(setPowerMode);

const BALANCED = {
  supported: true, mode: "balanced" as const, nvpmodelId: 1, nvpmodelName: "25W",
  clocksPinned: false, balancedId: 1, performanceId: 2,
};
const PINNED = { ...BALANCED, mode: "performance" as const, nvpmodelId: 2, nvpmodelName: "MAXN_SUPER", clocksPinned: true };

let session: SessionFixture;

beforeEach(() => {
  session = installSessionFixture();
  mockRead.mockResolvedValue({ ...BALANCED });
  mockSet.mockResolvedValue({ ...PINNED });
});

afterEach(() => session.cleanup());

function req(init: RequestInit & { auth?: boolean } = {}) {
  const { auth = true, ...rest } = init;
  return new Request("http://localhost/setup-api/system/power-profile", {
    ...rest,
    headers: auth ? { Cookie: session.cookie, ...(rest.headers ?? {}) } : rest.headers,
  });
}

describe("GET /setup-api/system/power-profile", () => {
  it("returns the profile and the memory guards in force", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject(BALANCED);
    expect(body.limits).toEqual(RESOURCE_LIMITS);
  });

  it("is 401 without a session", async () => {
    expect((await GET(req({ auth: false }))).status).toBe(401);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/system/power-profile", () => {
  it("switches to the pinned profile", async () => {
    const res = await POST(req({ method: "POST", body: JSON.stringify({ mode: "performance" }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "performance", clocksPinned: true });
    expect(mockSet).toHaveBeenCalledWith("performance");
  });

  it("switches back to balanced", async () => {
    mockSet.mockResolvedValue({ ...BALANCED });
    const res = await POST(req({ method: "POST", body: JSON.stringify({ mode: "balanced" }) }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith("balanced");
  });

  it("is 401 without a session, and does not touch the clocks", async () => {
    const res = await POST(req({ auth: false, method: "POST", body: JSON.stringify({ mode: "performance" }) }));
    expect(res.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("is 401 during the first-boot window too", async () => {
    session.cleanup();
    session = installSessionFixture({ passwordConfigured: false });
    const res = await POST(new Request("http://localhost/setup-api/system/power-profile", {
      method: "POST",
      body: JSON.stringify({ mode: "performance" }),
    }));
    expect(res.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects any mode the script does not implement", async () => {
    for (const bad of ["MAXN_SUPER", "maxn", "", 2, true, null, undefined, ["balanced"]]) {
      const res = await POST(req({ method: "POST", body: JSON.stringify({ mode: bad }) }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    expect((await POST(req({ method: "POST", body: "mode=performance" }))).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("answers 503 when the root-owned script is not installed", async () => {
    mockSet.mockRejectedValue(new ProfileUnavailableError("clawbox-power-mode.sh"));
    const res = await POST(req({ method: "POST", body: JSON.stringify({ mode: "performance" }) }));
    expect(res.status).toBe(503);
  });

  it("answers 500 when nvpmodel fails", async () => {
    mockSet.mockRejectedValue(new Error("nvpmodel: command not found"));
    const res = await POST(req({ method: "POST", body: JSON.stringify({ mode: "performance" }) }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("nvpmodel");
  });
});
