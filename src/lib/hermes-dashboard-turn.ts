import { WebSocket } from "ws";
import { DASHBOARD_WS_ORIGIN, dashboardWsTicket } from "@/lib/hermes-dashboard-auth";
import { isHermesCliProvider } from "@/lib/hermes-providers";

/**
 * A Hermes turn driven through the dashboard's own JSON-RPC socket instead of a
 * fresh `hermes chat -q` process.
 *
 * WHY THIS EXISTS, measured rather than assumed. On the live box a `chat -q`
 * turn spends about six seconds building an agent — importing the CLI, handshaking
 * the MCP server, assembling the system prompt — BEFORE the first request to the
 * model is even sent. On a "Hey" against deepseek-v4-flash that was 6.0s of boot
 * around 2.9s of model time: the wait a person feels is mostly a process starting
 * up, not a model thinking.
 *
 * The `hermes dashboard` process (127.0.0.2:9119) has already paid that cost and
 * is sitting there. Its `/api/ws` endpoint is the same JSON-RPC surface its own
 * Chat tab drives, and the agent runs INSIDE it, so a turn submitted here starts
 * against the model immediately and streams back token by token — the same
 * internal `stream_delta_callback` that makes Telegram replies type themselves out.
 * Measured on the same prompt and model: first visible text at 2.9s instead of
 * 8.4s, whole turn 3.0s instead of 9.8s.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not become the source of the turn
 * record. The final answer, its reasoning and its tool steps are still read from
 * the agent's own database by `readHermesTurn`, exactly as the CLI path reads
 * them, because that record is the one the transcript keeps and it is already
 * proven. This module's job is the two things the database cannot give in time:
 * the text as it arrives, and the session id to read afterwards.
 */

/** The dashboard's own event names, kept as a set so a rename is one edit. */
const EVENT = {
  ready: "gateway.ready",
  messageStart: "message.start",
  /** A fragment of the ANSWER. Never carries the monologue — see `reasoningDelta`. */
  messageDelta: "message.delta",
  messageComplete: "message.complete",
  /**
   * A fragment of the model's private reasoning, on its OWN channel.
   *
   * This is the whole reason the raw monologue cannot flash into the bubble on
   * this transport: the separation is made at the source rather than recovered
   * afterwards by parsing a console frame out of stdout. Nothing here forwards
   * it, and that is a property of the wire, not of a filter we have to keep
   * correct.
   */
  reasoningDelta: "reasoning.delta",
  /**
   * NOT reasoning. The agent's animated STATUS LINE — the spinner text.
   *
   * Upstream is explicit about this. `thinking_callback` is documented as the
   * live status line ("CLI: updates the prompt_toolkit spinner text. TUI /
   * Desktop: the same callback is bridged to the `thinking.delta` event, which
   * both render as the live spinner/status line" — run_agent.py `_emit_wait_notice`),
   * and the gateway wires it straight through: `"thinking_callback": lambda text:
   * _emit("thinking.delta", sid, {"text": text})` (tui_gateway/server.py). What
   * it carries is composed in agent/conversation_loop.py as `f"{face} {verb}..."`
   * from a fixed kaomoji list and a fixed verb list (agent/display.py:
   * KAWAII_THINKING / THINKING_VERBS).
   *
   * So this channel emits things like `(⌐■_■) computing...` — for EVERY model,
   * including ones that do no reasoning at all. Collecting it alongside
   * `reasoning.delta` put exactly that in the customer's Reasoning disclosure:
   * a turn on claude-fable-5 (which returned no monologue) showed
   * `(⊙_⊙) musing...` as though the model had thought it.
   *
   * It is named here so the frame is recognised and deliberately dropped,
   * rather than falling to `default` and being reported as unknown. Excluded at
   * the SOURCE — no regex scrubs a status vocabulary out of reasoning text
   * afterwards, because the wire already tells us which channel is which.
   */
  thinkingDelta: "thinking.delta",
  /**
   * A tool call is ABOUT to run, is running, or has finished.
   *
   * Measured on the live box rather than assumed (`tui_gateway/server.py`
   * `_on_tool_start` :6019, `_on_tool_complete` :6066, `tool_gen_callback`
   * :6322): a turn that reaches for a tool emits `tool.generating` while the
   * arguments are still being written, then `tool.start`, then — only when the
   * tool RETURNS — `tool.complete`. Nothing at all is emitted in between.
   *
   * That gap is the whole of the "went quiet" bug. A 240-second `terminal`
   * call, captured live, produced `tool.start` at t+3.7s and `tool.complete`
   * at t+244.0s with no turn-scoped frame between them; the only thing that
   * arrived was unrelated `sessions.changed` housekeeping from OTHER sessions,
   * which is luck, not liveness.
   *
   * Named here so the phase becomes something the customer can SEE ("working:
   * web_search") instead of a blank bubble, and so the idle clock is restarted
   * by a turn's own progress rather than by a neighbour's.
   */
  toolGenerating: "tool.generating",
  toolStart: "tool.start",
  toolComplete: "tool.complete",
  /**
   * The agent is BLOCKED, asking a person whether a tool may run.
   *
   * This is the one thing the socket does that spawning `hermes chat -q` never
   * did, and it is not cosmetic: the agent thread parks on an Event until an
   * answer comes back, so a client that treats this as just another event to
   * ignore hangs the turn forever. Found exactly that way — a live turn that
   * logged its first model call and then nothing at all, for minutes, with no
   * turn-finished line.
   */
  approvalRequest: "approval.request",
  /**
   * The agent is BLOCKED, asking the PERSON a question of its own.
   *
   * The same parked-thread failure as `approval.request` and a worse one,
   * because this frame had no case at all: it fell to `default`, was counted as
   * one more unknown event and dropped. Measured against hermes' own source
   * rather than guessed — `tui_gateway/server.py` `_clarify_block` :3581 hands
   * off to `_block` :3486, which mints `request_id = uuid4().hex[:8]` and then
   * parks the agent's worker thread on `Event.wait(timeout)` with
   * `_clarify_timeout_seconds()` :3568. That timeout defaults to 3600 seconds
   * in config, and `<= 0` is passed through as `None`, which is Python's word
   * for FOREVER.
   *
   * So the two clocks disagreed by twenty times over. The agent sat waiting an
   * hour for an answer nobody had been shown, while this reader gave up after
   * `IDLE_TIMEOUT_MS` (180s) and wrote "dashboard stream went quiet" into the
   * customer's transcript — a question they were never asked, reported to them
   * as a failure.
   */
  clarifyRequest: "clarify.request",
  /**
   * That question's window closed; nobody has to answer it any more.
   *
   * Carries only `{ request_id }` (server.py :3536 for a batch, :3546 for a
   * single). Named here for two reasons: the surface has to be able to take the
   * form away rather than leave a person typing into a prompt that can no
   * longer be answered, and the idle watchdog has to come back down off the
   * hour-long window this frame's absence justified.
   */
  clarifyExpire: "clarify.expire",
  error: "error",
} as const;

/**
 * What we answer an approval with, and why it is "approve".
 *
 * Not a new permission — the SAME one this route already grants. `chat -q`
 * runs the agent with no person attached and its tools execute unprompted;
 * that is what a customer typing into this chat gets today, and the security
 * scan that blocks the genuinely dangerous classes runs underneath either way.
 * Answering "deny" here would quietly make the chat LESS capable than it was
 * before it got faster, which is the wrong kind of surprise: the same request
 * that worked yesterday would come back refused.
 *
 * `once` rather than `always` or `session`: the grant covers the call being
 * asked about and nothing beyond it, so nothing this route answers can widen
 * what a later turn — or the owner's own dashboard session — may do.
 */
const APPROVAL_CHOICE = "once";

/**
 * How long a turn may go with NOTHING arriving before we call it dead.
 *
 * Idle, not total: a turn that is actively streaming is alive by definition and
 * must never be cut off for taking a long time, which is exactly what a blanket
 * deadline does to the long answers most worth waiting for. The clock restarts
 * on every frame — including `reasoning.delta`, so a model that thinks for two
 * minutes before writing a word still counts as working.
 */
const IDLE_TIMEOUT_MS = Number(process.env.HERMES_STREAM_IDLE_TIMEOUT_MS || 180_000);

/**
 * The same clock, while the turn is waiting on a PERSON.
 *
 * 3600 seconds because that is hermes' own `agent.clarify_timeout` default —
 * the number the agent's worker thread is itself parked on — and two clocks
 * that disagree about how long a question may go unanswered produce exactly one
 * outcome: the shorter one wins and kills a turn that was working perfectly.
 * With 180s against 3600s the reader gave up twenty times too early, every
 * time, on a question the customer had not even been shown.
 *
 * This is not the watchdog being weakened. `IDLE_TIMEOUT_MS` measures SILENCE,
 * and silence is evidence because a running agent has no reason to produce
 * none. A clarify is the one state where quiet is the expected shape of things:
 * the agent is deliberately emitting nothing because it is waiting for a human
 * being to read a question and type an answer, and a person taking four minutes
 * over that is liveness, not a wedged socket. The window narrows again the
 * moment the turn's own frames resume — see `TURN_PROGRESS` — so a turn that
 * really does wedge after the answer lands is still given up on in three
 * minutes rather than in an hour.
 */
const CLARIFY_IDLE_TIMEOUT_MS = Number(process.env.HERMES_CLARIFY_IDLE_TIMEOUT_MS || 3_600_000);

/**
 * "Nothing arrived for the whole window" — raised, and NAMED, so the caller can
 * tell it apart from a turn that genuinely failed.
 *
 * The distinction earns its keep because of what quiet turned out to mean on
 * the live box. Captured from the customer's own transcript: a question asked
 * at 20:10:44 whose answer the agent WROTE to `state.db` at 20:11:12 — 27
 * seconds later, 582 characters, two tool calls — and whose `message.complete`
 * frame never reached this socket. This reader, which can only end a turn on
 * `message.complete`, waited the full idle window and reported failure at
 * 20:14:13, exactly `IDLE_TIMEOUT_MS` after the last frame. The customer saw
 * "Error: dashboard stream went quiet"; the answer had been sitting in the
 * agent's database the entire time.
 *
 * So quiet is not proof of failure. It is proof only that THIS TRANSPORT
 * stopped hearing, and the caller owes the customer a look at the record
 * before it writes an error into their transcript.
 */
export class DashboardStreamQuietError extends Error {
  /** Discriminator, so a caller never has to match on the message text. */
  readonly quiet = true;
  /** Frames seen on this turn before the silence — 0 means never started. */
  readonly framesSeen: number;
  /** The last event type that arrived, for a log line worth reading. */
  readonly lastEvent: string;
  constructor(framesSeen: number, lastEvent: string) {
    super("dashboard stream went quiet");
    this.name = "DashboardStreamQuietError";
    this.framesSeen = framesSeen;
    this.lastEvent = lastEvent;
  }
}

/** Is this the "heard nothing" case, rather than a reported failure? */
export function isQuietStreamError(err: unknown): err is DashboardStreamQuietError {
  return err instanceof DashboardStreamQuietError;
}

/**
 * One question the agent is waiting on an answer to.
 *
 * Flattened from the TWO shapes the wire uses — a single question at the top of
 * the payload, or a `questions` array — because a surface that has to branch on
 * which of them arrived will get it wrong in exactly one of the two cases, and
 * the batch case is the rarer one. Normalising here means the renderer draws a
 * list of length one or length N and never asks how it was sent.
 *
 * `qid` is the identity the gateway answers by, and its emptiness is
 * meaningful rather than missing: a single-question clarify HAS no qid, and
 * `clarify.respond` for it must carry no `question_id` at all. For a batch the
 * qid is mandatory, and the agent unblocks only once EVERY qid has an answer.
 */
export interface ClarifyQuestion {
  /** Stable id for a batch question; "" for a single-question clarify. */
  readonly qid: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly multiSelect: boolean;
}

/**
 * Something the turn DID, reported while it is still doing it.
 *
 * Deliberately not the answer and deliberately not the reasoning: this is the
 * progress channel, and its whole purpose is that a turn spending three
 * minutes in `web_search` looks like work rather than like a hang.
 */
export type DashboardActivity =
  /** A tool call, `phase` moving start → result. `id` is stable across both. */
  | { kind: "tool"; phase: "start" | "result"; id: string; name: string; detail?: string; status?: "ok" | "error" }
  /**
   * The agent's animated status line — the kaomoji spinner.
   *
   * Forwarded as ACTIVITY and never as reasoning. It is a heartbeat that says
   * the agent is alive, and it is the exact frame that once put `(⊙_⊙)
   * musing...` in a customer's Reasoning disclosure on a model that had not
   * reasoned at all. Both facts are true at once, and this type is how they
   * stay true: liveness here, monologue nowhere near here.
   */
  | { kind: "status"; text: string }
  /**
   * The agent has stopped and is asking the customer something.
   *
   * Reported as ACTIVITY rather than as text for the same reason a tool step
   * is: it is not part of the answer, and folding it into the bubble would put
   * a question mid-sentence in a reply that has not been written yet. It is
   * also the only activity the customer can act ON, which is why it carries the
   * `requestId` — that value, and not the session, is what `clarify.respond`
   * is addressed by.
   *
   * `answered` appears only on a REPLAYED batch: the gateway hands back the
   * answers already locked in (`{ qid: answer }`) so a reconnecting surface can
   * restore the half-filled form instead of asking everything again. An empty
   * string in there is a real answer — hermes treats it as a locked SKIP — so
   * a reader must not mistake it for an unanswered question.
   */
  | {
      kind: "clarify";
      requestId: string;
      questions: readonly ClarifyQuestion[];
      answered?: Readonly<Record<string, string>>;
    }
  /** That question expired; nothing can be answered against `requestId` now. */
  | { kind: "clarifyExpire"; requestId: string };

/** Bound on the handshake itself, which is local and answers in milliseconds. */
const CONNECT_TIMEOUT_MS = 8_000;

/** Name every frame this module chose not to act on. Off unless asked. */
const DEBUG_FRAMES = process.env.HERMES_STREAM_DEBUG === "1";

/** Bound on `session.create` / `session.resume`, likewise local. */
const SESSION_TIMEOUT_MS = 15_000;

/**
 * Bound on a mid-conversation `/model` switch.
 *
 * Wider than the session calls because it is not just bookkeeping: the switch
 * rebuilds the agent's client against the new provider, measured at ~3.3s on
 * the bench box. Generous enough that a slow rebuild still lands, tight enough
 * that a wedged one does not eat the turn.
 */
const SWITCH_TIMEOUT_MS = 20_000;

/**
 * The most answer text we will hold. The route caps the CLI's stdout the same
 * way and for the same reason: a runaway turn must not be able to grow the
 * server's heap without limit.
 */
const MAX_TEXT_BYTES = 2_000_000;

/**
 * How long a "can this box stream?" answer is trusted before it is asked again.
 *
 * Short, because the dashboard is a service that can stop and start under us,
 * and the cost of being wrong is asymmetric in an unusual direction here: a
 * stale YES is harmless (the turn falls back to the CLI and the customer waits
 * the old amount), while a stale NO would keep a working box on the slow path
 * until the web server restarted. Half a minute keeps both short-lived.
 */
const PROBE_TTL_MS = 30_000;

let probe: { at: number; value: Promise<boolean> } | null = null;

/**
 * Can turns be streamed through the dashboard on THIS box, right now?
 *
 * Asked, not assumed, and asked by doing the first half of the real thing: mint
 * a WebSocket ticket. That single call proves the dashboard process is up, that
 * the stored password still opens it, and that the socket endpoints are enabled
 * — which is the whole precondition, and nothing weaker tests all three. The
 * ticket is then thrown away; it is single-use and expires in thirty seconds.
 *
 * Fails closed. A box that cannot answer is a box that spawns the CLI, which is
 * slower and completely correct.
 */
export async function hermesCanStreamTurns(): Promise<boolean> {
  const now = Date.now();
  if (probe && now - probe.at < PROBE_TTL_MS) return probe.value;
  const value = dashboardWsTicket()
    .then((ticket) => Boolean(ticket))
    .catch(() => false);
  probe = { at: now, value };
  return value;
}

/** Test seam: forget the probe so the next call asks again. */
export function resetHermesStreamProbe(): void {
  probe = null;
}

export interface DashboardTurnRequest {
  readonly text: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reasoning?: string;
  /**
   * Whether `provider` is a user-defined provider (a `providers.<slug>` entry
   * in config.yaml) rather than one of Hermes' built-ins — the catalogue's own
   * `is_user_defined`, which the route has in hand and this process does not.
   * Read only to resolve the dashboard's provider KIND; see servedProviderSlug.
   *
   * Three-state on purpose, and ABSENT is the common case: the route sends it
   * only off a live `dashboard` catalogue that actually carried the field, so
   * "not sent" means "nobody could say", not "no". Only `true` resolves a kind.
   */
  readonly providerIsUserDefined?: boolean;
  /** A stored session id to resume, or empty to start a new conversation. */
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

export interface DashboardTurnFinal {
  readonly text: string;
  readonly reasoning: string;
  /** The dashboard's own word for how the turn ended: `complete`, `error`, … */
  readonly status: string;
  readonly error?: string;
  /**
   * The model that ACTUALLY served this turn, as the dashboard reported it —
   * not the one the pills asked for. The two can differ (a refused switch), and
   * when they do the record has to say what really answered.
   */
  readonly model?: string;
  /** The provider behind `model`, when the dashboard names one. */
  readonly provider?: string;
}

export interface DashboardTurn {
  /**
   * The durable session id this turn runs against — the same
   * `YYYYMMDD_HHMMSS_hex` shape `chat -q --resume` takes and `readHermesTurn`
   * reads, so threading and the turn record are unchanged by the transport.
   */
  readonly sessionId: string;
  /**
   * The model this session is set to run when the turn is submitted, and the
   * provider behind it. Read from the dashboard rather than echoed back from
   * the request, so a switch that did not take is visible instead of assumed.
   */
  readonly model: string;
  readonly provider: string;
  /**
   * Run the submitted turn, reporting each fragment of the answer as it lands.
   *
   * `onActivity` is optional and separate on purpose: a caller that only wants
   * text stays exactly as it was, while one that can render progress gets the
   * tool steps and the status line as they happen instead of after the fact.
   */
  run(
    onDelta: (chunk: string) => void,
    onActivity?: (activity: DashboardActivity) => void,
  ): Promise<DashboardTurnFinal>;
  /**
   * Answer a pending clarify. Resolves when the gateway acknowledges.
   *
   * Offered on the turn because the socket is already open and authenticated,
   * and used mainly by the tests — the HTTP route deliberately opens a socket
   * of its own instead. Two reasons, and the second is the one that matters.
   * The first: this socket has ONE frame reader, so an answer sent while `run`
   * is waiting would compete with it for the next frame off the queue. The
   * second: `clarify.respond` carries no session id, so an answer does not need
   * this socket at all — and the case worth fixing is precisely the one where
   * this socket is gone, the streaming request having died while the agent sat
   * parked on the question for the rest of the hour.
   */
  respondToClarify(requestId: string, answer: string, questionId?: string): Promise<void>;
  /** Drop the socket. Safe to call twice, and safe to call after `run` settles. */
  close(): void;
}

/** A frame off the socket, as far as we are willing to assume. */
interface GatewayFrame {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: unknown };
  params?: { type?: unknown; payload?: unknown };
}

function parseFrame(raw: unknown): GatewayFrame | null {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as GatewayFrame) : null;
  } catch {
    return null;
  }
}

function frameType(frame: GatewayFrame): string {
  const type = frame.params?.type;
  return typeof type === "string" ? type : "";
}

/**
 * Did a `/model` switch actually take?
 *
 * It cannot be read from the JSON-RPC envelope alone, and assuming otherwise is
 * a bug this had. A REFUSED switch comes back as a perfectly successful reply:
 *
 *   { "output": "  ✗ Model `deepseek-v4-flash` was not found in this
 *                 provider's model listing.",
 *     "warning": "live session sync failed: …" }
 *
 * No `error` member anywhere. Treating that as success is what made the turn
 * report a model it was not running — the exact dishonesty the model field was
 * added to remove. Captured verbatim from the bench box.
 *
 * Read conservatively: a switch counts as made only when nothing says it was
 * not. `warning` is upstream's own channel for "the live session did not sync",
 * and `✗` is the marker its own output uses for a refusal.
 */
/**
 * Ids that are safe to place in a `/model …` command line.
 *
 * The switch is a COMMAND STRING the gateway parses into flags, so a value
 * carrying whitespace could add its own — and the flag it would reach for is
 * `--global`, the one that writes config.yaml and changes the model for every
 * other session, Telegram and cron. The chat route already charset-checks both
 * values (`isSafeHermesModelId`, `isPlausibleHermesProviderId`, neither of
 * which admits a space or a leading `-`), but this module is a library and must
 * not depend on its caller having done that: the whole point of `--session` is
 * that a chat turn cannot change the device default, and one unvalidated caller
 * would be enough to undo it.
 */
const COMMAND_SAFE_ID = /^[A-Za-z0-9_./:-]+$/;

/**
 * The provider a turn reports as having served it — a SLUG, or nothing.
 *
 * The dashboard names a user-defined provider by its KIND (`custom`), never
 * its slug: `info.provider` and a completion's `provider` both read `custom`
 * for clawai. Handed through as the served provider, that kind was persisted
 * per turn and the chat labelled every resumed reply "custom · …" for the
 * shipped default provider. So a reported value is trusted only when it is a
 * slug the CLI defines, or the very slug this turn asked for. A kind is
 * resolved to the requested slug only when the request named a user-defined
 * provider and the session is on the model it asked for — the route already
 * validated that pairing. A CANONICAL request against a `custom` session is a
 * contradiction (the switch is skipped on the model id alone, so the session
 * is still on whatever the kind stands for), and the honest answer is none.
 *
 * Two traps. `custom` is ALSO a real CLI slug (a generic OpenAI-compatible
 * endpoint), so it passes the allowlist — and a dashboard that says `custom`
 * of a session it did not just build for this request cannot be telling the
 * two apart, so on such a session the literal `custom` provider is never
 * asserted: the answer is none. (A session the request built, or switched, is
 * on the requested provider by contract, and BOTH call sites keep that answer
 * out of here rather than re-deriving it — `providerFromRequest`.)
 * And the allowlist cannot say which slugs are user-defined (`clawai` is in
 * Hermes' captured registry, `clawlocal` is not), so the kind is resolved only
 * off the catalogue's own flag, carried on the request as
 * `providerIsUserDefined`, and only when that flag says `true`. An ABSENT flag
 * is not a licence: it used to be read as the benefit of the doubt, which made
 * the whole contradiction rule inert on the shape the route produces most often
 * — it passes the flag only off a live `dashboard` catalogue, and a stale
 * `catalog-file` payload (up to 6 h after one `/api/model/options` failure, or a
 * cold boot) carries none while the dashboard SOCKET this transport uses is
 * healthy. A canonical request against a `custom` session then recorded the
 * canonical slug: the very lie the rule three lines up forbids. Unknown means
 * no label, here as everywhere else on this path.
 *
 * A report with NO provider in it resolves to nothing. The request cannot
 * stand in: the route validated that the requested PAIR is installable, not
 * that this session is on it — a resumed session holding the requested model
 * id needs no switch, so it keeps whatever provider it was created with. The
 * only two places the request IS the provider are a session this turn built
 * and one it switched, and neither reaches this function (see
 * `providerFromRequest`).
 */
/**
 * The dashboard's word for "a user-defined provider", which is ALSO a real CLI
 * slug. Exported because the route has to make the same refusal about the same
 * word when it reads the harness's billing record — one definition, so the two
 * cannot drift.
 */
export const DASHBOARD_PROVIDER_KIND = "custom";
function servedProviderSlug(reported: string, req: DashboardTurnRequest, onRequestedModel: boolean): string {
  const requested = req.provider;
  const reportedIsKind = reported === DASHBOARD_PROVIDER_KIND;
  if (reported && !reportedIsKind && (isHermesCliProvider(reported) || reported === requested)) return reported;
  if (!reported || !onRequestedModel || !requested) return "";
  // The kind and the literal slug are the same word; nothing here can say
  // which the session is on.
  if (requested === DASHBOARD_PROVIDER_KIND) return "";
  return reportedIsKind && req.providerIsUserDefined === true ? requested : "";
}

function commandSafe(value: string): boolean {
  return !value.startsWith("-") && COMMAND_SAFE_ID.test(value);
}

function modelSwitchTook(frame: GatewayFrame): boolean {
  if (frame.error) return false;
  const result = frame.result || {};
  const warning = result.warning;
  if (typeof warning === "string" && warning.trim()) return false;
  const output = typeof result.output === "string" ? result.output : "";
  return !output.includes("✗");
}

function payloadText(frame: GatewayFrame): string {
  const payload = frame.params?.payload;
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

/** The `clarify` member of the activity union, named so it can be returned. */
type ClarifyActivity = Extract<DashboardActivity, { kind: "clarify" }>;

/**
 * The events only THIS TURN can produce, as opposed to the box's housekeeping.
 *
 * The distinction exists solely to decide when a clarify has stopped blocking.
 * A person answers over a DIFFERENT socket — `clarify.respond` needs no session
 * id, so the browser's answer travels on its own connection and this reader
 * never sees the reply — which means the only evidence available here that the
 * agent unparked is that the agent started talking again.
 *
 * Membership is drawn tightly on purpose. `sessions.changed` and friends arrive
 * from OTHER sessions and prove nothing about this one; treating them as the
 * end of the wait would re-arm the three-minute clock while the customer was
 * still reading the question, which is the bug this whole file exists to avoid,
 * merely rediscovered from the other side.
 */
const TURN_PROGRESS: ReadonlySet<string> = new Set<string>([
  EVENT.messageStart,
  EVENT.messageDelta,
  EVENT.messageComplete,
  EVENT.reasoningDelta,
  EVENT.thinkingDelta,
  EVENT.toolGenerating,
  EVENT.toolStart,
  EVENT.toolComplete,
  EVENT.approvalRequest,
  EVENT.error,
]);

/** Choice labels, keeping only the strings — the wire has been wrong here. */
function clarifyChoices(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((choice): choice is string => typeof choice === "string");
}

/**
 * The questions in a clarify payload, whichever of the two shapes it arrived in.
 *
 * Coerced rather than trusted at every field. `choices` is absent on a
 * free-text clarify and the tool has been seen to send it as something other
 * than an array; `multi_select` is emitted ONLY when true (server.py :3628), so
 * its absence is a real answer rather than a gap to guess at.
 *
 * A batch entry with no `qid` is DROPPED, and that is deliberate: a batch is
 * answered per question, and `clarify.respond` with no `question_id` against a
 * batch is upstream's cancel-all. Rendering a question that could only be
 * answered by cancelling every other question in the same form would be worse
 * than not rendering it.
 */
function clarifyQuestions(payload: Record<string, unknown>): ClarifyQuestion[] {
  const batch = payload.questions;
  if (Array.isArray(batch)) {
    const out: ClarifyQuestion[] = [];
    for (const entry of batch) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      // Trimmed before the check, so a whitespace-only question is treated as
      // the absence it is. `"   "` is truthy, and letting it through would arm
      // the hour-long window on a card with nothing written on it. The adapter
      // trims the same field, and two normalisers that disagree about the same
      // payload is a bug waiting to be found the hard way.
      const question = typeof row.question === "string" ? row.question.trim() : "";
      const qid = typeof row.qid === "string" ? row.qid : "";
      if (!question || !qid) continue;
      out.push({ qid, question, choices: clarifyChoices(row.choices), multiSelect: row.multi_select === true });
    }
    return out;
  }
  const question = typeof payload.question === "string" ? payload.question.trim() : "";
  if (!question) return [];
  // The single case, given the empty qid that means "answer this with no
  // `question_id`" — the one value the gateway accepts for a non-batch reply.
  return [
    { qid: "", question, choices: clarifyChoices(payload.choices), multiSelect: payload.multi_select === true },
  ];
}

/**
 * The answers already locked in, on a partially answered batch being replayed.
 *
 * Empty strings are KEPT. Upstream treats an empty answer as a deliberate skip
 * that the batch counts as done, so dropping it here would show a reconnecting
 * customer an unanswered question they had already dismissed — and any answer
 * they then gave would be refused, because that qid is already locked.
 */
function clarifyAnswers(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [qid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (qid && typeof value === "string") out[qid] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A clarify payload as the activity a surface can actually render, or null.
 *
 * Null rather than a half-formed activity in the two cases where there is
 * nothing a person could do with it: no `request_id`, so no answer could ever
 * be addressed anywhere, and no usable question, so there would be nothing to
 * ask. Both would otherwise draw an empty form with a Send button pointing at
 * nowhere — and, worse, would suspend the idle watchdog for an hour on the
 * strength of a frame that blocks nothing.
 */
function normaliseClarify(raw: unknown): ClarifyActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
  if (!requestId) return null;
  const questions = clarifyQuestions(payload);
  if (!questions.length) return null;
  const answered = clarifyAnswers(payload.answers);
  return { kind: "clarify", requestId, questions, ...(answered ? { answered } : {}) };
}

/**
 * The question a fresh message should be delivered to, or null for none.
 *
 * `""` is a real answer here and not a miss: the single-question shape carries
 * that qid, and its `clarify.respond` must go out with NO `question_id` at all.
 * A batch answers per question, so the message goes to the first one still
 * outstanding — the answers already locked in are upstream's, and re-answering
 * one of those would be refused.
 *
 * Null when every question already has an answer. Falling back to "no
 * question_id" there would not be a harmless default: `_respond` takes the
 * batch branch only when a question_id is present (server.py:11911), so an
 * answer without one sets the Event immediately and `_block` returns the raw
 * string (server.py:3524), discarding every answer locked so far — silently,
 * under a `{"status":"ok"}`.
 */
function answerableQid(clarify: ClarifyActivity): string | null {
  const answered = clarify.answered ?? {};
  const outstanding = clarify.questions.find((question) => !(question.qid in answered));
  return outstanding ? outstanding.qid : null;
}

/**
 * Whether a batch still has a question in it after an answer landed.
 *
 * The gateway's own `remaining` is preferred over anything computed here,
 * because only it knows: answers accumulate in ITS registry across every
 * surface that has answered anything — this chat, the dashboard SPA, a second
 * browser — so a client's own arithmetic can be out of date the moment it is
 * done. Computed only when the reply says nothing.
 */
function clarifyStillOpen(
  raw: unknown,
  clarify: ClarifyActivity,
  answered: Readonly<Record<string, string>>,
): boolean {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 0;
  if (Array.isArray(raw)) return raw.some((value) => typeof value === "string");
  return clarify.questions.some((question) => !(question.qid in answered));
}

/**
 * Open a socket, settle the session, and hand back something that can run ONE turn.
 *
 * Connecting is separated from running on purpose. Everything that can fail for
 * an ordinary reason — the dashboard is down, the stored password is stale, the
 * session id no longer exists — fails HERE, in about a tenth of a second, while
 * the caller can still fall back to spawning the CLI. Once `run` starts, the
 * response has already been committed to streaming and there is no way back.
 *
 * Returns null rather than throwing for exactly that reason: "this box cannot
 * stream right now" is an expected answer, not a fault.
 */
export async function openDashboardTurn(req: DashboardTurnRequest): Promise<DashboardTurn | null> {
  if (req.signal?.aborted) return null;
  const ticket = await dashboardWsTicket(req.signal).catch(() => null);
  if (!ticket) return null;

  let socket: WebSocket;
  try {
    socket = new WebSocket(`${DASHBOARD_WS_ORIGIN}/api/ws?ticket=${encodeURIComponent(ticket)}`, {
      // The dashboard binds a non-loopback address and refuses an upgrade whose
      // Host does not name it. `ws` sets that from the URL, so this only has to
      // not be overridden — but the origin guard is checked too, and an absent
      // Origin is what a non-browser client is expected to present.
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  const close = () => {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  };

  /** Frames that arrive before anyone is reading them, so none are lost. */
  const queue: GatewayFrame[] = [];
  let waiter: ((frame: GatewayFrame) => void) | null = null;
  let dead: Error | null = null;
  let deadWaiter: ((err: Error) => void) | null = null;

  const fail = (err: Error) => {
    if (!dead) dead = err;
    deadWaiter?.(dead);
  };

  /**
   * Liveness, counted where it actually happens.
   *
   * EVERY frame off this socket restarts the idle clock — the clock lives in
   * `nextFrame`, and every frame resolves whichever `nextFrame` is waiting.
   * That includes the ones no branch of the turn loop acts on: `tool.start`
   * and `tool.complete`, the `thinking.delta` spinner, `session.info`,
   * `session.usage`, housekeeping. A tool phase emits no text and no
   * reasoning, and treating only those two as "alive" would call a working
   * agent dead; nothing here does that, and these counters exist so a test can
   * prove it rather than a comment claiming it.
   *
   * A frame that will not parse is still a frame — the socket is plainly
   * carrying traffic — so it counts as liveness even though it is dropped.
   */
  let framesSeen = 0;
  let lastEvent = "(none)";

  socket.on("message", (raw) => {
    framesSeen += 1;
    const frame = parseFrame(raw);
    if (!frame) {
      // Unparseable, but not silence. Wake the waiter so the idle clock
      // restarts; the loop simply reads the next frame.
      if (waiter) {
        const resume = waiter;
        waiter = null;
        resume({});
      }
      return;
    }
    const type = frameType(frame);
    if (type) lastEvent = type;
    if (waiter) {
      const resume = waiter;
      waiter = null;
      resume(frame);
    } else {
      queue.push(frame);
    }
  });
  socket.on("error", (err: Error) => fail(err));
  socket.on("close", (code: number) => fail(new Error(`dashboard socket closed (${code})`)));

  /** Next frame, or a rejection if the socket died or nothing came in time. */
  const nextFrame = (timeoutMs: number): Promise<GatewayFrame> =>
    new Promise<GatewayFrame>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) {
        resolve(queued);
        return;
      }
      if (dead) {
        reject(dead);
        return;
      }
      const timer = setTimeout(() => {
        waiter = null;
        deadWaiter = null;
        reject(new DashboardStreamQuietError(framesSeen, lastEvent));
      }, timeoutMs);
      waiter = (frame) => {
        clearTimeout(timer);
        deadWaiter = null;
        resolve(frame);
      };
      deadWaiter = (err) => {
        clearTimeout(timer);
        waiter = null;
        reject(err);
      };
    });

  try {
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("dashboard socket connect timed out")), CONNECT_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Ask for the session, then read until its reply. The server opens with a
    // `gateway.ready` event and keeps emitting housekeeping events throughout,
    // so the reply is found by its id rather than by position.
    const wantResume = Boolean(req.sessionId);
    const rpcId = 1;
    let lastRpcId = rpcId;
    const nextRpcId = () => ++lastRpcId;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        method: wantResume ? "session.resume" : "session.create",
        params: wantResume
          ? {
              session_id: req.sessionId,
              // The transcript is ours: `/setup-api/chat/history` serves it from
              // our own store. Replaying the whole conversation over this socket
              // would be a large payload nothing reads.
              omit_messages: true,
              source: "clawbox-chat",
            }
          : {
              ...(req.model ? { model: req.model } : {}),
              ...(req.provider ? { provider: req.provider } : {}),
              ...(req.reasoning ? { reasoning_effort: req.reasoning } : {}),
              source: "clawbox-chat",
            },
      }),
    );

    /**
     * Read frames until the reply to `id` arrives, ignoring events on the way.
     *
     * The server opens with `gateway.ready` and keeps emitting housekeeping
     * events throughout, so a reply is found by its id rather than by position.
     */
    const awaitReply = async (id: number, timeoutMs: number): Promise<GatewayFrame> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (Date.now() > deadline) throw new Error("dashboard reply timed out");
        const frame = await nextFrame(Math.max(1, deadline - Date.now()));
        if (frame.id === id) return frame;
      }
    };

    const sessionFrame = await awaitReply(rpcId, SESSION_TIMEOUT_MS);
    if (sessionFrame.error) {
      throw new Error(String(sessionFrame.error.message || "dashboard refused the session"));
    }
    const result = sessionFrame.result || {};
    const transportSid = typeof result.session_id === "string" ? result.session_id : "";
    const stored = result.stored_session_id;
    const sessionId = typeof stored === "string" && stored ? stored : req.sessionId || "";
    if (!transportSid) throw new Error("dashboard returned no session handle");

    // What this session is ACTUALLY set to run, as the dashboard reports it.
    // `session.resume` returns it in `info` ({model, provider, reasoning_effort,
    // …}); `session.create` returns the model there too. This is the only
    // trustworthy answer to "which model will the next turn use" — the pills in
    // our UI are a request, not a fact.
    const info = (result.info || {}) as Record<string, unknown>;
    let activeModel = typeof info.model === "string" ? info.model : "";
    let activeProvider = typeof info.provider === "string" ? info.provider : "";
    // Whether `activeProvider` is the REQUEST's slug (a session this turn
    // built, or switched) rather than the dashboard's report — the former is
    // true by contract and needs no resolving.
    let providerFromRequest = false;
    const activeReasoning = typeof info.reasoning_effort === "string" ? info.reasoning_effort : "";
    // On a FRESH session the override is part of the create call itself and is
    // honoured by contract (`session.create` builds the agent with it), so the
    // request is the truth here even if `info` was assembled before the build.
    if (!wantResume && req.model) {
      activeModel = req.model;
      if (req.provider) {
        activeProvider = req.provider;
        providerFromRequest = true;
      }
    }

    // ── Making a mid-conversation switch REAL ────────────────────────────
    //
    // `session.create` takes model/provider/reasoning_effort as per-session
    // overrides, so the FIRST turn of a chat already lands on the picked model.
    // `session.resume` takes none of them — it restores the session's stored
    // override and ignores anything else in params — so every LATER turn used
    // to run on whatever the conversation started with. Changing the pills
    // mid-chat therefore did nothing at all: a session opened on claude-fable-5
    // kept answering from claude-fable-5 after being switched to gpt-5.6-sol,
    // and said so when asked.
    //
    // Upstream's own answer to this is `/model <id> --provider <slug> --session`,
    // which is what the dashboard's Chat tab runs when its picker changes. It
    // swaps the live agent's client in place and pins the choice as a
    // PER-SESSION override; `resolve_persist_behavior` returns false for
    // `--session`, so config.yaml is never written and — upstream's own words —
    // the switch cannot leak "into every OTHER live session's next agent
    // rebuild". A chat turn must never change the box's default, and with this
    // flag it cannot.
    //
    // Skipped ONLY when the session is already provably on the requested model.
    // The switch costs ~3.3s on this hardware (it rebuilds the agent's client),
    // which is most of a fast turn, so re-asserting a model the session already
    // runs is worth avoiding — but silence is not proof: when the dashboard did
    // not say what the session is on, the turn is switched rather than assumed,
    // because assuming is precisely the bug this fixes.
    //
    // Compared on the MODEL id alone. `info.provider` reports a user-defined
    // provider by its KIND (`custom`) rather than its slug (`clawai`), so
    // comparing providers would report a difference on every single turn and
    // pay that cost forever.
    let switchedModel = false;
    const alreadyOnModel = Boolean(activeModel) && activeModel === req.model;
    if (wantResume && req.model && !alreadyOnModel) {
      // An id that cannot go on a command line safely does not go on one. The
      // turn drops to the CLI instead, where the same values travel as separate
      // argv elements and cannot become flags.
      if (!commandSafe(req.model) || (req.provider && !commandSafe(req.provider))) {
        throw new Error("model or provider is not safe to switch with");
      }
      const switchId = nextRpcId();
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: switchId,
          method: "slash.exec",
          params: {
            session_id: transportSid,
            command: `/model ${req.model}${req.provider ? ` --provider ${req.provider}` : ""} --session`,
          },
        }),
      );
      const switched = await awaitReply(switchId, SWITCH_TIMEOUT_MS);
      // A switch that did not take gives this transport UP, rather than
      // answering on the wrong model.
      //
      // There is a real case for it, found on the box: switching TO a
      // user-defined provider is refused, because the switch validates the
      // model against the target provider's model listing, and a
      // `providers.<slug>` entry in config.yaml used to carry none. On this
      // device that is `clawai` — the DEFAULT provider — so "go back to ClawBox
      // AI mid-conversation" was exactly the combination that could not be made
      // here. `applyClawaiToHermes` now declares that listing, so the clawai
      // case should no longer arise on a box this code has written; the guard
      // stays because a refusal is a thing the transport must read either way —
      // for a model outside the declared list, or a provider we never wrote —
      // and because nothing in this process can prove the switch took.
      //
      // Throwing lands in the catch below, which returns null, and the route
      // then spawns the CLI for this turn. That path passes `-m` and
      // `--provider` as argv rather than re-pointing the session — it does
      // carry `--resume <sid>` on a threaded turn, so it is not the fresh
      // process this comment used to claim, and whether argv beats a
      // per-session override there is the one thing about it still unverified
      // on a box (`cliServedPair` in the route says the same). The turn is
      // slower and not streamed, and it is ANSWERED BY THE MODEL THE CUSTOMER PICKED —
      // which is the property that matters more.
      if (!modelSwitchTook(switched)) {
        throw new Error(`dashboard would not switch this session to ${req.model}`);
      }
      activeModel = req.model;
      if (req.provider) {
        activeProvider = req.provider;
        providerFromRequest = true;
      }
      // The switch WIPES the session's reasoning effort — see below.
      switchedModel = true;
    }
    // What the DASHBOARD reported is resolved once, here, so the handle below
    // and the completion frame report the same thing — see servedProviderSlug.
    // What the request set stands as it is.
    if (!providerFromRequest) {
      activeProvider = servedProviderSlug(activeProvider, req, Boolean(activeModel) && activeModel === req.model);
    }

    // ── Putting the reasoning level back after a switch takes it away ────
    //
    // `/model … --session` rebuilds the session's agent, and the rebuild does
    // not carry the reasoning effort across. Measured on the live box, one
    // session, three steps: `session.create` with `reasoning_effort: "medium"`
    // reported `medium`; the very next `/model claude-fable-5 --provider
    // anthropic --session` reported `""`; nothing else was sent in between.
    //
    // That is the whole of the missing-thinking bug. Anthropic with no effort
    // set returns SIGNATURE-ONLY thinking blocks — `{"type":"thinking",
    // "thinking":"","signature":"…"}` — so `state.db` stores a
    // `reasoning_details` blob with no text in it and leaves `reasoning` and
    // `reasoning_content` NULL, and the turn record has no monologue to show.
    // Of the 24 such rows on the box, 23 were exactly that shape, and the one
    // that carried real thinking text carried it in `reasoning` too. The
    // capture was never broken; the LEVEL was being thrown away, on every turn
    // where the customer's pills caused a switch.
    //
    // `config.set` with a session id and a non-global scope is upstream's own
    // session-scoped door (server.py :11936, the `reasoning` branch at
    // :12394): it sets `create_reasoning_override` and the live agent's
    // `reasoning_config`, and it explicitly does NOT write config.yaml —
    // upstream's own comment says writing there "let every desktop model-menu
    // selection rewrite the user's global agent.reasoning_effort". A chat turn
    // must never change the box's default, and by this door it cannot.
    //
    // Sent when a switch has just cleared the level, and also when a resumed
    // session simply reports a different one — a session wiped by an EARLIER
    // turn's switch resumes with the wiped value, and re-asserting is the only
    // thing that repairs it. Best-effort by design: a box that refuses this
    // answers on the level it already had, which is what it does today.
    if (req.reasoning && (switchedModel || activeReasoning !== req.reasoning)) {
      const effortId = nextRpcId();
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: effortId,
          method: "config.set",
          params: {
            session_id: transportSid,
            key: "reasoning",
            value: req.reasoning,
            scope: "session",
          },
        }),
      );
      await awaitReply(effortId, SESSION_TIMEOUT_MS).catch(() => null);
    }

    // ── A question that was already waiting before we got here ───────────
    //
    // Not an event, and that is the whole trap. A clarify emitted while nobody
    // was connected is NOT re-emitted on reconnect — it is folded into the
    // RESULT of `session.resume` / `session.info` as `pending_clarify`
    // (server.py `_pending_clarify_request_payload` :1946, attached at :8971),
    // carrying the original payload, its `request_id`, and — for a batch — the
    // `answers` locked in so far. A reader that only listens for
    // `clarify.request` therefore resumes a conversation whose agent is parked
    // on a question, sees nothing at all, and waits out its idle window while
    // the answer it needs is sitting in the reply it already received.
    //
    // Read here and emitted at the top of `run`, rather than handed to the
    // caller now, because `openDashboardTurn` has no `onActivity` to give it
    // to and a caller that never runs the turn has no surface to draw it on.
    const replayClarify = normaliseClarify(result.pending_clarify);
    /**
     * Request ids the caller has already been told about.
     *
     * The dedupe exists because the replayed payload and a live
     * `clarify.request` are the SAME question when the agent re-emits on
     * reconnect, and a surface handed it twice draws two forms — the second
     * one empty, over the top of the half-filled one the customer was typing
     * into. Keyed on `request_id` because that is the identity the gateway
     * itself uses: one id, one prompt, one answer.
     */
    const announcedClarifies = new Set<string>();

    let started = false;
    return {
      sessionId,
      model: activeModel,
      provider: activeProvider,
      close,
      async run(
        onDelta: (chunk: string) => void,
        onActivity?: (activity: DashboardActivity) => void,
      ): Promise<DashboardTurnFinal> {
        if (started) throw new Error("this turn has already run");
        started = true;
        // Name the abort BEFORE closing. Closing alone made `run` reject with
        // `dashboard socket closed (<code>)`, which the route's `isAbort` check
        // cannot match — so a user pressing Stop was recorded in the customer's
        // transcript as a failed turn. `isAbort` tests for a real DOMException,
        // which is why this is not a plain Error with the name set.
        const onAbort = () => {
          fail(new DOMException("aborted", "AbortError") as unknown as Error);
          close();
        };
        req.signal?.addEventListener("abort", onAbort, { once: true });
        /**
         * The clarify this turn is currently blocked on, or "".
         *
         * One id rather than a set: the gateway blocks the agent's worker
         * thread on a single Event, so there is exactly one outstanding
         * clarify per session by construction — a batch is one request_id
         * covering many questions, not many requests.
         */
        let pendingClarifyId = "";
        /**
         * The `clarify.respond` this turn sent on the customer's behalf.
         *
         * Held until the gateway acknowledges it, because until then nothing
         * is known: whether the answer landed, whether the prompt had already
         * expired, and whether the batch still has questions in it. Nulled the
         * moment the acknowledgement is read.
         */
        let forwarded: { rpcId: number; clarify: ClarifyActivity; questionId: string; answer: string } | null = null;
        /** The turn's own prompt, sent at most once whichever path gets there. */
        let promptSent = false;
        const submitPrompt = () => {
          if (promptSent) return;
          promptSent = true;
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: nextRpcId(),
              method: "prompt.submit",
              params: { session_id: transportSid, text: req.text },
            }),
          );
        };
        try {
          // ── A message arriving on a session parked on a question ─────────
          //
          // That message IS the answer, and forwarding it is the whole of
          // TASK-610. What used to happen instead, read out of hermes 0.20.5
          // on the box: `prompt.submit` for a session whose worker is parked
          // takes the BUSY path (methods_prompt.py:346 → `_handle_busy_submit`
          // server.py:8233), which queues the text and fires
          // `agent.interrupt()` at a thread sitting in `ev.wait()`. Nothing on
          // that path touches the clarify registry — the only thing that
          // releases the Event is `_clear_pending` (server.py:3693), reached
          // only from `session.interrupt`. So the customer got their own
          // question replayed at them, their message sat in `queued_prompt`,
          // and the session stayed unusable for the rest of the window.
          //
          // `clarify.respond` is hermes' own door for this (dispatch
          // methods_prompt.py:1413 → `_respond` server.py:11900) and needs no
          // session id: `_pending` is a flat request_id → (sid, Event) map
          // (server.py:3496), which is why the dashboard SPA, a second browser
          // and this turn can all answer the same prompt.
          //
          // It is also what hermes' OWN channel adapters do. An inbound
          // Telegram/WhatsApp/Discord/Slack message is checked against the
          // pending clarify before it is dispatched as a turn
          // (gateway/run.py:16824 the text intercept, gateway/platforms/base.py:6171
          // the busy-bypass that gets it there at all — its comment: "leaving
          // the agent blocked and discarding the user's answer"). Those run on
          // hermes' second, session-indexed registry (tools/clarify_gateway.py:71),
          // which this transport cannot reach; this is the same behaviour on
          // the surface that has none of it, through the RPC that surface owns.
          //
          // Deliberately NOT capped at the HTTP route's MAX_ANSWER_CHARS: that
          // cap exists because that route takes a body from any client against
          // an arbitrary request id, while this text is this turn's own prompt,
          // which the transport was about to carry wholesale anyway.
          if (replayClarify) {
            announcedClarifies.add(replayClarify.requestId);
            const qid = req.text ? answerableQid(replayClarify) : null;
            if (qid !== null) {
              const rpcId = nextRpcId();
              forwarded = { rpcId, clarify: replayClarify, questionId: qid, answer: req.text };
              socket.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpcId,
                  method: "clarify.respond",
                  params: {
                    request_id: replayClarify.requestId,
                    answer: req.text,
                    // Only when there is one. An empty `question_id` against a
                    // batch is upstream's cancel-all, not a harmless default.
                    ...(qid ? { question_id: qid } : {}),
                  },
                }),
              );
              // The question is NOT announced yet, and the long window is NOT
              // armed yet. Both wait for the acknowledgement, on purpose:
              // drawing an answerable form for a question this turn has just
              // answered invites the customer to answer it twice, and while
              // the gateway is the one being waited on — for milliseconds —
              // silence is evidence exactly as it is anywhere else. If the
              // acknowledgement never comes, the ordinary watchdog says so in
              // three minutes instead of holding the turn open for an hour.
            } else if (onActivity) {
              // Nothing to forward it to — every question is already answered,
              // or this turn has no text of its own. The question goes out as
              // it always did.
              //
              // Armed ONLY when there is somewhere for the question to go.
              //
              // The hour-long window is justified by a PERSON being able to
              // read the prompt and answer it. `onActivity` is optional — a
              // caller that only wants the answer text passes none — and such
              // a caller can never show the question to anybody. Arming the
              // long window for it would park the turn for an hour on a prompt
              // with no surface, which is precisely the failure this whole
              // branch exists to prevent, merely reintroduced from the other
              // side.
              //
              // Without a surface the turn keeps the ordinary idle window and
              // gives up in three minutes. That is the honest outcome: the
              // question cannot be answered on this transport, and saying so
              // quickly beats waiting an hour to say the same thing.
              pendingClarifyId = replayClarify.requestId;
              onActivity(replayClarify);
            }
          }
          // Held back only while an answer this turn forwarded is in flight:
          // the same text as both the answer AND a fresh prompt would be two
          // turns off one message. Every other path submits immediately, and
          // the acknowledgement branch below submits it after a refusal or an
          // expiry, so a message is never swallowed.
          if (!forwarded) submitPrompt();
          let answer = "";
          let reasoning = "";
          let truncated = false;
          for (;;) {
            // The one place the two windows are chosen between. While a person
            // is being waited on, silence is the expected shape of the wire and
            // the clock has to match the one the AGENT is running (3600s); the
            // rest of the time silence is evidence and three minutes is plenty.
            const frame = await nextFrame(pendingClarifyId ? CLARIFY_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS);
            const type = frameType(frame);
            // ── What the gateway made of the answer we forwarded ───────────
            //
            // Read HERE, in the frame loop, and never with `awaitReply`: that
            // helper discards every frame that is not the reply it wants, and
            // the answer UNPARKS the agent — so the resumed turn's own deltas
            // can arrive before the acknowledgement does, and awaiting it
            // would eat the beginning of the customer's answer.
            if (forwarded && frame.id === forwarded.rpcId) {
              const sent = forwarded;
              forwarded = null;
              const result = (frame.result || {}) as Record<string, unknown>;
              const refused = frame.error ? String(frame.error.message || "the dashboard refused the answer") : "";
              const expired = !refused && result.status === "expired";
              if (refused || expired) {
                // NOT reported as answered — the whole false-success class in
                // one branch. A refusal leaves the question standing, so it
                // goes out as a live prompt; an expiry means the window had
                // already closed, so the card comes down instead of leaving
                // somebody typing into a prompt nothing can deliver.
                if (refused) console.warn(`[hermes-stream] clarify answer refused: ${refused}`);
                if (onActivity) {
                  if (expired) {
                    onActivity({ kind: "clarifyExpire", requestId: sent.clarify.requestId });
                  } else {
                    pendingClarifyId = sent.clarify.requestId;
                    onActivity(sent.clarify);
                  }
                }
                // And the message is still the customer's turn either way.
                submitPrompt();
                continue;
              }
              const answered = { ...(sent.clarify.answered ?? {}), [sent.questionId]: sent.answer };
              const stillOpen = clarifyStillOpen(result.remaining, sent.clarify, answered);
              if (onActivity) onActivity({ ...sent.clarify, answered });
              // Still open means a person is still being waited on — the rest
              // of the batch — so the human-shaped window stays. Fully
              // answered means the AGENT is working again, and a working agent
              // is held to the same three minutes as any other turn.
              pendingClarifyId = stillOpen && onActivity ? sent.clarify.requestId : "";
              continue;
            }
            // The turn talking again is the only proof available here that the
            // answer landed — it was sent over someone else's socket, and no
            // acknowledgement of it ever reaches this reader. Narrowing the
            // window back the moment the agent resumes is what keeps a turn
            // that wedges AFTER a clarify from holding the response for an hour.
            if (pendingClarifyId && TURN_PROGRESS.has(type)) pendingClarifyId = "";
            switch (type) {
              case EVENT.messageDelta: {
                const chunk = payloadText(frame);
                if (!chunk) break;
                if (answer.length + chunk.length > MAX_TEXT_BYTES) {
                  truncated = true;
                  break;
                }
                answer += chunk;
                onDelta(chunk);
                break;
              }
              case EVENT.reasoningDelta:
                // Collected, never forwarded. The bubble shows the answer; the
                // monologue belongs behind the reasoning disclosure, and the
                // authoritative copy is read from the agent's database at the end.
                if (reasoning.length < MAX_TEXT_BYTES) reasoning += payloadText(frame);
                break;
              case EVENT.thinkingDelta: {
                // NEVER collected into `reasoning` — see EVENT.thinkingDelta.
                // This is the spinner's status line, and a turn whose model
                // reasons about nothing must end with NO reasoning rather than
                // a kaomoji. It is still a heartbeat, and now it is a visible
                // one: forwarded as ACTIVITY, which no path folds into the
                // monologue. Arriving here has already restarted the idle
                // clock, in `nextFrame`, for every frame alike.
                const status = payloadText(frame);
                if (status && onActivity) onActivity({ kind: "status", text: status });
                break;
              }
              case EVENT.toolGenerating:
                // Counted as liveness, deliberately NOT shown.
                //
                // It carries no tool id and it names the tool differently from
                // the call that follows: captured on the box, one turn emitted
                // `tool.generating name=mcp__web_search` and then `tool.start
                // name=web_search id=toolu_01Nf…`. Forwarding it would draw a
                // pill under a name the customer never sees again and an id
                // no `tool.complete` can ever close, so the chat would end the
                // turn with two steps stuck at "running" beside the two that
                // actually finished. `tool.start` follows within a couple of
                // seconds and carries both, so nothing is lost by waiting for
                // it. Named in EVENT so it is a decision, not an unknown frame.
                break;
              case EVENT.toolStart: {
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const name = typeof payload.name === "string" ? payload.name : "";
                if (!name) break;
                const id = typeof payload.tool_id === "string" && payload.tool_id ? payload.tool_id : `start:${name}`;
                const context = typeof payload.context === "string" ? payload.context : "";
                if (onActivity) {
                  onActivity({ kind: "tool", phase: "start", id, name, ...(context ? { detail: context } : {}) });
                }
                break;
              }
              case EVENT.toolComplete: {
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const name = typeof payload.name === "string" ? payload.name : "";
                if (!name) break;
                const id = typeof payload.tool_id === "string" && payload.tool_id ? payload.tool_id : `start:${name}`;
                const summary = typeof payload.summary === "string" ? payload.summary : "";
                if (onActivity) {
                  onActivity({
                    kind: "tool",
                    phase: "result",
                    id,
                    name,
                    ...(summary ? { detail: summary } : {}),
                    status: "ok",
                  });
                }
                break;
              }
              case EVENT.approvalRequest: {
                // Answer immediately. The agent thread is parked waiting for
                // this and will not make another model call until it lands.
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const requestId = payload.request_id;
                socket.send(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: nextRpcId(),
                    method: "approval.respond",
                    params: {
                      session_id: transportSid,
                      choice: APPROVAL_CHOICE,
                      ...(typeof requestId === "string" && requestId ? { request_id: requestId } : {}),
                    },
                  }),
                );
                break;
              }
              case EVENT.clarifyRequest: {
                // NOT auto-answered, and that is the difference from the case
                // directly above. An approval asks whether a tool this route
                // already permits may run, so answering it "once" grants
                // nothing new and keeps the chat as capable as it was. A
                // clarify asks the CUSTOMER something only they know — which
                // file, which of these three, what should it be called — and
                // there is no default that is not a guess put in their mouth.
                // Answering it here would produce a confidently wrong turn,
                // which is worse than the hang it would be curing.
                //
                // So it is forwarded and the turn WAITS, on the long window,
                // for as long as hermes itself is prepared to wait.
                const clarify = normaliseClarify(frame.params?.payload);
                if (!clarify) break;
                // Already announced — this is the same question replayed by a
                // resume, not a second one. The customer is looking at it.
                if (announcedClarifies.has(clarify.requestId)) {
                  if (onActivity) pendingClarifyId = clarify.requestId;
                  break;
                }
                announcedClarifies.add(clarify.requestId);
                // Same rule as the replay branch above: the long window is
                // armed only when the prompt actually reached a surface that
                // can answer it.
                if (onActivity) {
                  pendingClarifyId = clarify.requestId;
                  onActivity(clarify);
                }
                break;
              }
              case EVENT.clarifyExpire: {
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
                if (!requestId) break;
                // Only the matching id stands the turn down. An expiry naming
                // some OTHER request — a stale one, or another session's, since
                // this transport carries frames the turn did not cause — must
                // not shorten the window the customer is still typing inside.
                if (pendingClarifyId === requestId) pendingClarifyId = "";
                if (onActivity) onActivity({ kind: "clarifyExpire", requestId });
                break;
              }
              case EVENT.messageComplete: {
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const finalText = typeof payload.text === "string" ? payload.text : answer;
                const finalReasoning = typeof payload.reasoning === "string" ? payload.reasoning : reasoning;
                const status = typeof payload.status === "string" ? payload.status : "complete";
                const error = typeof payload.error === "string" ? payload.error : "";
                // The turn may name the model that served it; otherwise the one
                // this session was settled on above is the answer.
                const servedModel = typeof payload.model === "string" && payload.model ? payload.model : activeModel;
                // A completion's `provider` is the same field with the same
                // kind-not-slug problem, and it is decided by the SAME rule the
                // session site applies — that site's guard was missing here,
                // which is how a session this turn BUILT on the literal
                // `custom` provider lost it again on the way out: the frame
                // reports `custom` (it must — the session is on custom), and
                // the resolver cannot tell that word's two meanings apart.
                //
                // So, in order:
                //   - off the settled model, the frame describes a pairing this
                //     turn never established: only the frame's own provider can
                //     speak for it, and a bare frame answers nothing;
                //   - on the settled model, a session this turn built or
                //     switched stands on the request's provider BY CONTRACT —
                //     but only against a frame that says the KIND or says
                //     nothing. A frame naming a different canonical SLUG is the
                //     harness telling us where it actually routed, and the
                //     harness's own word outranks our contract every time;
                //   - otherwise the frame's report is resolved, and a frame that
                //     names none defers to what the session was settled on —
                //     NOT to the request, which the session may have contradicted.
                const completionProvider = typeof payload.provider === "string" ? payload.provider : "";
                const onSettledModel = servedModel === activeModel;
                const frameNamesASlug = Boolean(completionProvider) && completionProvider !== DASHBOARD_PROVIDER_KIND;
                const servedProvider = onSettledModel && providerFromRequest && !frameNamesASlug
                  ? activeProvider
                  : completionProvider
                    ? servedProviderSlug(completionProvider, req, servedModel === req.model)
                    : onSettledModel
                      ? activeProvider
                      : "";
                return {
                  text: truncated ? `${finalText}\n\n[Reply truncated — it was too long to hold.]` : finalText,
                  reasoning: finalReasoning,
                  status,
                  ...(error ? { error } : {}),
                  ...(servedModel ? { model: servedModel } : {}),
                  ...(servedProvider ? { provider: servedProvider } : {}),
                };
              }
              case EVENT.error: {
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const message = typeof payload.message === "string" ? payload.message : "";
                throw new Error(message || "the agent reported an error");
              }
              default:
                // Every other frame is display detail this route does not
                // render (tool chips, usage, session info). Logged only when
                // asked, because the failure mode this exists for — the agent
                // parked on a prompt nobody answered — is invisible from the
                // outside and cost an afternoon to find once already.
                if (DEBUG_FRAMES && type) console.log(`[hermes-stream] ${type}`);
                break;
            }
          }
        } finally {
          req.signal?.removeEventListener("abort", onAbort);
          close();
        }
      },
      async respondToClarify(requestId: string, answer: string, questionId?: string): Promise<void> {
        const id = nextRpcId();
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "clarify.respond",
            // No `session_id`, and that is upstream's contract rather than an
            // omission: `_respond` resolves the session from a global pending
            // registry keyed by request id (server.py :11898), which is why any
            // authenticated dashboard socket can answer — including one opened
            // after the socket that asked the question has gone.
            //
            // `question_id` is sent only when there is one. Against a BATCH an
            // answer with no question_id is upstream's cancel-all, so an empty
            // string here would not be a harmless default; it would throw away
            // every other question in the same prompt.
            params: {
              request_id: requestId,
              answer,
              ...(questionId ? { question_id: questionId } : {}),
            },
          }),
        );
        const reply = await awaitReply(id, SESSION_TIMEOUT_MS);
        if (reply.error) {
          throw new Error(String(reply.error.message || "the dashboard refused the answer"));
        }
        // `{ status: "expired" }` is a successful call whose window had closed —
        // `_respond` is invoked with `allow_expired=True` precisely so a late
        // answer is reported rather than raised. Throwing on it would turn a
        // customer being a few seconds slow into an error in their transcript.
      },
    };
  } catch {
    close();
    return null;
  }
}
