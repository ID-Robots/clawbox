import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

/**
 * GitHub #1517: Settings showed the hotspot switch OFF while the box was still
 * broadcasting. The route reports the switch (`enabled`) and the radio
 * (`active`) separately; the card used to draw the radio's state only while
 * the switch was on, so "off" over a live AP looked like any other "off".
 */

// Mounts the whole settings app; on a loaded Jetson that alone eats most of the
// default 5 s budget (see settings-app.test.tsx).
vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

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

function json(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
}

/** What GET /setup-api/system/hotspot answers right now; a test moves it. */
let hotspot: { enabled: boolean; active: boolean; blockedBy?: string | null };
let hotspotPosts: Array<Record<string, unknown>>;
let hotspotGets: number;
/** Set: a stop the route answered for, after which the radio is still an AP. */
let stopLeavesApUp: boolean;
/** Set: each GET waits here (its answer fixed when it was asked) until released. */
let heldGets: Array<() => void> | null;

beforeEach(() => {
  hotspotPosts = [];
  hotspotGets = 0;
  stopLeavesApUp = false;
  heldGets = null;
  vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/setup-api/system/hotspot") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        hotspotPosts.push(body);
        // The route stopped the AP: the radio's next answer says so.
        if (body.enabled === false) hotspot = { enabled: false, active: stopLeavesApUp };
        else hotspot = { ...hotspot, enabled: true };
        return json({ success: true, apRestarted: false, apAction: body.enabled === false ? "stopped" : "deferred" });
      }
      hotspotGets++;
      const answer = { ssid: "ClawBox-Setup", hasPassword: true, blockedBy: null, ...hotspot };
      if (heldGets) {
        const held = heldGets;
        return new Promise<Response>((resolve) => {
          held.push(() => resolve({ ok: true, json: () => Promise.resolve(answer) } as Response));
        });
      }
      return json(answer);
    }
    if (url === "/setup-api/wifi/ethernet") return json({ connected: true, iface: "eth0" });
    if (url === "/setup-api/wifi/status") return json({ connected: false, ssid: null });
    if (url === "/setup-api/system/hostname") return json({ hostname: "clawbox", ipv4: "192.0.2.10" });
    if (url === "/setup-api/setup/status") return json({ setup_complete: true });
    return json({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openNetwork(container: HTMLElement) {
  const nav = container.querySelector("nav");
  if (!nav) throw new Error("desktop sidebar nav did not render");
  const network = [...nav.querySelectorAll(":scope > button")]
    .find((button) => (button.textContent ?? "").includes("settings.network"));
  if (!network) throw new Error("Network nav entry did not render");
  fireEvent.click(network);
}

const hotspotSwitch = () => screen.findByRole("switch", { name: "settings.hotspot" });

describe("Settings → Network: the hotspot card tells the radio's truth", () => {
  it("says so when the switch is off but the AP is still broadcasting, and stops it on request", async () => {
    hotspot = { enabled: false, active: true };
    const { container } = render(<SettingsApp ui={ui} />);
    openNetwork(container);

    const sw = await hotspotSwitch();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    const warning = await screen.findByTestId("hotspot-off-but-broadcasting");
    expect(warning).toHaveTextContent("still broadcasting");

    fireEvent.click(screen.getByRole("button", { name: "Stop it now" }));

    await waitFor(() => expect(hotspotPosts).toEqual([{ ssid: "ClawBox-Setup", enabled: false }]));
    // Read back from the radio, not assumed: the warning goes once it is down.
    await waitFor(() => expect(screen.queryByTestId("hotspot-off-but-broadcasting")).not.toBeInTheDocument());
  });

  it("an off switch over a quiet radio shows no warning", async () => {
    hotspot = { enabled: false, active: false };
    const { container } = render(<SettingsApp ui={ui} />);
    openNetwork(container);

    const sw = await hotspotSwitch();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    await waitFor(() => expect(hotspotGets).toBeGreaterThan(0));
    expect(screen.queryByTestId("hotspot-off-but-broadcasting")).not.toBeInTheDocument();
  });

  it("re-reads the radio after a toggle instead of trusting the switch it just set", async () => {
    hotspot = { enabled: true, active: true };
    const { container } = render(<SettingsApp ui={ui} />);
    openNetwork(container);

    const sw = await hotspotSwitch();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    const getsBefore = hotspotGets;

    fireEvent.click(sw);

    await waitFor(() => expect(hotspotPosts).toEqual([{ ssid: "ClawBox-Setup", enabled: false }]));
    await waitFor(() => expect(hotspotGets).toBeGreaterThan(getsBefore));
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByTestId("hotspot-off-but-broadcasting")).not.toBeInTheDocument();
  });

  it("shows the radio the re-read reports, not the stop the route answered, when the AP stays up", async () => {
    hotspot = { enabled: true, active: true };
    stopLeavesApUp = true;
    const { container } = render(<SettingsApp ui={ui} />);
    openNetwork(container);

    const sw = await hotspotSwitch();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    const getsBefore = hotspotGets;

    fireEvent.click(sw);

    await waitFor(() => expect(hotspotPosts).toEqual([{ ssid: "ClawBox-Setup", enabled: false }]));
    await waitFor(() => expect(hotspotGets).toBeGreaterThan(getsBefore));
    // The switch is saved off; the radio, read back, is still an AP.
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(await screen.findByTestId("hotspot-off-but-broadcasting")).toHaveTextContent("still broadcasting");
  });

  it("a re-read that answers after a newer one does not move the switch back", async () => {
    hotspot = { enabled: true, active: true };
    const { container } = render(<SettingsApp ui={ui} />);
    openNetwork(container);

    const sw = await hotspotSwitch();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    const held: Array<() => void> = [];
    heldGets = held;

    // Off: the re-read after it is still probing the radio...
    fireEvent.click(sw);
    await waitFor(() => expect(held).toHaveLength(1));
    await waitFor(() => expect(sw).not.toBeDisabled());
    // ...when the owner switches it on again.
    fireEvent.click(sw);
    await waitFor(() => expect(held).toHaveLength(2));
    expect(hotspotPosts).toEqual([
      { ssid: "ClawBox-Setup", enabled: false },
      { ssid: "ClawBox-Setup", enabled: true },
    ]);

    held[1]();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    // The older read ("off") lands last.
    held[0]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});
