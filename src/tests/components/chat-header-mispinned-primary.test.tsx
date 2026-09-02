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
 * A box whose `agents.defaults.model.primary` is the ClawBox AI image entry.
 *
 * An older ClawBox build could write it: the chat dropdown represented OpenAI
 * by `models.providers.openai.models[0]`, which on a paired box IS the image
 * row. Every turn on it fails, and the recovery this PR relies on is "the
 * owner picks a model again". That gesture has to actually work.
 *
 * The route answers `activeOptionId: null` — no option carries that model any
 * more — while `activeModel` still names it, because the gateway really is
 * running it. The header must not paper over that.
 */
const MIS_PINNED = {
  activeOptionId: null,
  activeModel: "openai/gpt-image-1-mini",
  activeSource: "primary",
  activeLabel: null,
  options: [
    {
      id: "deepseek/deepseek-v4-flash",
      label: "ClawBox AI",
      model: "deepseek/deepseek-v4-flash",
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
  primary: { available: true, label: "ClawBox AI", model: "deepseek/deepseek-v4-flash" },
  local: { available: false, label: null, model: null },
  subscriptionProviders: [],
};

/** The same state after the owner's pick lands: the box is on a chat model. */
const RECOVERED = {
  ...MIS_PINNED,
  activeOptionId: "deepseek/deepseek-v4-flash",
  activeModel: "deepseek/deepseek-v4-flash",
  activeLabel: "ClawBox AI",
};

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        // The route answers a successful switch with the WHOLE new state, and
        // ChatPopup sets it straight into `chatModelState`. A stub that
        // returned `{ success: true }` left `options` undefined and crashed
        // the header's `options.find` — the mock has to answer like the route.
        if (init?.method === "POST") return { ok: true, json: async () => RECOVERED };
        return { ok: true, json: async () => MIS_PINNED };
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

describe("the chat header on a box pinned to a model no row carries", () => {
  it("does not claim the first provider in the list is the active one", async () => {
    // `activeOptionId ?? options[0].id` named ClawBox AI while the gateway was
    // running openai/gpt-image-1-mini and every turn failed. Ordering puts
    // ClawBox AI first on every paired box, so the header was confidently
    // wrong on exactly the boxes that needed the truth.
    installFetch();
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /Chat provider/i });
    // Assert the TRUTH is shown, not merely that the lie is absent: an empty
    // or missing label would satisfy the negatives below on its own.
    await waitFor(() => {
      expect(trigger.textContent).toContain(translations.en["chat.noChatModel"]);
    });
    // The pill renders the provider's short name ("ClawBox"); naming any
    // healthy provider here is the lie, whatever its wording.
    expect(trigger.textContent).not.toContain("ClawBox");
    expect(trigger.textContent).not.toContain("OpenAI");
  });

  it("posts when the owner picks a provider row, even the one shown", async () => {
    // HeaderDropdown fires onChange only when the pick differs from `value`.
    // With `value` defaulted to options[0], clicking that same row — the
    // owner's most natural recovery gesture — was swallowed and the box
    // stayed mute.
    installFetch();
    render(<ChatPopup isOpen onClose={() => {}} />);

    const trigger = await screen.findByRole("button", { name: /Chat provider/i });
    fireEvent.click(trigger);
    const rows = await screen.findAllByRole("option");
    const clawai = rows.find((row) => (row.textContent ?? "").includes("ClawBox AI"));
    expect(clawai).toBeDefined();
    fireEvent.click(clawai!);

    await waitFor(() => {
      const posted = vi.mocked(fetch).mock.calls.some(([url, init]) =>
        String(url).includes("/setup-api/chat/model")
        && (init as RequestInit | undefined)?.method === "POST");
      expect(posted).toBe(true);
    });
  });
});
