import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { HOLD_MIN_MS, HOLD_TO_TALK_KEY } from "@/lib/chat-hold-to-talk";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; every
// component suite that mounts it declares both ceilings
// (`test-timeout-hygiene.test.ts` is the rule).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Hold to talk in the mascot chat: the mic button held down, or F8 held while
 * the chat is open. The transitions are pinned in
 * src/tests/unit/chat-hold-to-talk.test.ts; this is what they do to the real
 * composer — what is uploaded, what is sent, what is said on screen, and above
 * all that the microphone is never left open behind an interface that looks
 * idle.
 */

type Frame = Record<string, unknown>;

const sentFrames: Frame[] = [];
const fetchedUrls: string[] = [];

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
    this.respond(id, { runId: `run-${sentFrames.length}`, status: "started" });
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

/** Start, stop, and the callbacks the composer hangs off the instance; one blob at stop. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    this.onstop?.();
  });

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start() { this.state = "recording"; }
}

const micTrackStop = vi.fn();

function installFetch(transcript = "hello") {
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
      if (url.includes("/setup-api/chat/capabilities")) {
        return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: true, hermesSupportsImages: false } }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/chat/transcribe")) {
        return { ok: true, json: async () => ({ ok: true, text: transcript }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

function installMedia() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: micTrackStop }] }) },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
}

/** The mic button, once the gateway handshake has made it live. */
async function readyToRecord() {
  const record = await screen.findByTestId("voice-record");
  await waitFor(() => expect(record).not.toBeDisabled());
  return record;
}

const transcribeCalls = () => fetchedUrls.filter((u) => u.includes("/setup-api/chat/transcribe")).length;
const sentMessages = () => sentFrames
  .filter((f) => f.method === "chat.send")
  .map((f) => (f.params as { message?: unknown } | undefined)?.message);
const composer = () => screen.getByRole("textbox");
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/**
 * F8 down on the composer — where the owner's focus is when they hold it to talk.
 *
 * Pressed until the capture shows, not once: the key reads the connection from
 * a ref an effect keeps current, and under a loaded parallel run that effect
 * can land a beat after the button has drawn itself enabled — a press in that
 * beat is a press on a chat that is not connected yet, and is ignored. A
 * second press while the first one's hold is live changes nothing
 * (`stepHold`), so pressing again is safe.
 */
async function holdKey(target: Element = composer()) {
  await waitFor(() => {
    if (!screen.queryByTestId("voice-stop")) fireEvent.keyDown(target, { key: HOLD_TO_TALK_KEY });
    expect(screen.getByTestId("voice-stop")).toBeInTheDocument();
  }, { timeout: 10_000 });
}
const releaseKey = (target: Element = composer()) => act(async () => { fireEvent.keyUp(target, { key: HOLD_TO_TALK_KEY }); });

describe("hold to talk", () => {
  beforeEach(() => {
    sentFrames.length = 0;
    fetchedUrls.length = 0;
    FakeMediaRecorder.instances.length = 0;
    micTrackStop.mockClear();
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installMedia();
    installFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  describe("the key", () => {
    it("records while F8 is held, says so, and sends the words on release", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await holdKey();
      // Before the minimum, letting go would cancel, so nothing promises "send".
      expect(screen.getByTestId("voice-status")).not.toHaveAttribute("data-held");
      await advance(HOLD_MIN_MS + 50);
      const status = screen.getByTestId("voice-status");
      expect(status).toHaveAttribute("data-held", "key");
      expect(status.textContent).toContain("chat.voice.holdingKey");
      expect(screen.getByTestId("voice-stop")).toHaveAttribute("data-held", "key");

      await releaseKey();
      await waitFor(() => expect(sentMessages()).toContain("hello"));
      expect(transcribeCalls()).toBe(1);
      expect(micTrackStop).toHaveBeenCalled();
    });

    it("cancels a hold shorter than the minimum: nothing uploaded, the mic released, the reason said", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await holdKey();
      const recorder = FakeMediaRecorder.instances[0];
      await releaseKey();

      expect(recorder.stop).toHaveBeenCalledTimes(1);
      expect(micTrackStop).toHaveBeenCalled();
      expect(screen.queryByTestId("voice-stop")).toBeNull();
      expect(screen.getByTestId("voice-status").textContent).toContain("chat.voice.tooShort");
      await advance(1000);
      expect(transcribeCalls()).toBe(0);
      expect(sentMessages()).toEqual([]);
    });

    it("ignores key-repeat: one recording for one hold", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await holdKey();
      for (let i = 0; i < 6; i++) {
        fireEvent.keyDown(composer(), { key: HOLD_TO_TALK_KEY, repeat: true });
        await advance(40);
      }
      await advance(HOLD_MIN_MS);
      await releaseKey();

      expect(FakeMediaRecorder.instances).toHaveLength(1);
      await waitFor(() => expect(transcribeCalls()).toBe(1));
    });

    it("cancels on Escape while held — and Escape goes no further: the chat stays open", async () => {
      const onClose = vi.fn();
      render(<ChatPopup isOpen onClose={onClose} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await holdKey();
      await advance(HOLD_MIN_MS + 200);
      await act(async () => { fireEvent.keyDown(composer(), { key: "Escape" }); });

      expect(onClose).not.toHaveBeenCalled();
      expect(micTrackStop).toHaveBeenCalled();
      expect(screen.queryByTestId("voice-status")).toBeNull();
      // The key's own release after that has nothing left to send.
      await releaseKey();
      await advance(500);
      expect(transcribeCalls()).toBe(0);
      // With nothing held, Escape is the chat's again.
      fireEvent.keyDown(composer(), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("stops and releases the microphone when the window loses focus mid-hold", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await holdKey();
      await advance(HOLD_MIN_MS + 200);
      await act(async () => { window.dispatchEvent(new Event("blur")); });

      expect(micTrackStop).toHaveBeenCalled();
      expect(screen.queryByTestId("voice-stop")).toBeNull();
      // The keyup lands in another window and never arrives; nothing is sent.
      await advance(500);
      expect(transcribeCalls()).toBe(0);
    });

    it("stops and releases the microphone when the tab is hidden mid-hold", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const visibility = vi.spyOn(document, "visibilityState", "get");

      await holdKey();
      await advance(HOLD_MIN_MS + 200);
      visibility.mockReturnValue("hidden");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      visibility.mockRestore();

      expect(micTrackStop).toHaveBeenCalled();
      expect(screen.queryByTestId("voice-stop")).toBeNull();
      expect(transcribeCalls()).toBe(0);
    });

    it("stops and releases the microphone when the chat closes mid-hold, uploading nothing", async () => {
      const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await holdKey();
      await advance(HOLD_MIN_MS + 200);
      rerender(<ChatPopup isOpen={false} onClose={() => {}} />);
      await advance(10);

      expect(micTrackStop).toHaveBeenCalled();
      expect(transcribeCalls()).toBe(0);
    });

    it("does not throw away what Stop already sent when the key is let go of afterwards", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await holdKey();
      // Stop clicked with the mouse while F8 is still down — inside the
      // too-short window, which must not turn into a cancel.
      fireEvent.click(screen.getByTestId("voice-stop"), { detail: 1 });
      await releaseKey();
      await act(async () => { window.dispatchEvent(new Event("blur")); });

      await waitFor(() => expect(sentMessages()).toContain("hello"));
      expect(transcribeCalls()).toBe(1);
      expect(screen.queryByText("chat.voice.tooShort")).toBeNull();
    });

    it("leaves F8 to a terminal that has the focus", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      const terminal = document.createElement("div");
      terminal.className = "xterm";
      const input = document.createElement("textarea");
      terminal.appendChild(input);
      document.body.appendChild(terminal);
      try {
        fireEvent.keyDown(input, { key: HOLD_TO_TALK_KEY });
        await act(async () => { await Promise.resolve(); });
        expect(FakeMediaRecorder.instances).toHaveLength(0);
        expect(screen.queryByTestId("voice-status")).toBeNull();
      } finally {
        terminal.remove();
      }
    });

    it("is not Shift+F8, Ctrl+F8 or any other chord", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await readyToRecord();
      fireEvent.keyDown(composer(), { key: HOLD_TO_TALK_KEY, shiftKey: true });
      fireEvent.keyDown(composer(), { key: HOLD_TO_TALK_KEY, ctrlKey: true });
      await act(async () => { await Promise.resolve(); });
      expect(FakeMediaRecorder.instances).toHaveLength(0);
    });
  });

  describe("the mic button", () => {
    const pointerDown = (el: Element) => fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 7 });
    const pointerUp = () => act(async () => { fireEvent.pointerUp(window, { button: 0, isPrimary: true, pointerId: 7 }); });

    it("says in its tooltip that it can be held, and which key does the same", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      const record = await readyToRecord();
      expect(record.getAttribute("title")).toBe("chat.voice.recordHint");
      expect(record).toHaveAttribute("aria-keyshortcuts", HOLD_TO_TALK_KEY);
      // The accessible NAME is still the action.
      expect(record.getAttribute("aria-label")).toBe("chat.voice.record");
    });

    it("records while held and sends on release — exactly the Stop click", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      const record = await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      pointerDown(record);
      const stop = await screen.findByTestId("voice-stop");
      await advance(HOLD_MIN_MS + 100);
      expect(screen.getByTestId("voice-status")).toHaveAttribute("data-held", "pointer");
      expect(screen.getByTestId("voice-status").textContent).toContain("chat.voice.holding");

      await pointerUp();
      // The click the browser fires after the release belongs to the press.
      fireEvent.click(stop, { detail: 1 });
      await waitFor(() => expect(sentMessages()).toContain("hello"));
      expect(transcribeCalls()).toBe(1);
      expect(FakeMediaRecorder.instances[0].stop).toHaveBeenCalledTimes(1);
    });

    it("keeps today's toggle on a quick tap: recording goes on until Stop is clicked", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      const record = await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      pointerDown(record);
      const stop = await screen.findByTestId("voice-stop");
      await advance(80);
      await pointerUp();
      fireEvent.click(stop, { detail: 1 });
      await advance(2000);

      // Still recording, still saying so, nothing sent.
      const recorder = FakeMediaRecorder.instances[0];
      expect(recorder.stop).not.toHaveBeenCalled();
      expect(screen.getByTestId("voice-stop")).toBeInTheDocument();
      expect(screen.getByTestId("voice-status")).not.toHaveAttribute("data-held");
      expect(transcribeCalls()).toBe(0);

      // The second click is Stop, as it always was.
      fireEvent.pointerDown(screen.getByTestId("voice-stop"), { button: 0, isPrimary: true, pointerId: 8 });
      fireEvent.click(screen.getByTestId("voice-stop"), { detail: 1 });
      await waitFor(() => expect(transcribeCalls()).toBe(1));
      expect(recorder.stop).toHaveBeenCalledTimes(1);
    });

    it("sends nothing when the pointer is dragged off the button before letting go", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      const record = await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      pointerDown(record);
      await screen.findByTestId("voice-stop");
      await advance(HOLD_MIN_MS + 400);
      // jsdom lays the button out at 0,0; this is far off it.
      await act(async () => { fireEvent.pointerUp(window, { button: 0, isPrimary: true, pointerId: 7, clientX: 600, clientY: 600 }); });

      expect(micTrackStop).toHaveBeenCalled();
      expect(screen.queryByTestId("voice-stop")).toBeNull();
      await advance(500);
      expect(transcribeCalls()).toBe(0);
      expect(sentMessages()).toEqual([]);
    });

    it("cancels a held button on Escape, without closing the chat", async () => {
      const onClose = vi.fn();
      render(<ChatPopup isOpen onClose={onClose} />);
      const record = await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      pointerDown(record);
      await screen.findByTestId("voice-stop");
      await advance(HOLD_MIN_MS + 100);
      await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
      await pointerUp();

      expect(onClose).not.toHaveBeenCalled();
      expect(micTrackStop).toHaveBeenCalled();
      expect(transcribeCalls()).toBe(0);
    });

    it("cancels when the pointer is taken away (pointercancel) instead of let go", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      const record = await readyToRecord();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      pointerDown(record);
      await screen.findByTestId("voice-stop");
      await advance(HOLD_MIN_MS + 100);
      await act(async () => { fireEvent.pointerCancel(window, { pointerId: 7 }); });

      expect(micTrackStop).toHaveBeenCalled();
      expect(screen.queryByTestId("voice-stop")).toBeNull();
      expect(transcribeCalls()).toBe(0);
    });

    it("still records from a keyboard click (Enter or Space on the focused button)", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      const record = await readyToRecord();
      fireEvent.click(record, { detail: 0 });
      await screen.findByTestId("voice-stop");
      fireEvent.click(screen.getByTestId("voice-stop"), { detail: 0 });
      await waitFor(() => expect(transcribeCalls()).toBe(1));
    });
  });
});
