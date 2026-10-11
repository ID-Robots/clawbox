import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * What the owner is told when the daemon would not upload a backup.
 *
 * `clawkeepd` checks, before it uploads, that the encrypted archive fits in
 * what the account has free, and refuses — uploading and removing nothing —
 * when it does not, or when it cannot count what the account holds. A second
 * run while one is in flight is turned away too. Each of those used to reach
 * this window as a sentence about something else: "out of space" with no
 * sizes, "could not reach ClawKeep", "the backup did not finish".
 *
 * Two places have to say it. The banner, for the owner who pressed the button
 * — and the card itself, for the nightly run nobody was watching: the banner
 * is cleared by the next status poll, and "one retry and we'll lock it back
 * down" on a full account sends the owner to a button that can only refuse
 * again.
 */

const GB = 1024 ** 3;

const BASE = {
  paired: true,
  configured: true,
  encryptionConfigured: true,
  server: "https://portal.example",
  lastBackupAtMs: Date.now() - 3_600_000,
  lastHeartbeatAtMs: Date.now() - 60_000,
  lastHeartbeatStatus: "ok",
  cloudBytes: 5_046_586_573,
  snapshotCount: 4,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  schedule: { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 10 },
  nextRunAtMs: 0,
  lastRefusal: null,
};

/** 1.2 GB needed, 4.7 GB of 5.0 GB used: 307 MB free. */
const NO_ROOM = {
  kind: "quota_full",
  atMs: Date.now() - 60_000,
  neededBytes: 1_288_490_189,
  usedBytes: 5_046_586_573,
  quotaBytes: 5 * GB,
};
const LARGER_THAN_PLAN = { ...NO_ROOM, neededBytes: 6 * GB, usedBytes: 2 * GB };
const UNVERIFIED = { kind: "usage_unverified", atMs: Date.now(), neededBytes: 3 * GB, usedBytes: 0, quotaBytes: 5 * GB };

const GENERIC_LAPSED = "Your last backup didn't complete. One retry and we'll lock it back down.";
/** Stands in for the route's English sentence: the window has its own words
 *  for every case here and must not fall back to this one. */
const SERVER_SENTENCE = "SERVER ENGLISH SENTENCE";

interface Fixture {
  /** What `GET /setup-api/clawkeep` answers, before and after the backup. */
  status: Record<string, unknown>;
  statusAfterBackup?: Record<string, unknown>;
  /** What `POST /setup-api/clawkeep/backup` answers. */
  backup?: { status: number; body: Record<string, unknown> };
  locale?: string;
}

function mount(fixture: Fixture) {
  let backedUp = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("preferences")) {
        return { ok: true, status: 200, json: async () => ({ ui_language: fixture.locale ?? "en" }) };
      }
      if (url.includes("/setup-api/clawkeep/backup")) {
        backedUp = true;
        const answer = fixture.backup ?? { status: 200, body: { ok: true, exitCode: 0 } };
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
      }
      if (url.includes("/setup-api/clawkeep")) {
        const status = backedUp && fixture.statusAfterBackup ? fixture.statusAfterBackup : fixture.status;
        return { ok: true, status: 200, json: async () => status };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
  return render(<I18nProvider><ClawKeepApp /></I18nProvider>);
}

const refusedStatus = (lastRefusal: unknown) => ({ ...BASE, lastHeartbeatStatus: "error", lastRefusal });

/** The card's reason, once it is words: `t()` answers the bare key until the
 *  catalogue has loaded, and the paragraph is on screen before that. */
async function shownReason(): Promise<string> {
  let text = "";
  await waitFor(() => {
    text = screen.getByTestId("clawkeep-refusal").textContent ?? "";
    expect(text).not.toMatch(/^clawkeep\./);
  }, { timeout: 5000 });
  return text;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the ClawKeep card, after a run nobody was watching was refused", () => {
  it("says what the backup needed and what is free, in sizes a person reads", async () => {
    mount({ status: refusedStatus(NO_ROOM) });

    expect(await shownReason()).toBe(
      "This backup needs 1.2 GB, but only 307 MB of your 5.0 GB of ClawKeep storage is free. "
      + "Nothing was uploaded and your earlier backups are untouched. "
      + "Delete snapshots you no longer need or upgrade the plan, then back up again.",
    );
    // No raw byte count anywhere on the page, and not the line that tells the
    // owner of a full account that one retry will fix it.
    expect(document.body.textContent).not.toMatch(/\d{7,}/);
    expect(document.body.textContent).not.toContain(GENERIC_LAPSED);
    expect(screen.getByText("Protection Lapsed")).toBeTruthy();
  }, 15_000);

  it("does not suggest deleting snapshots for a backup larger than the whole plan", async () => {
    mount({ status: refusedStatus(LARGER_THAN_PLAN) });

    const reason = await shownReason();
    expect(reason).toContain("This backup is 6.0 GB — more than your whole ClawKeep plan holds (5.0 GB).");
    expect(reason).toContain("Deleting snapshots won't make room for it; upgrade the plan");
    expect(reason).not.toContain("you no longer need");
  }, 15_000);

  it("says a plan with no storage holds nothing, rather than leaving the figure out", async () => {
    mount({ status: refusedStatus({ ...NO_ROOM, neededBytes: 2048, usedBytes: 0, quotaBytes: 0 }) });

    expect(await shownReason()).toContain(
      "This backup is 2.0 KB — more than your whole ClawKeep plan holds (0 B).",
    );
  }, 15_000);

  it("says usage could not be checked, and that the earlier backups are safe", async () => {
    mount({ status: refusedStatus(UNVERIFIED) });

    expect(await shownReason()).toBe(
      "ClawKeep couldn't check how much cloud storage is in use, so this backup wasn't uploaded. "
      + "Your earlier backups are untouched. Check the internet connection and try again.",
    );
  }, 15_000);

  it("keeps the generic line for a failure that recorded no refusal", async () => {
    mount({ status: refusedStatus(null) });

    expect(await screen.findByText(GENERIC_LAPSED, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByTestId("clawkeep-refusal")).toBeNull();
  }, 15_000);

  it("does not explain an error the box has moved on from", async () => {
    // The record outlives the status when something else stamps the heartbeat
    // (an idle ping). It is the reason beside "error", not a verdict.
    mount({ status: { ...BASE, lastHeartbeatStatus: "ok", lastRefusal: NO_ROOM } });

    expect(await screen.findByText("You're Protected", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByTestId("clawkeep-refusal")).toBeNull();
    expect(document.body.textContent).not.toContain("This backup needs");
  }, 15_000);

  it("says it in the owner's language, with the same sizes", async () => {
    mount({ status: refusedStatus(NO_ROOM), locale: "de" });

    await waitFor(() => {
      expect(screen.getByTestId("clawkeep-refusal").textContent).toBe(
        "Dieses Backup benötigt 1.2 GB, aber von Ihren 5.0 GB ClawKeep-Speicher sind nur 307 MB frei. "
        + "Es wurde nichts hochgeladen, und Ihre bisherigen Backups sind unverändert. "
        + "Löschen Sie Snapshots, die Sie nicht mehr brauchen, oder erweitern Sie den Tarif, "
        + "und sichern Sie dann erneut.",
      );
    }, { timeout: 5000 });
    expect(screen.getByText("Schutz abgelaufen")).toBeTruthy();
  }, 15_000);
});

describe("\"Back up now\", when the daemon turns the run away", () => {
  it("puts the sizes in the banner AND leaves them on the card once the banner is gone", async () => {
    mount({
      status: BASE,
      statusAfterBackup: refusedStatus(NO_ROOM),
      backup: {
        status: 507,
        body: { error: SERVER_SENTENCE, code: "quota_full", exitCode: 2, refusal: NO_ROOM },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }, { timeout: 5000 }));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "⚠️ This backup needs 1.2 GB, but only 307 MB of your 5.0 GB of ClawKeep storage is free.",
      );
    }, { timeout: 5000 });
    // The card caught up with the same run, so the reason does not leave the
    // screen with the banner at the next status poll.
    expect(screen.getByTestId("clawkeep-refusal").textContent).toContain("needs 1.2 GB");
    expect(document.body.textContent).not.toContain(SERVER_SENTENCE);
    expect(document.body.textContent).not.toMatch(/\d{7,}/);
  }, 15_000);

  it("keeps the plain out-of-space line when the portal refused and no sizes are known", async () => {
    mount({
      status: BASE,
      backup: { status: 507, body: { error: SERVER_SENTENCE, code: "quota_full", exitCode: 2 } },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }, { timeout: 5000 }));

    expect(await screen.findByText(
      /The ClawKeep account is out of space — free some snapshots or upgrade the plan\./, {}, { timeout: 5000 },
    )).toBeTruthy();
    expect(document.body.textContent).not.toContain(SERVER_SENTENCE);
  }, 15_000);

  it("says usage could not be checked, not that ClawKeep is unreachable", async () => {
    mount({
      status: BASE,
      backup: {
        status: 503,
        body: { error: SERVER_SENTENCE, code: "usage_unverified", exitCode: 6, refusal: UNVERIFIED },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }, { timeout: 5000 }));

    expect(await screen.findByText(
      /ClawKeep couldn't check how much cloud storage is in use, so this backup wasn't uploaded\./,
      {}, { timeout: 5000 },
    )).toBeTruthy();
    expect(document.body.textContent).not.toContain("Could not reach ClawKeep");
    expect(document.body.textContent).not.toContain(SERVER_SENTENCE);
  }, 15_000);

  it("says another backup is already running, not that this one failed", async () => {
    mount({
      status: BASE,
      backup: { status: 409, body: { error: SERVER_SENTENCE, code: "already_running", exitCode: 14 } },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }, { timeout: 5000 }));

    expect(await screen.findByText(
      /Another backup is already running\. Wait for it to finish, then try again\./, {}, { timeout: 5000 },
    )).toBeTruthy();
    expect(document.body.textContent).not.toContain("The backup did not finish");
    expect(document.body.textContent).not.toContain(SERVER_SENTENCE);
  }, 15_000);
});
