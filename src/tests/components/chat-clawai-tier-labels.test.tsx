import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";

// The model name is the same across locales. The switch overlay still follows
// the desktop's language, with readable English when no dictionary answers.
const dictionary = vi.hoisted(() => ({ table: null as Record<string, string> | null }));
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => (dictionary.table ?? translations.de)[key] ?? key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const DE = translations.de;

/**
 * An older catalogue still advertises both tiers. Chat no longer fetches this
 * list or offers either subscription tier as a model choice.
 */
const CLAWAI_CATALOG = {
  provider: "clawai",
  models: [
    { id: "deepseek-v4-flash", label: "Free/Pro Tier", contextWindow: 1_000_000, input: "text", hint: "Default. Faster." },
    { id: "deepseek-v4-pro", label: "Max Tier", contextWindow: 1_000_000, input: "text", hint: "1.6T frontier model. Max plan only." },
  ],
  defaultModelId: "deepseek-v4-flash",
  allowCustom: false,
  fetchedAt: Date.now(),
};

/** GET /setup-api/chat/model as the route answers it for a ClawBox AI box. */
function chatModelState(activeModel: string) {
  return {
    activeOptionId: "clawai",
    activeModel,
    activeSource: "primary",
    activeLabel: "ClawBox AI",
    options: [
      {
        id: "clawai",
        label: "ClawBox AI",
        model: activeModel,
        provider: "clawai",
        available: true,
        settingsSection: "ai",
        isLocal: false,
      },
    ],
    primary: { available: true, label: "ClawBox AI", model: activeModel },
    local: { available: false, label: null, model: null },
    subscriptionProviders: [],
  };
}

const ON_PRO = "deepseek/deepseek-v4-pro";
const ON_FLASH = "deepseek/deepseek-v4-flash";

const ENTITLED_STATUS = {
  connected: true,
  provider: "clawai",
  providerLabel: "ClawBox AI",
  mode: "api_key",
  model: ON_PRO,
  clawaiTier: "pro",
  clawaiAccountTier: "pro",
  clawaiAllowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  clawaiConfigured: true,
  tierSource: "portal",
};

/** The same account on a portal whose list POSITIVELY excludes the Max id. */
const REFUSED_STATUS = {
  ...ENTITLED_STATUS,
  clawaiAllowedModels: ["deepseek-v4-flash"],
};

type FetchCall = { url: string; init?: RequestInit };

function installFetch(status: unknown, initialModel = ON_PRO) {
  const calls: FetchCall[] = [];
  let activeModel = initialModel;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/ai-models/catalog")) {
        return { ok: true, json: async () => CLAWAI_CATALOG };
      }
      if (url.includes("/setup-api/ai-models/status")) {
        return { ok: true, json: async () => status };
      }
      if (url.includes("/setup-api/chat/model")) {
        if (init?.method === "POST") {
          activeModel = (JSON.parse(String(init.body)) as { model: string }).model;
        }
        return { ok: true, json: async () => chatModelState(activeModel) };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  return calls;
}

function modelWrites(calls: FetchCall[]): number {
  return calls.filter((call) => call.url.includes("/setup-api/chat/model") && call.init?.method === "POST").length;
}

/** A socket that never connects: the chat sits on its overlays. */
class InertSocket {
  static OPEN = 1;
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}

/**
 * A socket the browser refuses. The constructor throwing is one of the
 * terminal-failure paths that tear the switch overlay down (TASK-712), which
 * is what lets the transcript — and the notice posted into it — be seen.
 */
class RefusedSocket {
  static OPEN = 1;
  constructor() {
    throw new Error("no socket in this test");
  }
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", InertSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
  dictionary.table = null;
});

describe("the chat composer's ClawBox AI model chip on a German desktop", () => {
  it.each([ON_PRO, ON_FLASH])("names no model at all, and no tier, for %s", async (model) => {
    const calls = installFetch(ENTITLED_STATUS, model);
    render(<ChatPopup isOpen onClose={() => {}} />);

    // The provider pill is the header's last word for ClawBox AI. The model
    // name used to sit beside it as a chip nobody could click; it is gone, and
    // everything this test already guarded — no picker, no tier vocabulary, no
    // catalogue fetch, one model write — still holds.
    await screen.findByRole("button", { name: /ClawBox/ });
    expect(screen.queryByText("Flash 4.1")).toBeNull();
    expect(screen.queryByRole("button", { name: /ClawBox AI-Modell/ })).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(calls.filter((call) => call.url.includes("/setup-api/ai-models/catalog"))).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Free\/Pro Tier|Max Tier|Max plan only/);
    expect(document.body.textContent).not.toContain(DE["ai.planNameMax"]);
    await waitFor(() => expect(modelWrites(calls)).toBe(model === ON_PRO ? 1 : 0));
  });
});

describe("the provider-switch overlay on a German desktop", () => {
  it("says what it is doing in the desktop's language", async () => {
    // The automatic switch to the Flash alias raises the overlay, and with a
    // socket that never answers it stays up — which is where the owner reads it.
    const calls = installFetch(REFUSED_STATUS);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(modelWrites(calls)).toBe(1));

    await screen.findByText(DE["chat.switchingProvider"]);
    expect(screen.getByText(DE["chat.reloadMayTake"])).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(DE["chat.reloadProgress"]);
    expect(document.body.textContent).not.toMatch(/Switching AI provider|This may take up to 30 seconds/);
  });

  it("falls back to the English words, never the keys, where no locale answers", async () => {
    // With no I18nProvider above it `useT` answers every key as itself. Three
    // regression tests render the chat that way and pin a terminal socket
    // failure tearing this overlay DOWN by asserting "Switching AI provider"
    // is not on screen (TASK-712) — a raw key here would make that assertion
    // pass with the overlay stuck, so the English floor is load-bearing.
    dictionary.table = {};
    const calls = installFetch(REFUSED_STATUS);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(modelWrites(calls)).toBe(1));

    await screen.findByText("Switching AI provider...");
    expect(screen.getByText("This may take up to 30 seconds")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe("Reload progress");
    expect(document.body.textContent).not.toContain("chat.switchingProvider");
    expect(document.body.textContent).not.toContain("chat.reloadMayTake");
  });
});

describe("the automatic switch to Flash on a German desktop", () => {
  it("switches quietly, with no model chip and no Max subscription upsell", async () => {
    vi.stubGlobal("WebSocket", RefusedSocket);
    const calls = installFetch(REFUSED_STATUS);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(modelWrites(calls)).toBe(1));
    // The write above is the synchronisation point the model name used to be.
    await screen.findByRole("button", { name: /ClawBox/ });
    expect(screen.queryByText("Flash 4.1")).toBeNull();
    const write = calls.find((call) => call.init?.method === "POST" && call.url.includes("/setup-api/chat/model"));
    expect(JSON.parse(String(write?.init?.body))).toEqual({ model: ON_FLASH, automatic: true });
    expect(screen.queryByRole("button", { name: /ClawBox AI-Modell/ })).toBeNull();
    expect(document.body.textContent).not.toContain(DE["ai.planNameMax"]);
    expect(document.body.textContent).not.toContain("deepseek-v4-pro");
    expect(document.body.textContent).not.toMatch(/requires a Max subscription|Staying on the current model/);
    expect(modelWrites(calls)).toBe(1);
  });
});
