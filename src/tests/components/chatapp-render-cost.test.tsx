// What a render of the full-page chat (`/app/clawbox`, ChatApp) costs.
//
// The page renders on every keystroke in its composer and every streamed
// chunk, and it used to build every bubble inline: each of those renders
// parsed the Markdown of every reply in the conversation again. The bubbles
// are memoised rows now (ChatAppMessageRow), as the mascot chat's are. These
// pin, on the real page against a scripted gateway:
//
//   - typing parses nothing;
//   - a streamed reply still updates live, chunk by chunk, parses only itself,
//     and the transcript still follows its newest line;
//   - a history re-read that answers the same conversation parses nothing;
//   - the bubbles draw what they drew inline.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";

// See test-timeout-hygiene.test.ts: a jsdom mount of a chat costs seconds
// under a full parallel run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/chat-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-markdown")>();
  return { ...actual, renderText: vi.fn(actual.renderText) };
});

import { renderText } from "@/lib/chat-markdown";
import ChatApp from "@/components/ChatApp";

const parses = () => vi.mocked(renderText).mock.calls.length;
const parsesOf = (text: string) => vi.mocked(renderText).mock.calls.filter(([t]) => t === text).length;

const DISK = "## Disk\n\n- **root**: 40 GB free\n- data: 12 GB";
const MEMORY = "| kind | free |\n|---|---|\n| RAM | 3.1 GB |\n| swap | 8 GB |";
const SESSION = "agent:main:main";

/** The stored conversation, as `chat.history` answers it — fresh objects on every read. */
function storedHistory() {
  return [
    { role: "user", content: "What is on the box?", timestamp: 1787236200000 },
    { role: "assistant", content: [{ type: "text", text: DISK }], timestamp: 1787236201000 },
    { role: "user", content: "And memory?", timestamp: 1787236202000 },
    { role: "assistant", content: [{ type: "text", text: MEMORY }], timestamp: 1787236203000 },
  ];
}

let historyReads = 0;

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
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } });
      return;
    }
    if (frame.method === "chat.history") {
      historyReads += 1;
      this.respond(id, { messages: storedHistory() });
      return;
    }
    this.respond(id, {});
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

  pushChat(state: string, message: unknown) {
    this.emit({ type: "event", event: "chat", payload: { sessionKey: SESSION, state, message } });
  }
}

const instances: FakeGatewayWs[] = [];

async function mountChat() {
  render(<ChatApp />);
  await screen.findByRole("heading", { name: "Disk" });
  await screen.findByText("RAM");
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(composer).not.toBeDisabled());
  return { ws: instances[instances.length - 1], composer };
}

beforeEach(() => {
  instances.length = 0;
  historyReads = 0;
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(renderText).mockClear();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the full-page chat's transcript", () => {
  it("is drawn as it was inline: the owner's pill, the parsed answer, the bubble shapes", async () => {
    await mountChat();
    const question = screen.getByText("What is on the box?");
    // The owner's words are the bubble's own text, never parsed as Markdown.
    expect(question.style.background).toContain("linear-gradient");
    expect(question.style.borderRadius).toBe("14px 14px 4px 14px");
    expect(question.parentElement?.style.justifyContent).toBe("flex-end");
    // The answer is parsed: a heading and a table, in the grey bubble.
    const heading = screen.getByRole("heading", { name: "Disk" });
    const bubble = heading.closest("div[style*='border-radius: 14px 14px 14px 4px']") as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble?.style.background).toBe("rgba(255, 255, 255, 0.06)");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("parses nothing while the owner types", async () => {
    const { composer } = await mountChat();
    const parsed = parses();

    for (const value of ["H", "He", "Hel", "Hell", "Hello"]) {
      fireEvent.change(composer, { target: { value } });
    }

    expect(composer.value).toBe("Hello");
    expect(parses()).toBe(parsed);
  });

  it("updates a streaming reply live, parses only the reply, and follows its newest line", async () => {
    const { ws, composer } = await mountChat();
    const rowParses = parsesOf(DISK) + parsesOf(MEMORY);
    const scrolls = () => vi.mocked(Element.prototype.scrollIntoView).mock.calls.length;

    for (const chunk of ["Checking", "Checking the disk", "Checking the disk now"]) {
      const before = scrolls();
      await act(async () => {
        ws.pushChat("delta", { role: "assistant", content: chunk });
        await Promise.resolve();
      });
      // Live: the bubble shows each chunk as it lands…
      await waitFor(() => expect(document.body.textContent).toContain(chunk));
      // …and the transcript scrolls to it.
      await waitFor(() => expect(scrolls()).toBeGreaterThan(before));
    }
    // Typing while it streams parses neither the reply nor the conversation.
    const parsedWhileStreaming = parses();
    fireEvent.change(composer, { target: { value: "x" } });
    expect(parses()).toBe(parsedWhileStreaming);

    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: [{ type: "text", text: "**All** fine." }] });
      await Promise.resolve();
    });
    // The finished answer is a row of its own, parsed: the bold is bold.
    await waitFor(() => expect(screen.getByText("All").closest("strong")).not.toBeNull());
    expect(document.body.textContent).not.toContain("Checking the disk now");
    // Not one of the stored replies was parsed again for any of it.
    expect(parsesOf(DISK) + parsesOf(MEMORY)).toBe(rowParses);
  });

  it("parses nothing when a history re-read answers the same conversation", async () => {
    const { ws } = await mountChat();
    expect(historyReads).toBe(1);
    const parsed = parses();

    // An ack-only final ("Sent.") re-reads the history three seconds later —
    // every message a fresh object, none of them changed.
    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: "Sent." });
      await Promise.resolve();
    });
    await waitFor(() => expect(historyReads).toBe(2), { timeout: 8_000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(screen.getByRole("heading", { name: "Disk" })).toBeInTheDocument();
    expect(parses()).toBe(parsed);
  });
});
