import { isSentinel, isInterSessionEnvelope } from "@/lib/chat-sentinels";
import {
  isInternalRoutingMessage,
  isFailedImageGenerationNotice,
} from "@/lib/chat-internal-messages";
import {
  splitAssistantMedia,
  splitUserAttachments,
  extractAudioAttachments,
} from "@/lib/chat-media";
import {
  asHarnessError,
  HarnessError,
  type FetchLike,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessStatus,
  type HistoryMessage,
  type HistoryOptions,
  type HistoryPage,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from "./transport";

/**
 * The OpenClaw side of the transport, wrapping today's gateway RPCs 1:1.
 *
 * This file MOVES code; it does not rewrite it. Every method below is the call
 * the chat already made, with the same method name and the same parameter
 * shape, and the history projection is the one that shipped — see the comment
 * above `projectGatewayHistory` for why that matters more here than anywhere
 * else in this program.
 *
 * The socket itself — the handshake, the retry ladder, the `session.message`
 * subscription and the event stream that paints streaming replies — still
 * lives in the chat component and is reached through `GatewayLink`. That is
 * the deliberate seam of a strangler: the RPC vocabulary moves first, on its
 * own, so the diff can be reviewed as "same frames, new home" before anything
 * touches 500 lines of event handling.
 */

/** How many messages a history read asks the gateway for. */
export const HISTORY_LIMIT = 50;

/** Spoken replies kept per message. */
const MAX_AUDIO_PER_MESSAGE = 4;

/** Strip gateway wrapper tags like `<final>`, `<thinking>`, etc. */
export function stripGatewayTags(text: string): string {
  return text.replace(/<\/?(?:final|thinking|response|answer|reply)>/gi, "").trim();
}

/** Pull the text content out of a gateway message object. */
export function extractText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  if (typeof m.text === "string") return stripGatewayTags(m.text);
  if (typeof m.content === "string") return stripGatewayTags(m.content);
  if (Array.isArray(m.content)) {
    const raw = m.content
      .map((block: unknown) => {
        if (!block || typeof block !== "object") return "";
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "thinking") return "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return stripGatewayTags(raw);
  }
  return "";
}

/** De-duplicate and cap the spoken-reply refs attached to one message. */
export function boundedAudio(...groups: string[][]): string[] {
  return [...new Set(groups.flat())].slice(0, MAX_AUDIO_PER_MESSAGE);
}

/**
 * Turn a raw `chat.history` page into the transcript the chat renders.
 *
 * THE SHARPEST EDGE IN THIS PROGRAM. What looks like one function is about six
 * independent bug fixes with no unifying rule between them, each written
 * against a real customer report:
 *
 *  - sentinels are dropped;
 *  - `isInternalRoutingMessage` catches background-job results that OpenClaw
 *    routes back into the conversation as `role: "user"`, which would otherwise
 *    put a wall of internal text in the transcript attributed to the person;
 *  - `isInterSessionEnvelope` runs BEFORE `splitAssistantMedia`, so an envelope
 *    carrying a MEDIA: line is dropped whole rather than surviving as a
 *    picture;
 *  - the image-failure notice only counts if it is NEWER than the wait began,
 *    because every read returns the last 50 messages and an older failure ended
 *    the wait ~400 ms after it started;
 *  - a user image sent with no caption survives, where it used to vanish
 *    together with the answer that replied to it;
 *  - the spoken reply, stored as its own message with the same text, is folded
 *    into the preceding bubble instead of showing the answer twice.
 *
 * Re-deriving any of these is how a shipped fix reopens. It moved here byte
 * for byte and should be changed only with a customer report in hand.
 *
 * Pure — no socket, no fetch, no React — which is what lets a golden fixture
 * pin it.
 */
export function projectGatewayHistory(
  rawMessages: unknown[],
  spokenPayload: unknown,
  options?: { imageWaitFrom?: number | null },
): HistoryPage {
  const imageWaitFrom = options?.imageWaitFrom ?? null;
  const watchingImage = imageWaitFrom !== null;
  let imageGenerationFailed = false;
  const chatMsgs: HistoryMessage[] = [];
  for (const msg of rawMessages) {
    const m = msg as Record<string, unknown>;
    const role = (m.role as string)?.toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const raw = extractText(m);
    if (isSentinel(raw)) continue;
    // OpenClaw routes background-job results back into the conversation as
    // `role: "user"` messages. They are instructions to the agent, not
    // anything the person typed, and rendering them puts a wall of internal
    // text in the transcript attributed to the user.
    const timestamp = (m.timestamp as number) || 0;
    if (isInternalRoutingMessage(m, raw)) {
      // Only a notice NEWER than the wait counts. Every history read
      // returns the last 50 messages, so failures from earlier generations
      // are still in the window — treating those as this job's outcome
      // ended the wait ~400ms after it started and the banner never showed.
      // Both sides of the comparison are server timestamps, so a browser
      // clock that disagrees with the device cannot skew it.
      if (watchingImage && timestamp > imageWaitFrom && isFailedImageGenerationNotice(raw)) {
        imageGenerationFailed = true;
      }
      continue;
    }
    // Inter-session routing envelopes are machinery addressed to the agent,
    // not chat content — drop the whole message (TASK-416). Kept alongside
    // isInternalRoutingMessage rather than replacing it: that one catches
    // background-job results arriving as role:"user", this one catches the
    // generic envelope on either role, and the two were written against
    // different failure reports. Checked BEFORE splitAssistantMedia so an
    // envelope carrying a MEDIA: line is dropped whole rather than
    // surviving as a picture. Shared with ChatApp so the surfaces can't drift.
    if (isInterSessionEnvelope(raw, m)) continue;
    if (role === "user") {
      // The customer's own attachments come out first, as picture URLs
      // rather than as the `[Attached file: /abs/path]` lines the composer
      // wrote (TASK-436). The generic single-bracket strip below still runs
      // on what is left, so every OTHER leading prefix — `[System: …]` and
      // friends — is dropped exactly as before.
      const { text: withoutAttachments, images, files } = splitUserAttachments(raw);
      const stripped = withoutAttachments.replace(/^\[[^\]]+\]\s*/, "");
      // Non-image attachments are re-labelled the way the live composer
      // labels them, so the bubble a customer sees before and after a
      // refresh is the same bubble rather than two different ones.
      const cleaned = [files.map((name) => `📎 ${name}`).join("\n"), stripped]
        .filter(Boolean)
        .join("\n");
      // An image sent with no caption used to disappear from history
      // entirely, because nothing survived the strip and this `continue`
      // took the whole turn with it — leaving the answer replying to a
      // question that was not there.
      if (!cleaned && images.length === 0) continue;
      const idempotencyKey = typeof m.idempotencyKey === "string" ? m.idempotencyKey : undefined;
      chatMsgs.push({ role: "user", text: cleaned, timestamp, idempotencyKey, images });
      continue;
    }
    // Replayed history carries the same MEDIA: lines the live turn did, so
    // a reopened chat shows its pictures rather than a bare caption.
    const { text, images, audio: directiveAudio } = splitAssistantMedia(raw);
    const audio = boundedAudio(extractAudioAttachments(m), directiveAudio);
    if (!text && images.length === 0 && audio.length === 0) continue;
    // Replayed history repeats the live path's two-message shape: the
    // spoken reply is stored as its own message carrying the same text.
    // Folded into the preceding bubble so a reopened chat shows one answer
    // with a player rather than the answer twice.
    const previous = chatMsgs[chatMsgs.length - 1];
    if (
      text.length > 0 &&
      audio.length > 0 &&
      images.length === 0 &&
      previous &&
      previous.role === "assistant" &&
      previous.text === text &&
      (previous.audio?.length ?? 0) === 0
    ) {
      previous.audio = audio;
      continue;
    }
    chatMsgs.push({ role: "assistant", text, timestamp, images, audio });
  }
  // Current OpenClaw merges TTS supplement records into chat.history, but
  // older supported gateways do not. The session-gated device route reads
  // the canonical transcript and returns only target timestamp + playable
  // URLs, which makes this survive a fresh browser and a full reboot.
  const durableAudio = new Map<number, string[]>();
  const spokenItems =
    spokenPayload && typeof spokenPayload === "object"
      ? (spokenPayload as { items?: unknown }).items
      : null;
  if (Array.isArray(spokenItems)) {
    for (const item of spokenItems) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as { targetTimestamp?: unknown; audio?: unknown };
      if (
        typeof candidate.targetTimestamp !== "number" ||
        !Number.isFinite(candidate.targetTimestamp) ||
        !Array.isArray(candidate.audio)
      )
        continue;
      const audio = boundedAudio(
        candidate.audio.filter(
          (src): src is string => typeof src === "string" && src.length > 0 && src.length <= 4096,
        ),
      );
      if (audio.length) durableAudio.set(candidate.targetTimestamp, audio);
    }
  }
  for (let i = 0; i < chatMsgs.length; i++) {
    const message = chatMsgs[i];
    if (message.role !== "assistant" || message.audio?.length || message.timestamp <= 0) continue;
    const audio = durableAudio.get(message.timestamp);
    if (audio) chatMsgs[i] = { ...message, audio };
  }
  return { messages: chatMsgs, imageGenerationFailed };
}

/**
 * The socket, as the adapter needs to see it.
 *
 * Narrow on purpose: an adapter that could reach the WebSocket object would
 * grow socket lifecycle logic, and the whole value of this step is that the
 * lifecycle stays exactly where it already works.
 */
export interface GatewayLink {
  /** One RPC. Rejects when the socket is not open. */
  request(method: string, params: unknown): Promise<unknown>;
  /** The gateway session key this chat is bound to, or `''` before the hello. */
  sessionKey(): string;
  /** Open the socket, running the handshake and retry ladder. */
  open(): Promise<void>;
  /** Close it and drop any pending requests. */
  close(): void;
  /** Report status changes to a listener; returns the unsubscribe. */
  onStatus(cb: (status: HarnessStatus, detail?: string) => void): () => void;
}

/** Turn a gateway rejection into the shared error vocabulary. */
function gatewayError(err: unknown): HarnessError {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/not connected/i.test(message)) return new HarnessError("not-connected", message, err);
  if (/timeout/i.test(message)) return new HarnessError("timeout", message, err);
  return asHarnessError(err, "upstream");
}

export class OpenClawGatewayAdapter implements HarnessAdapter {
  readonly id = "openclaw" as const;

  constructor(
    readonly capabilities: HarnessCapabilities,
    private readonly link: GatewayLink,
    /** Injected so tests and jsdom both get the fetch they expect. Typed as
     *  the call this uses rather than as `typeof fetch`, whose runtime-specific
     *  extras (Bun adds `preconnect`) a test double has no business providing. */
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  connect(): Promise<void> {
    return this.link.open();
  }

  disconnect(): void {
    this.link.close();
  }

  onStatus(cb: (status: HarnessStatus, detail?: string) => void): () => void {
    return this.link.onStatus(cb);
  }

  /**
   * The gateway ACKNOWLEDGES a turn and answers it on the event stream, so
   * this resolves with no text. `acknowledgedOnly` says so out loud rather
   * than leaving a caller to infer it from an empty string, which is exactly
   * the kind of inference that later renders "(no response)" over a reply that
   * was on its way.
   */
  async sendTurn(req: TurnRequest, _onEvent?: (event: TurnEvent) => void): Promise<TurnResult> {
    void _onEvent;
    let messageText = req.text;
    if (req.attachments.length > 0) {
      const filePaths = req.attachments.map((a) => `[Attached file: ${a.path}]`).join("\n");
      messageText = [filePaths, req.text].filter(Boolean).join("\n");
    }
    try {
      await this.link.request("chat.send", {
        sessionKey: this.link.sessionKey(),
        message: messageText || "(file attached)",
        deliver: false,
        idempotencyKey: req.idempotencyKey,
      });
    } catch (err) {
      throw gatewayError(err);
    }
    return { text: "", acknowledgedOnly: true };
  }

  /**
   * Best-effort, as it has always been: a Stop that cannot be delivered leaves
   * the run to finish on its own, and a red banner about the Stop button would
   * tell the customer nothing they can act on.
   */
  async abortTurn(): Promise<void> {
    try {
      await this.link.request("chat.abort", { sessionKey: this.link.sessionKey() });
    } catch {
      // Nothing to abort, or the socket went away first.
    }
  }

  /**
   * Throws on failure, deliberately. The caller keeps the transcript on screen
   * and says why — blanking the view on a failed reset is the worst outcome:
   * the agent still holds the thread but the user believes it is gone.
   */
  async resetSession(): Promise<void> {
    try {
      await this.link.request("sessions.reset", {
        key: this.link.sessionKey(),
        reason: "new",
      });
    } catch (err) {
      throw gatewayError(err);
    }
  }

  async loadHistory(options?: HistoryOptions): Promise<HistoryPage> {
    let result: Record<string, unknown>;
    let spokenPayload: unknown;
    try {
      [result, spokenPayload] = await Promise.all([
        this.link.request("chat.history", {
          sessionKey: this.link.sessionKey(),
          limit: options?.limit ?? HISTORY_LIMIT,
        }) as Promise<Record<string, unknown>>,
        this.fetchImpl("/setup-api/chat/spoken-history", { cache: "no-store" })
          .then(async (response) => (response.ok ? response.json() : { items: [] }))
          .catch(() => ({ items: [] })),
      ]);
    } catch (err) {
      throw gatewayError(err);
    }
    const msgs = (result.messages as unknown[]) || [];
    return projectGatewayHistory(msgs, spokenPayload, { imageWaitFrom: options?.imageWaitFrom });
  }

  async patchSessionDefaults(patch: { thinkingLevel?: string | null }): Promise<void> {
    try {
      await this.link.request("sessions.patch", {
        key: this.link.sessionKey(),
        thinkingLevel: patch.thinkingLevel,
      });
    } catch (err) {
      throw gatewayError(err);
    }
  }
}
