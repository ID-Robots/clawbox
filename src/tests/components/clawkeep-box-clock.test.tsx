import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";
import { _resetBoxClockForTests } from "@/lib/box-clock";

/**
 * TASK-2138: right after "Back up now" the card said "Last backup: in the
 * future". The daemon stamps `lastBackupAtMs` with the BOX's clock and the
 * window held it against the browser's, a few seconds behind. Now the window
 * reads the box's clock off the status answers (`serverNowMs`, else the Date
 * header) and judges every "when" against that — so a backup the box has just
 * finished is "just now" whichever way the two clocks disagree.
 */

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** How far the box's clock reads ahead of the browser's (negative: behind). */
let skewMs = 0;
/** Whether the status body carries the box's reading, or only the Date header does. */
let bodyReading = true;
const boxClock = () => Date.now() + skewMs;

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
  schedule: { enabled: true, frequency: "daily", timeOfDay: "02:00", weekday: 0, retentionKeepLast: 10 },
  nextRunAtMs: 0,
  scheduleArmedAtMs: 0,
};

let status: Record<string, unknown> = { ...BASE_STATUS };

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // Every answer carries the box's Date header, as Node's server sends one.
    const headers = new Headers({ date: new Date(boxClock()).toUTCString() });
    const ok = (json: unknown) => ({ ok: true, status: 200, statusText: "OK", headers, json: async () => json });
    if (url.includes("/setup-api/clawkeep/backup") && init?.method === "POST") {
      // The daemon finishes the run and stamps it with the box's clock.
      const at = boxClock();
      status = { ...status, lastBackupAtMs: at, lastHeartbeatAtMs: at, lastHeartbeatStatus: "ok" };
      return ok({ ok: true, exitCode: 0, stdoutTail: "", stderrTail: "" });
    }
    if (url.endsWith("/setup-api/clawkeep")) {
      return ok(bodyReading ? { ...status, serverNowMs: boxClock() } : status);
    }
    if (url.includes("/setup-api/clawkeep/snapshots")) return ok({ snapshots: [] });
    return ok({});
  }));
}

/** The value under the hero's "Last backup" label. */
function lastBackupShown(): string | null {
  const label = screen.queryAllByText("Last backup").find((el) => el.nextElementSibling);
  return label?.nextElementSibling?.textContent ?? null;
}

describe("ClawKeep's 'Last backup' right after Back up now, with the clocks apart", () => {
  beforeEach(() => {
    _resetBoxClockForTests();
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    _resetBoxClockForTests();
  });

  it.each([
    { name: "browser 4 s behind the box (the report), Date header only", skew: 4 * SEC, body: false },
    { name: "browser 10 min behind the box", skew: 10 * MIN, body: true },
    { name: "browser 10 min behind the box, Date header only", skew: 10 * MIN, body: false },
    { name: "browser 10 min ahead of the box", skew: -10 * MIN, body: true },
  ])("says 'just now' — $name", async ({ skew, body }) => {
    skewMs = skew;
    bodyReading = body;
    const before = boxClock() - 20 * HOUR - 30 * MIN;
    status = { ...BASE_STATUS, lastBackupAtMs: before, lastHeartbeatAtMs: before };

    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    // Before the backup: 20 h either way (the half hour keeps a 10 min skew
    // from tipping the hour, so what fails below is the label under test).
    await waitFor(() => expect(lastBackupShown()).toBe("20h ago"), { timeout: 5000 });

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }, { timeout: 5000 }));

    await waitFor(() => expect(lastBackupShown()).toBe("just now"), { timeout: 5000 });
    expect(document.body.textContent).not.toContain("in the future");
  }, 15_000);
});
