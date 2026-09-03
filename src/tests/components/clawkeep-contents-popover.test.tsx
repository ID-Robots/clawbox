import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";

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

function stubFetch() {
  const json = (body: unknown, code = 200) =>
    new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/clawkeep/memory")) return json({ supportedOnEdition: false });
    if (url.startsWith("/setup-api/clawkeep")) return json(status());
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
