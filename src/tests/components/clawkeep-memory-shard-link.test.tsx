import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";
import { OPEN_APP_EVENT } from "@/lib/ui-events";

/**
 * The memory index moved out of ClawKeep into the Memory Shard app. What
 * ClawKeep owes the owner now is the way there: the card people learned to
 * look for still sits in the window, and its one button opens the new app.
 */

const BASE_STATUS = {
  paired: false,
  configured: false,
  server: "https://portal.example",
  lastBackupAtMs: 0,
  openclawInstalled: true,
  daemonInstalled: true,
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

describe("ClawKeep's pointer to Memory Shard", () => {
  beforeEach(() => {
    status = { ...BASE_STATUS };
    urls = [];
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("says where memory search went and opens it in one click", async () => {
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    expect(await screen.findByText(/Memory search lives in Memory Shard\./, {}, { timeout: 5000 })).toBeTruthy();
    const opened: string[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent<{ appId: string }>).detail.appId);
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open Memory Shard" }));
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, onOpen);
    }
    expect(opened).toEqual(["memory-shard"]);
  });

  it("no longer probes the memory index itself — that is the new app's job", async () => {
    // The status probe shells out to the OpenClaw CLI and can hold a request
    // for up to 90 s on a cache miss. Two windows polling it would be two
    // probes competing with the indexer on an 8 GB box.
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    await screen.findByTestId("clawkeep-memory-shard-card", {}, { timeout: 5000 });
    expect(urls.some((u) => u.includes("/setup-api/clawkeep/memory"))).toBe(false);
  });

  it("does not point at an app the box cannot show", async () => {
    // Memory Shard is OpenClaw's index; on a box without that CLI the desktop
    // hides the app, and a button that opens nothing is worse than no button.
    status = { ...BASE_STATUS, openclawInstalled: false, archiverReady: true };
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    expect(await screen.findByRole("button", { name: "Pair with portal" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByTestId("clawkeep-memory-shard-card")).toBeNull();
  });

  it("does not point at the app while Hermes runs the box, even with the openclaw CLI installed", async () => {
    // The desktop hides Memory Shard by ACTIVE harness (OPENCLAW_ONLY_APP_IDS),
    // not by which CLIs happen to be on disk. A box that switched to Hermes
    // keeps the openclaw binary, so gating on the CLI alone would render a
    // button whose openApp() silently returns because the id was filtered out.
    status = { ...BASE_STATUS, openclawInstalled: true, agent: "hermes", archiverReady: true };
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    expect(await screen.findByRole("button", { name: "Pair with portal" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByTestId("clawkeep-memory-shard-card")).toBeNull();
  });
});
