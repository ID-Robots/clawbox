import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * What the restore result card says while the state holder is still coming back.
 *
 * A restore replaces the files the gateway holds open, so it has to be
 * restarted — and its next start is the SLOWEST this box performs: it re-reads
 * the SQLite the restore just wrote, straight after several hundred megabytes
 * of restore I/O. `systemctl restart` exits 0 long before :18789 is bound, so
 * the readiness probe that TASK-608 put behind the restart times out here as a
 * matter of course, not as an exception.
 *
 * The card must not read that as a failed restart. The sentence it used to
 * print — "Could not auto-restart 1 service(s). Run `sudo systemctl restart
 * clawbox-gateway.service` manually" — is wrong twice over: the service WAS
 * restarted, and running the command it prescribes kills a gateway in the
 * middle of its start, restarts the whole boot, and on a couple of repeats
 * trips StartLimitBurst (20/hour), after which the unit refuses every restart
 * for the rest of the window. A false failure that talks the owner into a real
 * one.
 */

const BASE_STATUS = {
  paired: true,
  configured: true,
  server: "https://portal.example",
  lastBackupAtMs: Date.now() - 3_600_000,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  encryptionConfigured: true,
  snapshotCount: 1,
  cloudBytes: 1024,
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 0 },
  nextRunAtMs: 0,
};

const SNAPSHOT = "2026-08-28T00-00-00.000Z-openclaw-backup.tar.gz";

let restoreBody: Record<string, unknown> = {};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes("/setup-api/clawkeep/snapshots")) {
      return ok({ snapshots: [{ name: SNAPSHOT, size_bytes: 4096, last_modified_ms: Date.now() }] });
    }
    if (url.includes("/setup-api/clawkeep/restore")) return ok(restoreBody);
    if (url.includes("/setup-api/clawkeep")) return ok(BASE_STATUS);
    return ok({});
  }));
}

/** Drive the app the way the owner does: Restore → pick the snapshot → confirm. */
async function restore() {
  render(<I18nProvider><ClawKeepApp /></I18nProvider>);
  fireEvent.click(
    await screen.findByRole("button", { name: /Restore from snapshot/i }, { timeout: 5000 }),
  );
  // The snapshot rows arrive after the modal's own fetch; the row's action and
  // the confirm dialog's are both labelled "Restore", so the dialog is scoped.
  const rows = await screen.findAllByRole("button", { name: "Restore" }, { timeout: 5000 });
  fireEvent.click(rows[0]);
  const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
  fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
}

describe("ClawKeep's restore result card", () => {
  beforeEach(() => {
    restoreBody = {};
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not prescribe a manual restart for a gateway that is still binding", async () => {
    restoreBody = {
      ok: true,
      archive: SNAPSHOT,
      archiveBytes: 4096,
      assets: [],
      skippedMembers: [],
      restartErrors: [],
      restartPending: ["clawbox-gateway.service: was restarted but is not serving the restored state yet"],
    };

    await restore();

    // The pending line is shown, and it names the unit so the owner can tell
    // which process is coming back on a box that has two.
    const pending = await screen.findByTestId("clawkeep-restart-pending", {}, { timeout: 5000 });
    expect(pending.textContent).toContain("clawbox-gateway.service");
    // The command that would make it worse is not on screen, and neither is
    // the sentence that says the restart could not be done.
    expect(screen.queryByText(/sudo systemctl restart/)).toBeNull();
    expect(screen.queryByText(/Could not auto-restart/)).toBeNull();
  });

  it("still prints the manual restart when the restart was actually refused", async () => {
    restoreBody = {
      ok: true,
      archive: SNAPSHOT,
      archiveBytes: 4096,
      assets: [],
      skippedMembers: [],
      restartErrors: ["clawbox-gateway.service: sudo: a password is required"],
      restartPending: [],
    };

    await restore();

    await waitFor(
      () => expect(screen.getByText(/Could not auto-restart/)).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.getByText(/sudo systemctl restart clawbox-gateway.service/)).toBeTruthy();
    expect(screen.queryByTestId("clawkeep-restart-pending")).toBeNull();
  });

  it("says nothing about restarts when the gateway came back", async () => {
    restoreBody = {
      ok: true,
      archive: SNAPSHOT,
      archiveBytes: 4096,
      assets: [],
      skippedMembers: [],
      restartErrors: [],
      restartPending: [],
    };

    await restore();

    await waitFor(
      () => expect(screen.getByText(new RegExp(SNAPSHOT))).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.queryByTestId("clawkeep-restart-pending")).toBeNull();
    expect(screen.queryByText(/Could not auto-restart/)).toBeNull();
  });

  it("survives a server that predates restartPending", async () => {
    // An older daemon answers without the field; the card must not throw over
    // a missing array, the way `skippedMembers` is already tolerated.
    restoreBody = {
      ok: true,
      archive: SNAPSHOT,
      archiveBytes: 4096,
      assets: [],
      restartErrors: [],
    };

    await restore();

    await waitFor(
      () => expect(screen.getByText(new RegExp(SNAPSHOT))).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.queryByTestId("clawkeep-restart-pending")).toBeNull();
  });
});
