import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * "What's in a backup" lives behind a question mark beside the title now,
 * not in a card of its own. Pinned: the list is off screen until asked for,
 * one click shows it with the credential warning, and Escape or a click
 * elsewhere puts it away.
 */

function status(over: Record<string, unknown> = {}) {
  return {
    supportedOnEdition: true,
    agent: "openclaw",
    paired: true,
    setupComplete: true,
    server: "https://clawbox.com",
    daemonInstalled: true,
    archiverInstalled: true,
    encryptionConfigured: true,
    backupContainsCredentials: true,
    lastBackupAtMs: 1_787_000_000_000,
    cloudBytes: 1024,
    snapshotCount: 2,
    schedule: { enabled: false, hour: 3, minute: 0 },
    nextRunAtMs: null,
    ...over,
  };
}

function stubFetch(over: Record<string, unknown> = {}) {
  const json = (body: unknown, code = 200) =>
    new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/clawkeep/memory")) return json({ supportedOnEdition: false });
    if (url.startsWith("/setup-api/clawkeep")) return json(status(over));
    return json({});
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("ClawKeep's backup contents", () => {
  it("stay behind the question mark until it is clicked, and close on Escape", async () => {
    stubFetch();
    render(<ClawKeepApp />);
    const toggle = await screen.findByTestId("clawkeep-contents-toggle");
    expect(screen.queryByTestId("clawkeep-contents-popover")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    const popover = await screen.findByTestId("clawkeep-contents-popover");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The per-edition list and the credential warning are what the owner
    // came to read.
    expect(popover.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(popover).toHaveTextContent("🔒");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("clawkeep-contents-popover")).not.toBeInTheDocument());
  });

  it("closes on a click anywhere else", async () => {
    stubFetch();
    render(<ClawKeepApp />);
    fireEvent.click(await screen.findByTestId("clawkeep-contents-toggle"));
    await screen.findByTestId("clawkeep-contents-popover");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("clawkeep-contents-popover")).not.toBeInTheDocument());
  });
});

/**
 * TASK-1301: the box's own backup archives are left out of every OpenClaw
 * snapshot, and the snapshot-sized archives a backup still carried are named
 * before the upload. Pinned: the rule is on the "Not included" line, what the
 * last run left out is said with its size, and the warning card lists what it
 * carried — and none of it is drawn when there is nothing to say.
 */
describe("what a backup leaves out, and what it carried", () => {
  // The catalogue arrives after the first paint, so every sentence is waited for.
  const app = () => render(<I18nProvider><ClawKeepApp /></I18nProvider>);
  const said = (id: string, text: string | RegExp) =>
    waitFor(() => expect(screen.getByTestId(id)).toHaveTextContent(text), { timeout: 5000 });

  it("lists the box's own backups under Not included", async () => {
    stubFetch();
    app();
    fireEvent.click(await screen.findByTestId("clawkeep-contents-toggle"));
    await said("clawkeep-contents-popover", /Not included:.*~\/\.openclaw\/backups/);
    expect(screen.getByTestId("clawkeep-contents-popover")).toHaveTextContent(/never contains older backups/);
    // Nothing was left out yet: no count to report.
    expect(screen.queryByTestId("clawkeep-contents-left-out")).not.toBeInTheDocument();
    expect(screen.queryByTestId("clawkeep-left-out")).not.toBeInTheDocument();
    expect(screen.queryByTestId("clawkeep-large-archives")).not.toBeInTheDocument();
  });

  it("says how much the last backup left out, on the card and in the popover", async () => {
    stubFetch({ leftOutCount: 8, leftOutBytes: 20 * 1024 ** 3 });
    app();
    await said(
      "clawkeep-left-out",
      "Left out of the last backup: 8 backup archive(s) kept on this box, 20.0 GB in all.",
    );
    expect(screen.getByTestId("clawkeep-left-out")).toHaveTextContent("untouched");

    fireEvent.click(screen.getByTestId("clawkeep-contents-toggle"));
    await said("clawkeep-contents-left-out", "The last backup left out 8 such file(s), 20.0 GB in all.");
  });

  it("warns about the snapshot-sized archives the last backup carried", async () => {
    stubFetch({
      largeArchives: [
        { path: "~/.openclaw/workspace/exports/dump.tar.gz", bytes: 1.9 * 1024 ** 3 },
        { path: "~/.openclaw/workspace/photos.zip", bytes: 300 * 1024 ** 2 },
      ],
      largeArchiveCount: 4,
      largeArchiveBytes: 3 * 1024 ** 3,
    });
    app();
    await said("clawkeep-large-archives", "The last backup carried 4 archive file(s), 3.0 GB in all");
    const card = screen.getByTestId("clawkeep-large-archives");
    expect(card).toHaveAttribute("role", "status");
    const rows = card.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("~/.openclaw/workspace/exports/dump.tar.gz");
    expect(rows[0]).toHaveTextContent("1.9 GB");
    expect(rows[1]).toHaveTextContent("300 MB");
    expect(card).toHaveTextContent("…and 2 more.");
    expect(card).toHaveTextContent(/into ~\/\.openclaw\/backups, which ClawKeep leaves out/);
  });
});
