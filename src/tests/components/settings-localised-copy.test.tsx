import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// The whole settings app mounts here — every panel and every status fetch —
// which on a loaded Jetson eats most of the default budget before the first
// assertion runs. Same ceiling as the neighbouring SettingsApp suites.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// One mutable pack, so the same mounted app can be asked both questions: does
// the copy come from the locale pack at all, and what does it fall back to when
// the pack has not been given these keys yet. `vi.hoisted` because the mock
// factory below is hoisted above every import in this file.
const pack = vi.hoisted(() => ({ strings: {} as Record<string, string> }));

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string) => pack.strings[key] ?? key,
  }),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));

// The provider panel is a screen of its own with its own edition probe; what
// this file is asking is only what Settings HANDS it.
vi.mock("@/components/AIModelsStep", () => ({
  default: ({ title, description }: { title?: string; description?: string }) => (
    <div data-testid="ai-models-step">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
}));

/** German for every string the sweep found rendered as an English literal. */
const GERMAN: Record<string, string> = {
  "settings.appearance": "Erscheinungsbild",
  "settings.providers": "Anbieter",
  "settings.network": "Netzwerk",
  "settings.systemUpdate": "Systemaktualisierung",
  "settings.connected": "Verbunden",
  "settings.aiConnectTitle": "KI-Anbieter verbinden",
  "settings.aiConnectDesc": "Wähle den KI-Dienst, den dein Assistent täglich nutzen soll",
  "settings.wired": "Kabelgebunden",
  "settings.accessDeviceAt": "Dieses Gerät erreichen unter",
  "settings.copyUrl": "URL kopieren",
  "settings.mdnsHint": "{url} funktioniert auch in Netzwerken mit mDNS. Die IP kann sich ändern.",
  "copy": "Kopieren",
  "copied": "Kopiert!",
};

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

describe("Settings copy comes from the locale pack", () => {
  beforeEach(() => {
    pack.strings = GERMAN;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url === "/setup-api/system/hostname") return jsonResponse({ hostname: "clawbox", ipv4: "192.168.1.50" });
      if (url === "/setup-api/wifi/ethernet") return jsonResponse({ connected: true, iface: "eth0" });
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: false, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url.startsWith("/setup-api/update/versions")) {
        return jsonResponse({ clawbox: { current: "v1.0.0", target: null }, openclaw: { current: "1.0.0", target: null } });
      }
      if (url === "/setup-api/system/update-branch") return jsonResponse({ branch: "" });
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness: "openclaw", defaultProvider: null, degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("localises the Connect AI Provider card's heading and subtitle", async () => {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(GERMAN["settings.providers"]) }));

    const panel = await screen.findByTestId("ai-models-step");
    expect(panel).toHaveTextContent(GERMAN["settings.aiConnectTitle"]);
    expect(panel).toHaveTextContent(GERMAN["settings.aiConnectDesc"]);
    expect(panel).not.toHaveTextContent("Connect AI Provider");
  });

  it("localises the network card's status, address label, copy button and mDNS note", async () => {
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(GERMAN["settings.network"]) }));

    expect(await screen.findByText(`${GERMAN["settings.wired"]} · ${GERMAN["settings.connected"]}`)).toBeInTheDocument();
    expect(screen.getByText(GERMAN["settings.accessDeviceAt"])).toBeInTheDocument();

    const copy = screen.getByRole("button", { name: GERMAN["settings.copyUrl"] });
    expect(copy).toHaveTextContent(GERMAN["copy"]);

    // The address keeps its own monospace element: the sentence is split at the
    // slot rather than flattened into one translated string.
    const hint = screen.getByText(/funktioniert auch in Netzwerken/);
    expect(hint).toHaveTextContent("clawbox.local funktioniert auch in Netzwerken mit mDNS. Die IP kann sich ändern.");
    expect(hint.querySelector(".font-mono")).toHaveTextContent("clawbox.local");
  });

  it("keeps the section label readable rather than clipping it to an ellipsis", async () => {
    render(<SettingsApp ui={defaultUi} />);
    const nav = await screen.findByRole("navigation");
    const update = Array.from(nav.querySelectorAll("button"))
      .find((button) => button.textContent?.includes(GERMAN["settings.systemUpdate"]));
    const label = update?.querySelector("span.flex-1");

    // jsdom has no layout, so the class is the assertion: `truncate` is what cut
    // "Systemaktualisierung" to "Systemaktualisier…" in the 240px rail.
    expect(label?.className).not.toContain("truncate");
    expect(label?.className).toContain("break-words");
  });

  it("falls back to English, never to the raw key, for a string the pack has not caught up with", async () => {
    // An empty pack is what a locale that has not been given these keys yet
    // looks like: `t` answers with the key itself.
    pack.strings = {};
    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.providers/ }));

    const panel = await screen.findByTestId("ai-models-step");
    expect(panel).toHaveTextContent("Connect AI Provider");
    expect(panel).not.toHaveTextContent("settings.aiConnectTitle");
  });
});
