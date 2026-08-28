import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";

// Resolve against the REAL tables rather than a hand-written map, so this
// breaks if the button stops reading the catalogue or the key goes away.
let locale: "en" | "de" = "en";
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => translations[locale][key] ?? key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * The chat header's close button is an icon and nothing else. Without a name
 * a screen reader announces it as "button" — one of three unlabeled buttons in
 * a row — and the one that dismisses the whole chat is the one the owner most
 * needs to be able to find. The name is the same "Close" every desktop window
 * already carries, so it is translated wherever the window chrome is.
 */

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return { ok: true, json: async () => ({ provider: "openrouter", current: "", reasoning: "medium", providers: [], models: [] }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  locale = "en";
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

describe("chat header close button", () => {
  it("has an accessible name and closes the chat", async () => {
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);
    const close = await screen.findByRole("button", { name: translations.en["window.close"] });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is named in the owner's language, through the window chrome's own key", async () => {
    locale = "de";
    render(<ChatPopup isOpen onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: translations.de["window.close"] })).toBeInTheDocument();
    // Not a second, untranslated "Close" beside it.
    expect(screen.queryByRole("button", { name: translations.en["window.close"] })).not.toBeInTheDocument();
  });
});
