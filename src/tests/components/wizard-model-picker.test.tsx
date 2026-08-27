// Setup wizard, step 4 "Connect AI Provider" → Anthropic Claude →
// Subscription → the Model picker underneath the authorization code.
//
// Two owner-reported defects, one live first-boot run:
//
//  1. The picker was a native <select>. Closed, it wore the dark theme;
//     OPEN, the browser painted its own popup — white ground, pale text —
//     and the customer could not read the list. Native <option> cannot be
//     themed, so the fix is a real component.
//  2. "Some models like Mythos are not available." Claude Mythos 5 was in
//     the list because the catalogue came from Anthropic's API-key surface,
//     while the customer was on the Subscription tab, whose surface does not
//     carry it. Now the row is still shown — and says why — but cannot be
//     picked, and it can never end up saved as the primary model.
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const strings: Record<string, string> = {
        "ai.model": "Model",
        "ai.modelChange": "Change",
        "ai.modelNeedsApiKey": "Not on subscriptions — needs an API key",
        "ai.modelSubscriptionNote":
          "Greyed-out models are not part of this subscription. Connect an API key instead to use them.",
        "ai.modelCustomToggle": "Enter a custom model ID…",
        "ai.modelCuratedToggle": "Pick from curated list",
        "ai.modelHelp": "You can switch between the curated models from the chat window anytime.",
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

// The live catalogue as a real device returns it: the Anthropic API surface,
// stamped by the catalog route with what the Claude subscription can run.
const CATALOG = {
  provider: "anthropic",
  defaultModelId: "claude-sonnet-4-6",
  allowCustom: true,
  fetchedAt: Date.now(),
  models: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", contextWindow: 1_048_576, availableOnSubscription: true },
    { id: "claude-mythos-5", label: "Claude Mythos 5", contextWindow: 1_000_000, availableOnSubscription: false },
    { id: "claude-fable-5", label: "Claude Fable 5", contextWindow: 1_000_000, availableOnSubscription: false },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000, availableOnSubscription: true },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 200_000, availableOnSubscription: true },
  ],
};

/** Bodies posted to /setup-api/ai-models/configure during a test. */
const configurePosts: Array<Record<string, unknown>> = [];

function stubFetch(catalog: unknown = CATALOG) {
  configurePosts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/setup-api/ai-models/oauth/providers")) {
      return { ok: true, json: async () => ({ providers: ["anthropic"] }) } as Response;
    }
    if (url.includes("/setup-api/ai-models/catalog")) {
      return { ok: true, json: async () => catalog } as Response;
    }
    if (url.includes("/setup-api/ai-models/oauth/start")) {
      return { ok: true, json: async () => ({ url: "https://claude.ai/oauth/authorize" }) } as Response;
    }
    if (url.includes("/setup-api/ai-models/oauth/exchange")) {
      return { ok: true, json: async () => ({ status: "complete" }) } as Response;
    }
    if (url.includes("/setup-api/ai-models/configure")) {
      configurePosts.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, json: async () => ({ success: true }) } as Response;
    }
    if (url.includes("harness")) {
      return { ok: true, json: async () => ({ edition: "openclaw" }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
}

/** Drive the Claude subscription sign-in through to the configure POST. */
async function completeSubscriptionSignIn() {
  fireEvent.click(await screen.findByRole("button", { name: /ai\.anthropicConnect|Connect/i }));
  const code = await screen.findByLabelText(/ai\.anthropicInputLabel|Authorization/i);
  fireEvent.change(code, { target: { value: "auth-code-123" } });
  fireEvent.keyDown(code, { key: "Enter" });
  await waitFor(() => expect(configurePosts.length).toBe(1));
  return configurePosts[0];
}

async function renderAnthropicSubscription() {
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

describe("wizard model picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetch();
  });

  it("opens a themed listbox, not a browser-painted native select", async () => {
    await renderAnthropicSubscription();
    const listbox = await openModelList();
    expect(document.querySelector("select")).toBeNull();
    expect(listbox.className).toContain("header-dropdown-popover--field");
    expect(within(listbox).getAllByRole("option")).toHaveLength(5);
  });

  it("still lists a model the subscription cannot run, and says why", async () => {
    await renderAnthropicSubscription();
    const listbox = await openModelList();
    const mythos = within(listbox).getByRole("option", { name: /Claude Mythos 5/ });
    expect(mythos.getAttribute("aria-disabled")).toBe("true");
    expect(mythos.textContent).toContain("Not on subscriptions — needs an API key");
    // Silently dropping it was the other way to get this wrong.
    expect(within(listbox).getByRole("option", { name: /Claude Fable 5/ })).toBeTruthy();
  });

  it("explains the greyed rows underneath the control", async () => {
    await renderAnthropicSubscription();
    await openModelList();
    expect(
      screen.getByText(/Greyed-out models are not part of this subscription/),
    ).toBeInTheDocument();
  });

  it("selects a model the subscription CAN run", async () => {
    await renderAnthropicSubscription();
    const listbox = await openModelList();
    fireEvent.click(within(listbox).getByRole("option", { name: /Claude Opus 4\.8/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Model:/ }).textContent).toContain("Claude Opus 4.8");
    });
  });

  it("never shows or sends a model the subscription cannot run, even the catalog default", async () => {
    // The id the picker displays is the id the save posts, so a default the
    // credential cannot route must not survive to either. Here the catalogue's
    // own default is off the subscription surface.
    stubFetch({ ...CATALOG, defaultModelId: "claude-mythos-5" });
    await renderAnthropicSubscription();
    // The collapsed summary is the first thing the customer reads, and it is
    // fed by the same derived id the save posts.
    const summary = await screen.findByRole("button", { name: /^Model/ });
    await waitFor(() => {
      expect(summary.textContent).toContain("Claude Opus 4.8");
    });
    expect(summary.textContent).not.toContain("Mythos");

    // And the open list agrees.
    const listbox = await openModelList();
    const active = within(listbox).getAllByRole("option", { selected: true });
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Claude Opus 4.8");
  });

  it("never posts a model the subscription cannot run, not even the catalog default", async () => {
    // The catalogue's own default is off the subscription surface. Neither the
    // picker nor the sign-in may fall back to it.
    stubFetch({ ...CATALOG, defaultModelId: "claude-mythos-5" });
    await renderAnthropicSubscription();
    const body = await completeSubscriptionSignIn();
    expect(body.model).not.toBe("claude-mythos-5");
    expect(body.model).toBe("claude-opus-4-8");
  });

  it("does not resurrect the blocked default through a blank custom-model field", async () => {
    // Custom mode is the power-user escape hatch, but an EMPTY field is not a
    // pick — it falls back to the catalogue, and that fallback has to obey the
    // same rule the picker does.
    stubFetch({ ...CATALOG, defaultModelId: "claude-mythos-5" });
    await renderAnthropicSubscription();
    fireEvent.click(await screen.findByRole("button", { name: /^Model/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Enter a custom model ID/ }));
    const body = await completeSubscriptionSignIn();
    expect(body.model).not.toBe("claude-mythos-5");
    expect(body.model).toBe("claude-opus-4-8");
  });

  it("leaves the whole list pickable when the surface could not be enumerated", async () => {
    // No `availableOnSubscription` anywhere: the device could not ask. Unknown
    // is not "no" — inventing a restriction here would be the same defect
    // wearing the opposite coat.
    stubFetch({
      ...CATALOG,
      models: CATALOG.models.map(({ id, label, contextWindow }) => ({ id, label, contextWindow })),
    });
    await renderAnthropicSubscription();
    const listbox = await openModelList();
    for (const option of within(listbox).getAllByRole("option")) {
      expect(option.getAttribute("aria-disabled")).toBeNull();
    }
    expect(
      screen.queryByText(/Greyed-out models are not part of this subscription/),
    ).not.toBeInTheDocument();
  });
});
