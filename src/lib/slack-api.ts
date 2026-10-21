// Slack token validation against Slack's own Web API.
//
// A Socket Mode app needs TWO tokens, and each can be wrong on its own:
//
//   * the Bot User OAuth Token (`xoxb-…`) — what the bot posts and reads with.
//     `auth.test` is the documented identity call: no scopes, and it answers
//     `{ok:false, error:"invalid_auth"}` for a dead token.
//   * the App-Level Token (`xapp-…`) — what opens the Socket Mode WebSocket.
//     It only works with the `connections:write` scope, and the only call that
//     proves it is `apps.connections.open`, which mints a one-time WebSocket
//     URL and nothing else (nothing connects to it here; it expires unused).
//
// Checking both before anything is written is the Discord route's rule: a save
// that skipped the live check would report success for a bot that can never
// connect, and the gateway log would be the only place that said so.
//
// Nothing here ever logs, returns or embeds a token. The repo is public and
// these errors reach the UI.

// Hardcoded, with no environment override, for the same reason as
// DISCORD_API_BASE: this is the one destination a stored token is ever sent to.
const SLACK_API_BASE = "https://slack.com/api";
const VALIDATE_TIMEOUT_MS = 8_000;

// Shape AND argv/systemd safety. Slack documents the prefixes; the body has
// only ever been `[A-Za-z0-9-]`. Bounds are generous so a longer future token
// is not refused by a shape check.
const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,250}$/;
const APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{10,250}$/;

export function isSlackBotToken(token: string): boolean {
  return BOT_TOKEN_RE.test(token);
}

export function isSlackAppToken(token: string): boolean {
  return APP_TOKEN_RE.test(token);
}

/** Which token Slack refused, and why — each has a different remedy. */
export type SlackTokenProblem =
  /** The bot token is dead (revoked, reinstalled, mistyped). */
  | "bot_token_rejected"
  /** The app-level token is dead, or is not an app-level token. */
  | "app_token_rejected"
  /** The app-level token is alive but lacks `connections:write`. */
  | "app_token_scope";

export class SlackAuthError extends Error {
  constructor(readonly problem: SlackTokenProblem) {
    super(`Slack refused the token (${problem})`);
    this.name = "SlackAuthError";
  }
}

/** Slack could not be asked: offline, DNS, TLS, timeout, 429 or 5xx. Never a verdict. */
export class SlackUnavailableError extends Error {
  constructor() {
    super("Slack could not be reached");
    this.name = "SlackUnavailableError";
  }
}

export interface SlackBotInfo {
  teamId: string;
  /** The workspace name, as Slack shows it. */
  teamName: string;
  /** The bot user's own name. */
  botName: string;
  botUserId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POST one Web API method with `token`; the parsed body, or SlackUnavailableError. */
async function slackCall(
  method: string,
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      // The caller's signal ADDS a reason to give up; it never replaces the
      // ceiling (the discord-api.ts lesson: `signal ?? timeout` disabled it).
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(VALIDATE_TIMEOUT_MS)])
        : AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch {
    throw new SlackUnavailableError();
  }
  if (!res.ok) {
    // Slack answers an auth failure with HTTP 200 and `ok:false`; a non-2xx is
    // a rate limit or an outage — "ask again later", never "bad token".
    res.body?.cancel();
    throw new SlackUnavailableError();
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new SlackUnavailableError();
  }
  if (!isRecord(data) || typeof data.ok !== "boolean") throw new SlackUnavailableError();
  return data;
}

// Errors that are a verdict on the TOKEN. Anything else Slack says
// (`ratelimited`, `internal_error`, `fatal_error`, `request_timeout`) is about
// Slack, and is reported as "could not check" rather than "wrong token".
const TOKEN_VERDICTS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "missing_scope",
  "no_permission",
  "invalid_token",
]);

/** The workspace and bot behind a bot token (`auth.test`). */
export async function fetchSlackBotInfo(
  botToken: string,
  signal?: AbortSignal,
): Promise<SlackBotInfo> {
  if (!isSlackBotToken(botToken)) throw new SlackAuthError("bot_token_rejected");
  const data = await slackCall("auth.test", botToken, signal);
  if (data.ok !== true) {
    if (typeof data.error === "string" && TOKEN_VERDICTS.has(data.error)) {
      throw new SlackAuthError("bot_token_rejected");
    }
    throw new SlackUnavailableError();
  }
  const teamId = typeof data.team_id === "string" ? data.team_id : "";
  const botUserId = typeof data.user_id === "string" ? data.user_id : "";
  // A user token (`xoxp-`) also passes auth.test; `bot_id` is what only a bot
  // token carries, and a user token would post as the person, not the bot.
  if (!teamId || !botUserId || typeof data.bot_id !== "string") {
    throw new SlackAuthError("bot_token_rejected");
  }
  return {
    teamId,
    teamName: typeof data.team === "string" ? data.team : teamId,
    botName: typeof data.user === "string" ? data.user : botUserId,
    botUserId,
  };
}

/**
 * Prove an app-level token can open a Socket Mode connection
 * (`apps.connections.open`). Resolves on success; nothing connects to the URL
 * Slack mints, and it expires on its own.
 */
export async function checkSlackAppToken(appToken: string, signal?: AbortSignal): Promise<void> {
  if (!isSlackAppToken(appToken)) throw new SlackAuthError("app_token_rejected");
  const data = await slackCall("apps.connections.open", appToken, signal);
  if (data.ok === true) return;
  const error = typeof data.error === "string" ? data.error : "";
  if (error === "missing_scope") throw new SlackAuthError("app_token_scope");
  if (TOKEN_VERDICTS.has(error)) throw new SlackAuthError("app_token_rejected");
  throw new SlackUnavailableError();
}
