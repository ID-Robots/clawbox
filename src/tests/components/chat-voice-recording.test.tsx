import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { MAX_RECORDING_MS } from "@/lib/chat-voice-input";

/**
 * Two things a capture must not do to the person holding the microphone.
 *
 * It must not run forever: nothing in the browser bounds a `MediaRecorder`, and
 * the transcribe route only learns a blob is oversized after the whole upload
 * has gone up, so an unbounded recording is paid for twice — once in the wait,
 * once in the lost dictation.
 *
 * And it must not offer to re-send audio that already came back empty: the call
 * succeeded, so the same bytes buy the same silence and one more paid
 * transcription.
 */

type Frame = Record<string, unknown>;

const sentFrames: Frame[] = [];
/** Every URL the component fetched, in order. */
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

/**
 * The narrowest `MediaRecorder` the composer actually uses: start, stop, and
 * the two callbacks it hangs off the instance. With no timeslice a real
 * recorder delivers everything in one blob at stop, which is what this does.
 */
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

/** @param transcript what the transcribe route answers with. */
function installFetch(transcript: string) {
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

/**
 * Wait until the mic button is live.
 *
 * It is disabled until the gateway handshake lands, so clicking earlier starts
 * nothing and the test asserts against a capture that never happened. Kept
 * separate from pressing it because the deadline tests have to swap in fake
 * timers between the two: the handshake needs real ones, and a `setTimeout`
 * scheduled before `useFakeTimers` can never be advanced.
 */
async function readyToRecord() {
  const record = await screen.findByTestId("voice-record");
  await waitFor(() => expect(record).not.toBeDisabled());
  return record;
}

/** Start a capture and wait until the composer is really in `recording`. */
async function pressRecord(record: HTMLElement) {
  fireEvent.click(record);
  await screen.findByTestId("voice-stop");
  return FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
}

const transcribeCalls = () => fetchedUrls.filter((u) => u.includes("/setup-api/chat/transcribe")).length;

describe("chat voice recording", () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("stops a recording that has run past the cap instead of uploading a blob the box will reject", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} />);
    const record = await readyToRecord();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recorder = await pressRecord(record);

    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS); });

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(micTrackStop).toHaveBeenCalled();
    // Ended the same way the stop button ends it, so the words still arrive.
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain("hello"));
  });

  it("does not push the deadline back as the recording clock re-renders", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} />);
    const record = await readyToRecord();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recorder = await pressRecord(record);

    // Tick the elapsed clock 150 times, one committed render each. A deadline
    // re-armed by those renders would sit 30s past the cap.
    const RENDER_CHURN_MS = 30_000;
    for (let elapsed = 0; elapsed < RENDER_CHURN_MS; elapsed += 200) {
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    }
    // The renders really happened, so the jump below is a real test of the
    // deadline's arming rather than of an inert component.
    expect(screen.getByTestId("voice-status").textContent).toContain("0:30");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS - RENDER_CHURN_MS);
    });

    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it("does not offer a retry when the recording transcribed to nothing", async () => {
    installFetch("   ");
    render(<ChatPopup isOpen onClose={() => {}} />);
    await pressRecord(await readyToRecord());

    fireEvent.click(screen.getByTestId("voice-stop"));
    await screen.findByTestId("voice-status");

    // The panel really is on screen, so the absent retry below is an absence
    // in a rendered row rather than a row that never mounted.
    expect(await screen.findByTestId("voice-dismiss")).toBeTruthy();
    expect(screen.queryByTestId("voice-retry")).toBeNull();
    // And with no retry there is no second upload of the same silence.
    await waitFor(() => expect(transcribeCalls()).toBe(1));
    expect(transcribeCalls()).toBe(1);
  });
});
