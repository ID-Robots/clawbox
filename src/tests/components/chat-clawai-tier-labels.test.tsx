import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";

// The GERMAN table, deliberately. The defect was English words on a German
// desktop — the chip said "Max Tier" while Settings said "Max-Tarif" (the UI
// sweep of 2026-09-07) — and a test resolving against the English table would
// pass with the literals still in place. One test swaps in an EMPTY table —
// every key answered as itself, which is what `useT` does with no
// I18nProvider above the component — to pin the English floor.
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
 * The catalogue route's own rows for ClawBox AI — English words and all,
 * exactly as `CLAWAI_STATIC_MODELS` serves them. The picker has to translate
 * these itself: the route knows no locale.
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

function installFetch(status: unknown) {
  const calls: FetchCall[] = [];
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
        // The boot guard's write lands the box on Flash; every read before it
        // reports the Max model the box booted on.
        if (init?.method === "POST") return { ok: true, json: async () => chatModelState(ON_FLASH) };
        return { ok: true, json: async () => chatModelState(ON_PRO) };
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

/**
 * The halves of a transcript notice around its `[text](url)` link — the link
 * renders as its text, so the words on either side are what the body shows.
 */
function aroundLink(notice: string): { before: string; after: string } {
  return {
    before: notice.slice(0, notice.indexOf("[")).trim(),
    after: notice.slice(notice.indexOf(")") + 1).trim(),
  };
}

describe("the chat composer's ClawBox AI model chip on a German desktop", () => {
  it("names the active tier the way Settings does, not with the catalogue's English words", async () => {
    installFetch(ENTITLED_STATUS);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /ClawBox AI-Modell/ });
    await waitFor(() => expect(trigger.textContent).toContain(DE["ai.planNameMax"]));
    expect(trigger.textContent).not.toContain("Max Tier");
  });

  it("draws both rows of the menu, label and hint, in the desktop's language", async () => {
    installFetch(ENTITLED_STATUS);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /ClawBox AI-Modell/ });
    await waitFor(() => expect(trigger.textContent).toContain(DE["ai.planNameMax"]));
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    const rows = screen.getAllByRole("option").map((row) => ({
      label: row.querySelector(".header-dropdown-option-label")?.textContent,
      hint: row.querySelector(".header-dropdown-option-hint")?.textContent,
    }));
    expect(rows).toEqual([
      { label: DE["ai.clawboxTierFlash"], hint: DE["ai.clawboxTierFlashHint"] },
      { label: DE["ai.planNameMax"], hint: DE["ai.clawboxTierMaxHint"] },
    ]);
    expect(document.body.textContent).not.toMatch(/Free\/Pro Tier|Max Tier|Max plan only/);
  });
});

describe("the provider-switch overlay on a German desktop", () => {
  it("says what it is doing in the desktop's language", async () => {
    // The boot guard's automatic drop to Flash raises the overlay, and with a
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

describe("a pick of the Max row the portal refuses, on a German desktop", () => {
  it("refuses in the desktop's language, naming the tier the row showed rather than its id", async () => {
    vi.stubGlobal("WebSocket", RefusedSocket);
    const calls = installFetch(REFUSED_STATUS);
    render(<ChatPopup isOpen onClose={() => {}} />);
    // The boot guard has moved the box to Flash: the chip says so, and the
    // Max row is now a pick rather than the active model.
    await waitFor(() => expect(modelWrites(calls)).toBe(1));
    const trigger = await screen.findByRole("button", { name: /ClawBox AI-Modell/ });
    await waitFor(() => expect(trigger.textContent).toContain(DE["ai.clawboxTierFlash"]));

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const maxRow = screen.getAllByRole("option").find(
      (row) => row.querySelector(".header-dropdown-option-label")?.textContent === DE["ai.planNameMax"],
    );
    expect(maxRow).toBeTruthy();
    fireEvent.click(maxRow!);

    // The refusal as the catalogue words it, with the tier the row was drawn
    // with in the {model} slot — never "deepseek-v4-pro", which the menu
    // never showed — and no write, because the pick was refused HERE.
    const { before, after } = aroundLink(
      DE["chat.modelNeedsMax"].replaceAll("{model}", DE["ai.planNameMax"]).replaceAll("{url}", PORTAL_DASHBOARD_URL),
    );
    expect(before).toContain(DE["ai.planNameMax"]);
    await waitFor(() => expect(document.body.textContent).toContain(before));
    expect(document.body.textContent).toContain(after);
    expect(document.body.textContent).not.toContain("deepseek-v4-pro");
    expect(document.body.textContent).not.toMatch(/requires a Max subscription|Staying on the current model/);
    expect(modelWrites(calls)).toBe(1);
  });
});

describe("the automatic drop to Flash on a German desktop", () => {
  it("explains itself with the tiers' Settings names", async () => {
    vi.stubGlobal("WebSocket", RefusedSocket);
    const calls = installFetch(REFUSED_STATUS);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(modelWrites(calls)).toBe(1));

    // The sentence as the catalogue words it, with the tiers filled in; the
    // portal link renders as its text, so the halves around it are what the
    // transcript shows.
    const { before, after } = aroundLink(
      DE["chat.maxTierDowngraded"]
        .replaceAll("{max}", DE["ai.planNameMax"])
        .replaceAll("{flash}", DE["ai.clawboxTierFlash"])
        .replaceAll("{url}", PORTAL_DASHBOARD_URL),
    );
    expect(before).toContain(DE["ai.planNameMax"]);
    expect(after).toContain(DE["ai.clawboxTierFlash"]);

    await waitFor(() => expect(document.body.textContent).toContain(before));
    expect(document.body.textContent).toContain(after);
    expect(document.body.textContent).not.toMatch(/Max Tier|Pro Tier/);
  });
});
