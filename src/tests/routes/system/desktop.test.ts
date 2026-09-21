import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * The /setup-api/system/desktop contract (TASK-455).
 *
 * The model is mocked: what this file guards is the HTTP surface — that both
 * verbs are owner-only with no bootstrap carve-out, that a bad body is a 400
 * and never reaches the system, and that a box missing the root-owned script
 * says so with a 503 instead of a bare 500.
 */

vi.mock("@/lib/system-profile", async () => {
  const actual = await vi.importActual<typeof import("@/lib/system-profile")>("@/lib/system-profile");
  return {
    ...actual,
    readDesktopMode: vi.fn(),
    setDesktopMode: vi.fn(),
  };
});

import { GET, POST } from "@/app/setup-api/system/desktop/route";
import {
  ProfileUnavailableError,
  readDesktopMode,
  setDesktopMode,
} from "@/lib/system-profile";

const mockRead = vi.mocked(readDesktopMode);
const mockSet = vi.mocked(setDesktopMode);

const STATUS = {
  supported: true,
  enabled: true,
  active: true,
  rebootRequired: false,
  defaultTarget: "graphical.target",
  displayManager: "gdm3:alias",
};

let session: SessionFixture;

beforeEach(() => {
  session = installSessionFixture();
  mockRead.mockResolvedValue({ ...STATUS });
  mockSet.mockResolvedValue({ ...STATUS, enabled: false, rebootRequired: true });
});

afterEach(() => session.cleanup());

function req(init: RequestInit & { auth?: boolean } = {}) {
  const { auth = true, ...rest } = init;
  return new Request("http://localhost/setup-api/system/desktop", {
    ...rest,
    headers: auth ? { Cookie: session.cookie, ...(rest.headers ?? {}) } : rest.headers,
  });
}

describe("GET /setup-api/system/desktop", () => {
  it("returns the current state to the owner", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS);
  });

  it("is 401 without a session", async () => {
    const res = await GET(req({ auth: false }));
    expect(res.status).toBe(401);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/system/desktop", () => {
  it("turns the desktop off and reports that a reboot is needed", async () => {
    const res = await POST(req({ method: "POST", body: JSON.stringify({ enabled: false }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, rebootRequired: true });
    expect(mockSet).toHaveBeenCalledWith(false);
  });

  it("turns it back on", async () => {
    mockSet.mockResolvedValue({ ...STATUS });
    const res = await POST(req({ method: "POST", body: JSON.stringify({ enabled: true }) }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(true);
  });

  it("is 401 without a session, and does not touch the system", async () => {
    const res = await POST(req({ auth: false, method: "POST", body: JSON.stringify({ enabled: false }) }));
    expect(res.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("is 401 during the first-boot window too — there is no bootstrap carve-out", async () => {
    session.cleanup();
    session = installSessionFixture({ passwordConfigured: false });
    const res = await POST(new Request("http://localhost/setup-api/system/desktop", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    }));
    expect(res.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean `enabled`", async () => {
    for (const bad of ["false", 0, null, undefined, {}, []]) {
      const res = await POST(req({ method: "POST", body: JSON.stringify({ enabled: bad }) }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(req({ method: "POST", body: "enabled=false" }));
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("answers 503, with the fix, when the root-owned script is not installed", async () => {
    mockSet.mockRejectedValue(new ProfileUnavailableError("clawbox-desktop-mode.sh"));
    const res = await POST(req({ method: "POST", body: JSON.stringify({ enabled: false }) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("install.sh --step performance_mode");
  });

  it("answers 500 when the script itself fails", async () => {
    mockSet.mockRejectedValue(new Error("sudo: a password is required"));
    const res = await POST(req({ method: "POST", body: JSON.stringify({ enabled: false }) }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("password is required");
  });
});
