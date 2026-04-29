import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-status-route-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

let GET: typeof import("@/app/setup-api/clawkeep/route").GET;
let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  await fs.mkdir(DATA_DIR, { recursive: true });
  const route = await import("@/app/setup-api/clawkeep/route");
  GET = route.GET;
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const entry of await fs.readdir(DATA_DIR).catch(() => [] as string[])) {
    await fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true });
  }
});

describe("GET /setup-api/clawkeep", () => {
  it("returns the unified status snapshot with no-store caching", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      paired: false,
      configured: false,
      restoring: false,
      lastBackupAtMs: 0,
      lastHeartbeatStatus: "",
      schedule: clawkeep.DEFAULT_SCHEDULE,
    });
    expect(typeof body.server).toBe("string");
    expect(body.server.length).toBeGreaterThan(0);
  });

  it("returns 500 with a structured error when getStatus throws", async () => {
    const spy = vi.spyOn(clawkeep, "getStatus").mockRejectedValueOnce(new Error("disk full"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/disk full/);
    spy.mockRestore();
  });

  it("propagates a ClawKeepError's status code", async () => {
    const err = new clawkeep.ClawKeepError("auth required", 401);
    const spy = vi.spyOn(clawkeep, "getStatus").mockRejectedValueOnce(err);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("auth required");
    spy.mockRestore();
  });
});
