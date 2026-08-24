import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ProviderStatusStrip from "@/components/ProviderStatusStrip";
import { notifyProvidersChanged } from "@/lib/ui-events";
import type { ProviderStatusSummary } from "@/lib/provider-status";

/**
 * The connection overview: every provider readable WITHOUT clicking, the
 * default marked, and both of those staying true while the customer watches.
 */

vi.mock("@/lib/i18n", async () => {
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          desktopTranslations.en[key] ?? key,
        ),
      locale: "en",
      setLocale: vi.fn(),
    }),
  };
});

const summary = (overrides: Partial<ProviderStatusSummary> = {}): ProviderStatusSummary => ({
  harness: "hermes",
  defaultProvider: "anthropic",
  degraded: false,
  providers: [
    { id: "clawai", label: "ClawBox AI", state: "disconnected", isDefault: false, section: "ai" },
    { id: "anthropic", label: "Anthropic", state: "connected", isDefault: true, section: "ai" },
    { id: "openrouter", label: "OpenRouter", state: "connected", isDefault: false, section: "ai" },
    { id: "gemini", label: "Google Gemini", state: "needs-reauth", isDefault: false, section: "ai" },
    { id: "nous", label: "Nous Portal", state: "unknown", isDefault: false, section: "ai" },
  ],
  ...overrides,
});

let statusBody: ProviderStatusSummary;
let defaultResponse: { ok: boolean; status: number; body: unknown };
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch() {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/setup-api/providers/status")) {
      return { ok: true, json: async () => statusBody, text: async () => JSON.stringify(statusBody) } as Response;
    }
    if (url.startsWith("/setup-api/providers/default")) {
      return {
        ok: defaultResponse.ok,
        status: defaultResponse.status,
        json: async () => defaultResponse.body,
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The chip that carries this provider, once it has rendered. */
async function chip(label: string): Promise<HTMLElement> {
  return (await screen.findByText(label)).closest("li") as HTMLElement;
}

beforeEach(() => {
  statusBody = summary();
  defaultResponse = { ok: true, status: 200, body: { ok: true } };
  stubFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("reading the strip without clicking anything", () => {
  it("names every provider and its state at once", async () => {
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);

    // The whole complaint this answers: you had to select a provider first.
    for (const label of ["ClawBox AI", "Anthropic", "OpenRouter", "Google Gemini", "Nous Portal"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(await screen.findAllByText("Connected")).toHaveLength(2);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Needs sign-in")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("carries a WORD for every state, not only a colour", async () => {
    // Roughly one man in twelve cannot separate the two hues that would
    // otherwise be the only difference between "connected" and "needs sign-in".
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    expect(within(await chip("Google Gemini")).getByText("Needs sign-in")).toBeInTheDocument();
  });

  it("marks exactly one provider as the default", async () => {
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    expect(await screen.findAllByText("Default")).toHaveLength(1);
    expect(within(await chip("Anthropic")).getByText("Default")).toBeInTheDocument();
  });

  it("says so when the box could not be asked", async () => {
    statusBody = summary({ degraded: true });
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    expect(
      await screen.findByText(/some states may be out of date/i),
    ).toBeInTheDocument();
  });
});

describe("clicking a chip", () => {
  it("hands the whole row back, so the caller knows where to send them", async () => {
    const onOpenProvider = vi.fn();
    render(<ProviderStatusStrip onOpenProvider={onOpenProvider} />);

    fireEvent.click(await screen.findByLabelText("Open OpenRouter settings"));

    expect(onOpenProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openrouter", section: "ai" }),
    );
  });
});

describe("choosing a new default", () => {
  it("offers the star only where it would do something", async () => {
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    await screen.findByText("Anthropic");

    // Connected and not already default → offered.
    expect(screen.getByLabelText("Make OpenRouter the default provider")).toBeInTheDocument();
    // Already the default → nothing to change.
    expect(screen.queryByLabelText("Make Anthropic the default provider")).toBeNull();
    // No credential → cannot be made the default.
    expect(screen.queryByLabelText("Make ClawBox AI the default provider")).toBeNull();
    expect(screen.queryByLabelText("Make Google Gemini the default provider")).toBeNull();
  });

  it("writes it through and repaints the star from the server's answer", async () => {
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Make OpenRouter the default provider"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/setup-api/providers/default",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/default"))!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ provider: "openrouter" });

    // The star moves because the box was re-asked, never because the browser
    // assumed the write landed.
    statusBody = summary({
      defaultProvider: "openrouter",
      providers: summary().providers.map((p) => ({ ...p, isDefault: p.id === "openrouter" })),
    });
    await waitFor(async () => {
      expect(within(await chip("OpenRouter")).getByText("Default")).toBeInTheDocument();
    });
  });

  it("reports a refusal instead of pretending it worked", async () => {
    defaultResponse = { ok: false, status: 409, body: { error: "provider_unauthenticated" } };
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Make OpenRouter the default provider"));

    expect(await screen.findByText(/provider_unauthenticated/)).toBeInTheDocument();
  });
});

describe("staying live", () => {
  it("re-reads the box when anything reports a provider change", async () => {
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();

    // The signal a successful sign-in in the panel below emits.
    statusBody = summary({
      providers: summary().providers.map((p) =>
        p.id === "clawai" ? { ...p, state: "connected" as const } : p,
      ),
    });
    notifyProvidersChanged();

    // Flips WITHOUT a reload — the whole of feature 1, seen from the strip.
    await waitFor(async () => {
      expect(within(await chip("ClawBox AI")).getByText("Connected")).toBeInTheDocument();
    });
  });

  it("keeps the last good answer when a refresh fails", async () => {
    render(<ProviderStatusStrip onOpenProvider={vi.fn()} />);
    await screen.findByText("Anthropic");

    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    notifyProvidersChanged();

    // A strip that emptied itself on a transient failure would read as
    // "everything disconnected", which is the one thing it must never say by
    // accident.
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });
});
