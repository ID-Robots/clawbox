import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { useProviderCatalog } from "@/hooks/useProviderCatalog";
import { getProviderCatalog } from "@/lib/provider-models";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; every
// component suite that mounts it declares both ceilings (see
// src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-1196, bug #3: opening the desktop chat on a box whose model runs ON the
 * box (llama.cpp, Ollama) asked /setup-api/ai-models/catalog for that provider,
 * and the route — which enumerates remote catalogues only — answered 400
 * "Unknown provider" on every open, provider signal and remount. The chat
 * header had nothing to gain from the request: such a provider has no curated
 * list and never a live one, so the answer was always "no picker".
 *
 * The catalog stub below answers exactly what the old route did, so a request
 * that sneaks back in is caught twice — as a recorded URL and as a 400.
 */

const catalogUrls: string[] = [];

/** A two-model catalogue for the cloud control case, so its picker is real. */
const ANTHROPIC_CATALOG = {
  provider: "anthropic",
  models: [
    { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 200_000 },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200_000 },
  ],
  defaultModelId: "claude-opus-5",
  allowCustom: true,
  fetchedAt: 0,
  source: "live",
};

/** GET /setup-api/chat/model for a one-row OpenClaw box. */
function openclawState(option: Record<string, unknown>, activeModel: string, isLocal: boolean) {
  return {
    activeOptionId: "row-1",
    activeModel,
    activeSource: isLocal ? "local" : "primary",
    activeLabel: option.label,
    options: [{ id: "row-1", available: true, settingsSection: "ai", isLocal, ...option }],
    primary: isLocal
      ? { available: false, label: null, model: null }
      : { available: true, label: option.label, model: activeModel },
    local: isLocal
      ? { available: true, label: option.label, model: activeModel }
      : { available: false, label: null, model: null },
    subscriptionProviders: [],
  };
}

function installFetch(state: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/ai-models/catalog")) {
        catalogUrls.push(url);
        const provider = new URL(url, "http://clawbox.local").searchParams.get("provider");
        if (provider === "anthropic") return { ok: true, status: 200, json: async () => ANTHROPIC_CATALOG };
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: `Unknown provider: ${provider}` }),
        };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => state };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

const providerPill = () => screen.findByRole("button", { name: /^Chat provider:/ });
const modelPill = () => screen.queryByRole("button", { name: /model:/i });

/** Let every effect the header's first render scheduled run to completion. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  catalogUrls.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("opening the chat on a local-model box", () => {
  it.each([
    ["llamacpp", { label: "Gemma 4 Local", model: "llamacpp/gemma4-e2b-it-q4_0", provider: "llamacpp" }],
    ["ollama", { label: "Ollama Local", model: "ollama/llama3.2:3b", provider: "ollama" }],
  ])("never asks the remote catalogue route for %s", async (_provider, row) => {
    installFetch(openclawState(row, row.model, true));
    render(<ChatPopup isOpen onClose={() => {}} />);

    // The header rendered on the local row, so the catalogue hook has run with
    // that provider — the absence below is a decision, not an early assert.
    expect(await providerPill()).toBeTruthy();
    await settle();

    expect(catalogUrls).toEqual([]);
    // Unchanged from before: a provider with no catalogue has no model picker.
    expect(modelPill()).toBeNull();
  });

  it("still loads the catalogue, and its picker, for a cloud provider", async () => {
    // The control: same mount, same stub, a provider the route does enumerate.
    // Without it the case above would pass on a header that had stopped asking
    // for anyone's catalogue.
    installFetch(openclawState(
      { label: "Anthropic", model: "anthropic/claude-opus-5", provider: "anthropic" },
      "anthropic/claude-opus-5",
      false,
    ));
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await providerPill()).toBeTruthy();
    await waitFor(() => expect(modelPill()).toBeTruthy());
    expect(modelPill()).toHaveAccessibleName("Anthropic model: Claude Opus 5");
    expect(catalogUrls.some((url) => url.includes("provider=anthropic"))).toBe(true);
    expect(catalogUrls.every((url) => url.includes("provider=anthropic"))).toBe(true);
  });
});

describe("useProviderCatalog", () => {
  it("answers null for a local provider without a request", async () => {
    installFetch({});
    const { result } = renderHook(() => useProviderCatalog("llamacpp"));
    await settle();

    expect(result.current).toBeNull();
    expect(catalogUrls).toEqual([]);
  });

  it("keeps the curated fallback list for a cloud provider whose catalogue fails", async () => {
    // The fallback lists the brief says must not break: a cloud provider still
    // renders its curated rows at once, and keeps them when the route fails.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        catalogUrls.push(String(input));
        return { ok: false, status: 503, json: async () => ({}) };
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const curated = getProviderCatalog("openai")!;
    const { result } = renderHook(() => useProviderCatalog("openai"));

    expect(result.current?.models.map((m) => m.id)).toEqual(curated.models.map((m) => m.id));
    expect(result.current?.fallback).toBe(true);
    await waitFor(() => expect(catalogUrls).toHaveLength(1));
    await settle();
    expect(result.current?.models.map((m) => m.id)).toEqual(curated.models.map((m) => m.id));
    expect(result.current?.fallback).toBe(true);
    warn.mockRestore();
  });
});
