import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { resetHarnessCache } from "@/lib/client-harness";

// The whole settings app mounts here — every panel and every status fetch.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Keys stand in for copy, the way the neighbouring settings a11y suite does it:
// this file is about the STRUCTURE of the page, not about which words fill it.
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t: (key: string) => key }),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));

const GiB = 1024 ** 3;

/** The caption class on beta, byte for byte: promoting the tag must not touch it. */
const CAPTION_CLASS = "text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest";

const ui: UISettings = {
  wallpaperId: "hermes",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 50,
  mascotHidden: false,
  wallpapers: [{ id: "hermes", name: "Hermes" }],
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

const STATS = {
  overview: { hostname: "clawbox", os: "Ubuntu", kernel: "5.15", uptime: "1h", arch: "arm64", platform: "linux" },
  cpu: { usage: 12, model: "ARMv8", cores: 6, loadAvg: ["1.0", "1.0", "1.0"], speed: 1800, perCore: [9, 8, 7, 6, 5, 4] },
  memory: { total: 7.4 * GiB, used: 5.8 * GiB, free: 1.6 * GiB, usedPercent: 78, swap: { used: 0, total: 0, percent: 0 } },
  temperature: { value: 56.1, display: "56.1°C" },
  gpu: { usage: 0 },
  storage: [],
  network: [],
  processes: [],
  timestamp: Date.now(),
};

/**
 * Settings, read by a screen reader that navigates by heading and by landmark.
 *
 * HL-7, measured on beta 8140fb46: four panels enumerated 0 `h2`, 0 `h3` and no
 * `main` at all — every visible section title ("WALLPAPER", "STATUS", "PER
 * CORE", "RESOURCES") is a `<label>` carrying a style, and a `<label>` with no
 * `for` and no wrapped control is inert to assistive technology. The result is
 * one flat run of text with nothing to jump between, and no landmark to skip to.
 *
 * What the page owes its reader, asserted below: one `h2` naming the panel that
 * is open, the cards' captions as `h3`, the panel region as a landmark — `main`
 * where Settings is the whole page, a NAMED REGION where it is one window on a
 * desktop that mounts six other apps with an `h1` each — the sidebar as a `nav`
 * whose current row says so, never a second `h1` from a pane Settings embeds,
 * and the captions' class strings untouched, because this is a structural fix
 * that must not move a pixel.
 */
describe("Settings exposes a heading structure and a landmark", () => {
  function serve(harness: "openclaw" | "hermes" = "openclaw") {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
      const url = String(input ?? "");
      if (url === "/setup-api/system/stats") return jsonResponse(STATS);
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: false, ssid: null });
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url.startsWith("/setup-api/update/versions")) {
        return jsonResponse({ clawbox: { current: "v1.0.0", target: null }, openclaw: { current: "1.0.0", target: null } });
      }
      if (url === "/setup-api/ai-models/status") return jsonResponse({ connected: false, provider: null, providerLabel: null, mode: null, model: null });
      if (url === "/setup-api/providers/status") return jsonResponse({ harness, defaultProvider: null, degraded: false, providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: true });
      if (url === "/setup-api/harness/active") return jsonResponse({ active: harness, edition: harness, activeKnown: true });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      return jsonResponse({});
    }));
  }

  beforeEach(() => {
    // The edition is cached for the document's lifetime, and a module cache
    // outlives a test: without this seam the Hermes case below would be served
    // the `openclaw` the earlier cases cached and would never render the pane
    // it exists to check.
    resetHarnessCache();
    serve();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  function openSection(section: string, { asPage = false } = {}) {
    render(<SettingsApp ui={ui} asPage={asPage} />);
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section } }));
  }

  /** The panel region, whichever landmark this instance is entitled to. */
  function findPanel(asPage: boolean, name: string) {
    return asPage
      ? screen.findByRole("main")
      : screen.findByRole("region", { name });
  }

  // The four panels the sweep measured, each with a card caption that must read
  // as a heading. `ai` is the one that already had an h1 — AIModelsStep's, drawn
  // embedded — and still owed its reader the panel's own name.
  const PANELS = [
    { section: "appearance", titleKey: "settings.appearance", captionKey: "settings.wallpaper" },
    { section: "ai", titleKey: "settings.providers", captionKey: "settings.providers.title" },
    { section: "system", titleKey: "settings.system", captionKey: "settings.device" },
    { section: "telegram", titleKey: "settings.telegram", captionKey: "settings.status" },
  ] as const;

  for (const panel of PANELS) {
    it(`names the ${panel.section} panel with an h2 over h3 section titles, and claims no h1`, async () => {
      openSection(panel.section);

      const region = await findPanel(false, panel.titleKey);
      expect(within(region).getByRole("heading", { level: 2, name: panel.titleKey })).toBeInTheDocument();
      // Awaited: the System panel draws its cards only once the figures land.
      expect(await within(region).findByRole("heading", { level: 3, name: panel.captionKey })).toBeInTheDocument();
      // A window is not the document's title. Counted on EVERY panel, because
      // the h1 that has to stay down is in a pane Settings embeds — the
      // Providers title, the System Update hero — not in Settings itself.
      expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    });
  }

  it("gives the standalone page one h1 — its own title — and a main landmark", async () => {
    openSection("appearance", { asPage: true });
    const main = await findPanel(true, "settings.title");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("settings.title");
    expect(within(main).getByRole("heading", { level: 2, name: "settings.appearance" })).toBeInTheDocument();
  });

  // Named rather than counted, so the case cannot pass on a panel that only
  // rendered a skeleton: this title is AIModelsStep's, drawn embedded, and it is
  // the `h1` the Providers panel carried on beta.
  it("demotes the embedded Providers title under the panel's own name", async () => {
    openSection("ai");
    const region = await findPanel(false, "settings.providers");
    expect(await within(region).findByRole("heading", { level: 2, name: "Connect AI Provider" })).toBeInTheDocument();
  });

  // Settings → System Update draws SystemUpdateApp inside this window, and that
  // pane opens on an <h1> of its own wherever it is the window itself.
  it("keeps the embedded System Update hero out of the document's h1", async () => {
    openSection("update");
    await findPanel(false, "settings.systemUpdate");
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  // The same pane on the other edition: Providers renders HermesProviderConfig
  // there, whose title is the h1 on a Hermes box's Providers panel.
  it("keeps the Providers title out of the document's h1 on a Hermes box", async () => {
    serve("hermes");
    openSection("ai");
    const region = await findPanel(false, "settings.providers");
    expect(within(region).getByRole("heading", { level: 2, name: "settings.providers" })).toBeInTheDocument();
    // Named, so this cannot pass on a box that quietly rendered the OpenClaw
    // pane instead: the title below belongs to HermesProviderConfig alone.
    expect(await within(region).findByRole("heading", { level: 2, name: "hermesProvider.title" })).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("marks the open section in the sidebar as the current one", async () => {
    openSection("system");
    await findPanel(false, "settings.system");
    const sidebar = screen.getByRole("navigation", { name: "settings.title" });
    const current = within(sidebar).getAllByRole("button").filter(b => b.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("settings.system");
  });

  // The whole point of promoting a caption rather than restyling one: the class
  // string is what paints it, so it has to survive the tag change byte for byte.
  // A deliberate restyle updates this line and says so in its own diff.
  it("promotes the caption without changing a single class", async () => {
    openSection("appearance");
    const region = await findPanel(false, "settings.appearance");
    const caption = within(region).getAllByRole("heading", { level: 3 }).find(h => h.textContent === "settings.wallpaper");
    expect(caption?.className).toBe(CAPTION_CLASS);
  });
});
