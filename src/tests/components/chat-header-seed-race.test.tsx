import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { HERMES_MODEL_STATE_EVENT } from "@/hooks/useHermesModelOptions";
import { PROVIDER_SIGNAL_DEBOUNCE_MS } from "@/lib/ui-events";

/**
 * The chat header re-seeds whenever a provider is configured, and there are now
 * several places that can fire that signal within a second of each other (a
 * ClawBox AI device login, a return from Hermes' sign-in page, the Save button),
 * on top of the mount seed that may still be in flight.
 *
 * They all hit the same unscoped route, so responses can come back out of order.
 * If a slower EARLIER seed is allowed to write when it finally lands, it
 * reinstates the provider list and device selection the newer one just replaced
 * — the header then names a provider the device is no longer on, which is the
 * same class of failure chat-model-pill-stability.test.tsx exists to prevent.
 *
 * The ordering is the whole point of this test: the first seed is deliberately
 * resolved LAST. Resolving them in order would pass with or without the guard.
 */

type Deferred = { resolve: (body: unknown) => void };

/** A provider payload as the unscoped GET /setup-api/hermes/models returns it. */
function seedBody(provider: string, providers: string[]) {
  return {
    provider,
    current: `${provider}/model-a`,
    reasoning: "medium",
    providers: providers.map((id) => ({ id, name: id, authenticated: true })),
    models: [],
  };
}

/** Queued responses for the unscoped seed route, resolved by hand. */
const pending: Deferred[] = [];

/**
 * Fire the "providers changed" signal and let the shared subscriber's debounce
 * elapse, so this really does start ONE seed.
 *
 * The two signals in these tests have to be spaced. `onProvidersChanged`
 * coalesces a burst into a single refetch on purpose — one key save emits twice,
 * once for the credential and once for the pairing — so two back-to-back
 * dispatches produce one seed and there is no race left to test. Spacing them
 * is also the truer model of what these tests describe: two configures a moment
 * apart, the first one's response still in flight.
 */
async function dispatchSeedSignal() {
  await act(async () => {
    window.dispatchEvent(new Event(HERMES_MODEL_STATE_EVENT));
    await new Promise((resolve) => setTimeout(resolve, PROVIDER_SIGNAL_DEBOUNCE_MS + 50));
  });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      // Scoped (?provider=) is the model hook, not the header seed.
      if (url.includes("/setup-api/hermes/models?")) {
        return {
          ok: true,
          json: async () => ({
            provider: new URL(url, "http://localhost").searchParams.get("provider"),
            authenticated: true,
            models: [],
            defaultModel: "",
            current: "",
            savedElsewhere: null,
            source: "dashboard",
            stale: false,
          }),
        };
      }
      if (url.includes("/setup-api/hermes/models")) {
        const body = await new Promise<unknown>((resolve) => pending.push({ resolve }));
        return { ok: true, json: async () => body };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** Answer the Nth still-unanswered seed request (0 = oldest). */
async function settle(index: number, body: unknown) {
  await act(async () => {
    pending[index].resolve(body);
    await Promise.resolve();
  });
}

const providerPill = () => screen.getByRole("button", { name: /^Chat provider:/ });

beforeEach(() => {
  pending.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  // jsdom ships no layout engine, so the message list's auto-scroll has nothing
  // to call. Unrelated to what is under test here.
  Element.prototype.scrollIntoView = vi.fn();
  // Hermes mode opens no socket, but the component still references the global.
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("overlapping Hermes header seeds", () => {
  it("keeps the newest provider when an earlier seed resolves last", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);

    // Mount seed lands: the device is on OpenRouter.
    await waitFor(() => expect(pending.length).toBe(1));
    await settle(0, seedBody("openrouter", ["openrouter"]));
    await waitFor(() => expect(providerPill()).toHaveAccessibleName("Chat provider: OpenRouter"));

    // Two configures land back to back — two seeds now in flight.
    await dispatchSeedSignal();
    await waitFor(() => expect(pending.length).toBe(2));
    await dispatchSeedSignal();
    await waitFor(() => expect(pending.length).toBe(3));

    // The SECOND (newest) answers first: the device moved to Anthropic.
    await settle(2, seedBody("anthropic", ["openrouter", "anthropic"]));
    await waitFor(() => expect(providerPill()).toHaveAccessibleName("Chat provider: Claude"));

    // Now the FIRST, slower seed finally answers with the pre-configure state.
    // It is stale, so it must not be allowed to drag the header backwards.
    await settle(1, seedBody("openrouter", ["openrouter"]));

    await act(async () => { await Promise.resolve(); });
    expect(providerPill()).toHaveAccessibleName("Chat provider: Claude");
  });

  it("keeps the newest provider LIST when an earlier seed resolves last", async () => {
    // The list is what the dropdown offers: a stale seed winning here means a
    // provider the user just connected disappears again from the picker.
    render(<ChatPopup isOpen onClose={() => {}} />);

    await waitFor(() => expect(pending.length).toBe(1));
    await settle(0, seedBody("openrouter", ["openrouter"]));
    await waitFor(() => expect(providerPill()).toBeTruthy());

    await dispatchSeedSignal();
    await waitFor(() => expect(pending.length).toBe(2));
    await dispatchSeedSignal();
    await waitFor(() => expect(pending.length).toBe(3));

    await settle(2, seedBody("anthropic", ["openrouter", "anthropic", "deepseek"]));
    await settle(1, seedBody("openrouter", ["openrouter"]));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { providerPill().click(); });
    // Both providers the newest seed reported are still on offer. (The selected
    // row carries a trailing check glyph, hence the substring match.)
    expect(screen.getByRole("option", { name: /Anthropic/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /DeepSeek/ })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});
