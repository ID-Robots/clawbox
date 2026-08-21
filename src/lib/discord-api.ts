// Discord bot-token validation against Discord's own API.
//
// Telegram's configure route can get away with a regex alone: a Telegram token
// carries the bot id in front of the colon, so a typo is usually a *shape*
// error. A Discord bot token has no documented shape at all — Discord has
// changed the encoding more than once and says only "treat it as opaque" — so a
// regex here would either reject valid tokens or accept anything. The only
// honest check is to ask Discord.
//
// `GET /users/@me` with `Authorization: Bot <token>` is the documented identity
// call and the cheapest one: it needs no scopes, no gateway connection and no
// guild, and it answers 401 for a bad token. That is the whole check.
//
// Nothing here ever logs, returns or embeds the token — not in an error
// message, not in a thrown stack. The repo is public and these errors are
// surfaced to the UI verbatim.

const DISCORD_API_BASE = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";
const VALIDATE_TIMEOUT_MS = 8_000;

export interface DiscordBotInfo {
  id: string;
  username: string;
  /** Present on bots that still carry a legacy 4-digit discriminator. */
  discriminator?: string;
  /** "username" or "username#0001" — what the UI shows. */
  displayName: string;
}

/** Discord answered, and the answer was "this token is not valid". */
export class DiscordAuthError extends Error {
  constructor(message = "Discord rejected this bot token") {
    super(message);
    this.name = "DiscordAuthError";
  }
}

/** We could not get an answer out of Discord (offline, timeout, 5xx, 429). */
export class DiscordUnavailableError extends Error {
  constructor(message = "Could not reach Discord to verify the token") {
    super(message);
    this.name = "DiscordUnavailableError";
  }
}

// Argv/systemd-safety guard, NOT a format check.
//
// The token reaches `hermes config set DISCORD_BOT_TOKEN <token>` as an argv
// element and `data/discord.env` as a systemd EnvironmentFile line. Restricting
// it to the characters every published Discord token has ever used (base64url
// segments joined by dots) is what makes both destinations safe: no whitespace
// or newline can split an env line, and no leading "-" can be read as a flag.
// Length bounds are deliberately generous — this must not become a shape check
// that a future token format fails.
const TOKEN_CHARSET_RE = /^[A-Za-z0-9._-]{20,200}$/;

/**
 * Reject values that could not be a bot token AND could be dangerous downstream.
 * Anything that passes still has to survive the live check.
 */
export function isSafeDiscordToken(token: string): boolean {
  if (!TOKEN_CHARSET_RE.test(token)) return false;
  // A leading "-" would be read as a flag by the Hermes CLI.
  return !token.startsWith("-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ask Discord who this token belongs to.
 *
 * @throws {DiscordAuthError} the token is not valid (HTTP 401).
 * @throws {DiscordUnavailableError} Discord could not be reached or did not
 *   answer usefully — the caller must NOT treat this as a bad token.
 */
export async function fetchDiscordBotInfo(
  token: string,
  signal?: AbortSignal,
): Promise<DiscordBotInfo> {
  let res: Response;
  try {
    res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bot ${token}`,
        // Discord asks bots to identify themselves; an unnamed client is the
        // first thing their rate limiter penalises.
        "User-Agent": "ClawBox (https://clawbox.com, 1.0)",
      },
      signal: signal ?? AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch {
    // DNS failure, TLS failure, timeout, aborted request. Never a verdict on
    // the token itself.
    throw new DiscordUnavailableError();
  }

  if (res.status === 401) {
    res.body?.cancel();
    throw new DiscordAuthError();
  }
  if (!res.ok) {
    res.body?.cancel();
    // 429 (rate limited) and 5xx both mean "ask again later", never "bad token".
    throw new DiscordUnavailableError();
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new DiscordUnavailableError();
  }
  if (!isRecord(data) || typeof data.id !== "string" || typeof data.username !== "string") {
    throw new DiscordUnavailableError();
  }

  // "0" is Discord's placeholder for an account migrated off discriminators.
  const discriminator =
    typeof data.discriminator === "string" && data.discriminator !== "0"
      ? data.discriminator
      : undefined;

  return {
    id: data.id,
    username: data.username,
    discriminator,
    displayName: discriminator ? `${data.username}#${discriminator}` : data.username,
  };
}
