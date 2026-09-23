import { EventEmitter } from "node:events";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cloud usage is counted from the bucket, never taken from the portal's counter.
 *
 * TASK-1025, from a customer box: the panel said "9.8 GB used, 2 snapshots"
 * while the portal's own page for the same account said 0 B of 5 GB and no
 * backups. The number the panel shows comes from `last_cloud_bytes` in
 * state.json, and the only thing that seeds that field outside a backup run is
 * `syncStateFromCloud()` — which preferred the daemon's `cloudBytes` field over
 * the snapshot list it was handed in the same response. That field used to be
 * the portal's `clawkeep:repo` counter passed straight through, and a counter
 * is an accumulator: it keeps the size of snapshots the account no longer has.
 *
 * Worse, the same counter is what the portal checks before minting R2
 * credentials, and it answers 402 once the counter passes the quota — so a
 * counter that had drifted high refused the very listing that would have
 * corrected it. The daemon now derives `cloudBytes` from the objects it listed,
 * and this side stops depending on it having done so: the snapshots are the
 * measurement, so they are what gets written.
 */

const daemon = vi.hoisted(() => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (daemon.stdout) child.stdout.emit("data", Buffer.from(daemon.stdout));
      if (daemon.stderr) child.stderr.emit("data", Buffer.from(daemon.stderr));
      child.emit("close", daemon.exitCode);
    });
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-usage-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const TOKEN_PATH = path.join(DATA_DIR, "token");
const STATE_PATH = path.join(DATA_DIR, "state.json");

/** What the drifted counter claimed on the customer's box: 9.8 GB. */
const STALE_COUNTER = 9_800_000_000;

let syncStateFromCloud: typeof import("@/lib/clawkeep").syncStateFromCloud;

async function readState(): Promise<Record<string, number | string>> {
  return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
}

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  process.env.CLAWKEEP_BIN = "/bin/true";
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  ({ syncStateFromCloud } = await import("@/lib/clawkeep"));
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  delete process.env.CLAWKEEP_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  daemon.exitCode = 0;
  daemon.stdout = "";
  daemon.stderr = "";
  await fs.writeFile(TOKEN_PATH, "claw_testtoken", { mode: 0o600 });
  await fs.rm(STATE_PATH, { force: true });
});

describe("syncStateFromCloud records what the bucket holds", () => {
  it("sums the snapshots instead of trusting a stale cloudBytes", async () => {
    daemon.stdout = JSON.stringify({
      ok: true,
      quotaBytes: 5_368_709_120,
      cloudBytes: STALE_COUNTER,
      snapshots: [
        { name: "b.tar.gz.enc", size_bytes: 200, last_modified_ms: 2_000 },
        { name: "a.tar.gz.enc", size_bytes: 100, last_modified_ms: 1_000 },
      ],
    });

    await syncStateFromCloud();

    const state = await readState();
    expect(state.last_cloud_bytes).toBe(300);
    expect(state.last_snapshot_count).toBe(2);
    // Newest snapshot doubles as "last backup" for a freshly paired box.
    expect(state.last_backup_at_ms).toBe(2_000);
  });

  it("reports an emptied account as empty, however high the counter is", async () => {
    daemon.stdout = JSON.stringify({
      ok: true,
      quotaBytes: 5_368_709_120,
      cloudBytes: STALE_COUNTER,
      snapshots: [],
    });

    await syncStateFromCloud();

    const state = await readState();
    expect(state.last_cloud_bytes).toBe(0);
    expect(state.last_snapshot_count).toBe(0);
  });

  it("leaves state.json alone when the listing fails", async () => {
    // Best-effort by contract: a refused or offline listing must not be
    // recorded as "your account is empty".
    daemon.exitCode = 1;
    daemon.stdout = JSON.stringify({ ok: false, error: "quota full", kind: "quota_full" });

    await syncStateFromCloud();

    await expect(fs.access(STATE_PATH)).rejects.toThrow();
  });
});
