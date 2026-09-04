import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { VOICE_SETTINGS_CHANGED_EVENT } from "@/lib/ui-events";

/**
 * A voice message gets a voice back.
 *
 * The recording is transcribed on the box and sent as text, so the gateway
 * never learns it was spoken; the chat remembers which run the spoken
 * question started and, when that run's reply lands, asks the box to speak it
 * and plays it in the bubble's own player. Pinned: the ask happens only for a
 * spoken turn, only while the owner's switch is on, with the reply's words
 * rather than its Markdown; and the switch is followed live.
 */

type Frame = Record<string, unknown>;

const sentFrames: Frame[] = [];
const speakBodies: string[] = [];
/** Every warm-up the chat asked for (the microphone's pre-load of Kokoro). */
const warmCalls: string[] = [];
/** Which engine the box says spoke, as the speak route's header names it. */
let speakEngine = "local";
let autoReplyAnswer = true;
let replyText = "**Fine**, thanks.";
/** When set, a turn is acked with "Sent." and the reply arrives from history instead. */
let ackOnly = false;

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
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }), 0);
  }

  send(raw: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (frame.type !== "req") return;
    sentFrames.push(frame);
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      // After an ack-only turn, the stored reply is what history answers.
      const stored = ackOnly && sentFrames.some((f) => f.method === "chat.send")
        ? [{ role: "assistant", content: [{ type: "text", text: replyText }], timestamp: 1787260001000 }]
        : [];
      this.respond(id, { messages: stored });
      return;
    }
    if (frame.method !== "chat.send") {
      // Subscriptions, the TTS status probe: acknowledged, never answered with
      // a reply — only a sent turn gets one, as on the real gateway.
      this.respond(id, {});
      return;
    }
    const runId = `run-${sentFrames.length}`;
    this.respond(id, { runId, status: "started" });
    setTimeout(() => this.emit({
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey: "agent:main:main",
        state: "final",
        stopReason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: ackOnly ? "Sent." : replyText }], timestamp: 1787260000000 },
      },
    }), 1);
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }
  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    this.onstop?.();
  });

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start() { this.state = "recording"; }
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/gateway/ws-config")) {
        return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/capabilities")) {
        return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: true, hermesSupportsImages: false } }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/chat/transcribe")) {
        return { ok: true, json: async () => ({ ok: true, text: "how are you" }) };
      }
      if (url.includes("/setup-api/tts/warm")) {
        warmCalls.push(url);
        return { ok: true, status: 202, headers: new Headers(), json: async () => ({ warming: true }) };
      }
      if (url.includes("/setup-api/tts/speak")) {
        speakBodies.push(String(init?.body ?? ""));
        // The real answer names the engine that spoke and the chat reads it
        // off the response, so a fake with no headers is not this route's
        // shape.
        return {
          ok: true,
          headers: new Headers({ "X-ClawBox-Voice-Engine": speakEngine }),
          blob: async () => new Blob([new Uint8Array(2048)], { type: "audio/wav" }),
        };
      }
      if (url.includes("/setup-api/tts")) {
        return { ok: true, json: async () => ({ choice: "auto", autoReply: autoReplyAnswer }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

function installMedia() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
}

const MEDIA = window.HTMLMediaElement.prototype;
const originalPlay = Object.getOwnPropertyDescriptor(MEDIA, "play");
const originalPause = Object.getOwnPropertyDescriptor(MEDIA, "pause");
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let play: ReturnType<typeof vi.fn>;

async function speakIntoTheChat() {
  const record = await screen.findByTestId("voice-record");
  await waitFor(() => expect(record).not.toBeDisabled());
  fireEvent.click(record);
  await screen.findByTestId("voice-stop");
  const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
  await act(async () => { recorder.stop(); });
  // The transcript went through the ordinary chat turn.
  await waitFor(() => expect(sentFrames.some((f) => f.method === "chat.send")).toBe(true));
}

describe("spoken replies in the desktop chat", () => {
  beforeEach(() => {
    sentFrames.length = 0;
    speakBodies.length = 0;
    warmCalls.length = 0;
    speakEngine = "local";
    FakeMediaRecorder.instances.length = 0;
    autoReplyAnswer = true;
    replyText = "**Fine**, thanks.";
    ackOnly = false;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installMedia();
    installFetch();
    // Playback ends a tick after it starts: the chain of spoken replies
    // waits for that before the next one plays.
    play = vi.fn(async function (this: HTMLMediaElement) { setTimeout(() => this.dispatchEvent(new Event("ended")), 0); });
    Object.defineProperty(MEDIA, "play", { configurable: true, value: play });
    Object.defineProperty(MEDIA, "pause", { configurable: true, value: vi.fn() });
    URL.createObjectURL = () => "blob:spoken-reply";
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    if (originalPlay) Object.defineProperty(MEDIA, "play", originalPlay);
    if (originalPause) Object.defineProperty(MEDIA, "pause", originalPause);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("asks the box to speak the reply to a spoken question, and plays it in the bubble", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    // The words, not the Markdown.
    await waitFor(() => expect(speakBodies).toEqual([JSON.stringify({ text: "Fine, thanks." })]));
    const player = await screen.findByTestId("chat-audio");
    expect(player).toHaveAttribute("src", "blob:spoken-reply");
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it("answers a typed question in text only", async () => {
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: "how are you" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(sentFrames.some((f) => f.method === "chat.send")).toBe(true));
    // The chat opens with a turn of its own ("hi"), so OUR reply is the second
    // bubble with this text.
    await waitFor(() => expect(screen.getAllByText("Fine, thanks.", { exact: false }).length).toBeGreaterThanOrEqual(2));
    expect(speakBodies).toEqual([]);
    expect(screen.queryByTestId("chat-audio")).not.toBeInTheDocument();
  });

  it("stays silent while the owner's switch is off, and follows the switch live", async () => {
    autoReplyAnswer = false;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(screen.getAllByText("Fine, thanks.", { exact: false }).length).toBeGreaterThanOrEqual(2));
    expect(speakBodies).toEqual([]);

    // Settings → Voice flipped it back on while the chat was open.
    act(() => { window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { autoReply: true } })); });
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies.length).toBe(1));
  });

  it("warms the box's own voice the moment the microphone is pressed", async () => {
    // Kokoro's server stops itself after five idle minutes, so the first
    // spoken reply of a conversation would wait out a 13-19 s model load —
    // usually long enough for the chain to give up on the box and answer in
    // the cloud voice. The recording and the agent's turn cover that load.
    render(<ChatPopup isOpen onClose={() => {}} />);
    const record = await screen.findByTestId("voice-record");
    await waitFor(() => expect(record).not.toBeDisabled());
    fireEvent.click(record);
    await screen.findByTestId("voice-stop");
    await waitFor(() => expect(warmCalls.length).toBe(1));
  });

  it("asks for no warm-up when the owner has switched spoken replies off", async () => {
    autoReplyAnswer = false;
    render(<ChatPopup isOpen onClose={() => {}} />);
    const record = await screen.findByTestId("voice-record");
    await waitFor(() => expect(record).not.toBeDisabled());
    // The switch is read when the panel opens; the mic must see the answer.
    await waitFor(() => expect(screen.queryByTestId("voice-stop")).toBeNull());
    fireEvent.click(record);
    await screen.findByTestId("voice-stop");
    expect(warmCalls).toEqual([]);
  });

  it("says the box is speaking while it makes the sound, and stops saying it", async () => {
    // The words are on screen the moment the turn ends and the voice follows
    // seconds later; with nothing said in between the chat looked finished and
    // then spoke out of nowhere.
    let releaseSpeak: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseSpeak = resolve; });
    const inner = globalThis.fetch as unknown as (i: unknown, init?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/setup-api/tts/speak")) await held;
      return inner(input, init);
    }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await screen.findByTestId("chat-speaking-reply");
    releaseSpeak();
    await waitFor(() => expect(screen.queryByTestId("chat-speaking-reply")).toBeNull());
  });

  it("says which voice spoke when it was not the box's own", async () => {
    // The owner picked the box's own voice; the chain falls through to the
    // cloud whenever it cannot answer, and the sound alone does not say so.
    speakEngine = "cloud";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await screen.findByTestId("chat-audio-cloud");
  });

  it("claims nothing about the engine when the box spoke for itself", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await screen.findByTestId("chat-audio");
    expect(screen.queryByTestId("chat-audio-cloud")).toBeNull();
  });

  it("tells the owner to press play when the browser refuses to start the reply", async () => {
    // iOS Safari wants the gesture and the sound in the same tick, which an
    // await for the audio cannot give it. The refusal used to be swallowed
    // whole: a spoken question was answered in silence, with a player nobody
    // knew to press.
    play.mockImplementation(async () => { throw new DOMException("blocked", "NotAllowedError"); });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await screen.findByTestId("chat-audio-blocked");
  });

  it("still speaks a reply that only arrived through the history refetch after an ack-only final", async () => {
    ackOnly = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    // The gateway acked with "Sent."; the reply is fetched 3 s later and is
    // owed aloud all the same.
    await waitFor(() => expect(speakBodies).toEqual([JSON.stringify({ text: "Fine, thanks." })]), { timeout: 8000 });
  }, 12_000);

});
