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

  it("carries what the last archive left out and the snapshot-sized archives it carried", async () => {
    // Written by the daemon (clawkeep/state.py) once the archive is built and
    // before the upload, read by the dashboard and by `backup_status`.
    const statePath = path.join(DATA_DIR, "state.json");
    await fs.writeFile(statePath, JSON.stringify({
      last_left_out_count: 8,
      last_left_out_bytes: 20_400_000_000,
      last_large_archives: [
        { path: "~/.openclaw/workspace/dump.tar.gz", bytes: 1_900_000_000 },
        { path: 7 },
        "not an entry",
        ...Array.from({ length: 6 }, (_, i) => ({ path: `~/x${i}.zip`, bytes: 300_000_000 })),
      ],
      last_large_archive_count: 9,
      last_large_archive_bytes: 3_700_000_000,
    }));
    let body = await (await GET()).json();
    expect(body).toMatchObject({
      leftOutCount: 8,
      leftOutBytes: 20_400_000_000,
      largeArchiveCount: 9,
      largeArchiveBytes: 3_700_000_000,
    });
    // What does not read as {path, bytes} is dropped; at most five are named.
    expect(body.largeArchives).toHaveLength(5);
    expect(body.largeArchives[0]).toEqual({ path: "~/.openclaw/workspace/dump.tar.gz", bytes: 1_900_000_000 });

    // A state.json from before this existed, or a garbled one, says nothing.
    await fs.writeFile(statePath, JSON.stringify({
      last_left_out_count: "lots", last_left_out_bytes: -5, last_large_archives: { path: "~/a.zip" },
    }));
    body = await (await GET()).json();
    expect(body).toMatchObject({
      leftOutCount: 0, leftOutBytes: 0, largeArchives: [], largeArchiveCount: 0, largeArchiveBytes: 0,
    });
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
