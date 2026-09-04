import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@/tests/helpers/test-utils";
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
 * A status answer whose BADGE and ENTITLEMENT disagree.
 *
 * CONSTRUCTED, and say so: the only device-info response measured on hardware
 * (2026-09-04, Max box) has them agreeing —
 *   {"tier":"max","deviceTier":"pro",
 *    "allowedModels":["deepseek-v4-flash","deepseek-v4-pro",…],
 *    "defaultModel":"deepseek-v4-pro", …}
 * The disagreement is what the gate exists to get right: `deviceTier` is the
 * tier this DEVICE defaults to (the configure route keeps "a Max subscriber
 * who runs Flash on this box" working on purpose, TASK-481), so a badge of
 * "flash" beside an entitlement list carrying the Pro id is a device default
 * next to an account permission — and only the second one may refuse a pick.
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

/** What the route answers once the box has been moved to the Flash tier. */
const ON_FLASH = {
  ...ON_PRO,
  activeModel: "deepseek/deepseek-v4-flash",
  primary: { available: true, label: "ClawBox AI", model: "deepseek/deepseek-v4-flash" },
};

/** The same account, on a portal whose list POSITIVELY excludes the Max id. */
const REFUSED_STATUS = {
  ...ENTITLED_STATUS,
  clawaiAllowedModels: ["deepseek-v4-flash"],
};

type FetchCall = { url: string; init?: RequestInit };

function installFetch(
  statusResponder: () => Promise<unknown>,
  /** Answer for the model WRITE only; the GET always reports `ON_PRO`. */
  modelPostResponder?: () => Promise<unknown>,
) {
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
        if (init?.method === "POST" && modelPostResponder) return modelPostResponder();
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

/** How many times `needle` appears in the rendered transcript. */
function occurrences(needle: string): number {
  return (document.body.textContent ?? "").split(needle).length - 1;
}

/**
 * Wait until the guard has had its chance.
 *
 * A "no POST happened" assertion is only worth anything against a window a
 * POST demonstrably fits inside — so the refusal case below asserts its POST
 * has ALREADY landed after this same helper, with no waitFor of its own. That
 * is the positive control: one settle, one POST when the portal refuses, none
 * when it does not.
 */
async function settle(calls: FetchCall[]) {
  await waitFor(() => {
    expect(calls.some((call) => call.url.includes("/setup-api/ai-models/status"))).toBe(true);
  });
  await waitFor(() => {
    expect(calls.some((call) => call.url.includes("/setup-api/chat/model"))).toBe(true);
  });
  // Generous next to the guard's chain (one effect turn, then the fetch): the
  // point of the window is that it cannot be the reason a POST is missing.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
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
    // Reading the device default as an entitlement told a paying Max owner he
    // needed a Max subscription and moved his box off the model he had just
    // picked in Telegram.
    const calls = installFetch(async () => ({ ok: true, json: async () => ENTITLED_STATUS }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Max subscription/i);
  });

  it("still drops to Flash when the portal really does refuse it", async () => {
    // The protection this replaces is real: on an unentitled account the proxy
    // answers every turn `400 "Model not allowed: …"` (measured 2026-09-04),
    // which the chat can only render as the opaque "[assistant turn failed]".
    // A NAMED refusal keeps the upgrade prompt and the drop to Flash.
    const calls = installFetch(async () => ({ ok: true, json: async () => REFUSED_STATUS }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    // No waitFor: this is the positive control for the two negative tests —
    // the POST is already there after the same settle() they assert emptiness
    // after. (The upgrade message itself goes into the transcript, which the
    // "Switching AI provider…" overlay covers for the whole of the switch.)
    expect(modelWrites(calls)).toEqual(['{"model":"deepseek/deepseek-v4-flash"}']);
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

describe("the boot guard when the switch it asks for fails", () => {
  it("POSTs once, says only what happened, and does not re-arm", async () => {
    // TWO defects in one path, both of them the guard's failure leg.
    //
    // Re-entry: `switchChatModel` writes `switchingModel`, which is one of its
    // OWN useCallback deps, so calling it changes its identity — and this
    // effect depends on that identity. The once-only latch is what stops the
    // guard re-entering; releasing it because the switch FAILED re-arms it
    // with nothing about the box changed. Every deterministic failure of
    // `/setup-api/chat/model` (400 "provider is not configured", 400 "invalid
    // model identifier", 409, 500, a proxy's non-JSON body) then loops: POST,
    // fail, release, re-enter — hundreds of writes against the box's own setup
    // server and two system messages per turn of it, for as long as the chat
    // window is open.
    //
    // False success: "switching you to Pro Tier so chat keeps working" was
    // posted BEFORE the switch was attempted, so a failed one left the
    // transcript claiming the box had been moved, directly above the `Error:`
    // line saying it had not, with the box still on the refused model.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    const calls = installFetch(
      async () => ({ ok: true, json: async () => REFUSED_STATUS }),
      async () => {
        writes += 1;
        if (writes > 1) {
          // Reached only by a re-armed guard. Answering the SECOND write
          // successfully is what lets this test fail with an assertion rather
          // than a five-second timeout: two failures in a row loop past 250
          // writes in 200 ms and the renderer never catches up.
          return { ok: true, json: async () => ON_FLASH };
        }
        // The first write is HELD until the test lets it go, and that is what
        // makes the mock faithful rather than slow. A real POST takes long
        // enough for React to commit the `switchingModel = true` render (the
        // one that raises the "Switching AI provider…" overlay); a mock that
        // settles inside the same microtask never commits it, so the callback
        // identity never changes and the re-entry above stays invisible.
        await held;
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "Selected AI provider is not configured" }),
        };
      },
    );
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => { expect(modelWrites(calls)).toHaveLength(1); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    release();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(modelWrites(calls)).toEqual(['{"model":"deepseek/deepseek-v4-flash"}']);
    // The failure is reported once, as itself…
    expect(occurrences("Selected AI provider is not configured")).toBe(1);
    // …and nothing claims the box was moved off the model it is still on.
    expect(document.body.textContent).not.toMatch(/needs a Max subscription/i);
  });
});
