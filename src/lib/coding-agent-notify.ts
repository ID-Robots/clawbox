/**
 * Telling the owner a coding run has ended.
 *
 * Two legs, both best-effort and one-way, both authored by ClawBox:
 *
 *   1. The desktop: the owner-notice ring (src/lib/pending-actions.ts) that
 *      `notifyOwner()` in src/lib/email-notify.ts and the MCP `ui_notify`
 *      tool write too. Every open desktop polls it and shows a top-right
 *      card with a button into the Coding Agent app.
 *   2. Telegram, when a bot is connected: a short message to the people the
 *      owner has approved to talk to the bot. On Hermes that goes through
 *      `hermes send` (src/lib/hermes-telegram.ts); on OpenClaw the web server
 *      has no CLI send path, so it calls the Bot API directly with the stored
 *      token — the same token telegram/status already uses for `getMe`.
 *
 *      The two editions therefore have DIFFERENT credentials, and the check
 *      has to sit on the edition's own side of the branch: Hermes' bot token
 *      lives in ~/.hermes/.env and is never read here, so ClawBox's copy of a
 *      token says nothing about whether that box can send.
 *
 * WHAT THE MESSAGE SAYS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The text is a fixed template: status, run id, a few counts. It never
 * contains the task or the summary. Both were written by a model working from
 * text the assistant read, and email-notify.ts's rule applies unchanged — a
 * notice is ClawBox speaking to the owner, not a channel for anyone else. The
 * summary is one tool call (or one Settings click) away.
 *
 * Every failure is swallowed and logged: a notice that does not arrive must
 * never turn a finished run into a failed one.
 */

import { pushPendingAction } from "@/lib/pending-actions";
import { get as configGet } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { notifyHermesTelegramUser, readHermesApprovedUsers } from "@/lib/hermes-telegram";
import { readTelegramAllowFrom } from "@/lib/openclaw-config";
import type { CodingRun } from "@/lib/coding-agent";

const MAX_TOAST_CHARS = 280;
/** Telegram's own limit is 4096; the template never gets near it. */
const MAX_TELEGRAM_CHARS = 1_000;
/** Approved senders are the household, not a mailing list. */
const MAX_TELEGRAM_RECIPIENTS = 5;
const TELEGRAM_TIMEOUT_MS = 8_000;
const CHAT_ID_RE = /^-?\d{1,20}$/;
// The bot token is interpolated into the request path, so constrain it to the
// shape Telegram issues (`<bot_id>:<secret>`) before it is ever used. The
// charset is the part that matters: no "/", "?", "#" or "@" means a config
// value cannot reshape the path or the request, and the host is a literal
// either way. No length floor — that would only reject valid tokens if Telegram
// changes format, and adds nothing the charset does not already give.
// This is also the check CodeQL wants for its "file data in outbound network
// request" alerts.
const BOT_TOKEN_RE = /^(\d{1,20}):([A-Za-z0-9_-]{1,200})$/;

function duration(run: CodingRun): string {
  const ms = (run.completedAt ?? Date.now()) - run.startedAt;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

/** The notice text. Exported so the test can pin what it must not contain. */
export function buildAnnouncement(run: CodingRun): string {
  const where = run.projectId ? `project "${run.projectId}"` : "its folder";
  const files = run.filesTouched.length;
  const counts = `${run.numTurns} turn${run.numTurns === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} changed, ${duration(run)}`;
  switch (run.status) {
    case "completed":
      return `Coding agent finished ${run.id} in ${where} (${counts}).`
        + (run.permissionDenials > 0 ? ` ${run.permissionDenials} action${run.permissionDenials === 1 ? " was" : "s were"} not allowed.` : "")
        + " Ask your assistant for the summary, or open the Coding Agent app.";
    case "stopped":
      return `Coding agent run ${run.id} in ${where} was stopped (${counts}).`
        + " Whatever it changed is still there — open the Coding Agent app to see.";
    default:
      return `Coding agent run ${run.id} in ${where} did not finish (${counts}). Open the Coding Agent app for the reason.`;
  }
}

/**
 * The desktop notice.
 *
 * Its own action type rather than the generic `notify` toast: a finished run
 * is something the owner may want to ACT on — read the summary, see what was
 * changed — and the desktop's top-right cards are where a notice with a button
 * belongs. The toast is for one-line remarks with nowhere to go.
 *
 * The extra fields are facts the device already knows (which run, how it
 * ended, which project). Still no task and no summary: those are model-authored
 * and the rule in this file's header applies to a card exactly as it does to a
 * toast.
 *
 * The entry is named after the run, so a desktop that sees it twice (two
 * polls, a reload) shows one card.
 */
async function notifyDesktop(run: CodingRun, message: string): Promise<void> {
  try {
    await pushPendingAction(
      {
        type: "coding_agent",
        message: message.slice(0, MAX_TOAST_CHARS),
        runId: run.id,
        status: run.status,
        projectId: run.projectId,
      },
      `coding:${run.id}`,
    );
  } catch (err) {
    console.error("[coding-agent] desktop notice failed:", err instanceof Error ? err.message : err);
  }
}

async function sendTelegramDirect(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    // Interpolated raw, not encoded: Telegram wants the literal "<id>:<secret>",
    // and encodeURIComponent turns the colon into %3A, which the API rejects.
    // BOT_TOKEN_RE is what makes this safe — the caller has already proved the
    // value holds nothing that could reshape the URL.
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No parse_mode: the text is plain, and a stray underscore must not turn
      // into a Markdown error that swallows the whole notice.
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function notifyTelegram(message: string): Promise<void> {
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
    const users = (await readHermesApprovedUsers()).slice(0, MAX_TELEGRAM_RECIPIENTS);
    if (users.length === 0) {
      // "No notice arrived" and "no notice was sent" are different problems.
      // A silent return made them the same one to whoever went looking.
      console.info("[coding-agent] no approved Telegram users on this device; notice not sent");
      return;
    }
    for (const user of users) {
      const ok = await notifyHermesTelegramUser(user.id, text);
      if (!ok) console.error(`[coding-agent] telegram notice to ${user.id} was not delivered`);
    }
    return;
  }

  // OpenClaw: the web server has no CLI send path, so it calls the Bot API
  // itself and the stored token IS the credential — no token, nothing to send
  // with.
  const token = await configGet("telegram_bot_token");
  if (typeof token !== "string" || !token.trim()) {
    console.info("[coding-agent] no Telegram bot is configured on this device; notice not sent");
    return;
  }
  // Rebuild the token from the match rather than testing and reusing the
  // original. Same value either way, but the one that reaches the URL is now
  // constructed here out of characters the pattern allows, which is what lets
  // CodeQL see the check as a sanitizer instead of an unrelated branch.
  const matched = BOT_TOKEN_RE.exec(token.trim());
  if (!matched) {
    console.error("[coding-agent] telegram bot token is not a valid token; notice not sent");
    return;
  }
  const botToken = `${matched[1]}:${matched[2]}`;

  const ids = (await readTelegramAllowFrom())
    .filter((id) => CHAT_ID_RE.test(id))
    .slice(0, MAX_TELEGRAM_RECIPIENTS);
  if (ids.length === 0) {
    console.info("[coding-agent] no approved Telegram senders on this device; notice not sent");
    return;
  }
  for (const id of ids) {
    const ok = await sendTelegramDirect(botToken, id, text);
    if (!ok) console.error(`[coding-agent] telegram notice to ${id} was not delivered`);
  }
}

/**
 * Fire both legs. Never throws; never blocks the caller on Telegram (the
 * Hermes CLI path alone can take seconds), which is why it is `void`ed from
 * the run's completion handler.
 */
export async function announceCodingAgent(run: CodingRun): Promise<void> {
  const message = buildAnnouncement(run);
  await notifyDesktop(run, message);
  try {
    await notifyTelegram(message);
  } catch (err) {
    console.error("[coding-agent] telegram notice failed:", err instanceof Error ? err.message : err);
  }
}
