import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { I18nProvider } from "@/lib/i18n";
import { translations } from "@/lib/translations";

/**
 * The voice status row is the only channel the composer has for what the
 * microphone is doing: the record button's label never changes, and everything
 * else about a live capture — the pulsing dot, the running clock — is visual.
 * A screen-reader user who cannot tell that the microphone opened, or that a
 * transcription failed, is being told nothing at all.
 *
 * Both assertions here are on the same row, entered through the cheapest door:
 * jsdom has no `navigator.mediaDevices` and no `MediaRecorder`, so clicking
 * record puts the panel straight into its `unsupported` error state with no
 * media faking whatsoever. That is a real non-idle render of the same node the
 * recording and transcribing states use.
 */

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
      // No saved language, so I18nProvider detects one from the browser —
      // jsdom reports en-US, which is what makes the English copy render.
      if (url.includes("/setup-api/preferences")) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/**
 * Open the voice status row.
 *
 * The mic button is disabled until the gateway says `connected`, so clicking
 * before the handshake lands would assert against a panel that never mounted.
 */
async function openVoiceStatus() {
  render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
  const record = await screen.findByTestId("voice-record");
  await waitFor(() => expect(record).not.toBeDisabled());
  fireEvent.click(record);
  return screen.findByTestId("voice-status");
}

/**
 * Say whether this page counts as a secure context.
 *
 * jsdom exposes `isSecureContext` as a plain own property, and the component
 * reads exactly the property the browser gates `getUserMedia` on — so setting
 * it here reproduces the LAN origin (`http://192.168.x.x/`) and the tunnel
 * origin (`https://…`) without faking any media API.
 */
function setSecureContext(secure: boolean) {
  Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
}

describe("chat voice status row", () => {
  beforeEach(() => {
    instances.length = 0;
    sentFrames.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    installFetch();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    // jsdom's default varies with the test URL; pin it so a test that does not
    // care about the origin is not silently deciding this behaviour.
    setSecureContext(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("announces voice state changes to a screen reader", async () => {
    const panel = await openVoiceStatus();

    expect(panel).toHaveAttribute("role", "status");
    expect(panel).toHaveAttribute("aria-live", "polite");
    // The role has to be exposed, not merely spelled: a live region the
    // accessibility tree does not surface announces nothing.
    expect(await screen.findByRole("status")).toBe(panel);
  });

  it("labels the error dismiss button as a dismiss, not the image-preview close", async () => {
    await openVoiceStatus();
    const dismiss = await screen.findByTestId("voice-dismiss");

    // Asserting on the rendered copy rather than on the key: this fails both
    // when the button names the wrong string and when the right key has no
    // entry to resolve to, which would put the raw key in front of the user.
    await waitFor(() =>
      expect(dismiss.getAttribute("aria-label")).toBe(translations.en["chat.voice.dismiss"]),
    );
    expect(dismiss.getAttribute("aria-label")).not.toBe(translations.en["chat.closePreview"]);
  });

  /**
   * TASK-470. `http://<ip>/` and `http://clawbox.local/` are how customers
   * actually reach their box, and they are not secure contexts, so the browser
   * removes `navigator.mediaDevices` and the microphone can NEVER work there.
   * The old copy said "This browser cannot record audio", which blames a
   * browser that is fine and names no remedy the owner can act on.
   */
  it("says the connection is the problem, not the browser, on a LAN origin", async () => {
    setSecureContext(false);
    const panel = await openVoiceStatus();

    await waitFor(() =>
      expect(panel.textContent).toContain(translations.en["chat.voice.insecureContext"]),
    );
    expect(panel.textContent).not.toContain(translations.en["chat.voice.unsupported"]);
    // The remedy has to be in the sentence — an accurate diagnosis the owner
    // cannot act on is no better than the wrong one.
    expect(translations.en["chat.voice.insecureContext"]).toContain("Remote Desktop");

    // …and it has to be READABLE. The row is one ellipsised line while a
    // capture is live, which on a real box cut this sentence off at "Open
    // this ClawBox…" — the half with the fix in it. Errors wrap.
    const line = panel.querySelector("span");
    expect(line).not.toBeNull();
    expect((line as HTMLElement).style.whiteSpace).toBe("normal");
    expect((line as HTMLElement).style.textOverflow).not.toBe("ellipsis");
  });

  it("labels the mic button with the reason before anyone clicks it", async () => {
    setSecureContext(false);
    render(<I18nProvider><ChatPopup isOpen onClose={() => {}} /></I18nProvider>);
    const record = await screen.findByTestId("voice-record");

    await waitFor(() =>
      expect(record.getAttribute("title")).toBe(translations.en["chat.voice.insecureContext"]),
    );
    expect(record.getAttribute("aria-label")).toBe(translations.en["chat.voice.insecureContext"]);
  });

  it("still blames the browser on a secure origin that cannot record", async () => {
    // Same missing capture API, secure origin: here the browser really is the
    // problem and the original message is the honest one. jsdom has no
    // mediaDevices either way, so this is the true fork in the diagnosis.
    setSecureContext(true);
    const panel = await openVoiceStatus();

    await waitFor(() =>
      expect(panel.textContent).toContain(translations.en["chat.voice.unsupported"]),
    );
    expect(panel.textContent).not.toContain(translations.en["chat.voice.insecureContext"]);
    const record = screen.getByTestId("voice-record");
    expect(record.getAttribute("aria-label")).toBe(translations.en["chat.voice.record"]);
  });
});
