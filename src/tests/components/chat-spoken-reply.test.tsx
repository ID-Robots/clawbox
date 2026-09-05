import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// The popup this suite mounts grew a session-tab strip and the OpenClaw 2
// device-identity handshake; under a FULL suite run every vitest worker gets
// a slice of the Jetson's six cores and the 5 s default started expiring on
// whichever test mounted while the box was busiest (a different one each
// run — solo runs never failed). The work is real, not hung: give it room.
//
// 30 s, the same number as every other file that declares a ceiling. It stood
// at 15 000 — exactly MIN_TIMEOUT_MS in
// src/tests/unit/test-timeout-hygiene.test.ts, so it passed that guard with no
// margin at all and would go red the day the floor moved by a millisecond. One
// number across the fleet is also one number to reason about.
//
// The other ceiling on this file is Testing Library's `asyncUtilTimeout`
// (src/tests/setup.ts), which bounds a SINGLE `findBy*` wait at 5 s and is not
// what this raises. Deliberate: the failures recorded here were vitest's own
// "Test timed out in 5000ms", i.e. several sub-5 s waits in series, and raising
// asyncUtilTimeout to 15 s was tried on this branch and reverted — the same
// cases still failed, one at 15.5 s and one on an outright assertion at 387 ms.
// Whatever that is, it is not a wait that needed longer.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
const IMAGE = "/home/clawbox/.openclaw/media/tool-image-generation/crab.png";
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

function assistantMessageWithAudio(text: string, timestamp: number, audioPaths: string[]) {
  return {
    role: "assistant",
    timestamp,
    content: [
      { type: "text", text },
      ...audioPaths.map((audioPath) => ({
        type: "attachment",
        attachment: { url: audioPath, kind: "audio", label: "voice.wav", mimeType: "audio/wav" },
      })),
    ],
  };
}

/** What the gateway replays. Set per test before the component mounts. */
let history: unknown[] = [];
/** How many times the component has re-read it. */
let historyReads = 0;
/** Durable mapping recovered from the on-box transcript route. */
let durableSpoken: Array<{ targetTimestamp: number; audio: string[] }> = [];

/**
 * The socket the component opened.
 *
 * Recorded by the class itself rather than by `socket = this` in a subclass
 * constructor: that trips `@typescript-eslint/no-this-alias` and fails lint.
 */
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    sockets.push(this);
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
      historyReads += 1;
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
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: durableSpoken }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

/**
 * Push the `session.message` event the harness sends for a spoken reply.
 *
 * This is where the audio actually is. Measured on box .65: the attachment
 * part rides this event and `chat.history` never returns it, so a client that
 * only reads the `chat` stream and the history replay renders no player at all.
 */
function deliverSessionMessage(message: unknown) {
  socket()?.emit({
    type: "event",
    event: "session.message",
    payload: { sessionKey: "agent:main:main", agentId: "main", message },
  });
}

/** Push one `final` chat event, the way a completed turn arrives. */
function deliver(message: unknown) {
  socket()?.emit({
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

function messageBubble(element: Element): Element | null {
  if (element instanceof HTMLAudioElement) return element.parentElement?.parentElement ?? null;
  // img -> preview button -> image wrapper -> image list -> message bubble.
  return element.parentElement?.parentElement?.parentElement?.parentElement ?? null;
}

describe("spoken replies in the mascot chat", () => {
  beforeEach(() => {
    history = [];
    historyReads = 0;
    durableSpoken = [];
    sockets.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("renders the audio the harness attached as a player with native controls", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByRole("textbox");

    deliver(assistantMessage(SPOKEN_TEXT, 1787291821899));
    await screen.findByText(SPOKEN_TEXT);
    deliverSessionMessage(assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE));

    await waitFor(() => expect(players()).toHaveLength(1));
    const player = players()[0];
    // `controls` is the acceptance: play/pause, seek and duration are the
    // browser's, and they are only there if the attribute is.
    expect(player.getAttribute("controls")).not.toBeNull();
    expect(player.getAttribute("src")).toBe(playerSrc(VOICE));
    // Duration on screen before anything is played, without pulling the file
    // down for a reply nobody listens to.
    expect(player.getAttribute("preload")).toBe("metadata");
    expect(player).toHaveAccessibleName(`chat.audioReply: ${SPOKEN_TEXT}`);
  });

  it("labels the player with speakable text, not the markdown the model wrote", async () => {
    // Observed live on .177 at beta 084e3f7: the model answered
    // `Sent — *"Seventeen copper bells."*` and the player's accessible name was
    // that string verbatim, so a screen reader announced the asterisks. It also
    // carried the whole message body, including a paragraph about how MEDIA is
    // delivered — internal wording, read out as the control's name.
    const MARKDOWN = 'Sent — *"Seventeen copper bells."*\n\nSee [the docs](https://clawbox.com/docs/tts) or run `openclaw health`.';
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByRole("textbox");

    deliver(assistantMessage(MARKDOWN, 1787291821899));
    deliverSessionMessage(assistantMessage(MARKDOWN, 1787291825743, VOICE));
    await waitFor(() => expect(players()).toHaveLength(1));

    const name = players()[0].getAttribute("aria-label") ?? "";
    expect(name.startsWith("chat.audioReply: ")).toBe(true);
    for (const marker of ["*", "`", "](", "https://"]) {
      expect(name).not.toContain(marker);
    }
    // The words survive; only the syntax is gone.
    expect(name).toContain("Seventeen copper bells.");
    expect(name).toContain("the docs");
  });

  it("does not show the answer twice when its spoken half arrives", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByRole("textbox");

    deliver(assistantMessage(SPOKEN_TEXT, 1787291821899));
    await screen.findByText(SPOKEN_TEXT);
    deliverSessionMessage(assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE));
    await waitFor(() => expect(players()).toHaveLength(1));

    expect(screen.getAllByText(SPOKEN_TEXT)).toHaveLength(1);
  });

  it("keeps the player when the history reconcile that event triggers comes back without it", async () => {
    // The trap this exists for: `session.message` schedules a history re-read,
    // and the history the gateway returns has no attachment in it. Rebuilding
    // the transcript from that answer alone takes the player back off the
    // screen a few hundred milliseconds after it appeared — which reads as a
    // flicker, not as a bug, and is worse than never showing it.
    history = [assistantMessage(SPOKEN_TEXT, 1787291821899)];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByText(SPOKEN_TEXT);

    deliverSessionMessage(assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE));
    await waitFor(() => expect(players()).toHaveLength(1));

    // The reconcile is debounced ~400ms behind the event. Asserting it really
    // ran, not just that time passed: a test that silently never re-read
    // history would pass on exactly the bug it is written to catch.
    const before = historyReads;
    await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3000 });
    expect(players()).toHaveLength(1);
    expect(players()[0].getAttribute("src")).toBe(playerSrc(VOICE));
  });

  it("restores stripped gateway history from the on-box transcript after a fresh remount", async () => {
    // Real .65 shape: chat.history has only the ordinary text replies. The
    // supplement route recovers exact target timestamps from the transcript,
    // so this starts with no React state and remains correct after unmount.
    history = [
      assistantMessage("Sure.", 100),
      assistantMessage("Sure.", 200),
    ];
    durableSpoken = [
      { targetTimestamp: 100, audio: [playerSrc(VOICE)] },
      { targetTimestamp: 200, audio: [playerSrc(SECOND_VOICE)] },
    ];
    const first = render(<ChatPopup isOpen onClose={() => {}} />);

    await waitFor(() => expect(players()).toHaveLength(2));
    expect(players().map(p => p.getAttribute("src"))).toEqual([
      playerSrc(VOICE),
      playerSrc(SECOND_VOICE),
    ]);

    first.unmount();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(players()).toHaveLength(2));
    expect(players().map(p => p.getAttribute("src"))).toEqual([
      playerSrc(VOICE),
      playerSrc(SECOND_VOICE),
    ]);
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

  it("holds an early repeated-text supplement for the new reply, not the old one", async () => {
    history = [
      assistantMessage("Sure.", 100, VOICE),
      { role: "user", content: [{ type: "text", text: "Again" }], timestamp: 150 },
    ];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(players()).toHaveLength(1));

    // The new audio beats its chat.final. Text-only matching used to attach it
    // to the older identical answer and then suppress the real new reply.
    history = [
      assistantMessage("Sure.", 100),
      { role: "user", content: [{ type: "text", text: "Again" }], timestamp: 150 },
      assistantMessage("Sure.", 200),
    ];
    durableSpoken = [
      { targetTimestamp: 100, audio: [playerSrc(VOICE)] },
      { targetTimestamp: 200, audio: [playerSrc(SECOND_VOICE)] },
    ];
    deliverSessionMessage(assistantMessage("Sure.", 210, SECOND_VOICE));
    deliver(assistantMessage("Sure.", 200));

    await waitFor(() => expect(players()).toHaveLength(2));
    expect(players().map(p => p.getAttribute("src"))).toEqual([
      playerSrc(VOICE),
      playerSrc(SECOND_VOICE),
    ]);
  });

  it("never carries a late old supplement into a later identical reply", async () => {
    history = [
      assistantMessage("Sure.", 100),
      { role: "user", content: [{ type: "text", text: "Again" }], timestamp: 150 },
    ];
    durableSpoken = [{ targetTimestamp: 100, audio: [playerSrc(VOICE)] }];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(players()).toHaveLength(1));
    const before = historyReads;

    // Turn-one audio arrives only after turn two has begun. A text-only pending
    // queue would hand it to turn two's identical final.
    deliverSessionMessage(assistantMessage("Sure.", 175, VOICE));
    history = [
      assistantMessage("Sure.", 100),
      { role: "user", content: [{ type: "text", text: "Again" }], timestamp: 150 },
      assistantMessage("Sure.", 200),
    ];
    deliver(assistantMessage("Sure.", 200));

    await waitFor(() => expect(screen.getAllByText("Sure.")).toHaveLength(2));
    await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3000 });
    expect(players()).toHaveLength(1);
    expect(players()[0].getAttribute("src")).toBe(playerSrc(VOICE));
  });

  it("does not render audio carried by an internal routing envelope", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    deliverSessionMessage({
      role: "user",
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      content: [
        { type: "text", text: "[Inter-session message] internal route" },
        { type: "attachment", attachment: { url: VOICE, kind: "audio", mimeType: "audio/wav" } },
      ],
      timestamp: 300,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(players()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("internal route");
  });

  it("keeps a reply that is nothing but audio", async () => {
    // An answer with no text is still an answer. Treated as an empty ack it
    // would be dropped and history refetched instead.
    history = [assistantMessage("", 1787291825743, VOICE)];
    render(<ChatPopup isOpen onClose={() => {}} />);

    await waitFor(() => expect(players()).toHaveLength(1));
  });

  it("keeps an audio-only history reply separate from a caption-free image", async () => {
    history = [
      assistantMessage(`MEDIA:${IMAGE}`, 100),
      assistantMessage("", 200, VOICE),
    ];
    render(<ChatPopup isOpen onClose={() => {}} />);

    const image = await screen.findByAltText("chat.generatedImage");
    await waitFor(() => expect(players()).toHaveLength(1));
    expect(messageBubble(players()[0])).not.toBe(messageBubble(image));
  });

  it("does not text-match a live audio-only event to a caption-free image", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    deliver(assistantMessage(`MEDIA:${IMAGE}`, 100));
    const image = await screen.findByAltText("chat.generatedImage");

    history = [
      assistantMessage(`MEDIA:${IMAGE}`, 100),
      assistantMessage("", 200, VOICE),
    ];
    deliverSessionMessage(assistantMessage("", 200, VOICE));

    await waitFor(() => expect(players()).toHaveLength(1));
    expect(messageBubble(players()[0])).not.toBe(messageBubble(image));
  });

  it("does not text-match an audio-only final to a caption-free image", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    deliver(assistantMessage(`MEDIA:${IMAGE}`, 100));
    const image = await screen.findByAltText("chat.generatedImage");
    deliver(assistantMessage("", 200, VOICE));

    await waitFor(() => expect(players()).toHaveLength(1));
    expect(messageBubble(players()[0])).not.toBe(messageBubble(image));
  });

  it("caps a live reply at four distinct audio players", async () => {
    const sources = Array.from({ length: 6 }, (_, index) =>
      `/home/clawbox/.openclaw/media/outbound/live-${index}.wav`);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());

    deliver(assistantMessageWithAudio("Bounded live reply", 250, sources));

    await waitFor(() => expect(players()).toHaveLength(4));
    expect(players().map(player => player.getAttribute("src"))).toEqual(
      sources.slice(0, 4).map(playerSrc),
    );
  });

  it("deduplicates and caps durable audio at four players", async () => {
    const sources = Array.from({ length: 5 }, (_, index) =>
      `/home/clawbox/.openclaw/media/outbound/durable-${index}.wav`);
    history = [assistantMessage("Bounded durable reply", 260)];
    durableSpoken = [{
      targetTimestamp: 260,
      audio: [playerSrc(sources[0]), playerSrc(sources[0]), ...sources.slice(1).map(playerSrc)],
    }];
    render(<ChatPopup isOpen onClose={() => {}} />);

    await waitFor(() => expect(players()).toHaveLength(4));
    expect(players().map(player => player.getAttribute("src"))).toEqual(
      sources.slice(0, 4).map(playerSrc),
    );
  });

  it("does not preserve stale audio-only state onto a caption-free image", async () => {
    history = [assistantMessage("", 100, VOICE)];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(players()).toHaveLength(1));

    history = [assistantMessage(`MEDIA:${IMAGE}`, 200)];
    const before = historyReads;
    deliverSessionMessage({
      role: "user",
      content: [{ type: "text", text: "refresh" }],
      timestamp: 300,
    });

    await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3000 });
    await screen.findByAltText("chat.generatedImage");
    expect(players()).toHaveLength(0);
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
  it("folds the spoken supplement into a turn that named emails", async () => {
    // A reply that points at mail keeps its `EMAIL:` lines in the STORED text
    // — they are lifted at render, not at write — while the pushed supplement
    // arrives already stripped. Comparing the two raw would never match, and
    // the audio would be dropped or land in a bubble of its own.
    const summary = "Jane sent the Wednesday plan.";
    const withRefs = `${summary}
EMAIL:4471`;

    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByRole("textbox");

    deliver(assistantMessage(withRefs, 1787291821899));
    // Generous waits: this suite drives a fake socket through real timers, and
    // a cold run here is slower than the 1s default allows for.
    await screen.findByText(summary, {}, { timeout: 5000 });
    expect(await screen.findAllByTestId("chat-email-card", {}, { timeout: 5000 })).toHaveLength(1);

    deliverSessionMessage(assistantMessage(withRefs, 1787291825743, VOICE));

    await waitFor(() => expect(players()).toHaveLength(1), { timeout: 5000 });
    // One answer with a player, not the answer twice.
    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.getAllByTestId("chat-email-card")).toHaveLength(1);
    // And the player's accessible name is the SUMMARY, not the stored text: it
    // is built from the same split body the bubble shows, so a screen reader
    // does not read "EMAIL 4471" aloud after it. The recorded audio is a second
    // copy: on Hermes ClawBox synthesises it and now strips the directives
    // there too (src/tests/routes/hermes/chat-spoken-reply.test.ts); on
    // OpenClaw the gateway makes it — with a cloud voice ClawBox never touches,
    // or by running ClawBox's own scripts/openclaw/clawbox-tts.sh for on-device
    // Kokoro — and neither engine strips the id, so it is still spoken there.
    // TASK-697's half, on the outbound hook that covers both.
    const label = players()[0].getAttribute("aria-label") ?? "";
    expect(label).toContain(summary);
    expect(label).not.toContain("EMAIL:4471");
    expect(label).not.toContain("4471");
  });
});
