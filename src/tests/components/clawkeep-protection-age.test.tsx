import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * The shield has to answer "am I protected *now*", not "did this box ever
 * complete a backup".
 *
 * The two failures that keep a ClawBox unprotected longest write no heartbeat
 * at all: `EXIT_AUTH_REVOKED` (3) returns from `clawkeep/clawkeep/runner.py`
 * before any portal exchange — "No portal exchange happened — don't heartbeat
 * or stamp state" — and a daemon that is gone (exec failure, 127) never runs
 * a line. In both cases `lastHeartbeatStatus` keeps the last run's "ok" and
 * `lastBackupAtMs` simply stops moving, so a shield that only asks
 * `lastBackupAtMs > 0` reads "You're Protected" for as long as the box lives.
 *
 * So: green only for a backup that is younger than the window the schedule
 * implies, amber once it ages past it, and — the false-failure side — a box
 * that has legitimately never run one still reads "Not Protected", never
 * "lapsed".
 */

const HOUR = 60 * 60 * 1000;

const BASE_STATUS = {
  paired: true,
  configured: true,
  server: "https://portal.example",
  lastBackupAtMs: 0,
  lastHeartbeatAtMs: 0,
  lastHeartbeatStatus: "",
  currentStep: "",
  currentStepAtMs: 0,
  cloudBytes: 4096,
  snapshotCount: 3,
  uploadBytesTotal: 0,
  uploadBytesDone: 0,
  uploadStartedAtMs: 0,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  agent: "openclaw",
  encryptionConfigured: true,
  schedule: {
    enabled: true,
    frequency: "daily",
    timeOfDay: "02:00",
    weekday: 0,
    retentionKeepLast: 10,
  },
  nextRunAtMs: 0,
  scheduleArmedAtMs: 0,
};

let status: Record<string, unknown> = { ...BASE_STATUS };

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes("/setup-api/clawkeep")) return ok(status);
    return ok({});
  }));
}

/** Render and wait for the shield headline to settle. */
async function shieldHeadline(): Promise<string> {
  render(<I18nProvider><ClawKeepApp /></I18nProvider>);
  const heading = await screen.findByRole(
    "heading",
    { level: 2, name: /You're Protected|Protection Lapsed|Not Protected/ },
    { timeout: 5000 },
  );
  return heading.textContent ?? "";
}

describe("the ClawKeep shield's age term", () => {
  beforeEach(() => {
    status = { ...BASE_STATUS };
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("goes amber when the last good backup aged past the nightly window, with no error heartbeat", async () => {
    // 40 h old against a daily schedule (24 h + 12 h grace = 36 h), and the
    // daemon's last word was a success — exactly the exit-3 / exit-127 shape.
    status = {
      ...BASE_STATUS,
      lastBackupAtMs: Date.now() - 40 * HOUR,
      lastHeartbeatAtMs: Date.now() - 40 * HOUR,
      lastHeartbeatStatus: "ok",
    };
    expect(await shieldHeadline()).toBe("Protection Lapsed");
  });

  it("says when the last good backup was and that nothing has run since", async () => {
    status = {
      ...BASE_STATUS,
      lastBackupAtMs: Date.now() - 3 * 24 * HOUR,
      lastHeartbeatAtMs: Date.now() - 3 * 24 * HOUR,
      lastHeartbeatStatus: "ok",
    };
    await shieldHeadline();
    expect(screen.getByText(/last completed backup was 3d ago/i)).toBeTruthy();
    expect(screen.getByText(/nothing has backed up this box since/i)).toBeTruthy();
  });

  it("stays green while the last backup is inside the window", async () => {
    status = {
      ...BASE_STATUS,
      lastBackupAtMs: Date.now() - 30 * HOUR,
      lastHeartbeatAtMs: Date.now() - 30 * HOUR,
      lastHeartbeatStatus: "ok",
    };
    expect(await shieldHeadline()).toBe("You're Protected");
    expect(screen.getByText(/safe in the ClawBox cloud/i)).toBeTruthy();
  });

  it("keeps a weekly schedule green at three days old", async () => {
    status = {
      ...BASE_STATUS,
      schedule: { ...BASE_STATUS.schedule, frequency: "weekly", weekday: 3 },
      lastBackupAtMs: Date.now() - 3 * 24 * HOUR,
      lastHeartbeatAtMs: Date.now() - 3 * 24 * HOUR,
      lastHeartbeatStatus: "ok",
    };
    expect(await shieldHeadline()).toBe("You're Protected");
  });

  it("ages a Hermes box out on the same terms — ClawKeep is shared", async () => {
    status = {
      ...BASE_STATUS,
      agent: "hermes",
      openclawInstalled: false,
      lastBackupAtMs: Date.now() - 40 * HOUR,
      lastHeartbeatAtMs: Date.now() - 40 * HOUR,
      lastHeartbeatStatus: "ok",
    };
    expect(await shieldHeadline()).toBe("Protection Lapsed");
  });

  it("reads 'Not Protected' on a fresh install that has never run one, never 'lapsed'", async () => {
    status = { ...BASE_STATUS, lastBackupAtMs: 0, lastHeartbeatStatus: "" };
    expect(await shieldHeadline()).toBe("Not Protected");
  });

  it("does not lapse a box for a schedule it was given a minute ago", async () => {
    // Every box ships with auto-backup off (a week-long window). Arming Daily
    // shrinks it to 36 h — retroactively, that flips a green box amber on the
    // same click and blames a scheduled run that has never run.
    status = {
      ...BASE_STATUS,
      lastBackupAtMs: Date.now() - 3 * 24 * HOUR,
      lastHeartbeatAtMs: Date.now() - 3 * 24 * HOUR,
      lastHeartbeatStatus: "ok",
      scheduleArmedAtMs: Date.now() - 60_000,
    };
    expect(await shieldHeadline()).toBe("You're Protected");
  });

  it("says auto-backup is off rather than 'safe, the works', when the switch is what turned it green", async () => {
    // Five days stale on a nightly cadence is amber; switching auto-backup off
    // widens the tolerated age to the no-schedule week and the shield goes
    // green on that one click. The verdict is beta's — a box its owner took off
    // auto-backup is judged as a manual one, and judging it against the cadence
    // it abandoned would cry wolf at every manual box — but the card must not
    // answer it with "safe in the ClawBox cloud" when nothing is going to make
    // a newer backup.
    status = {
      ...BASE_STATUS,
      schedule: { ...BASE_STATUS.schedule, enabled: false },
      lastBackupAtMs: Date.now() - 5 * 24 * HOUR,
      lastHeartbeatAtMs: Date.now() - 5 * 24 * HOUR,
      lastHeartbeatStatus: "ok",
    };
    expect(await shieldHeadline()).toBe("You're Protected");
    expect(screen.getByText(/last completed backup was 5d ago/i)).toBeTruthy();
    expect(screen.getByText(/auto-backup is off/i)).toBeTruthy();
    expect(screen.queryByText(/safe in the ClawBox cloud/i)).toBeNull();
  });

  it("says a refused run is refused, instead of waiting out the window", async () => {
    // EXIT_NEED_PASSPHRASE (9) returns without touching lastBackupAtMs, so the
    // age term alone would report green for 36 h over a box on which no run
    // can succeed.
    status = {
      ...BASE_STATUS,
      lastBackupAtMs: Date.now() - 1 * HOUR,
      lastHeartbeatAtMs: Date.now() - 30 * 60 * 1000,
      lastHeartbeatStatus: "needs-passphrase",
    };
    expect(await shieldHeadline()).toBe("Protection Lapsed");
    expect(screen.getByText(/refusing to run until this box has an encryption passphrase/i)).toBeTruthy();
  });

  it("still reports an error heartbeat as lapsed", async () => {
    status = {
      ...BASE_STATUS,
      lastBackupAtMs: Date.now() - 1 * HOUR,
      lastHeartbeatAtMs: Date.now() - 30 * 60 * 1000,
      lastHeartbeatStatus: "error",
    };
    expect(await shieldHeadline()).toBe("Protection Lapsed");
  });
});
