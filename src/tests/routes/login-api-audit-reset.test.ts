import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// TASK-2446: a factory reset clears the audit log and seals it for the life
// of the process (src/lib/audit-log.ts). A sign-in that resolved the previous
// owner BEFORE the wipe and only records itself after it — its password check
// still running, say — must not put the previous owner's name and address back
// in the log, however long the reset takes. The real audit log is used here;
// only what decides the sign-in is stubbed.

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-login-reset-${process.pid}-${Date.now()}`);

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async () => true),
  set: vi.fn(),
  DATA_DIR: path.join(fs.realpathSync(os.tmpdir()), `clawbox-login-reset-${process.pid}-data`),
}));

const gate = vi.hoisted(() => ({ release: null as null | ((ok: boolean) => void), reached: null as null | (() => void) }));

vi.mock("@/lib/auth", () => ({
  // The owner's password check: held until the test lets it answer.
  verifyPassword: vi.fn(() => new Promise<boolean>((resolve) => {
    gate.release = resolve;
    gate.reached?.();
  })),
  // Implementations, not mockReturnValue: the suite resets mocks between cases.
  createSessionCookie: vi.fn(() => "session.cookie"),
  getSessionSigningSecret: vi.fn(async () => "secret"),
  getSessionGeneration: vi.fn(async () => 0),
  getSystemUsername: vi.fn(() => "clawbox"),
}));
vi.mock("@/lib/clawbox-users", () => ({ findUser: vi.fn(async () => null), checkUserPassword: vi.fn() }));
vi.mock("@/lib/system-password", () => ({ hasOwnerPassword: vi.fn(async () => true) }));
vi.mock("@/lib/login-rate-limit", () => ({
  checkLockout: vi.fn(async () => ({ locked: false, retryAfterSeconds: 0 })),
  recordFailure: vi.fn(async () => ({ locked: false, retryAfterSeconds: 0 })),
  recordSuccess: vi.fn(async () => {}),
  padResponseTime: vi.fn(async () => undefined),
  SHARED_BUCKET_MAX_LOCK_MS: 300000,
}));

import { auditLogPath, auditLogSealed, clearAuditLogForReset, recordAudit, unsealAuditLog } from "@/lib/audit-log";
import { POST } from "@/app/login-api/route";

function login(): Request {
  return new Request("http://localhost/login-api", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-clawbox-peer": "192.0.2.77" },
    body: JSON.stringify({ password: "the-previous-owners-password", duration: 43200 }),
  });
}

/** Start a sign-in and wait until it is inside its password check. (Boxed: an async function would flatten the promise it returns.) */
async function startLogin(): Promise<{ done: Promise<Response> }> {
  const reached = new Promise<void>((r) => { gate.reached = r; });
  const done = POST(login());
  await reached;
  return { done };
}

const lines = () => (fs.existsSync(auditLogPath()) ? fs.readFileSync(auditLogPath(), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  unsealAuditLog();
  fs.rmSync(path.dirname(auditLogPath()), { recursive: true, force: true });
  gate.release = null;
});

afterAll(() => {
  unsealAuditLog();
  fs.rmSync(path.dirname(auditLogPath()), { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("a sign-in that outlives a factory reset", () => {
  it("resolved before the wipe and finishing after it writes nothing to the log", async () => {
    const pending = await startLogin();
    // The reset wipes and clears the log while the sign-in waits on its password.
    await clearAuditLogForReset();
    gate.release!(true);
    expect((await pending.done).status).toBe(200);
    expect(lines()).toEqual([]);
    // The reset's own line is still written, and is the log's only line.
    await recordAudit({ event: "factory_reset", actor: "clawbox" });
    expect(lines().map((l) => l.event)).toEqual(["factory_reset"]);
  });

  it("finishing more than five minutes after the clear — a long reset — writes nothing either", async () => {
    const pending = await startLogin();
    await clearAuditLogForReset();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    try {
      gate.release!(true);
      expect((await pending.done).status).toBe(200);
      // And a failed one, later still.
      const failing = await startLogin();
      gate.release!(false);
      expect((await failing.done).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
    expect(lines()).toEqual([]);
    expect(auditLogSealed()).toBe(true);
  });

  it("records as before once a reset that stopped at its failure gate has released the seal", async () => {
    await clearAuditLogForReset();
    unsealAuditLog();
    const pending = await startLogin();
    gate.release!(true);
    expect((await pending.done).status).toBe(200);
    expect(lines()).toEqual([expect.objectContaining({ event: "login", actor: "clawbox", ip: "192.0.2.77" })]);
  });
});
