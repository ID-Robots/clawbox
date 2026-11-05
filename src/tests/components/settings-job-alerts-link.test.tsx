import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { resetHarnessCache } from "@/lib/client-harness";
import { OPEN_JOB_ALERTS_SETTINGS } from "@/lib/notify-action";
import { dispatchOpenSettingsSection } from "@/lib/ui-events";

// The scheduled-job alert's desktop notice says "Open Settings → Harness".
// The Scheduled job alerts card sits under the harness tiles and four other
// panels — below the fold of a desktop window — so the click has to land on
// Harness AND bring that card into view, from an open Settings window and
// from a cold one alike, and only when a notice asked.

vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => <img alt="" {...props} /> }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));

const defaultUi: UISettings = {
  wallpaperId: "default",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 100,
  mascotHidden: false,
  wallpapers: [{ id: "default", name: "Default" }],
  customWallpapers: [],
  onWallpaperChange: vi.fn(),
  onWpFitChange: vi.fn(),
  onWpBgColorChange: vi.fn(),
  onWpOpacityChange: vi.fn(),
  onMascotToggle: vi.fn(),
  onWallpaperUpload: vi.fn(),
  onCustomWallpaperDelete: vi.fn(),
};

const JOB_ALERTS = {
  enabled: true,
  off: null,
  runtime: "openclaw",
  reachable: true,
  checkedAt: Date.now(),
  watched: 2,
  problems: [{ id: "j1", name: "Daily sales report", problem: "failing", count: 2, since: Date.now(), error: "command exited with code 1" }],
};

type PendingWindow = Window & { __clawboxPendingSettingsSection?: unknown; __clawboxPendingSettingsFocus?: unknown };

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

beforeEach(() => {
  resetHarnessCache();
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url.startsWith("/setup-api/job-alerts")) return jsonResponse(JOB_ALERTS);
    if (url.startsWith("/setup-api/harness/active")) return jsonResponse({ edition: "openclaw", active: "openclaw" });
    if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
    return jsonResponse({});
  }));
});

describe("Settings → Harness: the job alert's notice lands on the Scheduled job alerts card", () => {
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  let scrolled: Element[] = [];

  beforeEach(() => {
    scrolled = [];
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(this: Element) { scrolled.push(this); },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
    delete (window as PendingWindow).__clawboxPendingSettingsSection;
    delete (window as PendingWindow).__clawboxPendingSettingsFocus;
  });

  it("an open Settings window goes to Harness and scrolls to the card", async () => {
    render(<SettingsApp ui={defaultUi} />);
    act(() => { dispatchOpenSettingsSection(OPEN_JOB_ALERTS_SETTINGS.section, OPEN_JOB_ALERTS_SETTINGS.focus); });

    expect(await screen.findByTestId("settings-harness-page")).toBeInTheDocument();
    const card = await screen.findByTestId("settings-job-alerts");
    await waitFor(() => expect(scrolled).toContain(card));
    expect((window as PendingWindow).__clawboxPendingSettingsFocus).toBeUndefined();
  });

  it("a COLD open does the same, from the handoff the notice left on window", async () => {
    (window as PendingWindow).__clawboxPendingSettingsSection = "harness";
    (window as PendingWindow).__clawboxPendingSettingsFocus = "jobAlerts";
    render(<SettingsApp ui={defaultUi} />);

    const card = await screen.findByTestId("settings-job-alerts");
    await waitFor(() => expect(scrolled).toContain(card));
  });

  it("a plain link to Harness opens it at the top: no scroll to the card", async () => {
    render(<SettingsApp ui={defaultUi} />);
    act(() => { dispatchOpenSettingsSection("harness"); });

    const card = await screen.findByTestId("settings-job-alerts");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(scrolled).not.toContain(card);
  });
});
