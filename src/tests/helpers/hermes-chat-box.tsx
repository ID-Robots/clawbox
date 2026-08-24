import { expect, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";

/**
 * A box that runs Hermes and no gateway, as the chat surface sees it.
 *
 * Every Hermes chat test needs the same four routes answered —
 * `/setup-api/harness/active`, `/setup-api/chat/capabilities`,
 * `/setup-api/hermes/models` and `/setup-api/hermes/chat` — and the same
 * refusal to open a socket. Written out per file, that contract drifts: one
 * copy gets updated with the route and the other keeps asserting against a
 * shape the product no longer has, while still passing.
 *
 * The returned object is LIVE. `facts` may be changed before `mountHermesChat`
 * to describe a different box, because that is the interesting axis: what
 * differs between two devices of the same edition.
 */
export const HERMES_SESSION = "20260810_221825_609d1e";

export interface HermesBox {
  /** Bodies POSTed to the Hermes chat route, in order. */
  chatPosts: Record<string, unknown>[];
  /** Every URL the surface fetched, so an upload can be asserted absent. */
  fetchedUrls: string[];
  /** A box with no gateway must never open a socket. */
  socketsOpened: number;
  /** What this particular device can do. Change before mounting. */
  facts: { hasClawaiToken: boolean; hermesSupportsImages: boolean };
}

/**
 * Stub `fetch` and `WebSocket` for one Hermes box.
 *
 * @param reply what the chat route answers for a given outbound message;
 *   defaults to a fixed line, which is all most cases need.
 */
export function installHermesBox(reply: (message: string) => string = () => "hello back"): HermesBox {
  const box: HermesBox = {
    chatPosts: [],
    fetchedUrls: [],
    socketsOpened: 0,
    // The default device is a customer on their own provider key: no ClawBox
    // AI credential, so nothing on it can turn a recording into text.
    facts: { hasClawaiToken: false, hermesSupportsImages: false },
  };

  class ForbiddenWs {
    static readonly OPEN = 1;
    readyState = ForbiddenWs.OPEN;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      box.socketsOpened += 1;
    }
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      box.fetchedUrls.push(url);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/chat/capabilities")) {
        return { ok: true, json: async () => ({ harness: "hermes", facts: box.facts }) };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return {
          ok: true,
          json: async () => ({
            providers: [{ id: "clawlocal", name: "On this box", authenticated: true }],
            // The scoped form of this route (?provider=…) answers the model
            // pill; one model means no pill, which is the plain case here.
            models: [{ id: "gemma", name: "Gemma" }],
            provider: "clawlocal",
            current: "gemma",
            defaultModel: "gemma",
            reasoning: "off",
          }),
        };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/chat/spoken-history")) {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      if (url.includes("/setup-api/hermes/chat")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        box.chatPosts.push(body);
        return {
          ok: true,
          json: async () => ({ text: reply(String(body.message)), sessionId: HERMES_SESSION }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  vi.stubGlobal("WebSocket", ForbiddenWs as unknown as typeof WebSocket);
  return box;
}

/** Mount the chat on this box and hand back its composer. */
export async function mountHermesChat(box: HermesBox): Promise<HTMLElement> {
  render(<ChatPopup isOpen onClose={() => {}} />);
  const textarea = await screen.findByRole("textbox");
  // The harness resolves through a fetch; until it lands the surface still
  // assumes the gateway and the gates under test are not in force yet. Seeding
  // the Hermes header is the one thing only this path does, so it is the signal
  // that the mode really switched — waiting on a control to vanish would also
  // "pass" if it were never rendered at all.
  await waitFor(() => {
    expect(box.fetchedUrls.some((u) => u.includes("/setup-api/hermes/models"))).toBe(true);
  });
  await waitFor(() => expect(textarea).not.toBeDisabled());
  return textarea;
}
