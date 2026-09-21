import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * What the owner is shown when "Back up now" comes back 409 `not_paired`.
 *
 * The fixture is a PAIRED box on purpose: `DashboardCard` is the only thing
 * with a "Back up now" button and `ClawKeepApp` renders it only when
 * `status.paired`, so a box that was never paired shows the Pair card and this
 * screen does not exist. What it reproduces is the pairing going away
 * underneath an open panel — unpaired in another tab, or revoked at the portal
 * — where the 10 s status poll still says paired and the click lands anyway.
 *
 * The route used to answer HTTP 200 `{ok:false, stderrTail:"… token error: No
 * token at <path>; run 'clawkeep pair' first"}`, and the result card printed
 * that tail verbatim — a daemon log line naming a directory on the device as
 * the entire explanation of a backup that never started.
 *
 * The route now answers 409 `{error, code:"not_paired"}` (see
 * src/tests/routes/clawkeep-unpaired.test.ts), which never reaches
 * `setBackupResult` — so the result card cannot render, and the sentence
 * arrives through the app's own error line. This test holds that: whatever a
 * later change does to the card, a refused backup must read as one sentence
 * and never as daemon output.
 */

const STATUS = {
  paired: true,
  configured: true,
  encryptionConfigured: true,
  server: "https://portal.example",
  lastBackupAtMs: Date.now() - 3_600_000,
  cloudBytes: 1024,
  snapshotCount: 2,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 10 },
  nextRunAtMs: 0,
};

const NOT_PAIRED = "ClawKeep is not paired with an account";
/** A daemon log line of the shape that used to reach the panel, path and all. */
const DAEMON_TAIL =
  "token error: No token at /home/clawbox/clawbox/data/clawkeep/token; run 'clawkeep pair' first";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/clawkeep/backup")) {
        return {
          ok: false,
          status: 409,
          // `stderrTail` is what the route used to answer WITH, inside a 200.
          // It is in the fixture so the assertion below can fail: nothing may
          // put it on screen, whatever header it might appear under.
          json: async () => ({ error: NOT_PAIRED, code: "not_paired", stderrTail: DAEMON_TAIL }),
        };
      }
      if (url.includes("/setup-api/clawkeep")) {
        return { ok: true, status: 200, json: async () => STATUS };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ClawKeep's backup button when the pairing is gone mid-session", () => {
  // 15 s, not vitest's default 5 s: this mounts the whole ClawKeep app and
  // settles its status poll before it can click, and the two waits below ask
  // for 5 s each — on a loaded runner the default budget expires first.
  it("says ClawKeep is not paired, and shows no daemon output", async () => {
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }, { timeout: 5000 }));

    expect(await screen.findByText(new RegExp(NOT_PAIRED), {}, { timeout: 5000 })).toBeTruthy();
    // `BackupResultCard` was the only component that rendered the daemon's
    // `stderrTail`, and "Failed (exit {code})" was its header. Since TASK-672
    // the card has no failure branch at all — a failed backup is a non-2xx
    // whose sentence goes to the page's error banner. Asserting the absent
    // header alone would be unfalsifiable now that the string is deleted from
    // every locale, so the fixture carries a daemon-shaped tail with a device
    // path in it and the real assertion is that NOTHING put it on screen.
    expect(screen.queryByText(/Failed \(exit/)).toBeNull();
    expect(document.body.textContent).not.toContain(DAEMON_TAIL);
    expect(document.body.textContent).not.toContain("/home/clawbox");
  }, 15_000);
});
