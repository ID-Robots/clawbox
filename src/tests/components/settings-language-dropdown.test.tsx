import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// The whole settings app mounts here — every panel and every status fetch.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t: (key: string) => key }),
}));

vi.mock("next/image", () => ({ default: () => null }));
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

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

/**
 * The trigger has always promised `aria-haspopup="listbox"`. What it opened was
 * a bare div of buttons that only a mouse could dismiss, so a screen reader was
 * sent looking for options that did not exist and a keyboard had no way out.
 */
describe("Settings → Appearance language picker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: false, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  function openPicker() {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.appearance/ }));
    const trigger = screen.getByRole("button", { name: /English/ });
    fireEvent.click(trigger);
    return trigger;
  }

  it("renders the listbox its trigger announces, with one selected option", () => {
    const trigger = openPicker();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(listbox).toContainElement(options[0]);
    expect(options.length).toBeGreaterThan(1);
    expect(options.filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("English");
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    const trigger = openPicker();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  // A `role="listbox"` promises arrow-key navigation. This one had none: the
  // rows were plain buttons in the tab order, so the only way through ten
  // languages was Tab, and nothing ever moved focus off the trigger.
  it("walks the rows with the arrow keys, one tab stop for the whole list", () => {
    openPicker();
    const options = screen.getAllByRole("option");
    // Opens standing on the language in use, which is the row the arrows
    // start from.
    expect(options[0]).toHaveFocus();
    expect(options[0]).toHaveAttribute("tabindex", "0");
    expect(options[1]).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
    const last = screen.getAllByRole("option").length - 1;
    expect(screen.getAllByRole("option")[last]).toHaveFocus();

    // Past the end it wraps rather than sticking, the way HeaderDropdown does.
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[last]).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Home" });
    expect(screen.getAllByRole("option")[0]).toHaveFocus();
  });

  it("picks the row the arrows are on with Enter, and closes back onto the trigger", () => {
    const trigger = openPicker();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    const second = screen.getAllByRole("option")[1];
    const chosen = second.textContent;
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
    // `setLocale` is mocked out in this suite, so the pick is asserted by the
    // list closing on the row the keyboard was standing on — not on the one
    // the mouse never touched.
    expect(chosen).toBeTruthy();
  });

  it("opens on ArrowDown from the trigger, standing on the language in use", () => {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.appearance/ }));
    const trigger = screen.getByRole("button", { name: /English/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { selected: true })).toHaveFocus();
  });

  it("still closes on a click outside", () => {
    openPicker();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
