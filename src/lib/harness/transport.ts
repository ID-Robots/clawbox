import type { ChatMessage, ChatToolSummary } from "@/lib/chat-history-cache";

/**
 * The one contract the chat surface talks to.
 *
 * Pure types plus one error class. No React, no `ws`, no `fs`, so this file
 * imports cleanly into client components, server routes and vitest alike.
 *
 * The point of this module is the owner's rule: a chat feature is written ONCE
 * and both editions get it, or it is honestly absent on one of them and says
 * so. Two implementations of the same feature, or an `if (harness ===
 * 'hermes')` sprinkled through a 4000-line component, are the failure mode
 * this replaces.
 */

/** Which agent runtime is answering. */
export type HarnessId = "openclaw" | "hermes";

/**
 * The one call an adapter makes of `fetch`.
 *
 * Narrower than `typeof fetch` on purpose: runtimes bolt extras onto the global
 * (Bun adds `preconnect`), and a test double has no business implementing them
 * to stand in for a plain request.
 *
 * The parameters are DERIVED from the ambient `fetch` rather than written as
 * `RequestInfo | URL`: this module is in the MCP server's import graph, which
 * typechecks without the DOM lib (mcp/tsconfig.json), and `RequestInfo` is a
 * DOM name. Deriving them resolves in both projects and cannot drift from
 * whichever fetch the runtime declares.
 */
export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

/**
 * Capabilities as DATA.
 *
 * The ONLY thing UI is allowed to branch on. Every flag names a user-visible
 * affordance — a button, a banner, a control — never a transport detail. A
 * component that wants to know "is this Hermes?" is almost always asking the
 * wrong question; the right one is "can this box do the thing this button
 * promises?", and the answer can differ between two boxes of the SAME edition
 * (a Hermes device with no ClawBox AI credential genuinely cannot transcribe).
 *
 * The one exception, which is identity and not capability, is the model and
 * provider picker: it renders a different VENDOR'S catalogue, which is a
 * product fact rather than something a box can or cannot do.
 */
export interface HarnessCapabilities {
  /** Replies arrive token-by-token rather than whole. */
  readonly streamsTurns: boolean;
  /** The transcript survives a page refresh. */
  readonly canListHistory: boolean;
  /** "New chat" can make the AGENT forget, not merely blank the view. */
  readonly canResetSession: boolean;
  /** A sticky per-session default can be pushed (OpenClaw `sessions.patch`). */
  readonly canPatchSessionDefaults: boolean;
  /**
   * Where the reasoning dial lives. `'session'` means it is pushed once and
   * sticks; `'per-turn'` means it rides on every turn. Recorded as a scope
   * rather than as a bare `canSetReasoning: false` on purpose: Hermes HAS a
   * reasoning dial (`hermes chat --reasoning`), it just has no sticky patch.
   * Flattening the two would hide a working control.
   */
  readonly reasoningScope: "session" | "per-turn";
  readonly canAttachImages: boolean;
  readonly canAttachDocuments: boolean;
  readonly maxAttachmentsPerTurn: number;
  /** The composer's microphone. */
  readonly canTranscribe: boolean;
  /** A picture can be produced in this chat, by SOMETHING. */
  readonly canGenerateImages: boolean;
  /**
   * WHO makes that picture happen — the second half of `canGenerateImages`,
   * and a separate flag because it has a separate answer per edition:
   *
   *   `'agent'`    the customer just asks, and the agent reaches for its own
   *                image tool. OpenClaw, where the tool is a bundled plugin
   *                wired up through `agents.defaults.imageGenerationModel`.
   *                Nothing in the composer to render: the ordinary send path
   *                already carries the request.
   *   `'composer'` the BOX asks, because the agent has nothing REGISTERED to
   *                reach for. Hermes, whose image-generation provider slot
   *                exists and ships empty, so the picture is fetched from the
   *                ClawBox AI images endpoint by `generateImage` below. This is
   *                the value that puts a button in the composer.
   *   `null`       no picture can be made here at all. Always the value when
   *                `canGenerateImages` is false, and never a value when it is
   *                true — the two are computed together for exactly that
   *                reason.
   *
   * Recorded as a trigger rather than as a bare `showImageButton`, for the
   * reason `reasoningScope` is a scope rather than `canSetReasoning`: the
   * ability is present on both editions and only its ROUTE differs, and
   * flattening that difference into a boolean about a control is how a UI ends
   * up asking "is this Hermes?" again.
   *
   * It is also the seam where the OTHER half of this work merges. A Hermes box
   * whose `image_gen` provider slot has been FILLED can be asked in plain words
   * on every channel it answers on, not only in this chat — so such a box
   * should report `'agent'`, the button should disappear, and the composer
   * needs no edit at all for that to happen. One expression decides it.
   */
  readonly imageGenerationTrigger: "agent" | "composer" | null;
  /** Replies can be spoken back (TTS). */
  readonly canSpeakReplies: boolean;
  /**
   * WHO turns the reply into audio — the sibling of `imageGenerationTrigger`,
   * and a separate flag for the same reason:
   *
   *   `'harness'`  the gateway speaks the reply itself and pushes a second
   *                message carrying the audio part. OpenClaw. Nothing for the
   *                chat to ask for.
   *   `'box'`      the BOX asks, because the harness will not do it unbidden:
   *                Hermes exposes `POST /api/audio/speak` but never speaks a
   *                reply on its own, so the ClawBox chat route calls it and
   *                attaches the clip in the same shape the gateway produces.
   *   `null`       nothing here can speak. Always the value when
   *                `canSpeakReplies` is false, and never a value when it is
   *                true — the two are computed together.
   */
  readonly spokenReplyTrigger: "harness" | "box" | null;
  /** The Stop button. */
  readonly canAbortTurn: boolean;
  /** There is a socket that can be down — i.e. a connection banner is honest. */
  readonly hasLiveConnection: boolean;
  /**
   * WHERE this box's chat provider and model are configured:
   *
   *   `'openclaw-config'`  `agents.defaults.model.primary` in
   *                        ~/.openclaw/openclaw.json, which
   *                        /setup-api/chat/model reads and writes.
   *   `'harness'`          the harness keeps its own — Hermes' `model.provider`
   *                        / `model.default` in ~/.hermes/config.yaml, served
   *                        by /setup-api/hermes/models.
   *
   * The sibling of `canListHistory`'s reasoning, and here for the same reason:
   * a route whose whole subject lives in ONE harness's store has to be able to
   * ask whether this is that harness, rather than each such route re-deciding
   * from the harness id. chat/model answered a confident 200 about the
   * OpenClaw config on every edition until it could ask this.
   */
  readonly modelStore: "openclaw-config" | "harness";
}

/**
 * Every adapter method rejects with a `HarnessError` and nothing else.
 *
 * Adapters translate their native failure (a WS ack's `.error`, an HTTP
 * status, a spawn ENOENT) into one of these codes. The UI copies `message`
 * verbatim into a system bubble, so a message must read as a sentence to a
 * customer; `code` picks the retry affordance.
 *
 * No adapter ever puts a binary path or a credential in `message` — the same
 * posture the Hermes routes already keep, which scrub before answering.
 */
export type HarnessErrorCode =
  /** The gateway socket is down; retry once it reconnects. */
  | "not-connected"
  /** A capability that reports false was called anyway. Always a BUG. */
  | "unsupported"
  /** The user hit Stop (HTTP 499 / a WS abort). Shows nothing. */
  | "aborted"
  | "timeout"
  /** The provider or proxy said no — `message` is user-facing. */
  | "upstream"
  /** 400-class: a bad model, provider, reasoning level or session id. */
  | "invalid-input"
  /** No credential for this edition (e.g. no ClawBox AI token). */
  | "not-configured"
  | "internal";

export class HarnessError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

/**
 * Narrow an unknown rejection to a `HarnessError`, wrapping anything else.
 *
 * A user-initiated Stop surfaces as a DOM `AbortError`, which is not a failure
 * and must not become a red banner — it is mapped here once so no caller has
 * to remember to special-case it.
 */
export function asHarnessError(
  err: unknown,
  fallback: HarnessErrorCode = "internal",
): HarnessError {
  if (err instanceof HarnessError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError") return new HarnessError("aborted", "Stopped.", err);
    return new HarnessError(fallback, err.message, err);
  }
  return new HarnessError(fallback, "Something went wrong.", err);
}

/** A file staged on the box, ready for THIS harness to open. */
export interface StagedAttachment {
  /** Display name in the composer strip. */
  readonly name: string;
  /** Absolute path on the box, readable by this harness. */
  readonly path: string;
  /** MIME type as reported by the browser. */
  readonly type: string;
}

/**
 * One question the agent is blocked on, mid-turn.
 *
 * Declared in the transport rather than beside the route that produces it
 * because the renderer is a client component: importing the server module for
 * a four-field shape would drag the parking table, its timers and `node:fs`
 * into the browser bundle. The wire shape is small and stable enough that a
 * second declaration here is cheaper than that coupling.
 *
 * `qid` is empty for a SINGLE question. That is not a missing value — it is
 * how the answer route tells "the one question of this request" from "one of a
 * batch", and a caller must post `questionId` only for the latter.
 */
export interface ClarifyQuestion {
  readonly qid: string;
  readonly question: string;
  /** Offered answers. May be empty: a free-text question offers none. */
  readonly choices: string[];
  /** More than one choice may be picked; the answer is then a JSON array. */
  readonly multiSelect: boolean;
}

export interface TurnRequest {
  readonly text: string;
  readonly attachments: readonly StagedAttachment[];
  readonly idempotencyKey: string;
  /** Header overrides. An adapter ignores what its harness has no dial for. */
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly signal?: AbortSignal;
}

/**
 * What a turn emits on its way to an answer.
 *
 * Streaming adapters call `onEvent` and then resolve with the same final text;
 * non-streaming ones resolve only. A caller therefore never has to know which
 * kind it is holding — it renders deltas if they come and the final either way.
 */
export type TurnEvent =
  /**
   * The answer SO FAR — cumulative, not the fragment that just arrived.
   *
   * Stated here because it is the one thing about this event a reader cannot
   * infer and a renderer cannot survive getting wrong: append when it meant
   * replace and the reply doubles; replace when it meant append and only the
   * last few characters are ever visible.
   *
   * Cumulative is the right way round because the surface's job is to paint the
   * current state of one bubble, which is what `setStreaming(text)` already
   * does for the gateway. An adapter whose transport speaks in fragments — the
   * Hermes dashboard socket does — accumulates them itself and reports the
   * whole, so the renderer stays the same one for every harness.
   *
   * It is never the model's monologue. Thinking is reported separately on the
   * finished turn, and no transport may leak it into this field.
   */
  | { kind: "delta"; text: string }
  | { kind: "final"; text: string; media?: readonly string[] }
  | { kind: "thinking"; on: boolean }
  /**
   * A step the agent is taking, WHILE it is taking it.
   *
   * `id` is stable from `start` to `result` so a surface can update the pill it
   * already drew instead of adding a second one. This is progress, not record:
   * the finished turn still carries its own `toolCalls`, and a surface that
   * ignores this event is exactly as correct as it was before — it just shows a
   * long tool call as silence, which is what this exists to end.
   */
  | { kind: "tool"; phase: "start" | "result"; id: string; name: string; detail?: string; status?: "ok" | "error" }
  /**
   * The agent's live status line — the spinner text.
   *
   * A heartbeat for the surface to show, and never the model's monologue.
   * Thinking is reported only on the finished turn, in `reasoning`.
   */
  | { kind: "status"; text: string }
  /**
   * The agent has STOPPED and is waiting for the customer to answer.
   *
   * An event rather than a delta because it is not part of the answer: a delta
   * is cumulative text destined for one bubble, and folding a question into
   * that stream would make the prompt indistinguishable from the reply — it
   * would be appended to, overwritten by the next delta, and persisted into the
   * transcript as if the agent had said it. This is the opposite kind of thing:
   * a control that is live for as long as the agent is parked and meaningless
   * the moment it is not, which is why the surface renders it beside the turn
   * and never inside the message.
   *
   * `requestId` is the identity, not the position: the same prompt is REPLAYED
   * on a reconnect, so a surface must de-duplicate on it or draw the card
   * twice. `answered` carries the qids already locked in, so those questions
   * come back collapsed instead of inviting a second answer the gateway would
   * accept and confuse the agent with — on a replayed batch, and on a question
   * the customer's own next message answered (TASK-610), where a
   * single-question prompt appears under its empty qid.
   */
  | { kind: "clarify"; requestId: string; questions: ClarifyQuestion[]; answered?: Record<string, string> }
  /**
   * The agent gave up waiting. The card stays on screen — a question that
   * silently vanished would read as an answer that was sent — but every
   * control on it is dead, because nothing posted now can reach the turn.
   */
  | { kind: "clarifyExpire"; requestId: string };

export interface TurnResult {
  readonly text: string;
  /** `/setup-api/chat/media?path=…` refs for pictures, or empty. */
  readonly media?: readonly string[];
  /** Spoken-reply refs, kept apart from pictures — different affordances. */
  readonly audio?: readonly string[];
  /**
   * The model's internal monologue for this turn, SEPARATE from `text`.
   *
   * A harness that reports it lets the surface show it as a collapsed
   * disclosure; one that does not simply omits it. It must never be folded into
   * `text` — that is the bug this field exists to end.
   */
  readonly reasoning?: string;
  /** The steps the agent took to answer, in call order. */
  readonly toolCalls?: readonly ChatToolSummary[];
  /** What actually served this turn (not what was asked for), as the harness reports it. */
  readonly model?: string;
  readonly provider?: string;
  /**
   * True when the harness merely ACKNOWLEDGED the turn and the answer will
   * arrive by another route (the gateway's own event stream). The caller must
   * not paint `text` as the reply in that case — it is empty by construction.
   */
  readonly acknowledgedOnly?: boolean;
}

/**
 * One replayed transcript row.
 *
 * Deliberately the chat's own `ChatMessage` rather than a narrower parallel
 * shape: the transcript IS this type everywhere else in the surface, and a
 * second nearly-identical interface would only mean a conversion function that
 * eventually drops a field — the attachments, the spoken audio, or the
 * idempotency key that lets a reconcile recognise an in-flight turn.
 */
export type HistoryMessage = ChatMessage & { variant?: "success" | "error" };

export interface HistoryOptions {
  /** Newest-last, capped here. Defaults to 50 — today's gateway limit. */
  readonly limit?: number;
  /**
   * When a picture is being waited on, the moment the wait began. Anything at
   * or before it is a PREVIOUS generation's outcome, not this one's, which is
   * why the window is passed in rather than inferred: every history read
   * returns the last 50 messages, so an older failure notice is still in the
   * page, and treating it as this job's answer ended the wait ~400 ms after it
   * started with the banner never showing.
   */
  readonly imageWaitFrom?: number | null;
}

export interface HistoryPage {
  readonly messages: HistoryMessage[];
  /**
   * True when the page carried a failed-image-generation notice NEWER than
   * `imageWaitFrom`. A failed job produces no picture, so the count check that
   * normally ends the wait would never fire and the banner would sit there
   * until it timed out.
   */
  readonly imageGenerationFailed: boolean;
}

export type HarnessStatus = "idle" | "connecting" | "connected" | "error";

/**
 * The adapter.
 *
 * Preconditions are stated per method as a capability. Calling a method whose
 * capability is false is a BUG in the caller, and every adapter answers it with
 * `HarnessError('unsupported')` rather than a silent no-op, so the bug shows up
 * in a test instead of as a customer wondering why a button did nothing.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;

  /**
   * Bring the transport up. OpenClaw: the gateway WS handshake. Hermes:
   * resolve-only, because there is nothing to hold open. Progress is reported
   * through `onStatus`. Safe to call repeatedly.
   */
  connect(): Promise<void>;
  disconnect(): void;
  onStatus(cb: (status: HarnessStatus, detail?: string) => void): () => void;

  /**
   * Send one turn. Streaming adapters call `onEvent` and then resolve with the
   * same final text; non-streaming adapters resolve only. Rejects
   * `HarnessError('aborted')` when `req.signal` fires.
   */
  sendTurn(req: TurnRequest, onEvent?: (event: TurnEvent) => void): Promise<TurnResult>;

  /**
   * Kill the in-flight turn. Resolves (no-op) when nothing is running.
   * Precondition: `capabilities.canAbortTurn`.
   */
  abortTurn(): Promise<void>;

  /**
   * Make the AGENT forget — not merely blank the view; the caller clears the
   * visible transcript once this resolves.
   * Precondition: `capabilities.canResetSession`.
   * MUST be idempotent: the (+) button is double-clickable.
   */
  resetSession(): Promise<void>;

  /**
   * A fresh session key beside `mainSessionKey`, for a second conversation
   * with the same agent — the (+) in the chat header. Pure and free: nothing
   * exists until the first turn (the gateway files a session on its first
   * `chat.send`, the transcript store on its first append), and reading the
   * history of a key never seen answers an empty page, so a new tab costs no
   * round trip. The SHAPE is the transport's business, which is why this
   * lives here and not in the component: the gateway needs `agent:<id>:…`,
   * the transcript store needs a bare filename.
   */
  newSessionKey(mainSessionKey: string): string;

  /**
   * Whether `key` was minted by THIS transport. The tab list is persisted
   * across reloads, and a dual box that switched harness restores the other
   * one's keys — which would then be read against a store that has never
   * heard of them. The bind step drops what this answers false to.
   */
  ownsSessionKey(key: string): boolean;

  /**
   * Forget a conversation this surface opened with `newSessionKey`: abort its
   * run if `running`, then delete its transcript. Best effort and never
   * rejects — a closed tab cannot be reopened, so nothing waits on the answer,
   * and a session that refuses deletion mid-run simply stays until its
   * transport's own cleanup. Never the main session.
   */
  deleteSession(key: string, opts: { running: boolean }): Promise<void>;

  /**
   * Newest-last. Returns an empty page for a fresh chat rather than throwing
   * on "no history yet".
   * Precondition: `capabilities.canListHistory`.
   */
  loadHistory(options?: HistoryOptions): Promise<HistoryPage>;

  /**
   * Push a sticky per-session default.
   * Precondition: `capabilities.canPatchSessionDefaults`. A caller whose
   * `reasoningScope` is `'per-turn'` puts the level on the `TurnRequest`
   * instead — see `shouldPatchSessionDefaults` in ./capabilities.
   */
  patchSessionDefaults(patch: { thinkingLevel?: string | null }): Promise<void>;

  /**
   * Draw one picture and answer with what to render it from.
   *
   * Precondition: `capabilities.imageGenerationTrigger === 'composer'`. An
   * adapter whose trigger is `'agent'` rejects with `HarnessError('unsupported')`
   * and is right to — on that edition a picture is asked for by SENDING A TURN,
   * and there is no second way to get one that this method could stand for.
   * That is why the trigger is a capability of its own: without it, an OpenClaw
   * box would report `canGenerateImages: true` beside a method that only
   * throws, which is precisely the contradiction this table exists to prevent.
   *
   * The refs come back in the same `/setup-api/chat/media?path=…` form
   * `TurnResult.media` uses, so one renderer draws a picture the agent made and
   * one the box fetched, and both survive a refresh through the transcript.
   *
   * Rejects `HarnessError('aborted')` when `signal` fires — a customer who
   * changed their mind is not a failure and must not become a red bubble.
   */
  generateImage(prompt: string, signal?: AbortSignal): Promise<{ media: readonly string[] }>;

  /*
   * RESERVED, and deliberately not declared yet:
   *
   *   stageAttachment(file: Blob, filename: string): Promise<StagedAttachment>
   *   transcribe(blob: Blob, filename: string, signal?: AbortSignal): Promise<string>
   *
   * Both go through routes that are already edition-neutral, so today the
   * composer calls them directly and no adapter is in the way. They join this
   * interface when the work that makes them differ per edition lands — Hermes
   * attachments (`chat --image` plus the staging root). Declaring them now would
   * mean two adapters carrying bodies that only throw.
   */
}
