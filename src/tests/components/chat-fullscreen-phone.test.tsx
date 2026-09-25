import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import {
  CHAT_FULLSCREEN_STORAGE_KEY,
  CHAT_TEXT_SCALE_STORAGE_KEY,
  resetChatPhoneLayoutMemory,
} from "@/lib/chat-phone-layout";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; every
// component suite that mounts it declares both ceilings (see
// `test-timeout-hygiene.test.ts`).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Fullscreen chat on a phone (TASK-1157).
 *
 * On a phone the bars around the conversation took close to half a landscape
 * screen: the tab header above it, and the composer's attachment, Create and
 * three pickers below it. A phone now opens with the header folded into a slim
 * strip and the composer down to the text box and its send action — every
 * folded control one tap away, and never removed from the keyboard or a
 * screen reader once shown. Leaving fullscreen is one control, and remembered.
 * The conversation's text size steps on its own, also remembered. None of it
 * exists on a big screen.
 */

const STAGED_PATH = "/home/clawbox/.openclaw/media/chat-attachments/photo-1.png";

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
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/chat/attachments")) {
        return { ok: true, json: async () => ({ ok: true, name: "photo-1.png", path: STAGED_PATH }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** The composer is live once the handshake and the history read landed. */
async function connected() {
  await waitFor(() => expect(sentFrames.some(f => f.method === "chat.history")).toBe(true));
  await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
}

function sentMessages(): string[] {
  return sentFrames
    .filter(f => f.method === "chat.send")
    .map(f => String((f.params as { message?: unknown }).message ?? ""));
}

function phone(props: Partial<React.ComponentProps<typeof ChatPopup>> = {}) {
  return render(<ChatPopup isOpen onClose={() => {}} mobile {...props} />);
}

beforeEach(() => {
  sentFrames.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
  Element.prototype.scrollIntoView = vi.fn();
  installFetch();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetHarnessCache();
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
});

describe("a phone in fullscreen chat", () => {
  it("opens with the header folded into the strip and the composer down to the text box and Send", async () => {
    phone();
    await connected();

    const strip = screen.getByTestId("chat-header-strip");
    const header = screen.getByTestId("chat-header");
    const toggle = screen.getByTestId("chat-header-toggle");
    // Out of the layout AND the accessibility tree, and the strip says so.
    expect(header).toHaveAttribute("hidden");
    expect(header.style.display).toBe("none");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", header.id);
    expect(toggle).toHaveAccessibleName("Show chat header");
    expect(within(strip).getByTestId("chat-fullscreen-toggle")).toHaveAttribute("aria-pressed", "true");

    // Folded: the input row is the whole composer.
    const primary = screen.getByTestId("chat-composer-primary");
    expect(Array.from(primary.children).map(el => el.getAttribute("data-testid") ?? el.tagName)).toEqual([
      "composer-options-toggle", "TEXTAREA", "chat-send",
    ]);
    expect(screen.queryByTestId("chat-composer-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-attach")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-new-app-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-options-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the header under the strip, with the way to the desktop in it, and folds it again", async () => {
    const onClose = vi.fn();
    phone({ onClose });
    await connected();

    const toggle = screen.getByTestId("chat-header-toggle");
    fireEvent.click(toggle);
    const header = screen.getByTestId("chat-header");
    expect(header).not.toHaveAttribute("hidden");
    expect(header.style.display).toBe("flex");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Hide chat header");
    // The strip stays where it was, above the header it opened.
    expect(screen.getByTestId("chat-header-strip").nextElementSibling).toBe(header);
    // The tabs, a new chat and the way out are all real, reachable controls.
    expect(within(header).getByRole("tablist")).toBeInTheDocument();
    expect(within(header).getByTestId("chat-new-tab")).toBeInTheDocument();
    const toDesktop = within(header).getByTestId("chat-popup-close");
    expect(toDesktop).toHaveAccessibleName("chat.showDesktop");
    fireEvent.click(toDesktop);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    expect(header).toHaveAttribute("hidden");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the header on a swipe down along the strip and folds it on a swipe up", async () => {
    phone();
    await connected();
    const strip = screen.getByTestId("chat-header-strip");
    const toggle = screen.getByTestId("chat-header-toggle");
    const header = screen.getByTestId("chat-header");

    fireEvent.pointerDown(toggle, { pointerType: "touch", clientY: 4 });
    fireEvent.pointerUp(toggle, { pointerType: "touch", clientY: 60 });
    expect(header).not.toHaveAttribute("hidden");
    // The tap the swipe ends in must not undo it.
    fireEvent.click(toggle);
    expect(header).not.toHaveAttribute("hidden");

    // A short wobble is a tap, not a swipe — the click decides.
    fireEvent.pointerDown(strip, { pointerType: "touch", clientY: 20 });
    fireEvent.pointerUp(strip, { pointerType: "touch", clientY: 26 });
    expect(header).not.toHaveAttribute("hidden");

    fireEvent.pointerDown(strip, { pointerType: "touch", clientY: 60 });
    fireEvent.pointerUp(strip, { pointerType: "touch", clientY: 4 });
    expect(header).toHaveAttribute("hidden");

    // That swipe ended on the strip, not the toggle, so no click trailed it:
    // the next real tap on the toggle must still count.
    fireEvent.pointerDown(toggle, { pointerType: "touch", clientY: 10 });
    fireEvent.pointerUp(toggle, { pointerType: "touch", clientY: 10 });
    fireEvent.click(toggle);
    expect(header).not.toHaveAttribute("hidden");

    // So must Enter on it, which arrives with no press at all.
    fireEvent.pointerDown(strip, { pointerType: "touch", clientY: 60 });
    fireEvent.pointerUp(strip, { pointerType: "touch", clientY: 4 });
    expect(header).toHaveAttribute("hidden");
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);
    expect(header).not.toHaveAttribute("hidden");
    fireEvent.click(toggle);
    expect(header).toHaveAttribute("hidden");

    // A mouse drag is not a swipe at all.
    fireEvent.pointerDown(strip, { pointerType: "mouse", clientY: 4 });
    fireEvent.pointerUp(strip, { pointerType: "mouse", clientY: 90 });
    expect(header).toHaveAttribute("hidden");
  });

  it("sends a typed message exactly as before with the composer folded", async () => {
    phone();
    await connected();
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "Is the build done?" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(sentMessages()).toContain("Is the build done?"));
    // Enter sends too.
    fireEvent.change(field, { target: { value: "And the tests?" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(sentMessages()).toContain("And the tests?"));
  });

  it("puts the attachment one tap away, and a file picked there goes with the message", async () => {
    phone();
    await connected();
    const fold = screen.getByTestId("composer-options-toggle");
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    const row = screen.getByTestId("chat-composer-row");
    expect(fold).toHaveAttribute("aria-controls", row.id);
    // The fold control did not move: it still leads the input row.
    expect(screen.getByTestId("chat-composer-primary").firstElementChild).toBe(fold);

    const pick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const attach = within(row).getByTestId("chat-attach");
    expect(attach).toHaveAccessibleName("Attach file");
    fireEvent.click(attach);
    expect(pick).toHaveBeenCalled();
    const input = pick.mock.contexts[0] as HTMLInputElement;
    expect(input.type).toBe("file");

    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(document.body.textContent).toContain("photo-1.png"));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what is this?" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      const sent = sentMessages().find(m => m.includes("what is this?"));
      expect(sent).toContain(`[Attached file: ${STAGED_PATH}]`);
    });
  });

  it("leaves fullscreen with one control, brings everything back, and remembers it", async () => {
    const { unmount } = phone();
    await connected();

    fireEvent.click(screen.getByTestId("chat-fullscreen-toggle"));
    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-header")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("chat-composer-row")).toBeInTheDocument();
    expect(screen.getByTestId("chat-attach")).toBeInTheDocument();
    expect(screen.getByTestId("composer-options-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBe("0");
    // The way back in now lives in the header, and says it is off.
    const enter = within(screen.getByTestId("chat-header")).getByTestId("chat-fullscreen-toggle");
    expect(enter).toHaveAttribute("aria-pressed", "false");
    expect(enter).toHaveAccessibleName("Fullscreen chat");
    unmount();

    // What a reload is: a fresh mount reading the stored choice.
    phone();
    await connected();
    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-header")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("chat-header").style.display).toBe("flex");
    expect(screen.getByTestId("chat-composer-row")).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId("chat-header")).getByTestId("chat-fullscreen-toggle"));
    expect(screen.getByTestId("chat-header-strip")).toBeInTheDocument();
    expect(screen.getByTestId("chat-header")).toHaveAttribute("hidden");
    expect(screen.queryByTestId("chat-composer-row")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBe("1");
  });

  it("folds what was peeked open again when the chat is closed and reopened", async () => {
    const { rerender } = phone();
    await connected();
    fireEvent.click(screen.getByTestId("chat-header-toggle"));
    fireEvent.click(screen.getByTestId("composer-options-toggle"));
    expect(screen.getByTestId("chat-composer-row")).toBeInTheDocument();

    rerender(<ChatPopup isOpen={false} onClose={() => {}} mobile />);
    rerender(<ChatPopup isOpen onClose={() => {}} mobile />);
    expect(await screen.findByTestId("chat-header-strip")).toBeInTheDocument();
    expect(screen.getByTestId("chat-header")).toHaveAttribute("hidden");
    expect(screen.queryByTestId("chat-composer-row")).not.toBeInTheDocument();
  });
});

describe("the phone chat's text size", () => {
  it("steps the conversation's size alone, says where it landed, and remembers it", async () => {
    const { unmount } = phone();
    await connected();
    const transcript = screen.getByTestId("chat-transcript");
    expect(transcript).not.toHaveAttribute("data-chat-text-scale");

    const open = screen.getByTestId("chat-text-size-toggle");
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const bar = screen.getByRole("group", { name: "Text size" });
    expect(open).toHaveAttribute("aria-controls", bar.id);
    const value = within(bar).getByTestId("chat-text-size-value");
    expect(value).toHaveTextContent("100%");
    // A button's content is presentational, so the value a screen reader
    // hears lives in the reset button's name and in a status region outside
    // every button.
    const reset = within(bar).getByTestId("chat-text-size-reset");
    expect(reset).toHaveAccessibleName("Reset text size (100%)");
    const status = within(bar).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Text size 100%");
    expect(status.closest("button")).toBeNull();

    const larger = within(bar).getByRole("button", { name: "Larger text" });
    const smaller = within(bar).getByRole("button", { name: "Smaller text" });
    fireEvent.click(larger);
    fireEvent.click(larger);
    expect(value).toHaveTextContent("130%");
    expect(status).toHaveTextContent("Text size 130%");
    expect(reset).toHaveAccessibleName("Reset text size (130%)");
    expect(transcript).toHaveAttribute("data-chat-text-scale", "1.3");
    expect(transcript.style.getPropertyValue("--chat-text-scale")).toBe("1.3");
    expect(window.localStorage.getItem(CHAT_TEXT_SCALE_STORAGE_KEY)).toBe("1.3");
    // The composer and the header are not the conversation.
    expect(screen.getByTestId("chat-composer")).not.toHaveAttribute("data-chat-text-scale");

    fireEvent.click(larger);
    expect(value).toHaveTextContent("150%");
    expect(larger).toBeDisabled();
    fireEvent.click(within(bar).getByRole("button", { name: "Reset text size (150%)" }));
    expect(value).toHaveTextContent("100%");
    expect(transcript).not.toHaveAttribute("data-chat-text-scale");
    fireEvent.click(smaller);
    expect(value).toHaveTextContent("85%");
    expect(smaller).toBeDisabled();
    fireEvent.click(larger);
    fireEvent.click(larger);
    expect(value).toHaveTextContent("115%");
    unmount();

    phone();
    await connected();
    expect(screen.getByTestId("chat-transcript")).toHaveAttribute("data-chat-text-scale", "1.15");
    // The bar itself starts closed again; the size is what persists.
    expect(screen.queryByTestId("chat-text-size-bar")).not.toBeInTheDocument();
  });

  it("is offered outside fullscreen too, from the header", async () => {
    window.localStorage.setItem(CHAT_FULLSCREEN_STORAGE_KEY, "0");
    phone();
    await connected();
    const header = screen.getByTestId("chat-header");
    fireEvent.click(within(header).getByTestId("chat-text-size-toggle"));
    expect(screen.getByTestId("chat-text-size-bar")).toBeInTheDocument();
  });
});

describe("on a big screen", () => {
  it("draws none of it, whatever a phone chose", async () => {
    window.localStorage.setItem(CHAT_FULLSCREEN_STORAGE_KEY, "1");
    window.localStorage.setItem(CHAT_TEXT_SCALE_STORAGE_KEY, "1.5");
    render(<ChatPopup isOpen onClose={() => {}} />);
    await connected();

    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-fullscreen-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-text-size-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-options-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-header")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("chat-header").style.display).toBe("flex");
    expect(screen.getByTestId("chat-transcript")).not.toHaveAttribute("data-chat-text-scale");
    // The composer row, with the paperclip in it, exactly where it was.
    expect(screen.getByTestId("chat-composer-row")).toContainElement(screen.getByTestId("chat-attach"));
  });

  it("follows a phone-sized window back to the desktop layout", async () => {
    const { rerender } = phone();
    await connected();
    expect(screen.getByTestId("chat-header-strip")).toBeInTheDocument();
    await act(async () => {
      rerender(<ChatPopup isOpen onClose={() => {}} mobile={false} />);
    });
    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-header")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("chat-header").style.display).toBe("flex");
    expect(screen.getByTestId("chat-composer-row")).toBeInTheDocument();
  });
});
