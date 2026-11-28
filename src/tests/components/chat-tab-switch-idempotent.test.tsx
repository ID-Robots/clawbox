import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import {
  HERMES_SESSION,
  installHermesBox,
  mountHermesChat,
  type HermesBox,
} from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";
import type { ReactNode } from "react";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; see
// `test-timeout-hygiene.test.ts` for why every suite that mounts it says so.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let str = translations.en[key] ?? key;
        for (const [k, v] of Object.entries(params ?? {})) str = str.replaceAll(`{${k}}`, String(v));
        return str;
      },
    }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * Leaving a chat tab and coming back is idempotent (TASK-2494).
 *
 * Seen on a box with two conversations open: every A -> B -> A painted the last
 * answer a second time (a refresh showed it once, so only the screen was
 * wrong), and the status line under a turn still running restarted its clock at
 * 0-1 s and lost what the harness had said it was doing. The popup has ONE set
 * of conversation state, so a switch puts down what belongs to the tab left and
 * picks it up again on return; these pin that nothing is counted twice and
 * nothing is started again.
 */

const tabs = () => screen.getAllByTestId("chat-tab");
const activeTabKey = () =>
  tabs().find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key");
const turnStatus = () => screen.queryByTestId("chat-turn-status")?.textContent ?? null;

/** The newest bubble's words, as many times as they are on screen. */
const shown = (text: string) => screen.queryAllByText(text).length;

/** The epoch the faked wall clock starts at; only `Date` is faked. */
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

// ── Hermes ────────────────────────────────────────────────────────────────────

describe("A -> B -> A on the Hermes edition", () => {
  const DESKTOP = "desktop";
  let box: HermesBox;

  beforeEach(() => {
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    box = installHermesBox();
  });

  async function send(text: string) {
    const textarea = screen.getByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(box.chatPosts.length).toBeGreaterThan(0));
  }

  async function openNewTab(): Promise<string> {
    const plus = screen.getByTestId("chat-new-tab");
    await waitFor(() => expect(plus).not.toBeDisabled());
    fireEvent.click(plus);
    await waitFor(() => expect(tabs()).toHaveLength(2));
    return activeTabKey() as string;
  }

  async function backToMain() {
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
  }

  /** A turn answered on an event stream the test paces frame by frame. */
  function pacedTurn() {
    const encoder = new TextEncoder();
    let releaseChunk: ((chunk: string | null) => void) | null = null;
    box.facts.hermesStreamsTurns = true;
    box.chatResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body: {
        getReader: () => ({
          read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
            releaseChunk = (chunk) => (chunk === null
              ? resolve({ done: true })
              : resolve({ done: false, value: encoder.encode(chunk) }));
          }),
        }),
      },
    });
    return async (event: string | null, data?: unknown) => {
      await waitFor(() => expect(releaseChunk).not.toBeNull());
      const release = releaseChunk!;
      releaseChunk = null;
      release(event === null ? null : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
  }

  it("keeps a running turn's clock and the harness's words when the owner comes back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const push = pacedTurn();
    await mountHermesChat(box);
    await send("think it over");
    await push("status", { text: "Thinking…" });
    await waitFor(() => expect(turnStatus()).toContain("Thinking…"));

    // Seven seconds into the turn, the clock says so.
    vi.setSystemTime(T0 + 7_000);
    await waitFor(() => expect(turnStatus()).toMatch(/·\s*7s/), { timeout: 3_000 });

    // Over to another conversation for five seconds: nothing is running there.
    await openNewTab();
    expect(turnStatus()).toBeNull();
    vi.setSystemTime(T0 + 12_000);

    // Back: the same turn, twelve seconds old, still thinking — not a new
    // count from 0 under a freshly picked verb.
    await backToMain();
    const line = turnStatus();
    expect(line).toContain("Thinking…");
    expect(line).toMatch(/·\s*12s/);

    await push("done", { text: "Thought it over.", harness: "hermes", sessionId: HERMES_SESSION });
    await push(null);
    await waitFor(() => expect(shown("Thought it over.")).toBe(1));
    await waitFor(() => expect(turnStatus()).toBeNull());
  });

  it("a new turn after the round trip starts its own clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const push = pacedTurn();
    await mountHermesChat(box);
    await send("first");
    await push("status", { text: "Thinking…" });
    await openNewTab();
    vi.setSystemTime(T0 + 9_000);
    await backToMain();
    await waitFor(() => expect(turnStatus()).toMatch(/·\s*9s/));
    await push("done", { text: "First answer.", harness: "hermes", sessionId: HERMES_SESSION });
    await push(null);
    await waitFor(() => expect(turnStatus()).toBeNull());

    // The kept line belonged to that turn alone.
    const pushNext = pacedTurn();
    vi.setSystemTime(T0 + 20_000);
    await send("second");
    await waitFor(() => expect(turnStatus()).toMatch(/·\s*0s/));
    expect(turnStatus()).not.toContain("Thinking…");
    await pushNext("done", { text: "Second answer.", harness: "hermes", sessionId: HERMES_SESSION });
    await pushNext(null);
    await waitFor(() => expect(shown("Second answer.")).toBe(1));
  });

  it("shows the answer once when the read on return already holds it", async () => {
    // The route writes the answer into the transcript and only then answers
    // the request. A return inside that window reads the answer from the
    // transcript, and the request then lands it again.
    let release!: (answer: unknown) => void;
    box.chatResponse = () => new Promise((resolve) => { release = resolve; });
    await mountHermesChat(box);
    await send("what is 37 times 199?");

    await openNewTab();
    box.storedTranscript = [
      ...box.storedTranscript,
      { role: "user", text: "what is 37 times 199?", timestamp: 30 },
      { role: "assistant", text: "7363.", timestamp: 31 },
    ];
    await backToMain();
    await screen.findByText("7363.");

    release({ ok: true, json: async () => ({ text: "7363.", sessionId: HERMES_SESSION }) });
    await waitFor(() => expect(turnStatus()).toBeNull());
    expect(shown("7363.")).toBe(1);

    // And it stays once over more round trips.
    for (let i = 0; i < 2; i++) {
      fireEvent.click(tabs()[1]);
      await waitFor(() => expect(activeTabKey()).not.toBe(DESKTOP));
      await backToMain();
      await screen.findByText("7363.");
      expect(shown("7363.")).toBe(1);
    }
  });
});

// ── OpenClaw ──────────────────────────────────────────────────────────────────

describe("A -> B -> A on the OpenClaw edition", () => {
  const MAIN = "agent:main:main";
  const SEED = "Earlier in this chat.";
  /** Transcript per session key, as the gateway holds it. */
  let histories: Record<string, unknown[]> = {};
  const sent: Array<Record<string, unknown>> = [];
  const sockets: FakeGatewayWs[] = [];

  class FakeGatewayWs {
    static readonly OPEN = 1;
    readyState = FakeGatewayWs.OPEN;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
      setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
    }
    send(raw: string) {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame.type !== "req") return;
      sent.push(frame);
      const id = frame.id as string;
      const params = (frame.params ?? {}) as Record<string, unknown>;
      switch (frame.method) {
        case "connect":
          return this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
        case "chat.history":
          return this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
        case "chat.send":
          return this.respond(id, { runId: params.idempotencyKey, status: "started" });
        default:
          return this.respond(id, {});
      }
    }
    close() {}
    private respond(id: string, payload: unknown) {
      setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
    }
    emit(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  const socket = () => sockets[sockets.length - 1];
  const chatFrame = (payload: Record<string, unknown>) =>
    act(async () => { socket().emit({ type: "event", event: "chat", payload }); });
  const text = (value: string) => ({ role: "assistant", content: [{ type: "text", text: value }] });

  beforeEach(() => {
    histories = { [MAIN]: [{ ...text(SEED), timestamp: 500 }] };
    sent.length = 0;
    sockets.length = 0;
    window.localStorage.clear();
    resetHarnessCache();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs);
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/gateway/ws-config")) return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      if (url.includes("/setup-api/harness/active")) return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      if (url.includes("/setup-api/chat/model")) return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      if (url.includes("/setup-api/chat/spoken-history")) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: true, json: async () => ({}) };
    }));
  });

  async function openNewTab(): Promise<string> {
    const plus = await screen.findByRole("button", { name: "New chat" });
    await waitFor(() => expect(plus).not.toBeDisabled());
    fireEvent.click(plus);
    await waitFor(() => expect(activeTabKey()).not.toBe(MAIN));
    return activeTabKey() as string;
  }

  /** Send a turn from main, see it start, leave for a new tab; hands back its run. */
  async function sendThenLeave(question: string, beforeLeaving: () => Promise<void> = async () => {}): Promise<string> {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByText(SEED);
    const input = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(input, { target: { value: question } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sent.some((f) => f.method === "chat.send")).toBe(true));
    const runId = String((sent.find((f) => f.method === "chat.send")!.params as Record<string, unknown>).idempotencyKey);
    await chatFrame({ sessionKey: MAIN, runId, state: "delta", message: text("Multiplying") });
    await beforeLeaving();
    await openNewTab();
    expect(turnStatus()).toBeNull();
    return runId;
  }

  async function backToMain() {
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(MAIN));
  }

  it("keeps a running turn's clock when the owner comes back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const runId = await sendThenLeave("what is 37 times 199?", async () => {
      vi.setSystemTime(T0 + 7_000);
      await waitFor(() => expect(turnStatus()).toMatch(/·\s*7s/), { timeout: 3_000 });
    });
    vi.setSystemTime(T0 + 12_000);
    await backToMain();
    // The same turn, twelve seconds in — not a new count from 0.
    expect(turnStatus()).toMatch(/·\s*12s/);
    await chatFrame({ sessionKey: MAIN, runId, state: "final", message: text("7363.") });
    await waitFor(() => expect(turnStatus()).toBeNull());
  });

  it("paints an answer the read on return already holds once, and keeps it once", async () => {
    const runId = await sendThenLeave("what is 37 times 199?");
    // While the owner is away the run stores its answer; the live final for it
    // is still on its way when they come back.
    histories[MAIN] = [
      ...histories[MAIN],
      { role: "user", content: "what is 37 times 199?", idempotencyKey: `${runId}:user`, timestamp: 600 },
      { ...text("7363."), timestamp: 601, __openclaw: { runId } },
    ];
    await backToMain();
    await screen.findByText("7363.");
    await chatFrame({ sessionKey: MAIN, runId, state: "final", message: text("7363.") });
    await waitFor(() => expect(turnStatus()).toBeNull());
    expect(shown("7363.")).toBe(1);

    // Round trips after the answer change nothing either.
    for (let i = 0; i < 2; i++) {
      fireEvent.click(tabs()[1]);
      await waitFor(() => expect(activeTabKey()).not.toBe(MAIN));
      await backToMain();
      await screen.findByText("7363.");
      expect(shown("7363.")).toBe(1);
    }
  });

  it("still shows the same words from a different run as a reply of its own", async () => {
    // A reminder the box delivers twice, with no question between: two runs,
    // two bubbles, even though they say the same thing.
    histories[MAIN] = [
      { role: "user", content: "remind me to stretch", timestamp: 400 },
      { ...text("Time to stretch."), timestamp: 500, __openclaw: { runId: "cron-1" } },
    ];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByText("Time to stretch.");
    await chatFrame({ sessionKey: MAIN, runId: "cron-2", state: "final", message: text("Time to stretch.") });
    await waitFor(() => expect(shown("Time to stretch.")).toBe(2));
  });
});
