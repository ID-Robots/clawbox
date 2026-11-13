import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawai-connect-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "clawai-connect-state.json");

let connect: typeof import("@/lib/clawai-connect");

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  connect = await import("@/lib/clawai-connect");
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(STATE_PATH, { force: true });
});

describe("clawai-connect — user codes + device ids", () => {
  it("createClawAiUserCode returns a 4-4 grouped Crockford-base32 code", () => {
    const code = connect.createClawAiUserCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // Source alphabet excludes I, O, 0, 1 (but keeps L — see clawai-connect.ts).
    expect(code).not.toMatch(/[IO01]/);
  });

  it("createClawAiUserCode is sufficiently random across many calls", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i += 1) codes.add(connect.createClawAiUserCode());
    // 8-char alphabet32 has > 1e12 codes; collisions in 1k draws should be 0.
    expect(codes.size).toBe(1000);
  });

  it("createClawAiDeviceId returns a base64url string", () => {
    const id = connect.createClawAiDeviceId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeGreaterThan(20);
  });
});

describe("clawai-connect — session persistence", () => {
  const sample: import("@/lib/clawai-connect").ClawAiConnectSession = {
    device_id: "abc",
    user_code: "AAAA-BBBB",
    interval: 5,
    createdAt: Date.now(),
    status: "pending",
    provider: "clawai",
    scope: "primary",
    tier: "flash",
  };

  it("readClawAiSession returns null when no state file", async () => {
    expect(await connect.readClawAiSession()).toBeNull();
  });

  it("writeClawAiSession persists and readClawAiSession round-trips", async () => {
    await connect.writeClawAiSession(sample);
    const read = await connect.readClawAiSession();
    expect(read).toEqual(sample);
  });

  it("writeClawAiSession is atomic (no .tmp leftovers in DATA_DIR)", async () => {
    await connect.writeClawAiSession(sample);
    const files = await fs.readdir(DATA_DIR);
    expect(files.filter((f) => f.includes(".tmp.")).length).toBe(0);
  });

  it("clearClawAiSession removes the state file", async () => {
    await connect.writeClawAiSession(sample);
    await connect.clearClawAiSession();
    expect(await connect.readClawAiSession()).toBeNull();
  });

  it("clearClawAiSession is a no-op when no file exists", async () => {
    await expect(connect.clearClawAiSession()).resolves.not.toThrow();
  });

  it("readClawAiSession returns null on malformed JSON", async () => {
    await fs.writeFile(STATE_PATH, "not json");
    expect(await connect.readClawAiSession()).toBeNull();
  });
});

describe("clawai-connect — session TTL", () => {
  it("isClawAiSessionExpired returns false for a fresh session", () => {
    expect(
      connect.isClawAiSessionExpired({
        device_id: "x",
        user_code: "AAAA-BBBB",
        interval: 5,
        createdAt: Date.now(),
        status: "pending",
        provider: "clawai",
        scope: "primary",
      }),
    ).toBe(false);
  });

  it("isClawAiSessionExpired returns true after 15 minutes", () => {
    expect(
      connect.isClawAiSessionExpired({
        device_id: "x",
        user_code: "AAAA-BBBB",
        interval: 5,
        createdAt: Date.now() - 16 * 60 * 1000,
        status: "pending",
        provider: "clawai",
        scope: "primary",
      }),
    ).toBe(true);
  });
});

describe("clawai-connect — a conditional write (TASK-2501)", () => {
  const base: import("@/lib/clawai-connect").ClawAiConnectSession = {
    device_id: "mine",
    user_code: "AAAA-BBBB",
    interval: 5,
    createdAt: 1_000,
    status: "configuring",
    provider: "clawai",
    scope: "entitlement",
    tier: "free",
  };

  it("writes while the stored session is still the owner's, and not over a newer one", async () => {
    await connect.writeClawAiSession(base);
    expect(await connect.writeClawAiSessionIfCurrent(base, { ...base, status: "complete" })).toBe(true);
    expect((await connect.readClawAiSession())?.status).toBe("complete");
    const newer = { ...base, device_id: "newer", createdAt: 2_000, status: "pending" as const, scope: "primary" as const };
    await connect.writeClawAiSession(newer);
    expect(await connect.writeClawAiSessionIfCurrent(base, { ...base, status: "error", error: "x" })).toBe(false);
    expect(await connect.readClawAiSession()).toEqual(newer);
    // The same code started again is a different session too.
    await connect.writeClawAiSession({ ...base, createdAt: 3_000 });
    expect(await connect.writeClawAiSessionIfCurrent(base, { ...base, status: "complete" })).toBe(false);
  });

  it("never recreates a session cleared while a conditional write was queued", async () => {
    await connect.writeClawAiSession(base);
    const cleared = connect.clearClawAiSession();
    const conditional = connect.writeClawAiSessionIfCurrent(base, { ...base, status: "complete" });
    await cleared;
    expect(await conditional).toBe(false);
    expect(await connect.readClawAiSession()).toBeNull();
  });

  it("writes nothing when there is no session", async () => {
    expect(await connect.writeClawAiSessionIfCurrent(base, base)).toBe(false);
    expect(await connect.readClawAiSession()).toBeNull();
  });

  it("orders a plain write queued behind it after it", async () => {
    await connect.writeClawAiSession(base);
    const newer = { ...base, device_id: "newer", createdAt: 2_000 };
    const conditional = connect.writeClawAiSessionIfCurrent(base, { ...base, status: "complete" });
    const plain = connect.writeClawAiSession(newer);
    expect(await conditional).toBe(true);
    await plain;
    expect(await connect.readClawAiSession()).toEqual(newer);
  });
});
