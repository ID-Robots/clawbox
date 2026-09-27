import { describe, expect, it, vi, beforeEach } from "vitest";

// TASK-1256: signing in as a ClawBox user other than the owner. The owner's
// login (no username) is the pre-multi-user one and must not change.

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
  DATA_DIR: `/tmp/clawbox-test-data-${process.pid}`,
}));

vi.mock("@/lib/auth", () => ({
  verifyPassword: vi.fn(),
  createSessionCookie: vi.fn().mockReturnValue("session.cookie"),
  getSessionSigningSecret: vi.fn().mockResolvedValue("secret"),
  getSessionGeneration: vi.fn().mockResolvedValue(0),
  getSystemUsername: vi.fn().mockReturnValue("clawbox"),
}));

vi.mock("@/lib/clawbox-users", () => ({
  findUser: vi.fn(),
  verifyUserPassword: vi.fn(),
}));

vi.mock("@/lib/system-password", () => ({
  hasOwnerPassword: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/login-rate-limit", () => ({
  checkLockout: vi.fn(),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
  padResponseTime: vi.fn().mockResolvedValue(undefined),
  SHARED_BUCKET_MAX_LOCK_MS: 300000,
}));

import * as config from "@/lib/config-store";
import { createSessionCookie, getSessionGeneration, getSessionSigningSecret, getSystemUsername, verifyPassword } from "@/lib/auth";
import { findUser, verifyUserPassword } from "@/lib/clawbox-users";
import { checkLockout, recordFailure, recordSuccess } from "@/lib/login-rate-limit";

const ALICE = { username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: "a1b2c3d4e5f60718" };

function login(body: Record<string, unknown>): Request {
  return new Request("http://localhost/login-api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration: 43200, ...body }),
  });
}

describe("/login-api — multi-user", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(config.get).mockResolvedValue(true as never);
    vi.mocked(createSessionCookie).mockReturnValue("session.cookie");
    vi.mocked(getSystemUsername).mockReturnValue("clawbox");
    vi.mocked(getSessionSigningSecret).mockResolvedValue("secret");
    vi.mocked(getSessionGeneration).mockResolvedValue(0);
    vi.mocked(verifyPassword).mockResolvedValue(false);
    vi.mocked(verifyUserPassword).mockResolvedValue(false);
    vi.mocked(findUser).mockImplementation(async (name: string) => (name === "alice" ? ALICE : null));
    vi.mocked(checkLockout).mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
    vi.mocked(recordFailure).mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
    vi.mocked(recordSuccess).mockResolvedValue(undefined);
    POST = (await import("@/app/login-api/route")).POST;
  });

  it("signs a second user in against THEIR Linux password and names them in the cookie", async () => {
    vi.mocked(verifyUserPassword).mockResolvedValue(true);

    const res = await POST(login({ username: "alice", password: "alices-password" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, username: "alice" });
    expect(verifyUserPassword).toHaveBeenCalledWith("alice", "alices-password");
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(createSessionCookie).toHaveBeenCalledWith(43200, "secret", 0, { u: "alice", sv: ALICE.sv });
    expect(res.headers.get("set-cookie")).toContain("clawbox_session=session.cookie");
  });

  it("with no username is the owner's login, exactly as before multi-user", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const res = await POST(login({ password: "owner-password" }));

    expect(res.status).toBe(200);
    expect(verifyPassword).toHaveBeenCalledWith("owner-password");
    expect(verifyUserPassword).not.toHaveBeenCalled();
    expect(createSessionCookie).toHaveBeenCalledWith(43200, "secret", 0, { u: "clawbox" });
  });

  it("the owner's own name is the owner's login too", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const res = await POST(login({ username: "clawbox", password: "owner-password" }));
    expect(res.status).toBe(200);
    expect(verifyPassword).toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
  });

  it("refuses a wrong password for a second user without trying the owner's", async () => {
    const res = await POST(login({ username: "alice", password: "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "bad_credentials", error: "Incorrect username or password" });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(createSessionCookie).not.toHaveBeenCalled();
  });

  it("answers an unknown user exactly like a wrong password, and never runs a check for it", async () => {
    const unknown = await POST(login({ username: "mallory", password: "whatever1" }));
    const wrong = await POST(login({ username: "alice", password: "whatever1" }));

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(verifyUserPassword).toHaveBeenCalledTimes(1); // alice's, not mallory's
    expect(verifyUserPassword).toHaveBeenCalledWith("alice", "whatever1");
  });

  it("never signs in a system account that is not a ClawBox user", async () => {
    vi.mocked(verifyUserPassword).mockResolvedValue(true);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    for (const name of ["root", "ubuntu", "daemon"]) {
      const res = await POST(login({ username: name, password: "anything1" }));
      expect(res.status, name).toBe(401);
    }
    expect(createSessionCookie).not.toHaveBeenCalled();
  });

  it("charges a per-user bucket, capped like the shared one, for an account that exists", async () => {
    await POST(login({ username: "alice", password: "wrong" }));
    const keys = vi.mocked(recordFailure).mock.calls.map(([key, opts]) => [key, opts?.maxLockMs]);
    expect(keys).toContainEqual(["user:alice", 300000]);
    expect(keys).toContainEqual(["global", 300000]);
  });

  it("creates no bucket for a made-up name, so spraying names cannot fill the table", async () => {
    await POST(login({ username: "mallory", password: "wrong" }));
    const keys = vi.mocked(recordFailure).mock.calls.map(([key]) => key);
    expect(keys).toEqual(["global"]);
  });

  it("honours a lockout on the chosen user's bucket before checking any password", async () => {
    vi.mocked(checkLockout).mockImplementation(async (key: string) =>
      key === "user:alice" ? { locked: true, retryAfterSeconds: 120 } : { locked: false, retryAfterSeconds: 0 },
    );
    vi.mocked(verifyUserPassword).mockResolvedValue(true);

    const res = await POST(login({ username: "alice", password: "alices-password" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(await res.json()).toMatchObject({ code: "locked" });
    expect(verifyUserPassword).not.toHaveBeenCalled();
  });

  it("clears the user's bucket along with the others on success", async () => {
    vi.mocked(verifyUserPassword).mockResolvedValue(true);
    await POST(login({ username: "alice", password: "alices-password" }));
    const cleared = vi.mocked(recordSuccess).mock.calls.map(([key]) => key);
    expect(cleared).toEqual(expect.arrayContaining(["global", "user:alice"]));
  });

  it("a second user's lockout does not lock the owner", async () => {
    vi.mocked(checkLockout).mockImplementation(async (key: string) =>
      key === "user:alice" ? { locked: true, retryAfterSeconds: 120 } : { locked: false, retryAfterSeconds: 0 },
    );
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const res = await POST(login({ password: "owner-password" }));
    expect(res.status).toBe(200);
  });
});
