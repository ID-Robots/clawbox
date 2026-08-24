import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import HermesProviderConfig from "@/components/HermesProviderConfig";
import { notifyProvidersChanged } from "@/lib/ui-events";
import type { ProviderStatusSummary } from "@/lib/provider-status";

/**
 * The AI Providers section — the merge of what used to be two.
 *
 * Replaces provider-status-strip.test.tsx: every property that file asserted
 * still has to hold (a WORD for every state, exactly one default, a live
 * re-read on the shared signal, a refusal reported rather than swallowed), but
 * now of the ONE section rather than of a strip sitting above a picker that
 * knew none of it. The new properties are the hero and the radio's two verbs.
 */

// Copy comes from two catalogues here, which is the point: the panel chrome is
// Hermes' (hermesProvider.*) and the connection vocabulary is the edition-
// neutral one the removed strip already had translated (settings.providers.*).
vi.mock("@/lib/i18n", async () => {
  const { providerEn } = await import("@/lib/hermes-translations/en-provider");
  const { desktopTranslations } = await import("@/lib/desktop-translations");
  const table: Record<string, string> = { ...desktopTranslations.en, ...providerEn };
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
      authenticated: true,
      models: [{ id: "vendor/model-a", description: "" }],
      defaultModel: "vendor/model-a",
      current: "vendor/model-a",
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

/** The box this section is reading: ClawBox AI is the default and connected. */
const summary = (overrides: Partial<ProviderStatusSummary> = {}): ProviderStatusSummary => ({
  harness: "hermes",
  defaultProvider: "clawai",
  degraded: false,
  providers: [
    { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai" },
    { id: "openrouter", label: "OpenRouter", state: "disconnected", isDefault: false, section: "ai" },
    { id: "anthropic", label: "Anthropic", state: "connected", isDefault: false, section: "ai" },
    { id: "openai-codex", label: "OpenAI Codex", state: "connected", isDefault: false, section: "ai" },
    { id: "gemini", label: "Google Gemini", state: "needs-reauth", isDefault: false, section: "ai" },
    { id: "nous", label: "Nous Portal", state: "unknown", isDefault: false, section: "ai" },
  ],
  ...overrides,
});

let statusBody: ProviderStatusSummary;
let pairing: { provider: string; current: string };
let defaultResponse: { ok: boolean; status: number; body: unknown };
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.startsWith("/setup-api/providers/status")) {
      return { ok: true, json: async () => statusBody } as Response;
    }
    if (url.startsWith("/setup-api/providers/default")) {
      return {
        ok: defaultResponse.ok,
        status: defaultResponse.status,
        json: async () => defaultResponse.body,
      } as Response;
    }
    if (url === "/setup-api/hermes/clawai") {
      return {
        ok: true,
        json: async () => ({
          hasToken: true,
          tier: "flash",
          tierStored: "flash",
          active: true,
          model: "deepseek-v4-flash",
        }),
      } as Response;
    }
    if (url === "/setup-api/hermes/oauth") {
      return { ok: true, json: async () => ({ providers: [] }) } as Response;
    }
    if (url === "/setup-api/hermes/models" && method === "GET") {
      return { ok: true, json: async () => pairing } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The radio row carrying this provider, once it has rendered. */
async function row(label: string): Promise<HTMLElement> {
  return (await screen.findByText(label)).closest("label") as HTMLElement;
}

const hero = () => screen.getByTestId("provider-default-hero");

/** The POSTs this section made to the make-default endpoint, as bodies. */
function defaultCalls(): unknown[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).startsWith("/setup-api/providers/default"))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  statusBody = summary();
  pairing = { provider: "clawai", current: "deepseek-v4-flash" };
  defaultResponse = { ok: true, status: 200, body: { ok: true } };
  stubFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("the hero — what is answering right now", () => {
  it("names the default provider, its model and its connection in one card", async () => {
    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    const card = await screen.findByTestId("provider-default-hero");
    expect(within(card).getByText("ClawBox AI")).toBeInTheDocument();
    // The model id is the half of the answer the old picker only revealed
    // after you had selected the provider and read a dropdown.
    expect(within(card).getByText("deepseek-v4-flash")).toBeInTheDocument();
    expect(within(card).getByText(/switches natively through Hermes/)).toBeInTheDocument();
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(within(card).getByText("Default")).toBeInTheDocument();
  });

  it("marks exactly one provider as the default", async () => {
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    await screen.findByTestId("provider-default-hero");
    // Once in the hero, and nowhere else — the ticked row carries a radio and a
    // tint, not a second copy of the word.
    expect(screen.getAllByText("Default")).toHaveLength(1);
  });

  it("stays away entirely until the box has a default at all", async () => {
    statusBody = summary({
      defaultProvider: null,
      providers: summary().providers.map((p) => ({ ...p, isDefault: false })),
    });
    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    await screen.findByText("OpenRouter");
    expect(screen.queryByTestId("provider-default-hero")).toBeNull();
  });

  it("offers Change model, and lands it on the model UI for that provider", async () => {
    statusBody = summary({
      defaultProvider: "anthropic",
      providers: summary().providers.map((p) => ({ ...p, isDefault: p.id === "anthropic" })),
    });
    pairing = { provider: "anthropic", current: "claude-opus-4-8" };
    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("button", { name: "Change model" }));

    // Selecting the row is what puts that provider's scoped model dropdown on
    // screen; the hero deliberately grows no model UI of its own.
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Anthropic/ })).toBeChecked();
    });
    expect(screen.getByLabelText(/Default model/i)).toBeInTheDocument();
  });
});

describe("every row is honest about its own connection", () => {
  it("carries a WORD for every state, not only a colour", async () => {
    // Roughly one man in twelve cannot separate the two hues that would
    // otherwise be the only difference between "connected" and "needs sign-in".
    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    expect(within(await row("OpenRouter")).getByText("Not connected")).toBeInTheDocument();
    expect(within(await row("Google Gemini")).getByText("Needs sign-in")).toBeInTheDocument();
    expect(within(await row("Nous Portal")).getByText("Unknown")).toBeInTheDocument();
    expect(within(await row("Anthropic")).getByText("Connected")).toBeInTheDocument();
  });

  it("says so when the box could not be asked", async () => {
    statusBody = summary({ degraded: true });
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    expect(await screen.findByText(/some states may be out of date/i)).toBeInTheDocument();
  });
});

describe("the radio's two verbs", () => {
  it("makes a CONNECTED provider the default, and swaps the hero live", async () => {
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    await screen.findByTestId("provider-default-hero");

    fireEvent.click(screen.getByRole("radio", { name: /Anthropic/ }));

    await waitFor(() => expect(defaultCalls()).toEqual([{ provider: "anthropic" }]));

    // The hero moves because the box was RE-ASKED, never because the browser
    // assumed the write landed.
    statusBody = summary({
      defaultProvider: "anthropic",
      providers: summary().providers.map((p) => ({ ...p, isDefault: p.id === "anthropic" })),
    });
    pairing = { provider: "anthropic", current: "claude-opus-4-8" };

    await waitFor(() => {
      expect(within(hero()).getByText("Anthropic")).toBeInTheDocument();
      expect(within(hero()).getByText("claude-opus-4-8")).toBeInTheDocument();
    });
    // …without a reload, and without the section being left and re-entered.
    expect(within(hero()).queryByText("deepseek-v4-flash")).toBeNull();
  });

  it("routes a DISCONNECTED provider to its sign-in flow instead", async () => {
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    await screen.findByTestId("provider-default-hero");

    fireEvent.click(await screen.findByRole("radio", { name: /OpenRouter/ }));

    await waitFor(() => expect(screen.getByRole("radio", { name: /OpenRouter/ })).toBeChecked());
    // A provider with no credential cannot be made the default — the write
    // would be refused, and pretending otherwise is what the row's state is
    // there to prevent. It gets the key/sign-in controls instead.
    expect(defaultCalls()).toEqual([]);
    expect(screen.getByLabelText(/OpenRouter API key/i)).toBeInTheDocument();
  });

  it("writes nothing when the provider chosen is already the default", async () => {
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    await screen.findByTestId("provider-default-hero");

    fireEvent.click(await screen.findByRole("radio", { name: /ClawBox AI/ }));

    await new Promise((r) => setTimeout(r, 50));
    expect(defaultCalls()).toEqual([]);
  });

  it("reports a refusal instead of pretending it worked", async () => {
    defaultResponse = { ok: false, status: 409, body: { error: "provider_unauthenticated" } };
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    await screen.findByTestId("provider-default-hero");

    fireEvent.click(screen.getByRole("radio", { name: /Anthropic/ }));

    expect(await screen.findByText(/provider_unauthenticated/)).toBeInTheDocument();
  });
});

describe("staying live", () => {
  it("re-reads the box when anything reports a provider change", async () => {
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    expect(within(await row("OpenRouter")).getByText("Not connected")).toBeInTheDocument();

    // The signal a successful sign-in in the panel below emits.
    statusBody = summary({
      providers: summary().providers.map((p) =>
        p.id === "openrouter" ? { ...p, state: "connected" as const } : p,
      ),
    });
    notifyProvidersChanged();

    await waitFor(async () => {
      expect(within(await row("OpenRouter")).getByText("Connected")).toBeInTheDocument();
    });
  });

  it("keeps the last good answer when a refresh fails", async () => {
    render(<HermesProviderConfig embedded testId="hermes-ai" />);
    await screen.findByTestId("provider-default-hero");

    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    notifyProvidersChanged();

    // A section that emptied itself on a transient failure would read as
    // "everything disconnected", which is the one thing it must never say by
    // accident.
    await new Promise((r) => setTimeout(r, 250));
    expect(within(hero()).getByText("ClawBox AI")).toBeInTheDocument();
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });
});
