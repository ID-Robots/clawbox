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

/** Where the box writes a picture it generated, as the real route reports it. */
export const GENERATED_IMAGE_PATH =
  "/home/clawbox/clawbox/data/chat-media/chat-generated/2b1f4a90-0c8d-4c2b-9f31-6b0a2f9d51ce.png";

export interface HermesBox {
  /** Bodies POSTed to the Hermes chat route, in order. */
  chatPosts: Record<string, unknown>[];
  /** Every URL the surface fetched, so an upload can be asserted absent. */
  fetchedUrls: string[];
  /** A box with no gateway must never open a socket. */
  socketsOpened: number;
  /** What this particular device can do. Change before mounting. */
  facts: {
    hasClawaiToken: boolean;
    hermesSupportsImages: boolean;
    hermesHasVisionRoute: boolean;
    hermesStreamsTurns: boolean;
    hasClawaiImageRoute: boolean;
  };
  /**
   * What the durable transcript holds.
   *
   * NON-empty by default, because an empty transcript is the "first
   * conversation" signal that fires the auto-greet — real behaviour, worth a
   * test of its own, and noise in every other case. Empty it to get that
   * signal back.
   */
  storedTranscript: Record<string, unknown>[];
  /**
   * The transcripts of the conversations the surface opens BESIDE the desktop
   * one, keyed by the session key it minted for each. Read for any key that is
   * not the desktop's; a key never written answers an empty transcript, as the
   * store does.
   */
  tabTranscripts: Record<string, Record<string, unknown>[]>;
  /** DELETEs of the stored transcript, so "new chat" can be shown to reach it. */
  transcriptDeletes: number;
  /** The session key of every transcript DELETEd, in order. */
  deletedKeys: string[];
  /** The session key of every transcript READ, in order. */
  historyReads: string[];
  /**
   * The Hermes session id the chat route reports for a turn on this session
   * key. One fixed id by default; a test that needs to tell two conversations
   * apart answers differently per key.
   */
  sessionIdFor: (sessionKey: string) => string;
  /** Prompts POSTed to the images route, in order. */
  imagePrompts: string[];
  /**
   * What that route answers next. A test that wants the failure path replaces
   * this; the default draws one picture.
   */
  imageReply: () => { ok: boolean; status: number; payload: unknown };
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
    facts: {
      hasClawaiToken: false,
      hermesSupportsImages: false,
      hermesHasVisionRoute: false,
      hermesStreamsTurns: false,
      // …and no live image route, so the picture button starts absent for the
      // same reason the microphone does: nothing to spend, nowhere to spend it.
      hasClawaiImageRoute: false,
    },
    storedTranscript: [{ role: "assistant", text: "Earlier in this chat.", timestamp: 1 }],
    tabTranscripts: {},
    transcriptDeletes: 0,
    deletedKeys: [],
    historyReads: [],
    sessionIdFor: () => HERMES_SESSION,
    imagePrompts: [],
    imageReply: () => ({
      ok: true,
      status: 200,
      payload: { ok: true, media: [`/setup-api/chat/media?path=${encodeURIComponent(GENERATED_IMAGE_PATH)}`] },
    }),
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
      if (url.includes("/setup-api/chat/images")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: unknown };
        box.imagePrompts.push(String(body.prompt ?? ""));
        const answer = box.imageReply();
        return { ok: answer.ok, status: answer.status, json: async () => answer.payload };
      }
      if (url.includes("/setup-api/chat/history")) {
        // The desktop thread unless the surface named another conversation —
        // the route's own default.
        const key = new URL(url, "http://box").searchParams.get("sessionKey") || "desktop";
        const isDesktop = key === "desktop";
        if (init?.method === "DELETE") {
          box.transcriptDeletes += 1;
          box.deletedKeys.push(key);
          if (isDesktop) box.storedTranscript = [];
          else delete box.tabTranscripts[key];
          return { ok: true, json: async () => ({ ok: true }) };
        }
        box.historyReads.push(key);
        const messages = isDesktop ? box.storedTranscript : box.tabTranscripts[key] ?? [];
        return { ok: true, json: async () => ({ messages }) };
      }
      if (url.includes("/setup-api/hermes/chat")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        box.chatPosts.push(body);
        const sessionId = box.sessionIdFor(typeof body.sessionKey === "string" ? body.sessionKey : "desktop");
        return {
          ok: true,
          json: async () => ({ text: reply(String(body.message)), sessionId }),
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
