import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import { resetHarnessCache } from "@/lib/client-harness";

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
  /** The whole settings app mounts here, so every panel's status call needs an
   *  answer. A test that wants one route to behave differently wraps this. */
  function defaultFetch(input: string | URL, init?: RequestInit) {
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
      if (url === "/setup-api/providers/status") {
        return jsonResponse({
          harness: "openclaw",
          defaultProvider: "clawai",
          degraded: false,
          providers: [
            { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai" },
            { id: "anthropic", label: "Anthropic Claude", state: "disconnected", isDefault: false, section: "ai" },
          ],
        });
      }
      if (url === "/setup-api/setup/status") return jsonResponse({ setup_complete: false });
      if (url === "/setup-api/llamacpp/status") return jsonResponse({ installed: false });
      if (url === "/setup-api/ollama/status") return jsonResponse({ installed: false });
      if (url === "/setup-api/telegram/status") return jsonResponse({ configured: false });
      if (url === "/setup-api/setup/reset") return jsonResponse({ ok: true });

      return jsonResponse({});
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(defaultFetch));
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

    const confirmButton = screen.getByRole("button", { name: "settings.reset" });
    // TASK-443: the wipe cannot start on the dialog opening alone.
    expect(confirmButton).toBeDisabled();

    fireEvent.change(document.getElementById("factory-reset-password")!, { target: { value: "hunter2" } });
    fireEvent.change(document.getElementById("factory-reset-confirm")!, { target: { value: "RESET" } });
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/setup/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "hunter2", confirm: "RESET" }),
      });
    });

    const overlay = await screen.findByRole("status");
    expect(overlay).toBeInTheDocument();
    expect(document.body).toContainElement(overlay);
    expect(container).not.toContainElement(overlay);
    expect(within(overlay).getAllByText("settings.erasingSettings")).toHaveLength(2);
    expect(within(overlay).getByText("settings.waitingOnline")).toBeInTheDocument();
    expect(within(overlay).getByText("settings.startingSetup")).toBeInTheDocument();
  });

  it("keeps the dialog up and shows why when the box refuses the reset", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      if (input.toString() === "/setup-api/setup/reset") {
        return Promise.resolve(new Response(JSON.stringify({ error: "Incorrect password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return defaultFetch(input, init);
    }));

    render(<SettingsApp ui={defaultUi} />);

    fireEvent.click(screen.getByRole("button", { name: /settings\.about$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /factoryReset/ }));
    fireEvent.change(document.getElementById("factory-reset-password")!, { target: { value: "wrong" } });
    fireEvent.change(document.getElementById("factory-reset-confirm")!, { target: { value: "RESET" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.reset" }));

    // The old flow went straight to the "erasing..." overlay without reading
    // the response, so a refusal was indistinguishable from a wipe in progress.
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.getElementById("factory-reset-confirm")).toBeInTheDocument();
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

describe("SettingsApp desktop nav overflow contract", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The sidebar grew past the window once (Email/Discord/WhatsApp were added)
  // and painted its last sections outside the Settings frame. The contract is
  // structural, not a height keyed to today's list: the nav owns a scrollport,
  // the row clips, and no item may be squashed to make the list fit.
  function renderDesktop() {
    const { container } = render(<SettingsApp ui={defaultUi} />);
    const nav = container.querySelector("nav");
    if (!nav) throw new Error("desktop sidebar nav did not render");
    const row = nav.parentElement;
    if (!row) throw new Error("sidebar has no layout row");
    const content = nav.nextElementSibling;
    if (!content) throw new Error("content pane did not render");
    return { row, nav, content };
  }

  it("gives the sidebar its own scrollport so a long section list scrolls", () => {
    const { nav } = renderDesktop();

    expect(nav.className).toContain("overflow-y-auto");
    // Without min-h-0 a flex child refuses to shrink below its content height.
    expect(nav.className).toContain("min-h-0");
  });

  it("clips the layout row so the nav can never paint outside the window", () => {
    const { row } = renderDesktop();

    expect(row.className).toContain("overflow-hidden");
    expect(row.className).toContain("h-full");
  });

  it("keeps every section button at full height whatever the item count", () => {
    const { nav } = renderDesktop();
    const items = [...nav.querySelectorAll(":scope > button")];

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.className).toContain("shrink-0");
    }
  });

  it("lets the content pane fill its column and scroll independently", () => {
    const { content } = renderDesktop();

    expect(content.className).toContain("flex-1");
    expect(content.className).toContain("overflow-y-auto");
    expect(content.className).toContain("min-w-0");
  });
});

/**
 * TASK follow-up: the AI section's own "Status" card duplicated the new AI
 * Providers hero on the Hermes edition — same provider, same model, same
 * "connected", stacked directly above it. The owner's goal this round was to
 * kill redundant provider sections, so the card is suppressed on hermes (the
 * hero is the single source there) and kept verbatim on openclaw and dual,
 * which have no hero.
 */
describe("SettingsApp — AI section Status card is not doubled on Hermes", () => {
  function stubForEdition(edition: "hermes" | "openclaw") {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = input.toString();
        if (url === "/setup-api/harness/active") {
          return jsonResponse({ active: edition, edition });
        }
        if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
        if (url === "/setup-api/setup/status") {
          return jsonResponse({ setup_complete: true, ai_model_configured: true });
        }
        if (url === "/setup-api/ai-models/status") {
          return jsonResponse({
            connected: true,
            provider: edition === "hermes" ? "anthropic" : "clawai",
            providerLabel: edition === "hermes" ? "Anthropic" : "ClawBox AI",
            mode: null,
            model: edition === "hermes" ? "claude-fable-5" : "deepseek-v4-flash",
            clawaiTier: null,
          });
        }
        if (url === "/setup-api/ai-models/oauth/providers") return jsonResponse({ providers: [] });
        if (url === "/setup-api/providers/status") {
          return jsonResponse({
            harness: edition,
            defaultProvider: edition === "hermes" ? "anthropic" : "clawai",
            degraded: false,
            providers: [
              {
                id: edition === "hermes" ? "anthropic" : "clawai",
                label: edition === "hermes" ? "Anthropic" : "ClawBox AI",
                state: "connected",
                isDefault: true,
                section: "ai",
              },
            ],
          });
        }
        // HermesProviderConfig's own reads (only exercised on the hermes path).
        if (url === "/setup-api/hermes/clawai") {
          return jsonResponse({ hasToken: false, tier: "flash", tierStored: null, active: false, model: "" });
        }
        if (url === "/setup-api/hermes/oauth") return jsonResponse({ providers: [] });
        if (url.startsWith("/setup-api/hermes/models")) {
          return jsonResponse({ provider: "anthropic", current: "claude-fable-5", models: [] });
        }
        if (url === "/setup-api/llamacpp/status") return jsonResponse({ installed: false });
        if (url === "/setup-api/ollama/status") return jsonResponse({ installed: false });
        return jsonResponse({});
      }),
    );
  }

  beforeEach(() => {
    resetHarnessCache();
    const pending = window as Window & { __clawboxPendingSettingsSection?: string };
    pending.__clawboxPendingSettingsSection = "ai";
  });

  afterEach(() => {
    resetHarnessCache();
    vi.unstubAllGlobals();
  });

  it("hides the Status card on hermes — the hero carries it instead", async () => {
    stubForEdition("hermes");
    render(<SettingsApp ui={defaultUi} />);

    // The hero is the single source of "what is running" on this edition.
    expect(await screen.findByTestId("provider-default-hero")).toBeInTheDocument();
    // And the old Status card, which named the same provider and model right
    // above it, is gone.
    await waitFor(() => {
      expect(screen.queryByText("settings.status")).not.toBeInTheDocument();
    });
  });

  it("keeps the Status card on openclaw — there is no hero there", async () => {
    stubForEdition("openclaw");
    render(<SettingsApp ui={defaultUi} />);

    // OpenClaw renders the picker, not the hero, so its Status card must stay.
    expect(await screen.findByText("settings.status")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-default-hero")).not.toBeInTheDocument();
  });
});
