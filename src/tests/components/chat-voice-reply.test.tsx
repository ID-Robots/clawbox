import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup, { speakFailureIsNewest } from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { VOICE_SETTINGS_CHANGED_EVENT } from "@/lib/ui-events";
import { _resetSpokenReplyPlaybackForTests } from "@/lib/spoken-reply-playback";
import { speechTextFor } from "@/lib/speech-text";

// The same ceiling the sibling chat suites take: under a full-suite run every
// worker gets a slice of the box's cores and the 5 s default expires on
// whichever test mounted while it was busiest.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
/**
 * What the chat asks `tts/speak` for: the words, and the compressed formats
 * this browser can play (src/lib/voice-reply-format.ts). jsdom's audio element
 * answers "" to every `canPlayType`, so the list is the MP3 floor alone.
 */
const SPEAK_BODY = JSON.stringify({ text: "Fine, thanks.", formats: ["mp3"] });
/** Every warm-up the chat asked for (the microphone's pre-load of Kokoro). */
const warmCalls: string[] = [];
/** Which engine the box says spoke, as the speak route's header names it. */
let speakEngine = "local";
let autoReplyAnswer = true;
/** When set, `/setup-api/tts` answers a server error instead of the switch. */
let ttsRefuses = false;
let replyText = "**Fine**, thanks.";
/** When set, a turn is acked with "Sent." and the reply arrives from history instead. */
let ackOnly = false;
/** What `/setup-api/tts` says about the box's engines; `null` sends no list. */
let ttsEngines: Array<Record<string, unknown>> | null = null;
/** How many times the chat has read `/setup-api/tts` — the settle signal. */
let ttsReads = 0;
/** A clip the harness put ON the reply itself (Hermes, and an older gateway). */
let replyAudio: string | null = null;
/**
 * A clip the gateway speaks ITSELF, delivered the way it really delivers one:
 * a SECOND message repeating the reply's text and carrying the attachment,
 * `supplementDelayMs` after the final. That is the shape ChatPopup's merge is
 * written for ("the spoken half arrives as a SECOND message"), and the shape a
 * box whose owner hand-edited `tts.auto: "always"` produces.
 */
let supplementAudio: string | null = null;
let supplementDelayMs = 3;
/**
 * Settings → Voice → "Auto-play every spoken reply", as `/setup-api/tts`
 * states it; `undefined` sends no field at all — a server from before it.
 */
let autoPlayAllAnswer: boolean | undefined = undefined;
/** When set, what `chat.history` answers: a conversation the box already stored. */
let historyMessages: unknown[] | null = null;
/** When set, the gateway delivers every final TWICE, as a replay can. */
let duplicateFinal = false;
/** How long after a turn is sent its final lands — long enough, when raised, for the owner to leave mid-turn. */
let finalDelayMs = 1;
/** When set, every read of `/setup-api/tts` is held until it resolves: a status read still in flight. */
let ttsGate: Promise<void> | null = null;
/** The page's visibility, as the chat reads it. */
let pageVisibility: DocumentVisibilityState = "visible";
/**
 * Settings → Voice → "Short spoken answers", as `/setup-api/tts` states it;
 * `undefined` sends no field at all — a server from before it.
 */
let shortSpokenAnswer: boolean | undefined = undefined;
/**
 * The reply as the gateway STREAMS it before its final: each entry the whole
 * reply so far, one `delta` frame apiece, `deltaGapMs` apart.
 */
let streamDeltas: string[] = [];
const deltaGapMs = 2;
/**
 * When set, the final of every turn after the chat's own opener waits for
 * this — so a test can look at the chat while the reply is still streaming.
 */
let finalGate: Promise<void> | null = null;
/** Every socket the chat opened, newest last — so a test can drop one. */
const sockets: FakeGatewayWs[] = [];

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
    sockets.push(this);
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
      if (historyMessages) {
        this.respond(id, { messages: historyMessages });
        return;
      }
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
    const final = {
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey: "agent:main:main",
        state: "final",
        stopReason: "stop",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: ackOnly ? "Sent." : replyText },
            ...(replyAudio
              ? [{
                type: "attachment",
                attachment: { url: replyAudio, kind: "audio", label: "voice.wav", mimeType: "audio/wav" },
              }]
              : []),
          ],
          timestamp: 1787260000000,
        },
      },
    };
    streamDeltas.forEach((soFar, i) => {
      setTimeout(() => this.emit({
        type: "event",
        event: "chat",
        payload: {
          runId,
          sessionKey: "agent:main:main",
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: soFar }] },
        },
      }), 1 + i * deltaGapMs);
    });
    const streamed = streamDeltas.length * deltaGapMs;
    // The chat's own opener is the first send; only the owner's turns wait.
    const gate = sentFrames.filter((f) => f.method === "chat.send").length > 1 ? finalGate : null;
    const emitFinal = () => {
      setTimeout(() => this.emit(final), finalDelayMs + streamed);
      if (duplicateFinal) setTimeout(() => this.emit(final), finalDelayMs + streamed + 5);
    };
    if (gate) void gate.then(emitFinal);
    else emitFinal();
    if (supplementAudio) {
      setTimeout(() => this.emit({
        type: "event",
        event: "chat",
        payload: {
          runId,
          sessionKey: "agent:main:main",
          state: "final",
          stopReason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: replyText },
              { type: "attachment", attachment: { url: supplementAudio, kind: "audio", label: "voice.wav", mimeType: "audio/wav" } },
            ],
            timestamp: 1787260000500,
          },
        },
      }), 1 + supplementDelayMs);
    }
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
        return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: true, hermesSupportsImages: false, onboardingArmed: true } }) };
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
        ttsReads += 1;
        if (ttsRefuses) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
        // What the box says at the moment it is ASKED: a read held below
        // answers with the state from before anything changed meanwhile.
        const answer = {
          choice: "auto",
          autoReply: autoReplyAnswer,
          ...(autoPlayAllAnswer !== undefined ? { autoPlayAll: autoPlayAllAnswer } : {}),
          ...(shortSpokenAnswer !== undefined ? { shortSpoken: shortSpokenAnswer } : {}),
          ...(ttsEngines ? { engines: ttsEngines } : {}),
        };
        if (ttsGate) await ttsGate;
        return { ok: true, json: async () => answer };
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
const originalPaused = Object.getOwnPropertyDescriptor(MEDIA, "paused");
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
    ttsRefuses = false;
    replyText = "**Fine**, thanks.";
    ackOnly = false;
    ttsEngines = null;
    ttsReads = 0;
    replyAudio = null;
    supplementAudio = null;
    supplementDelayMs = 3;
    autoPlayAllAnswer = undefined;
    historyMessages = null;
    duplicateFinal = false;
    finalDelayMs = 1;
    ttsGate = null;
    pageVisibility = "visible";
    shortSpokenAnswer = undefined;
    streamDeltas = [];
    finalGate = null;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => pageVisibility });
    sockets.length = 0;
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
    if (originalPaused) Object.defineProperty(MEDIA, "paused", originalPaused);
    else delete (MEDIA as unknown as Record<string, unknown>).paused;
    _resetSpokenReplyPlaybackForTests();
    delete (document as unknown as Record<string, unknown>).visibilityState;
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
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    const player = await screen.findByTestId("chat-audio");
    expect(player).toHaveAttribute("src", "blob:spoken-reply");
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  /**
   * Send a TYPED turn and wait for its reply to have landed.
   *
   * The chat opens with a turn of its own, so the send this waits for is the
   * SECOND one; the settle is the reply's own bubble arriving, counted the
   * same way. A test that asserted on `speakBodies` without it would be
   * reading the array before the turn had finished and would pass on the very
   * bug it is written for.
   */
  async function typeIntoTheChat(question = "how are you") {
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: question } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(sentFrames.filter((f) => f.method === "chat.send").length).toBeGreaterThanOrEqual(2));
    // The turn is OVER — the running-turn line has gone — so an assertion on
    // `speakBodies` is reading the finished state rather than racing it.
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
  }

  /**
   * The OpenClaw half of the owner's switch, and the reason it looked broken
   * on that edition while working on Hermes.
   *
   * Hermes speaks EVERY reply while the switch is on — its chat route makes
   * the clip and hands it back on the answer. On OpenClaw nothing did: the
   * gateway's `tts.auto: "inbound"` speaks only after an INBOUND VOICE
   * message, and this chat transcribes on the box and posts text, so a typed
   * question came back silent and with no player at all.
   */
  it("gives a typed question's reply a player too, without playing it out loud", async () => {
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    // The box was asked for the words, exactly as it is for a spoken question.
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    // ...and the clip is on the bubble, ready to press.
    const player = await screen.findByTestId("chat-audio");
    expect(player).toHaveAttribute("src", "blob:spoken-reply");
    // A typed question is not answered ALOUD, though: that stays the reply to
    // a spoken one, on both editions.
    expect(play).not.toHaveBeenCalled();
  });

  /**
   * ...but the chat's OWN opening turn is not the owner asking.
   *
   * `FIRST_CONVERSATION_OPENER` is sent by ClawBox to make the agent introduce
   * itself on a box nobody has talked to yet — nobody is waiting to hear it,
   * and a first boot is exactly when a cold Kokoro is at its slowest. So the
   * greeting's reply gets no clip, and the count above stays the owner's own.
   */
  it("spends no synthesis on the greeting the chat sends itself", async () => {
    replyText = "Hello there.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByText("Hello there.", { exact: false });
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
    expect(speakBodies).toEqual([]);
    expect(screen.queryByTestId("chat-audio")).not.toBeInTheDocument();
  });

  /**
   * Every "asks for nothing" test below settles first.
   *
   * The ask is a `fetch` behind an awaited queue, so it lands at least a
   * microtask after the turn does: an assertion taken the instant the turn
   * settles would pass with the bug present. Waiting for a POSITIVE fact that
   * cannot precede the ask — the switch having been read, a clip having been
   * rendered — is what makes the silence mean something.
   */
  async function settleAfterTheTurn() {
    await waitFor(() => expect(ttsReads).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  it("leaves a typed question silent while the owner's switch is off", async () => {
    autoReplyAnswer = false;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await settleAfterTheTurn();
    expect(speakBodies).toEqual([]);
    expect(screen.queryByTestId("chat-audio")).not.toBeInTheDocument();
  });

  it("stays silent while the box has not said the switch is on", async () => {
    // Off by default (the owner's ruling, 2026-09-15): the chat opens with the
    // switch OFF and only a body that STATES `autoReply: true` moves it. A
    // status read that failed used to leave the initial `true` in place, so a
    // spoken question was answered out loud on a box nobody had asked.
    ttsRefuses = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(screen.getAllByText("Fine, thanks.", { exact: false }).length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(ttsReads).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(speakBodies).toEqual([]);
    expect(warmCalls).toEqual([]);
    expect(screen.queryByTestId("chat-audio")).not.toBeInTheDocument();
  });

  it("asks for nothing on a box that has said it has no voice", async () => {
    // The same rule the attach and microphone buttons follow: a box that
    // positively reports every engine unconfigured is not asked to speak,
    // rather than asked and refused on every single reply.
    ttsEngines = [{ id: "local", configured: false }, { id: "cloud", configured: false }];
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    // The engines answer BEFORE the turn, or the chat would still be at
    // `null` — "nothing known", which asks — and the test would be pinning
    // its own timing rather than the rule.
    await waitFor(() => expect(ttsReads).toBeGreaterThan(0));
    await typeIntoTheChat();
    await settleAfterTheTurn();
    expect(speakBodies).toEqual([]);
  });

  it("does not ask for a reply that arrived with its own clip", async () => {
    // A clip carried ON the reply: the Hermes edition permanently (its chat
    // route attaches one inside the turn) and an older OpenClaw gateway, which
    // pushed its TTS supplement inside the final. The chat renders it and asks
    // for nothing — asking as well would spend a synthesis per reply and then
    // have nowhere to put the result.
    replyText = "Fine, thanks.";
    replyAudio = "/home/clawbox/.openclaw/media/outbound/voice-1787260000000---aa.wav";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    // Both replies in this transcript carry one — the chat's opening turn and
    // the typed one — and neither was synthesised here.
    await waitFor(() => expect(screen.queryAllByTestId("chat-audio")).toHaveLength(2));
    await settleAfterTheTurn();
    expect(speakBodies).toEqual([]);
  });

  it("keeps ONE player when the gateway speaks the reply itself, late", async () => {
    // The shape the OpenClaw gateway really uses when its `tts.auto` has been
    // hand-edited to "always": a SECOND message repeating the reply's text,
    // carrying the clip, after the final. It is made by the same engine as
    // ours, so it can land either side of the synthesis this chat started —
    // which is why the race is not claimed to be closed. What IS pinned is the
    // outcome the owner sees: one reply, one player, never two.
    replyText = "Fine, thanks.";
    supplementAudio = "/home/clawbox/.openclaw/media/outbound/voice-1787260000500---bb.wav";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    // One per reply in this transcript (the chat's opening turn and the typed
    // one), and every one of them the GATEWAY'S clip — not a `blob:` this
    // chat made. A synthesis this chat may also have started has nowhere to go
    // and is released by the ring; what must never happen is the owner being
    // shown two players for one answer.
    //
    // Waited for as a POSITIVE end state first: the turn-status line goes the
    // moment the first final lands, and the gateway's supplement is a later
    // frame. Read at a fixed 60 ms after that, a loaded runner could still be
    // between the two — and a synthesis this chat started could still be on
    // its way to a bubble.
    const players = () => screen.queryAllByTestId("chat-audio").map((el) => el.getAttribute("src") ?? "");
    await waitFor(() => {
      expect(players()).toHaveLength(2);
      expect(players().every((src) => src.includes("/setup-api/chat/media"))).toBe(true);
    });
    // Then the settle, after which a synthesis this chat started has had its
    // chance to reach a bubble: a third player still may not appear.
    await settleAfterTheTurn();
    const srcs = players();
    expect(srcs).toHaveLength(2);
    expect(srcs.every((src) => src.includes("/setup-api/chat/media"))).toBe(true);
  });

  it("keeps ONE player when the gateway's clip lands after this chat's own", async () => {
    // The other side of that race, made certain: the box has already spoken
    // the reply for this chat and put the clip on the bubble when the
    // gateway's supplement arrives. Merging the two put both players on one
    // answer; the gateway's clip takes the bubble instead.
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    // The chat's opening turn, answered with no clip from anyone.
    await screen.findByText("Fine, thanks.", { exact: false });
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
    // The typed one: spoken here first, the gateway's own clip long after.
    supplementAudio = "/home/clawbox/.openclaw/media/outbound/voice-1787260000500---bb.wav";
    supplementDelayMs = 250;
    await typeIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    await waitFor(() => expect(screen.queryAllByTestId("chat-audio").map((el) => el.getAttribute("src"))).toEqual(["blob:spoken-reply"]));
    await waitFor(() => {
      const srcs = screen.queryAllByTestId("chat-audio").map((el) => el.getAttribute("src") ?? "");
      expect(srcs).toHaveLength(1);
      expect(srcs[0]).toContain("/setup-api/chat/media");
    });
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

  /**
   * ...and when the box could not make the sound after all, it SAYS so.
   *
   * A cloud voice that took the connection and sent nothing used to hold
   * "Speaking the reply…" for a minute, and then the line simply went: the
   * owner, listening for an answer, heard nothing and was told nothing. The
   * box now gives up on a silent cloud in seconds (src/lib/voice-speak.ts)
   * and answers the refusal; the chat turns that into a line under the reply.
   */
  describe("when the voice cannot speak the reply", () => {
    /** `tts/speak` answers with `answer` — or, as a function, throws what it throws. */
    function speakAnswers(answer: Record<string, unknown> | (() => never)) {
      const inner = globalThis.fetch as unknown as (i: unknown, init?: RequestInit) => Promise<unknown>;
      vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes("/setup-api/tts/speak")) {
          speakBodies.push(String(init?.body ?? ""));
          if (typeof answer === "function") answer();
          return answer;
        }
        return inner(input, init);
      }));
    }
    const refusal = (status: number, code: string) => ({
      ok: false,
      status,
      headers: new Headers(),
      json: async () => ({ error: "the English sentence", code }),
    });

    it("says the voice is not answering when the box gave up on a silent cloud, and stops saying it is speaking", async () => {
      speakAnswers(refusal(502, "cloud_no_answer"));
      render(<ChatPopup isOpen onClose={() => {}} />);
      await speakIntoTheChat();
      const line = await screen.findByTestId("chat-speak-failed");
      expect(line).toHaveTextContent("Voice is not answering right now — try again in a moment.");
      expect(line).toHaveAttribute("role", "status");
      expect(screen.queryByTestId("chat-speaking-reply")).toBeNull();
      expect(play).not.toHaveBeenCalled();
    });

    it("says the same when the chat's own ask never came back", async () => {
      speakAnswers(() => { throw new DOMException("The operation timed out.", "TimeoutError"); });
      render(<ChatPopup isOpen onClose={() => {}} />);
      await speakIntoTheChat();
      expect(await screen.findByTestId("chat-speak-failed")).toHaveTextContent("Voice is not answering right now");
      expect(screen.queryByTestId("chat-speaking-reply")).toBeNull();
    });

    it("says so when the box answered but the audio broke off on the way", async () => {
      speakAnswers({
        ok: true,
        status: 200,
        headers: new Headers({ "X-ClawBox-Voice-Engine": "cloud" }),
        blob: async () => { throw new TypeError("network error"); },
      });
      render(<ChatPopup isOpen onClose={() => {}} />);
      await speakIntoTheChat();
      expect(await screen.findByTestId("chat-speak-failed")).toHaveTextContent("Voice is not answering right now");
      expect(screen.queryByTestId("chat-speaking-reply")).toBeNull();
      expect(play).not.toHaveBeenCalled();
    });

    it("says nothing when the owner switches spoken replies off while the box is still trying", async () => {
      let answer: (value: unknown) => void = () => {};
      const held = new Promise((resolve) => { answer = resolve; });
      const inner = globalThis.fetch as unknown as (i: unknown, init?: RequestInit) => Promise<unknown>;
      vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes("/setup-api/tts/speak")) {
          speakBodies.push(String(init?.body ?? ""));
          return held;
        }
        return inner(input, init);
      }));
      render(<ChatPopup isOpen onClose={() => {}} />);
      await speakIntoTheChat();
      await screen.findByTestId("chat-speaking-reply");
      act(() => { window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { autoReply: false } })); });
      // The box gives up on its silent cloud only after the switch went off.
      await act(async () => { answer(refusal(502, "cloud_no_answer")); });
      await waitFor(() => expect(screen.queryByTestId("chat-speaking-reply")).toBeNull());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(screen.queryByTestId("chat-speak-failed")).toBeNull();
    });

    it("says the voice could not speak it when the box refused for another reason", async () => {
      speakAnswers(refusal(502, "local_failed"));
      render(<ChatPopup isOpen onClose={() => {}} />);
      await speakIntoTheChat();
      expect(await screen.findByTestId("chat-speak-failed")).toHaveTextContent("The voice could not speak this reply.");
    });

    it("says nothing when the owner switched spoken replies off meanwhile — that is not a failure", async () => {
      speakAnswers(refusal(409, "switched_off"));
      render(<ChatPopup isOpen onClose={() => {}} />);
      await speakIntoTheChat();
      await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
      await waitFor(() => expect(screen.queryByTestId("chat-speaking-reply")).toBeNull());
      expect(screen.queryByTestId("chat-speak-failed")).toBeNull();
    });

    it("says nothing for a typed question's clip, which nobody was waiting to hear", async () => {
      speakAnswers(refusal(502, "cloud_no_answer"));
      replyText = "Fine, thanks.";
      render(<ChatPopup isOpen onClose={() => {}} />);
      await typeIntoTheChat();
      await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
      // Give a failure line every chance to appear before saying it did not.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(screen.queryByTestId("chat-speak-failed")).toBeNull();
    });

    it("takes the line away once the conversation moves on", async () => {
      speakAnswers(refusal(502, "cloud_no_answer"));
      render(<ChatPopup isOpen onClose={() => {}} />);
      await speakIntoTheChat();
      await screen.findByTestId("chat-speak-failed");
      const textarea = await screen.findByRole("textbox");
      await waitFor(() => expect(textarea).not.toBeDisabled());
      fireEvent.change(textarea, { target: { value: "never mind" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(screen.queryByTestId("chat-speak-failed")).toBeNull());
    });

    it("keeps the line on the reply it failed for, not on a later one with the same words", () => {
      const failed = { role: "assistant", text: "Done.", timestamp: 1000 };
      const asked = { role: "user", text: "and the other one", timestamp: 2000 };
      const sameWords = { role: "assistant", text: "Done.", timestamp: 3000 };
      const notice = { role: "system", text: "Stopped.", timestamp: 4000 };
      const failure = { text: "Done.", timestamp: 1000, after: 1 };
      expect(speakFailureIsNewest([failed], failure)).toBe(true);
      // The chat's own notices do not move it off its reply...
      expect(speakFailureIsNewest([failed, notice], failure)).toBe(true);
      // ...the owner's next message does, and a later "Done." does not bring it back.
      expect(speakFailureIsNewest([failed, asked], failure)).toBe(false);
      expect(speakFailureIsNewest([failed, asked, sameWords], failure)).toBe(false);
      expect(speakFailureIsNewest([], failure)).toBe(false);
    });

    it("finds a reply that was not painted yet when it failed by where the transcript ended, never by its words alone", () => {
      const earlier = { role: "assistant", text: "Done.", timestamp: 500 };
      const question = { role: "user", text: "and now?", timestamp: 900 };
      const failed = { role: "assistant", text: "Done.", timestamp: 1000 };
      const asked = { role: "user", text: "and the other one", timestamp: 2000 };
      const sameWords = { role: "assistant", text: "Done.", timestamp: 3000 };
      // The transcript held two lines when the failure landed; the reply's
      // bubble was appended after them.
      const failure = { text: "Done.", timestamp: null, after: 2 };
      expect(speakFailureIsNewest([earlier, question, failed], failure)).toBe(true);
      // A later reply with the same words is another reply, not this one.
      expect(speakFailureIsNewest([earlier, question, failed, asked, sameWords], failure)).toBe(false);
      // Nor is the earlier one, before the bubble has been painted at all.
      expect(speakFailureIsNewest([earlier], { ...failure, after: 1 })).toBe(false);
    });
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
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]), { timeout: 8000 });
  }, 12_000);

  /**
   * The owner's Stop (TASK-890). A reply the chat plays on its own is a
   * detached media element, not the bubble's; it used to leave the bubble
   * reading "play" with nothing on screen that could silence it.
   *
   * Playback here does NOT end on its own: the element reports `play` and then
   * stays playing until something pauses it, which is the state a Stop is for.
   */
  function holdPlayback() {
    const pausedBy = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(MEDIA, "paused", {
      configurable: true,
      get(this: HTMLMediaElement) { return pausedBy.get(this) !== false; },
    });
    play.mockImplementation(async function (this: HTMLMediaElement) {
      pausedBy.set(this, false);
      this.dispatchEvent(new Event("play"));
    });
    const pause = vi.fn(function (this: HTMLMediaElement) {
      if (pausedBy.get(this) === false) {
        pausedBy.set(this, true);
        this.dispatchEvent(new Event("pause"));
      }
    });
    Object.defineProperty(MEDIA, "pause", { configurable: true, value: pause });
    return { pause, isPlaying: (el: HTMLMediaElement) => pausedBy.get(el) === false };
  }

  it("puts a Stop on the bubble of a reply playing on its own, and one press silences it", async () => {
    replyText = "Fine, thanks.";
    const media = holdPlayback();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    const stop = await screen.findByTestId("spoken-reply-stop");
    const detached = play.mock.contexts[play.mock.contexts.length - 1] as HTMLMediaElement;
    expect(media.isPlaying(detached)).toBe(true);
    // Stop is the whole transport while the chat's own element speaks: its
    // position belongs to the chat's queue, so there is no pause to offer.
    expect(stop).toHaveAccessibleName(/^chat\.audioStop /);
    expect(screen.queryByTestId("spoken-reply-play")).toBeNull();

    fireEvent.click(stop);
    expect(media.isPlaying(detached)).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("spoken-reply-stop")).toBeNull());
    // The text reply and its clip stay; the clip plays again from the start.
    expect(screen.getAllByText("Fine, thanks.").length).toBeGreaterThan(0);
    const bubbleAudio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    expect(bubbleAudio.currentTime).toBe(0);
    fireEvent.click(screen.getByTestId("spoken-reply-play"));
    await waitFor(() => expect(media.isPlaying(bubbleAudio)).toBe(true));
    await screen.findByTestId("spoken-reply-stop");
  });

  it("stops the reply that is speaking when the owner sends a new prompt", async () => {
    replyText = "Fine, thanks.";
    const media = holdPlayback();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await screen.findByTestId("spoken-reply-stop");
    const detached = play.mock.contexts[play.mock.contexts.length - 1] as HTMLMediaElement;

    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: "and tomorrow?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(media.isPlaying(detached)).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("spoken-reply-stop")).toBeNull());
  });

  it("stops the reply that is speaking when the owner starts a new spoken question", async () => {
    replyText = "Fine, thanks.";
    const media = holdPlayback();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await screen.findByTestId("spoken-reply-stop");
    const detached = play.mock.contexts[play.mock.contexts.length - 1] as HTMLMediaElement;
    fireEvent.click(await screen.findByTestId("voice-record"));
    expect(media.isPlaying(detached)).toBe(false);
  });

  // ── Auto-play every spoken reply ──────────────────────────────────────
  //
  // Settings → Voice's second switch: on, a TYPED question's reply plays by
  // itself exactly as a spoken one's does. Off — the default, and what a box
  // that predates the switch reads — everything above holds unchanged. Every
  // case counts `play` after a settle: one reply is one playback at most, and
  // a reply the owner did not just ask for in this tab is none.

  /** A clip the box stored with a reply, in the shape the harness attaches it. */
  const STORED_CLIP = "/home/clawbox/.openclaw/media/outbound/voice-1787250000000---cc.wav";
  const storedConversation = () => [
    { role: "user", content: [{ type: "text", text: "how are you" }], timestamp: 1787250000000 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Fine, thanks." },
        { type: "attachment", attachment: { url: STORED_CLIP, kind: "audio", label: "voice.wav", mimeType: "audio/wav" } },
      ],
      timestamp: 1787250000500,
    },
  ];
  const sends = () => sentFrames.filter((f) => f.method === "chat.send").length;

  /** One more typed question, after the first: waits for ITS send and ITS turn to end. */
  async function typeAgain(question: string) {
    const before = sends();
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: question } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(sends()).toBe(before + 1));
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
  }

  it("plays a typed question's reply by itself once the owner switched auto-play on", async () => {
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    const player = await screen.findByTestId("chat-audio");
    expect(player).toHaveAttribute("src", "blob:spoken-reply");
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    // The chat's own opener was not the owner asking: its reply stays silent.
    await settleAfterTheTurn();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("leaves a typed question's reply on its player while auto-play is off", async () => {
    autoPlayAllAnswer = false;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    expect(await screen.findByTestId("chat-audio")).toHaveAttribute("src", "blob:spoken-reply");
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
  });

  it("plays the clip a typed reply arrived with, and asks for none", async () => {
    // Hermes' chat route attaches the clip inside the turn; so can a gateway.
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    replyAudio = "/home/clawbox/.openclaw/media/outbound/voice-1787260000000---aa.wav";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect((play.mock.contexts[0] as HTMLMediaElement).src).toContain("/setup-api/chat/media");
    await settleAfterTheTurn();
    expect(speakBodies).toEqual([]);
    // The opener's reply carried a clip too, and was never the owner's question.
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("answers a spoken question exactly as before with auto-play on", async () => {
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    await settleAfterTheTurn();
    expect(play).toHaveBeenCalledTimes(1);
    expect(speakBodies).toHaveLength(1);
  });

  it("says press play when the browser refuses to start a typed reply on its own", async () => {
    autoPlayAllAnswer = true;
    play.mockImplementation(async () => { throw new DOMException("blocked", "NotAllowedError"); });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await screen.findByTestId("chat-audio-blocked");
  });

  it("does nothing while spoken replies are off, whatever auto-play says", async () => {
    autoReplyAnswer = false;
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await settleAfterTheTurn();
    expect(speakBodies).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  });

  it("follows the switch live: the next typed reply plays with no reload", async () => {
    autoPlayAllAnswer = false;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await waitFor(() => expect(speakBodies).toHaveLength(1));
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();

    // Settings → Voice turned auto-play on while the chat was open.
    act(() => {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { autoReply: true, autoPlayAll: true } }));
    });
    await typeAgain("and tomorrow?");
    await waitFor(() => expect(speakBodies).toHaveLength(2));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    // ...and off again: the next one waits on its player.
    act(() => {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { autoReply: true, autoPlayAll: false } }));
    });
    await typeAgain("and the day after?");
    await waitFor(() => expect(speakBodies).toHaveLength(3));
    await settleAfterTheTurn();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("never starts a reply that is already in the history when the chat opens", async () => {
    autoPlayAllAnswer = true;
    historyMessages = storedConversation();
    render(<ChatPopup isOpen onClose={() => {}} />);
    // The stored clip is on screen — the history HAS painted — and silent.
    await screen.findByTestId("chat-audio");
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
    expect(speakBodies).toEqual([]);
  });

  it("plays a reply delivered twice only once", async () => {
    autoPlayAllAnswer = true;
    duplicateFinal = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    await settleAfterTheTurn();
    expect(play).toHaveBeenCalledTimes(1);
    expect(speakBodies).toHaveLength(1);
  });

  it("plays nothing again after a reconnect, or when the stored reply is pushed and read back", async () => {
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    // The gateway bounces under the chat, which reconnects on its own.
    const frames = (method: string) => sentFrames.filter((f) => f.method === method).length;
    const connectsBefore = frames("connect");
    act(() => { sockets[sockets.length - 1].onclose?.(); });
    await waitFor(() => expect(frames("connect")).toBeGreaterThan(connectsBefore), { timeout: 10_000 });

    // ...and pushes the conversation as it stored it, the reply's clip
    // included, which the chat reads back from the history.
    historyMessages = storedConversation();
    const historyBefore = frames("chat.history");
    const stored = storedConversation()[1];
    act(() => {
      sockets[sockets.length - 1].emit({ type: "event", event: "session.message", payload: { sessionKey: "agent:main:main", message: stored } });
    });
    await waitFor(() => expect(frames("chat.history")).toBeGreaterThan(historyBefore), { timeout: 10_000 });
    await settleAfterTheTurn();
    expect(play).toHaveBeenCalledTimes(1);
    expect(speakBodies).toHaveLength(1);
  }, 25_000);

  it("plays a typed reply that only arrived through the history refetch after an ack-only final", async () => {
    // The live landing of the run just closed in this conversation, read from
    // history because the gateway acked with "Sent." — the same rule the
    // spoken question's reply follows above.
    autoPlayAllAnswer = true;
    ackOnly = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]), { timeout: 8000 });
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    await settleAfterTheTurn();
    expect(play).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("never plays an OLDER reply when the ack-only refetch comes back before the new one is stored", async () => {
    // The box acked with "Sent." and, three seconds on, has stored the owner's
    // question but not yet its answer: the newest reply in what it reads back
    // is the one from before this turn, clip and all. Not live.
    autoPlayAllAnswer = true;
    ackOnly = true;
    historyMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "An older answer." },
          { type: "attachment", attachment: { url: STORED_CLIP, kind: "audio", label: "voice.wav", mimeType: "audio/wav" } },
        ],
        timestamp: 1787250000500,
      },
      { role: "user", content: [{ type: "text", text: "how are you" }], timestamp: 1787260000000 },
    ];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByText("An older answer.", { exact: false });
    const reads = () => sentFrames.filter((f) => f.method === "chat.history").length;
    await typeAgain("how are you");
    const readsAfterTheTurn = reads();
    // The refetch three seconds after the "Sent." ack has come and gone.
    await waitFor(() => expect(reads()).toBeGreaterThan(readsAfterTheTurn), { timeout: 8000 });
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
    expect(speakBodies).toEqual([]);
  }, 15_000);

  it("lets a settings change win over a status read that was already out", async () => {
    // The chat opened and asked the box; before the answer came back, the
    // owner turned auto-play OFF in Settings -> Voice. The read's answer is
    // from before that change, and must not put the switch back on.
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    let openGate: () => void = () => {};
    ttsGate = new Promise<void>((resolve) => { openGate = resolve; });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(ttsReads).toBeGreaterThan(0));
    autoPlayAllAnswer = false;
    act(() => {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { autoReply: true, autoPlayAll: false } }));
    });
    await act(async () => { openGate(); });
    ttsGate = null;
    await typeIntoTheChat();
    // Spoken replies are on, so the reply still gets its clip — to press.
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
  });

  /**
   * Send a typed question whose reply lands `finalDelayMs` later, and do
   * `leave` while it is out. Waits for the chat's own opener to settle first,
   * so the send counted is the owner's.
   */
  async function typeThenLeave(leave: () => void) {
    await waitFor(() => expect(sends()).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
    finalDelayMs = 400;
    const before = sends();
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: "how are you" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(sends()).toBe(before + 1));
    act(() => { leave(); });
  }

  it("leaves a typed reply on its player when the owner closed the chat before it landed", async () => {
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
    await typeThenLeave(() => rerender(<ChatPopup isOpen={false} onClose={() => {}} />));
    // The reply landed with the popup closed: its clip is made, silently.
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]), { timeout: 5000 });
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
  });

  it("leaves a typed reply on its player when the owner's tab was hidden before it landed", async () => {
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeThenLeave(() => { pageVisibility = "hidden"; });
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]), { timeout: 5000 });
    expect(await screen.findByTestId("chat-audio")).toHaveAttribute("src", "blob:spoken-reply");
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
  });

  it("asks again before the sound starts: a tab hidden while the clip was made stays silent", async () => {
    // The reply landed with the owner at the chat, so it was going to play —
    // "Speaking the reply…" is up — but the owner switched tabs while the box
    // was still making the sound. The clip goes on its bubble; nothing plays.
    autoPlayAllAnswer = true;
    replyText = "Fine, thanks.";
    let releaseSpeak: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseSpeak = resolve; });
    const inner = globalThis.fetch as unknown as (i: unknown, init?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/setup-api/tts/speak")) await held;
      return inner(input, init);
    }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await typeIntoTheChat();
    await screen.findByTestId("chat-speaking-reply");
    pageVisibility = "hidden";
    releaseSpeak();
    await waitFor(() => expect(screen.getByTestId("chat-audio")).toHaveAttribute("src", "blob:spoken-reply"));
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
  });

  // ── Short spoken answers ──────────────────────────────────────────────
  //
  // Settings → Voice's third switch: on, the voice says the reply's ANSWER —
  // its first sentences, src/lib/short-speech-text.ts — and starts as soon as
  // the stream has settled them, before the reply has finished; the bubble
  // keeps every word. Off — the default, and what a box that predates the
  // switch reads — the whole reply is read out at its final, as above.

  const ANSWER = "**Yes** — last night's backup ran at 03:00 and finished cleanly. Nothing needs doing. It took four minutes.";
  /** What the voice says of LONG_REPLY with short answers on. */
  const SHORT_ANSWER = "Yes — last night's backup ran at 03:00 and finished cleanly. Nothing needs doing. It took four minutes.";
  /** A reply whose whole spoken text runs well past 300 characters. */
  const LONG_REPLY = [
    ANSWER,
    "",
    "Here is what it ran:",
    "",
    "```bash",
    "rsync -a /home /mnt/backup",
    "```",
    "",
    "The full log is in the backup folder, and the next run is tomorrow night. If you like, I can send you a summary every morning, or only warn you when a run fails. Backups older than thirty days are pruned on their own, so the disk will not fill up.",
  ].join("\n");
  /** LONG_REPLY as the gateway streams it: the answer has settled by the fourth frame. */
  const LONG_DELTAS = [
    "**Yes** — last night's backup ran at 03:00",
    "**Yes** — last night's backup ran at 03:00 and finished cleanly. Nothing needs doing.",
    ANSWER,
    `${ANSWER}\n\nHere is what it ran:`,
    LONG_REPLY.slice(0, LONG_REPLY.indexOf("rsync")),
    LONG_REPLY,
  ];
  const speakBody = (text: string) => JSON.stringify({ text, formats: ["mp3"] });
  /** Hold every owner's turn's final until the returned function is called. */
  function holdTheFinal(): () => void {
    let open: () => void = () => {};
    finalGate = new Promise<void>((resolve) => { open = resolve; });
    return () => open();
  }
  /** Type a question whose reply is held mid-stream: waits for ITS send, not its end. */
  async function askWhileItStreams(question = "did the backup run?") {
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: question } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(sends()).toBeGreaterThanOrEqual(2));
  }
  /** The reply's last words are on screen in the chat's opener AND the reply streaming now. */
  async function waitForTheWholeStream() {
    await waitFor(() => expect(screen.getAllByText(/pruned on their own/)).toHaveLength(2));
  }

  it("speaks only the short answer of a spoken question, before the reply has finished streaming", async () => {
    shortSpokenAnswer = true;
    replyText = LONG_REPLY;
    streamDeltas = LONG_DELTAS;
    const releaseFinal = holdTheFinal();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    // Asked for and PLAYING while the turn is still running — its final has
    // not even been sent.
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER)]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("chat-stop")).toBeInTheDocument();

    await act(async () => { releaseFinal(); });
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
    // The bubble keeps every word of the reply, the code and the detail the
    // voice left out included...
    expect(screen.getAllByText(/pruned on their own/)).toHaveLength(2);
    expect(screen.getAllByText(/rsync -a \/home \/mnt\/backup/)).toHaveLength(2);
    // ...and the clip that was said joins it, to play again.
    await waitFor(() => expect(screen.getByTestId("chat-audio")).toHaveAttribute("src", "blob:spoken-reply"));
    // The final did not say it a second time.
    await settleAfterTheTurn();
    expect(speakBodies).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("reads the whole reply out at its final, exactly as before, while short answers are off", async () => {
    shortSpokenAnswer = false;
    replyText = LONG_REPLY;
    streamDeltas = LONG_DELTAS;
    const releaseFinal = holdTheFinal();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitForTheWholeStream();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(speakBodies).toEqual([]);

    await act(async () => { releaseFinal(); });
    await waitFor(() => expect(speakBodies).toEqual([speakBody(speechTextFor(LONG_REPLY))]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  });

  it("reads the whole reply out on a box that predates the switch", async () => {
    // No `shortSpoken` field at all: off, as on the box.
    replyText = LONG_REPLY;
    streamDeltas = LONG_DELTAS;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([speakBody(speechTextFor(LONG_REPLY))]));
  });

  it("plays a typed reply's short answer while it streams, once auto-play is on", async () => {
    shortSpokenAnswer = true;
    autoPlayAllAnswer = true;
    replyText = LONG_REPLY;
    streamDeltas = LONG_DELTAS;
    const releaseFinal = holdTheFinal();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await askWhileItStreams();
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER)]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("chat-stop")).toBeInTheDocument();

    await act(async () => { releaseFinal(); });
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
    await settleAfterTheTurn();
    expect(speakBodies).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("makes a typed reply's clip to press from its short answer, at the final, while auto-play is off", async () => {
    // Nobody is waiting to hear it, so nothing is raced from the stream.
    shortSpokenAnswer = true;
    replyText = LONG_REPLY;
    streamDeltas = LONG_DELTAS;
    const releaseFinal = holdTheFinal();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await askWhileItStreams();
    await waitForTheWholeStream();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(speakBodies).toEqual([]);

    await act(async () => { releaseFinal(); });
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER)]));
    expect(await screen.findByTestId("chat-audio")).toHaveAttribute("src", "blob:spoken-reply");
    await settleAfterTheTurn();
    expect(play).not.toHaveBeenCalled();
  });

  it("speaks a short reply that never settled from its final, once", async () => {
    // Two words could still become three sentences until the reply ends.
    shortSpokenAnswer = true;
    streamDeltas = ["**Fine**", "**Fine**, thanks."];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([SPEAK_BODY]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    await settleAfterTheTurn();
    expect(speakBodies).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("says the short answer instead of a long reply's own clip, and leaves that clip on the bubble", async () => {
    // Hermes' chat route attaches the WHOLE reply read out; with short
    // answers on, the chat says the answer itself.
    shortSpokenAnswer = true;
    replyText = LONG_REPLY;
    replyAudio = "/home/clawbox/.openclaw/media/outbound/voice-1787260000000---aa.wav";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER)]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect((play.mock.contexts[0] as HTMLMediaElement).src).toBe("blob:spoken-reply");
    // Both replies keep the clip they came with (the chat's opener carried
    // one too, and was never played).
    const players = screen.getAllByTestId("chat-audio").map((el) => el.getAttribute("src") ?? "");
    expect(players).toHaveLength(2);
    expect(players.every((src) => src.includes("/setup-api/chat/media"))).toBe(true);
    await settleAfterTheTurn();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("plays a long reply's own clip as it is on a box that has said it has no voice", async () => {
    // Nothing could make the short answer, and the clip the reply came with
    // still plays.
    shortSpokenAnswer = true;
    ttsEngines = [{ id: "local", configured: false }, { id: "cloud", configured: false }];
    replyText = LONG_REPLY;
    streamDeltas = LONG_DELTAS;
    replyAudio = "/home/clawbox/.openclaw/media/outbound/voice-1787260000000---aa.wav";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(ttsReads).toBeGreaterThan(0));
    await speakIntoTheChat();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect((play.mock.contexts[0] as HTMLMediaElement).src).toContain("/setup-api/chat/media");
    await settleAfterTheTurn();
    expect(speakBodies).toEqual([]);
  });

  it("plays a short reply's own clip as it is, and asks for nothing", async () => {
    shortSpokenAnswer = true;
    replyText = "Fine, thanks.";
    replyAudio = "/home/clawbox/.openclaw/media/outbound/voice-1787260000000---aa.wav";
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect((play.mock.contexts[0] as HTMLMediaElement).src).toContain("/setup-api/chat/media");
    await settleAfterTheTurn();
    expect(speakBodies).toEqual([]);
  });

  it("speaks the short answer of a reply that only arrived through the history refetch", async () => {
    // The replay sounds as the live reply would have.
    shortSpokenAnswer = true;
    ackOnly = true;
    replyText = LONG_REPLY;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER)]), { timeout: 8000 });
  }, 12_000);

  it("follows the short-answers switch live, and an event that does not name it leaves it alone", async () => {
    replyText = LONG_REPLY;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(ttsReads).toBeGreaterThan(0));
    act(() => {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { autoReply: true, autoPlayAll: false, shortSpoken: true } }));
    });
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER)]));

    // A writer from before the switch names only the other two.
    act(() => {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { autoReply: true, autoPlayAll: false } }));
    });
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER), speakBody(SHORT_ANSWER)]));

    // ...and off again: the whole reply.
    act(() => {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, { detail: { shortSpoken: false } }));
    });
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies[2]).toBe(speakBody(speechTextFor(LONG_REPLY))));
  });

  it("silences an answer spoken from the stream when the owner stops the turn", async () => {
    shortSpokenAnswer = true;
    replyText = LONG_REPLY;
    streamDeltas = LONG_DELTAS;
    holdTheFinal();
    const media = holdPlayback();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    const detached = play.mock.contexts[0] as HTMLMediaElement;
    expect(media.isPlaying(detached)).toBe(true);
    fireEvent.click(screen.getByTestId("chat-stop"));
    expect(media.isPlaying(detached)).toBe(false);
  });

  it("keeps an answer spoken from the stream with what was kept of a run that ended without its final", async () => {
    shortSpokenAnswer = true;
    replyText = LONG_REPLY;
    // The answer settles on the last frame that arrives; the final never does.
    streamDeltas = LONG_DELTAS.slice(0, 4);
    holdTheFinal();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await speakIntoTheChat();
    await waitFor(() => expect(speakBodies).toEqual([speakBody(SHORT_ANSWER)]));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    await act(async () => {
      sockets[sockets.length - 1].emit({
        type: "event",
        event: "chat",
        payload: { runId: "run-cut", sessionKey: "agent:main:main", state: "aborted" },
      });
    });
    await waitFor(() => expect(screen.queryByTestId("chat-stop")).toBeNull());
    // What had streamed stays on screen beside the chat's opener, and the
    // clip that said its answer joins it, to play again...
    expect(screen.getAllByText(/Here is what it ran/)).toHaveLength(2);
    expect(await screen.findByTestId("chat-audio")).toHaveAttribute("src", "blob:spoken-reply");
    // ...and nothing about the cut-off run is said a second time.
    await settleAfterTheTurn();
    expect(speakBodies).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

});
