import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import {
  _resetLocalAiBannerForTest,
  chatOnLocalAi,
  LOCAL_AI_BANNER_DISMISSED_KEY,
} from "@/components/LocalAiChatBanner";
import { resetHarnessCache } from "@/lib/client-harness";

// The same ceiling the sibling chat suites take.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The chat on Local AI — a model on the box itself, read into memory on the
 * first reply after it was idle, which can take a minute.
 *
 * Pinned: the note at the top of the chat ("Running on this box…") shows only
 * while the active model is local, and stays closed once closed; and while a
 * Local AI turn waits for its first token the status line says the model is
 * loading — only while llama-server answers that it is not ready — in place of
 * a spinner verb, until the first token arrives.
 *
 * TASK-2127, a long conversation switched to Local AI: one larger than the
 * local window gets a card instead of a minutes-long compaction on the box —
 * "Start a new chat with Local AI" (one click, the waiting message goes with
 * it) or "Shorten this conversation first" (the gateway's `sessions.compact`)
 * — and a turn whose compaction runs says "Shortening the conversation…".
 */

type Frame = Record<string, unknown>;

const sentFrames: Frame[] = [];
let activeSource: "local" | "primary" = "local";
/** Held until resolved: the turn's first token (a delta), then its final. */
let firstToken: Promise<void> = Promise.resolve();
let finalReply: Promise<void> = Promise.resolve();
let releaseFirstToken: () => void = () => {};
let releaseFinal: () => void = () => {};
/** What `sessions.describe` answers for the main conversation's size (other keys: a short chat). */
let mainTokens = 0;
/** llama-server's readiness, as /setup-api/llamacpp/status answers it. */
let llamaRunning = false;
/** The core's compaction frames around a turn, and when the second one comes. */
let emitCompaction = false;
let compactionDone: Promise<void> = Promise.resolve();
let releaseCompaction: () => void = () => {};
/** When `sessions.compact` answers. */
let compactGate: Promise<void> = Promise.resolve();
let releaseCompact: () => void = () => {};

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
    try { frame = JSON.parse(raw) as Frame; } catch { return; }
    if (frame.type !== "req") return;
    sentFrames.push(frame);
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") { this.respond(id, { messages: [] }); return; }
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === "sessions.describe") {
      const tokens = params.key === "agent:main:main" ? mainTokens : 2400;
      this.respond(id, { session: { key: params.key, totalTokens: tokens, contextTokens: 32768 } });
      return;
    }
    if (frame.method === "sessions.compact") {
      void compactGate.then(() => {
        mainTokens = 9000;
        this.respond(id, { ok: true, key: params.key, compacted: true, result: { tokensBefore: 100460, tokensAfter: 9000 } });
      });
      return;
    }
    if (frame.method !== "chat.send") { this.respond(id, {}); return; }
    const runId = `run-${sentFrames.length}`;
    const sessionKey = String(params.sessionKey ?? "agent:main:main");
    this.respond(id, { runId, status: "started" });
    if (emitCompaction) {
      const compaction = (phase: "start" | "end") => ({
        type: "event", event: "agent", payload: { runId, sessionKey, stream: "compaction", data: { phase } },
      });
      setTimeout(() => this.emit(compaction("start")), 0);
      void compactionDone.then(() => this.emit(compaction("end")));
    }
    const event = (state: "delta" | "final", text: string) => ({
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey,
        state,
        ...(state === "final" ? { stopReason: "stop" } : {}),
        message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1787260000000 },
      },
    });
    void firstToken.then(() => {
      this.emit(event("delta", "Gemma here"));
      void finalReply.then(() => this.emit(event("final", "Gemma here, on the box.")));
    });
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

function modelState() {
  const local = { id: "llamacpp/gemma4-e2b-it-q4_0", label: "Gemma 4 Local", model: "llamacpp/gemma4-e2b-it-q4_0", provider: "llamacpp", available: true, settingsSection: "localAi", isLocal: true };
  const cloud = { id: "anthropic/claude-sonnet-4-6", label: "Anthropic Claude", model: "anthropic/claude-sonnet-4-6", provider: "anthropic", available: true, settingsSection: "ai", isLocal: false };
  const active = activeSource === "local" ? local : cloud;
  return {
    activeOptionId: active.id,
    activeModel: active.model,
    activeSource,
    activeLabel: active.label,
    options: [cloud, local],
    primary: { available: true, label: cloud.label, model: cloud.model },
    local: { available: true, label: local.label, model: local.model, contextWindow: 32768 },
  };
}

let modelReads = 0;

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
      if (url.includes("/setup-api/chat/capabilities")) {
        return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: false, onboardingArmed: false } }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        modelReads += 1;
        return { ok: true, json: async () => modelState() };
      }
      if (url.includes("/setup-api/llamacpp/status")) {
        return { ok: true, json: async () => ({ running: llamaRunning }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** Mount the chat and wait for it to have read which model is on. */
async function mount() {
  const view = render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(modelReads).toBeGreaterThan(0));
  const textarea = await screen.findByRole("textbox");
  await waitFor(() => expect(textarea).not.toBeDisabled());
  // A tick for the model state to land and render.
  await act(async () => {});
  return view;
}

async function send(text: string) {
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  await waitFor(() => expect(sentFrames.some((f) => f.method === "chat.send")).toBe(true));
}

const statusLine = () => screen.getByTestId("chat-turn-status");

describe("the chat on Local AI", () => {
  beforeEach(() => {
    sentFrames.length = 0;
    modelReads = 0;
    activeSource = "local";
    firstToken = new Promise((resolve) => { releaseFirstToken = resolve; });
    finalReply = new Promise((resolve) => { releaseFinal = resolve; });
    mainTokens = 0;
    llamaRunning = false;
    emitCompaction = false;
    compactionDone = new Promise((resolve) => { releaseCompaction = resolve; });
    compactGate = new Promise((resolve) => { releaseCompact = resolve; });
    resetHarnessCache();
    window.localStorage.clear();
    _resetLocalAiBannerForTest();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    releaseFirstToken();
    releaseFinal();
    releaseCompaction();
    releaseCompact();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("shows the note at the top while the active model is local", async () => {
    await mount();
    const note = await screen.findByTestId("chat-local-ai-banner");
    expect(note).toHaveTextContent("Running on this box.");
    expect(note).toHaveTextContent("The first reply can take up to a minute while the local model loads. After that it's faster.");
    expect(note).toHaveAttribute("role", "note");
  });

  it("closing the note is remembered: it does not come back on the next open", async () => {
    const { unmount } = await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss this note" }));
    expect(screen.queryByTestId("chat-local-ai-banner")).toBeNull();
    expect(window.localStorage.getItem(LOCAL_AI_BANNER_DISMISSED_KEY)).toBe("1");
    unmount();

    // A fresh page load: nothing in memory, the browser's storage remembers.
    _resetLocalAiBannerForTest();
    await mount();
    expect(screen.queryByTestId("chat-local-ai-banner")).toBeNull();
  });

  it("a browser that refuses storage still keeps the note closed for the page's life", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      const { unmount } = await mount();
      fireEvent.click(await screen.findByRole("button", { name: "Dismiss this note" }));
      expect(screen.queryByTestId("chat-local-ai-banner")).toBeNull();
      unmount();
      await mount();
      expect(screen.queryByTestId("chat-local-ai-banner")).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("shows no note on a cloud model", async () => {
    activeSource = "primary";
    await mount();
    expect(screen.queryByTestId("chat-local-ai-banner")).toBeNull();
  });

  it("says the local model is loading until the turn's first token, then goes back to its usual words", async () => {
    await mount();
    await send("hello");
    await waitFor(() => expect(statusLine()).toHaveTextContent("Loading the local model…"));

    await act(async () => { releaseFirstToken(); });
    await screen.findByText("Gemma here");
    await waitFor(() => expect(statusLine()).not.toHaveTextContent("Loading the local model"));
    // The turn is still running — a verb (or "Working…") is back on the line.
    expect(statusLine().textContent).toMatch(/…/);

    await act(async () => { releaseFinal(); });
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());
  });

  it("the next turn waits for its own first token again", async () => {
    await mount();
    await send("first");
    await act(async () => { releaseFirstToken(); releaseFinal(); });
    await waitFor(() => expect(screen.queryByTestId("chat-turn-status")).toBeNull());

    firstToken = new Promise((resolve) => { releaseFirstToken = resolve; });
    finalReply = new Promise((resolve) => { releaseFinal = resolve; });
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "second" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(statusLine()).toHaveTextContent("Loading the local model…"));
  });

  it("does not say the model is loading over a llama-server that is up", async () => {
    llamaRunning = true;
    await mount();
    await send("hello");
    await waitFor(() => expect(statusLine().textContent).toMatch(/…/));
    // A few polls' worth of waiting: the words stay the usual ones.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(statusLine()).not.toHaveTextContent("Loading the local model");
    expect(statusLine()).not.toHaveTextContent("Shortening");
  });

  it("a cloud turn keeps its spinner verb", async () => {
    activeSource = "primary";
    await mount();
    await send("hello");
    await waitFor(() => expect(screen.getByTestId("chat-turn-status")).toBeInTheDocument());
    expect(statusLine()).not.toHaveTextContent("Loading the local model");
    expect(statusLine().textContent).toMatch(/…/);
  });
});

describe("chatOnLocalAi", () => {
  it("reads OpenClaw's active model source", () => {
    expect(chatOnLocalAi("openclaw", "", "local")).toBe(true);
    expect(chatOnLocalAi("openclaw", "", "primary")).toBe(false);
    expect(chatOnLocalAi("openclaw", "", null)).toBe(false);
    // A Hermes pill left in storage says nothing about an OpenClaw chat.
    expect(chatOnLocalAi("openclaw", "clawlocal", "primary")).toBe(false);
  });

  it("an external AI engine in the slot is not a model on this box (TASK-2376)", () => {
    expect(chatOnLocalAi("openclaw", "", "local", true)).toBe(false);
    expect(chatOnLocalAi("openclaw", "", "local", false)).toBe(true);
    // Hermes names the engine by its own provider, never clawlocal.
    expect(chatOnLocalAi("hermes", "clawext", null)).toBe(false);
  });

  it("reads the provider Hermes' header picked: the box's own clawlocal", () => {
    expect(chatOnLocalAi("hermes", "clawlocal", null)).toBe(true);
    expect(chatOnLocalAi("hermes", "anthropic", "local")).toBe(false);
    expect(chatOnLocalAi("hermes", "", null)).toBe(false);
  });
});

const sends = () => sentFrames.filter((f) => f.method === "chat.send");

async function type(text: string) {
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

describe("a long conversation switched to Local AI (TASK-2127)", () => {
  beforeEach(() => {
    sentFrames.length = 0;
    modelReads = 0;
    activeSource = "local";
    firstToken = new Promise((resolve) => { releaseFirstToken = resolve; });
    finalReply = new Promise((resolve) => { releaseFinal = resolve; });
    mainTokens = 100460;
    llamaRunning = true;
    emitCompaction = false;
    compactionDone = new Promise((resolve) => { releaseCompaction = resolve; });
    compactGate = new Promise((resolve) => { releaseCompact = resolve; });
    resetHarnessCache();
    window.localStorage.clear();
    _resetLocalAiBannerForTest();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    releaseFirstToken();
    releaseFinal();
    releaseCompaction();
    releaseCompact();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("offers a new chat, recommended, or a summary first — without sending anything", async () => {
    await mount();
    const offer = await screen.findByTestId("chat-local-ai-long-chat");
    expect(offer).toHaveTextContent("This conversation is too long for the local model");
    expect(offer).toHaveTextContent("It holds about 100k tokens; the local model reads up to 32k.");
    expect(screen.getByTestId("chat-local-ai-long-chat-new")).toHaveTextContent("Start a new chat with Local AI");
    expect(screen.getByTestId("chat-local-ai-long-chat-new")).toHaveTextContent("Recommended");
    expect(screen.getByTestId("chat-local-ai-long-chat-shorten")).toHaveTextContent("Shorten this conversation first");
    expect(sentFrames.find((f) => f.method === "sessions.describe")?.params).toEqual({ key: "agent:main:main" });
    expect(sends()).toHaveLength(0);
  });

  it("holds a message sent into it, and 'Start a new chat with Local AI' asks it in a new tab in one click", async () => {
    await mount();
    await screen.findByTestId("chat-local-ai-long-chat");
    await type("Колко е 17 × 23?");

    await waitFor(() => expect(screen.getByTestId("chat-local-ai-long-chat-pending")).toHaveTextContent("Колко е 17 × 23?"));
    expect(screen.getByTestId("chat-local-ai-long-chat-pending")).toHaveTextContent("Your message waits here and goes to the chat you pick.");
    expect(sends()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("chat-local-ai-long-chat-new"));

    await waitFor(() => expect(sends()).toHaveLength(1));
    const params = sends()[0].params as Record<string, unknown>;
    expect(params.sessionKey).toMatch(/^agent:main:clawbox-[a-z0-9]{12}$/);
    expect(params.message).toBe("Колко е 17 × 23?");
    // The new chat is short: no card there.
    expect(screen.queryByTestId("chat-local-ai-long-chat")).toBeNull();
    await act(async () => { releaseFirstToken(); releaseFinal(); });
    await screen.findByText("Gemma here, on the box.");
  });

  it("'Shorten this conversation first' runs the gateway's compaction, says so, then sends the message here", async () => {
    await mount();
    await screen.findByTestId("chat-local-ai-long-chat");
    await type("Колко е 17 × 23?");
    await screen.findByTestId("chat-local-ai-long-chat-pending");

    fireEvent.click(screen.getByTestId("chat-local-ai-long-chat-shorten"));

    await waitFor(() => expect(sentFrames.some((f) => f.method === "sessions.compact")).toBe(true));
    expect(sentFrames.find((f) => f.method === "sessions.compact")?.params).toEqual({ key: "agent:main:main" });
    await waitFor(() => expect(statusLine()).toHaveTextContent("Shortening the conversation for the local model…"));
    expect(screen.getByTestId("chat-local-ai-long-chat-shorten")).toBeDisabled();
    expect(sends()).toHaveLength(0);

    await act(async () => { releaseCompact(); });

    await screen.findByText("Conversation shortened for the local model.");
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].params).toMatchObject({ sessionKey: "agent:main:main", message: "Колко е 17 × 23?" });
    expect(screen.queryByTestId("chat-local-ai-long-chat")).toBeNull();
  });

  it("the × puts the waiting message back in the composer, and the conversation goes on as it is", async () => {
    await mount();
    await screen.findByTestId("chat-local-ai-long-chat");
    await type("Колко е 17 × 23?");
    await screen.findByTestId("chat-local-ai-long-chat-pending");

    fireEvent.click(screen.getByTestId("chat-local-ai-long-chat-dismiss"));

    expect(screen.queryByTestId("chat-local-ai-long-chat")).toBeNull();
    expect(await screen.findByRole("textbox")).toHaveValue("Колко е 17 × 23?");
    fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].params).toMatchObject({ sessionKey: "agent:main:main", message: "Колко е 17 × 23?" });
  });

  it("a turn says it is shortening the conversation while the core's compaction runs", async () => {
    mainTokens = 9000;
    llamaRunning = false;
    emitCompaction = true;
    await mount();
    await send("hello");
    expect(screen.queryByTestId("chat-local-ai-long-chat")).toBeNull();
    await waitFor(() => expect(statusLine()).toHaveTextContent("Shortening the conversation for the local model…"));

    await act(async () => { releaseCompaction(); });
    // The summary is done; the server is still waking: now it IS loading.
    await waitFor(() => expect(statusLine()).toHaveTextContent("Loading the local model…"));

    await act(async () => { releaseFirstToken(); });
    await waitFor(() => expect(statusLine()).not.toHaveTextContent(/Loading the local model|Shortening/));
  });

  it("a chat on a cloud model is never measured and never offered", async () => {
    activeSource = "primary";
    await mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId("chat-local-ai-long-chat")).toBeNull();
    expect(sentFrames.some((f) => f.method === "sessions.describe")).toBe(false);
  });
});
