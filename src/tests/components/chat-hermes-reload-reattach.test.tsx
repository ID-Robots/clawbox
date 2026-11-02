import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; see
// `test-timeout-hygiene.test.ts` for why every suite that mounts it says so.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Reloading the chat while Hermes is answering (TASK-2117).
 *
 * On a real box a refresh mid-answer cut the answer off and left "Stopped."
 * under it, every time. The box now keeps the turn running past the reload;
 * this is the other half — the reloaded page has to FOLLOW it. Without that it
 * would show the question with nothing under it until the turn had finished,
 * no Stop button for a turn that is plainly still going, and a composer that
 * sends the next message straight over it.
 *
 * So, as the owner sees it: the page comes back showing the agent at work,
 * the text so far, then the whole answer — once, with no "Stopped." — and the
 * next message is answered like any other. Stop still stops, on the box.
 */

const SESSION = "20260823_193014_6f5942";
const QUESTION = "Write me a long story about the sea";
const FIRST = "The sea was calm that morning, ";
const WHOLE = `${FIRST}and by evening it had carried the boat home.`;
const NEXT_ANSWER = "Here is the next part.";

let releaseChunk: ((chunk: string | null) => void) | null = null;
let socketsOpened = 0;
/** Whether the box reports a turn still running for the conversation. */
let liveTurn = true;
let attaches: string[] = [];
let stops: string[] = [];
let posts: Record<string, unknown>[] = [];

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

/**
 * The attach route's stream, handed out one `releaseChunk` at a time. A read
 * still pending when the page gives up rejects with an AbortError, as a
 * browser's does.
 */
function pacedStream(signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
              signal?.addEventListener("abort", () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              });
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
        // What the box recorded before the reload — the question, nothing yet
        // under it — and whether it is still answering it.
        return {
          ok: true,
          json: async () => ({
            messages: [{ role: "user", text: QUESTION, timestamp: 1 }],
            sessionId: SESSION,
            ...(liveTurn ? { liveTurn: true } : {}),
          }),
        };
      }
      if (url.startsWith("/setup-api/hermes/chat?") && init?.method === "DELETE") {
        stops.push(url);
        liveTurn = false;
        return { ok: true, status: 200, json: async () => ({ stopped: 1 }) };
      }
      if (url.startsWith("/setup-api/hermes/chat?")) {
        attaches.push(url);
        if (!liveTurn) return { ok: true, status: 204, headers: { get: () => null }, body: null };
        return pacedStream(init?.signal);
      }
      if (url === "/setup-api/hermes/chat") {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return {
          ok: true,
          status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
          json: async () => ({ text: NEXT_ANSWER, harness: "hermes", sessionId: SESSION }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

async function mount() {
  // Under StrictMode: effects run twice there, and a page that followed the
  // turn twice would paint its answer twice.
  render(
    <StrictMode>
      <ChatPopup isOpen onClose={() => {}} />
    </StrictMode>,
  );
  const textarea = await screen.findByRole("textbox");
  return textarea;
}

/** Hand the stream one chunk and let the component settle. */
async function push(chunk: string | null) {
  await waitFor(() => expect(releaseChunk).not.toBeNull());
  const release = releaseChunk!;
  releaseChunk = null;
  release(chunk);
  await new Promise((r) => setTimeout(r, 0));
}

const occurrences = (text: string) => screen.queryAllByText(text).length;

describe("reloading the chat while Hermes is answering", () => {
  beforeEach(() => {
    releaseChunk = null;
    socketsOpened = 0;
    liveTurn = true;
    attaches = [];
    stops = [];
    posts = [];
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    installFetch();
    vi.stubGlobal("WebSocket", ForbiddenWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  it("comes back showing the turn still running, then its whole answer — once, and never Stopped", async () => {
    await mount();
    // The reloaded page follows the turn instead of re-sending the question.
    await waitFor(() => expect(attaches.length).toBe(1));
    expect(attaches[0]).toBe("/setup-api/hermes/chat?sessionKey=desktop");
    // The agent is visibly at work, and Stop is there for it.
    expect(await screen.findByTitle("chat.stop")).toBeTruthy();
    expect(screen.getByTestId("chat-turn-status")).toBeTruthy();

    // What the turn had said before the reload, replayed.
    await push(frame("delta", { text: FIRST }));
    await waitFor(() => expect(occurrences(FIRST.trim())).toBe(1));

    // …and the rest, live, until it is done.
    liveTurn = false;
    await push(frame("delta", { text: "and by evening it had carried the boat home." }));
    await push(frame("done", { text: WHOLE, harness: "hermes", sessionId: SESSION }));
    await push(null);

    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    await waitFor(() => expect(occurrences(WHOLE)).toBe(1));
    expect(screen.queryByText("chat.stopped")).toBeNull();
    expect(screen.queryByText(/^Error: /)).toBeNull();
    expect(posts).toEqual([]);
    expect(stops).toEqual([]);
    expect(socketsOpened).toBe(0);
  });

  it("answers the next message after the reload like any other", async () => {
    const textarea = await mount();
    await waitFor(() => expect(attaches.length).toBe(1));
    liveTurn = false;
    await push(frame("done", { text: WHOLE, harness: "hermes", sessionId: SESSION }));
    await push(null);
    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());

    fireEvent.change(textarea, { target: { value: "Go on" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(await screen.findByText(NEXT_ANSWER)).toBeTruthy();
    expect(posts).toHaveLength(1);
    // The same conversation, resumed — not a stranger with no idea of the story.
    expect(posts[0]).toMatchObject({ message: "Go on", sessionId: SESSION });
    expect(screen.queryByText("chat.stopped")).toBeNull();
  });

  it("queues a message typed while the followed turn is still answering, rather than sending it over it", async () => {
    const textarea = await mount();
    await waitFor(() => expect(attaches.length).toBe(1));
    await screen.findByTitle("chat.stop");

    fireEvent.change(textarea, { target: { value: "Go on" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toEqual([]);

    liveTurn = false;
    await push(frame("done", { text: WHOLE, harness: "hermes", sessionId: SESSION }));
    await push(null);
    // The queued message goes once the turn it waited behind has finished.
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(await screen.findByText(NEXT_ANSWER)).toBeTruthy();
  });

  it("stops the followed turn on the box when the owner presses Stop", async () => {
    await mount();
    await waitFor(() => expect(attaches.length).toBe(1));
    await push(frame("delta", { text: FIRST }));
    await waitFor(() => expect(occurrences(FIRST.trim())).toBe(1));

    fireEvent.click(screen.getByTitle("chat.stop"));

    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    expect(stops).toEqual(["/setup-api/hermes/chat?sessionKey=desktop"]);
    // What was written stays, with the stop marked under it.
    expect(await screen.findByText("chat.stopped")).toBeTruthy();
    expect(occurrences(FIRST.trim())).toBe(1);
  });

  it("follows nothing when the box is not answering", async () => {
    liveTurn = false;
    await mount();
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(attaches).toEqual([]);
    expect(screen.queryByTitle("chat.stop")).toBeNull();
  });
});
