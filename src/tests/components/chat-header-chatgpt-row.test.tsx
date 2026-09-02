import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => translations.en[key] ?? key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * The ChatGPT subscription is the `codex` ROW and the `openai/<id>` MODEL.
 *
 * `codex` survives as the UI id — the label, the catalogue, the reasoning
 * table all hang off it — while OpenClaw 2 resolves the subscription only
 * under `openai/`. Every place the header turns a row into a model id (or back)
 * has to bridge those two, and the one that did not silently removed the model
 * dropdown from every ChatGPT box: the only surface an owner has to move
 * between GPT-5.5 / GPT-5.4 / GPT-5.6-Sol after setup.
 */

const CODEX_CATALOG = {
  provider: "codex",
  models: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", contextWindow: 400_000, availableOnSubscription: true },
    { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 400_000, availableOnSubscription: true },
    { id: "gpt-5.4", label: "GPT-5.4", contextWindow: 1_000_000, availableOnSubscription: true },
    { id: "gpt-5.5-pro", label: "GPT-5.5 Pro", contextWindow: 400_000, availableOnSubscription: false },
  ],
  defaultModelId: "gpt-5.5",
  allowCustom: true,
  fetchedAt: Date.now(),
};

/** GET /setup-api/chat/model as the route answers it for a ChatGPT box. */
function chatModelState(overrides: Record<string, unknown> = {}) {
  return {
    activeOptionId: "openai/gpt-5.4",
    activeModel: "openai/gpt-5.4",
    activeSource: "primary",
    activeLabel: "OpenAI Codex",
    options: [
      {
        id: "openai/gpt-5.4",
        label: "OpenAI Codex",
        model: "openai/gpt-5.4",
        provider: "codex",
        available: true,
        settingsSection: "ai",
        isLocal: false,
      },
    ],
    primary: { available: true, label: "OpenAI Codex", model: "openai/gpt-5.4" },
    local: { available: false, label: null, model: null },
    subscriptionProviders: ["codex", "openai"],
    ...overrides,
  };
}

function installFetch(state: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/ai-models/catalog")) {
        return { ok: true, json: async () => CODEX_CATALOG };
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

describe("the chat header on a ChatGPT-subscription box", () => {
  it("still offers the model dropdown when the active model is openai/<id>", async () => {
    installFetch(chatModelState());
    render(<ChatPopup isOpen onClose={() => {}} />);

    // The row's provider is the UI id `codex`; the model it is running is
    // `openai/gpt-5.4`. Comparing the two verbatim answers "not this
    // provider's model" and the switcher disappears.
    const trigger = await screen.findByRole("button", { name: /OpenAI Codex model/i });
    expect(trigger.textContent).toContain("GPT-5.4");
  });

  it("switches to another ChatGPT model from that dropdown", async () => {
    installFetch(chatModelState());
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /OpenAI Codex model/i });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const row = screen.getAllByRole("option").find((option) =>
      option.querySelector(".header-dropdown-option-label")?.textContent === "GPT-5.5");
    fireEvent.click(row!);

    await waitFor(() => {
      const posted = vi.mocked(fetch).mock.calls.find(([url, init]) =>
        String(url).includes("/setup-api/chat/model")
        && (init as RequestInit | undefined)?.method === "POST");
      expect(posted).toBeTruthy();
      expect(JSON.parse(String((posted![1] as RequestInit).body))).toMatchObject({
        model: "codex/gpt-5.5",
        provider: "codex",
      });
    });
  });

  it("greys the API-key-only tiers on the ChatGPT row", async () => {
    installFetch(chatModelState());
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /OpenAI Codex model/i });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const pro = screen.getAllByRole("option").find((option) =>
      option.querySelector(".header-dropdown-option-label")?.textContent === "GPT-5.5 Pro");
    expect(pro?.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("a ChatGPT sign-in this core cannot use", () => {
  const staleState = chatModelState({
    activeOptionId: "clawai/deepseek-v4-flash",
    activeModel: "deepseek/deepseek-v4-flash",
    activeLabel: "ClawBox AI",
    options: [
      {
        id: "clawai/deepseek-v4-flash",
        label: "ClawBox AI",
        model: "deepseek/deepseek-v4-flash",
        provider: "clawai",
        available: true,
        settingsSection: "ai",
        isLocal: false,
      },
      {
        id: "openai/gpt-5.5",
        label: "OpenAI Codex",
        model: "openai/gpt-5.5",
        provider: "codex",
        available: false,
        reauthRequired: true,
        settingsSection: "ai",
        isLocal: false,
      },
    ],
    subscriptionProviders: [],
  });

  it("says the sign-in is stale, not that the provider was never set up", async () => {
    installFetch(staleState);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /Chat provider/i });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const row = screen.getAllByRole("option").find((option) =>
      option.textContent?.includes("OpenAI Codex"));

    // "Set up in Settings" sends the owner to re-enter a credential the box
    // already has. The one thing that fixes this box is signing in again.
    expect(row?.textContent).toContain("Sign in again");
  });

  it("tells the owner to sign in again when the greyed row is clicked", async () => {
    installFetch(staleState);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /Chat provider/i });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const row = screen.getAllByRole("option").find((option) =>
      option.textContent?.includes("OpenAI Codex"));
    fireEvent.click(row!);

    await waitFor(() => {
      expect(screen.getByText(/sign in again/i)).toBeTruthy();
    });
  });
});
