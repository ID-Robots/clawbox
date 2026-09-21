import { describe, expect, it } from "vitest";
import {
  MAX_RECORDING_MS,
  RECORDING_MIME_CANDIDATES,
  classifyCaptureAvailability,
  classifyCaptureError,
  describeTranscribeFailure,
  formatRecordingClock,
  mergeTranscript,
  pickRecordingMimeType,
  recordingFileName,
} from "@/lib/chat-voice-input";

// The logic behind the microphone button in the mascot chat composer. TASK-381.

describe("mergeTranscript", () => {
  it("keeps text the user already typed", () => {
    // There is no undo in a chat composer: replacing the box would destroy
    // half a typed sentence with no way to get it back.
    expect(mergeTranscript("Remind me to", "call the supplier at four")).toBe(
      "Remind me to call the supplier at four",
    );
  });

  it("uses the transcript alone when nothing was typed", () => {
    expect(mergeTranscript("", "hello there")).toBe("hello there");
  });

  it("does not leave a double space where the typed text ended", () => {
    expect(mergeTranscript("Remind me to ", "call")).toBe("Remind me to call");
  });

  it("leaves the box untouched when nothing was heard", () => {
    expect(mergeTranscript("half a sentence", "   ")).toBe("half a sentence");
  });
});

describe("describeTranscribeFailure", () => {
  it("passes through a message written for a person", () => {
    expect(describeTranscribeFailure({ error: "The recording is too long" }))
      .toBe("The recording is too long");
  });

  it("refuses a message carrying an absolute path", () => {
    // Errors are the classic way internals reach a customer's screen.
    expect(describeTranscribeFailure({ error: "ENOENT: /home/clawbox/.openclaw/tmp/x.webm" })).toBeNull();
  });

  it("refuses a message carrying a URL", () => {
    expect(describeTranscribeFailure({ error: "POST https://clawbox.com/api/ai/audio/transcriptions failed" })).toBeNull();
  });

  it("refuses a message carrying anything token-shaped", () => {
    expect(describeTranscribeFailure({ error: "Bearer claw_abc123 was rejected" })).toBeNull();
    expect(describeTranscribeFailure({ error: "key sk-livekey is invalid" })).toBeNull();
  });

  it("refuses a stack frame", () => {
    expect(describeTranscribeFailure({ error: "TypeError\n    at POST (route.ts:12)" })).toBeNull();
  });

  it("returns null for anything that is not a message at all", () => {
    expect(describeTranscribeFailure(null)).toBeNull();
    expect(describeTranscribeFailure({})).toBeNull();
    expect(describeTranscribeFailure({ error: 42 })).toBeNull();
    expect(describeTranscribeFailure({ error: "  " })).toBeNull();
  });
});

describe("pickRecordingMimeType", () => {
  it("prefers WebM/Opus, which the proxy takes without re-encoding", () => {
    // Verified against the live ClawBox AI endpoint on 2026-08-21: it accepts
    // exactly what Chrome's MediaRecorder produces, so the box converts nothing.
    expect(pickRecordingMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to a format the browser does support", () => {
    // Safari has no WebM at all and answers with MP4/AAC.
    expect(pickRecordingMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("lets the browser choose when it supports none of the candidates", () => {
    expect(pickRecordingMimeType(() => false)).toBe("");
  });

  it("keeps looking when a browser throws instead of answering", () => {
    expect(pickRecordingMimeType((type) => {
      if (type.includes("webm")) throw new Error("not a type I know");
      return type === "audio/mp4";
    })).toBe("audio/mp4");
  });

  it("offers WebM before the others, since that is the box's own browser", () => {
    expect(RECORDING_MIME_CANDIDATES[0]).toContain("webm");
  });
});

describe("recordingFileName", () => {
  it("matches the extension to the container the proxy will sniff", () => {
    expect(recordingFileName("audio/webm;codecs=opus")).toBe("recording.webm");
    expect(recordingFileName("audio/mp4")).toBe("recording.mp4");
    expect(recordingFileName("audio/ogg;codecs=opus")).toBe("recording.ogg");
  });

  it("defaults to webm when the browser named no type", () => {
    expect(recordingFileName("")).toBe("recording.webm");
  });
});

describe("classifyCaptureError", () => {
  it("calls a refused permission a permission problem", () => {
    // The user's next step is the browser's site settings.
    const err = new Error("denied");
    err.name = "NotAllowedError";
    expect(classifyCaptureError(err)).toBe("permission");
  });

  it("treats an insecure-context refusal as a permission problem too", () => {
    const err = new Error("insecure");
    err.name = "SecurityError";
    expect(classifyCaptureError(err)).toBe("permission");
  });

  it("calls a missing device unsupported", () => {
    // Different advice entirely: plug a microphone in.
    const err = new Error("no device");
    err.name = "NotFoundError";
    expect(classifyCaptureError(err)).toBe("unsupported");
  });

  it("does not throw on something that is not an Error", () => {
    expect(classifyCaptureError("nope")).toBe("unsupported");
  });
});

describe("formatRecordingClock", () => {
  it("counts seconds, then minutes", () => {
    expect(formatRecordingClock(0)).toBe("0:00");
    expect(formatRecordingClock(4_200)).toBe("0:04");
    expect(formatRecordingClock(65_000)).toBe("1:05");
    expect(formatRecordingClock(600_000)).toBe("10:00");
  });

  it("never renders a negative clock from a jumped system time", () => {
    expect(formatRecordingClock(-5_000)).toBe("0:00");
  });
});

describe("MAX_RECORDING_MS", () => {
  it("cuts a capture off at ten minutes", () => {
    // Pinned to the number, because the tests that exercise the deadline
    // import this constant and would stay green at any value at all — a zero
    // would end every capture the instant it started and none of them would
    // notice. The value is a compromise between two failures: ten minutes of
    // Opus at the bitrate MediaRecorder picks is around a tenth of the route's
    // 25 MB ceiling, far enough under it that no browser's default can upload
    // its way into a 413, and long enough that no dictation a person actually
    // speaks gets cut off mid-sentence.
    expect(MAX_RECORDING_MS).toBe(10 * 60 * 1000);
  });
});

describe("classifyCaptureAvailability", () => {
  // TASK-470. `http://<ip>/` and `http://clawbox.local/` — the ordinary way a
  // customer reaches their box on the LAN — are not secure contexts, so the
  // browser deletes `navigator.mediaDevices` outright. Telling that owner
  // "this browser cannot record audio" sends them to check a browser that is
  // working perfectly, and no permission they grant can ever help.
  it("blames the insecure origin when the capture API is missing there", () => {
    expect(classifyCaptureAvailability({
      secureContext: false,
      hasMediaDevices: false,
      hasMediaRecorder: true,
    })).toBe("insecure");
  });

  it("still blames the browser when a SECURE origin has no capture API", () => {
    // Same missing API, different cause: on https or localhost the origin is
    // not the problem, so the old message is the honest one.
    expect(classifyCaptureAvailability({
      secureContext: true,
      hasMediaDevices: false,
      hasMediaRecorder: true,
    })).toBe("unsupported");
  });

  it("reports unsupported when MediaRecorder is missing on a secure origin", () => {
    expect(classifyCaptureAvailability({
      secureContext: true,
      hasMediaDevices: true,
      hasMediaRecorder: false,
    })).toBe("unsupported");
  });

  it("allows capture when the browser has both halves", () => {
    expect(classifyCaptureAvailability({
      secureContext: true,
      hasMediaDevices: true,
      hasMediaRecorder: true,
    })).toBe("ok");
  });

  it("does not refuse a working insecure-origin browser it cannot explain", () => {
    // Belt and braces: if a browser ever DID expose capture on an insecure
    // origin, the availability check must not be what takes it away.
    expect(classifyCaptureAvailability({
      secureContext: false,
      hasMediaDevices: true,
      hasMediaRecorder: true,
    })).toBe("ok");
  });
});
