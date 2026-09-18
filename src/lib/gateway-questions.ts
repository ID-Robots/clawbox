// ── The agent's own question, as the ClawBox chat shows it ──────────────────
//
// WHAT THIS IS FOR. OpenClaw's `ask_user` tool STOPS the turn and waits for a
// person: the agent posts 1-3 questions, each with 2-4 labelled options and an
// optional description per option, and blocks on `question.waitAnswer` until
// somebody resolves it or its timeout runs out. OpenClaw's own Control UI draws
// that as a card with the options numbered and a "type your own answer" box.
// ClawBox drew nothing — the chat showed a tool pill that sat on "running" for
// fifteen minutes and then a reply that began "No answer arrived; proceed with
// best judgment." The question was never on screen, so there was nothing the
// owner could have pressed.
//
// This is the sibling of `gateway-approvals.ts` and it follows the same rule:
// NOTHING HERE INVENTS A QUEUE. The lifecycle, the ids, the expiry and the
// first-answer-wins resolution are all the gateway's, read off the pinned
// 2026.8.1 core on the box:
//
//   * `question.requested` carries the whole `QuestionRecordSchema` —
//     `{id, questions[], agentId?, sessionKey?, runId?, createdAtMs,
//     expiresAtMs, status, answers?, resolvedBy?}` — and is broadcast under
//     the `operator.questions` scope (`operator.admin` is a superset, and the
//     chat's connect frame asks for both).
//   * `question.resolved` is the terminal half and is deliberately NARROW:
//     `{id, status}` plus `answers` when answered. It carries NO session key,
//     which is why this module matches it by id against what is already held.
//   * `question.list` answers the pending set (`{questions: […]}`), which is
//     how a reload or a reconnect gets its card back — the one thing the
//     Hermes clarify card cannot do, because there the wait lives in a turn.
//   * `question.resolve` takes `{id, answers: {answers: {qid: string[]}}}`
//     and answers `{status: "answered", answers}` — or `{id, cancel: true}`,
//     which this surface never sends: cancelling is the AGENT's own call
//     (`run-abort`, `wait-timeout`), and a button that threw the question away
//     would be a fourth way to leave an agent with no answer.
//
// THE GATEWAY WANTS EVERY ANSWER AT ONCE. `QuestionManager.validateAnswers`
// refuses a resolve whose map omits a question ("requires an answer") or
// carries an empty string ("contains an empty answer"), and a single-select
// question refuses more than one value. So a card with three questions posts
// ONE resolve carrying all three — the opposite of the Hermes clarify card,
// which posts once per question because there each qid unblocks on its own.
// That is also why there is no Skip here: an empty answer is not a value the
// gateway accepts.

/** The event the gateway broadcasts when the agent parks on a question. */
export const QUESTION_REQUESTED_EVENT = "question.requested";
/** …and the one it broadcasts when that question reaches a terminal state. */
export const QUESTION_RESOLVED_EVENT = "question.resolved";

/**
 * The box's own "that answer was not readable" marker, in `QuestionCard.error`.
 *
 * A MARKER and not a sentence, exactly as the approval card's is: `error`
 * otherwise carries the GATEWAY's words, which the card renders verbatim
 * because they are the truth about why a resolve was refused. A sentence
 * written here would be the one English line on a card whose every other word
 * is in the owner's language.
 */
export const QUESTION_NO_OUTCOME_RECORDED = "clawbox:no-question-outcome-recorded";

/** The operator scope those two events are guarded by. */
export const QUESTIONS_SCOPE = "operator.questions";

/** One offered answer. `description` is the line under the label. */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

/** One question of a request. */
export interface AskUserQuestion {
  readonly questionId: string;
  /** A ≤12-character chip the model chose; may be empty on a hand-made request. */
  readonly header: string;
  readonly question: string;
  /** 2-4 offered answers, or none for a free-text question. */
  readonly options: readonly QuestionOption[];
  /** Several options may be picked; the answer is then several values. */
  readonly multiSelect: boolean;
  /** An answer outside the options is accepted. `ask_user` always sets it. */
  readonly isOther: boolean;
}

/** Every state the gateway records. `pending` is the only actionable one. */
export type QuestionStatus = "pending" | "answered" | "cancelled" | "expired";

export interface QuestionCard {
  readonly id: string;
  /** The conversation it belongs to, as the gateway canonicalised it. */
  readonly sessionKey: string;
  readonly questions: readonly AskUserQuestion[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly status: QuestionStatus;
  /** What was recorded, per question id. Present only once answered. */
  readonly answers?: Readonly<Record<string, readonly string[]>>;
  /** A resolve is in flight — the owner's press, not the gateway's word. */
  readonly busy?: boolean;
  /** Why the last attempt did not reach the gateway. */
  readonly error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The gateway's own question-id alphabet (`QuestionIdSchema`: snake_case,
 * opening with a letter), REBUILT from the value rather than tested on it.
 *
 * A qid arrives off the wire and is then used as a property name — on the
 * answers map here, on the card's draft, and on the map posted back to
 * `question.resolve`. Testing the string and passing the original through
 * leaves the caller's string in play, which is the house rule this codebase
 * already keeps for every id that reaches a path (`safeAppId`,
 * `safeProjectId`, `safeSkillName`) and what CodeQL rightly flags as remote
 * property injection. `__proto__` is outside this alphabet by construction,
 * and an id the gateway itself would refuse can answer nothing anyway.
 */
const QUESTION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_";

function safeQuestionId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return "";
  let rebuilt = "";
  for (const character of trimmed) {
    if (!QUESTION_ID_ALPHABET.includes(character)) return "";
    rebuilt += character;
  }
  const first = rebuilt.charCodeAt(0);
  return first >= 97 && first <= 122 ? rebuilt : "";
}

function asStatus(value: unknown): QuestionStatus | null {
  return value === "pending" || value === "answered" || value === "cancelled" || value === "expired"
    ? value
    : null;
}

/**
 * One question, or null when there is nothing here a person could answer.
 *
 * A SECRET question is refused outright — `isSecret`, and the `secretStore`
 * binding beside it, mean the gateway expects a masked input whose value it
 * writes into the secret store. This chat has no masked field, so rendering it
 * as an ordinary text box would put a credential in a visible input, in React
 * state and in the transcript's own DOM. Refusing the card leaves the question
 * to a surface that can mask it; drawing it would be the wrong kind of help.
 */
function readQuestion(raw: unknown): AskUserQuestion | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.isSecret === true || asRecord(record.secretStore)) return null;
  const questionId = safeQuestionId(record.questionId);
  const question = asText(record.question);
  if (!questionId || !question) return null;
  const options: QuestionOption[] = [];
  if (Array.isArray(record.options)) {
    for (const entry of record.options) {
      const option = asRecord(entry);
      const label = asText(option?.label);
      // An option this could not read is a CHOICE MISSING from the card, and
      // the owner has no way to see that it is missing. Same rule as the
      // partial request below: refuse the question rather than quietly offer
      // three of the four answers the agent asked about. An empty `options`
      // is a different thing entirely — that is a free-text question.
      if (!label) return null;
      const description = asText(option?.description);
      options.push({ label, ...(description ? { description } : {}) });
    }
  }
  return {
    questionId,
    header: asText(record.header),
    question,
    options,
    multiSelect: record.multiSelect === true,
    // An OLDER gateway, or a hand-made `question.request`, may leave `isOther`
    // off. Free text is then offered anyway when there are no options at all,
    // because a question with neither options nor a text box is a card with no
    // answer on it — which is the state this whole feature exists to remove.
    isOther: record.isOther === true || options.length === 0,
  };
}

/** The answers map, with anything unusable dropped rather than half-read. */
function readAnswers(raw: unknown): Record<string, string[]> | null {
  const record = asRecord(raw);
  const answers = asRecord(record?.answers);
  if (!answers) return null;
  const out: Record<string, string[]> = {};
  for (const [rawId, values] of Object.entries(answers)) {
    const qid = safeQuestionId(rawId);
    if (!qid || !Array.isArray(values)) continue;
    const texts = values.filter((value): value is string => typeof value === "string");
    if (texts.length > 0) out[qid] = texts;
  }
  return out;
}

/**
 * One card off a `question.requested` event or a `question.list` row.
 *
 * Null on: a payload that is not an object, no id, a status this build cannot
 * read, and a request with no answerable question left in it (every one of
 * them secret, or unreadable).
 */
export function readQuestionCard(raw: unknown): QuestionCard | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asText(record.id);
  if (!id) return null;
  const status = asStatus(record.status);
  if (!status) return null;
  if (!Array.isArray(record.questions)) return null;
  const questions: AskUserQuestion[] = [];
  for (const entry of record.questions) {
    const question = readQuestion(entry);
    if (question) questions.push(question);
  }
  // PART of a request is not a request. The gateway refuses a resolve that
  // leaves any question unanswered, so a card drawn over a subset would offer
  // a Send that can only ever come back refused.
  if (questions.length === 0 || questions.length !== record.questions.length) return null;
  const answers = readAnswers(record.answers);
  const createdAtMs = asMs(record.createdAtMs, 0);
  return {
    id,
    sessionKey: asText(record.sessionKey),
    questions,
    createdAtMs,
    // No stated expiry means NO LOCAL EXPIRY — the same rule the approval card
    // keeps. Falling back to `createdAtMs` would grey the card out the instant
    // it appeared, over a question the gateway is still holding open.
    expiresAtMs: asMs(record.expiresAtMs, Number.POSITIVE_INFINITY),
    status,
    ...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
  };
}

/** What a `question.resolved` event says became of one question. */
export interface QuestionResolution {
  readonly id: string;
  readonly status: Exclude<QuestionStatus, "pending">;
  readonly answers?: Readonly<Record<string, readonly string[]>>;
}

/**
 * The terminal event, or null.
 *
 * Deliberately narrow, because the event is: it carries the id, the status and
 * — when answered — the answers, and NO session key. Matching by id against
 * the cards already held is therefore the whole of the filter, and it is the
 * right one: a card this surface never drew is an event about a conversation
 * it is not showing.
 */
export function readQuestionResolution(raw: unknown): QuestionResolution | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asText(record.id);
  const status = asStatus(record.status);
  if (!id || !status || status === "pending") return null;
  const answers = readAnswers(record.answers);
  return {
    id,
    status,
    ...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
  };
}

/**
 * Whether a question the gateway scoped to `questionKey` belongs to the
 * conversation this chat has bound.
 *
 * NOT a string equality, and that is deliberate. The record's `sessionKey` is
 * the CANONICAL store key (`resolveStoredSessionKeyForAgentStore`), which adds
 * the `agent:<id>:` namespace to a bare key like `main` — so the gateway may
 * well name the same conversation the chat bound in a longer form. Comparing
 * byte for byte would drop the card for exactly the session the question was
 * asked in, which is the failure this feature exists to remove.
 *
 * A record with NO session key belongs to whoever is watching: `ask_user` is a
 * primary-session tool, and a question nobody can place is still a question
 * somebody has to answer.
 */
export function questionBelongsToSession(questionKey: string, boundKey: string): boolean {
  const question = questionKey.trim().toLowerCase();
  const bound = boundKey.trim().toLowerCase();
  if (!question || !bound) return true;
  if (question === bound) return true;
  return question.endsWith(`:${bound}`) || bound.endsWith(`:${question}`);
}

/** `next` replacing any card with the same id, or appended, order preserved. */
export function mergeQuestionCard(
  cards: readonly QuestionCard[],
  next: QuestionCard,
): QuestionCard[] {
  const index = cards.findIndex((card) => card.id === next.id);
  if (index < 0) return [...cards, next];
  const kept = cards[index];
  // A pushed update carries the gateway's truth; the press in flight is ours,
  // and survives only while the card is still pending.
  const merged: QuestionCard = next.status === "pending" && kept.busy
    ? { ...next, busy: true }
    : next;
  return cards.map((card, i) => (i === index ? merged : card));
}

/**
 * The cards after a `question.list` read.
 *
 * `question.list` answers the PENDING set and only that (`manager.list()`
 * filters on `status === "pending"`), so a pending card it does not mention is
 * over — the resolve happened while this surface was not listening, and
 * leaving it up would offer a button the gateway would refuse. Terminal cards
 * are kept: they are what the owner reads to learn what happened.
 */
export function questionsAfterReplay(
  prev: readonly QuestionCard[],
  pending: readonly QuestionCard[],
): QuestionCard[] {
  const base = prev.filter((card) => card.status !== "pending");
  return pending.reduce<QuestionCard[]>(
    (cards, card) => mergeQuestionCard(cards, card),
    [...base],
  );
}

/** Read the pending set off a `question.list` payload. */
export function readQuestionList(raw: unknown): QuestionCard[] {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.questions)) return [];
  const cards: QuestionCard[] = [];
  for (const entry of record.questions) {
    const card = readQuestionCard(entry);
    if (card && card.status === "pending") cards.push(card);
  }
  return cards;
}

/**
 * Ask the gateway what is still waiting, and put it on screen.
 *
 * Called on every connect and every session switch. Never throws: a gateway
 * without the RPC, or a socket that has gone, leaves the chat exactly as it
 * was — a chat with no card is what the box did before this existed, and an
 * error banner over a question nobody asked for would be worse.
 *
 * The bound key travels WITH the answer, for the reason the approvals replay
 * does: this call is not cancelled when the owner switches conversation, so a
 * slow list for the tab they left must not land under the tab they are in.
 */
export async function loadPendingQuestions(
  request: (method: string, params: unknown) => Promise<unknown>,
  key: string,
  apply: (pending: QuestionCard[], forKey: string) => void,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await request("question.list", {});
  } catch {
    return;
  }
  apply(
    readQuestionList(payload).filter((card) => questionBelongsToSession(card.sessionKey, key)),
    key,
  );
}

/** The card the owner just answered, so it cannot be answered twice. */
export function markQuestionBusy(cards: readonly QuestionCard[], id: string): QuestionCard[] {
  return cards.map((card) => (card.id === id ? { ...card, busy: true, error: undefined } : card));
}

/**
 * What the gateway RECORDED, folded into the card — never what was asked for.
 *
 * `question.resolve` answers `{status, answers?}`. An answer this cannot read
 * leaves the card PENDING with an error on it, because a resolve whose outcome
 * is unknown is not a resolve that happened: the owner has to be able to press
 * again, and the gateway is first-answer-wins, so pressing again over an answer
 * that did land comes back as the terminal state rather than a second answer.
 */
export function questionsAfterResolve(
  cards: readonly QuestionCard[],
  id: string,
  result: unknown,
): QuestionCard[] {
  const target = cards.find((card) => card.id === id);
  if (!target) return cards as QuestionCard[];

  if (result instanceof Error) {
    return cards.map((card) =>
      card.id === id ? { ...card, busy: undefined, error: result.message } : card,
    );
  }

  const record = asRecord(result);
  const status = asStatus(record?.status);
  if (!status || status === "pending") {
    return cards.map((card) =>
      card.id === id ? { ...card, busy: undefined, error: QUESTION_NO_OUTCOME_RECORDED } : card,
    );
  }
  const answers = readAnswers(record?.answers);
  return cards.map((card) =>
    card.id === id
      ? {
        ...card,
        status,
        ...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
        busy: undefined,
        error: undefined,
      }
      : card,
  );
}

/** Fold a `question.resolved` event into the card it names. */
export function questionsAfterResolution(
  cards: readonly QuestionCard[],
  resolution: QuestionResolution,
): QuestionCard[] {
  const index = cards.findIndex((card) => card.id === resolution.id);
  if (index < 0) return cards as QuestionCard[];
  return cards.map((card, i) =>
    i === index
      ? {
        ...card,
        status: resolution.status,
        ...(resolution.answers ? { answers: resolution.answers } : {}),
        busy: undefined,
        error: undefined,
      }
      : card,
  );
}

/**
 * Whether pressing anything on this card could still do something.
 *
 * The window is judged HERE rather than by the gateway a second later: the
 * expiry is the request's own, `question.resolve` rejects a late answer as
 * `QUESTION_ALREADY_TERMINAL`, and offering a control that cannot work is the
 * UI's own false success.
 */
export function questionIsActionable(card: QuestionCard, nowMs: number): boolean {
  if (card.status !== "pending") return false;
  if (card.busy) return false;
  return card.expiresAtMs > nowMs;
}

/**
 * The answers as `question.resolve` wants them, or null when the card is not
 * ready to be sent.
 *
 * Every question must carry at least one non-empty value and a single-select
 * question exactly one — the gateway's own `validateAnswers` rules, applied
 * here so the Send button is dark until the request would be accepted rather
 * than bright until it is refused.
 */
export function buildQuestionAnswers(
  questions: readonly AskUserQuestion[],
  draft: Readonly<Record<string, readonly string[]>>,
): { answers: Record<string, string[]> } | null {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    // `Object.hasOwn`, never a bare read: a qid is a name the model chose,
    // and `constructor` is a perfectly legal one — a plain `draft[qid]` would
    // hand back Object's own constructor for a question nobody has answered.
    const values = (Object.hasOwn(draft, question.questionId) ? draft[question.questionId] : [])
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0) return null;
    if (!question.multiSelect && values.length > 1) return null;
    answers[question.questionId] = values;
  }
  return { answers };
}

/** A recorded answer as a person reads it. */
export function describeQuestionAnswer(values: readonly string[] | undefined): string {
  return (values ?? []).filter(Boolean).join(", ");
}
