import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

/**
 * Settings → Monitors is only on a box that HAS a monitor session. Every other
 * box — the Jetson product, and any box without a kiosk — answers
 * `/setup-api/monitors` with `{ available: false }`, and there the Settings
 * sidebar must look exactly as it did before monitor mode existed.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/i18n", () => {
  // Stable across renders, like the real provider's.
  const ctx = { t: (key: string) => key, locale: "en", localeResolved: true, setLocale: () => {} };
  return {
    LANGUAGES: [{ code: "en", name: "English" }],
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useT: () => ctx,
  };
});

vi.mock("next/image", () => ({ default: () => null }));

const ui: UISettings = {
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

const MONITOR = {
  id: "AOC|Q27B3MA|17ZP6HA000848",
  name: "HDMI-A-1",
  label: "AOC Q27B3MA",
  builtIn: false,
  enabled: true,
  modes: [{ width: 2560, height: 1440, refresh: 59.951, preferred: true }],
  current: { width: 2560, height: 1440, refresh: 59.951 },
  scale: 1,
  transform: "normal",
  rect: { x: 0, y: 0, width: 2560, height: 1440 },
  physicalSize: { width: 600, height: 340 },
  adaptiveSync: null,
};
const AVAILABLE = {
  available: true,
  monitors: [MONITOR],
  order: [MONITOR.id],
  main: MONITOR.id,
  box: { width: 2560, height: 1440 },
  pending: null,
  mirror: false,
};
const UNAVAILABLE = { available: false, monitors: [], order: [], main: null, box: null, pending: null, mirror: false };

type MonitorsAnswer = { ok: boolean; status: number; body: unknown } | "reject";

function installFetch(monitors: MonitorsAnswer) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url === "/setup-api/monitors") {
      if (monitors === "reject") throw new TypeError("Failed to fetch");
      return { ok: monitors.ok, status: monitors.status, json: async () => monitors.body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The sidebar row "Monitors" (its label span's own text is the key). */
const navRow = (key: string) =>
  screen.queryAllByText(key, { exact: true }).map((el) => el.closest("button")).find((b) => b !== null) ?? null;
const monitorsRow = () => navRow("settings.monitors");

async function mountAndAsk(fetchMock: ReturnType<typeof installFetch>) {
  render(<SettingsApp ui={ui} />);
  // The sidebar is up…
  await waitFor(() => expect(navRow("settings.appearance")).not.toBeNull());
  // …and the monitors question has been asked and answered.
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/setup-api/monitors")).toBe(true));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

type PendingSlot = Window & { __clawboxPendingSettingsSection?: unknown };

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as PendingSlot).__clawboxPendingSettingsSection;
});

/** The open pane's name: the sr-only heading the sidebar's label key names. */
const paneTitle = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("SettingsApp — the Monitors row", () => {
  it("is hidden on a box whose /setup-api/monitors answers available:false", async () => {
    const fetchMock = installFetch({ ok: true, status: 200, body: UNAVAILABLE });
    await mountAndAsk(fetchMock);
    expect(monitorsRow()).toBeNull();
    // The rest of the sidebar is untouched.
    expect(navRow("settings.appearance")).not.toBeNull();
    expect(navRow("settings.about")).not.toBeNull();
  });

  it("is hidden when the question cannot be answered (an error status, or no answer at all)", async () => {
    const refused = installFetch({ ok: false, status: 401, body: { error: "Unauthorized" } });
    await mountAndAsk(refused);
    expect(monitorsRow()).toBeNull();
  });

  it("is hidden when the request itself fails", async () => {
    const failed = installFetch("reject");
    await mountAndAsk(failed);
    expect(monitorsRow()).toBeNull();
  });

  it("appears on a box with a monitor session, and opens the Monitors panel", async () => {
    const fetchMock = installFetch({ ok: true, status: 200, body: AVAILABLE });
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(monitorsRow()).not.toBeNull());

    fireEvent.click(monitorsRow()!);
    expect(await screen.findByTestId("monitors-panel")).toBeInTheDocument();
    expect(screen.getByTestId("monitors-block-1")).toHaveAttribute("data-monitor-id", MONITOR.id);
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/setup-api/monitors").length).toBeGreaterThanOrEqual(2);
  });
});

// A deep link to the Monitors pane (`/app/settings?section=monitors`, or any
// open-settings-section event) on a box with no monitor session used to open a
// pane titled "Monitors" that said there were none, with no sidebar row lit —
// on the Jetson, where Settings had always ignored the value.
describe("SettingsApp — a deep link to Monitors", () => {
  it("is ignored on a box without a monitor session: Settings opens where it always did", async () => {
    (window as PendingSlot).__clawboxPendingSettingsSection = "monitors";
    const fetchMock = installFetch({ ok: true, status: 200, body: UNAVAILABLE });
    await mountAndAsk(fetchMock);

    expect(paneTitle()).toContain("settings.appearance");
    expect(paneTitle()).not.toContain("settings.monitors");
    expect(screen.queryByTestId("monitors-panel")).toBeNull();
    expect(screen.queryByTestId("monitors-unavailable")).toBeNull();
    expect(screen.queryByTestId("monitors-loading")).toBeNull();
    // Only the sidebar's own question was asked; no Monitors pane asked again.
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/setup-api/monitors")).toHaveLength(1);
  });

  it("is ignored when the question cannot be answered", async () => {
    (window as PendingSlot).__clawboxPendingSettingsSection = "monitors";
    const failed = installFetch("reject");
    await mountAndAsk(failed);
    expect(paneTitle()).toContain("settings.appearance");
    expect(screen.queryByTestId("monitors-unavailable")).toBeNull();
  });

  it("an open-settings-section event for Monitors is ignored there too", async () => {
    const fetchMock = installFetch({ ok: true, status: 200, body: UNAVAILABLE });
    await mountAndAsk(fetchMock);
    act(() => {
      window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "monitors" } }));
    });
    expect(paneTitle()).toContain("settings.appearance");
    expect(screen.queryByTestId("monitors-unavailable")).toBeNull();
  });

  it("opens the Monitors pane on a box with a monitor session, once it has answered", async () => {
    (window as PendingSlot).__clawboxPendingSettingsSection = "monitors";
    installFetch({ ok: true, status: 200, body: AVAILABLE });
    render(<SettingsApp ui={ui} />);
    expect(await screen.findByTestId("monitors-panel")).toBeInTheDocument();
    expect(paneTitle()).toContain("settings.monitors");
  });

  it("a waiting Monitors link gives way to a later link or a click elsewhere", async () => {
    // The answer is slow; meanwhile the owner goes somewhere else. When the
    // box says yes it must not drag Settings to Monitors.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (input.toString() === "/setup-api/monitors") {
        await gate;
        return { ok: true, status: 200, json: async () => AVAILABLE };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    (window as PendingSlot).__clawboxPendingSettingsSection = "monitors";
    render(<SettingsApp ui={ui} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "wifi" } }));
    });
    await act(async () => { release?.(); await gate; });
    await waitFor(() => expect(monitorsRow()).not.toBeNull());
    expect(screen.queryByTestId("monitors-panel")).toBeNull();
    expect(paneTitle()).toContain("settings.network");
  });

  it("an event for Monitors after the box has answered yes opens it at once", async () => {
    const fetchMock = installFetch({ ok: true, status: 200, body: AVAILABLE });
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(monitorsRow()).not.toBeNull());
    expect(screen.queryByTestId("monitors-panel")).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "monitors" } }));
    });
    expect(await screen.findByTestId("monitors-panel")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });
});
