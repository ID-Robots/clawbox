// One plain message to one chat, on the bot the box already talks on.
//
// WHY IT IS ITS OWN FILE. Two features now speak to the owner in the Telegram
// conversation he already has with this box — the coding-agent finish notice
// and the email approval question (email-approval-reply.ts) — and the awkward
// part is identical for both and different per edition:
//
//   Hermes  the bot is the HARNESS's. `hermes send` reads its own token out of
//           ~/.hermes/.env, so ClawBox never holds it and never needs to.
//   OpenClaw the web server has no CLI send path, so it calls the Bot API with
//           `channels.telegram.botToken` — the same bot, the same token the
//           gateway polls with, read through readActiveTelegramBot().
//
// Two copies of that branch would drift, and the branch is exactly where the
// last two bugs in this area lived: gating a Hermes send on ClawBox's own
// `telegram_bot_token` mirror silenced the notice on every box paired out of
// band (TASK-650, TASK-714). One reader, one place to be wrong.
//
// SENDING IS NOT RECEIVING, and that distinction is what makes this safe to use
// beside the harness: `sendMessage` is a plain HTTPS call that takes nothing off
// the update stream, so it cannot collide with the single `getUpdates` long poll
// the harness owns (email-approval-telegram.ts explains why a second READER
// needs a bot of its own). A message the bot sends is also not echoed back into
// `getUpdates`, so nothing sent from here re-enters the box as an inbound turn.
//
// NEVER THROWS. Every caller is a notice or a question beside work that has
// already succeeded, and a Telegram outage must not turn a queued draft or a
// finished run into a failure. The boolean is the whole report.

import { getActiveHarness } from "@/lib/harness";
import { notifyHermesTelegramUser } from "@/lib/hermes-telegram";
import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";

/** Telegram's own limit is 4096 characters; callers cap their own text. */
export const MAX_TELEGRAM_CHARS = 4_000;

/**
 * This file's own ceiling on one request. Exported so the test can assert that
 * a caller's budget SHORTENS it and never lengthens it, without restating the
 * number in a second place.
 */
export const TELEGRAM_TIMEOUT_MS = 8_000;

/**
 * A numeric Telegram chat/user id, possibly negative for a group.
 *
 * Exported because every caller filters its recipient list with it before it
 * counts what it is about to attempt — a key that cannot address anybody would
 * otherwise be reported as a delivery failure for a message nothing tried.
 */
export const TELEGRAM_CHAT_ID_RE = /^(-?)(\d{1,20})$/;

/**
 * The shape Telegram issues: `<bot id>:<secret>`.
 *
 * The token is interpolated into the request PATH, so the charset is the part
 * that matters: no "/", "?", "#" or "@" means a config value cannot reshape the
 * request, and the host is a literal either way. No length floor — that would
 * only reject valid tokens if Telegram changed format. This is also the check
 * CodeQL wants for its "file data in outbound network request" alerts.
 */
const BOT_TOKEN_RE = /^(\d{1,20}):([A-Za-z0-9_-]{1,200})$/;

/**
 * Is this the shape Telegram issues?
 *
 * Exported so a caller that reads the token store ITSELF can say so once,
 * before it fans out. `sendTelegramBotMessage` applies the same check and
 * answers `false` — which is right for it and wrong as a diagnostic: a
 * malformed stored token reported five times as "the notice was not delivered"
 * sends support looking at Telegram or at the pairing instead of at the token.
 */
export function isTelegramBotToken(token: string): boolean {
  return BOT_TOKEN_RE.test(token.trim());
}

/**
 * One `sendMessage` on a token the CALLER has already resolved.
 *
 * Separate from `sendOwnerTelegramText` because coding-agent-notify.ts reads the
 * token itself — it distinguishes "no bot is configured" from "the store could
 * not be read" in its log, which is a diagnostic this function's boolean cannot
 * carry — and only the HTTP half was duplicated between the two.
 */
export async function sendTelegramBotMessage(
  token: string,
  chatId: string,
  text: string,
  /**
   * A caller's remaining budget. Only ever SHORTENS, the same rule the Hermes
   * leg follows: 8 s is right for a notice nothing waits on and can still be
   * 8 s too many inside a request whose caller gives up at 60.
   */
  timeoutMs?: number,
): Promise<boolean> {
  const matched = BOT_TOKEN_RE.exec(token.trim());
  if (!matched) return false;
  // BOTH values that came off the disk are REBUILT here, out of characters
  // their own pattern allows, rather than tested somewhere else and passed
  // through. The token is read from the harness's config and the chat id from
  // the harness's allowlist, and this function — not its callers — is where
  // they reach the wire, so this is where the check belongs. Rebuilding is also
  // what lets CodeQL see it as a sanitizer instead of an unrelated branch
  // (`js/file-access-to-http`).
  const safeToken = `${matched[1]}:${matched[2]}`;
  const chat = TELEGRAM_CHAT_ID_RE.exec(chatId.trim());
  if (!chat) return false;
  const safeChatId = chat[1] === "-" ? `-${chat[2]}` : chat[2];
  const budget =
    typeof timeoutMs === "number" && timeoutMs > 0 ? Math.min(timeoutMs, TELEGRAM_TIMEOUT_MS) : TELEGRAM_TIMEOUT_MS;
  try {
    // Interpolated raw, not encoded: Telegram wants the literal
    // "<bot id>:<secret>", and encodeURIComponent turns the colon into %3A,
    // which the API rejects.
    const res = await fetch(`https://api.telegram.org/bot${safeToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No parse_mode: the text is plain, and a stray underscore must not turn
      // into a Markdown error that swallows the whole message.
      body: JSON.stringify({ chat_id: safeChatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(budget),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Say `text` to `chatId` on whichever bot this edition actually talks on.
 *
 * `false` covers every reason nothing arrived — no bot, an unreadable store, a
 * malformed token, a refusal from Telegram, a timeout — because no caller acts
 * differently on any of them; the reasons are in the service log, written by
 * the readers this delegates to.
 */
export async function sendOwnerTelegramText(
  chatId: string,
  text: string,
  opts: {
    /**
     * Which harness's bot to speak on. Defaults to the active one; the reply
     * path passes the harness the owner's message actually arrived on, because
     * on a dual box the verdict has to land in the conversation he typed in.
     */
     harness?: "openclaw" | "hermes";
    /**
     * A ceiling for a caller that is itself inside somebody's budget. Only
     * SHORTENS: the Hermes leg spawns a CLI whose own default is 90 s, which is
     * right for a notice nothing waits on and far too long inside a request
     * that is given 60.
     */
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  if (!TELEGRAM_CHAT_ID_RE.test(chatId)) return false;
  const body = text.slice(0, MAX_TELEGRAM_CHARS);
  if (!body) return false;

  // NEVER THROWS is this file's whole contract, and the readers below can:
  // `hermesSecretsPresent` raises on an unreadable harness store (EACCES after
  // a root-run `hermes config set`, a non-regular file), and an unhandled throw
  // here would turn a notice beside work that SUCCEEDED into a failed request.
  try {
    if ((opts.harness ?? (await getActiveHarness())) === "hermes") {
      return await notifyHermesTelegramUser(chatId, body, opts.timeoutMs);
    }

    const { token } = await readActiveTelegramBot("openclaw");
    if (typeof token !== "string" || !token.trim()) return false;
    return await sendTelegramBotMessage(token, chatId, body, opts.timeoutMs);
  } catch (err) {
    console.error("[telegram] could not resolve this device's bot:", err instanceof Error ? err.message : err);
    return false;
  }
}
