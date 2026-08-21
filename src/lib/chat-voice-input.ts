// -- Voice input state machine ---------------------------------------------
//
// The logic behind the microphone button in the mascot chat composer, kept out
// of the component so it can be tested without rendering a browser.
//
// The states are what the user is told, and every one of them is reachable
// from the UI: no state exists that the composer cannot render, and no
// transition happens that the composer cannot show. That matters most for
// `recording` — a microphone that is live while the interface looks idle is
// the one outcome this must never produce, so releasing the capture is tied to
// leaving the state rather than to any particular button.

export type VoiceState =
  /** Nothing is happening; the mic button is offered. */
  | "idle"
  /** Permission has been asked for and not yet granted or refused. */
  | "requesting"
  /** The microphone is live and capturing. */
  | "recording"
  /** Capture is finished and the audio is at the box being transcribed. */
  | "transcribing"
  /** Something went wrong; `error` says what, and retry may be possible. */
  | "error";

export type VoiceError =
  /** The browser or the user refused the microphone. */
  | "permission"
  /** No capture device, or the browser has no MediaRecorder at all. */
  | "unsupported"
  /** The recording never captured any audio. */
  | "empty"
  /** The box or the proxy failed. Retryable — the audio still exists. */
  | "transcribe";

export type VoiceStatus = {
  state: VoiceState;
  error: VoiceError | null;
  /** Human-readable detail from the failing layer, when there is one. */
  message: string | null;
  /** Whether a failed attempt can be retried without recording again. */
  canRetry: boolean;
};

export const IDLE_STATUS: VoiceStatus = { state: "idle", error: null, message: null, canRetry: false };

/**
 * The transcript, merged into whatever the user had already typed.
 *
 * Dictation is additive: someone who typed half a sentence and then spoke the
 * rest should end up with both. Replacing the box would silently destroy typed
 * text, and there is no undo in a chat composer.
 */
export function mergeTranscript(existing: string, transcript: string): string {
  const spoken = transcript.trim();
  if (!spoken) return existing;
  const typed = existing.trimEnd();
  if (!typed) return spoken;
  return `${typed} ${spoken}`;
}

/**
 * Turn a failed transcription response into something worth showing.
 *
 * The route already writes messages meant for a person, so the useful ones are
 * passed through. What must never reach the surface is the fallback: a raw
 * exception, a stack, or a URL with a token in it. When there is no vetted
 * message, the caller gets null and shows its own generic line.
 */
export function describeTranscribeFailure(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "string") return null;
  const trimmed = error.trim();
  if (!trimmed) return null;
  // Anything that looks like a path, a URL, a bearer token or a stack frame is
  // a leak, not a message. Errors are the classic way internals escape into a
  // customer's screen, so this is a whitelist by shape rather than a blocklist
  // of known-bad strings.
  if (/(^|\s)\/[\w.-]+\//.test(trimmed)) return null;
  if (/https?:\/\//i.test(trimmed)) return null;
  if (/\b(claw_|sk-|Bearer\s)/i.test(trimmed)) return null;
  if (/\bat\s+\w+\s+\(/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Pick the recording format.
 *
 * Chrome on the ClawBox produces WebM/Opus, which the ClawBox AI proxy accepts
 * as-is — verified against the live endpoint on 2026-08-21 — so the default
 * path re-encodes nothing. The list exists for the other browsers someone might
 * open the box's UI from: Safari has no WebM and answers with MP4/AAC. An empty
 * string means "let the browser choose", which is always valid.
 */
export const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

export function pickRecordingMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string {
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    try {
      if (isSupported(candidate)) return candidate;
    } catch {
      // A browser that throws from isTypeSupported is telling us it does not
      // know the type. Keep looking rather than failing the whole recording.
    }
  }
  return "";
}

/** The file extension that matches a recording's MIME type. */
export function recordingFileName(mimeType: string): string {
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

/**
 * Classify why `getUserMedia` refused.
 *
 * The distinction is the user's next action: a permission problem is fixed in
 * the browser's site settings, while a missing device means plugging one in.
 * Telling them the wrong one wastes their time.
 */
export function classifyCaptureError(err: unknown): VoiceError {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission";
  return "unsupported";
}

/**
 * Elapsed recording time as `m:ss`.
 *
 * Shown next to a live indicator so a capture always says how long it has been
 * running — the difference between "it is recording" and "it has been
 * recording for four minutes and I forgot".
 */
export function formatRecordingClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
