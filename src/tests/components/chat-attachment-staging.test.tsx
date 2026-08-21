import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * TASK-417: the device accepted an attached image and then answered that it
 * could not see it.
 *
 * Half of that was a missing vision model (covered by the configure-route and
 * gateway-pre-start tests). The other half is here: the composer uploaded to
 * the Files API, which writes to `$HOME/uploads`, and then named that absolute
 * path in the message. OpenClaw reads media only from a fixed root allowlist
 * (`buildMediaLocalRoots`), and `$HOME/uploads` is not on it, so the `image`
 * tool answered "Local media path is not under an allowed directory" — proven
 * on box 192.168.50.65 on 2026-08-21 with the exact path the composer produces.
 *
 * Asserting on the component rather than on source text: the upload URL and the
 * `[Attached file: …]` line are two different callbacks that have to agree, and
 * what matters to a customer is that the path the agent is handed is one it can
 * open.
 */

const STAGED_PATH = "/home/clawbox/.openclaw/media/chat-attachments/paste-1.png";

type Frame = Record<string, unknown>;

const instances: FakeGatewayWs[] = [];
const sentFrames: Frame[] = [];

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
      this.respond(id, { messages: [] });
      return;
    }
    // Any other request is a turn. Ack it and then close it out: the surface
    // opens with an automatic greeting, and a run that never finishes leaves
    // `sending` true, which queues the turn under test instead of sending it.
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

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

/** Every URL the component fetched, in order. */
const fetchedUrls: string[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("/setup-api/gateway/ws-config")) {
        return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/chat/attachments")) {
        return { ok: true, json: async () => ({ ok: true, name: "paste-1.png", path: STAGED_PATH }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/**
 * Wait until the composer is live.
 *
 * The paste handler is a no-op until the socket says `connected` — pasting
 * before the handshake lands makes this test silently assert nothing.
 */
async function connected() {
  await waitFor(() => {
    expect(sentFrames.some((f) => f.method === "chat.history")).toBe(true);
  });
}

/** Paste one PNG into the composer, the way Ctrl+V on a screenshot does. */
function pasteImage(textarea: HTMLElement) {
  const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    },
  });
}

describe("device chat attachment staging", () => {
  beforeEach(() => {
    instances.length = 0;
    sentFrames.length = 0;
    fetchedUrls.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    // jsdom has no layout engine, so the transcript's auto-scroll has nothing
    // to call. Unrelated to what is under test.
    Element.prototype.scrollIntoView = vi.fn();
    installFetch();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("uploads a pasted image to the staging route, not the Files API", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);

    await waitFor(() => {
      expect(fetchedUrls.some((u) => u.includes("/setup-api/chat/attachments"))).toBe(true);
    });
    // $HOME/uploads is outside OpenClaw's media allowlist — going back to it
    // is the regression this test exists to catch.
    expect(fetchedUrls.some((u) => u.includes("/setup-api/files"))).toBe(false);
  });

  it("hands the agent the staged path, inside an allowed media root", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);
    await waitFor(() => expect(document.body.textContent).toContain("paste-1.png"));

    fireEvent.change(textarea, { target: { value: "what is in this picture?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // The turn we typed, not whatever else the surface sends on open.
    const message = await waitFor(() => {
      const text = sentFrames
        .filter((f) => f.method === "chat.send")
        .map((f) => String((f.params as { message?: unknown }).message ?? ""))
        .find((m) => m.includes("what is in this picture?"));
      expect(text).toBeDefined();
      return text as string;
    });

    expect(message).toContain(`[Attached file: ${STAGED_PATH}]`);
    expect(message).not.toContain("/uploads/");
  });
});
