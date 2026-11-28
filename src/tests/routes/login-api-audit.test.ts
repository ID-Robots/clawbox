import { describe, expect, it, vi, beforeEach } from "vitest";

// TASK-2446: every sign-in, failed sign-in and sign-out is a line in the
// audit log (src/lib/audit-log.ts). A failed sign-in names the account only
// when it is one on this box — a name nobody has may be a password typed into
// the wrong field — and a request turned away at the lockout gate, which never
// tried a password, writes nothing (anyone could fill the log by asking).

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
  checkUserPassword: vi.fn(),
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

const audit = vi.hoisted(() => ({
  record: vi.fn(async () => {}),
  actor: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/lib/audit-log", () => ({ recordAudit: audit.record, auditActorOf: audit.actor }));

import * as config from "@/lib/config-store";
import { createSessionCookie, getSessionGeneration, getSessionSigningSecret, getSystemUsername, verifyPassword } from "@/lib/auth";
import { checkUserPassword, findUser } from "@/lib/clawbox-users";
import { checkLockout, recordFailure, recordSuccess } from "@/lib/login-rate-limit";

const ALICE = { username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: "a1b2c3d4e5f60718" };

function login(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/login-api", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ duration: 43200, ...body }),
  });
}

describe("/login-api — the audit log", () => {
  let POST: (req: Request) => Promise<Response>;
  let LOGOUT: (req?: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(config.get).mockResolvedValue(true as never);
    vi.mocked(createSessionCookie).mockReturnValue("session.cookie");
    vi.mocked(getSystemUsername).mockReturnValue("clawbox");
    vi.mocked(getSessionSigningSecret).mockResolvedValue("secret");
    vi.mocked(getSessionGeneration).mockResolvedValue(0);
    vi.mocked(verifyPassword).mockResolvedValue(false);
    vi.mocked(checkUserPassword).mockResolvedValue("wrong");
    vi.mocked(findUser).mockImplementation(async (name: string) => (name === "alice" ? ALICE : null));
    vi.mocked(checkLockout).mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
    vi.mocked(recordFailure).mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
    vi.mocked(recordSuccess).mockResolvedValue(undefined);
    audit.actor.mockResolvedValue(null);
    POST = (await import("@/app/login-api/route")).POST;
    LOGOUT = (await import("@/app/login-api/logout/route")).POST;
  });

  it("records the owner's sign-in, with how long the session lasts", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const req = login({ password: "owners-password" });
    expect((await POST(req)).status).toBe(200);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({ event: "login", actor: "clawbox", detail: { remote: false, hours: 12 } }, req);
  });

  it("records a user's sign-in as theirs", async () => {
    vi.mocked(checkUserPassword).mockResolvedValue("ok");
    expect((await POST(login({ username: "alice", password: "alices-password" }))).status).toBe(200);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ event: "login", actor: "alice" }), expect.any(Request));
  });

  it("records a wrong password against the account it was tried on", async () => {
    expect((await POST(login({ username: "alice", password: "guess" }))).status).toBe(401);
    expect(audit.record).toHaveBeenCalledWith({ event: "login_failed", actor: "alice", detail: { locked: false, remote: false } }, expect.any(Request));
  });

  it("never writes down a name that is not an account on this box", async () => {
    expect((await POST(login({ username: "my-secret-password", password: "guess" }))).status).toBe(401);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(entry).toMatchObject({ event: "login_failed", actor: null });
    expect(JSON.stringify(entry)).not.toContain("my-secret-password");
  });

  it("says when the failure locked the account out, and that it came over remote access", async () => {
    vi.mocked(recordFailure).mockResolvedValue({ locked: true, retryAfterSeconds: 60 });
    const res = await POST(login({ password: "guess" }, { "cf-connecting-ip": "198.51.100.7" }));
    expect(res.status).toBe(429);
    expect(audit.record).toHaveBeenCalledWith({ event: "login_failed", actor: "clawbox", detail: { locked: true, remote: true } }, expect.any(Request));
  });

  it("writes nothing for a request turned away at the lockout gate", async () => {
    vi.mocked(checkLockout).mockResolvedValue({ locked: true, retryAfterSeconds: 60 });
    expect((await POST(login({ password: "guess" }))).status).toBe(429);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("records a sign-out of a session the box honours, and nothing for one it does not", async () => {
    audit.actor.mockResolvedValue("alice");
    const req = new Request("http://localhost/login-api/logout", { method: "POST" });
    expect((await LOGOUT(req)).status).toBe(200);
    expect(audit.record).toHaveBeenCalledWith({ event: "logout", actor: "alice" }, req);
    audit.record.mockClear();
    audit.actor.mockResolvedValue(null);
    expect((await LOGOUT(new Request("http://localhost/login-api/logout", { method: "POST" }))).status).toBe(200);
    expect((await LOGOUT()).status).toBe(200);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
