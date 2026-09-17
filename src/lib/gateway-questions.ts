// ── The agent's own question, as the OpenClaw gateway raises it ─────────────
//
// WHAT THIS IS FOR. When an OpenClaw agent needs a decision that belongs to the
// person, it calls `ask_user`, and the gateway parks the run on a QUESTION
// RECORD until someone answers it. OpenClaw's own Control UI docks a question
// panel over the composer; ClawBox rendered nothing at all, so on this box the
// turn showed a tool pill reading "ask user · running…" and then sat there for
// the full fifteen-minute timeout with no way to reply. This module is the
// reading half of the card that answers it; `chat-question.tsx` is the face.
//
// HARNESS FIRST, AND THE HARNESS OWNS ALL OF IT. Nothing here invents a queue,
// an id, an expiry or a delivery. Read off the pinned core (tag `v2026.9.3`):
//
//   * `question.requested` carries the QuestionRecord ITSELF — not an envelope
//     around it, unlike `session.approval`. `src/gateway/server-methods/question.ts`
//     broadcasts `context.broadcast("question.requested", record)`.
//   * `question.resolved` carries `{id, status}` plus `answers` when answered
//     (`QuestionResolvedEventSchema`): answered | cancelled | expired.
//   * Both events are gated on the `operator.questions` scope
//     (`EVENT_SCOPE_GUARDS` in `src/gateway/server-broadcast.ts`), and
//     `operator.admin` — which this chat's connect frame already carries —
//     satisfies every guard. Neither event is in `SESSION_SUBSCRIPTION_EVENTS`,
//     so no extra subscribe is needed to receive them.
//   * `question.list` takes `{}` and answers `{questions: QuestionRecord[]}` —
//     the whole set this client may see, which is why the reader below filters
//     to the session the surface is bound to.
//   * `question.resolve` takes EITHER `{id, answers: {answers: {qid: string[]}}}`
//     or `{id, cancel: true}` (`QuestionResolveParamsSchema`), and answers
//     `{status: "answered", answers} | {status: "cancelled"}`.
//
// SKIP IS `cancel: true`, NOT AN EMPTY ANSWER. The gateway's own
// `validateAnswers` refuses an empty or missing value for every question in the
// record ("requires an answer"), so a Skip built as `{qid: []}` would come back
// as an error with the agent still parked. The Control UI's Skip calls
// `cancelQuestionPrompt` → `{id, cancel: true}`, the tool then returns
// `status: "no_answer"`, and the agent continues on its own judgment. That is
// the only skip the protocol has.

/** The events the chat listens for. Names are the core's. */
export const QUESTION_REQUESTED_EVENT = "question.requested";
export const QUESTION_RESOLVED_EVENT = "question.resolved";

/** Every state the gateway records for a question. `pending` is the live one. */
export type QuestionStatus = "pending" | "answered" | "cancelled" | "expired";

/** One offered answer. `description` is the subtitle under the label. */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

/**
 * One question of a record — at most three, `QuestionRecordSchema`.
 *
 * `isOther` decides whether a free-text answer is ACCEPTED, not merely offered:
 * the manager refuses a value that is not a declared option label when it is
 * false. `ask_user` always sets it true (`ask-user-tool-normalization.ts`), so
 * the row is normally there; a question minted by something else may not have
 * it, and offering a box whose answer the gateway would reject is the "false
 * success" this reads the flag to avoid.
 */
export interface QuestionItem {
  readonly questionId: string;
  /** Short tag, capped at 12 characters by the protocol. */
  readonly header: string;
  readonly question: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  readonly isOther: boolean;
  /** A credential is being asked for: never echoed, never shown as typed. */
  readonly isSecret: boolean;
}

export interface QuestionCard {
  readonly id: string;
  /** The gateway session this belongs to. Empty means "not attributable". */
  readonly sessionKey: string;
  readonly runId?: string;
  readonly questions: readonly QuestionItem[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly status: QuestionStatus;
  /** qid → the values recorded, once answered. */
  readonly answers?: Readonly<Record<string, readonly string[]>>;
  /** A submit or skip is in flight; the controls are locked until it lands. */
  readonly busy?: "submit" | "skip";
  /** Why the last attempt did not reach the gateway. Never a decision. */
  readonly error?: string;
}

/** The box's own "the gateway answered something unreadable" marker. */
export const QUESTION_NO_OUTCOME_RECORDED = "clawbox:no-outcome-recorded";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStatus(value: unknown): QuestionStatus | null {
  return value === "pending" || value === "answered" || value === "cancelled" || value === "expired"
    ? value
    : null;
}

function readOption(raw: unknown): QuestionOption | null {
  const record = asRecord(raw);
  const label = record ? asText(record.label) : "";
  if (!label) return null;
  const description = record ? asText(record.description) : "";
  return description ? { label, description } : { label };
}

function readQuestionItem(raw: unknown): QuestionItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const questionId = asText(record.questionId);
  const question = asText(record.question);
  // A question with no id cannot be answered — `question.resolve` keys the
  // answers by it — and one with no text cannot be asked. Either way there is
  // nothing to put on screen, and half a question is worse than none.
  if (!questionId || !question) return null;
  const options: QuestionOption[] = [];
  if (Array.isArray(record.options)) {
    for (const entry of record.options) {
      const option = readOption(entry);
      if (option) options.push(option);
    }
  }
  return {
    questionId,
    header: asText(record.header),
    question,
    options,
    multiSelect: record.multiSelect === true,
    isOther: record.isOther === true,
    isSecret: record.isSecret === true,
  };
}

/** qid → values, own properties only. */
function readAnswers(raw: unknown): Record<string, readonly string[]> | undefined {
  const envelope = asRecord(raw);
  const answers = envelope ? asRecord(envelope.answers) : null;
  if (!answers) return undefined;
  const out: Record<string, string[]> = {};
  // `Object.hasOwn` rather than `in`: a question id is a string the model
  // chose, and `constructor` matches the protocol's own id grammar.
  for (const key of Object.keys(answers)) {
    if (!Object.hasOwn(answers, key)) continue;
    const values = answers[key];
    if (!Array.isArray(values)) continue;
    out[key] = values.filter((value): value is string => typeof value === "string");
  }
  return out;
}

/**
 * One `question.requested` payload, or one row of `question.list`.
 *
 * Answers `null` for anything this build cannot put a complete card behind: a
 * record with no readable question is a question the person would be invited to
 * answer blind, and the gateway would refuse whatever they sent.
 */
export function readQuestionRecord(raw: unknown): QuestionCard | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asText(record.id);
  if (!id || !Array.isArray(record.questions)) return null;
  const questions: QuestionItem[] = [];
  for (const entry of record.questions) {
    const item = readQuestionItem(entry);
    if (!item) return null;
    questions.push(item);
  }
  if (questions.length === 0) return null;
  const status = asStatus(record.status);
  if (!status) return null;
  const runId = asText(record.runId);
  const answers = readAnswers(record.answers);
  return {
    id,
    sessionKey: asText(record.sessionKey),
    ...(runId ? { runId } : {}),
    questions,
    createdAtMs: asMs(record.createdAtMs),
    expiresAtMs: asMs(record.expiresAtMs),
    status,
    ...(answers ? { answers } : {}),
  };
}

/**
 * Whether a card belongs to the conversation this surface is bound to.
 *
 * The record's `sessionKey` is the key the gateway STORED the question under
 * (`resolveStoredSessionKeyForAgentStore`), and the chat's is the one the hello
 * named, so the comparison is on the canonical form of both rather than on the
 * raw strings: the gateway lowercases session keys, and a bare `main` names the
 * same conversation the fully qualified `agent:main:main` does. A record with no
 * session key at all — a question from a standalone attached MCP client — is
 * deliberately NOT adopted: it belongs to no conversation on screen, and
 * answering it here would answer it on the owner's behalf from a card that
 * cannot say where it came from.
 */
export function questionBelongsToSession(card: QuestionCard, sessionKey: string): boolean {
  if (!card.sessionKey || !sessionKey) return false;
  return canonicalSessionKey(card.sessionKey) === canonicalSessionKey(sessionKey);
}

/** `agent:<id>:<key>` → `<id>/<key>`; a bare key → `main/<key>`. Lowercased. */
function canonicalSessionKey(key: string): string {
  const lower = key.trim().toLowerCase();
  const parts = lower.split(":");
  if (parts[0] === "agent" && parts.length >= 3) {
    return `${parts[1] || "main"}/${parts.slice(2).join(":")}`;
  }
  return `main/${lower}`;
}

/** `next` replacing any card with the same id, or appended, order preserved. */
export function mergeQuestionCard(cards: readonly QuestionCard[], next: QuestionCard): QuestionCard[] {
  const index = cards.findIndex((card) => card.id === next.id);
  if (index < 0) return [...cards, next];
  const kept = cards[index];
  // A replayed record carries the harness's truth; the press in flight is ours,
  // and survives only while the question is still open.
  const merged: QuestionCard =
    next.status === "pending" && kept.busy ? { ...next, busy: kept.busy } : next;
  return cards.map((card, i) => (i === index ? merged : card));
}

/**
 * The cards after a `question.resolved` event.
 *
 * The event may name a question this surface never drew — it is broadcast to
 * every client that may see the session — and that is not an error: an unknown
 * id is simply ignored rather than materialising a card with no questions on it.
 */
export function questionsAfterResolvedEvent(
  cards: readonly QuestionCard[],
  payload: unknown,
): QuestionCard[] {
  const record = asRecord(payload);
  const id = record ? asText(record.id) : "";
  const status = record ? asStatus(record.status) : null;
  if (!id || !status || status === "pending") return cards as QuestionCard[];
  const answers = readAnswers(record?.answers);
  return cards.map((card) =>
    card.id === id
      ? { ...card, status, ...(answers ? { answers } : {}), busy: undefined, error: undefined }
      : card,
  );
}

/** The params `question.resolve` takes for an answer. */
export function questionResolveParams(
  id: string,
  answers: Record<string, readonly string[]>,
): { id: string; answers: { answers: Record<string, string[]> } } {
  return {
    id,
    answers: {
      answers: Object.fromEntries(
        Object.entries(answers).map(([questionId, values]) => [questionId, [...values]]),
      ),
    },
  };
}

/** The params `question.resolve` takes for a Skip — the protocol's only one. */
export function questionSkipParams(id: string): { id: string; cancel: true } {
  return { id, cancel: true };
}

/** The card the owner just pressed, so it cannot be pressed twice. */
export function markQuestionBusy(
  cards: readonly QuestionCard[],
  id: string,
  busy: "submit" | "skip",
): QuestionCard[] {
  return cards.map((card) => (card.id === id ? { ...card, busy, error: undefined } : card));
}

/**
 * What the gateway RECORDED, folded into the card — never what was asked for.
 *
 * An answer that raced another surface's comes back as that surface's outcome
 * rather than as an error, exactly as `approval.resolve` does. A reply that is
 * not the documented shape leaves the card open and says so: an outcome this
 * could not read is not an outcome that happened.
 */
export function questionsAfterResolve(
  cards: readonly QuestionCard[],
  id: string,
  result: unknown,
): QuestionCard[] {
  if (!cards.some((card) => card.id === id)) return cards as QuestionCard[];
  if (result instanceof Error) {
    return cards.map((card) =>
      card.id === id ? { ...card, busy: undefined, error: result.message } : card,
    );
  }
  const record = asRecord(result);
  const status = record ? asStatus(record.status) : null;
  if (!status || status === "pending") {
    return cards.map((card) =>
      card.id === id ? { ...card, busy: undefined, error: QUESTION_NO_OUTCOME_RECORDED } : card,
    );
  }
  const answers = readAnswers(record?.answers);
  return cards.map((card) =>
    card.id === id
      ? { ...card, status, ...(answers ? { answers } : {}), busy: undefined, error: undefined }
      : card,
  );
}

/**
 * The cards after a `question.list`, for the session the surface is bound to.
 *
 * AUTHORITATIVE for what is still open: `question.list` answers with every
 * record this client may see, so a pending card it does not mention has been
 * resolved somewhere this socket could not hear about — on a phone, in the
 * Control UI, or while the socket was down — and leaving it on screen would
 * offer live buttons over a question nothing will ever settle. Terminal cards
 * are kept: they are the record of what happened.
 *
 * `requestedAtMs` is what keeps that authority honest. The answer describes the
 * moment the gateway read it, and a `question.requested` can land while the
 * call is in flight — the event's card would then be dropped by a list that
 * could not have known about it, which is the same question silently vanishing
 * that this whole feature exists to end. A pending card created at or after we
 * ASKED is therefore kept whether or not the answer mentions it.
 */
export function questionsAfterList(
  prev: readonly QuestionCard[],
  payload: unknown,
  sessionKey: string,
  requestedAtMs = Number.POSITIVE_INFINITY,
): QuestionCard[] {
  const record = asRecord(payload);
  const rows = record && Array.isArray(record.questions) ? record.questions : [];
  const listed: QuestionCard[] = [];
  for (const row of rows) {
    const card = readQuestionRecord(row);
    if (card && questionBelongsToSession(card, sessionKey)) listed.push(card);
  }
  return listed.reduce<QuestionCard[]>(
    (cards, card) => mergeQuestionCard(cards, card),
    prev.filter((card) => card.status !== "pending" || card.createdAtMs >= requestedAtMs),
  );
}

/**
 * Whether pressing anything on this card could still do something.
 *
 * The window is checked HERE rather than left to the gateway a second later:
 * the record carries its own `expiresAtMs`, the gateway refuses a late answer,
 * and offering a control that cannot work is the UI's own false success.
 */
export function questionIsActionable(card: QuestionCard, nowMs: number): boolean {
  if (card.status !== "pending") return false;
  if (card.busy) return false;
  return card.expiresAtMs > nowMs;
}
