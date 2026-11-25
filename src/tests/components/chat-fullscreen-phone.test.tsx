import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import {
  CHAT_FULLSCREEN_STORAGE_KEY,
  CHAT_TEXT_SCALE_STORAGE_KEY,
  resetChatPhoneLayoutMemory,
} from "@/lib/chat-phone-layout";
import { CHAT_MOBILE_BACK, mobileBackDepth, resetMobileBackForTests, runMobileBack } from "@/lib/mobile-back";

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
    // Only a sent message is answered, so an untouched chat stays empty (the
    // portrait bar's title follows whether it has messages).
    if (frame.method !== "chat.send") return;
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

/** What `/setup-api/chat/model` answers; a test with pickers sets its own. */
const NO_PICKERS = { options: [], activeOptionId: "" };
let chatModelBody: Record<string, unknown> = NO_PICKERS;
/** The bodies POSTed to `/setup-api/chat/model` — a model switch. */
const modelSwitches: Record<string, unknown>[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/chat/model") && init?.method === "POST") {
        const picked = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        modelSwitches.push(picked);
        // The route answers with the box's new state.
        const options = (chatModelBody.options ?? []) as { id: string; model?: string }[];
        const now = options.find(o => o.model === picked.model);
        return { ok: true, json: async () => ({ ...chatModelBody, activeOptionId: now?.id ?? "", activeModel: picked.model }) };
      }
      if (url.includes("/setup-api/gateway/ws-config")) {
        return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => chatModelBody };
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
  modelSwitches.length = 0;
  chatModelBody = NO_PICKERS;
  resetMobileBackForTests();
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

/**
 * A phone held upright (TASK-2778): one slim bar instead of the header (a menu
 * button, and the conversation's name once it has one), a menu from the left
 * with everything the header held, and a composer of one row — "+", the model,
 * the microphone, Send — whose "+" and model each open a bottom sheet. The
 * fullscreen mode has no part in it; landscape (every test above: jsdom's
 * viewport is wider than tall) keeps all of it as it was.
 */
describe("a phone held upright", () => {
  const originalMatchMedia = window.matchMedia;

  function orient(portrait: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("portrait") ? portrait : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  /** ClawBox AI with its effort levels, and Local AI beside it. */
  const PICKERS = {
    activeOptionId: "clawai",
    activeModel: "deepseek/deepseek-v4-flash",
    activeSource: "primary",
    activeLabel: "ClawBox AI",
    options: [
      {
        id: "clawai", label: "ClawBox AI", model: "deepseek/deepseek-v4-flash", provider: "clawai",
        available: true, settingsSection: "ai", isLocal: false, thinkingLevels: ["off", "low", "medium", "high"],
      },
      {
        id: "local", label: "Local AI", model: "llamacpp/gemma-4-e2b", provider: "llamacpp",
        available: true, settingsSection: "local-ai", isLocal: true,
      },
    ],
    primary: { available: true, label: "ClawBox AI", model: "deepseek/deepseek-v4-flash" },
    local: { available: true, label: "Local AI", model: "llamacpp/gemma-4-e2b" },
  };

  beforeEach(() => orient(true));
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  it("trades the header for one slim bar: the menu, and the title once there is a conversation", async () => {
    phone();
    await connected();

    const bar = screen.getByTestId("chat-phone-bar");
    const menu = within(bar).getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-haspopup", "dialog");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    // The header's controls are gone from view and from the accessibility
    // tree: tabs, new chat, text size, fullscreen and the Desktop pill.
    expect(screen.getByTestId("chat-header")).toHaveAttribute("hidden");
    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-fullscreen-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-text-size-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-popup")).toHaveAttribute("data-chat-portrait", "true");
    // An empty chat has no title, only the greeting.
    expect(screen.queryByTestId("chat-phone-title")).not.toBeInTheDocument();
    expect(screen.getByText("chat.saySomething")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    expect(await screen.findByTestId("chat-phone-title")).toHaveTextContent("ClawBox");
    // Upright neither reads nor writes the fullscreen choice.
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBeNull();
  });

  it("leaves landscape's fullscreen choice where it was, and turning the phone brings that layout back", async () => {
    window.localStorage.setItem(CHAT_FULLSCREEN_STORAGE_KEY, "0");
    phone();
    await connected();
    expect(screen.getByTestId("chat-phone-bar")).toBeInTheDocument();
    expect(screen.getByTestId("chat-header")).toHaveAttribute("hidden");

    orient(false);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(screen.queryByTestId("chat-phone-bar")).not.toBeInTheDocument();
    // Landscape outside fullscreen, as stored: the full header and the row.
    expect(screen.getByTestId("chat-header")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("chat-composer-row")).toBeInTheDocument();
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBe("0");

    orient(true);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(screen.getByTestId("chat-phone-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-composer-row")).not.toBeInTheDocument();
  });

  it("leaves landscape's own fold and header peek as they were after a turn upright", async () => {
    orient(false);
    phone();
    await connected();
    // Landscape fullscreen (the default): peek the header, unfold the options.
    fireEvent.click(screen.getByTestId("chat-header-toggle"));
    fireEvent.click(screen.getByTestId("composer-options-toggle"));
    expect(screen.getByTestId("chat-composer-row")).toBeInTheDocument();

    orient(true);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(screen.getByTestId("chat-phone-bar")).toBeInTheDocument();
    orient(false);
    act(() => { window.dispatchEvent(new Event("resize")); });

    expect(screen.getByTestId("chat-header-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chat-header")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("composer-options-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chat-composer-row")).toBeInTheDocument();
  });

  it("opens a menu from the left with a new chat, the chats, the desktop and the text size", async () => {
    const onClose = vi.fn();
    phone({ onClose });
    await connected();

    const button = screen.getByTestId("chat-phone-menu-button");
    fireEvent.click(button);
    const menu = screen.getByRole("dialog", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-modal", "true");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", menu.id);
    // Focus moved in, and the chat behind it is out of reach.
    expect(menu).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByTestId("chat-composer").closest("[inert]")).not.toBeNull();

    expect(within(menu).getByRole("button", { name: "New chat" })).toBeEnabled();
    const rows = within(menu).getAllByTestId("chat-phone-menu-chat");
    expect(rows).toHaveLength(1);
    const main = within(rows[0]).getByTestId("chat-phone-menu-select");
    expect(main).toHaveTextContent("ClawBox");
    expect(main).toHaveAttribute("aria-current", "true");
    // Main's restart, as on its tab plate.
    expect(within(rows[0]).getByRole("button", { name: "New session" })).toBeInTheDocument();
    expect(within(menu).getByRole("group", { name: "Text size" })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("button", { name: "Show the desktop" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the menu on Escape, a tap beside it and the phone's Back, and gives focus back", async () => {
    const onClose = vi.fn();
    phone({ onClose });
    await connected();
    const button = screen.getByTestId("chat-phone-menu-button");

    // No focus beforehand, as after a tap in Safari: the button takes it
    // itself, so the menu has somewhere to hand it back.
    expect(button).not.toHaveFocus();
    fireEvent.click(button);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    // The Escape stopped at the menu: the chat is still open.
    expect(onClose).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("chat-composer").closest("[inert]")).toBeNull();

    fireEvent.click(button);
    // A tap on the menu itself is not a tap beside it.
    fireEvent.click(screen.getByRole("dialog", { name: "Menu" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-phone-menu-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();

    // Back: the menu holds one level of page.tsx's back depth, under the
    // chat's owner, so the page closes it before it closes the chat.
    expect(mobileBackDepth()).toBe(0);
    fireEvent.click(button);
    expect(mobileBackDepth()).toBe(1);
    act(() => { expect(runMobileBack(CHAT_MOBILE_BACK)).toBe(true); });
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
    expect(mobileBackDepth()).toBe(0);
  });

  it("starts, switches and closes chats from the menu, which closes behind each pick", async () => {
    phone();
    await connected();
    const button = screen.getByTestId("chat-phone-menu-button");

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();

    fireEvent.click(button);
    let rows = screen.getAllByTestId("chat-phone-menu-chat");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveAttribute("data-active", "true");
    expect(within(rows[1]).getByTestId("chat-phone-menu-select")).toHaveTextContent("chat.tabUntitled");
    // The open tab carries its close; main, not open, has no restart now.
    expect(within(rows[1]).getByRole("button", { name: "Close tab" })).toBeInTheDocument();
    expect(within(rows[0]).queryByRole("button", { name: "New session" })).not.toBeInTheDocument();

    fireEvent.click(within(rows[0]).getByTestId("chat-phone-menu-select"));
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByTestId("chat-phone-menu-chat")[0]).toHaveAttribute("data-active", "true"));

    rows = screen.getAllByTestId("chat-phone-menu-chat");
    fireEvent.click(within(rows[1]).getByTestId("chat-phone-menu-select"));
    fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByTestId("chat-phone-menu-chat")[1]).toHaveAttribute("data-active", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getAllByTestId("chat-phone-menu-chat")).toHaveLength(1);
  });

  it("steps the conversation's text size from the menu", async () => {
    phone();
    await connected();
    fireEvent.click(screen.getByTestId("chat-phone-menu-button"));
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(screen.getByTestId("chat-transcript")).toHaveAttribute("data-chat-text-scale", "1.15");
    expect(window.localStorage.getItem(CHAT_TEXT_SCALE_STORAGE_KEY)).toBe("1.15");
  });

  it("puts the composer on one row under the text: +, the model, then Send", async () => {
    chatModelBody = PICKERS;
    phone();
    await connected();
    const pill = await screen.findByTestId("chat-model-pill");

    const primary = screen.getByTestId("chat-composer-primary");
    const plus = screen.getByTestId("composer-options-toggle");
    expect(primary.firstElementChild?.tagName).toBe("TEXTAREA");
    expect(primary.children[1]).toBe(plus);
    expect(primary.children[2]).toContainElement(pill);
    expect(primary.lastElementChild).toBe(screen.getByTestId("chat-send"));
    expect(plus).toHaveAttribute("aria-haspopup", "dialog");
    // No row of pickers and paperclip under it, and no pills anywhere.
    expect(screen.queryByTestId("chat-composer-row")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".chat-header-pills")).toHaveLength(0);
    // The pill names the provider and the effort.
    expect(pill).toHaveTextContent(/^ClawBox\s*Medium/);
  });

  it("opens the options as a bottom sheet from +, and a file picked there goes with the message", async () => {
    phone();
    await connected();
    const plus = screen.getByTestId("composer-options-toggle");
    fireEvent.click(plus);
    const sheet = screen.getByRole("dialog", { name: "Chat options" });
    expect(plus).toHaveAttribute("aria-expanded", "true");
    expect(plus).toHaveAttribute("aria-controls", sheet.id);
    expect(within(sheet).getByTestId("chat-new-app-toggle")).toBeInTheDocument();

    const pick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(within(sheet).getByRole("button", { name: "Attach file" }));
    expect(pick).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Chat options" })).not.toBeInTheDocument();
    const input = pick.mock.contexts[0] as HTMLInputElement;
    expect(input.type).toBe("file");
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(document.body.textContent).toContain("photo-1.png"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what is this?" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      expect(sentMessages().find(m => m.includes("what is this?"))).toContain(`[Attached file: ${STAGED_PATH}]`);
    });

    // Escape and Back close it too.
    fireEvent.click(plus);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Chat options" })).not.toBeInTheDocument();
    fireEvent.click(plus);
    act(() => { runMobileBack(CHAT_MOBILE_BACK); });
    expect(screen.queryByRole("dialog", { name: "Chat options" })).not.toBeInTheDocument();
  });

  it("opens the model sheet from the pill: the current choice ticked, the effort row, and a pick switches", async () => {
    chatModelBody = PICKERS;
    phone();
    await connected();
    const pill = await screen.findByTestId("chat-model-pill");
    fireEvent.click(pill);
    const sheet = screen.getByRole("dialog", { name: "Model" });
    expect(pill).toHaveAttribute("aria-expanded", "true");

    const providers = within(sheet).getByRole("group", { name: "Chat provider" });
    const rows = within(providers).getAllByRole("button");
    expect(rows.map(r => r.getAttribute("data-option-id"))).toEqual(["clawai", "local"]);
    expect(rows[0]).toHaveAttribute("aria-pressed", "true");
    expect(rows[1]).toHaveAttribute("aria-pressed", "false");

    // The effort row: a pick there stays in the sheet and moves the pill.
    const effort = within(sheet).getByRole("group", { name: "Reasoning effort" });
    const high = within(effort).getAllByRole("button").find(o => o.getAttribute("data-option-id") === "high")!;
    fireEvent.click(high);
    await waitFor(() => expect(high).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("dialog", { name: "Model" })).toBeInTheDocument();
    expect(pill).toHaveTextContent(/^ClawBox\s*High/);

    // The provider already in use changes nothing and closes the sheet,
    // which hands focus back to the pill.
    fireEvent.click(rows[0]);
    expect(screen.queryByRole("dialog", { name: "Model" })).not.toBeInTheDocument();
    expect(modelSwitches).toHaveLength(0);
    expect(pill).toHaveFocus();

    // Another one goes through the picker's own switch.
    fireEvent.click(pill);
    fireEvent.click(within(screen.getByRole("group", { name: "Chat provider" })).getAllByRole("button")[1]);
    expect(screen.queryByRole("dialog", { name: "Model" })).not.toBeInTheDocument();
    await waitFor(() => expect(modelSwitches).toContainEqual(expect.objectContaining({ model: "llamacpp/gemma-4-e2b", provider: "llamacpp" })));
  });
});
