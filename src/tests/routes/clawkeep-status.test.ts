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

  it("carries the symbolic links the last archive skipped (TASK-1304)", async () => {
    // Written by the daemon beside the fields above: the archiver refuses a
    // link out of the backup, so ClawKeep leaves it out and the run finishes.
    const statePath = path.join(DATA_DIR, "state.json");
    await fs.writeFile(statePath, JSON.stringify({
      last_heartbeat_status: "ok",
      last_skipped_links: [
        { path: "~/.openclaw/workspace/docs/catalogue", target: "/home/clawbox/Shared/Exports/catalogue" },
        { path: "~/.openclaw/workspace/docs/gone.pdf" },
        { path: 7, target: "/x" },
        "not an entry",
        ...Array.from({ length: 25 }, (_, i) => ({ path: `~/l${i}`, target: `../../out${i}` })),
      ],
      last_skipped_link_count: 31,
    }));
    let body = await (await GET()).json();
    expect(body.lastHeartbeatStatus).toBe("ok");
    expect(body.skippedLinkCount).toBe(31);
    // What does not read as {path, target} is dropped; at most twenty are named.
    expect(body.skippedLinks).toHaveLength(20);
    expect(body.skippedLinks[0]).toEqual({
      path: "~/.openclaw/workspace/docs/catalogue", target: "/home/clawbox/Shared/Exports/catalogue",
    });
    expect(body.skippedLinks[1]).toEqual({ path: "~/l0", target: "../../out0" });

    // A state.json from before this existed, or a garbled one, says nothing.
    await fs.writeFile(statePath, JSON.stringify({
      last_skipped_links: { path: "~/a", target: "/b" }, last_skipped_link_count: "lots",
    }));
    body = await (await GET()).json();
    expect(body).toMatchObject({ skippedLinks: [], skippedLinkCount: 0 });
  });

  it("returns 500 with a structured error when getStatus throws", async () => {
    const spy = vi.spyOn(clawkeep, "getStatus").mockRejectedValueOnce(new Error("disk full"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/disk full/);
    spy.mockRestore();
  });

  it("a data path that cannot be a directory is refused with the same error it always was", async () => {
    // The shelf's shield asks every 5 s, so the read no longer makes the data
    // directory each time — but a path that cannot BE one (a file where it
    // should be) must still be the mkdir's refusal, not some read's.
    await GET();
    await fs.rm(DATA_DIR, { recursive: true, force: true });
    await fs.writeFile(DATA_DIR, "not a directory");
    try {
      const res = await GET();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe(`EEXIST: file already exists, mkdir '${DATA_DIR}'`);
    } finally {
      await fs.rm(DATA_DIR, { force: true });
      await fs.mkdir(DATA_DIR, { recursive: true });
    }
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

/**
 * The data directory, made once per process rather than on every read.
 *
 * Each case takes a FRESH copy of the module (the "once" is module state), and
 * the answer it is held to is the one a copy that has never read anything
 * gives — which makes the directory first, as every read used to.
 */
describe("getStatus — the data directory", () => {
  async function freshClawkeep() {
    vi.resetModules();
    return import("@/lib/clawkeep");
  }

  it("is made by the first read, not by every read", async () => {
    await fs.writeFile(path.join(DATA_DIR, "config.toml"), 'server = "https://portal.example"\n');
    const lib = await freshClawkeep();
    const mkdir = vi.spyOn(fs, "mkdir");
    for (let i = 0; i < 4; i++) await lib.getStatus();
    expect(mkdir.mock.calls.filter(([p]) => p === DATA_DIR)).toHaveLength(1);
  });

  it("a directory removed under a running server is answered exactly as before, and is back after the read", async () => {
    const lib = await freshClawkeep();
    await lib.getStatus();
    await fs.writeFile(path.join(DATA_DIR, "token"), "claw_test_token");
    await fs.writeFile(path.join(DATA_DIR, "state.json"), JSON.stringify({ last_backup_at_ms: 1_700_000_000_000 }));
    expect((await lib.getStatus()).paired).toBe(true);

    await fs.rm(DATA_DIR, { recursive: true, force: true });
    const after = await lib.getStatus();

    await fs.rm(DATA_DIR, { recursive: true, force: true });
    const never = await (await freshClawkeep()).getStatus();

    expect(after).toEqual(never);
    expect(after).toMatchObject({ paired: false, lastBackupAtMs: 0, schedule: clawkeep.DEFAULT_SCHEDULE });
    // The read seeded config.toml, which makes the directory again.
    expect((await fs.stat(DATA_DIR)).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(DATA_DIR, "config.toml"), "utf8")).resolves.toContain("server =");
  });

  it("a data path that became a file is refused with the error a first read gives", async () => {
    const lib = await freshClawkeep();
    await lib.getStatus();
    await fs.rm(DATA_DIR, { recursive: true, force: true });
    await fs.writeFile(DATA_DIR, "not a directory");
    try {
      const after = await lib.getStatus().then(() => null, (e: NodeJS.ErrnoException) => e);
      const never = await (await freshClawkeep()).getStatus().then(() => null, (e: NodeJS.ErrnoException) => e);
      expect(never?.code).toBe("EEXIST");
      expect(after?.code).toBe(never?.code);
      expect(after?.message).toBe(never?.message);
      // And it is not trusted afterwards: once the path is a directory again,
      // the next read answers normally.
      await fs.rm(DATA_DIR, { force: true });
      await fs.mkdir(DATA_DIR, { recursive: true });
      await expect(lib.getStatus()).resolves.toMatchObject({ paired: false });
    } finally {
      await fs.rm(DATA_DIR, { recursive: true, force: true });
      await fs.mkdir(DATA_DIR, { recursive: true });
    }
  });
});
