import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { deriveProtection } from "@/lib/clawkeep-protection";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-schedule-route-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

// The schedule route calls into the in-process scheduler's `refresh()` after
// each PUT. The scheduler reads the persisted schedule, arms a setTimeout,
// and would otherwise leak a real timer across the test suite — stub it out
// so we can assert it was called and avoid the leak.
vi.mock("@/lib/clawkeep-scheduler", () => ({
  start: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  nextRunAtMs: vi.fn(() => 0),
}));

let GET: typeof import("@/app/setup-api/clawkeep/schedule/route").GET;
let PUT: typeof import("@/app/setup-api/clawkeep/schedule/route").PUT;
let scheduler: typeof import("@/lib/clawkeep-scheduler");
let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  await fs.mkdir(DATA_DIR, { recursive: true });
  const route = await import("@/app/setup-api/clawkeep/schedule/route");
  GET = route.GET;
  PUT = route.PUT;
  scheduler = await import("@/lib/clawkeep-scheduler");
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const entry of await fs.readdir(DATA_DIR).catch(() => [] as string[])) {
    await fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true });
  }
});

function jsonReq(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost/setup-api/clawkeep/schedule"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const ARMED_DAILY = {
  enabled: true,
  frequency: "daily",
  timeOfDay: "02:00",
  weekday: 0,
  retentionKeepLast: 10,
};

/**
 * Make the persisted schedule look like one armed at `atMs`. Both provenances
 * are backdated — the file's mtime and the stamp the file carries — so the
 * fixture is a fair starting point whichever of the two the shield reads.
 */
async function backdateArm(atMs: number): Promise<void> {
  const raw = JSON.parse(await fs.readFile(SCHEDULE_FILE, "utf8"));
  await fs.writeFile(SCHEDULE_FILE, JSON.stringify({ ...raw, armedAtMs: atMs }, null, 2));
  await fs.utimes(SCHEDULE_FILE, new Date(atMs), new Date(atMs));
}

/** A `schedule.json` as beta wrote it: no `armedAtMs`, a recent mtime. */
async function writeLegacySchedule(schedule: unknown): Promise<void> {
  await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

/** The daemon's `state.json` — what the arm gate reads to ask "was this box
 *  already lapsed when the owner armed it?". */
async function writeLastBackup(atMs: number): Promise<void> {
  await fs.writeFile(
    path.join(DATA_DIR, "state.json"),
    JSON.stringify({ last_backup_at_ms: atMs, last_heartbeat_status: "ok" }, null, 2),
  );
}

describe("/setup-api/clawkeep/schedule", () => {
  describe("GET", () => {
    it("returns DEFAULT_SCHEDULE when nothing is persisted", async () => {
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schedule).toEqual(clawkeep.DEFAULT_SCHEDULE);
      expect(body.nextRunAtMs).toBe(0);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("surfaces a persisted schedule and a non-zero nextRunAtMs", async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      const hh = String(future.getHours()).padStart(2, "0");
      const mm = String(future.getMinutes()).padStart(2, "0");
      await clawkeep.writeSchedule({
        enabled: true,
        frequency: "daily",
        timeOfDay: `${hh}:${mm}`,
        weekday: 0,
        retentionKeepLast: 10,
      });
      const res = await GET();
      const body = await res.json();
      expect(body.schedule.enabled).toBe(true);
      expect(body.schedule.timeOfDay).toBe(`${hh}:${mm}`);
      expect(body.nextRunAtMs).toBeGreaterThan(Date.now());
    });
  });

  describe("PUT", () => {
    it("persists a valid schedule and re-arms the scheduler", async () => {
      const res = await PUT(jsonReq({
        enabled: true,
        frequency: "weekly",
        timeOfDay: "03:15",
        weekday: 4,
        retentionKeepLast: 7,
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schedule).toEqual({
        enabled: true,
        frequency: "weekly",
        timeOfDay: "03:15",
        weekday: 4,
        retentionKeepLast: 7,
      });
      expect(scheduler.refresh).toHaveBeenCalledTimes(1);

      // Round-trip: GET should see the same thing.
      const after = await (await GET()).json();
      expect(after.schedule).toEqual(body.schedule);
    });

    it("sanitises a payload with bogus fields and still re-arms", async () => {
      const res = await PUT(jsonReq({
        enabled: true,
        frequency: "hourly",      // unknown — coerced to daily
        timeOfDay: "not-a-time",  // bogus — coerced to default
        weekday: 99,              // out-of-range — coerced to 0
      }));
      const body = await res.json();
      expect(body.schedule.frequency).toBe("daily");
      expect(body.schedule.timeOfDay).toBe(clawkeep.DEFAULT_SCHEDULE.timeOfDay);
      expect(body.schedule.weekday).toBe(0);
      expect(scheduler.refresh).toHaveBeenCalledTimes(1);
    });

    it("treats an empty body as a disable + defaults", async () => {
      const res = await PUT(new NextRequest(new URL("http://localhost/setup-api/clawkeep/schedule"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "",
      }));
      const body = await res.json();
      expect(body.schedule).toEqual(clawkeep.DEFAULT_SCHEDULE);
    });
  });

  // The shield ages a box out against the schedule this route publishes, so
  // what the route hands back about *when the cadence was armed* is part of
  // the protection verdict, not decoration.
  describe("the arm stamp the protection shield reads", () => {
    // A box whose backups died ten days ago. EXIT_AUTH_REVOKED returns before
    // any portal exchange, so the last heartbeat still reads "ok" and the age
    // of the last good backup is the only thing that gives it away.
    const deadBox = { lastHeartbeatStatus: "ok", encryptionConfigured: true };

    it("reads the cadence and the stamp off one version of the file", async () => {
      // The two are halves of one verdict — the window comes from the schedule,
      // the grace anchor from the stamp — so a `writeSchedule()` rename landing
      // between two separate reads pairs the cadence of one version with the
      // stamp of the next, a verdict neither version would give. A returned
      // pair that happens to agree proves nothing about that; the guarantee is
      // that there is only ever one read to interleave with.
      await PUT(jsonReq(ARMED_DAILY));
      const readFile = vi.spyOn(fs, "readFile");
      const body = await (await GET()).json();
      const scheduleReads = readFile.mock.calls
        .filter((args) => String(args[0]) === SCHEDULE_FILE).length;
      readFile.mockRestore();

      expect(scheduleReads).toBe(1);
      const onDisk = JSON.parse(await fs.readFile(SCHEDULE_FILE, "utf8"));
      expect(body.schedule.frequency).toBe(onDisk.frequency);
      expect(body.scheduleArmedAtMs).toBe(onDisk.armedAtMs);
    });

    it("depends on auto-backup shipping OFF by default", () => {
      // `nextArmedAtMs` reads an enabled schedule as evidence of its own
      // arming. A box with no `schedule.json` at all is judged on
      // DEFAULT_SCHEDULE, so shipping that as `enabled: true` would make every
      // fresh box read as "already armed" and lose the first-arm grace —
      // lapsing on the very click that arms it. Load-bearing, so pinned.
      expect(clawkeep.DEFAULT_SCHEDULE.enabled).toBe(false);
    });

    it("does not read an unreadable schedule.json as 'never armed'", async () => {
      const now = Date.now();
      // A truncated write or a power cut mid-rename leaves the file there and
      // unparseable, and `readSchedule()` falls back to DEFAULT_SCHEDULE —
      // which says auto-backup is off. But a file nobody can read is evidence
      // of NOTHING, not evidence that this box never armed a schedule, and the
      // owner's re-arming click must not buy 36 h of green on a box whose
      // backups have been dead for five days.
      const lastBackupAtMs = now - 5 * DAY_MS;
      // Parsing is not the same as being a schedule: `sanitiseSchedule` coerces
      // rather than throwing, so `null` and `[]` would otherwise come back as a
      // perfectly readable "auto-backup is off" and buy the same false window.
      for (const corpse of ["{not-json", "", "null", "[]"]) {
        await writeLastBackup(lastBackupAtMs);
        await fs.writeFile(SCHEDULE_FILE, corpse);

        const armed = await (await PUT(jsonReq(ARMED_DAILY))).json();
        expect(deriveProtection({ ...armed, ...deadBox, lastBackupAtMs }, now))
          .toEqual({ state: "lapsed", reason: "stale" });
      }
    });

    it("does not read an I/O failure as 'no schedule was ever armed'", async () => {
      // "No file" is one error code, not all of them. EACCES on a file left
      // root-owned, EIO on failing storage — the box that needs the alarm most
      // — is a file that IS there, and reading it as "auto-backup was off"
      // hands the owner's next re-arming click 36 h of green on a dead box.
      // A directory where the file should be reproduces that class (EISDIR)
      // without the test depending on not running as root.
      await fs.mkdir(SCHEDULE_FILE);
      await expect(clawkeep.readScheduleSnapshot()).resolves.toMatchObject({ unreadable: true });
      await fs.rmdir(SCHEDULE_FILE);

      // ...and a file that is simply absent still means what it says: this box
      // has never armed a schedule, so its first arm keeps its grace.
      await expect(clawkeep.readScheduleSnapshot()).resolves.toMatchObject({ unreadable: false });
    });

    it("does not regrant the window when an armed schedule is merely re-saved", async () => {
      const now = Date.now();
      const lastBackupAtMs = now - 10 * DAY_MS;

      await PUT(jsonReq(ARMED_DAILY));
      await backdateArm(now - 60 * DAY_MS);

      const before = await (await GET()).json();
      expect(deriveProtection({ ...before, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });

      // The lapsed card tells the owner the scheduled run is failing, so they
      // open the schedule card and change the one thing they can — keep-last
      // from 10 to 7. Same switch, same cadence, same time of day.
      const saved = await (await PUT(jsonReq({ ...ARMED_DAILY, retentionKeepLast: 7 }))).json();
      expect(saved.schedule.retentionKeepLast).toBe(7);

      // Nothing about the box has changed, so the shield must not turn green —
      // not on the response the card folds in, and not on the next poll.
      expect(deriveProtection({ ...saved, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
      const after = await (await GET()).json();
      expect(deriveProtection({ ...after, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
    });

    it("does not regrant the window for a time-of-day nudge either", async () => {
      const now = Date.now();
      const lastBackupAtMs = now - 10 * DAY_MS;

      await PUT(jsonReq(ARMED_DAILY));
      await backdateArm(now - 60 * DAY_MS);
      const saved = await (await PUT(jsonReq({ ...ARMED_DAILY, timeOfDay: "03:00" }))).json();

      expect(saved.schedule.timeOfDay).toBe("03:00");
      expect(deriveProtection({ ...saved, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
    });


    it("does not un-lapse a dead box when the owner toggles auto-backup off and on", async () => {
      const now = Date.now();
      // Five days without a backup on a nightly schedule: amber, and the copy
      // invites exactly this — the owner opens the schedule card and flips the
      // switch. Two PUTs, the second of which genuinely arms.
      const lastBackupAtMs = now - 5 * DAY_MS;
      await writeLastBackup(lastBackupAtMs);
      await PUT(jsonReq(ARMED_DAILY));
      await backdateArm(now - 60 * DAY_MS);

      await PUT(jsonReq({ ...ARMED_DAILY, enabled: false }));
      const rearmed = await (await PUT(jsonReq(ARMED_DAILY))).json();

      // Arming must not lapse a box for a run that is not due yet. It must not
      // un-lapse one either — those are different things, and only the first
      // needs granting.
      expect(deriveProtection({ ...rearmed, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
    });

    it("does not un-lapse a dead box whose schedule.json predates the stamp", async () => {
      const now = Date.now();
      // The upgrade path, and the state EVERY deployed box is in the moment it
      // takes this build: beta's `schedule.json`, auto-backup on, no
      // `armedAtMs`. Five days without a backup on a nightly schedule is amber,
      // and the lapsed copy sends the owner to the schedule card — where the
      // first instinct is to flip the switch off and back on.
      const lastBackupAtMs = now - 5 * DAY_MS;
      await writeLastBackup(lastBackupAtMs);
      await writeLegacySchedule(ARMED_DAILY);

      const before = await (await GET()).json();
      expect(deriveProtection({ ...before, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });

      await PUT(jsonReq({ ...ARMED_DAILY, enabled: false }));
      const rearmed = await (await PUT(jsonReq(ARMED_DAILY))).json();

      // A missing stamp means "no window is running", not "this box has never
      // had a schedule" — reading it as the latter hands the toggle the very
      // rescue the stamp exists to refuse.
      expect(deriveProtection({ ...rearmed, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
      const after = await (await GET()).json();
      expect(deriveProtection({ ...after, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
    });

    it("does not un-lapse a dead box by tightening the cadence either", async () => {
      const now = Date.now();
      const lastBackupAtMs = now - 10 * DAY_MS;
      await writeLastBackup(lastBackupAtMs);
      await PUT(jsonReq({ ...ARMED_DAILY, frequency: "weekly" }));
      await backdateArm(now - 60 * DAY_MS);

      // Ten days is past the weekly window too, so the box was already lapsed
      // when the tightening arrived — one click, and it must stay lapsed.
      const tightened = await (await PUT(jsonReq(ARMED_DAILY))).json();
      expect(deriveProtection({ ...tightened, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
    });

    it("gives no grace to a schedule.json written before the stamp existed", async () => {
      const now = Date.now();
      // The upgrade path every box takes: beta's file, no `armedAtMs`, and an
      // mtime the owner refreshed minutes ago by nudging retention. Judged on
      // that mtime the box would read green for another 36 h.
      const lastBackupAtMs = now - 6 * DAY_MS;
      await writeLastBackup(lastBackupAtMs);
      await writeLegacySchedule(ARMED_DAILY);

      const body = await (await GET()).json();
      expect(body.scheduleArmedAtMs).toBe(0);
      expect(deriveProtection({ ...body, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
    });

    it("gives no window to a first arm on a box the no-schedule week had lapsed", async () => {
      const now = Date.now();
      // Seven days and an hour, never scheduled: the window this box is leaving
      // had already called it lapsed, and MAX_BACKUP_WINDOW_MS (7 d 12 h) is
      // wide enough for a minted stamp to reach past it. Arming a cadence is a
      // promise about future runs, not evidence about the last one.
      const lastBackupAtMs = now - 7 * DAY_MS - 60 * 60 * 1000;
      await writeLastBackup(lastBackupAtMs);

      const armed = await (await PUT(jsonReq(ARMED_DAILY))).json();
      expect(deriveProtection({ ...armed, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
      expect(armed.scheduleArmedAtMs).toBe(0);
    });

    it("still gives a schedule the owner has just armed its own window", async () => {
      const now = Date.now();
      // The case the grace exists for, and the one every box starts in: auto-
      // backup has never been armed here, so the window is the no-schedule week
      // and a three-day-old manual backup is green. Arming Daily shrinks that to
      // 36 h; applying it retroactively would lapse the box on the click for a
      // run that is not due yet.
      const lastBackupAtMs = now - 3 * DAY_MS;
      await writeLastBackup(lastBackupAtMs);

      await PUT(jsonReq({ ...ARMED_DAILY, enabled: false }));
      const armed = await (await PUT(jsonReq(ARMED_DAILY))).json();

      expect(armed.scheduleArmedAtMs).toBeGreaterThan(0);
      expect(deriveProtection({ ...armed, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "protected", reason: "ok" });
    });

    it("re-arms when the cadence tightens from weekly to daily", async () => {
      const now = Date.now();
      const lastBackupAtMs = now - 3 * DAY_MS;
      await writeLastBackup(lastBackupAtMs);

      await PUT(jsonReq({ ...ARMED_DAILY, frequency: "weekly" }));
      await backdateArm(now - 60 * DAY_MS);
      const tightened = await (await PUT(jsonReq(ARMED_DAILY))).json();

      // Weekly held it green on age alone; Daily would not, so the tightening
      // gets its own window rather than lapsing the box on the click.
      expect(deriveProtection({ ...tightened, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "protected", reason: "ok" });
    });

    it("does not re-arm when the cadence loosens from daily to weekly", async () => {
      const now = Date.now();
      const lastBackupAtMs = now - 10 * DAY_MS;

      await PUT(jsonReq(ARMED_DAILY));
      await backdateArm(now - 60 * DAY_MS);
      const loosened = await (await PUT(jsonReq({ ...ARMED_DAILY, frequency: "weekly" }))).json();

      // Ten days is past the weekly window too, and loosening a cadence cannot
      // lapse a box that the tighter one already allowed — so there is nothing
      // to forgive and nothing to re-anchor.
      expect(deriveProtection({ ...loosened, ...deadBox, lastBackupAtMs }, now))
        .toEqual({ state: "lapsed", reason: "stale" });
    });
  });
});
