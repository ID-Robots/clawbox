import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";

// Resolve against the REAL English table rather than a hand-written map, so
// this test breaks if the header stops reusing the wizard's own copy.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => translations.en[key] ?? key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/** The one string both pickers put on a row the subscription cannot run. */
const NEEDS_API_KEY = translations.en["ai.modelNeedsApiKey"];

/**
 * The chat header's inline model switcher and the setup wizard's picker read
 * the SAME catalogue, stamped by the same route with the same
 * `availableOnSubscription` flag — and only the wizard obeyed it.
 *
 * The wizard's own help line sends the customer here ("switch between the
 * curated models from the chat window anytime"), so the unfiltered surface was
 * the one it advertised: on a Claude-subscription box the header offered
 * Claude Mythos 5 / Claude Fable 5, which the `claude-cli` surface does not
 * carry, as ordinary pickable rows.
 *
 * The header does not hide them — a silently missing row is the same lie in
 * the other direction. It greys them out and says why, exactly as the wizard
 * does.
 */

const ANTHROPIC_CATALOG = {
  provider: "anthropic",
  models: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 200_000, availableOnSubscription: true },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", contextWindow: 1_000_000, availableOnSubscription: true },
    { id: "claude-fable-5", label: "Claude Fable 5", contextWindow: 1_000_000, availableOnSubscription: false },
    { id: "claude-mythos-5", label: "Claude Mythos 5", contextWindow: 1_000_000, availableOnSubscription: false },
  ],
  defaultModelId: "claude-sonnet-4-6",
  allowCustom: true,
  fetchedAt: Date.now(),
};

/** GET /setup-api/chat/model as the route answers it for a Claude box. */
function chatModelState(subscriptionProviders: string[]) {
  return {
    activeOptionId: "anthropic/claude-sonnet-4-6",
    activeModel: "anthropic/claude-sonnet-4-6",
    activeSource: "primary",
    activeLabel: "Anthropic Claude",
    options: [
      {
        id: "anthropic/claude-sonnet-4-6",
        label: "Anthropic Claude",
        model: "anthropic/claude-sonnet-4-6",
        provider: "anthropic",
        available: true,
        settingsSection: "ai",
        isLocal: false,
      },
    ],
    primary: { available: true, label: "Anthropic Claude", model: "anthropic/claude-sonnet-4-6" },
    local: { available: false, label: null, model: null },
    subscriptionProviders,
  };
}

function installFetch(subscriptionProviders: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/ai-models/catalog")) {
        return { ok: true, json: async () => ANTHROPIC_CATALOG };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => chatModelState(subscriptionProviders) };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** Open the model pill and return its listbox rows, keyed by label. */
async function openModelPicker() {
  const trigger = await screen.findByRole("button", { name: /Anthropic Claude model/i });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
  const rows = new Map<string, HTMLElement>();
  for (const row of screen.getAllByRole("option")) {
    const label = row.querySelector(".header-dropdown-option-label")?.textContent ?? "";
    rows.set(label, row as HTMLElement);
  }
  return rows;
}

beforeEach(() => {
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

describe("the chat header's model picker on a Claude-subscription box", () => {
  it("greys out the models the subscription surface cannot run", async () => {
    installFetch(["anthropic"]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const rows = await openModelPicker();
    expect(rows.get("Claude Fable 5")?.getAttribute("aria-disabled")).toBe("true");
    expect(rows.get("Claude Mythos 5")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("says WHY, rather than leaving a silently dead row", async () => {
    installFetch(["anthropic"]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const rows = await openModelPicker();
    expect(rows.get("Claude Fable 5")?.textContent).toContain(NEEDS_API_KEY);
    // Same wording the wizard uses, not a lookalike written for this surface.
    expect(NEEDS_API_KEY).toContain("needs an API key");
  });

  it("still SHOWS them — a missing row is the same lie in the other direction", async () => {
    installFetch(["anthropic"]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const rows = await openModelPicker();
    expect(rows.has("Claude Fable 5")).toBe(true);
    expect(rows.has("Claude Mythos 5")).toBe(true);
  });

  it("refuses to switch onto one when it is clicked", async () => {
    installFetch(["anthropic"]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const rows = await openModelPicker();
    fireEvent.click(rows.get("Claude Fable 5")!);

    // No POST may leave the browser for a model the box has just been told it
    // cannot run — the picker must not lean on the server guard to say no.
    await waitFor(() => {
      const posted = vi.mocked(fetch).mock.calls.some(([url, init]) =>
        String(url).includes("/setup-api/chat/model")
        && (init as RequestInit | undefined)?.method === "POST");
      expect(posted).toBe(false);
    });
  });

  it("leaves every model pickable on an API-key box", async () => {
    installFetch([]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const rows = await openModelPicker();
    expect(rows.get("Claude Fable 5")?.getAttribute("aria-disabled")).toBeNull();
    expect(rows.get("Claude Mythos 5")?.getAttribute("aria-disabled")).toBeNull();
  });
});
