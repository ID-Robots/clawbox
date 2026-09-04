// Which Telegram bot does THIS box poll?
//
// One question, and on BOTH editions the answer belongs to the harness. ClawBox's
// own `telegram_bot_token` is a MIRROR that /setup-api/telegram/configure happens
// to write beside the real thing — never the authority:
//
//   * OpenClaw — `setTelegramToken()` writes `channels.telegram.botToken` into
//     ~/.openclaw/openclaw.json, and the gateway long-polls from there.
//   * Hermes — `hermes config set TELEGRAM_BOT_TOKEN` writes ~/.hermes/.env (the
//     path `hermes config env-path` prints) and the gateway reads it from there.
//
// So a box configured through the harness's own CLI — or restored with the
// harness's home intact but a fresh ClawBox data/config.json — has a working bot
// and no mirror at all. Asking the mirror then answered "this box has no bot",
// which made the email-approval same-bot guard fail OPEN, told the setup wizard
// to re-offer a step for a bot that already works, and let a bot change slip past
// the pairing reset.
//
// HARNESS GAP, stated rather than worked around: neither harness has a bot-
// IDENTITY command. Hermes' `hermes send --list telegram --json` answers the
// approved CHAT ids, not the bot; OpenClaw's channel block is the config itself.
// The credential is therefore the only native answer, and the bot id is read off
// Telegram's own `<bot id>:<secret>` token shape.
//
// Both answers are TRI-STATE. "This box has no bot" and "we could not find out"
// are different facts: a panel may render the first, and only the second is
// allowed to make a save gate refuse.

import { get as configGet } from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { readHermesTelegramToken } from "@/lib/hermes-telegram";
import { readConfigStrict } from "@/lib/openclaw-config";

/**
 * Telegram tokens are `<bot id>:<secret>`. The id is the BOT; the secret is one
 * credential for it, and /revoke issues another. Two tokens that differ only in
 * the secret address the same `getUpdates` stream, so identity comparisons have
 * to be made on the id — comparing whole tokens reports a rotated credential as
 * a different bot and lets two pollers collide.
 */
const BOT_TOKEN_RE = /^(\d{1,20}):[A-Za-z0-9_-]{1,200}$/;

/** The bot id inside a token, or null when the value is not one. */
export function telegramBotId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const matched = BOT_TOKEN_RE.exec(raw.trim());
  return matched ? matched[1] : null;
}

/**
 * A value out of a HARNESS store, accepted only if it could address a bot.
 *
 * Both harness stores hold more than ClawBox put there: ~/.hermes/.env is
 * generated from Hermes' own ~25 KB template of key hints, and openclaw.json is
 * equally open to `openclaw config set` and a text editor. A placeholder or a
 * half-pasted token cannot reach Telegram, so reporting it as a configured bot
 * would end the setup wizard over nothing — and it is this function that keeps
 * every token leaving this module safe to interpolate into an api.telegram.org
 * path. ClawBox's own mirror is deliberately NOT filtered here: it is written
 * only by the configure route, which validates the shape on the way in.
 */
function harnessBotToken(raw: unknown): string | null {
  return typeof raw === "string" && telegramBotId(raw) !== null ? raw.trim() : null;
}

/** One store's answer: the bot it holds, and whether it could be read at all. */
interface StoredBot {
  token: string | null;
  known: boolean;
}

export type ActiveTelegramBot = StoredBot;

/** ClawBox's own mirror of the token. Never the authority; often the only copy. */
async function clawboxMirror(): Promise<string | null> {
  const token = await configGet("telegram_bot_token");
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * OpenClaw's own credential, out of the channel block its gateway polls from.
 *
 * `readConfigStrict` and not `readConfig`: the plain reader answers `{}` to a
 * missing file and to an EACCES alike, which is the fail-open that put this
 * whole class of bug in the tree. Strict lets only ENOENT mean "nothing is
 * configured" and raises everything else, so `known` can be honest.
 */
async function openclawStoredBot(): Promise<StoredBot> {
  try {
    const config = await readConfigStrict();
    return { token: harnessBotToken(config.channels?.telegram?.botToken), known: true };
  } catch (err) {
    console.error("[telegram] openclaw.json could not be read; the bot it holds is unknown:", err);
    return { token: null, known: false };
  }
}

/** Hermes' own credential, out of the env file the harness itself names. */
async function hermesStoredBot(): Promise<StoredBot> {
  const hermes = await readHermesTelegramToken();
  return { token: harnessBotToken(hermes.token), known: hermes.known };
}

/** The store the given harness keeps its Telegram credential in. */
function storeFor(harness: Harness): () => Promise<StoredBot> {
  return harness === "hermes" ? hermesStoredBot : openclawStoredBot;
}

/**
 * The bot the ACTIVE harness chats with — the question a status panel asks.
 *
 * The harness's own store wins; ClawBox's mirror is consulted only when that
 * store holds nothing or could not be read, so a panel degrades to the old
 * answer rather than reporting a working bot as gone. `known` still says which
 * of the two it was.
 *
 * `harness` is optional so a caller that has already resolved it does not pay
 * for a second lookup.
 */
export async function readActiveTelegramBot(harness?: Harness): Promise<ActiveTelegramBot> {
  const active = harness ?? (await getActiveHarness());
  const stored = await storeFor(active)();
  if (stored.token) return stored;
  return { token: await clawboxMirror(), known: stored.known };
}

/** Every bot this box could be long-polling, by bot id. */
export interface TelegramBotsInUse {
  ids: string[];
  /** False when a store that might hold a bot could not be read. */
  known: boolean;
}

/**
 * Which bots is ANY harness on this box polling — the question the
 * email-approval same-bot guard asks, and a different one from the panel's.
 *
 * Both stores are read, not just the active harness's. On the `dual` SKU both
 * harnesses are installed and the active one is a runtime toggle, so
 * openclaw.json and ~/.hermes/.env can name DIFFERENT bots: approving the
 * inactive harness's bot as the approvals bot would be a collision that arrives
 * the moment the owner switches back. On a single-harness box the other store is
 * simply absent, which both readers answer cleanly as "no bot" — so there is no
 * edition test here, and none that could go stale.
 *
 * ClawBox's mirror is included too. It is never the authority, but it costs one
 * read and it is the only trace left of a bot whose harness store this box
 * cannot currently read.
 */
export async function readTelegramBotsInUse(): Promise<TelegramBotsInUse> {
  const [openclaw, hermes, mirror] = await Promise.all([
    openclawStoredBot(),
    hermesStoredBot(),
    clawboxMirror(),
  ]);
  const ids = new Set<string>();
  for (const token of [openclaw.token, hermes.token, mirror]) {
    const id = telegramBotId(token);
    if (id !== null) ids.add(id);
  }
  return { ids: [...ids], known: openclaw.known && hermes.known };
}
