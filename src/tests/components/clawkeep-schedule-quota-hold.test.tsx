import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * TASK-1211: auto-backup switched off while the ClawKeep account was full is a
 * pause the box ends by itself, and the card has to say so — "Off" read as a
 * decision someone had made, and the owner asked whether ClawBox had disabled
 * it or whether they should re-arm it.
 */

const HOUR = 60 * 60 * 1000;
const PAUSED_COPY = "Paused while the ClawKeep account is full — it switches back on by itself once backups can run again.";
const OFF_COPY = "Off — back up only when you click Back up now.";

const SCHEDULE = { enabled: false, frequency: "daily", timeOfDay: "02:00", weekday: 0, retentionKeepLast: 10 };

const BASE_STATUS = {
  paired: true,
  setupComplete: true,
  configured: true,
  server: "https://portal.example",
  lastBackupAtMs: Date.now() - 20 * HOUR,
  lastHeartbeatAtMs: Date.now() - HOUR,
  lastHeartbeatStatus: "error",
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
  schedule: SCHEDULE,
  nextRunAtMs: 0,
  scheduleArmedAtMs: 1,
  scheduleQuotaHoldSinceMs: Date.now() - HOUR,
};

let status: Record<string, unknown> = { ...BASE_STATUS };
let saveAnswer: Record<string, unknown> = {};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes("/setup-api/clawkeep/schedule") && init?.method === "PUT") return ok(saveAnswer);
    if (url.includes("/setup-api/clawkeep/snapshots")) return ok({ snapshots: [] });
    if (url.includes("/setup-api/clawkeep")) return ok(status);
    return ok({});
  }));
}

/** The card's one-line summary, once the provider has resolved the locale —
 *  before that it renders catalogue keys. */
async function scheduleSummary(): Promise<HTMLElement> {
  render(<I18nProvider><ClawKeepApp /></I18nProvider>);
  const summary = await screen.findByTestId("clawkeep-schedule-summary", {}, { timeout: 5000 });
  await waitFor(() => expect(summary.textContent).not.toMatch(/^clawkeep\./), { timeout: 5000 });
  return summary;
}

describe("the ClawKeep schedule card during a quota pause", () => {
  beforeEach(() => {
    status = { ...BASE_STATUS };
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("says auto-backup is paused and comes back by itself, not that it is off", async () => {
    expect((await scheduleSummary()).textContent).toBe(PAUSED_COPY);
  });

  it("says 'Off' for a schedule the owner switched off with room in the account", async () => {
    status = { ...BASE_STATUS, scheduleQuotaHoldSinceMs: 0 };

    expect((await scheduleSummary()).textContent).toBe(OFF_COPY);
  });

  it("says 'Off' for an older server that sends no hold at all", async () => {
    const { scheduleQuotaHoldSinceMs: _dropped, ...older } = BASE_STATUS;
    void _dropped;
    status = older;

    expect((await scheduleSummary()).textContent).toBe(OFF_COPY);
  });

  it("drops the pause copy once the owner switches auto-backup back on", async () => {
    saveAnswer = {
      schedule: { ...SCHEDULE, enabled: true },
      nextRunAtMs: Date.now() + 5 * HOUR,
      scheduleArmedAtMs: 1,
      scheduleQuotaHoldSinceMs: 0,
    };
    const summary = await scheduleSummary();
    expect(summary.textContent).toBe(PAUSED_COPY);

    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-backup" }));

    await waitFor(() => expect(screen.getByTestId("clawkeep-schedule-summary").textContent).toMatch(/^Next run/));
  });
});
