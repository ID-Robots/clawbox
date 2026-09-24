/**
 * Fullscreen chat on the full-page chat, `/app/clawbox` (TASK-1157).
 *
 * The same view settings as the mascot chat (lib/chat-phone-layout.ts), on the
 * page "Open in new tab" and a mailed link open: on a phone its header folds
 * into the strip — taking the page's own title bar with it, whose way back to
 * the desktop then rides in the chat's header — and the composer folds its
 * attachment buttons behind one control. At or above the desktop breakpoint
 * nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";
import {
  CHAT_FULLSCREEN_STORAGE_KEY,
  CHAT_TEXT_SCALE_STORAGE_KEY,
  resetChatPhoneLayoutMemory,
} from "@/lib/chat-phone-layout";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SESSION = "agent:main:main";
const sent: Record<string, unknown>[] = [];

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    sent.push(frame);
    const id = frame.id as string;
    if (frame.method === "connect") {
      setTimeout(() => this.emit({
        type: "res", id, ok: true,
        payload: { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } },
      }), 0);
      return;
    }
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload: { messages: [], runId: `run-${sent.length}` } }), 0);
  }

  close() { this.readyState = 3; }
  addEventListener() {}
  removeEventListener() {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

const originalMatchMedia = window.matchMedia;

/** A phone-sized viewport, as the desktop's own breakpoint query sees it. */
function viewport(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width") ? phone : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function connected() {
  await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
}

beforeEach(() => {
  sent.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  installFetch();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
  resetHarnessCache();
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
});

describe("the full-page chat on a phone", () => {
  it("opens fullscreen: the header behind the strip, the page's title bar folded away with it", async () => {
    viewport(true);
    const chrome = vi.fn();
    render(<ChatApp onPhoneChromeHiddenChange={chrome} />);
    await connected();

    const header = screen.getByTestId("chatapp-header");
    const toggle = screen.getByTestId("chat-header-toggle");
    expect(header).toHaveAttribute("hidden");
    expect(toggle).toHaveAttribute("aria-controls", header.id);
    expect(chrome).toHaveBeenLastCalledWith(true);

    // Opened, the header carries the way back to the desktop the page's bar
    // would have.
    fireEvent.click(toggle);
    expect(header).not.toHaveAttribute("hidden");
    const home = within(header).getByTestId("chatapp-desktop-link");
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAccessibleName("chat.showDesktop");
  });

  it("folds the attachment buttons behind one control that never moves, and still sends", async () => {
    viewport(true);
    render(<ChatApp />);
    await connected();

    const fold = await screen.findByTestId("chatapp-composer-options-toggle");
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTitle("chat.attachImage")).not.toBeInTheDocument();
    expect(screen.queryByTitle("chat.takePhoto")).not.toBeInTheDocument();

    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    const options = screen.getByTestId("chatapp-composer-options");
    expect(fold).toHaveAttribute("aria-controls", options.id);
    expect(within(options).getByTitle("chat.attachImage")).toBeInTheDocument();
    expect(within(options).getByTitle("chat.takePhoto")).toBeInTheDocument();
    // First in the row, before the field, in both states.
    expect(fold.parentElement!.firstElementChild).toBe(fold);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Still there?" } });
    fireEvent.click(screen.getByTitle("chat.send"));
    await waitFor(() => expect(sent.some(f => f.method === "chat.send"
      && (f.params as { message?: unknown }).message === "Still there?")).toBe(true));
  });

  it("leaves fullscreen, hands the page its title bar back, and remembers it", async () => {
    viewport(true);
    const chrome = vi.fn();
    const { unmount } = render(<ChatApp onPhoneChromeHiddenChange={chrome} />);
    await connected();

    fireEvent.click(screen.getByTestId("chat-fullscreen-toggle"));
    expect(chrome).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    const header = screen.getByTestId("chatapp-header");
    expect(header).not.toHaveAttribute("hidden");
    // The page's bar is back, so its link is not drawn twice.
    expect(within(header).queryByTestId("chatapp-desktop-link")).not.toBeInTheDocument();
    expect(screen.getByTitle("chat.attachImage")).toBeInTheDocument();
    expect(window.localStorage.getItem(CHAT_FULLSCREEN_STORAGE_KEY)).toBe("0");
    unmount();

    render(<ChatApp />);
    await connected();
    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("chatapp-header")).getByTestId("chat-fullscreen-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("steps the conversation's text size and keeps it", async () => {
    viewport(true);
    render(<ChatApp />);
    await connected();
    fireEvent.click(screen.getByTestId("chat-text-size-toggle"));
    const bar = screen.getByRole("group", { name: "Text size" });
    fireEvent.click(within(bar).getByRole("button", { name: "Larger text" }));
    expect(screen.getByTestId("chatapp-transcript")).toHaveAttribute("data-chat-text-scale", "1.15");
    expect(window.localStorage.getItem(CHAT_TEXT_SCALE_STORAGE_KEY)).toBe("1.15");
  });
});

describe("the full-page chat on a big screen", () => {
  it("is exactly what it was, whatever a phone chose", async () => {
    viewport(false);
    window.localStorage.setItem(CHAT_FULLSCREEN_STORAGE_KEY, "1");
    window.localStorage.setItem(CHAT_TEXT_SCALE_STORAGE_KEY, "1.5");
    const chrome = vi.fn();
    render(<ChatApp onPhoneChromeHiddenChange={chrome} />);
    await connected();

    expect(chrome).not.toHaveBeenCalledWith(true);
    expect(screen.queryByTestId("chat-header-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-fullscreen-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-text-size-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chatapp-composer-options-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("chatapp-header")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("chatapp-transcript")).not.toHaveAttribute("data-chat-text-scale");
    // The attachment buttons sit in the input row, before the field, as ever.
    expect(await screen.findByTitle("chat.attachImage")).toBeInTheDocument();
  });
});
