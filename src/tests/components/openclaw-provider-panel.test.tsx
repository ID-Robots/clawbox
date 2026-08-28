import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";
import type { ProviderStatusSummary } from "@/lib/provider-status";

/**
 * The OpenClaw AI-provider panel, wearing the treatment the Hermes panel
 * already had: a default HERO above the list, and a connection WORD on every
 * row.
 *
 * This file exists to pin the two halves of that port against each other. The
 * presentation is new; the CATALOGUE is not, and the last test here is the one
 * that matters most — the port was allowed to restyle the rows and forbidden to
 * change which rows there are, in what order, or what each one is worth.
 */

// Real copy, from the real catalogues, so a key that does not exist shows up as
// a raw key string in an assertion rather than passing silently.
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
      localeResolved: true,
      setLocale: vi.fn(),
    }),
  };
});

vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

vi.mock("@/hooks/useOllamaModels", () => ({
  useOllamaModels: () => ({
    ollamaRunning: false,
    ollamaModels: [],
    ollamaSearch: "",
    ollamaSearchResults: [],
    ollamaSearching: false,
    ollamaPulling: false,
    ollamaPullProgress: null,
    ollamaSaving: false,
    checkOllamaStatus: vi.fn(),
    handleOllamaSearchChange: vi.fn(),
    pullOllamaModel: vi.fn(),
    saveOllamaConfig: vi.fn(),
    deleteOllamaModel: vi.fn(),
    formatOllamaBytes: vi.fn((bytes: number) => `${bytes}`),
    clearSearch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useLlamaCppModels", () => ({
  useLlamaCppModels: () => ({
    llamaCppRunning: false,
    llamaCppInstalled: false,
    llamaCppModels: [],
    llamaCppEndpoint: "http://127.0.0.1:8080/v1",
    llamaCppSaving: false,
    llamaCppProgress: null,
    checkLlamaCppStatus: vi.fn(),
    saveLlamaCppConfig: vi.fn(),
  }),
}));

/** The box under test: ClawBox AI is the default and connected. */
const summary: ProviderStatusSummary = {
  harness: "openclaw",
  defaultProvider: "clawai",
  degraded: false,
  providers: [
    { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai" },
    { id: "openai", label: "OpenAI GPT", state: "disconnected", isDefault: false, section: "ai" },
    { id: "anthropic", label: "Anthropic Claude", state: "connected", isDefault: false, section: "ai" },
    { id: "google", label: "Google Gemini", state: "disconnected", isDefault: false, section: "ai" },
    { id: "openrouter", label: "OpenRouter", state: "disconnected", isDefault: false, section: "ai" },
  ],
};

/** Exactly what Settings → AI Models hands the panel. */
const SETTINGS_PROVIDER_IDS = ["clawai", "openai", "anthropic", "google", "openrouter"];

function stubFetch(status: unknown = summary) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/setup-api/providers/status")) {
      return { ok: true, json: async () => status };
    }
    if (url.includes("/setup-api/ai-models/oauth/providers")) {
      return { ok: true, json: async () => ({ providers: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

function renderPanel(props: Record<string, unknown> = {}) {
  return render(
    <AIModelsStep
      embedded
      providerIds={SETTINGS_PROVIDER_IDS}
      defaultProviderId="clawai"
      currentProviderId="clawai"
      currentModel="deepseek-v4-flash"
      title="Connect AI Provider"
      description="Choose the primary AI service"
      {...props}
    />,
  );
}

/** Open the collapsed catalogue so every row is in the DOM. */
async function expandCatalogue() {
  const more = await screen.findByRole("button", { name: /show more/i });
  fireEvent.click(more);
}

describe("OpenClaw AI provider panel — Hermes treatment", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    stubFetch();
  });

  it("renders the default hero above the list, naming provider, model and connection", async () => {
    renderPanel();

    const hero = await screen.findByTestId("provider-default-hero");
    expect(hero).toHaveTextContent("ClawBox AI");
    expect(hero).toHaveTextContent("deepseek-v4-flash");
    // The star badge and the connection word, in the edition-neutral copy.
    expect(within(hero).getByText("Default")).toBeInTheDocument();
    expect(within(hero).getByText("Connected")).toBeInTheDocument();
  });

  it("labels the radio group through the catalogue, not a hardcoded string", async () => {
    renderPanel();
    // Same accessible name as before, but sourced from a translation key: the
    // raw key would surface here if the key were missing.
    const group = await screen.findByRole("radiogroup", { name: "AI Provider" });
    expect(group).toBeInTheDocument();
  });

  it("gives every row a real radio input and a connection word", async () => {
    renderPanel();
    await screen.findByTestId("provider-default-hero");
    await expandCatalogue();

    const group = screen.getByRole("radiogroup", { name: "AI Provider" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(SETTINGS_PROVIDER_IDS.length);
    // One word per state, never a bare dot.
    expect(within(group).getAllByText("Connected")).toHaveLength(2);
    expect(within(group).getAllByText("Not connected")).toHaveLength(3);
  });

  it("keeps the provider catalogue byte-identical to the pre-port list", async () => {
    renderPanel();
    await expandCatalogue();

    const group = screen.getByRole("radiogroup", { name: "AI Provider" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    // Ids AND order — the port restyles rows, it does not curate them.
    expect(radios.map((r) => r.value)).toEqual(SETTINGS_PROVIDER_IDS);
    expect(radios.map((r) => r.name)).toEqual(SETTINGS_PROVIDER_IDS.map(() => "ai-provider"));
    // The names customers read, unchanged.
    for (const label of ["ClawBox AI", "OpenAI GPT", "Anthropic Claude", "Google Gemini", "OpenRouter"]) {
      expect(within(group).getByText(label)).toBeInTheDocument();
    }
  });

  it("never writes a default from a row click — OpenClaw selection stays inert", async () => {
    renderPanel();
    await expandCatalogue();

    const group = screen.getByRole("radiogroup", { name: "AI Provider" });
    const anthropic = within(group).getAllByRole("radio").find((r) => (r as HTMLInputElement).value === "anthropic");
    fireEvent.click(anthropic!);

    await waitFor(() => expect(anthropic).toBeChecked());
    const calls = vi.mocked(fetch).mock.calls.map(([input]) =>
      typeof input === "string" ? input : String(input),
    );
    expect(calls.some((u) => u.includes("/setup-api/providers/default"))).toBe(false);
  });

  it("degrades to the plain list when the status endpoint cannot answer", async () => {
    vi.unstubAllGlobals();
    stubFetch({ nonsense: true });
    renderPanel();

    const group = await screen.findByRole("radiogroup", { name: "AI Provider" });
    expect(group).toBeInTheDocument();
    expect(screen.queryByTestId("provider-default-hero")).not.toBeInTheDocument();
  });

  it("shows no hero on the Local AI surface, whose default is a different section", async () => {
    renderPanel({
      providerIds: ["llamacpp"],
      defaultProviderId: "llamacpp",
      currentProviderId: "llamacpp",
      configureScope: "local",
      testId: "settings-local-ai-step",
    });

    await screen.findByRole("radiogroup", { name: "AI Provider" });
    expect(screen.queryByTestId("provider-default-hero")).not.toBeInTheDocument();
  });
});
