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

// Hardcoded, with no environment override, and that is the security property
// rather than an oversight. This is the one destination a stored bot token is
// ever sent to, so anything that could retarget it — an env var read at import
// time included — would turn a config-write primitive into token exfiltration.
// The tests never needed the seam either: they stub global fetch and assert
// against this literal URL.
const DISCORD_API_BASE = "https://discord.com/api/v10";
const VALIDATE_TIMEOUT_MS = 8_000;

export interface DiscordBotInfo {
  id: string;
  username: string;
  /** Present on bots that still carry a legacy 4-digit discriminator. */
  discriminator?: string;
  /** "username" or "username#0001" — what the UI shows. */
  displayName: string;
}

/**
 * This token is not valid. Either Discord answered 401, or the value could not
 * be a bot token at all and was never sent. Both mean the same thing to the
 * owner — the stored credential is dead until a new one is pasted — so they
 * deliberately share one error rather than splitting a distinction the panel
 * has no way to act on differently.
 */
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
 * Sending a stored credential outward is the whole point of this function, so
 * the status route's "a value read from disk reaches an outbound request" shape
 * is the feature rather than a leak. Three things keep it that way: the
 * destination is DISCORD_API_BASE, a hardcoded literal with no environment
 * override, so neither a caller, a request, nor the process environment can
 * retarget it; the token travels only in the Authorization header, never in a
 * URL or a log line; and every token is run through isSafeDiscordToken here,
 * whether it came from an operator or off the disk. Same class as the other
 * credential-check calls in the tree.
 *
 * @throws {DiscordAuthError} the token is not valid (HTTP 401).
 * @throws {DiscordUnavailableError} Discord could not be reached or did not
 *   answer usefully — the caller must NOT treat this as a bad token.
 */
export async function fetchDiscordBotInfo(
  token: string,
  signal?: AbortSignal,
): Promise<DiscordBotInfo> {
  // The same charset guard the configure route applies on the way IN, applied
  // again here on the way OUT. `data/discord.env` is ours and 0600, but "the
  // file can only ever hold what we wrote" is an assumption rather than a
  // check, and this function is where a stored value leaves the box: the
  // status and members routes both read the token straight off disk and hand
  // it to this call. A truncated or hand-edited file must produce an honest
  // "that token is dead" instead of an outbound request built out of it.
  if (!isSafeDiscordToken(token)) throw new DiscordAuthError();

  let res: Response;
  try {
    res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bot ${token}`,
        // Discord asks bots to identify themselves; an unnamed client is the
        // first thing their rate limiter penalises.
        "User-Agent": "ClawBox (https://clawbox.com, 1.0)",
      },
      // The caller's signal ADDS a reason to give up, it does not replace the
      // timeout. `signal ?? timeout` looked equivalent and was not: the
      // configure route passes `request.signal`, which silently disabled the
      // 8 s ceiling, so a hung TLS connection to Discord fell back to undici's
      // own (much longer) limits with the Settings spinner — which has no
      // client-side timeout — waiting behind it.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(VALIDATE_TIMEOUT_MS)])
        : AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
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

// ── Privileged Gateway Intents preflight ────────────────────────────────────
//
// The friction this exists for: the token validates, `GET /users/@me` answers,
// the panel says "receiving" — and the bot is dead, because discord.py raises
// PrivilegedIntentsRequired at gateway connect when MESSAGE CONTENT was never
// ticked in the Developer Portal. Nothing in a token check can see that. The
// only symptom is a bot that is online and silent, which is precisely the
// failure this integration exists to avoid.
//
// `GET /applications/@me` exposes it before a gateway ever runs: the
// application's `flags` bitfield carries the privileged intents that are
// actually enabled.
//
// THE BIT THAT MATTERS. Discord publishes each privileged intent TWICE — a
// plain bit for an app that has passed verification, and a `_LIMITED` bit for
// one that has not, which is every ClawBox owner's bot (verification only
// applies past 100 guilds). Read from the live bench bot while it was connected
// and answering messages, `flags` was 8953856 = bits 13, 15, 19, 23: the
// _LIMITED bits ONLY. Testing bit 18 alone would have reported "intents
// missing" for a bot that demonstrably had the intent on. So each intent is the
// OR of its two bits, and getting that wrong is a false alarm on every
// unverified bot rather than an edge case.
const FLAG_GATEWAY_GUILD_MEMBERS = 1 << 14;
const FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

export interface DiscordIntents {
  /** MESSAGE CONTENT INTENT. Without it the bot connects and reads nothing. */
  messageContent: boolean;
  /** SERVER MEMBERS INTENT. Without it the member list cannot be read. */
  serverMembers: boolean;
}

/** Decode the privileged-intent bits out of an application `flags` bitfield. */
export function intentsFromApplicationFlags(flags: number): DiscordIntents {
  return {
    messageContent:
      (flags & (FLAG_GATEWAY_MESSAGE_CONTENT | FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0,
    serverMembers:
      (flags & (FLAG_GATEWAY_GUILD_MEMBERS | FLAG_GATEWAY_GUILD_MEMBERS_LIMITED)) !== 0,
  };
}

/**
 * One authenticated GET against the Discord API.
 *
 * Same destination rule as fetchDiscordBotInfo: DISCORD_API_BASE is a hardcoded
 * literal no caller, request or environment variable can steer; the token is
 * validated here and travels only in the Authorization header. `pathname` is
 * built from ids this module has already read out of a Discord response, and
 * encodeURIComponent'd at every call site, so it cannot carry a caller-supplied
 * path.
 */
async function discordGet(token: string, pathname: string, signal?: AbortSignal): Promise<unknown> {
  // Same read-boundary guard as fetchDiscordBotInfo, for the same reason: the
  // members picker reaches here with a token read straight off disk.
  if (!isSafeDiscordToken(token)) throw new DiscordAuthError();

  let res: Response;
  try {
    res = await fetch(`${DISCORD_API_BASE}${pathname}`, {
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "ClawBox (https://clawbox.com, 1.0)",
      },
      // The caller's signal ADDS a reason to give up, it does not replace the
      // ceiling — the same trap fetchDiscordBotInfo documents.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(VALIDATE_TIMEOUT_MS)])
        : AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch {
    throw new DiscordUnavailableError();
  }
  if (res.status === 401) {
    res.body?.cancel();
    throw new DiscordAuthError();
  }
  if (!res.ok) {
    res.body?.cancel();
    throw new DiscordUnavailableError();
  }
  try {
    return await res.json();
  } catch {
    throw new DiscordUnavailableError();
  }
}

/**
 * Read the application's enabled privileged intents.
 *
 * @throws {DiscordAuthError} the token is not valid (HTTP 401).
 * @throws {DiscordUnavailableError} could not be read. The caller must treat
 *   that as "unknown", never as "the intents are off" — blocking a save on a
 *   network blip is the same dishonesty pointing the other way.
 */
export async function fetchDiscordIntents(
  token: string,
  signal?: AbortSignal,
): Promise<DiscordIntents> {
  const app = await discordGet(token, "/applications/@me", signal);
  if (!isRecord(app) || typeof app.flags !== "number") throw new DiscordUnavailableError();
  return intentsFromApplicationFlags(app.flags);
}

// ── Guilds and members, for the allowlist picker ────────────────────────────

export interface DiscordMember {
  /** Numeric snowflake. This is exactly what DISCORD_ALLOWED_USERS holds. */
  id: string;
  /** Server nickname, then global display name, then username. */
  displayName: string;
  username: string;
  /** Owns the guild they were found in. Pre-selected in the picker. */
  isOwner: boolean;
  guildId: string;
  guildName: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
  ownerId: string | null;
  /** The member page hit the API's per-call ceiling and was cut off. */
  truncated: boolean;
  /** False when Discord refused the member list (Server Members intent off). */
  membersReadable: boolean;
}

export interface DiscordGuildMembers {
  guilds: DiscordGuild[];
  /** Humans only, de-duplicated by user id across guilds. */
  members: DiscordMember[];
}

// Bounds, not expectations. An owner's bot is in one or two servers with a
// handful of people in them; these stop a bot that was invited to something
// enormous from turning one Settings save into an unbounded fan-out of REST
// calls behind a spinner that has no client-side timeout.
const MAX_GUILDS = 25;
const MEMBER_PAGE_LIMIT = 1000;

function memberDisplayName(user: Record<string, unknown>, nick: unknown): string {
  if (typeof nick === "string" && nick.trim()) return nick;
  if (typeof user.global_name === "string" && user.global_name.trim()) return user.global_name;
  return typeof user.username === "string" ? user.username : "";
}

/**
 * List the servers the bot is in, and the humans in them.
 *
 * Two calls per guild, and both are load-bearing:
 *
 *   * `GET /guilds/{id}` carries `owner_id` and needs NO privileged intent.
 *     That is what makes the owner pre-selection work even on a bot whose
 *     Server Members intent is still off — the default selection never depends
 *     on the call that can be refused.
 *   * `GET /guilds/{id}/members` IS gated on the Server Members intent. With it
 *     off Discord answers 403, so a failed member page degrades that one guild
 *     to its owner rather than failing the whole save.
 *
 * Bots are filtered out: an allowlist entry for a bot cannot talk to the
 * assistant, so it would only be a confusing row in the picker.
 */
export async function fetchDiscordGuildMembers(
  token: string,
  signal?: AbortSignal,
): Promise<DiscordGuildMembers> {
  const raw = await discordGet(token, "/users/@me/guilds?limit=200", signal);
  if (!Array.isArray(raw)) throw new DiscordUnavailableError();

  const guilds: DiscordGuild[] = [];
  const byId = new Map<string, DiscordMember>();

  for (const entry of raw.slice(0, MAX_GUILDS)) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const guildId = entry.id;
    const guildName = typeof entry.name === "string" ? entry.name : guildId;
    const encoded = encodeURIComponent(guildId);

    let ownerId: string | null = null;
    try {
      const full = await discordGet(token, `/guilds/${encoded}`, signal);
      if (isRecord(full) && typeof full.owner_id === "string") ownerId = full.owner_id;
    } catch (err) {
      // A rejected token is a verdict about the whole call, not this one guild.
      if (err instanceof DiscordAuthError) throw err;
    }

    let membersReadable = true;
    let page: unknown = null;
    try {
      page = await discordGet(token, `/guilds/${encoded}/members?limit=${MEMBER_PAGE_LIMIT}`, signal);
    } catch (err) {
      if (err instanceof DiscordAuthError) throw err;
      membersReadable = false;
    }

    const list = Array.isArray(page) ? page : [];
    guilds.push({
      id: guildId,
      name: guildName,
      ownerId,
      truncated: list.length >= MEMBER_PAGE_LIMIT,
      membersReadable,
    });

    for (const m of list) {
      if (!isRecord(m) || !isRecord(m.user)) continue;
      const user = m.user;
      if (typeof user.id !== "string") continue;
      if (user.bot === true) continue;
      if (byId.has(user.id)) continue;
      byId.set(user.id, {
        id: user.id,
        displayName: memberDisplayName(user, m.nick),
        username: typeof user.username === "string" ? user.username : "",
        isOwner: ownerId !== null && user.id === ownerId,
        guildId,
        guildName,
      });
    }

    // The owner is the default selection, so they have to appear in the list
    // even when the member page could not be read at all.
    if (ownerId && !byId.has(ownerId)) {
      byId.set(ownerId, {
        id: ownerId,
        displayName: "",
        username: "",
        isOwner: true,
        guildId,
        guildName,
      });
    }
  }

  return { guilds, members: [...byId.values()] };
}
