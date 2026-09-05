import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * TASK-698: the standalone full-screen chat (`/app/clawbox`, ChatApp) printed
 * the harness's `MEDIA:<path>` directive to the customer as literal text — an
 * absolute path under `~/.openclaw/media` in the transcript — where the mascot
 * chat (ChatPopup) turns the same line into the picture it names.
 *
 * The convention is documented in `src/lib/chat-media.ts`: a generated picture
 * or a spoken reply is NOT delivered as a structured attachment, it is named by
 * a directive line inside the reply text, and every client is expected to run
 * the split itself.
 *
 * Driven through a scripted gateway socket rather than asserted on source text:
 * ChatApp has its own `loadHistory`, its own live `final` handler and its own
 * streaming render, and all three have to agree.
 */

const IMAGE_PATH =
  "/home/clawbox/.openclaw/media/tool-image-generation/image-1---84d24458-84ba-4d45-b90f-de4476c32c31.png";
const VOICE_PATH = "/home/clawbox/.openclaw/media/outbound/voice-6f1c1f1e.wav";

const HISTORY_CAPTION = "Here's your fluffy cat!";
const HISTORY_REPLY = `${HISTORY_CAPTION} \u{1F408}\n\nMEDIA:${IMAGE_PATH}`;

type Frame = Record<string, unknown>;

/**
 * A gateway socket that answers the handshake and `chat.history` and can push
 * live `chat` events — the same shape `chat-inter-session-envelope.test.tsx`
 * drives both surfaces with.
 */
class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    instances.push(this);
    setTimeout(
      () => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
      0,
    );
  }

  send(raw: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, {
        messages: [
          { role: "user", content: "make me a picture of a fluffy cat", timestamp: 1787236200000 },
          {
            role: "assistant",
            content: [{ type: "text", text: HISTORY_REPLY }],
            timestamp: 1787236209000,
          },
        ],
      });
      return;
    }
    this.respond(id, {});
  }

  close() {
    this.readyState = FakeGatewayWs.CLOSED;
  }

  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  pushChat(state: string, message: unknown) {
    this.emit({
      type: "event",
      event: "chat",
      payload: { sessionKey: "agent:main:main", state, message },
    });
  }
}

const instances: FakeGatewayWs[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/gateway/ws-config")) {
        return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

async function socket() {
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return instances[instances.length - 1];
}

beforeEach(() => {
  instances.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  // jsdom has no layout engine, so the transcript's auto-scroll has nothing to
  // call. Unrelated to what is under test.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("ChatApp lifts MEDIA: directives", () => {
  it("renders the picture a replayed reply names, not its path", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));

    expect(document.body.textContent).not.toContain(`MEDIA:${IMAGE_PATH}`);
    expect(document.body.textContent).not.toContain(IMAGE_PATH);
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      expect.stringContaining(encodeURIComponent(IMAGE_PATH)),
    );
  });

  it("renders the picture a live final names, not its path", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));
    const ws = await socket();

    const livePath = "/home/clawbox/.openclaw/media/tool-image-generation/retry-9c2f.png";
    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: `Here's the retry!\n\nMEDIA:${livePath}` });
      await Promise.resolve();
    });

    await waitFor(() => expect(document.body.textContent).toContain("Here's the retry!"));
    expect(document.body.textContent).not.toContain(livePath);
    await waitFor(() =>
      expect(
        screen.getAllByRole("img").some(img =>
          (img.getAttribute("src") ?? "").includes(encodeURIComponent(livePath)),
        ),
      ).toBe(true),
    );
  });

  it("keeps the directive out of the bubble while the turn is still streaming", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));
    const ws = await socket();

    const streamPath = "/home/clawbox/.openclaw/media/tool-image-generation/stream-11ab.png";
    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: `Nearly there\n\nMEDIA:${streamPath}` });
      await Promise.resolve();
    });

    await waitFor(() => expect(document.body.textContent).toContain("Nearly there"));
    expect(document.body.textContent).not.toContain(streamPath);
  });

  it("plays a spoken reply the directive names instead of dropping or printing it", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));
    const ws = await socket();

    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: `Said out loud.\n\nMEDIA:${VOICE_PATH}` });
      await Promise.resolve();
    });

    await waitFor(() => expect(document.body.textContent).toContain("Said out loud."));
    expect(document.body.textContent).not.toContain(VOICE_PATH);
    const player = await waitFor(() => {
      const found = document.querySelector("audio");
      expect(found).not.toBeNull();
      return found as HTMLAudioElement;
    });
    expect(player.getAttribute("src")).toContain(encodeURIComponent(VOICE_PATH));
    // An accessible name is read out verbatim, so the path must not be in it
    // either — the leak the same review found on the mascot chat's player.
    expect(player.getAttribute("aria-label") ?? "").not.toContain(VOICE_PATH);
  });
});
