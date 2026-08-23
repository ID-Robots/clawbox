import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

// Every test in this file mounts the WHOLE settings app — every panel, every
// status fetch, and now the pet picker as well. On a Jetson under full-suite
// load that mount alone eats most of the default 5 s budget, so these tests
// were failing on the clock rather than on an assertion. The work is real and
// the assertions are cheap; the budget is what was wrong.
vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("next/image", () => ({
  default: () => null,
}));

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

const statsResponse = {
  overview: {
    hostname: "clawbox-test",
    os: "TestOS",
    kernel: "6.8.0",
    uptime: "1h",
    arch: "arm64",
    platform: "linux",
  },
  cpu: {
    usage: 12,
    model: "Test CPU",
    cores: 4,
    loadAvg: ["0.10", "0.12", "0.14"],
    speed: 1800,
  },
  memory: {
    total: 8 * 1024 * 1024 * 1024,
    used: 2 * 1024 * 1024 * 1024,
    free: 6 * 1024 * 1024 * 1024,
    usedPercent: 25,
    swap: {
      used: 0,
      total: 0,
      percent: 0,
    },
  },
  temperature: {
    value: 42,
    display: "42C",
  },
  gpu: {
    usage: 0,
  },
  storage: [],
  network: [],
  processes: [],
  timestamp: Date.now(),
};

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

describe("SettingsApp factory reset overlay", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url === "/setup-api/preferences" && init?.method === "POST") return jsonResponse({ ok: true });
      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
      if (url === "/setup-api/update/versions") {
        return jsonResponse({
          clawbox: { current: "v1.0.0", target: null },
          openclaw: { current: "v1.0.0", target: null },
        });
      }
      if (url === "/setup-api/system/update-branch") return jsonResponse({ branch: "" });
      if (url === "/setup-api/wifi/status") return jsonResponse({ connected: false, ssid: null });
      if (url === "/setup-api/system/hotspot") return jsonResponse({ enabled: true, ssid: "ClawBox-Setup" });
      if (url === "/setup-api/ai-models/status") {
        return jsonResponse({
          connected: false,
          provider: null,
          providerLabel: null,
          mode: null,
          model: null,
        });
      }
      if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: false });
      if (url === "/setup-api/llamacpp/status") return jsonResponse({ installed: false });
      if (url === "/setup-api/ollama/status") return jsonResponse({ installed: false });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      if (url === "/setup-api/setup/reset") return jsonResponse({ ok: true });

      return jsonResponse({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the factory reset loading screen in a portal with progress steps", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    const { container } = render(<SettingsApp ui={defaultUi} />, { container: root });

    fireEvent.click(screen.getByRole("button", { name: /settings\.about$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /factoryReset/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.reset" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/setup/reset", { method: "POST" });
    });

    const overlay = await screen.findByRole("status");
    expect(overlay).toBeInTheDocument();
    expect(document.body).toContainElement(overlay);
    expect(container).not.toContainElement(overlay);
    expect(within(overlay).getAllByText("settings.erasingSettings")).toHaveLength(2);
    expect(within(overlay).getByText("settings.waitingOnline")).toBeInTheDocument();
    expect(within(overlay).getByText("settings.startingSetup")).toBeInTheDocument();
  });

  it("kicks off the ClawBox AI device-auth handshake when the desktop deep-link event is fired", async () => {
    const pendingWindow = window as Window & {
      __clawboxPendingSettingsSection?: string;
      __clawboxPendingClawAiOffer?: boolean;
    };
    pendingWindow.__clawboxPendingSettingsSection = "ai";
    pendingWindow.__clawboxPendingClawAiOffer = true;

    render(<SettingsApp ui={defaultUi} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/setup-api/ai-models/clawai/start",
        expect.objectContaining({ method: "POST" }),
      );
    });
    // The legacy "Paste your token here" dialog has been retired in
    // favour of the device-code flow; assert it stays gone so a
    // regression that re-mounts it would fail loudly here.
    expect(screen.queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();
  });

  it("selects ClawBox AI when the desktop provider deep-link is fired", async () => {
    const pendingWindow = window as Window & {
      __clawboxPendingSettingsSection?: string;
      __clawboxPendingAiProvider?: string;
    };
    pendingWindow.__clawboxPendingSettingsSection = "ai";
    pendingWindow.__clawboxPendingAiProvider = "clawai";

    render(<SettingsApp ui={defaultUi} />);

    const providerRadio = await screen.findByRole("radio", { name: /ClawBox AI/i });
    expect(providerRadio).toBeChecked();
  });

});

/**
 * The regenerate endpoint shipped with no caller: nothing in the UI, the CLI
 * or the MCP surface ever POSTed to it, so the on-device generator could only
 * be triggered by the cache ageing out on its own. These cover the button that
 * now calls it, and — the part that matters — that its refusals do not all
 * read as "your chat is using the model".
 */
describe("SettingsApp mascot phrase refresh", () => {
  let regenerateResponse: { ok: boolean; body: unknown };

  beforeEach(() => {
    regenerateResponse = {
      ok: true,
      body: { ok: true, phrases: {}, meta: { source: "local", reason: "generated", locale: "en" } },
    };
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/mascot-lines/regenerate") && init?.method === "POST") {
        return Promise.resolve({
          ok: regenerateResponse.ok,
          json: () => Promise.resolve(regenerateResponse.body),
        });
      }
      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const clickRefresh = async () => {
    const button = await screen.findByRole("button", { name: /settings\.mascotRefresh$/ });
    fireEvent.click(button);
    return button;
  };

  it("POSTs to the regenerate endpoint with the current locale", async () => {
    render(<SettingsApp ui={defaultUi} />);

    await clickRefresh();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/setup-api/mascot-lines/regenerate?locale=en",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("shows a spinner while the run is in flight and confirms when it lands", async () => {
    let resolveRun: ((value: unknown) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/mascot-lines/regenerate") && init?.method === "POST") {
        return new Promise((resolve) => { resolveRun = resolve; });
      }
      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      return jsonResponse({});
    }));

    render(<SettingsApp ui={defaultUi} />);
    const button = await clickRefresh();

    // A local run is up to 180 seconds. Without this the button looks dead.
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();
    expect(within(button).getByText("settings.mascotRefreshing")).toBeInTheDocument();

    resolveRun!({
      ok: true,
      json: () => Promise.resolve({ ok: true, meta: { source: "local", reason: "generated", locale: "en" } }),
    });

    expect(await screen.findByText("settings.mascotRefreshed")).toBeInTheDocument();
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "false"));
  });

  it("tells a background refresh apart from the user's own chat", async () => {
    // The misleading message this fixes: "busy with your chat" was shown when
    // the box's OWN phrase refresh held the model.
    regenerateResponse = {
      ok: true,
      body: { ok: false, reason: "…", meta: { source: "pack", reason: "refresh-in-progress", locale: "en" } },
    };
    render(<SettingsApp ui={defaultUi} />);
    await clickRefresh();
    expect(await screen.findByText("settings.mascotRefreshInProgress")).toBeInTheDocument();
    expect(screen.queryByText("settings.mascotRefreshChatBusy")).not.toBeInTheDocument();
  });

  it("names the user's chat only when the chat really is the holder", async () => {
    regenerateResponse = {
      ok: true,
      body: { ok: false, reason: "…", meta: { source: "pack", reason: "chat-busy", locale: "en" } },
    };
    render(<SettingsApp ui={defaultUi} />);
    await clickRefresh();
    expect(await screen.findByText("settings.mascotRefreshChatBusy")).toBeInTheDocument();
  });

  it("maps every refusal to its own message and falls back for an unknown one", async () => {
    const cases: [string, string][] = [
      ["low-memory", "settings.mascotRefreshLowMemory"],
      ["unavailable", "settings.mascotRefreshUnavailable"],
      ["timeout", "settings.mascotRefreshFailed"],
      ["transport", "settings.mascotRefreshFailed"],
      ["malformed", "settings.mascotRefreshFailed"],
      // Its own message, NOT the generic failure one: the model worked and
      // simply had nothing to add, which is not a fault to go debugging.
      ["no-new-phrases", "settings.mascotRefreshNothingNew"],
      // A reason a future server adds must not render blank.
      ["something-new", "settings.mascotRefreshFailed"],
    ];
    for (const [reason, key] of cases) {
      regenerateResponse = {
        ok: true,
        body: { ok: false, reason: "…", meta: { source: "pack", reason, locale: "en" } },
      };
      const { unmount } = render(<SettingsApp ui={defaultUi} />);
      await clickRefresh();
      expect(await screen.findByText(key), reason).toBeInTheDocument();
      unmount();
    }
  });

  it("reports a transport failure instead of leaving the spinner running", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/mascot-lines/regenerate") && init?.method === "POST") {
        return Promise.reject(new Error("network down"));
      }
      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      return jsonResponse({});
    }));

    render(<SettingsApp ui={defaultUi} />);
    const button = await clickRefresh();

    expect(await screen.findByText("settings.mascotRefreshFailed")).toBeInTheDocument();
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
