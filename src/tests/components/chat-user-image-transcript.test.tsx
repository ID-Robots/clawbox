import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { I18nProvider } from "@/lib/i18n";

/**
 * TASK-436, on the surface the customer uses.
 *
 * Reported with a screenshot: vision answers correctly about a photo that
 * appears NOWHERE in the conversation. The user turn shows only "What is this ?"
 * and scrolling back gives no way to tell which picture any answer was about.
 *
 * The renderer was never the problem — ChatPopup already draws `msg.images` for
 * a user turn. The image was discarded twice: the live bubble was built without
 * one, and the history projection reduced the stored turn to its caption.
 *
 * Driven through the component because the two halves have to agree: the bubble
 * drawn at send time and the bubble rebuilt from history after a refresh must be
 * the same bubble, and only the component can show that.
 */

const PNG = "/home/clawbox/.openclaw/media/chat-attachments/paste-1.png";
const SECOND = "/home/clawbox/.openclaw/media/chat-attachments/paste-2.png";
const PDF = "/home/clawbox/.openclaw/media/chat-attachments/report.pdf";

type Frame = Record<string, unknown>;
const sentFrames: Frame[] = [];
/** What `chat.history` replays — i.e. what a refresh or a reboot would show. */
let history: unknown[] = [];

function storedUserTurn(text: string, timestamp: number) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

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
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
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
    if (frame.method === "chat.history") {
      this.respond(id, { messages: history });
      return;
    }
    const runId = `run-${sentFrames.length}`;
    this.respond(id, { runId, status: "started" });
    // Answer the turn the way the gateway does, so `sending` clears and the
    // transcript settles instead of staying mid-run for the whole assertion.
    setTimeout(() => this.emit({
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey: "agent:main:main",
        state: "final",
        stopReason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 1787260000000 },
      },
    }), 1);
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }
  addEventListener() {}
  removeEventListener() {}
  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, status: 200, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, status: 200, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, status: 200, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    if (url.includes("/setup-api/chat/attachments")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, name: "paste-1.png", path: PNG }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));
}

async function connected() {
  await waitFor(() => expect(sentFrames.some(f => f.method === "chat.history")).toBe(true));
}

function pasteImage(textarea: HTMLElement) {
  const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  fireEvent.paste(textarea, {
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
  });
}

/** Every image inside the transcript, ignoring the composer's own strip. */
function transcriptImages(): HTMLImageElement[] {
  const strip = screen.queryByTestId("chat-attachments");
  return [...document.querySelectorAll("img")].filter(img => !strip?.contains(img)) as HTMLImageElement[];
}

const mediaRoute = (p: string) => `/setup-api/chat/media?path=${encodeURIComponent(p)}`;

describe("the image a customer sent, in the transcript", () => {
  beforeEach(() => {
    sentFrames.length = 0;
    history = [];
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    installFetch();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview-1"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("renders the picture in the user's own turn as soon as it is sent", async () => {
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);
    // Wait for the STAGED path, not merely for the strip: the thumbnail is
    // minted from the local Blob immediately, while `path` only exists once the
    // box has answered, and it is the path the bubble renders.
    await waitFor(() => {
      const strip = screen.getByTestId("chat-attachments");
      expect(strip.querySelector("img")).toBeTruthy();
    });
    await waitFor(() => expect(
      (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .some(c => String(c[0]).includes("/setup-api/chat/attachments")),
    ).toBe(true));
    fireEvent.change(textarea, { target: { value: "What is this ?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    const images = await waitFor(() => {
      const found = transcriptImages();
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // The box's own session-gated route, so the very same URL still resolves
    // after a refresh and after a reboot. An object URL would not survive
    // either, and a raw path is a broken image.
    expect(images[0].getAttribute("src")).toBe(mediaRoute(PNG));
    expect(screen.getByText("What is this ?")).toBeTruthy();
    // The 📎 line was a stand-in for a picture nobody could see. With the
    // picture there it is noise.
    expect(document.body.textContent).not.toContain("📎 paste-1.png");
  });

  it("still shows it after a refresh, rebuilt from what the gateway stored", async () => {
    history = [storedUserTurn(`[Attached file: ${PNG}]\nWhat is this ?`, 1787260000000)];
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    await screen.findByRole("textbox");
    await connected();

    const images = await waitFor(() => {
      const found = transcriptImages();
      expect(found.length).toBe(1);
      return found;
    });
    expect(images[0].getAttribute("src")).toBe(mediaRoute(PNG));
    expect(screen.getByText("What is this ?")).toBeTruthy();
  });

  it("keeps a turn that was nothing but a picture", async () => {
    // Sent with no caption, the whole user turn used to disappear on reload,
    // leaving the assistant answering a question that was not on screen.
    history = [storedUserTurn(`[Attached file: ${PNG}]`, 1787260000000)];
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    await screen.findByRole("textbox");
    await connected();

    await waitFor(() => expect(transcriptImages().length).toBe(1));
  });

  it("never prints an absolute path, however many files the turn carried", async () => {
    // The strip this replaced was anchored and non-global, so with two
    // attachments the SECOND path was rendered verbatim to the customer.
    history = [storedUserTurn(
      `[Attached file: ${PNG}]\n[Attached file: ${SECOND}]\n[Attached file: ${PDF}]\ncompare these`,
      1787260000000,
    )];
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    await screen.findByRole("textbox");
    await connected();

    await waitFor(() => expect(transcriptImages().length).toBe(2));
    const shown = document.body.textContent ?? "";
    expect(shown).not.toContain("/home/clawbox");
    expect(shown).not.toContain("[Attached file:");
    expect(screen.getByText(/compare these/)).toBeTruthy();
    // A document cannot be drawn, so it keeps the label the composer gives it —
    // its name, not the path it happens to sit at.
    expect(shown).toContain("report.pdf");
  });

  it("leaves an ordinary turn exactly as it was", async () => {
    history = [storedUserTurn("just a question", 1787260000000)];
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    await screen.findByRole("textbox");
    await connected();

    await waitFor(() => expect(screen.getByText("just a question")).toBeTruthy());
    expect(transcriptImages().length).toBe(0);
  });
});
