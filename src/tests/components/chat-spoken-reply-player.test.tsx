import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { resetSpokenReplyPeakCache } from "@/components/SpokenReplyPlayer";
import { VOICE_SETTINGS_CHANGED_EVENT } from "@/lib/ui-events";

/**
 * The ClawBox player for a spoken reply, and the switch that asks for one.
 *
 * TASK-782, the owner's pick from the voice mockups (A2 + B1): the browser's
 * grey `<audio controls>` bar is replaced by a player this product draws — a
 * 36px play/pause button, a waveform read off the clip with the played part
 * filled, a clock and a download — and the composer grows a speaker button
 * that turns spoken replies on and off without a trip to Settings.
 *
 * What is pinned here is everything a screenshot cannot check: that the
 * control is operable from the keyboard, that its accessible name is still the
 * one `audioLabel` computes, that the waveform never blocks the reply from
 * rendering and degrades to a plain bar when a clip cannot be decoded, that a
 * silent reply grows no player at all, and — the part that would otherwise
 * quietly grow a second source of truth — that the toggle writes the EXISTING
 * spoken-replies setting through the same route Settings → Voice writes.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const VOICE = "/home/clawbox/.openclaw/media/outbound/voice-1787291821763---93f78bf1.wav";
const SPOKEN_TEXT = "The lantern is green.";
const playerSrc = (p: string) => `/setup-api/chat/media?path=${encodeURIComponent(p)}`;

/** What `chat.history` replays. Set before the component mounts. */
let history: unknown[] = [];
/** The answer `/setup-api/tts` gives, as the tests set it up. */
let ttsAnswer: Record<string, unknown> = { choice: "auto", autoReply: true };
/** Every POST the component made, in order. */
let posts: Array<{ url: string; body: unknown }> = [];
/** What the `autoReply` POST answers with. */
let postAnswer: { ok: boolean; status?: number; body: Record<string, unknown> } = {
  ok: true,
  body: { choice: "auto", autoReply: false },
};

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
    if (frame.method === "chat.history") { this.respond(id, { messages: history }); return; }
    this.respond(id, {});
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
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body ?? "null")) });
      if (url.includes("/setup-api/tts")) {
        return {
          ok: postAnswer.ok,
          status: postAnswer.status ?? (postAnswer.ok ? 200 : 403),
          json: async () => postAnswer.body,
        };
      }
      return { ok: true, json: async () => ({}) };
    }
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
      return { ok: true, json: async () => ({ items: [] }) };
    }
    if (url.includes("/setup-api/tts")) {
      return { ok: true, json: async () => ttsAnswer };
    }
    // The peak reader asks for the clip itself.
    if (url.includes("/setup-api/chat/media")) {
      clipFetches.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

/** Push the `session.message` event a spoken reply's audio rides on. */
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
    payload: { runId: "r1", sessionKey: "agent:main:main", state: "final", stopReason: "stop", message },
  });
}

// ── A media element jsdom does not implement ──────────────────────────────
const MEDIA = window.HTMLMediaElement.prototype;
const saved: Array<[string, PropertyDescriptor | undefined]> = [];
const clocks = new WeakMap<HTMLMediaElement, number>();
const paused = new WeakMap<HTMLMediaElement, boolean>();
let clipDuration: number = 21;

function stubMediaElement() {
  for (const name of ["play", "pause", "duration", "currentTime", "paused"]) {
    saved.push([name, Object.getOwnPropertyDescriptor(MEDIA, name)]);
  }
  Object.defineProperty(MEDIA, "duration", { configurable: true, get() { return clipDuration; } });
  Object.defineProperty(MEDIA, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) { return paused.get(this) !== false; },
  });
  Object.defineProperty(MEDIA, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) { return clocks.get(this) ?? 0; },
    set(this: HTMLMediaElement, value: number) {
      clocks.set(this, value);
      this.dispatchEvent(new Event("timeupdate"));
    },
  });
  Object.defineProperty(MEDIA, "play", {
    configurable: true,
    value: vi.fn(async function (this: HTMLMediaElement) {
      paused.set(this, false);
      this.dispatchEvent(new Event("play"));
    }),
  });
  Object.defineProperty(MEDIA, "pause", {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      paused.set(this, true);
      this.dispatchEvent(new Event("pause"));
    }),
  });
}

function restoreMediaElement() {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(MEDIA, name, descriptor);
    else delete (MEDIA as unknown as Record<string, unknown>)[name];
  }
  saved.length = 0;
}

/**
 * A decoder that answers, one that never answers, or one that refuses —
 * the three states the waveform has to survive.
 */
let decodeMode: "ok" | "pending" | "fail" = "ok";
function stubAudioDecoder() {
  class FakeOfflineAudioContext {
    decodeAudioData(): Promise<unknown> {
      if (decodeMode === "fail") return Promise.reject(new Error("not audio"));
      if (decodeMode === "pending") return new Promise(() => {});
      const samples = new Float32Array(4410);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 40) * (i / samples.length);
      return Promise.resolve({
        duration: clipDuration,
        length: samples.length,
        numberOfChannels: 1,
        sampleRate: 44100,
        getChannelData: () => samples,
      });
    }
  }
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
  vi.stubGlobal("AudioContext", FakeOfflineAudioContext);
}

/**
 * A viewport that reports what it sees.
 *
 * `src/tests/setup.ts` installs a NO-OP IntersectionObserver for every suite,
 * which is right for a component that only uses one to be polite and wrong
 * here: the waveform is read when the player comes ON SCREEN, so a viewport
 * that never reports anything means no waveform, ever. `visible = false` is
 * the other half — a player scrolled far down a transcript, which must cost
 * nothing at all.
 */
let visible = true;
function stubViewport() {
  class FakeIntersectionObserver {
    constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { if (visible) setTimeout(() => this.cb([{ isIntersecting: true }]), 0); }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
}

/** Every clip body the peak reader asked the box for. */
let clipFetches: string[] = [];

const playButton = () => screen.getByTestId("spoken-reply-play");
const wave = () => screen.getByTestId("spoken-reply-wave");
const clock = () => screen.getByTestId("spoken-reply-clock");

async function renderReplyWithAudio() {
  // The stored transcript carries the reply's WORDS, the way the gateway
  // replays it: `session.message` schedules a history re-read a few hundred
  // milliseconds later, and a history that had forgotten the turn would take
  // the bubble back off the screen underneath a slow assertion.
  history = [assistantMessage(SPOKEN_TEXT, 1787291821899)];
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByRole("textbox");
  deliver(assistantMessage(SPOKEN_TEXT, 1787291821899));
  await screen.findByText(SPOKEN_TEXT);
  deliverSessionMessage(assistantMessage(SPOKEN_TEXT, 1787291825743, VOICE));
  return await screen.findByTestId("spoken-reply-player");
}

describe("the ClawBox player for a spoken reply", () => {
  beforeEach(() => {
    sockets.length = 0;
    posts = [];
    history = [];
    // Peaks are cached per URL for the page's lifetime — which is the point of
    // them, and would otherwise hand the next test the previous one's decode.
    resetSpokenReplyPeakCache();
    ttsAnswer = { choice: "auto", autoReply: true, engines: [{ id: "local", configured: true }] };
    postAnswer = { ok: true, body: { choice: "auto", autoReply: false } };
    decodeMode = "ok";
    clipDuration = 21;
    visible = true;
    clipFetches = [];
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
    stubMediaElement();
    stubAudioDecoder();
    stubViewport();
  });

  afterEach(() => {
    restoreMediaElement();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("draws its own transport instead of the browser's bar", async () => {
    await renderReplyWithAudio();
    const audio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    // The browser's grey bar is gone; everything it did is ours now.
    expect(audio.getAttribute("controls")).toBeNull();
    // ...but not the two things that made the old one work: the media route
    // answers Range requests for the scrubber, and the duration is on screen
    // before the file is pulled down.
    expect(audio.getAttribute("src")).toBe(playerSrc(VOICE));
    expect(audio.getAttribute("preload")).toBe("metadata");

    // The name the code already computes, under the verb of the next press.
    expect(playButton()).toHaveAccessibleName(`chat.audioPlay chat.audioReply: ${SPOKEN_TEXT}`);
    expect(wave()).toHaveAttribute("role", "slider");
    // The length arrives with the element's metadata, not with the markup.
    await waitFor(() => expect(wave()).toHaveAttribute("aria-valuemax", "21"));
    // A clock nothing announces: a live region ticking once a second is the
    // mistake the recording clock's own comment documents.
    expect(clock()).toHaveAttribute("aria-hidden", "true");
    const download = screen.getByTestId("spoken-reply-download");
    expect(download).toHaveAttribute("href", playerSrc(VOICE));
    expect(download).toHaveAttribute("download");
  });

  it("plays, pauses and says which the button will do next", async () => {
    await renderReplyWithAudio();
    fireEvent.click(playButton());
    await waitFor(() => expect(playButton()).toHaveAccessibleName(
      `chat.audioPause chat.audioReply: ${SPOKEN_TEXT}`));
    fireEvent.click(playButton());
    await waitFor(() => expect(playButton()).toHaveAccessibleName(
      `chat.audioPlay chat.audioReply: ${SPOKEN_TEXT}`));
  });

  it("shows the length at rest and the elapsed time while it plays", async () => {
    await renderReplyWithAudio();
    await waitFor(() => expect(clock()).toHaveTextContent("0:21"));
    const audio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    fireEvent.click(playButton());
    act(() => { audio.currentTime = 8; });
    await waitFor(() => expect(clock()).toHaveTextContent("0:08 / 0:21"));
  });

  it("seeks from the keyboard: arrows five seconds, Home and End to the edges", async () => {
    await renderReplyWithAudio();
    const audio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    const bar = wave();
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    await waitFor(() => expect(audio.currentTime).toBe(5));
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    await waitFor(() => expect(audio.currentTime).toBe(10));
    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    await waitFor(() => expect(audio.currentTime).toBe(5));
    fireEvent.keyDown(bar, { key: "Home" });
    await waitFor(() => expect(audio.currentTime).toBe(0));
    fireEvent.keyDown(bar, { key: "End" });
    await waitFor(() => expect(audio.currentTime).toBe(21));
    // The position is readable, not only visible.
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "21"));
    // Space plays from the bar itself.
    fireEvent.keyDown(bar, { key: " " });
    await waitFor(() => expect(playButton()).toHaveAccessibleName(
      `chat.audioPause chat.audioReply: ${SPOKEN_TEXT}`));
  });

  it("renders the reply before the peaks are known, and never waits for them", async () => {
    decodeMode = "pending";
    await renderReplyWithAudio();
    // The player is fully usable while the decode is still out.
    expect(wave()).toHaveAttribute("data-peaks", "placeholder");
    fireEvent.click(playButton());
    await waitFor(() => expect(playButton()).toHaveAccessibleName(
      `chat.audioPause chat.audioReply: ${SPOKEN_TEXT}`));
  });

  it("falls back to a plain progress bar when the clip cannot be decoded", async () => {
    decodeMode = "fail";
    await renderReplyWithAudio();
    await waitFor(() => expect(wave()).toHaveAttribute("data-peaks", "unavailable"));
    // Still a slider, still seekable — only the bars are gone.
    fireEvent.keyDown(wave(), { key: "End" });
    const audio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    await waitFor(() => expect(audio.currentTime).toBe(21));
  });

  it("draws the clip's own shape, and fills it as the reply plays", async () => {
    // The headline of the whole control, and the one thing a `data-peaks`
    // attribute cannot promise: that the decoded envelope reaches the screen
    // and that the played part of it is the part that is filled.
    await renderReplyWithAudio();
    await waitFor(() => expect(wave()).toHaveAttribute("data-peaks", "ready"));
    const bars = () => wave().querySelectorAll(".spoken-reply-bar");
    expect(bars().length).toBeGreaterThan(8);
    // Nothing played yet, so nothing is filled.
    expect(wave().querySelectorAll(".spoken-reply-bar.on")).toHaveLength(0);
    // The shape is the CLIP's, not a flat block: the stub's envelope rises.
    const heights = [...bars()].map((bar) => Number.parseFloat((bar as HTMLElement).style.height));
    expect(new Set(heights).size).toBeGreaterThan(1);

    const audio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    act(() => { audio.currentTime = clipDuration / 2; });
    await waitFor(() => {
      const on = wave().querySelectorAll(".spoken-reply-bar.on").length;
      expect(on).toBeGreaterThan(0);
      expect(on).toBeLessThan(bars().length);
    });
  });

  it("holds still until the element knows how long the clip is", async () => {
    // In a browser `duration` is NaN until `loadedmetadata`, which the stub's
    // synchronous getter otherwise hides. Every seek is computed from it, and
    // a player that treated NaN as a number would jump the position to NaN and
    // put "NaN:NaN" on the clock.
    clipDuration = Number.NaN;
    await renderReplyWithAudio();
    expect(clock()).toHaveTextContent("0:00");
    expect(wave()).toHaveAttribute("aria-valuemax", "0");
    const audio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    fireEvent.keyDown(wave(), { key: "End" });
    fireEvent.keyDown(wave(), { key: "ArrowRight" });
    expect(audio.currentTime).toBe(0);

    // ...and it catches up the moment the metadata lands.
    clipDuration = 21;
    act(() => { audio.dispatchEvent(new Event("loadedmetadata")); });
    await waitFor(() => expect(wave()).toHaveAttribute("aria-valuemax", "21"));
  });

  it("says so, and stops pretending to be pressable, when the clip is gone", async () => {
    // A transcript keeps its media URLs; the file behind one can be cleaned up
    // and the route then 404s. The browser's own bar showed its broken state —
    // ours has to, or it draws play / 0:00 / download over nothing.
    await renderReplyWithAudio();
    const audio = screen.getByTestId("chat-audio") as HTMLAudioElement;
    act(() => { audio.dispatchEvent(new Event("error")); });

    await screen.findByTestId("spoken-reply-unavailable");
    expect(playButton()).toBeDisabled();
    expect(screen.queryByTestId("spoken-reply-wave")).toBeNull();
    expect(screen.queryByTestId("spoken-reply-download")).toBeNull();
  });

  it("costs nothing for a reply nobody has scrolled to", async () => {
    // The whole clip has to come down to draw its shape, and a replayed
    // transcript can hold fifty of them. Eagerly that is tens of megabytes
    // pulled through the box's own server, on a Jetson, for bars nobody is
    // looking at — so the read waits for the player to be on screen, exactly
    // as `preload="metadata"` makes the audio wait to be played.
    visible = false;
    await renderReplyWithAudio();
    // The player is there and usable; only its picture is deferred.
    expect(wave()).toHaveAttribute("data-peaks", "placeholder");
    fireEvent.click(playButton());
    await waitFor(() => expect(playButton()).toHaveAccessibleName(
      `chat.audioPause chat.audioReply: ${SPOKEN_TEXT}`));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(clipFetches).toEqual([]);
  });

  it("gives a silent reply no player at all", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await screen.findByRole("textbox");
    deliver(assistantMessage("No sound here.", 1787291821899));
    await screen.findByText("No sound here.");
    expect(screen.queryByTestId("spoken-reply-player")).toBeNull();
    expect(screen.queryByTestId("chat-audio")).toBeNull();
  });
});

describe("the composer's spoken-replies toggle", () => {
  beforeEach(() => {
    sockets.length = 0;
    posts = [];
    history = [];
    // Peaks are cached per URL for the page's lifetime — which is the point of
    // them, and would otherwise hand the next test the previous one's decode.
    resetSpokenReplyPeakCache();
    ttsAnswer = { choice: "auto", autoReply: true, engines: [{ id: "local", configured: true }] };
    postAnswer = { ok: true, body: { choice: "auto", autoReply: false } };
    clipDuration = 21;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
    stubMediaElement();
    stubAudioDecoder();
    stubViewport();
  });

  afterEach(() => {
    restoreMediaElement();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("shows the box's own setting, and writes it through the route Settings writes", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const toggle = await screen.findByTestId("chat-speak-toggle");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(toggle).toHaveAccessibleName("chat.spokenRepliesOn");

    fireEvent.click(toggle);
    // The EXISTING setting — one switch, not a second one beside it.
    await waitFor(() => expect(posts).toEqual([
      { url: "/setup-api/tts", body: { action: "autoReply", enabled: false } },
    ]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(toggle).toHaveAccessibleName("chat.spokenRepliesOff");
    // Said in words, not only in colour, and politely announced.
    const notice = await screen.findByTestId("chat-speak-notice");
    expect(notice).toHaveTextContent("chat.spokenRepliesOffNotice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the switch where it was when the box refuses the write", async () => {
    // The false-success trap: an owner-only route answers 403 to a session
    // that cannot change it, and a toggle that flipped anyway would say the
    // box was quiet while it went on speaking.
    postAnswer = { ok: false, status: 403, body: { error: "owner only", code: "owner_only" } };
    render(<ChatPopup isOpen onClose={() => {}} />);
    const toggle = await screen.findByTestId("chat-speak-toggle");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(toggle);
    await waitFor(() => expect(posts.length).toBe(1));
    await waitFor(() => expect(screen.getByTestId("chat-speak-notice")).toHaveTextContent("chat.spokenRepliesFailed"));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("stays offered when the box says nothing about its engines", async () => {
    // `null` is not "no". An unreachable route, or one too old to report its
    // engines, says nothing about them — and hiding the switch on silence
    // would take a working control off a box that speaks perfectly well.
    ttsAnswer = { choice: "auto", autoReply: true };
    render(<ChatPopup isOpen onClose={() => {}} />);
    expect(await screen.findByTestId("chat-speak-toggle")).toBeInTheDocument();
  });

  it("follows the box's voice being installed while the chat is open", async () => {
    // Probe-once: the engines were read only when the popup opened, so an
    // owner who installed Kokoro in Settings beside a docked chat had no
    // button until the chat was closed and reopened.
    ttsAnswer = { choice: "auto", autoReply: true, engines: [{ id: "local", configured: false }] };
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByRole("textbox");
    await waitFor(() => expect(screen.queryByTestId("chat-speak-toggle")).toBeNull());

    act(() => {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGED_EVENT, {
        detail: { autoReply: true, engines: [{ id: "local", configured: true }] },
      }));
    });
    expect(await screen.findByTestId("chat-speak-toggle")).toBeInTheDocument();
  });

  it("is not offered on a box with no voice to speak with", async () => {
    ttsAnswer = { choice: "auto", autoReply: true, engines: [
      { id: "local", configured: false }, { id: "cloud", configured: false },
    ] };
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByRole("textbox");
    await waitFor(() => expect(screen.queryByTestId("chat-speak-toggle")).toBeNull());
  });
});
