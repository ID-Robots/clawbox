import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * A spoken reply has to be something the user can play.
 *
 * TTS does not arrive the way a generated picture does. Measured on box .65:
 * the harness answers the turn, then appends a SECOND assistant message that
 * repeats the same text and carries the audio as a structured attachment part —
 * no MEDIA: line anywhere. `extractText` reads text parts and nothing else, so
 * the box did the work, wrote the file, and the chat rendered a caption with no
 * way to hear it.
 *
 * Two failures follow from that shape and both are asserted here: the audio
 * being dropped, and the repeat being appended as a second bubble so the answer
 * appears twice, once silent. The same shape comes back from `chat.history`, so
 * reopening the chat has to produce the same single bubble with a player.
 *
 * TASK-381 acceptance 4-5.
 */

const VOICE = "/home/clawbox/.openclaw/media/outbound/voice-1787291821763---93f78bf1.wav";
const SECOND_VOICE = "/home/clawbox/.openclaw/media/outbound/voice-1787291999999---0c1d2e3f.wav";
const SPOKEN_TEXT = "The lantern is green.";

const playerSrc = (p: string) => `/setup-api/chat/media?path=${encodeURIComponent(p)}`;

function assistantMessage(text: string, timestamp: number, audioPath?: string) {
  const content: unknown[] = [{ type: "text", text }];
  if (audioPath) {
    content.push({
      type: "attachment",
      attachment: { url: audioPath, kind: "audio", label: "voice.wav", mimeType: "audio/wav" },
    });
  }
  return { role: "assistant", content, timestamp };
}

/** What the gateway replays. Set per test before the component mounts. */
let history: unknown[] = [];

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: history });
      return;
    }
    this.respond(id, { runId: "r1", status: "started" });
  }

  close() {}
  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

let socket: FakeGatewayWs | null = null;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

/** Push one `final` chat event, the way a completed turn arrives. */
function deliver(message: unknown) {
  socket?.emit({
    type: "event",
    event: "chat",
    payload: {
      runId: "r1",
      sessionKey: "agent:main:main",
      state: "final",
      stopReason: "stop",
      message,
    },
  });
}

const players = () => screen.queryAllByTestId("chat-audio") as HTMLAudioElement[];

describe("spoken replies in the mascot chat", () => {
  beforeEach(() => {
    history = [];
    socket = null;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", class extends FakeGatewayWs {
      constructor(url: string) { super(url); socket = this; }
    } as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("renders the audio the harness attached as a player with native controls", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await screen.findByRole("textbox");

    deliver(assistantMessage(SPOKEN_TEXT, 1787291821899));
    await screen.findByText(SPOKEN_TEXT);
    deliver(assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE));

    await waitFor(() => expect(players()).toHaveLength(1));
    const player = players()[0];
    // `controls` is the acceptance: play/pause, seek and duration are the
    // browser's, and they are only there if the attribute is.
    expect(player.getAttribute("controls")).not.toBeNull();
    expect(player.getAttribute("src")).toBe(playerSrc(VOICE));
    // Duration on screen before anything is played, without pulling the file
    // down for a reply nobody listens to.
    expect(player.getAttribute("preload")).toBe("metadata");
  });

  it("does not show the answer twice when its spoken half arrives", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await screen.findByRole("textbox");

    deliver(assistantMessage(SPOKEN_TEXT, 1787291821899));
    await screen.findByText(SPOKEN_TEXT);
    deliver(assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE));
    await waitFor(() => expect(players()).toHaveLength(1));

    expect(screen.getAllByText(SPOKEN_TEXT)).toHaveLength(1);
  });

  it("still shows the player after a reload, from history alone", async () => {
    // The refresh case: nothing is delivered live, the transcript is rebuilt
    // from what the gateway stored — including the same two-message shape.
    history = [
      assistantMessage(SPOKEN_TEXT, 1787291821899),
      assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE),
    ];
    render(<ChatPopup isOpen onClose={() => {}} />);

    await waitFor(() => expect(players()).toHaveLength(1));
    expect(players()[0].getAttribute("src")).toBe(playerSrc(VOICE));
    expect(screen.getAllByText(SPOKEN_TEXT)).toHaveLength(1);
  });

  it("gives each spoken reply its own file", async () => {
    // Two answers, two recordings. A player that reused the first URL would
    // play the wrong words back — and would do it convincingly.
    history = [
      assistantMessage("First answer.", 1),
      assistantMessage("First answer.", 2, VOICE),
      assistantMessage("Second answer.", 3),
      assistantMessage("Second answer.", 4, SECOND_VOICE),
    ];
    render(<ChatPopup isOpen onClose={() => {}} />);

    await waitFor(() => expect(players()).toHaveLength(2));
    expect(players().map(p => p.getAttribute("src"))).toEqual([
      playerSrc(VOICE),
      playerSrc(SECOND_VOICE),
    ]);
  });

  it("keeps a reply that is nothing but audio", async () => {
    // An answer with no text is still an answer. Treated as an empty ack it
    // would be dropped and history refetched instead.
    history = [assistantMessage("", 1787291825743, VOICE)];
    render(<ChatPopup isOpen onClose={() => {}} />);

    await waitFor(() => expect(players()).toHaveLength(1));
  });

  it("puts no filesystem path on screen", async () => {
    // The path is the src of an element, never text — TASK-416's rule applies
    // to the spoken half of a reply exactly as it does to the written one.
    history = [
      assistantMessage(SPOKEN_TEXT, 1787291821899),
      assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE),
    ];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(players()).toHaveLength(1));

    expect(document.body.textContent).not.toContain("/home/clawbox");
    expect(document.body.textContent).not.toContain("MEDIA:");
    expect(document.body.textContent).not.toContain("voice-1787291821763");
  });
});
