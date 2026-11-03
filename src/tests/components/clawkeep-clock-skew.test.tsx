import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { formatNextRun, timeAgo } from "@/components/clawkeep-ui";
import { I18nProvider } from "@/lib/i18n";
import { _resetBoxClockForTests, noteBoxClock } from "@/lib/box-clock";

/**
 * "Last backup: in the future", right after Back up now: the browser's clock
 * was a few seconds behind the box's, and the label measured the box's
 * `lastBackupAtMs` against the browser's `Date.now()`. The label now measures
 * on the box's clock — learned from the status answer's `Date` header — and a
 * time ahead of it (a leftover skew) reads "just now", never "in the future".
 * Both ways round: a browser ahead of the box used to age a fresh backup by its
 * lead, and one behind it took minutes off every age.
 */

const SEC = 1_000;
const MIN = 60_000;

/** The key a fake translator was asked for, with its count when it had one. */
const t = (key: string, params?: Record<string, string | number>) =>
  params && "count" in params ? `${key}:${params.count}` : key;

/** An answer whose `Date` header says the box's clock read `boxMs`. */
function stamped(boxMs: number): { headers: Headers } {
  return { headers: new Headers({ date: new Date(boxMs).toUTCString() }) };
}

beforeEach(() => {
  _resetBoxClockForTests();
});

describe("timeAgo on the box's clock", () => {
  const BROWSER_NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

  it("says just now for a backup the box just finished, with the browser behind the box", () => {
    const boxNow = BROWSER_NOW + 10 * MIN;
    noteBoxClock(stamped(boxNow), BROWSER_NOW - 20, BROWSER_NOW);
    const finishedAt = boxNow - 2 * SEC;
    vi.useFakeTimers();
    vi.setSystemTime(BROWSER_NOW);
    try {
      expect(timeAgo(finishedAt, t)).toBe("clawkeep.justNow");
      // Older backups keep their age: on the browser's clock this one is 5 minutes ahead.
      expect(timeAgo(finishedAt - 5 * MIN, t, BROWSER_NOW)).toBe("clawkeep.justNow");
      expect(timeAgo(finishedAt - 5 * MIN, t)).toBe("clawkeep.minutesAgo:5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says just now for a backup the box just finished, with the browser ahead of the box", () => {
    const boxNow = BROWSER_NOW - 10 * MIN;
    noteBoxClock(stamped(boxNow), BROWSER_NOW - 20, BROWSER_NOW);
    const finishedAt = boxNow - 2 * SEC;
    expect(timeAgo(finishedAt, t, BROWSER_NOW)).toBe("clawkeep.minutesAgo:10");
    vi.useFakeTimers();
    vi.setSystemTime(BROWSER_NOW);
    try {
      expect(timeAgo(finishedAt, t)).toBe("clawkeep.justNow");
      expect(timeAgo(finishedAt - 3 * MIN, t)).toBe("clawkeep.minutesAgo:3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a time ahead of now as just now, never in the future", () => {
    expect(timeAgo(BROWSER_NOW + 5 * SEC, t, BROWSER_NOW)).toBe("clawkeep.justNow");
    expect(timeAgo(BROWSER_NOW + 2 * MIN, t, BROWSER_NOW)).toBe("clawkeep.justNow");
    // Further ahead than any skew: the box's clock was set back since. Still a past backup.
    expect(timeAgo(BROWSER_NOW + 2 * MIN + 1, t, BROWSER_NOW)).toBe("clawkeep.justNow");
    expect(timeAgo(BROWSER_NOW + 3 * 3_600_000, t, BROWSER_NOW)).toBe("clawkeep.justNow");
  });

  it("keeps its other answers", () => {
    expect(timeAgo(0, t, BROWSER_NOW)).toBe("clawkeep.never");
    expect(timeAgo(BROWSER_NOW - 5 * MIN, t, BROWSER_NOW)).toBe("clawkeep.minutesAgo:5");
    expect(timeAgo(BROWSER_NOW - 3 * 3_600_000, t, BROWSER_NOW)).toBe("clawkeep.hoursAgo:3");
    expect(timeAgo(BROWSER_NOW - 2 * 86_400_000, t, BROWSER_NOW)).toBe("clawkeep.daysAgo:2");
  });
});

describe("formatNextRun on the box's clock", () => {
  const BROWSER_NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
  /** The fake translator, with every parameter it was given. */
  const tAll = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down to the box's next run from the box's now, both ways round", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BROWSER_NOW);
    // The box is 10 minutes ahead of the browser; its next run is 30 minutes off by its clock.
    noteBoxClock(stamped(BROWSER_NOW + 10 * MIN), BROWSER_NOW - 20, BROWSER_NOW);
    expect(formatNextRun(BROWSER_NOW + 40 * MIN, tAll)).toBe('clawkeep.inMinutes:{"mins":30}');
    // The box is 10 minutes behind; a run 5 minutes off by its clock is not "any moment".
    noteBoxClock(stamped(BROWSER_NOW - 10 * MIN), BROWSER_NOW - 20, BROWSER_NOW);
    expect(formatNextRun(BROWSER_NOW - 5 * MIN, tAll)).toBe('clawkeep.inMinutes:{"mins":5}');
    expect(formatNextRun(BROWSER_NOW - 11 * MIN, tAll)).toBe("clawkeep.anyMoment");
  });
});

const BASE_STATUS = {
  paired: true,
  configured: true,
  server: "https://portal.example",
  lastBackupAtMs: 0,
  lastHeartbeatAtMs: 0,
  lastHeartbeatStatus: "ok",
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

describe("the ClawKeep window right after a backup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /**
   * A box whose clock is `skewMs` ahead of the browser's (negative: behind),
   * which finished a backup two seconds ago by its own clock. `dateHeader`
   * false: an answer without one, as a proxy might leave it.
   */
  function boxAnswering(skewMs: number, { dateHeader = true } = {}) {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const boxNow = Date.now() + skewMs;
      const headers = dateHeader ? stamped(boxNow).headers : new Headers();
      const body = String(input).includes("/setup-api/clawkeep")
        ? { ...BASE_STATUS, lastBackupAtMs: boxNow - 2 * SEC, lastHeartbeatAtMs: boxNow - 2 * SEC }
        : {};
      return { ok: true, status: 200, statusText: "OK", headers, json: async () => body };
    }));
  }

  /** What the "Last backup" cell says once the status has been drawn. */
  async function lastBackupCell(): Promise<string> {
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    const [label] = await screen.findAllByText("Last backup", undefined, { timeout: 5000 });
    return label.nextElementSibling?.textContent ?? "";
  }

  it("says just now with the browser's clock 10 minutes behind the box", async () => {
    boxAnswering(10 * MIN);
    expect(await lastBackupCell()).toBe("just now");
    expect(screen.queryByText(/in the future/i)).toBeNull();
  });

  it("says just now with the browser's clock 10 minutes ahead of the box", async () => {
    boxAnswering(-10 * MIN);
    expect(await lastBackupCell()).toBe("just now");
    expect(screen.queryByText(/\b(9|10)m ago/)).toBeNull();
  });

  it("says just now with the browser a few seconds behind and no Date header to correct it", async () => {
    boxAnswering(8 * SEC, { dateHeader: false });
    expect(await lastBackupCell()).toBe("just now");
    expect(screen.queryByText(/in the future/i)).toBeNull();
  });

  it("never says in the future, even 10 minutes behind with no Date header to correct it", async () => {
    boxAnswering(10 * MIN, { dateHeader: false });
    expect(await lastBackupCell()).toBe("just now");
    expect(screen.queryByText(/in the future/i)).toBeNull();
  });
});
