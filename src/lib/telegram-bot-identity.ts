// Which Telegram bot does THIS box chat with?
//
// One question, two editions, two credential stores — and asking the wrong one
// is how three separate surfaces came to disagree with the device:
//
//   * OpenClaw — ClawBox owns the credential. /setup-api/telegram/configure
//     writes it to ClawBox's config store AND hands it to the gateway, so
//     `telegram_bot_token` IS the answer.
//   * Hermes — the HARNESS owns it. The token lives in ~/.hermes/.env (the path
//     `hermes config env-path` prints, where `hermes config set
//     TELEGRAM_BOT_TOKEN` writes and where the gateway reads it from), and
//     ClawBox's copy is only a side effect of its own configure route. A box
//     paired with `hermes config set`, or restored with ~/.hermes intact but
//     without ClawBox's config.json, has a working bot and no copy at all.
//
// Every caller here is a panel read or a save gate, so the Hermes answer is a
// plain file read and never the CLI: `hermes config get TELEGRAM_BOT_TOKEN`
// resolves the same value but costs a ~2 s subprocess and prints the secret on
// stdout, which is the wrong shape for a route polled every three seconds.
//
// The answer is a TRI-STATE. "This box has no bot" and "we could not find out"
// are different facts, and the same-bot guard in /setup-api/email/chat-approval
// is only safe while it can tell them apart.

import { get as configGet } from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { readHermesTelegramToken } from "@/lib/hermes-telegram";

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

export interface ActiveTelegramBot {
  /** The bot this box chats with, or null when it demonstrably has none. */
  token: string | null;
  /**
   * False when the edition's own credential store could not be read. `token`
   * may still carry a fallback, but nothing may be REFUSED or PERMITTED on it.
   */
  known: boolean;
}

/** ClawBox's own copy of the token — the whole answer on OpenClaw. */
async function clawboxCopy(): Promise<string | null> {
  const token = await configGet("telegram_bot_token");
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * The bot this device chats with, asked of whichever store the running edition
 * actually keeps it in.
 *
 * `harness` is optional so a caller that has already resolved it does not pay
 * for a second lookup.
 */
export async function readActiveTelegramBot(harness?: Harness): Promise<ActiveTelegramBot> {
  const active = harness ?? (await getActiveHarness());
  if (active !== "hermes") return { token: await clawboxCopy(), known: true };

  const hermes = await readHermesTelegramToken();
  if (hermes.known) return hermes;
  // Hermes' store could not be read. ClawBox's copy is written alongside it by
  // /setup-api/telegram/configure, so it is a HINT worth showing a panel rather
  // than reporting a working bot as gone — carried with `known: false` so a
  // gate can refuse instead of acting on it.
  return { token: await clawboxCopy(), known: false };
}
