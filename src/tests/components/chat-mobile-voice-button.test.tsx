import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// A jsdom mount of `ChatPopup` — the fake gateway handshake, the model seed,
// the transcript — costs seconds under a full parallel run, and a case does it
// once and then waits on several sub-5 s `waitFor`s in series. Every component
// suite that mounts it declares both ceilings; `test-timeout-hygiene.test.ts`
// is the rule, and says there why 5 s is the wrong budget here and 30 s still
// fails a test that has genuinely hung.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


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

/**
 * The phone chat's microphone.
 *
 * On a phone the chat is where the page lands, and voice is often the whole
 * interaction — the owner talks to the box while driving. So there the
 * microphone is a 72px round button beside the text box instead of a 36px
 * icon among the composer's row, with a recording state that reads at a
 * glance. The desktop keeps its compact button; both run the same handlers.
 */
// No I18nProvider is mounted here, so labels read as their catalogue keys.
describe("the phone chat's microphone", () => {
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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("is the touch microphone beside the text box on a phone", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} mobile />);
    const record = await readyToRecord();

    expect(record).toHaveAttribute("data-size", "large");
    expect(record).toHaveClass("chat-voice-large");
    // Out of the crowded button row, beside the text box.
    expect(screen.getByTestId("chat-composer-row")).not.toContainElement(record);
    expect(record.parentElement).toContainElement(screen.getByRole("textbox"));
    // Exactly one microphone — the compact one is not drawn as well.
    expect(screen.getAllByTestId("voice-record")).toHaveLength(1);
  });

  it("swaps the idle microphone for Send while typing and restores it when cleared", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} mobile />);
    await readyToRecord();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "A typed question" } });
    expect(screen.queryByTestId("voice-record")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-send")).toBeEnabled();
    expect(input.parentElement).toContainElement(screen.getByTestId("chat-send"));
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByTestId("voice-record")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-send")).not.toBeInTheDocument();
  });

  it("does not hide the recording stop action when text is entered", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} mobile />);
    fireEvent.click(await readyToRecord());
    await screen.findByTestId("voice-stop");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft during capture" } });
    expect(screen.getByTestId("voice-stop")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-send")).not.toBeInTheDocument();
  });

  it("turns into the large stop button while it records, and records through the same flow", async () => {
    installFetch("hello from the car");
    render(<ChatPopup isOpen onClose={() => {}} mobile />);
    const record = await readyToRecord();

    fireEvent.click(record);
    const stop = await screen.findByTestId("voice-stop");
    expect(stop).toHaveAttribute("data-size", "large");
    expect(stop).toHaveClass("chat-voice-large--recording");
    expect(stop).toHaveAccessibleName("chat.voice.stop");
    expect(screen.getByTestId("voice-status")).toBeInTheDocument();

    fireEvent.click(stop);
    await waitFor(() => expect(sentFrames.some(frame => {
      if (frame.method !== "chat.send") return false;
      const params = frame.params as { message?: unknown } | undefined;
      return params?.message === "hello from the car";
    })).toBe(true));
    expect(await screen.findByTestId("voice-record")).toHaveAttribute("data-size", "large");
  });

  it("keeps the compact button in the composer row on a big screen", async () => {
    installFetch("hello");
    render(<ChatPopup isOpen onClose={() => {}} />);
    const record = await readyToRecord();

    expect(record).toHaveAttribute("data-size", "compact");
    expect(record).not.toHaveClass("chat-voice-large");
    expect(screen.getByTestId("chat-composer-row")).toContainElement(record);
  });

  it("offers a labelled way to the desktop on a phone, and a plain close on a big screen", async () => {
    installFetch("hello");
    const onClose = vi.fn();
    const { unmount } = render(<ChatPopup isOpen onClose={onClose} mobile />);
    const toDesktop = screen.getByTestId("chat-popup-close");
    expect(toDesktop).toHaveAccessibleName("chat.showDesktop");
    expect(toDesktop).toHaveTextContent("chat.desktop");
    fireEvent.click(toDesktop);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    render(<ChatPopup isOpen onClose={() => {}} />);
    expect(screen.getByTestId("chat-popup-close")).toHaveAccessibleName("window.close");
  });
});
