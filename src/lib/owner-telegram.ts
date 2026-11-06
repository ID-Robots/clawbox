/**
 * A short ClawBox notice to the owner on Telegram, when a bot is connected:
 * one message to each of the people the owner has approved to talk to the bot.
 *
 * Moved out of src/lib/coding-agent-notify.ts, where it was the finish
 * notice's second leg, when the scheduled-job alerts (src/lib/job-alerts.ts)
 * needed the same send — one fan-out, so the two notices cannot come to
 * disagree about who is told or with which credential. Best-effort and
 * one-way: every failure is logged under the caller's tag and swallowed.
 *
 * On Hermes that goes through `hermes send` (src/lib/hermes-telegram.ts); on
 * OpenClaw the web server has no CLI send path, so it calls the Bot API
 * directly with the stored token — the same token telegram/status already uses
 * for `getMe`.
 *
 * The two editions therefore have DIFFERENT credentials, and the check has to
 * sit on the edition's own side of the branch: Hermes' bot token lives in
 * ~/.hermes/.env and is never read here, so ClawBox's copy of a token says
 * nothing about whether that box can send.
 *
 * The text is the CALLER's fixed template. Nothing a model wrote and nothing
 * the assistant read belongs in it — email-notify.ts's rule: a notice is
 * ClawBox speaking to the owner, not a channel for anyone else.
 */

import { getActiveHarness } from "@/lib/harness";
import { notifyHermesTelegramUser, readHermesApprovedUsers } from "@/lib/hermes-telegram";
import { readTelegramAllowFrom } from "@/lib/openclaw-config";
import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";
import { isTelegramBotToken, sendTelegramBotMessage } from "@/lib/telegram-owner-send";

/** Telegram's own limit is 4096; the templates never get near it. */
const MAX_TELEGRAM_CHARS = 1_000;
/** Approved senders are the household, not a mailing list. */
const MAX_TELEGRAM_RECIPIENTS = 5;
const CHAT_ID_RE = /^-?\d{1,20}$/;

/**
 * Send `message` to the owner's approved Telegram users. `tag` names the
 * caller in the log (`[coding-agent] …`), so "no notice arrived" can be traced
 * to the feature that meant to send it. Resolves when every send has been
 * tried; rejects only on a fault outside the sends themselves.
 */
export async function notifyOwnerTelegram(message: string, tag: string): Promise<void> {
  const text = message.slice(0, MAX_TELEGRAM_CHARS);
  // WHICH EDITION FIRST, because the two have different credentials — and the
  // credential is the whole reason this branch exists.
  const harness = await getActiveHarness();

  if (harness === "hermes") {
    // The bot is the HARNESS's. `hermes send` reads its own token from
    // ~/.hermes/.env and the approved senders come from Hermes' pairing store;
    // nothing on this path can use ClawBox's `telegram_bot_token`, which is
    // written only as a side effect of /setup-api/telegram/configure.
    //
    // Gating on it anyway — which is what this function did, above the harness
    // branch — silenced the notice on every Hermes box paired another way:
    // `hermes config set`, or a restore that brought back ~/.hermes without
    // ClawBox's config.json. A working bot, approved users, and no notice.
    // Shape-checked before they are counted, the way the OpenClaw leg filters
    // its ids below. Hermes' store tolerates a legacy layout and merges two
    // directories, so a key that cannot address anyone is possible — counting
    // it would report five delivery FAILURES for messages nothing attempted,
    // which is the ambiguity the log line right below exists to remove.
    const users = (await readHermesApprovedUsers())
      .filter((user) => CHAT_ID_RE.test(user.id))
      .slice(0, MAX_TELEGRAM_RECIPIENTS);
    if (users.length === 0) {
      // "No notice arrived" and "no notice was sent" are different problems.
      // A silent return made them the same one to whoever went looking.
      console.info(`[${tag}] no approved Telegram users on this device; notice not sent`);
      return;
    }
    for (const user of users) {
      const ok = await notifyHermesTelegramUser(user.id, text);
      if (!ok) console.error(`[${tag}] telegram notice to ${user.id} was not delivered`);
    }
    return;
  }

  // OpenClaw: the web server has no CLI send path, so it calls the Bot API
  // itself and needs the credential in hand — but the credential is the
  // HARNESS's here too. `channels.telegram.botToken` in openclaw.json is the
  // same bot's token and is equally usable from this side, while ClawBox's
  // `telegram_bot_token` is a mirror /setup-api/telegram/configure writes; a box
  // paired with `openclaw config set`, or restored with ~/.openclaw intact and a
  // fresh data/config.json, has none. Gating on the mirror silenced the notice
  // on such a box — working bot, approved senders, nothing delivered — and said
  // so at INFO, so nothing ever told the owner. A multi-account channel keeps
  // the bot under `accounts.<id>` instead, and the reader answers which account
  // it took the bot from, so the approved senders below are that account's.
  const { token, known, account } = await readActiveTelegramBot("openclaw");
  if (typeof token !== "string" || !token.trim()) {
    // The third state matters in the log even though it cannot matter to the
    // outcome: a notice is not a gate, so an unreadable store still costs only
    // this one card — but logging "no bot is configured" for a store that could
    // not be READ is the same false failure the comment above complains about,
    // one fault further out, and it sends support looking at the pairing.
    if (known) {
      console.info(`[${tag}] no Telegram bot is configured on this device; notice not sent`);
    } else {
      console.error(`[${tag}] this device's Telegram bot could not be read; notice not sent`);
    }
    return;
  }
  // Said ONCE, before the fan-out, and not five times as "not delivered": a
  // token that is not a token is a different problem from a Telegram that would
  // not answer, and the second reading sends support to the wrong place.
  if (!isTelegramBotToken(token)) {
    console.error(`[${tag}] telegram bot token is not a valid token; notice not sent`);
    return;
  }
  const ids = (await readTelegramAllowFrom(account))
    .filter((id) => CHAT_ID_RE.test(id))
    .slice(0, MAX_TELEGRAM_RECIPIENTS);
  if (ids.length === 0) {
    console.info(`[${tag}] no approved Telegram senders on this device; notice not sent`);
    return;
  }
  for (const id of ids) {
    // The token guard, the request and its timeout are the shared sender's:
    // this leg and the email approval question post to the same bot.
    const ok = await sendTelegramBotMessage(token, id, text);
    if (!ok) console.error(`[${tag}] telegram notice to ${id} was not delivered`);
  }
}
