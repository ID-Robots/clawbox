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
 *
 * WHO IS TOLD. By default the first {@link MAX_TELEGRAM_RECIPIENTS} approved
 * users, in the harness's own order. A caller may hand in the owner's pick
 * instead (`recipients`, TASK-2543 — the scheduled-job alerts' "Telegram
 * recipients" in Settings → Harness): then only the picked people who are
 * STILL approved are told, an empty pick tells nobody, and the harness's order
 * no longer decides anything. Approval stays the gate either way — a pick can
 * narrow who is told, never reach someone the bot does not talk to.
 */

import { get as configGet } from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { notifyHermesTelegramUser, readHermesApprovedUsers } from "@/lib/hermes-telegram";
import { readTelegramAllowFrom } from "@/lib/openclaw-config";
import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";
import { isTelegramBotToken, sendTelegramBotMessage } from "@/lib/telegram-owner-send";

/** Telegram's own limit is 4096; the templates never get near it. */
const MAX_TELEGRAM_CHARS = 1_000;
/** Approved senders are the household, not a mailing list: the default fan-out. */
export const MAX_TELEGRAM_RECIPIENTS = 5;
/**
 * The most people an owner's pick may name. Each send is awaited in turn and a
 * Settings read can be waiting on the check that sends, so the bound is still
 * a household's, only larger than the default's.
 */
export const MAX_PICKED_TELEGRAM_RECIPIENTS = 20;
const CHAT_ID_RE = /^-?\d{1,20}$/;

/**
 * The display names ClawBox remembers for approved senders, by id — written by
 * /setup-api/telegram/pairing (its `APPROVED_NAMES_KEY`) when the owner
 * approves someone, because OpenClaw's allowlist is bare ids (Hermes' own store
 * carries a name). Read-only here.
 */
const TELEGRAM_APPROVED_NAMES_KEY = "telegram_approved_names";

/** A value that can address a Telegram chat: digits, optionally negative. */
export function isTelegramChatId(value: unknown): value is string {
  return typeof value === "string" && CHAT_ID_RE.test(value);
}

/**
 * Who a notice goes to, out of the approved users' ids (in the harness's
 * order). `picked` null or undefined is the default: the first
 * {@link MAX_TELEGRAM_RECIPIENTS}. A pick keeps only the approved ids it names
 * — an id no longer approved is skipped, an empty pick is nobody. Pure.
 */
export function pickTelegramRecipients(
  approved: readonly string[],
  picked?: readonly string[] | null,
): string[] {
  const ids = [...new Set(approved.filter(isTelegramChatId))];
  if (picked == null) return ids.slice(0, MAX_TELEGRAM_RECIPIENTS);
  const wanted = new Set(picked);
  return ids.filter((id) => wanted.has(id)).slice(0, MAX_PICKED_TELEGRAM_RECIPIENTS);
}

export interface OwnerTelegramUser {
  /** The Telegram user id — the DM chat id a notice is sent to. */
  id: string;
  /** Display name where one is known (Hermes' store, or the name remembered at approval). */
  name?: string;
}

/** The remembered display names; an unreadable or damaged map is none. */
export async function readApprovedTelegramNames(): Promise<Record<string, string>> {
  let raw: unknown;
  try {
    raw = await configGet(TELEGRAM_APPROVED_NAMES_KEY);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name === "string" && name.trim()) out[id] = name.trim();
  }
  return out;
}

/**
 * Everyone the active harness's bot may send a notice to — the people a pick
 * is made from. The SAME ids {@link notifyOwnerTelegram} fans out over (on
 * OpenClaw, the allowlist of the account it takes the bot from), shape-checked
 * the same way, so the list the owner ticks in is the list the send obeys.
 */
export async function readOwnerTelegramUsers(): Promise<{ runtime: Harness; users: OwnerTelegramUser[] }> {
  const runtime = await getActiveHarness();
  const names = await readApprovedTelegramNames();
  const seen = new Set<string>();
  const users: OwnerTelegramUser[] = [];
  const add = (id: string, name: string | undefined) => {
    if (!isTelegramChatId(id) || seen.has(id)) return;
    seen.add(id);
    const shown = name ?? (Object.hasOwn(names, id) ? names[id] : undefined);
    users.push(shown ? { id, name: shown } : { id });
  };
  if (runtime === "hermes") {
    for (const user of await readHermesApprovedUsers()) add(user.id, user.name);
  } else {
    const { account } = await readActiveTelegramBot("openclaw");
    for (const id of await readTelegramAllowFrom(account)) add(id, undefined);
  }
  return { runtime, users };
}

export interface OwnerTelegramOptions {
  /**
   * The owner's pick of who is told, by Telegram id; null or absent for the
   * default. See {@link pickTelegramRecipients}.
   */
  recipients?: readonly string[] | null;
}

/**
 * The ids this send goes to, logged the way support reads it: a pick that
 * leaves nobody says why, and a picked id that is no longer approved is named
 * as skipped rather than silently dropped.
 */
function recipientsFor(
  approved: readonly string[],
  picked: readonly string[] | null | undefined,
  tag: string,
  nobodyApproved: string,
): string[] {
  const ids = pickTelegramRecipients(approved, picked);
  if (picked == null) {
    if (ids.length === 0) console.info(`[${tag}] ${nobodyApproved}; notice not sent`);
    return ids;
  }
  const approvedSet = new Set(approved);
  const stale = [...new Set(picked)].filter((id) => !approvedSet.has(id));
  if (stale.length > 0) {
    console.info(`[${tag}] picked Telegram recipients no longer approved, skipped: ${stale.join(", ")}`);
  }
  if (ids.length === 0) {
    console.info(picked.length === 0
      ? `[${tag}] the owner picked nobody to receive this notice on Telegram; notice not sent`
      : `[${tag}] none of the picked Telegram recipients is approved on this device; notice not sent`);
  }
  return ids;
}

/**
 * Send `message` to the owner's approved Telegram users — or, with
 * `options.recipients`, to the owner's pick of them. `tag` names the caller in
 * the log (`[coding-agent] …`), so "no notice arrived" can be traced to the
 * feature that meant to send it. Resolves when every send has been tried;
 * rejects only on a fault outside the sends themselves.
 */
export async function notifyOwnerTelegram(
  message: string,
  tag: string,
  options: OwnerTelegramOptions = {},
): Promise<void> {
  const text = message.slice(0, MAX_TELEGRAM_CHARS);
  const picked = options.recipients;
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
    // "No notice arrived" and "no notice was sent" are different problems. A
    // silent return made them the same one to whoever went looking.
    const ids = recipientsFor(
      (await readHermesApprovedUsers()).map((user) => user.id),
      picked,
      tag,
      "no approved Telegram users on this device",
    );
    for (const id of ids) {
      const ok = await notifyHermesTelegramUser(id, text);
      if (ok) console.info(`[${tag}] telegram notice sent to ${id}`);
      else console.error(`[${tag}] telegram notice to ${id} was not delivered`);
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
  const ids = recipientsFor(
    await readTelegramAllowFrom(account),
    picked,
    tag,
    "no approved Telegram senders on this device",
  );
  for (const id of ids) {
    // The token guard, the request and its timeout are the shared sender's:
    // this leg and the email approval question post to the same bot.
    const ok = await sendTelegramBotMessage(token, id, text);
    if (ok) console.info(`[${tag}] telegram notice sent to ${id}`);
    else console.error(`[${tag}] telegram notice to ${id} was not delivered`);
  }
}
