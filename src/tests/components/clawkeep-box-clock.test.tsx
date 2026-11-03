import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";
import { _resetBoxClockForTests } from "@/lib/box-clock";

/**
 * TASK-2138: "Last backup" is a time the box wrote, and it was held against
 * the browser's clock. A laptop 45 s behind the box called the backup that had
 * just finished "in the future"; one 10 min ahead called a 3-minute-old backup
 * 13 minutes old. The window's own status poll carries the box's clock in its
 * `Date` header, and the label is held to that.
 */

const MINUTE = 60_000;

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

/** How far the box's clock is ahead of the browser's (negative: behind). */
let boxLeadMs = 0;
let status: Record<string, unknown> = { ...BASE_STATUS };

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const boxNow = Date.now() + boxLeadMs;
    const answer = (json: unknown) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ date: new Date(boxNow).toUTCString() }),
      json: async () => json,
    });
    if (url === "/setup-api/clawkeep") return answer(status);
    return answer({});
  }));
}

async function lastBackupValue(): Promise<string> {
  render(<I18nProvider><ClawKeepApp /></I18nProvider>);
  const label = await screen.findByText("Last backup", undefined, { timeout: 5000 });
  return label.nextElementSibling?.textContent ?? "";
}

describe("ClawKeep's last backup, on the box's clock", () => {
  beforeEach(() => {
    _resetBoxClockForTests();
    boxLeadMs = 0;
    status = { ...BASE_STATUS };
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls a backup that just finished on a box ahead of the browser just now, not in the future", async () => {
    boxLeadMs = 45_000;
    const finished = Date.now() + boxLeadMs - 2_000;
    status = { ...BASE_STATUS, lastBackupAtMs: finished, lastHeartbeatAtMs: finished };
    await lastBackupValue();
    await waitFor(() => expect(screen.getByText("Last backup").nextElementSibling?.textContent).toBe("just now"));
    expect(screen.queryByText(/in the future/i)).toBeNull();
  });

  it("does not age a backup by the browser's lead over the box", async () => {
    boxLeadMs = -10 * MINUTE;
    const finished = Date.now() + boxLeadMs - 3 * MINUTE;
    status = { ...BASE_STATUS, lastBackupAtMs: finished, lastHeartbeatAtMs: finished };
    await lastBackupValue();
    await waitFor(() => expect(screen.getByText("Last backup").nextElementSibling?.textContent).toBe("3m ago"));
  });
});
