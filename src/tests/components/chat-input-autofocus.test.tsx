/**
 * The chat's message box takes the caret by itself on a big screen with a
 * mouse only (TASK-1317).
 *
 * On a phone, or anything driven by a finger, a focused input IS a soft
 * keyboard: opening the chat raised one and the whole app jumped up under it
 * before the owner had touched anything — and again on every reconnect. There
 * the conversation opens with the keyboard closed and the keyboard comes up
 * when the input is tapped. Both chat surfaces are covered: the mascot chat
 * (`ChatPopup`, which is also the phone's chat view) and the full-page chat
 * (`ChatApp`, `/app/clawbox`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { resetChatPhoneLayoutMemory } from "@/lib/chat-phone-layout";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SESSION = "agent:main:main";

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
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    const payload = frame.method === "connect"
      ? { snapshot: { sessionDefaults: { mainSessionKey: SESSION } } }
      : { messages: [] };
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }
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
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

type Device = "desktop" | "phone" | "tablet";

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

/**
 * What the page can tell about the device: a desktop is a wide viewport with a
 * mouse, a phone a narrow one with a finger, a tablet a wide one with a finger.
 */
function device(kind: Device) {
  const phone = kind === "phone";
  const coarse = kind !== "desktop";
  Object.defineProperty(window, "innerWidth", { value: phone ? 390 : 1024, configurable: true, writable: true });
  window.matchMedia = ((query: string) => ({
    matches: (coarse && query === "(pointer: coarse)") || (phone && query.includes("max-width")),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** The input is enabled once the gateway handshake lands — the moment the old code focused it. */
async function connected() {
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).not.toBeDisabled());
  return input;
}

/** Comfortably past the 100 ms the focus is deferred by, so a focus that is coming has come. */
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  installFetch();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true, writable: true });
  (document.activeElement as HTMLElement | null)?.blur?.();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
  window.localStorage.clear();
  resetChatPhoneLayoutMemory();
});

describe("the mascot chat's message box", () => {
  it("takes the caret when the chat opens on a desktop", async () => {
    device("desktop");
    render(<ChatPopup isOpen onClose={() => {}} />);
    const input = await connected();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("takes it again when the chat is closed and reopened on a desktop", async () => {
    device("desktop");
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
    const input = await connected();
    await waitFor(() => expect(input).toHaveFocus());
    rerender(<ChatPopup isOpen={false} onClose={() => {}} />);
    input.blur();
    rerender(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });

  it("leaves the keyboard closed when the chat opens on a phone", async () => {
    device("phone");
    render(<ChatPopup isOpen onClose={() => {}} mobile />);
    const input = await connected();
    await settle();
    expect(input).not.toHaveFocus();
  });

  it("leaves it closed when the phone's chat is closed and reopened", async () => {
    device("phone");
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} mobile />);
    await connected();
    rerender(<ChatPopup isOpen={false} onClose={() => {}} mobile />);
    rerender(<ChatPopup isOpen onClose={() => {}} mobile />);
    const input = await connected();
    await settle();
    expect(input).not.toHaveFocus();
  });

  it("leaves it closed on a touch screen wider than a phone", async () => {
    device("tablet");
    render(<ChatPopup isOpen onClose={() => {}} />);
    const input = await connected();
    await settle();
    expect(input).not.toHaveFocus();
  });

  it("opens the keyboard when the owner taps the input", async () => {
    device("phone");
    render(<ChatPopup isOpen onClose={() => {}} mobile />);
    const input = await connected();
    await settle();
    await userEvent.click(input);
    expect(input).toHaveFocus();
  });
});

describe("the full-page chat's message box", () => {
  it("takes the caret when the chat connects on a desktop", async () => {
    device("desktop");
    render(<ChatApp />);
    const input = await connected();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("leaves the keyboard closed when the chat connects on a phone", async () => {
    device("phone");
    render(<ChatApp />);
    const input = await connected();
    await settle();
    expect(input).not.toHaveFocus();
  });

  it("leaves it closed on a touch screen wider than a phone", async () => {
    device("tablet");
    render(<ChatApp />);
    const input = await connected();
    await settle();
    expect(input).not.toHaveFocus();
  });

  it("opens the keyboard when the owner taps the input", async () => {
    device("phone");
    render(<ChatApp />);
    const input = await connected();
    await settle();
    await userEvent.click(input);
    expect(input).toHaveFocus();
  });
});
