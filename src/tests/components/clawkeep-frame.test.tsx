import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * ClawKeep's window frame — the Coding Agent's: one header row that names the
 * app and says whether the box is paired, with Portal and Unpair beside it
 * once it is, and the cards below. The memory index moved out to the Memory
 * Shard app, and the pointer card that used to say so is gone too: the app
 * has its own icon on the desktop, and a card whose only job was to open a
 * different window was the one thing in ClawKeep that was not about backups.
 */

const BASE_STATUS = {
  paired: false,
  configured: false,
  server: "https://portal.example",
  lastBackupAtMs: 0,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 0 },
  nextRunAtMs: 0,
};

let status: Record<string, unknown> = { ...BASE_STATUS };
let urls: string[] = [];

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes("/setup-api/clawkeep")) return ok(status);
    return ok({});
  }));
}

describe("ClawKeep's frame", () => {
  beforeEach(() => {
    status = { ...BASE_STATUS };
    urls = [];
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("leads with the app's name and an unpaired pill, and one Pair button below", async () => {
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    expect(await screen.findByRole("button", { name: "Pair with portal" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "ClawKeep" })).toBeTruthy();
    expect(screen.getByTestId("clawkeep-state").textContent).toBe("Not paired");
    // Nothing to leave or open until the box is paired.
    expect(screen.queryByRole("link", { name: /Portal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpair" })).toBeNull();
  });

  it("puts Portal and Unpair in the header once paired, not as full-width buttons between the cards", async () => {
    status = { ...BASE_STATUS, paired: true, configured: true, lastBackupAtMs: Date.now() - 3_600_000, cloudBytes: 1024, snapshotCount: 2 };
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    expect(await screen.findByRole("button", { name: "Back up now" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTestId("clawkeep-state").textContent).toBe("Paired");
    const header = screen.getByRole("heading", { level: 1, name: "ClawKeep" }).parentElement!.parentElement!;
    const portal = within(header).getByRole("link", { name: /Portal/ });
    expect(portal.getAttribute("href")).toBe("https://portal.example/portal/clawkeep");
    expect(portal.getAttribute("target")).toBe("_blank");
    expect(within(header).getByRole("button", { name: "Unpair" })).toBeTruthy();
  });

  it("no longer points at Memory Shard, nor probes the memory index", async () => {
    // The status probe shells out to the OpenClaw CLI and can hold a request
    // for up to 90 s on a cache miss. Two windows polling it would be two
    // probes competing with the indexer on an 8 GB box.
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    await screen.findByRole("button", { name: "Pair with portal" }, { timeout: 5000 });
    expect(screen.queryByText(/Memory Shard/)).toBeNull();
    expect(screen.queryByTestId("clawkeep-memory-shard-card")).toBeNull();
    expect(urls.some((u) => u.includes("/setup-api/clawkeep/memory"))).toBe(false);
  });
});
