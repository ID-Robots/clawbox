/**
 * Hermes turns that outlive the request that started them.
 *
 * THE BUG THIS EXISTS FOR (TASK-2117): on Hermes, reloading the chat while the
 * agent was answering cut the answer off and wrote "Stopped." into the
 * transcript, every time. The chat route handed `request.signal` to the turn,
 * and that signal fires for ANY end of the browser's connection — F5, a window
 * reload, a laptop lid — not only for the owner's Stop. The route could not tell
 * the two apart, so it treated every reload as a Stop.
 *
 * OpenClaw never had the problem because its turns live in the gateway, not in
 * a browser request: the page sends `chat.send`, the run belongs to the gateway,
 * and a reloaded page reads the history and hears the rest of the run on its new
 * socket. Only `chat.abort` ends a run early. This module gives the Hermes route
 * the same shape inside the one server process:
 *
 *   - a turn is registered under its transcript key and carries its OWN abort
 *     controller, which only {@link stopLiveTurns} — the owner's Stop — fires;
 *   - every frame the route streams is kept in a replay log, so a page that
 *     reloads mid-answer can re-attach and see what it missed, then hear the
 *     rest live;
 *   - the browser's connection is just a listener: when it goes, it stops
 *     listening and the turn goes on to record its answer.
 *
 * In memory only, and that is the right size for it: a turn that is running is
 * a turn this process is running, so a restart of the server ends both together
 * and the durable transcript (which records the question before the turn starts
 * and the answer when it ends) is what the next page load reads.
 *
 * On `globalThis` so every route bundle of this one server process — the chat
 * route that runs the turn, the history route that reports it, the stop that
 * ends it — reads the same registry.
 *
 * SERVER ONLY.
 */

/** One server-sent event as the chat route writes it: a name and a JSON body. */
export interface LiveTurnFrame {
  readonly event: string;
  readonly data: unknown;
}

/** A frame, or `null` once the turn has ended and nothing more will come. */
type Listener = (frame: LiveTurnFrame | null) => void;

interface LiveTurnState {
  readonly id: string;
  readonly sessionKey: string;
  /** When the route began it — which of two running turns is the newer. */
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly frames: LiveTurnFrame[];
  readonly listeners: Set<Listener>;
  ended: boolean;
  readonly settled: Promise<void>;
  resolveSettled: () => void;
}

/** The handle the route runs a turn through. */
export interface LiveTurn {
  readonly id: string;
  /** When the turn began (epoch ms): a file its reply names is the member's only if written since (TASK-2516). */
  readonly startedAt: number;
  /** Fires on the owner's Stop and on nothing else. */
  readonly signal: AbortSignal;
  /** Forward a frame to everyone attached, and keep it for whoever attaches later. */
  emit(event: string, data: unknown): void;
  /** The turn is over. Idempotent; every attached stream is closed. */
  end(): void;
  /** Attach a listener; see {@link attachLiveTurn}. */
  attach(listener: Listener): () => void;
}

/**
 * How long an ENDED turn is kept for a late re-attach.
 *
 * A page that read the history while the turn was live and asks to attach a
 * moment after it ended must still be handed the ending — otherwise it would be
 * left drawing "thinking" over a turn whose answer is already on disk. A minute
 * is far beyond that window and still small: the log holds one turn's text.
 */
export const ENDED_TURN_RETENTION_MS = 60_000;

/**
 * How long a Stop waits for the turn to write down that it was stopped.
 *
 * The stopped turn records what was streamed and the "Stopped." marker on its
 * way out, and a caller that deletes the conversation right after stopping it
 * (closing a chat tab) must not have that write land on the deleted transcript
 * afterwards. Bounded, because a turn wedged inside its transport must not hold
 * the owner's Stop hostage; the abort has already been delivered either way.
 */
export const STOP_SETTLE_TIMEOUT_MS = 5_000;

/**
 * How long a Stop for a turn that has not reached the registry yet is held for
 * it. The page's Stop and its request race: an owner who sends and stops at
 * once can have the Stop arrive while the request is still being validated, and
 * the old route stopped that turn (the request's own signal fired). Matched by
 * the turn id the page sent, so it can never stop the NEXT message instead.
 */
export const EARLY_STOP_RETENTION_MS = 60_000;

const STATE_KEY = Symbol.for("clawbox.hermes.live-turns");

interface Registry {
  readonly turns: Map<string, LiveTurnState[]>;
  /** `<sessionKey>\n<turnId>` → when the early Stop stops counting. */
  readonly earlyStops: Map<string, number>;
}

function shared(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let current = holder[STATE_KEY];
  if (!current) {
    current = { turns: new Map(), earlyStops: new Map() };
    holder[STATE_KEY] = current;
  }
  return current;
}

function registry(): Map<string, LiveTurnState[]> {
  return shared().turns;
}

function earlyStopKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}\n${turnId}`;
}

/**
 * At most this many early Stops are held at once. Each is a Stop that named a
 * turn the box had not seen yet, and nearly all are spent within a second; the
 * cap only bounds what a page that kept stopping turns it never sent can leave.
 */
const MAX_EARLY_STOPS = 64;

function pruneEarlyStops(now: number): void {
  const { earlyStops } = shared();
  for (const [key, until] of earlyStops) {
    if (until <= now) earlyStops.delete(key);
  }
  // Oldest first, in insertion order.
  for (const key of earlyStops.keys()) {
    if (earlyStops.size <= MAX_EARLY_STOPS) break;
    earlyStops.delete(key);
  }
}

/** Take (and spend) an early Stop for this turn, if one is waiting for it. */
function takeEarlyStop(sessionKey: string, turnId: string, now: number): boolean {
  const { earlyStops } = shared();
  pruneEarlyStops(now);
  const key = earlyStopKey(sessionKey, turnId);
  const waiting = earlyStops.has(key);
  earlyStops.delete(key);
  return waiting;
}

function newTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function forget(state: LiveTurnState): void {
  const turns = registry().get(state.sessionKey);
  if (!turns) return;
  const left = turns.filter((turn) => turn !== state);
  if (left.length) registry().set(state.sessionKey, left);
  else registry().delete(state.sessionKey);
}

/**
 * Hand `listener` everything the turn has said so far, then — if it is still
 * running — everything it says from now on. Synchronous on purpose: the replay
 * and the subscription happen in one step, so no frame can fall between them.
 * An ended turn replays and then reports its end at once.
 */
function attach(state: LiveTurnState, listener: Listener): () => void {
  for (const frame of state.frames) listener(frame);
  if (state.ended) {
    listener(null);
    return () => {};
  }
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * Register a turn under the transcript it is recorded in.
 *
 * More than one turn can run under the same key — a second message sent while
 * the first is still answering — and each keeps its own log. A re-attaching
 * page is handed the newest; a Stop ends them all.
 *
 * `turnId` is the id the page sent the turn with. A Stop that named it before
 * the turn got here (see {@link EARLY_STOP_RETENTION_MS}) aborts it at once.
 */
export function beginLiveTurn(sessionKey: string, opts: { turnId?: string; now?: number } = {}): LiveTurn {
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const state: LiveTurnState = {
    id: opts.turnId || newTurnId(),
    sessionKey,
    startedAt: opts.now ?? Date.now(),
    controller: new AbortController(),
    frames: [],
    listeners: new Set(),
    ended: false,
    settled,
    resolveSettled,
  };
  registry().set(sessionKey, [...(registry().get(sessionKey) ?? []), state]);
  if (opts.turnId && takeEarlyStop(sessionKey, opts.turnId, opts.now ?? Date.now())) {
    state.controller.abort();
  }
  return {
    id: state.id,
    startedAt: state.startedAt,
    signal: state.controller.signal,
    emit(event, data) {
      if (state.ended) return;
      const frame: LiveTurnFrame = { event, data };
      // The replay keeps the answer as ONE delta, however many fragments it
      // arrived in: a re-attaching page only needs the text so far, and a long
      // answer streamed token by token would otherwise be thousands of frames.
      // Only RUNS of deltas merge, so a tool step still lands where it happened.
      // A status line is only ever the latest one — the caption under the
      // thread — so a run of those keeps its last.
      const last = state.frames[state.frames.length - 1];
      const chunk = event === "delta" ? deltaText(data) : null;
      if (chunk !== null && last?.event === "delta") {
        state.frames[state.frames.length - 1] = { event: "delta", data: { text: `${deltaText(last.data) ?? ""}${chunk}` } };
      } else if (event === "status" && last?.event === "status") {
        state.frames[state.frames.length - 1] = frame;
      } else {
        state.frames.push(frame);
      }
      for (const listener of [...state.listeners]) {
        try {
          listener(frame);
        } catch {
          /* one dead listener must not cost the others their frame */
        }
      }
    },
    end() {
      if (state.ended) return;
      state.ended = true;
      const listeners = [...state.listeners];
      state.listeners.clear();
      for (const listener of listeners) {
        try {
          listener(null);
        } catch {
          /* the stream was already gone */
        }
      }
      state.resolveSettled();
      const timer = setTimeout(() => forget(state), ENDED_TURN_RETENTION_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    attach(listener) {
      return attach(state, listener);
    },
  };
}

function deltaText(data: unknown): string | null {
  const text = (data as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : null;
}

/** The turn a re-attaching page should follow: the newest running one, else the newest kept. */
function latest(sessionKey: string): LiveTurnState | null {
  const turns = registry().get(sessionKey) ?? [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (!turns[i].ended) return turns[i];
  }
  return turns[turns.length - 1] ?? null;
}

/**
 * Whether a turn is still running under this transcript key — one a page
 * should follow. A turn the owner has already STOPPED is not, even while it is
 * still writing its ending down: the page that pressed Stop has drawn the stop,
 * and following the turn again would paint whatever it settled under it.
 */
export function hasLiveTurn(sessionKey: string): boolean {
  return (registry().get(sessionKey) ?? []).some((turn) => !turn.ended && !turn.controller.signal.aborted);
}

/**
 * Every conversation with a turn running right now, the newest-started first.
 *
 * What a tool call from Hermes has no other way to say: the MCP server is one
 * shared process called with no session id, so when the assistant starts a
 * coding run, the turn running in a ClawBox chat at that moment is the best
 * evidence of which chat asked (src/lib/coding-agent-notify.ts). A turn the
 * owner has stopped is not running, as in {@link hasLiveTurn}.
 */
export function liveTurnKeys(): Array<{ sessionKey: string; startedAt: number }> {
  const out: Array<{ sessionKey: string; startedAt: number }> = [];
  for (const [sessionKey, turns] of registry()) {
    const running = turns.filter((turn) => !turn.ended && !turn.controller.signal.aborted);
    if (running.length === 0) continue;
    out.push({ sessionKey, startedAt: Math.max(...running.map((turn) => turn.startedAt)) });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Resolves once no turn is running under `sessionKey` — at once when none is.
 * A turn begun while it waits is waited for too. No bound of its own: race it.
 */
export async function whenLiveTurnsSettle(sessionKey: string): Promise<void> {
  for (;;) {
    const running = (registry().get(sessionKey) ?? []).filter((turn) => !turn.ended);
    if (running.length === 0) return;
    await Promise.all(running.map((turn) => turn.settled));
  }
}

/**
 * The owner's Stop: abort every running turn under `sessionKey` and wait —
 * boundedly — for each to finish writing its own ending down. Returns how many
 * were stopped.
 *
 * `turnId` names the turn the page that pressed Stop had sent. When no turn by
 * that id has reached the registry yet, the Stop is held for it instead of
 * being lost (see {@link EARLY_STOP_RETENTION_MS}).
 */
export async function stopLiveTurns(
  sessionKey: string,
  opts: { turnId?: string; waitMs?: number; now?: number } = {},
): Promise<number> {
  const turns = registry().get(sessionKey) ?? [];
  if (opts.turnId && !turns.some((turn) => turn.id === opts.turnId)) {
    const now = opts.now ?? Date.now();
    shared().earlyStops.set(earlyStopKey(sessionKey, opts.turnId), now + EARLY_STOP_RETENTION_MS);
    pruneEarlyStops(now);
  }
  const running = turns.filter((turn) => !turn.ended);
  if (!running.length) return 0;
  const waitMs = opts.waitMs ?? STOP_SETTLE_TIMEOUT_MS;
  for (const turn of running) turn.controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(running.map((turn) => turn.settled)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return running.length;
}

/** The response headers every streamed turn is sent with. */
export const LIVE_TURN_STREAM_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx and friends buffer a proxied response by default, which would hold
  // every fragment until the turn ended and undo the whole point.
  "x-accel-buffering": "no",
};

/** How often a stream opened on a person's session asks whether that session still holds. */
export const LIVE_TURN_SESSION_RECHECK_MS = 5_000;

/** Who may go on listening: see {@link liveTurnResponse}. */
export interface LiveTurnListenerOptions {
  /**
   * Whether the session the stream was opened on is still accepted — false once
   * its cookie has expired or been revoked. Absent for a caller with no session
   * to run out (the assistant's bearer).
   */
  readonly stillSignedIn?: () => Promise<boolean>;
  /** Tests shorten it. */
  readonly recheckMs?: number;
}

/**
 * A server-sent-event response that follows a turn until it ends.
 *
 * `subscribe` is handed the listener and returns the detach. The browser going
 * away cancels the stream, and cancelling only DETACHES: the turn neither hears
 * nor cares that nobody is reading any more.
 *
 * The session gate judged the request once, when it arrived, and a turn can run
 * for many minutes — so a reply asked for just before the session ran out went
 * on streaming to a page that was signed out (TASK-2131). With `stillSignedIn`,
 * the stream asks again every `recheckMs` and ends once the answer is no. That
 * too only detaches: the turn still records its answer, which the page reads
 * from the transcript after signing in again.
 */
export function liveTurnResponse(
  subscribe: (listener: Listener) => () => void,
  options: LiveTurnListenerOptions = {},
): Response {
  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;
  let sessionCheck: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stopSessionCheck = () => {
    if (sessionCheck) clearInterval(sessionCheck);
    sessionCheck = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        stopSessionCheck();
        detach?.();
        try {
          controller.close();
        } catch {
          /* the caller already went away */
        }
      };
      const stillSignedIn = options.stillSignedIn;
      if (stillSignedIn) {
        sessionCheck = setInterval(() => {
          void stillSignedIn().then((ok) => { if (!ok) close(); }, () => {});
        }, Math.max(1, options.recheckMs ?? LIVE_TURN_SESSION_RECHECK_MS));
        sessionCheck.unref?.();
      }
      const unsubscribe = subscribe((frame) => {
        if (closed) return;
        if (frame === null) {
          close();
          return;
        }
        try {
          controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
        } catch {
          // Enqueueing into a stream the browser cancelled throws; the turn
          // carries on regardless, so this listener simply leaves.
          close();
        }
      });
      detach = unsubscribe;
      if (closed) unsubscribe();
    },
    cancel() {
      closed = true;
      stopSessionCheck();
      detach?.();
    },
  });
  return new Response(stream, { headers: { ...LIVE_TURN_STREAM_HEADERS } });
}

/**
 * The response a re-attaching page is sent: the newest turn under `sessionKey`,
 * replayed and then followed live. Null when there is none to follow — none
 * ran, or it ended long enough ago that the transcript is the only account of
 * it. A turn that ended within {@link ENDED_TURN_RETENTION_MS} is replayed to
 * its end, so a page that read the history a moment before the answer landed
 * is still handed it.
 */
export function liveTurnResponseFor(sessionKey: string, options: LiveTurnListenerOptions = {}): Response | null {
  const state = latest(sessionKey);
  if (!state) return null;
  return liveTurnResponse((listener) => attach(state, listener), options);
}

/** Test seam: forget every turn and every held Stop. */
export function resetLiveTurns(): void {
  registry().clear();
  shared().earlyStops.clear();
}
