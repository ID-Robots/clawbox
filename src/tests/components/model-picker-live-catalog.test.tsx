// M-05 / TASK-653 — the picker must show the models the BOX reports, not the
// three hard-coded Claude entries in provider-models.ts.
//
// The first catalog read on a cold box is a fallback: the refresh behind
// `/setup-api/ai-models/catalog` takes ~3 minutes on a Jetson, and until it
// lands the route has nothing live to serve. The picker renders the curated
// cold-start list then, which is fine — as long as it goes back and asks
// again. It did not: `useProviderCatalog` fetched once per provider and never
// re-read, so a box whose Anthropic plugin was disabled at boot showed three
// Claude models for the rest of the day while it could run eleven.
//
// Connecting a provider is exactly the moment the catalogue becomes
// enumerable, and the app already has a signal for it —
// `notifyProvidersChanged()` from @/lib/ui-events, which every successful
// configure emits and which the provider-status strip already listens to.
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";
import { notifyProvidersChanged } from "@/lib/ui-events";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const strings: Record<string, string> = {
        "ai.model": "Model",
        "ai.modelChange": "Change",
        "ai.modelNeedsApiKey": "Not on subscriptions — needs an API key",
        "ai.modelCustomToggle": "Enter a custom model ID…",
        "ai.modelCuratedToggle": "Pick from curated list",
      };
      return strings[key] ?? key;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
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

/**
 * What the route serves before any live enumeration has landed: the curated
 * cold-start rows, with NO `source` (they are not the box's answer) and
 * `warming: true` (a fork is out there, so asking again is worth something).
 */
const WARMING = {
  provider: "anthropic",
  models: [
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, near-frontier.", contextWindow: 200_000 },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "Default. Speed + intelligence.", contextWindow: 1_000_000 },
    { id: "claude-opus-5", label: "Claude Opus 5", hint: "Most capable.", contextWindow: 1_000_000 },
  ],
  defaultModelId: "claude-sonnet-5",
  allowCustom: true,
  fetchedAt: 0,
  warming: true,
};

/**
 * `openclaw models list --provider anthropic --all --json` on a 2026.8.1 box,
 * through the catalog route: eleven rows, every one `available`.
 */
const LIVE_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000 },
  { id: "claude-fable-5", label: "Claude Fable 5", contextWindow: 1_000_000 },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", contextWindow: 1_000_000 },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", contextWindow: 1_000_000 },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", contextWindow: 1_000_000 },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", contextWindow: 1_000_000 },
  { id: "claude-mythos-5", label: "Claude Mythos 5", contextWindow: 1_000_000 },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000 },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 200_000 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000 },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (2025-10-01)", contextWindow: 200_000 },
];

const LIVE = {
  provider: "anthropic",
  models: LIVE_MODELS,
  defaultModelId: "claude-sonnet-5",
  allowCustom: true,
  fetchedAt: Date.now(),
  source: "live",
};

/** Every catalog URL the component asked for, in order. */
const catalogUrls: string[] = [];

function stubFetch() {
  catalogUrls.length = 0;
  let catalogCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/setup-api/ai-models/oauth/providers")) {
      return { ok: true, json: async () => ({ providers: ["anthropic"] }) } as Response;
    }
    if (url.includes("/setup-api/ai-models/catalog")) {
      catalogUrls.push(url);
      catalogCalls += 1;
      // The box is still warming when the picker first mounts; the enumeration
      // lands a moment later, exactly as it does after a provider connect.
      return { ok: true, json: async () => (catalogCalls === 1 ? WARMING : LIVE) } as Response;
    }
    if (url.includes("harness")) {
      return { ok: true, json: async () => ({ edition: "openclaw" }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
}

async function renderStep() {
  const view = render(
    <AIModelsStep
      embedded
      providerIds={["anthropic"]}
      defaultProviderId="anthropic"
      title="Connect AI Provider"
      description="Primary provider"
    />,
  );
  await waitFor(() => {
    expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
  });
  return view;
}

/** Expand the collapsed "Model — <name> — Change" summary, then open the list. */
async function openModelList() {
  const summary = await screen.findByRole("button", { name: /^Model/ });
  fireEvent.click(summary);
  const trigger = await screen.findByRole("button", { name: /^Model:/ });
  fireEvent.click(trigger);
  return screen.getByRole("listbox", { name: "Model" });
}

describe("model picker — live catalogue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetch();
  });

  it("re-reads the catalogue when a provider connects, and shows every live row", async () => {
    await renderStep();
    // Cold start: the curated three, because that is all there is yet.
    let listbox = await openModelList();
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);

    // A provider connect is the moment the catalogue becomes enumerable.
    await act(async () => {
      notifyProvidersChanged();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    await waitFor(() => {
      listbox = screen.getByRole("listbox", { name: "Model" });
      expect(within(listbox).getAllByRole("option")).toHaveLength(11);
    }, { timeout: 3000 });

    const labels = within(listbox).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("Claude Fable 5"))).toBe(true);
    expect(labels.some((l) => l.includes("Claude Opus 4.8"))).toBe(true);
    expect(labels.some((l) => l.includes("Claude Mythos 5"))).toBe(true);
  });

  it("asks the route to refresh rather than re-reading the same cached answer", async () => {
    await renderStep();
    await openModelList();

    await act(async () => {
      notifyProvidersChanged();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    await waitFor(() => expect(catalogUrls.length).toBeGreaterThan(1), { timeout: 3000 });
    expect(catalogUrls[catalogUrls.length - 1]).toContain("refresh=1");
  });

  it("keeps asking while the box is still enumerating", async () => {
    // Nothing connects here: the box is simply slow. The picker must not settle
    // on the curated list for the rest of the session because its one fetch
    // happened three minutes too early.
    await renderStep();
    await openModelList();

    await waitFor(() => expect(catalogUrls.length).toBeGreaterThan(1), { timeout: 5000 });
    await waitFor(() => {
      const listbox = screen.getByRole("listbox", { name: "Model" });
      expect(within(listbox).getAllByRole("option")).toHaveLength(11);
    }, { timeout: 5000 });
  });
});
