import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-persistence-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const CONFIG_PATH = path.join(DATA_DIR, "config.toml");

let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = CONFIG_PATH;
  await fs.mkdir(DATA_DIR, { recursive: true });
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe everything except the dir itself between tests so each starts
  // from a fresh "first-run" state.
  for (const entry of await fs.readdir(DATA_DIR).catch(() => [] as string[])) {
    await fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true });
  }
});

describe("readSchedule / writeSchedule", () => {
  it("returns DEFAULT_SCHEDULE when no file exists", async () => {
    const s = await clawkeep.readSchedule();
    expect(s).toEqual(clawkeep.DEFAULT_SCHEDULE);
  });

  it("returns DEFAULT_SCHEDULE when the file is corrupt", async () => {
    await fs.writeFile(path.join(DATA_DIR, "schedule.json"), "{not-json", { mode: 0o600 });
    const s = await clawkeep.readSchedule();
    expect(s).toEqual(clawkeep.DEFAULT_SCHEDULE);
  });

  it("round-trips a valid schedule", async () => {
    const written = await clawkeep.writeSchedule({
      enabled: true,
      frequency: "weekly",
      timeOfDay: "09:30",
      weekday: 3,
    });
    expect(written).toEqual({ enabled: true, frequency: "weekly", timeOfDay: "09:30", weekday: 3 });
    const reread = await clawkeep.readSchedule();
    expect(reread).toEqual(written);
  });

  it("sanitises a bogus frequency to 'daily'", async () => {
    const out = await clawkeep.writeSchedule({
      enabled: true,
      // @ts-expect-error -- testing runtime coercion
      frequency: "hourly",
      timeOfDay: "02:00",
      weekday: 0,
    });
    expect(out.frequency).toBe("daily");
  });

  it("sanitises a malformed timeOfDay to the default", async () => {
    const out = await clawkeep.writeSchedule({
      enabled: true,
      frequency: "daily",
      timeOfDay: "midnight",
      weekday: 0,
    });
    expect(out.timeOfDay).toBe(clawkeep.DEFAULT_SCHEDULE.timeOfDay);
  });

  it("clamps an out-of-range weekday back to the default", async () => {
    const out = await clawkeep.writeSchedule({
      enabled: true,
      frequency: "weekly",
      timeOfDay: "02:00",
      weekday: 12,
    });
    expect(out.weekday).toBe(clawkeep.DEFAULT_SCHEDULE.weekday);
  });

  it("treats truthy-but-non-true `enabled` as disabled (strict)", async () => {
    const out = await clawkeep.writeSchedule({
      // @ts-expect-error -- runtime coercion check
      enabled: "yes",
      frequency: "daily",
      timeOfDay: "02:00",
      weekday: 0,
    });
    expect(out.enabled).toBe(false);
  });

  it("schedule.json is written 0600", async () => {
    await clawkeep.writeSchedule({ enabled: true, frequency: "daily", timeOfDay: "02:00", weekday: 0 });
    const stat = await fs.stat(path.join(DATA_DIR, "schedule.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("computeNextRunMs", () => {
  it("returns 0 for a schedule whose enabled flag is false", () => {
    const s = { ...clawkeep.DEFAULT_SCHEDULE, enabled: false };
    expect(clawkeep.computeNextRunMs(s, new Date("2026-04-29T12:00:00"))).toBe(0);
  });

  it("returns 0 when timeOfDay is bogus", () => {
    const s: typeof clawkeep.DEFAULT_SCHEDULE = {
      enabled: true,
      frequency: "daily",
      timeOfDay: "ninety:nine",
      weekday: 0,
    };
    expect(clawkeep.computeNextRunMs(s, new Date("2026-04-29T12:00:00"))).toBe(0);
  });

  it("daily picks today's slot when the time is still ahead", () => {
    const s = { enabled: true, frequency: "daily" as const, timeOfDay: "23:30", weekday: 0 };
    const now = new Date("2026-04-29T12:00:00");
    const next = new Date(clawkeep.computeNextRunMs(s, now));
    expect(next.getDate()).toBe(29);
    expect(next.getHours()).toBe(23);
  });

  it("daily rolls forward when the time has passed", () => {
    const s = { enabled: true, frequency: "daily" as const, timeOfDay: "01:00", weekday: 0 };
    const now = new Date("2026-04-29T12:00:00");
    const next = new Date(clawkeep.computeNextRunMs(s, now));
    expect(next.getDate()).toBe(30);
    expect(next.getHours()).toBe(1);
  });

  it("weekly lands on the configured weekday in the future", () => {
    const s = { enabled: true, frequency: "weekly" as const, timeOfDay: "02:00", weekday: 0 }; // Sunday
    const now = new Date("2026-04-29T12:00:00"); // Wednesday
    const next = new Date(clawkeep.computeNextRunMs(s, now));
    expect(next.getDay()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("readToken / writeToken / deleteToken", () => {
  it("readToken returns null when no token file exists", async () => {
    const t = await clawkeep.readToken();
    expect(t).toBeNull();
  });

  it("readToken returns null when the file content doesn't start with claw_", async () => {
    await fs.writeFile(path.join(DATA_DIR, "token"), "bogus_token_value", { mode: 0o600 });
    const t = await clawkeep.readToken();
    expect(t).toBeNull();
  });

  it("writeToken rejects a non-claw_* prefix as a 400 ClawKeepError", async () => {
    await expect(clawkeep.writeToken("nope_abc")).rejects.toMatchObject({
      name: "ClawKeepError",
      status: 400,
    });
  });

  it("write → read returns the same token", async () => {
    await clawkeep.writeToken("claw_abcdef");
    const t = await clawkeep.readToken();
    expect(t).toBe("claw_abcdef");
  });

  it("token file is mode 0600", async () => {
    await clawkeep.writeToken("claw_abcdef");
    const stat = await fs.stat(path.join(DATA_DIR, "token"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("deleteToken is idempotent (no error when token missing)", async () => {
    await expect(clawkeep.deleteToken()).resolves.toBeUndefined();
    await clawkeep.writeToken("claw_xyz");
    await clawkeep.deleteToken();
    await expect(clawkeep.deleteToken()).resolves.toBeUndefined();
    expect(await clawkeep.readToken()).toBeNull();
  });
});

describe("readConfigToml", () => {
  it("seeds a default config.toml on first read", async () => {
    expect(await fs.access(CONFIG_PATH).then(() => true, () => false)).toBe(false);
    const toml = await clawkeep.readConfigToml();
    expect(toml).toMatch(/^server = "/m);
    expect(toml).toMatch(/\[openclaw]/);
    // Subsequent reads return the same content without re-seeding.
    const again = await clawkeep.readConfigToml();
    expect(again).toBe(toml);
  });

  it("preserves an existing config.toml verbatim", async () => {
    const userTml = `server = "https://example.test"\nschedule = "weekly"\n[openclaw]\nbinary = "openclaw"\n`;
    await fs.writeFile(CONFIG_PATH, userTml, { mode: 0o644 });
    const toml = await clawkeep.readConfigToml();
    expect(toml).toBe(userTml);
  });
});

describe("getStatus", () => {
  it("reports paired=false / configured=false / restoring=false on a fresh device", async () => {
    const status = await clawkeep.getStatus();
    expect(status.paired).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.restoring).toBe(false);
    expect(status.lastBackupAtMs).toBe(0);
    expect(status.snapshotCount).toBe(0);
  });

  it("flips paired=true once a token is written", async () => {
    await clawkeep.writeToken("claw_test");
    const status = await clawkeep.getStatus();
    expect(status.paired).toBe(true);
    expect(status.configured).toBe(true); // server is non-empty in the seeded config
  });

  it("surfaces the persisted schedule and a non-zero nextRunAtMs when enabled", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const hh = String(future.getHours()).padStart(2, "0");
    const mm = String(future.getMinutes()).padStart(2, "0");
    await clawkeep.writeSchedule({
      enabled: true,
      frequency: "daily",
      timeOfDay: `${hh}:${mm}`,
      weekday: 0,
    });
    const status = await clawkeep.getStatus();
    expect(status.schedule.enabled).toBe(true);
    expect(status.schedule.timeOfDay).toBe(`${hh}:${mm}`);
    expect(status.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it("returns the parsed `server` from a custom config.toml", async () => {
    await fs.writeFile(
      CONFIG_PATH,
      `server = "https://custom.example.com"\n[openclaw]\nbinary = "openclaw"\n`,
      { mode: 0o644 },
    );
    const status = await clawkeep.getStatus();
    expect(status.server).toBe("https://custom.example.com");
  });
});

describe("restoring flag (via getStatus.restoring)", () => {
  it("returns restoring=true while a fresh restoring.flag exists", async () => {
    await fs.writeFile(path.join(DATA_DIR, "restoring.flag"), "", { mode: 0o600 });
    const status = await clawkeep.getStatus();
    expect(status.restoring).toBe(true);
  });

  it("auto-clears a stale flag (older than the 30 m window)", async () => {
    const flag = path.join(DATA_DIR, "restoring.flag");
    await fs.writeFile(flag, "", { mode: 0o600 });
    // Backdate mtime by 31 minutes.
    const past = new Date(Date.now() - 31 * 60 * 1000);
    await fs.utimes(flag, past, past);
    const status = await clawkeep.getStatus();
    expect(status.restoring).toBe(false);
    // The auto-clear path should have removed the flag from disk.
    await expect(fs.access(flag)).rejects.toBeTruthy();
  });
});
