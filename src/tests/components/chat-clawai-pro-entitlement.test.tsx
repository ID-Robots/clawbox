import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@/tests/helpers/test-utils";
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
 * A box running the ClawBox AI Max model, picked from the Telegram `/model`
 * keyboard. `activeModel` is what the gateway is really on; the chat header
 * only reads it.
 */
const ON_PRO = {
  activeOptionId: "clawai",
  activeModel: "deepseek/deepseek-v4-pro",
  activeSource: "primary",
  activeLabel: "ClawBox AI",
  options: [
    {
      id: "clawai",
      label: "ClawBox AI",
      model: "deepseek/deepseek-v4-pro",
      provider: "clawai",
      available: true,
      settingsSection: "ai",
      isLocal: false,
    },
    {
      id: "openai/gpt-5.4",
      label: "OpenAI GPT",
      model: "openai/gpt-5.4",
      provider: "openai",
      available: true,
      settingsSection: "ai",
      isLocal: false,
    },
  ],
  primary: { available: true, label: "ClawBox AI", model: "deepseek/deepseek-v4-pro" },
  local: { available: false, label: null, model: null },
  subscriptionProviders: [],
};

/**
 * The portal's answer for the paired token, as `/api/clawbox-ai/device-info`
 * really serves it (measured on a Max box, 2026-09-04):
 *   {"tier":"max","deviceTier":"pro",
 *    "allowedModels":["deepseek-v4-flash","deepseek-v4-pro",…],
 *    "defaultModel":"deepseek-v4-pro", …}
 *
 * `deviceTier` is the model the device currently defaults to, NOT what the
 * plan entitles — a Max account whose box was paired while it was on the Pro
 * plan is still stamped `flash`, so the badge tier reads "flash" while the
 * entitlement list still carries the Pro id.
 */
const ENTITLED_STATUS = {
  connected: true,
  provider: "clawai",
  providerLabel: "ClawBox AI",
  mode: "api_key",
  model: "deepseek/deepseek-v4-pro",
  clawaiTier: "flash",
  clawaiAccountTier: "flash",
  clawaiAllowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  clawaiConfigured: true,
  tierSource: "portal",
};

type FetchCall = { url: string; init?: RequestInit };

function installFetch(statusResponder: () => Promise<unknown>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/ai-models/status")) {
        return statusResponder();
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ON_PRO };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  return calls;
}

function modelWrites(calls: FetchCall[]): string[] {
  return calls
    .filter((call) => call.url.includes("/setup-api/chat/model") && call.init?.method === "POST")
    .map((call) => String(call.init?.body ?? ""));
}

/** Let every effect chain the status poll can start run to completion. */
async function settle(calls: FetchCall[]) {
  await waitFor(() => {
    expect(calls.some((call) => call.url.includes("/setup-api/ai-models/status"))).toBe(true);
  });
  await waitFor(() => {
    expect(calls.some((call) => call.url.includes("/setup-api/chat/model"))).toBe(true);
  });
  // Two macrotask turns: the guard's own effect, then the POST it would fire.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
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

describe("a ClawBox AI Pro model the account is entitled to", () => {
  it("is left running when the portal lists it, whatever the device-tier badge says", async () => {
    // The badge tier is the device-pair stamp, not the entitlement. Reading it
    // as one told a paying Max owner he needed a Max subscription and moved
    // his box off the model he had just picked in Telegram.
    const calls = installFetch(async () => ({ ok: true, json: async () => ENTITLED_STATUS }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Max subscription/i);
  });

  it("still drops to Flash when the portal really does refuse it", async () => {
    // The protection this replaces is real: an unentitled Pro pick is
    // downgraded to flash by the proxy's live-tier reconcile, so every reply
    // comes from a model the header does not name. A NAMED refusal keeps the
    // upgrade prompt and the switch.
    const calls = installFetch(async () => ({
      ok: true,
      json: async () => ({
        ...ENTITLED_STATUS,
        clawaiAllowedModels: ["deepseek-v4-flash"],
      }),
    }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    // The switch itself is the assertion: the upgrade message is posted into
    // the transcript, which the "Switching AI provider…" overlay covers for
    // the whole of the switch it just started.
    await waitFor(() => {
      expect(modelWrites(calls)).toEqual(['{"model":"deepseek/deepseek-v4-flash"}']);
    });
  });

  it("is left running when the entitlement could not be read at all", async () => {
    // A failed status poll is "I don't know", not "you are not entitled" —
    // and the box's model is not something to rewrite on a question that
    // never got an answer.
    const calls = installFetch(async () => {
      throw new Error("network down");
    });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Max subscription/i);
  });
});
