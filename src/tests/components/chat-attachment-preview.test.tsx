import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { I18nProvider } from "@/lib/i18n";
import { translations } from "@/lib/translations";

/**
 * TASK-380 acceptance 2 and 5, on the surface a customer actually uses.
 *
 * Two shipped behaviours are wrong and neither is visible from the unit level:
 *
 * 1. A pasted image rendered as a material icon plus a file name the composer
 *    had just invented (`paste-<ts>-<idx>.png`), so the only question that
 *    matters — "is that the picture I meant to send" — was unanswerable. With
 *    the transcript not echoing the image either (TASK-436), a pasted image was
 *    invisible everywhere in the product.
 *
 * 2. `uploadFiles` returned early on a non-OK response and swallowed throws
 *    into console.error. A rejected file, a full disk and an expired session
 *    all looked exactly like a paste that had not fired.
 *
 * Asserted through the component rather than the helper because the leak that
 * matters is a lifecycle one: the object URL has to be revoked by whichever
 * of remove / send / unmount happens, and only the component knows that.
 */

const STAGED_PATH = "/home/clawbox/.openclaw/media/chat-attachments/paste-1.png";

type Frame = Record<string, unknown>;

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

/** What the staging route answers next. */
let stagingResponse: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { ok: true, name: "paste-1.png", path: STAGED_PATH },
};
/** Set to make fetch reject outright, the way a dropped connection does. */
let stagingThrows = false;

const revoked: string[] = [];
let nextBlobId = 0;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
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
        if (stagingThrows) throw new TypeError("Failed to fetch");
        return {
          ok: stagingResponse.ok,
          status: stagingResponse.status,
          json: async () => stagingResponse.body,
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

async function connected() {
  await waitFor(() => {
    expect(sentFrames.some((f) => f.method === "chat.history")).toBe(true);
  });
}

function pasteImage(textarea: HTMLElement, type = "image/png") {
  const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type });
  fireEvent.paste(textarea, {
    clipboardData: { items: [{ kind: "file", type, getAsFile: () => file }] },
  });
}

/** The staged thumbnail, or undefined while none is rendered. */
function thumbnail(): HTMLImageElement | undefined {
  const strip = screen.queryByTestId("chat-attachments");
  return strip?.querySelector("img") as HTMLImageElement | undefined;
}

/**
 * Assert that `text` renders the `key` template.
 *
 * Split on the placeholder rather than substituting a name: a paste that FAILS
 * never gets a name back from the box, so the composer falls back to the name
 * it stamped itself (`paste-<Date.now()>-<idx>.png`), which the test cannot
 * know. Both halves present also proves the key resolved — an unresolved key
 * would put `chat.attachment.error.box` in front of the customer.
 */
function expectCopy(text: string | null, key: keyof typeof translations.en) {
  const [before, after] = translations.en[key].split("{name}");
  expect(text ?? "").toContain(before.trim());
  if (after.trim()) expect(text ?? "").toContain(after.trim());
}

describe("device chat attachment preview", () => {
  beforeEach(() => {
    sentFrames.length = 0;
    revoked.length = 0;
    nextBlobId = 0;
    stagingThrows = false;
    stagingResponse = { ok: true, status: 200, body: { ok: true, name: "paste-1.png", path: STAGED_PATH } };
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    installFetch();
    // jsdom ships no object-URL implementation, so it is stubbed rather than
    // spied on. Recording the revokes is the point: a preview that is never
    // released pins the whole Blob for the life of the document.
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => `blob:preview-${++nextBlobId}`),
      revokeObjectURL: vi.fn((u: string) => { revoked.push(u); }),
    });
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("shows the pasted image itself, not just its invented file name", async () => {
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);

    const img = await waitFor(() => {
      const el = thumbnail();
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    });
    expect(img.getAttribute("src")).toBe("blob:preview-1");
    // The name is still there for the file-picker case; the thumbnail is the
    // addition, not a replacement.
    expect(screen.getByTestId("chat-attachments").textContent).toContain("paste-1.png");
  });

  it("releases the thumbnail when the attachment is removed", async () => {
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);
    await waitFor(() => expect(thumbnail()).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /paste-1\.png/i }));

    await waitFor(() => expect(revoked).toContain("blob:preview-1"));
    expect(thumbnail()).toBeFalsy();
  });

  it("releases the thumbnail once the turn is sent", async () => {
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);
    await waitFor(() => expect(thumbnail()).toBeTruthy());

    fireEvent.change(textarea, { target: { value: "what is this?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(revoked).toContain("blob:preview-1"));
  });

  it("releases the thumbnail when the chat surface unmounts", async () => {
    const view = render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);
    await waitFor(() => expect(thumbnail()).toBeTruthy());

    view.unmount();
    await waitFor(() => expect(revoked).toContain("blob:preview-1"));
  });

  it("tells the user when the box rejected the file, instead of nothing", async () => {
    stagingResponse = { ok: false, status: 413, body: { error: "Request exceeds the size limit" } };

    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);

    const err = await screen.findByTestId("chat-attachment-error");
    // Asserting on the resolved copy: this fails both when the wrong reason is
    // chosen and when the key has no entry, which would put the raw key on the
    // customer's screen.
    await waitFor(() => expectCopy(err.textContent, "chat.attachment.error.tooLarge"));
    // Nothing was staged, so nothing may claim to be attached.
    expect(screen.queryByTestId("chat-attachments")).toBeFalsy();
  });

  it("never renders an error message that carries an absolute path", async () => {
    stagingResponse = {
      ok: false,
      status: 500,
      body: { error: "Upload failed: ENOSPC /home/clawbox/.openclaw/media/chat-attachments/paste-1.png" },
    };

    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);

    const err = await screen.findByTestId("chat-attachment-error");
    await waitFor(() => expectCopy(err.textContent, "chat.attachment.error.box"));
    expect(err.textContent).not.toContain("/home/clawbox");
    expect(err.textContent).not.toContain("ENOSPC");
  });

  it("reports a request that never completed as the box's problem", async () => {
    stagingThrows = true;

    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);

    const err = await screen.findByTestId("chat-attachment-error");
    await waitFor(() => expectCopy(err.textContent, "chat.attachment.error.box"));
  });

  it("does not leave the thumbnail pinned when staging fails", async () => {
    stagingResponse = { ok: false, status: 500, body: { error: "nope" } };

    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);
    await screen.findByTestId("chat-attachment-error");

    // The URL was minted before the request, so the failure path owns it.
    await waitFor(() => expect(revoked).toContain("blob:preview-1"));
  });

  it("treats a 200 with no path as a failure rather than a silent no-op", async () => {
    stagingResponse = { ok: true, status: 200, body: { ok: true, name: "paste-1.png" } };

    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);

    await screen.findByTestId("chat-attachment-error");
    expect(screen.queryByTestId("chat-attachments")).toBeFalsy();
  });

  it("clears a previous error when a later paste succeeds", async () => {
    stagingResponse = { ok: false, status: 500, body: { error: "nope" } };

    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const textarea = await screen.findByRole("textbox");
    await connected();

    pasteImage(textarea);
    await screen.findByTestId("chat-attachment-error");

    stagingResponse = { ok: true, status: 200, body: { ok: true, name: "paste-1.png", path: STAGED_PATH } };
    pasteImage(textarea);

    await waitFor(() => expect(thumbnail()).toBeTruthy());
    // A stale complaint above a strip that now holds a good attachment reads
    // as "this one failed too".
    expect(screen.queryByTestId("chat-attachment-error")).toBeFalsy();
  });
});
