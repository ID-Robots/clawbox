import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";

/**
 * TASK-698: the standalone full-screen chat (`/app/clawbox`, ChatApp) printed
 * the harness's `MEDIA:<path>` directive to the customer as literal text — an
 * absolute path under `~/.openclaw/media` in the transcript — where the mascot
 * chat (ChatPopup) turns the same line into the picture it names.
 *
 * The convention is documented in `src/lib/chat-media.ts`. A generated picture
 * is NOT delivered as a structured attachment: it is named by a directive line
 * inside the reply text, and every client is expected to run the split itself —
 * OpenClaw's own Control UI does exactly that (its bundled
 * `control-ui-boot-*.js` on the box carries the same split). A SPOKEN reply
 * arrives the other way round, as a second assistant message carrying an
 * `attachment` part, so both shapes are exercised below.
 *
 * Driven through a scripted gateway socket rather than asserted on source text:
 * ChatApp has its own live `final` handler and its own streaming render beside
 * the shared history projection, and all three have to agree.
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
  window.localStorage.clear();
  // jsdom has no layout engine, so the transcript's auto-scroll has nothing to
  // call. Unrelated to what is under test.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("plays the spoken reply the harness attaches, and does not show the answer twice", async () => {
    // The shape the box ACTUALLY produces, measured on hardware (TASK-381 and
    // the note in lib/chat-media.ts): TTS is not a MEDIA: line at all. The
    // harness appends a SECOND assistant message repeating the answer's text
    // and carrying a structured `attachment` part. Rendered naively that is the
    // answer twice with no way to hear it.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));
    const ws = await socket();

    const spoken = "Said out loud.";
    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: [{ type: "text", text: spoken }] });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.body.textContent).toContain(spoken));

    await act(async () => {
      ws.pushChat("final", {
        role: "assistant",
        content: [
          { type: "text", text: spoken },
          {
            type: "attachment",
            attachment: {
              url: VOICE_PATH,
              kind: "audio",
              mimeType: "audio/wav",
              label: "voice-6f1c1f1e.wav",
            },
          },
        ],
      });
      await Promise.resolve();
    });

    const player = await waitFor(() => {
      const found = document.querySelector("audio");
      expect(found).not.toBeNull();
      return found as HTMLAudioElement;
    });
    expect(player.getAttribute("src")).toContain(encodeURIComponent(VOICE_PATH));
    expect(document.body.textContent).not.toContain(VOICE_PATH);
    // One bubble, not two: the supplement is folded into the answer it repeats.
    expect(document.body.textContent?.match(new RegExp(spoken, "g"))).toHaveLength(1);
    // An accessible name is read out verbatim, so the path must not be in it.
    expect(player.getAttribute("aria-label") ?? "").not.toContain(VOICE_PATH);
  });

  it("plays a spoken reply a MEDIA: directive names instead of dropping it", async () => {
    // The other shape: a provider that names its output the way image
    // generation does. Both are read — `splitAssistantMedia` lifts the
    // directive, `extractAudioAttachments` the structured part.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));
    const ws = await socket();

    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: `Here you go.\n\nMEDIA:${VOICE_PATH}` });
      await Promise.resolve();
    });

    await waitFor(() => expect(document.body.textContent).toContain("Here you go."));
    expect(document.body.textContent).not.toContain(VOICE_PATH);
    const player = await waitFor(() => {
      const found = document.querySelector("audio");
      expect(found).not.toBeNull();
      return found as HTMLAudioElement;
    });
    expect(player.getAttribute("src")).toContain(encodeURIComponent(VOICE_PATH));
  });

  it("caps and de-duplicates the clips one reply names", async () => {
    // `boundedAudio` is the rule every transcript path applies
    // (MAX_AUDIO_PER_MESSAGE = 4). Without it a repeated directive renders two
    // players under the same React key and a reply naming ten fires ten
    // `preload="metadata"` requests at the media route on a Jetson.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));
    const ws = await socket();

    const clips = Array.from({ length: 6 }, (_, i) =>
      `/home/clawbox/.openclaw/media/outbound/voice-${i}.wav`);
    // Six distinct clips plus a repeat of the first — seven directive lines.
    const lines = [...clips, clips[0]].map((path) => `MEDIA:${path}`).join("\n");
    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: `Six of them.\n${lines}` });
      await Promise.resolve();
    });

    await waitFor(() => expect(document.body.textContent).toContain("Six of them."));
    await waitFor(() => expect(document.querySelectorAll("audio").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("audio").length).toBe(4);
  });

  it("lifts the picture out of a transcript replayed after a reconnect", async () => {
    // The history path goes through the shared `projectGatewayHistory`, so a
    // reload shows what the live turn showed rather than a second derivation.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(HISTORY_CAPTION));
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      expect.stringContaining(encodeURIComponent(IMAGE_PATH)),
    );
  });
});
