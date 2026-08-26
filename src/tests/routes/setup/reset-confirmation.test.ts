import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * The confirmation gate in front of the factory wipe: a session, the owner's
 * current OS password, and the typed word — the rest of TASK-443's ask, after
 * the session half landed in #436.
 *
 * These tests care only about which requests get PAST the gate, so everything
 * the wipe itself touches is stubbed into inertness. A test that reached
 * `resetUpdateState` would mean the gate let it through, which is exactly the
 * assertion each refusal case makes.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));

vi.mock("fs/promises", () => ({
  default: {
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => {}),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => {}),
    chown: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/updater", () => ({ resetUpdateState: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/test/data" }));

const mockVerifyPassword = vi.fn(async (password: string) => password === "correct-horse");
vi.mock("@/lib/auth", () => ({
  getSystemUsername: vi.fn(() => "clawbox"),
  verifyPassword: (password: string) => mockVerifyPassword(password),
}));

// The real throttle is covered by the login-rate-limit suite. Here it is a
// no-op so a refusal is measured by its status, not by a 300 ms pad.
vi.mock("@/lib/login-rate-limit", () => ({
  MIN_RESPONSE_MS: 0,
  SHARED_BUCKET_MAX_LOCK_MS: 300_000,
  checkLockout: vi.fn(async () => ({ locked: false, retryAfterSeconds: 0 })),
  recordFailure: vi.fn(async () => ({ locked: false, retryAfterSeconds: 0 })),
  recordSuccess: vi.fn(async () => {}),
  padResponseTime: vi.fn(async () => {}),
}));

import { resetUpdateState } from "@/lib/updater";

const mockResetUpdateState = vi.mocked(resetUpdateState);

describe("POST /setup-api/setup/reset — confirmation gate (TASK-443)", () => {
  let post: (body: unknown, opts?: { cookie?: string }) => Promise<Response>;
  let session: SessionFixture;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockVerifyPassword.mockImplementation(async (password: string) => password === "correct-horse");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }));

    session = installSessionFixture();
    const mod = await import("@/app/setup-api/setup/reset/route");
    post = (body, opts) =>
      mod.POST(
        new Request("http://localhost/setup-api/setup/reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(opts?.cookie === undefined ? { Cookie: session.cookie } : opts.cookie ? { Cookie: opts.cookie } : {}),
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    session.cleanup();
  });

  it("refuses a caller with no session before it looks at the body", async () => {
    const res = await post({ password: "correct-horse", confirm: "RESET" }, { cookie: "" });

    expect(res.status).toBe(401);
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockResetUpdateState).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const res = await post("not json at all");

    expect(res.status).toBe(400);
    expect(mockResetUpdateState).not.toHaveBeenCalled();
  });

  it("refuses a request with the right password but no typed confirmation", async () => {
    const res = await post({ password: "correct-horse" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("RESET") });
    expect(mockResetUpdateState).not.toHaveBeenCalled();
  });

  it("refuses a mistyped confirmation without spending a password attempt", async () => {
    const res = await post({ password: "correct-horse", confirm: "RESE" });

    expect(res.status).toBe(400);
    // The cheap check runs first, so a fat-fingered word never reaches the
    // password oracle and never counts against the owner's lockout.
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockResetUpdateState).not.toHaveBeenCalled();
  });

  it("refuses the wrong password even with a perfect confirmation", async () => {
    const res = await post({ password: "wrong", confirm: "RESET" });

    expect(res.status).toBe(401);
    expect(mockVerifyPassword).toHaveBeenCalledWith("wrong");
    expect(mockResetUpdateState).not.toHaveBeenCalled();
  });

  it("refuses a missing password", async () => {
    const res = await post({ confirm: "RESET" });

    expect(res.status).toBe(400);
    expect(mockResetUpdateState).not.toHaveBeenCalled();
  });

  it("accepts the password with the typed word, in any casing or padding", async () => {
    const res = await post({ password: "correct-horse", confirm: "  reset " });

    expect(res.status).toBe(200);
    expect(mockResetUpdateState).toHaveBeenCalled();
  });
});
