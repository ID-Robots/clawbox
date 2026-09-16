import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import HermesProviderConfig from "@/components/HermesProviderConfig";
import type { ProviderStatusSummary } from "@/lib/provider-status";

/**
 * Setup wizard, step 4, on a Hermes device.
 *
 * The wizard surface is the SAME step as the OpenClaw one ("Connect AI
 * Provider"): one recommended card, everything else one tap behind "Show more
 * providers…", the ClawBox AI sub-flow under it, and the local-only skip at the
 * bottom. It used to open on a flat list of every provider Hermes knows, with
 * the "Auto / DEFAULT" hero on top and OpenRouter's key field underneath —
 * a different product on the same step, on a screen an owner meets once.
 *
 * Settings embeds the same component with `embedded`, and that surface is
 * deliberately NOT collapsed: on Hermes this panel absorbed the connection
 * strip, so every provider's state has to stay visible there (SettingsApp
 * suppresses its own status card for exactly that reason).
 */

vi.mock("@/lib/i18n", async () => {
  const { translations } = await import("@/lib/translations");
  const table = translations.en;
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          table[key] ?? key,
        ),
      locale: "en",
      setLocale: vi.fn(),
    }),
  };
});

vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

vi.mock("@/hooks/useHermesModelOptions", () => ({
  useHermesModelOptions: () => ({
    scope: {
      provider: "openrouter",
      authenticated: false,
      models: [],
      defaultModel: "",
      current: "",
      savedElsewhere: null,
      source: "dashboard",
      stale: false,
      fetchedAt: Date.now(),
    },
    loading: false,
    refresh: vi.fn(),
  }),
  notifyHermesModelState: vi.fn(),
}));

/**
 * The device-code hook is driven by its callbacks here: the poll's
 * `configuring` → `complete` transitions are what the wizard has to visualise.
 */
let loginCallbacks: {
  onConfiguring?: () => void;
  onComplete?: () => void;
  onError?: (msg: string) => void;
} = {};
vi.mock("@/hooks/useClawaiDeviceLogin", () => ({
  useClawaiDeviceLogin: (options: typeof loginCallbacks) => {
    loginCallbacks = options;
    return { deviceCode: null, verificationUrl: null, polling: false, start: vi.fn(), reset: vi.fn() };
  },
}));

/** A box mid-setup: nothing connected yet, no default. */
const summary = (overrides: Partial<ProviderStatusSummary> = {}): ProviderStatusSummary => ({
  harness: "hermes",
  defaultProvider: null,
  unrunnable: [],
  degraded: false,
  providers: [
    { id: "clawai", label: "ClawBox AI", state: "disconnected", isDefault: false, section: "ai", enabled: true },
    { id: "openrouter", label: "OpenRouter", state: "disconnected", isDefault: false, section: "ai", enabled: true },
    { id: "anthropic", label: "Anthropic", state: "disconnected", isDefault: false, section: "ai", enabled: true },
    { id: "gemini", label: "Google Gemini", state: "disconnected", isDefault: false, section: "ai", enabled: true },
  ],
  ...overrides,
});

let statusBody: ProviderStatusSummary;
let pairing: { provider: string; current: string; providers?: { id: string; authenticated: boolean; credentialPresent: boolean }[] };
let clawaiState: { hasToken: boolean; tier: string; tierStored: string | null; active: boolean; model: string };

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("/setup-api/providers/status")) {
      return { ok: true, json: async () => statusBody } as Response;
    }
    if (url === "/setup-api/hermes/clawai") {
      return { ok: true, json: async () => clawaiState } as Response;
    }
    if (url === "/setup-api/hermes/oauth") {
      return { ok: true, json: async () => ({ providers: [] }) } as Response;
    }
    if (url === "/setup-api/hermes/models" && method === "GET") {
      return { ok: true, json: async () => pairing } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
}

/** Every provider radio currently on screen, by accessible name. */
function providerRows(): string[] {
  return screen.queryAllByRole("radio").map((input) => input.getAttribute("value") ?? "");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  statusBody = summary();
  // A fresh box: Hermes has no provider/model pairing of its own yet.
  pairing = { provider: "", current: "" };
  clawaiState = { hasToken: false, tier: "flash", tierStored: null, active: false, model: "deepseek-v4-flash" };
  stubFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("wizard step 4 on Hermes — the OpenClaw provider step", () => {
  it("opens on ClawBox AI alone, with every other provider behind the collapsible", async () => {
    render(<HermesProviderConfig testId="hermes-ai" onNext={vi.fn()} />);

    await screen.findByText("ClawBox AI");
    await waitFor(() => expect(providerRows()).toEqual(["clawai"]));
    expect(screen.queryByText("OpenRouter")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show more providers/i }));

    await screen.findByText("OpenRouter");
    expect(providerRows()).toContain("anthropic");
    expect(providerRows().length).toBeGreaterThan(1);
  });

  it("carries the ClawBox AI sub-flow — plan card and device code — under that one card", async () => {
    render(<HermesProviderConfig testId="hermes-ai" onNext={vi.fn()} />);

    // The plan summary (ClawboxAiPlanPicker's closed state) and the device-code
    // kick-off, exactly as the OpenClaw step shows them.
    await screen.findByRole("button", { name: /Get device code/i });
    expect(screen.getAllByText(/plan/i).length).toBeGreaterThan(0);
    // …and not the OpenRouter API-key field the step used to open on.
    expect(screen.queryByLabelText(/OpenRouter API key/i)).toBeNull();
  });

  it("offers the local-only skip instead of a bare Continue", async () => {
    render(<HermesProviderConfig testId="hermes-ai" onNext={vi.fn()} />);

    await screen.findByText("ClawBox AI");
    expect(screen.getByRole("button", { name: /Skip — I'll use only local AI/i })).toBeTruthy();
  });

  it("keeps the Auto/default hero off the wizard surface", async () => {
    statusBody = summary({
      defaultProvider: "auto",
      providers: [
        ...summary().providers,
        { id: "auto", label: "Auto", state: "connected", isDefault: true, section: "ai", enabled: true },
      ],
    });
    render(<HermesProviderConfig testId="hermes-ai" onNext={vi.fn()} />);

    await screen.findByText("ClawBox AI");
    expect(screen.queryByTestId("provider-default-hero")).toBeNull();
  });

  it("takes the wizard's own title and description, so both editions read alike", async () => {
    render(
      <HermesProviderConfig
        testId="hermes-ai"
        onNext={vi.fn()}
        title="Connect AI Provider"
        description="Select your AI provider and enter your API key or subscription token."
      />,
    );

    expect(await screen.findByRole("heading", { name: "Connect AI Provider" })).toBeTruthy();
    expect(screen.getByText(/Select your AI provider/i)).toBeTruthy();
  });
});

describe("the same panel in Settings — unchanged", () => {
  it("still lists every provider and still shows the default hero", async () => {
    statusBody = summary({
      defaultProvider: "clawai",
      providers: summary().providers.map((row) =>
        row.id === "clawai" ? { ...row, state: "connected" as const, isDefault: true } : row,
      ),
    });
    pairing = { provider: "clawai", current: "deepseek-v4-flash" };
    clawaiState = { hasToken: true, tier: "flash", tierStored: "flash", active: true, model: "deepseek-v4-flash" };

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    await screen.findByText("OpenRouter");
    expect(await screen.findByTestId("provider-default-hero")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "AI Providers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show more providers/i })).toBeNull();
  });
});

describe("connecting ClawBox AI on the wizard — the same progress overlay as OpenClaw", () => {
  it("shows the setting-up overlay while the device configures, holds it, then Connected!, then advances", async () => {
    const onNext = vi.fn();
    render(<HermesProviderConfig testId="hermes-ai" onNext={onNext} />);
    await screen.findByRole("button", { name: /Get device code/i });

    // The device code was entered on the phone; the box is now applying the
    // credential. Before this the only cue was one muted status line.
    act(() => loginCallbacks.onConfiguring?.());

    expect(screen.getByText("Setting up ClawBox AI")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem").filter((row) => row.hasAttribute("data-step-state"));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toHaveAttribute("data-step-state", "active");
    // The form underneath is parked (hidden, not torn down), so nothing re-fetches.
    const parked = screen.getByRole("button", { name: /Get device code/i, hidden: true });
    expect(parked.closest("[aria-hidden='true']")).not.toBeNull();

    act(() => loginCallbacks.onComplete?.());

    // An instant connect must not flash: the overlay stays up for its minimum
    // dwell before the DONE beat, and only then does the wizard move on.
    expect(screen.getByText("Setting up ClawBox AI")).toBeInTheDocument();
    expect(onNext).not.toHaveBeenCalled();
    await screen.findByText("Connected!", {}, { timeout: 4_000 });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: 2_500 });
  }, 10_000);

  it("drops the overlay and shows the error when the handoff fails", async () => {
    render(<HermesProviderConfig testId="hermes-ai" onNext={vi.fn()} />);
    await screen.findByRole("button", { name: /Get device code/i });

    act(() => loginCallbacks.onConfiguring?.());
    expect(screen.getByText("Setting up ClawBox AI")).toBeInTheDocument();

    act(() => loginCallbacks.onError?.("Device code expired"));

    expect(screen.queryByText("Setting up ClawBox AI")).toBeNull();
    expect(screen.getByText("Device code expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Get device code/i })).toBeInTheDocument();
  });
});

describe("the harness's own default provider is not the owner's choice", () => {
  it("keeps ClawBox AI selected when Hermes names OpenRouter with no key behind it", async () => {
    // A fresh Hermes install answers `model.provider = openrouter` before
    // anyone has configured anything — the wizard used to open on that row.
    pairing = {
      provider: "openrouter",
      current: "",
      providers: [{ id: "openrouter", authenticated: false, credentialPresent: false }],
    };
    render(<HermesProviderConfig testId="hermes-ai" onNext={vi.fn()} />);

    await screen.findByRole("button", { name: /Get device code/i });
    await new Promise((r) => setTimeout(r, 50));
    expect(providerRows()).toEqual(["clawai"]);
    expect(screen.getByRole("radio", { name: /ClawBox AI/ })).toBeChecked();
  });

  it("still opens on a provider the owner has actually connected", async () => {
    pairing = {
      provider: "openrouter",
      current: "openrouter/auto",
      providers: [{ id: "openrouter", authenticated: true, credentialPresent: true }],
    };
    render(<HermesProviderConfig testId="hermes-ai" onNext={vi.fn()} />);

    await waitFor(() => expect(providerRows()).toEqual(["openrouter"]));
    expect(screen.getByRole("radio", { name: /OpenRouter/ })).toBeChecked();
  });
});
