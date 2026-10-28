import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { OPEN_SETTINGS_SECTION_EVENT } from "@/lib/ui-events";

// Both surfaces mount the fake gateway handshake, the history restore and the
// transcript in jsdom; see test-timeout-hygiene.test.ts for the per-file ceiling.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A turn stuck on a model the account cannot run (xAI, 2026-10): grok-4.6
 * answered every call with a 429 stating `Requests per Minute (actual/limit):
 * 0/0`, the core retried it nine times over a minute, and the owner read "The
 * AI service needs a short break". Before its first wait the core tells the
 * chat the attempt failed on a rate limit (`agent` lifecycle `finishing`); the
 * chat hands the run to the box at once, the box confirms the zero limit,
 * stops the run, moves the chat to Grok 4.7 and sends the turn again — and the
 * chat says that, instead of "Stopped." for a Stop nobody pressed.
 *
 * The frames are the pinned core's (2026.10.7) for such an attempt.
 */

const MAIN = "agent:main:main";
const SEED_TEXT = "Ready when you are.";
const PROMPT = "summarise my inbox";
const CORE_COPY = "⚠️ The AI service needs a short break. Please try again in a few minutes.";

const FALLBACK_LINE =
  "Grok 4.6 is not available on this xAI account — its rate limit is 0 (no API credit or quota for it yet)."
  + " Switched the chat to Grok 4.7 and sent your message again."
  + " To use Grok 4.6, add credit at console.x.ai.";

/** The test box, 2026-10: the account's xAI quota ran out — every Grok model answers 0/0. */
const NO_QUOTA_LINE =
  "Your xAI account has no API quota right now (xAI sets it by your spend). Add credit at console.x.ai, or switch provider.";
const EXHAUSTED = {
  handled: true, kind: "zero_quota", provider: "xai", model: "grok-4.7", modelLabel: "Grok 4.7",
  fallbackModel: null, fallbackLabel: null, switched: false, resent: false, news: true,
  accountExhausted: true, alternative: { model: "openai/gpt-5.5", label: "ChatGPT", provider: "openai-codex" },
};

/** Every inline colour from `el` up to the transcript: what the bubble is drawn in. */
function coloursAround(el: HTMLElement): string[] {
  const out: string[] = [];
  for (let node: HTMLElement | null = el; node; node = node.parentElement) if (node.style?.color) out.push(node.style.color);
  return out;
}

let histories: Record<string, unknown[]> = {};
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;
/** What the box answers a fallback report with, and when. */
let fallbackAnswer: { body: Record<string, unknown>; release: Promise<void> } = { body: { handled: false }, release: Promise.resolve() };

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    sent.push(frame);
    const id = frame.id as string;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === "connect") return this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
    if (frame.method === "chat.history") return this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
    if (frame.method === "chat.send") return this.respond(id, { runId: params.idempotencyKey, status: "started" });
    this.respond(id, {});
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }

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
    if (url.includes("/setup-api/gateway/ws-config")) return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    if (url.includes("/setup-api/harness/active")) return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    if (url.includes("/setup-api/chat/model")) return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    if (url.includes("/setup-api/chat/spoken-history")) return { ok: true, json: async () => ({ items: [] }) };
    if (url.includes("/setup-api/ai-models/model-fallback")) {
      const { body, release } = fallbackAnswer;
      await release;
      return { ok: true, json: async () => body };
    }
    return { ok: true, headers: new Headers(), json: async () => ({}) };
  }));
}

const fallbackReports = () => vi.mocked(fetch).mock.calls
  .filter(([input]) => String(input).includes("/setup-api/ai-models/model-fallback"))
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const bubbles = (text: string | RegExp) => screen.queryAllByText(text).filter((el) => el.tagName !== "TEXTAREA");
const STOPPED = /^(Stopped\.|chat\.stopped)$/;

function lastSend(): { runId: string; sessionKey: string } {
  const send = sent.filter((f) => f.method === "chat.send").pop();
  const params = (send?.params ?? {}) as { idempotencyKey?: string; sessionKey?: string };
  return { runId: String(params.idempotencyKey ?? ""), sessionKey: String(params.sessionKey ?? "") };
}

async function push(event: string, payload: Record<string, unknown>) {
  await act(async () => {
    socket()?.emit({ type: "event", event, payload });
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function sendPrompt(): Promise<{ runId: string; sessionKey: string }> {
  const before = lastSend().runId;
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: PROMPT } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(lastSend().runId).not.toBe(before));
  await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));
  return lastSend();
}

/** The core's failed-attempt frame, sent before it waits to retry. */
const attemptFailed = (runId: string, sessionKey: string, provider = "xai", model = "grok-4.6") => push("agent", {
  runId,
  sessionKey,
  agentId: "main",
  stream: "lifecycle",
  data: { phase: "finishing", error: CORE_COPY, errorObservation: { provider, model, failoverReason: "rate_limit" } },
});

const retrying = (runId: string, sessionKey: string) => push("agent", {
  runId,
  sessionKey,
  stream: "run_status",
  data: { phase: "retrying", reason: "rate_limit", attempt: 2, maxAttempts: 10, delayMs: 8000, message: "Retrying… 2/10" },
});

const aborted = (runId: string, sessionKey: string) => push("chat", { runId, sessionKey, state: "aborted" });

async function mount(surface: "popup" | "page") {
  if (surface === "popup") render(<ChatPopup isOpen onClose={() => {}} />);
  else render(<ChatApp />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

describe.each([
  ["the mascot chat", "popup"],
  ["the full-page chat", "page"],
] as const)("a turn on a model the account cannot run — %s", (_name, surface) => {
  beforeEach(() => {
    histories = { [MAIN]: [{ role: "assistant", content: [{ type: "text", text: SEED_TEXT }], timestamp: 500 }] };
    sent.length = 0;
    sockets.length = 0;
    fallbackAnswer = { body: { handled: false }, release: Promise.resolve() };
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

  it("hands the run to the box at the first failed attempt, once, and says where the chat went — not \"Stopped.\"", async () => {
    let release!: () => void;
    fallbackAnswer = {
      body: {
        handled: true, kind: "zero_quota", provider: "xai", model: "grok-4.6", modelLabel: "Grok 4.6",
        fallbackModel: "grok-4.7", fallbackLabel: "Grok 4.7", switched: true, resent: true, news: true,
      },
      release: new Promise<void>((resolve) => { release = resolve; }),
    };
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();

    await attemptFailed(runId, sessionKey);
    await retrying(runId, sessionKey);

    await waitFor(() => expect(fallbackReports()).toHaveLength(1));
    expect(fallbackReports()[0]).toMatchObject({
      provider: "xai",
      model: "grok-4.6",
      reason: "rate_limit",
      runId,
      sessionKey,
      message: PROMPT,
    });

    // The box stops the run while the chat is still waiting for its answer.
    await aborted(runId, sessionKey);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });

    await screen.findByText(FALLBACK_LINE);
    expect(bubbles(STOPPED)).toHaveLength(0);
    expect(document.body.textContent ?? "").not.toMatch(/short break/);
  });

  it("gives the owner's Stop its line back when the box did not act (an ordinary throttle)", async () => {
    let release!: () => void;
    fallbackAnswer = { body: { handled: false }, release: new Promise<void>((resolve) => { release = resolve; }) };
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();

    await attemptFailed(runId, sessionKey);
    await waitFor(() => expect(fallbackReports()).toHaveLength(1));
    await aborted(runId, sessionKey);
    expect(bubbles(STOPPED)).toHaveLength(0);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });

    await waitFor(() => expect(bubbles(STOPPED)).toHaveLength(1));
  });

  it("says ONCE, calmly, that the account has no API quota when no model of the provider is left — with Settings → Providers and a one-click switch", async () => {
    fallbackAnswer = { body: EXHAUSTED, release: Promise.resolve() };
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();

    await attemptFailed(runId, sessionKey, "xai", "grok-4.7");
    await retrying(runId, sessionKey);
    await waitFor(() => expect(fallbackReports()).toHaveLength(1));
    await aborted(runId, sessionKey);

    const line = await screen.findByText(NO_QUOTA_LINE);
    expect(bubbles(NO_QUOTA_LINE)).toHaveLength(1);
    // Calm blue, never the red of an error.
    const colours = coloursAround(line);
    expect(colours[0]).toBe("rgb(191, 219, 254)");
    expect(colours).not.toContain("rgb(239, 68, 68)");
    expect(colours).not.toContain("rgb(252, 165, 165)");
    expect(bubbles(STOPPED)).toHaveLength(0);
    expect(document.body.textContent ?? "").not.toMatch(/is not available on this xAI account|Switched the chat to Grok/);

    // Settings → Providers opens the Settings window on its Providers section.
    const opened: string[] = [];
    const onOpen = (event: Event) => opened.push(String((event as CustomEvent<{ section?: string }>).detail?.section));
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpen);
    fireEvent.click(screen.getByTestId("chat-notice-providers"));
    window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpen);
    expect(screen.getByTestId("chat-notice-providers").textContent).toBe("Settings → Providers");
    expect(opened).toEqual(["ai"]);

    // The one-click switch sends the picker's own request for the other provider.
    const switchButton = screen.getByTestId("chat-notice-switch");
    expect(switchButton.textContent).toBe("Switch to ChatGPT");
    await act(async () => { fireEvent.click(switchButton); await new Promise((r) => setTimeout(r, 20)); });
    const switches = vi.mocked(fetch).mock.calls
      .filter(([input, init]) => String(input).includes("/setup-api/chat/model") && (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(switches).toEqual([{ model: "openai/gpt-5.5", provider: "openai-codex" }]);
  });

  it("draws the failed turn's zero-quota sentence calm too, when the provider's words reach the chat", async () => {
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();
    await push("chat", {
      runId,
      sessionKey,
      state: "error",
      errorMessage: "429 Too many requests for team T and model grok-4.7. Your team's rate limit is — Requests per Minute (actual/limit): 0/0.",
    });
    const line = await screen.findByText(/That message did not go through — .* its rate limit is 0/);
    expect(coloursAround(line)[0]).toBe("rgb(191, 219, 254)");
  });

  it("costs nothing for a provider whose models do not fall back", async () => {
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();
    await attemptFailed(runId, sessionKey, "anthropic", "claude-opus-5-5");
    await retrying(runId, sessionKey);
    await aborted(runId, sessionKey);
    expect(fallbackReports()).toHaveLength(0);
    await waitFor(() => expect(bubbles(STOPPED)).toHaveLength(1));
  });
});
