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

// Settings owns the timeout consequences; the overlay's own readiness state
// machine has a dedicated component suite. This button exposes that one
// callback while keeping the full Settings form and request lifecycle real.
vi.mock("@/components/TelegramConfiguringOverlay", () => ({
  default: ({ onTimeout }: { onTimeout: () => void }) => (
    <button type="button" data-testid="telegram-force-timeout" onClick={onTimeout}>
      Force Telegram timeout
    </button>
  ),
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

  it("renders custom wallpaper removal beside, not inside, the selection control", async () => {
    render(<SettingsApp ui={{ ...defaultUi, customWallpapers: ["data:image/png;base64,AA=="] }} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.appearance/ }));

    const select = await screen.findByRole("button", { name: "Custom 1" });
    const remove = screen.getByRole("button", { name: "Remove Custom 1" });
    expect(select).not.toContainElement(remove);
    expect(remove.className).toContain("opacity-60");
    expect(remove.className).not.toContain("opacity-0 ");
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

  it("does not enter reconnect polling when the reset request never reaches the box", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      if (input.toString() === "/setup-api/setup/reset") {
        return Promise.reject(new TypeError("network offline"));
      }
      return defaultFetch(input, init);
    }));

    render(<SettingsApp ui={defaultUi} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.about$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /factoryReset/ }));
    fireEvent.change(document.getElementById("factory-reset-password")!, { target: { value: "hunter2" } });
    fireEvent.change(document.getElementById("factory-reset-confirm")!, { target: { value: "RESET" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.reset" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("settings.connectionFailed");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.getElementById("factory-reset-confirm")).toBeInTheDocument();
  });

  it("closes the reset dialog on Escape and clears what was typed", async () => {
    render(<SettingsApp ui={defaultUi} />);

    fireEvent.click(screen.getByRole("button", { name: /settings\.about$/ }));
    const trigger = await screen.findByRole("button", { name: /factoryReset/ });
    trigger.focus();
    fireEvent.click(trigger);
    const password = document.getElementById("factory-reset-password")!;
    const cancel = screen.getByRole("button", { name: "cancel" });

    expect(password).toHaveFocus();
    fireEvent.keyDown(password, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(password).toHaveFocus();

    fireEvent.change(password, { target: { value: "hunter2" } });

    fireEvent.keyDown(password, { key: "Escape" });

    await waitFor(() => {
      expect(document.getElementById("factory-reset-confirm")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();

    // Reopening must not hand the next caller the last password typed.
    fireEvent.click(screen.getByRole("button", { name: /factoryReset/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(document.getElementById("factory-reset-password")).toHaveValue("");
  });

  it("aborts an active Telegram configure request on readiness timeout and enables retry", async () => {
    let configureSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      if (input.toString() === "/setup-api/telegram/configure") {
        configureSignal = init?.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => {
          configureSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      return defaultFetch(input, init);
    }));

    const { container } = render(<SettingsApp ui={defaultUi} />);
    const nav = container.querySelector("nav");
    if (!nav) throw new Error("desktop sidebar nav did not render");
    const channels = [...nav.querySelectorAll(":scope > button")]
      .find((button) => (button.textContent ?? "").includes("settings.channels"));
    if (!channels) throw new Error("Messaging Channels nav entry did not render");
    fireEvent.click(channels);
    fireEvent.click(await screen.findByTestId("settings-channel-telegram"));

    const token = await screen.findByLabelText("settings.botToken");
    fireEvent.change(token, { target: { value: "123456789:test-token" } });
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect$/ }));

    await waitFor(() => expect(configureSignal).toBeDefined());
    fireEvent.click(await screen.findByTestId("telegram-force-timeout"));

    await waitFor(() => expect(configureSignal?.aborted).toBe(true));
    const retry = await screen.findByRole("button", { name: /settings\.connect$/ });
    expect(retry).toBeEnabled();
    expect(await screen.findByText("settings.connectionFailed")).toBeInTheDocument();
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
    // Settings opens on AI Models; the phrase refresh lives in Appearance.
    fireEvent.click(screen.getByRole("button", { name: /settings\.appearance/ }));
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
 * TASK follow-up: the AI section's own "Status" card duplicated the AI
 * Providers hero — same provider, same model, same "connected", stacked
 * directly above it. It was suppressed on hermes only because that was the one
 * edition with a hero; now that the OpenClaw panel opens with the same hero,
 * the reason applies on every edition and the card is gone from all of them.
 */
describe("SettingsApp — the AI section never doubles the provider hero", () => {
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

  it("hides it on openclaw too — the same hero now opens that panel", async () => {
    stubForEdition("openclaw");
    render(<SettingsApp ui={defaultUi} />);

    // The OpenClaw panel opens with the hero the Hermes one already had...
    expect(await screen.findByTestId("provider-default-hero")).toBeInTheDocument();
    // ...so the card that said the same three things one card higher is gone.
    await waitFor(() => {
      expect(screen.queryByText("settings.status")).not.toBeInTheDocument();
    });
  });
});

/**
 * The Messaging Channels hub — one sidebar entry for every outside service the assistant
 * can be reached through, in the shape of GNOME's Online Accounts. The four
 * connectors keep their own panes (and their deep links); what changed is that
 * the sidebar stopped carrying four near-identical rows.
 */
describe("SettingsApp messaging channels hub", () => {
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

  function navButtons(container: HTMLElement): HTMLElement[] {
    const nav = container.querySelector("nav");
    if (!nav) throw new Error("desktop sidebar nav did not render");
    return [...nav.querySelectorAll(":scope > button")] as HTMLElement[];
  }

  it("carries one Messaging Channels entry instead of a row per channel", () => {
    const { container } = render(<SettingsApp ui={defaultUi} />);
    const labels = navButtons(container).map((b) => b.textContent ?? "");

    // Each row's text carries its label plus an sr-only status line, so these
    // are substring checks rather than exact matches.
    expect(labels.some((l) => l.includes("settings.channels"))).toBe(true);
    for (const gone of ["settings.telegram", "settings.email", "settings.whatsapp", "settings.discord"]) {
      expect(labels.some((l) => l.includes(gone))).toBe(false);
    }
  });

  it("lists every channel on the hub page, each opening its own settings", async () => {
    const { container } = render(<SettingsApp ui={defaultUi} />);
    const accounts = navButtons(container).find((b) => (b.textContent ?? "").includes("settings.channels"));
    if (!accounts) throw new Error("Messaging Channels nav entry did not render");
    fireEvent.click(accounts);

    const list = await screen.findByTestId("settings-channels-list");
    for (const id of ["telegram", "email", "whatsapp", "discord"]) {
      expect(within(list).getByTestId(`settings-channel-${id}`)).toBeInTheDocument();
    }

    // A row opens that connector's pane, and the pane offers the way back —
    // the sidebar no longer has a row of its own to return to.
    fireEvent.click(screen.getByTestId("settings-channel-telegram"));
    expect(await screen.findByTestId("settings-channels-back")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-channels-list")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-channels-back"));
    expect(await screen.findByTestId("settings-channels-list")).toBeInTheDocument();
  });

  it("keeps the entry lit while a channel pane is open", async () => {
    const { container } = render(<SettingsApp ui={defaultUi} />);
    const accountsButton = () =>
      navButtons(container).find((b) => (b.textContent ?? "").includes("settings.channels"))!;
    fireEvent.click(accountsButton());
    fireEvent.click(await screen.findByTestId("settings-channel-discord"));

    await waitFor(() => expect(screen.getByTestId("settings-channels-back")).toBeInTheDocument());
    expect(accountsButton().className).toContain("coral-bright");
  });
});

/**
 * Providers and Local AI are neighbouring sidebar entries, each with its own
 * provider list on top: cloud sign-ins on Providers, the on-device model and
 * the inventory of everything on the box on Local AI. The old "localModels"
 * section id survives as a deep link that lands on Local AI.
 */
describe("SettingsApp providers and Local AI pages", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
      if (url.startsWith("/setup-api/providers/status")) {
        return jsonResponse({ harness: "openclaw", providers: [], defaultProvider: null, degraded: false });
      }
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function navButtons(container: HTMLElement): HTMLElement[] {
    const nav = container.querySelector("nav");
    if (!nav) throw new Error("desktop sidebar nav did not render");
    return [...nav.querySelectorAll(":scope > button")] as HTMLElement[];
  }

  it("carries Providers and Local AI, and no Local Models or AI Provider rows", () => {
    const { container } = render(<SettingsApp ui={defaultUi} />);
    const labels = navButtons(container).map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("settings.providers"))).toBe(true);
    expect(labels.some((l) => l.includes("settings.localAi"))).toBe(true);
    expect(labels.some((l) => l.includes("settings.localModels"))).toBe(false);
    expect(labels.some((l) => l.includes("settings.aiProvider"))).toBe(false);
    // Providers leads the sidebar, with Local AI directly beneath it.
    expect(labels.findIndex((l) => l.includes("settings.localAi"))).toBe(labels.findIndex((l) => l.includes("settings.providers")) + 1);
  });

  it("carries no Coding Agent section — its settings live in the Coding Agent app now", async () => {
    // The switch, folder, effort and GitHub card moved back into the app at
    // the owner's request; the sidebar must not offer a dead entry, and the
    // old section id must not open a panel here.
    const { container } = render(<SettingsApp ui={defaultUi} />);
    const labels = navButtons(container).map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("settings.codingAgent"))).toBe(false);

    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "codingAgent" } }));
    expect(screen.queryByTestId("coding-agent-settings-panel")).toBeNull();
  });

  it("opens on Providers with the provider list, and Local AI shows the grouped on-device page", async () => {
    const { container } = render(<SettingsApp ui={defaultUi} />);
    expect(await screen.findByTestId("ai-provider-list")).toBeInTheDocument();

    const local = navButtons(container).find((b) => (b.textContent ?? "").includes("settings.localAi"));
    if (!local) throw new Error("Local AI nav entry did not render");
    fireEvent.click(local);
    // One grouped page for everything on the box (it loads its inventory first).
    expect(await screen.findByTestId("local-ai-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-local-ai-step")).not.toBeInTheDocument();
  });

  it("lands the old Local Models deep link on Local AI and keeps that entry lit", async () => {
    const { container } = render(<SettingsApp ui={defaultUi} />);
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "localModels" } }));
    expect(await screen.findByTestId("local-ai-loading")).toBeInTheDocument();
    const local = navButtons(container).find((b) => (b.textContent ?? "").includes("settings.localAi"))!;
    expect(local.className).toContain("coral-bright");
  });
});
