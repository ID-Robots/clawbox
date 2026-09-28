import { EventEmitter } from "node:events";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-1211: a schedule switched off while the ClawKeep account was full
 * (`quotaHoldSinceMs`) comes back on by itself — and only on evidence that the
 * account issues credentials again. Against a real data directory; the one
 * thing faked is the `clawkeep snapshots` process.
 */

const daemon = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[] }[],
  exitCode: 0,
  stdout: "",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (bin: string, args: string[]) => {
    daemon.spawns.push({ bin, args });
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
      child.emit("close", daemon.exitCode);
    });
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-quota-hold-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const HOLD_SINCE = 1_790_000_000_000;
const PAUSED = {
  enabled: false,
  frequency: "weekly",
  timeOfDay: "01:00",
  weekday: 2,
  retentionKeepLast: 3,
  armedAtMs: 1_780_000_000_000,
  quotaHoldSinceMs: HOLD_SINCE,
};

let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  process.env.CLAWKEEP_BIN = "/bin/true";
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  delete process.env.CLAWKEEP_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  daemon.spawns.length = 0;
  daemon.exitCode = 0;
  daemon.stdout = JSON.stringify({ ok: true, snapshots: [], quotaBytes: 54_760_833_024, cloudBytes: 0 });
  for (const entry of await fs.readdir(DATA_DIR).catch(() => [] as string[])) {
    await fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true });
  }
  await fs.writeFile(path.join(DATA_DIR, "token"), "claw_testtoken", { mode: 0o600 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function writeJson(file: string, body: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(body, null, 2));
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

describe("releaseQuotaHoldIfCredentialsWork", () => {
  it("does nothing, and asks nothing, when there is no hold", async () => {
    await writeJson(SCHEDULE_FILE, { ...PAUSED, quotaHoldSinceMs: undefined });

    await expect(clawkeep.releaseQuotaHoldIfCredentialsWork()).resolves.toEqual({ outcome: "none" });
    expect(daemon.spawns).toHaveLength(0);
  });

  it("switches back on, keeping the cadence and the arm stamp, when the account lists again", async () => {
    await writeJson(SCHEDULE_FILE, PAUSED);
    await writeJson(STATE_FILE, { last_backup_at_ms: 1_700_000_000_000, quota_full_since_ms: HOLD_SINCE - 1, last_cloud_bytes: 7 });

    const check = await clawkeep.releaseQuotaHoldIfCredentialsWork();

    expect(check).toEqual({
      outcome: "released",
      schedule: { enabled: true, frequency: "weekly", timeOfDay: "01:00", weekday: 2, retentionKeepLast: 3 },
      // Coming back from a pause is not a fresh protection window.
      armedAtMs: PAUSED.armedAtMs,
    });
    expect(daemon.spawns.map((s) => s.args[0])).toEqual(["snapshots"]);
    const onDisk = await readJson(SCHEDULE_FILE);
    expect(onDisk.enabled).toBe(true);
    expect(onDisk).not.toHaveProperty("quotaHoldSinceMs");
    // The listing minted credentials, so the daemon's record is cleared — and
    // nothing else in state.json is touched.
    expect(await readJson(STATE_FILE)).toEqual({
      last_backup_at_ms: 1_700_000_000_000,
      quota_full_since_ms: 0,
      last_cloud_bytes: 7,
    });
  });

  it("takes a backup that succeeded after the pause as the evidence, without asking the account", async () => {
    await writeJson(SCHEDULE_FILE, PAUSED);
    await writeJson(STATE_FILE, { last_backup_at_ms: HOLD_SINCE + 60_000 });

    const check = await clawkeep.releaseQuotaHoldIfCredentialsWork();

    expect(check.outcome).toBe("released");
    expect(daemon.spawns).toHaveLength(0);
  });

  it("keeps the pause while the account still refuses credentials for quota", async () => {
    await writeJson(SCHEDULE_FILE, PAUSED);
    daemon.exitCode = 1;
    daemon.stdout = JSON.stringify({ ok: false, kind: "quota_full", error: "Cloud backup quota reached." });

    await expect(clawkeep.releaseQuotaHoldIfCredentialsWork()).resolves.toEqual({ outcome: "held" });
    expect(await readJson(SCHEDULE_FILE)).toEqual(PAUSED);
  });

  it("keeps the pause when the answer is unknown — offline is not 'there is room'", async () => {
    await writeJson(SCHEDULE_FILE, PAUSED);
    daemon.exitCode = 1;
    daemon.stdout = JSON.stringify({ ok: false, kind: "network", error: "offline" });

    await expect(clawkeep.releaseQuotaHoldIfCredentialsWork()).resolves.toEqual({ outcome: "held" });
    expect((await readJson(SCHEDULE_FILE)).enabled).toBe(false);
  });

  it("is published on the status the card and the MCP read", async () => {
    await writeJson(SCHEDULE_FILE, PAUSED);

    const status = await clawkeep.getStatus();

    expect(status.schedule.enabled).toBe(false);
    expect(status.nextRunAtMs).toBe(0);
    expect(status.scheduleQuotaHoldSinceMs).toBe(HOLD_SINCE);
  });

  it("ignores a hold beside `enabled: true` — that schedule is simply armed", async () => {
    await writeJson(SCHEDULE_FILE, { ...PAUSED, enabled: true });

    expect((await clawkeep.readScheduleSnapshot()).quotaHoldSinceMs).toBe(0);
  });
});

describe("resetRunningState keeps the daemon's quota record", () => {
  it("clears the in-flight fields and nothing the schedule save reads", async () => {
    await writeJson(STATE_FILE, { last_step: "uploading", quota_full_since_ms: HOLD_SINCE });

    await clawkeep.resetRunningState();

    const state = await readJson(STATE_FILE);
    expect(state.last_step).toBe("");
    expect(state.quota_full_since_ms).toBe(HOLD_SINCE);
  });
});
