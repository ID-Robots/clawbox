import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * A Hermes reply appearing in the bubble as it is written.
 *
 * The unit tests below this one prove the adapter accumulates correctly and the
 * route frames correctly. What they cannot prove is the thing the customer
 * actually gets: that the deltas REACH the surface. `sendTurn` has taken an
 * `onEvent` callback since the transport was defined and nothing had ever
 * passed one — the whole streaming half of the contract was dead code on both
 * harnesses. So this mounts the real component and watches the bubble.
 *
 * The second half is the one that would embarrass us: the model's monologue
 * must not appear on screen even for a frame. On this transport it arrives on a
 * separate channel and the route forwards only the answer, so what is asserted
 * here is that nothing downstream undoes that.
 */

const HERMES_SESSION = "20260823_193014_6f5942";

let socketsOpened = 0;
/** Resolves the streamed body's next chunk, so a test can pace the stream. */
let releaseChunk: ((chunk: string | null) => void) | null = null;

class ForbiddenWs {
  static readonly OPEN = 1;
  readyState = ForbiddenWs.OPEN;
  constructor() {
    socketsOpened += 1;
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE Response whose chunks are handed out one `releaseChunk` at a time. */
function pacedStream(): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              releaseChunk = (chunk) =>
                chunk === null ? resolve({ done: true }) : resolve({ done: false, value: encoder.encode(chunk) });
            }),
        };
      },
    },
  } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/chat/capabilities")) {
        return {
          ok: true,
          json: async () => ({
            harness: "hermes",
            // The box the whole change is for: a dashboard is up, so turns can
            // stream. Everything else stays off — streaming is its own fact.
            facts: {
              hasClawaiToken: false,
              hermesSupportsImages: false,
              hermesHasVisionRoute: false,
              hermesStreamsTurns: true,
              hasClawaiImageRoute: false,
            },
          }),
        };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return {
          ok: true,
          json: async () => ({
            providers: [{ id: "clawai", name: "ClawBox AI", authenticated: true }],
            models: [{ id: "deepseek-v4-flash", name: "Flash" }],
            provider: "clawai",
            current: "deepseek-v4-flash",
            defaultModel: "deepseek-v4-flash",
            reasoning: "off",
          }),
        };
      }
      if (url.includes("/setup-api/chat/model")) return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      if (url.includes("/setup-api/chat/spoken-history")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [{ role: "assistant", text: "Earlier.", timestamp: 1 }] }) };
      }
      if (url.includes("/setup-api/hermes/chat")) {
        // The composer must have ASKED for a stream, or the route would never
        // have offered one.
        expect((init?.headers as Record<string, string>)?.Accept).toBe("text/event-stream");
        return pacedStream();
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

async function mount() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  const textarea = await screen.findByRole("textbox");
  await waitFor(() => expect(textarea).not.toBeDisabled());
  return textarea;
}

async function send(textarea: HTMLElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(releaseChunk).not.toBeNull());
}

/** Hand the stream one chunk and let the component settle. */
async function push(chunk: string | null) {
  await waitFor(() => expect(releaseChunk).not.toBeNull());
  const release = releaseChunk!;
  releaseChunk = null;
  release(chunk);
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  socketsOpened = 0;
  releaseChunk = null;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  installFetch();
  vi.stubGlobal("WebSocket", ForbiddenWs as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("a streamed Hermes reply on screen", () => {
  it("paints the answer before the turn has finished", async () => {
    const textarea = await mount();
    await send(textarea, "Hey");

    await push(frame("delta", { text: "Hello" }));
    await waitFor(() => expect(screen.getByText(/Hello/)).toBeTruthy());
    // Still mid-turn: the reply is on screen and the turn has not settled.
    expect(screen.queryByText(/Hello there, how can I help\?/)).toBeNull();

    await push(frame("delta", { text: " there, how can I help?" }));
    await waitFor(() => expect(screen.getByText(/Hello there, how can I help\?/)).toBeTruthy());

    await push(
      frame("done", { text: "Hello there, how can I help?", harness: "hermes", sessionId: HERMES_SESSION }),
    );
    await push(null);
    // And the settled turn replaces the streaming bubble rather than doubling it.
    await waitFor(() => {
      expect(screen.getAllByText(/Hello there, how can I help\?/)).toHaveLength(1);
    });
  });

  it("shows nothing of the monologue, at any point in the turn", async () => {
    const textarea = await mount();
    await send(textarea, "2+2?");
    await push(frame("delta", { text: "Four." }));
    await waitFor(() => expect(screen.getByText(/Four\./)).toBeTruthy());
    // The reasoning only ever arrives on the settled turn, and the surface puts
    // it behind a disclosure — never in the bubble.
    expect(document.body.textContent).not.toContain("two plus two");
    await push(
      frame("done", {
        text: "Four.",
        harness: "hermes",
        reasoning: "two plus two is four",
        sessionId: HERMES_SESSION,
      }),
    );
    await push(null);
    await waitFor(() => expect(screen.getByText(/Four\./)).toBeTruthy());
    const bubble = screen.getByText(/Four\./);
    expect(bubble.textContent).not.toContain("two plus two");
  });

  it("opens no socket to do any of it", async () => {
    // A Hermes box runs no gateway. The stream is an HTTP response the route
    // holds open, not a connection the surface manages — which is also why
    // `hasLiveConnection` stays false and no connection banner appears.
    const textarea = await mount();
    await send(textarea, "Hey");
    await push(frame("delta", { text: "hi" }));
    await push(frame("done", { text: "hi", harness: "hermes", sessionId: HERMES_SESSION }));
    await push(null);
    expect(socketsOpened).toBe(0);
  });
});
