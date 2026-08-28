// The Telegram Bot API calls the approvals bot makes, and nothing else.
//
// WHY THERE IS A SECOND BOT AT ALL — this is the load-bearing decision of the
// whole feature, so it is written down where the network calls are.
//
// The harness (the OpenClaw gateway, or Hermes) holds the MAIN bot's token and
// is the single consumer of its `getUpdates` long poll. Telegram allows exactly
// one: a second poller gets "Conflict: terminated by other getUpdates request"
// and both sides stall — install.sh says so in as many words, and a webhook is
// just as exclusive. So an inline keyboard on the main bot delivers its
// callback_query TO THE HARNESS: into the same process that runs the agent.
// Anything that reached ClawBox from there would have been handed over by the
// party the approval gate exists to stop (see src/lib/owner-session.ts).
//
// A bot ClawBox owns exclusively has an inbound stream nobody else reads. The
// owner's tap goes from their phone to Telegram to this process over TLS. The
// agent is not in that path, holds no token for this bot, and cannot write to
// its update stream.
//
// The token consequently NEVER reaches the harness. It is not written to
// openclaw.json, not passed to `hermes config set`, not put in an env file.

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** One call, one owner, one small JSON body. Nothing here is slow on purpose. */
const CALL_TIMEOUT_MS = 10_000;

/**
 * How long getUpdates is allowed to hold the connection open.
 *
 * Long polling, not a busy loop: 25s means a box with a question outstanding
 * makes about two requests a minute and answers a tap within a second of it
 * happening. Below Telegram's own 50s ceiling with room to spare, so a proxy
 * that trims idle connections at 30s does not turn every poll into an error.
 */
export const POLL_TIMEOUT_S = 25;

/**
 * The shape Telegram issues: `<bot_id>:<secret>`.
 *
 * This is a SAFETY check, not a format check. The token is interpolated into
 * the request path, so the charset is what matters: with no "/", "?", "#" or
 * "@" a stored value cannot reshape the URL, and the host is a literal either
 * way. Identical in intent to the one in coding-agent-notify.ts, which is also
 * what makes CodeQL read this as a sanitizer rather than an unrelated branch.
 */
const BOT_TOKEN_RE = /^(\d{1,20}):([A-Za-z0-9_-]{1,200})$/;

/**
 * Rebuild the token out of the matched groups rather than returning the input.
 * Same value, but the string that reaches the URL is now assembled here from
 * characters the pattern allows.
 */
export function safeBotToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const matched = BOT_TOKEN_RE.exec(raw.trim());
  if (!matched) return null;
  return `${matched[1]}:${matched[2]}`;
}

/** Telegram chat ids are integers; the minus sign is a group chat. */
export const CHAT_ID_RE = /^-?\d{1,20}$/;

export interface TelegramBotInfo {
  id: number;
  username: string;
}

/** An inline keyboard row. Only the callback flavour — never a URL button. */
export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

/** Telegram answered, but said no. */
export class TelegramApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
  }
}

/** We could not get an answer at all (offline, timeout, 5xx). */
export class TelegramUnavailableError extends Error {
  constructor(message = "Could not reach Telegram") {
    super(message);
    this.name = "TelegramUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bot API method names are letters only. Nothing else can reshape a path. */
const METHOD_RE = /^[A-Za-z]+$/;

/**
 * One Bot API method call.
 *
 * BOTH path segments are rebuilt here out of characters a pattern allows,
 * rather than trusted from the caller. The token has already been through
 * safeBotToken() on the way out of config, and this is a second, LOCAL check at
 * the one place a string becomes a URL — so the guarantee does not depend on
 * every future caller remembering it, and so the sanitizer is visible to CodeQL
 * at the sink rather than several frames away.
 *
 * Errors never carry the token or the response body: this repo is public and
 * these messages reach the UI verbatim.
 */
async function call(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = CALL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  const safeToken = safeBotToken(token);
  if (!safeToken) throw new TelegramApiError("This is not a usable bot token", 0);
  const safeMethod = METHOD_RE.exec(method)?.[0];
  if (!safeMethod) throw new TelegramApiError("Unsupported Telegram method", 0);

  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API_BASE}/bot${safeToken}/${safeMethod}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TelegramUnavailableError();
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }

  if (!res.ok || !isRecord(parsed) || parsed.ok !== true) {
    // Telegram's own `description` is safe to surface — it is about the bot and
    // the chat, never about the token — and it is the only thing that tells an
    // owner "you have not pressed Start on this bot yet".
    const description =
      isRecord(parsed) && typeof parsed.description === "string" ? parsed.description : "Telegram refused the request";
    throw new TelegramApiError(description, res.status);
  }
  return parsed.result;
}

/** Identity check. The one call the Settings panel makes when a token is saved. */
export async function fetchApprovalBotInfo(token: string): Promise<TelegramBotInfo> {
  const result = await call(token, "getMe", {});
  if (!isRecord(result) || typeof result.id !== "number" || typeof result.username !== "string") {
    throw new TelegramApiError("Telegram did not describe this bot", 200);
  }
  return { id: result.id, username: result.username };
}

/**
 * Post the question. Returns the message id so the outcome can be edited in.
 *
 * No parse_mode, deliberately. The body is text the agent composed, which on a
 * bad day is text an attacker composed; Markdown would let it style itself into
 * something that reads like ClawBox speaking, and one stray underscore would
 * make Telegram reject the whole message.
 */
export async function sendApprovalMessage(
  token: string,
  chatId: string,
  text: string,
  buttons: InlineButton[],
): Promise<number> {
  const result = await call(token, "sendMessage", {
    chat_id: chatId,
    text,
    // Bot API 7.0 replaced disable_web_page_preview with this object.
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [buttons] },
  });
  if (!isRecord(result)) throw new TelegramApiError("Telegram did not confirm the message", 200);
  return asMessageId(result.message_id);
}

/**
 * A message id we are willing to keep.
 *
 * This number is the ONE piece of network data that reaches the prompt store on
 * disk, so it is rebuilt here as a bounded integer rather than passed through:
 * whatever the response held, what gets written is a small whole number this
 * function produced.
 */
export function asMessageId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TelegramApiError("Telegram did not confirm the message", 200);
  }
  return Math.trunc(value);
}

/**
 * Take the keyboard away, leaving the question itself untouched.
 *
 * The missing keyboard is the point: a settled draft with live buttons still
 * under it invites a second press that can only fail, and leaves the chat
 * history claiming a decision is still open when it is not.
 *
 * The TEXT is deliberately not rewritten. That message holds the full draft —
 * recipients, subject and body — and it is the owner's only copy of it once the
 * queue has let go. A send that fails after the draft was claimed would, if we
 * had overwritten the message with a verdict, destroy the very text the owner
 * needs in order to ask for it again.
 */
export async function clearApprovalKeyboard(token: string, chatId: string, messageId: number): Promise<void> {
  await call(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

/** The verdict, posted as a reply so it sits under the draft it belongs to. */
export async function replyInChat(
  token: string,
  chatId: string,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  await call(token, "sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    // reply_parameters replaced reply_to_message_id in Bot API 7.0.
    // allow_sending_without_reply matters here: an owner who deletes the
    // question must still be told what happened to the mail.
    ...(replyToMessageId === undefined
      ? {}
      : { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }),
  });
}

/**
 * Close the spinner on the owner's phone.
 *
 * Telegram shows a loading state on a tapped button until this is called; an
 * unanswered callback spins for a few seconds and then looks like it failed.
 * It is called even for a REFUSED tap, because "nothing happened" is a worse
 * answer than "you are not allowed to do that".
 */
export async function answerCallback(token: string, callbackId: string, text: string): Promise<void> {
  await call(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    // Telegram caps this at 200 characters and truncates silently otherwise.
    text: text.slice(0, 200),
    show_alert: true,
  });
}

/**
 * One long poll.
 *
 * `allowed_updates` is narrowed to callback_query on purpose. This bot is not a
 * conversational surface — it asks one question and takes one answer — and
 * asking Telegram for nothing else means an owner who types at it cannot put
 * their words, or anyone else's, into this process at all.
 */
export async function fetchApprovalUpdates(
  token: string,
  offset: number,
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  const result = await call(
    token,
    "getUpdates",
    {
      ...(offset > 0 ? { offset } : {}),
      timeout: POLL_TIMEOUT_S,
      allowed_updates: ["callback_query"],
    },
    // The request itself is allowed to sit for the poll window plus a margin;
    // the shared 10s timeout would abort every long poll before it returned.
    (POLL_TIMEOUT_S + 10) * 1000,
    // A stop request must not have to wait out a 25-second long poll: at
    // shutdown that is an open TLS request on an embedded board, and in a test
    // it is a cycle still running after the temp root has been deleted.
    signal,
  );
  if (!Array.isArray(result)) return [];
  return result.filter(isUpdate);
}

function isUpdate(value: unknown): value is TelegramUpdate {
  if (!isRecord(value) || typeof value.update_id !== "number") return false;
  if (value.callback_query === undefined) return true;
  if (!isRecord(value.callback_query)) return false;
  const cq = value.callback_query;
  return typeof cq.id === "string" && isRecord(cq.from) && typeof cq.from.id === "number";
}
