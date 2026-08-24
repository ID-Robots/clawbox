import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { MAX_RECORDING_MS } from "@/lib/chat-voice-input";

/**
 * What a capture must not do to the person holding the microphone.
 *
 * It must not run forever: nothing in the browser bounds a `MediaRecorder`, and
 * the transcribe route only learns a blob is oversized after the whole upload
 * has gone up, so an unbounded recording is paid for twice — once in the wait,
 * once in the lost dictation.
 *
 * It must not come back after it has been cancelled: `stop()` ends the capture
 * before it hands over the audio, and the ten-minute deadline is still armed in
 * that gap. Audio the user threw away must not be uploaded and paid for by a
 * timer that fired a moment too late.
 *
 * It must not offer to re-send audio that already came back empty: the call
 * succeeded, so the same bytes buy the same silence and one more paid
 * transcription.
 *
 * And it must not shout. The status row is a live region because it is the only
 * way a screen reader learns the microphone opened — but a live region is
 * announced whole, so a running clock inside it is read out every second for as
 * long as the capture lasts.
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

/**
 * @param transcripts what the transcribe route answers with, one entry per
 *   upload: a string is a transcript, `null` a server failure — the one kind
 *   of error that leaves the audio worth sending again. The last entry answers
 *   every further call, so a single argument means "always this".
 */
function installFetch(...transcripts: (string | null | Promise<string>)[]) {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("/setup-api/gateway/ws-config")) {
        return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/capabilities")) {
        // A LINKED box. The microphone follows the ClawBox AI credential on
        // both editions now — the route behind it answers 503 without one — so
        // a box that holds no token offers no button, and every case in this
        // file is about what happens once the button has been pressed.
        return {
          ok: true,
          json: async () => ({
            harness: "openclaw",
            facts: { hasClawaiToken: true, hermesSupportsImages: false },
          }),
        };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/chat/transcribe")) {
        const configured = transcripts[Math.min(calls++, transcripts.length - 1)];
        const signal = init?.signal;
        const aborted = new Promise<never>((_, reject) => {
          if (!signal) return;
          const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener("abort", rejectAbort, { once: true });
        });
        const answer = await Promise.race([Promise.resolve(configured), aborted]);
        if (answer === null) return { ok: false, status: 500, json: async () => ({ error: "the box is busy" }) };
        return { ok: true, json: async () => ({ ok: true, text: answer }) };
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
 * A microphone whose permission prompt stays open until the test answers it.
 *
 * The real gap this reproduces: `getUserMedia` resolves in a later task than
 * the click, and until it does there is no stream for any cleanup to stop.
 * Returns the resolver so a test can close or unmount the panel first and then
 * hand the stream over, which is exactly the order a slow prompt produces.
 */
function installPendingMedia(): { grant: () => void } {
  let release!: () => void;
  const answered = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        await answered;
        return { getTracks: () => [{ stop: micTrackStop }] };
      },
    },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
  return { grant: () => release() };
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
    // Ended the same way the stop button ends it, so the words still arrive
    // and are sent through the real chat turn (Telegram-like voice flow).
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(sentFrames.some(frame => {
      if (frame.method !== "chat.send") return false;
      const params = frame.params as { message?: unknown } | undefined;
      return params?.message === "hello";
    })).toBe(true));
    expect((textarea as HTMLTextAreaElement).value).toBe("");
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
    const readings = new Set<string>();
    for (let elapsed = 0; elapsed < RENDER_CHURN_MS; elapsed += 200) {
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      readings.add(screen.getByTestId("voice-clock").textContent ?? "");
    }
    // The renders really happened, so the jump below is a real test of the
    // deadline's arming rather than of an inert component. Counted as distinct
    // readings rather than asserted as one exact time: `shouldAdvanceTime` also
    // moves the mocked clock with real wall time, so whatever the clock ends on
    // depends on how fast the machine ran and any single value would flake in
    // CI. Thirty simulated seconds cannot show fewer than thirty different
    // readings — drift only ever adds seconds, never takes them away — so the
    // bound holds on any machine and still fails on a component that stopped
    // re-rendering.
    expect(readings.size).toBeGreaterThanOrEqual(30);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS - RENDER_CHURN_MS);
    });

    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it("does not transcribe a capture the user cancelled a moment before the cap", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} />);
    const record = await readyToRecord();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recorder = await pressRecord(record);

    // A spec-accurate stop, which the shared fake is not: `stop()` goes
    // inactive at once and queues `dataavailable`/`stop` as a task. That queue
    // is the whole race — until it drains the composer still believes it is
    // recording, so the deadline is still armed over a capture that is already
    // over and already cancelled. `deliver` drains it on the test's word.
    let deliver = () => {};
    recorder.stop = vi.fn(() => {
      recorder.state = "inactive";
      deliver = () => {
        recorder.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: recorder.mimeType }) });
        recorder.onstop?.();
      };
    });

    fireEvent.click(screen.getByTestId("voice-cancel"));
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS); });
    await act(async () => { deliver(); });

    // The user threw this audio away. Uploading it anyway is a transcription
    // they did not ask for and are billed for.
    expect(transcribeCalls()).toBe(0);
  });

  it("keeps the running clock out of what the live region announces", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} />);
    await pressRecord(await readyToRecord());

    const clock = await screen.findByTestId("voice-clock");
    // The row is `role="status"`, which is atomic: everything left inside it is
    // re-read in full on any change within it, and this changes five times a
    // second for up to ten minutes.
    expect(clock).toHaveAttribute("aria-hidden", "true");
    // Hidden from assistive tech only. On screen the line reads exactly as it
    // did before the clock was split out of it — label, one space, elapsed
    // time. (No I18nProvider here, so `t` hands back the key; the shape of the
    // line is what this pins.)
    expect(clock.parentElement?.textContent).toBe(`chat.voice.recording ${clock.textContent}`);
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

  it("holds no audio to re-upload once a transcript has come back empty", async () => {
    // The first upload fails, which is the one outcome that DOES offer the
    // recording again — so the retry below is proof that the audio was being
    // held and was re-uploadable. That retry comes back empty, and from there
    // the composer must be holding nothing that can be sent a third time.
    installFetch(null, "");
    render(<ChatPopup isOpen onClose={() => {}} />);
    await pressRecord(await readyToRecord());

    fireEvent.click(screen.getByTestId("voice-stop"));
    fireEvent.click(await screen.findByTestId("voice-retry"));
    await waitFor(() => expect(transcribeCalls()).toBe(2));

    expect(await screen.findByTestId("voice-dismiss")).toBeTruthy();
    expect(screen.queryByTestId("voice-retry")).toBeNull();

    fireEvent.click(screen.getByTestId("voice-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("voice-status")).toBeNull());
    expect(transcribeCalls()).toBe(2);
  });

  it("throws away the audio a failed recorder produced instead of paying to transcribe it", async () => {
    // `error` is not the last event a MediaRecorder sends. It still delivers
    // `dataavailable` and `stop` afterwards, and the stop handler's whole job
    // is to upload. Left attached it would take the partial audio from a
    // capture the browser had just declared failed, send it, and replace the
    // error the user is reading with a transcribing spinner.
    installFetch("should never be transcribed");
    render(<ChatPopup isOpen onClose={() => {}} />);
    const recorder = await pressRecord(await readyToRecord());

    act(() => { recorder.onerror?.(); });
    // The real sequence: the recorder goes on to deliver its audio and stop.
    act(() => { recorder.stop(); });

    await waitFor(() => expect(screen.getByTestId("voice-status").textContent).toBeTruthy());
    expect(transcribeCalls()).toBe(0);
    // And nothing is held that a retry could send either.
    expect(screen.queryByTestId("voice-retry")).toBeNull();
    expect(micTrackStop).toHaveBeenCalled();
  });

  it("stops a microphone that arrives after the panel has closed", async () => {
    // The window nothing else covers: between the click and the permission
    // being answered there is no stream, so the close handler has nothing to
    // stop. If the resolver simply records with whatever it is handed, closing
    // the panel mid-prompt leaves a live microphone behind an interface that
    // is no longer on screen — with the pulsing dot and the clock gone with it.
    const mic = installPendingMedia();
    installFetch("hello");
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
    const record = await readyToRecord();
    fireEvent.click(record);
    await screen.findByTestId("voice-status");

    rerender(<ChatPopup isOpen={false} onClose={() => {}} />);
    await act(async () => { mic.grant(); await Promise.resolve(); });

    await waitFor(() => expect(micTrackStop).toHaveBeenCalled());
    // Handed back, stopped, and never recorded with.
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(transcribeCalls()).toBe(0);
  });

  it("shows no error for a permission denied after the panel closed", async () => {
    // The other half of the same window: a prompt still open when the panel
    // closes can be DENIED afterwards. An error pinned to a panel nobody is
    // looking at waits there for the next time it opens, describing a request
    // that is no longer anyone's.
    let refuse!: () => void;
    const answered = new Promise<void>((_, reject) => { refuse = () => reject(new DOMException("Permission denied", "NotAllowedError")); });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => { await answered; return null; } },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    installFetch("hello");
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
    fireEvent.click(await readyToRecord());
    await screen.findByTestId("voice-status");

    rerender(<ChatPopup isOpen={false} onClose={() => {}} />);
    await act(async () => { refuse(); await Promise.resolve(); });

    rerender(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId("voice-status")).toBeNull());
  });

  it("stops a microphone that arrives after the component has unmounted", async () => {
    const mic = installPendingMedia();
    installFetch("hello");
    const { unmount } = render(<ChatPopup isOpen onClose={() => {}} />);
    fireEvent.click(await readyToRecord());
    await screen.findByTestId("voice-status");

    unmount();
    await act(async () => { mic.grant(); await Promise.resolve(); });

    await waitFor(() => expect(micTrackStop).toHaveBeenCalled());
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(transcribeCalls()).toBe(0);
  });

  it("does not transcribe an active recording after the component unmounts", async () => {
    installFetch("should never be sent");
    const { unmount } = render(<ChatPopup isOpen onClose={() => {}} />);
    const recorder = await pressRecord(await readyToRecord());

    unmount();

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(micTrackStop).toHaveBeenCalled();
    expect(transcribeCalls()).toBe(0);
  });

  it("releases the microphone when MediaRecorder.start throws", async () => {
    class StartFailureRecorder extends FakeMediaRecorder {
      override start() { throw new DOMException("unsupported", "NotSupportedError"); }
    }
    vi.stubGlobal("MediaRecorder", StartFailureRecorder as unknown as typeof MediaRecorder);
    installFetch("should never be sent");
    render(<ChatPopup isOpen onClose={() => {}} />);

    fireEvent.click(await readyToRecord());

    await waitFor(() => expect(screen.getByTestId("voice-status")).toBeTruthy());
    expect(micTrackStop).toHaveBeenCalled();
    expect(transcribeCalls()).toBe(0);
    expect(screen.queryByTestId("voice-stop")).toBeNull();
  });

  it("does not send a transcript that finishes after the chat unmounts", async () => {
    let finish!: (text: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    installFetch(pending);
    const { unmount } = render(<ChatPopup isOpen onClose={() => {}} />);
    await pressRecord(await readyToRecord());
    fireEvent.click(screen.getByTestId("voice-stop"));
    await waitFor(() => expect(transcribeCalls()).toBe(1));

    unmount();
    await act(async () => { finish("late invisible message"); await Promise.resolve(); });

    expect(sentFrames.some(frame => {
      if (frame.method !== "chat.send") return false;
      return (frame.params as { message?: unknown } | undefined)?.message === "late invisible message";
    })).toBe(false);
  });

  it("turns a stalled transcription upload into a retryable timeout", async () => {
    installFetch(new Promise<string>(() => {}));
    render(<ChatPopup isOpen onClose={() => {}} />);
    await pressRecord(await readyToRecord());
    const sendsBefore = sentFrames.filter(frame => frame.method === "chat.send").length;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByTestId("voice-stop"));
    await waitFor(() => expect(transcribeCalls()).toBe(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });

    expect(await screen.findByTestId("voice-retry")).toBeTruthy();
    expect(transcribeCalls()).toBe(1);
    expect(sentFrames.filter(frame => frame.method === "chat.send")).toHaveLength(sendsBefore);
  });

  it("sends only the recording and preserves a draft typed while transcription is pending", async () => {
    let finish!: (text: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    installFetch(pending);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await pressRecord(await readyToRecord());
    fireEvent.click(screen.getByTestId("voice-stop"));
    await waitFor(() => expect(transcribeCalls()).toBe(1));

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft for later" } });
    await act(async () => { finish("recorded voice turn"); await Promise.resolve(); });

    await waitFor(() => expect(sentFrames.some(frame => {
      if (frame.method !== "chat.send") return false;
      return (frame.params as { message?: unknown } | undefined)?.message === "recorded voice turn";
    })).toBe(true));
    expect(sentFrames.some(frame => {
      if (frame.method !== "chat.send") return false;
      return String((frame.params as { message?: unknown } | undefined)?.message).includes("draft for later");
    })).toBe(false);
    expect(textarea.value).toBe("draft for later");
  });
});
