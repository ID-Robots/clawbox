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
 *      The owner can switch this leg off for the finish notice and keep the
 *      desktop card — see {@link codingAgentTelegramOff}.
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
import { PREFERENCE_KEY_PREFIX } from "@/lib/preference-schema";
import { getActiveHarness } from "@/lib/harness";
import { notifyHermesTelegramUser, readHermesApprovedUsers } from "@/lib/hermes-telegram";
import { readTelegramAllowFrom } from "@/lib/openclaw-config";
import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";
import { isTelegramBotToken, sendTelegramBotMessage } from "@/lib/telegram-owner-send";
import type { CodingRun } from "@/lib/coding-agent";
import type { TeamBoard } from "@/lib/coding-team-board";
import { formatResetClock } from "@/lib/anthropic-limit";
import { OPEN_ANTHROPIC_ACCOUNTS_SETTINGS } from "@/lib/notify-action";

const MAX_TOAST_CHARS = 280;
/** Telegram's own limit is 4096; the template never gets near it. */
const MAX_TELEGRAM_CHARS = 1_000;
/** Approved senders are the household, not a mailing list. */
const MAX_TELEGRAM_RECIPIENTS = 5;
const CHAT_ID_RE = /^-?\d{1,20}$/;

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
      console.info("[coding-agent] no Telegram bot is configured on this device; notice not sent");
    } else {
      console.error("[coding-agent] this device's Telegram bot could not be read; notice not sent");
    }
    return;
  }
  // Said ONCE, before the fan-out, and not five times as "not delivered": a
  // token that is not a token is a different problem from a Telegram that would
  // not answer, and the second reading sends support to the wrong place.
  if (!isTelegramBotToken(token)) {
    console.error("[coding-agent] telegram bot token is not a valid token; notice not sent");
    return;
  }
  const ids = (await readTelegramAllowFrom(account))
    .filter((id) => CHAT_ID_RE.test(id))
    .slice(0, MAX_TELEGRAM_RECIPIENTS);
  if (ids.length === 0) {
    console.info("[coding-agent] no approved Telegram senders on this device; notice not sent");
    return;
  }
  for (const id of ids) {
    // The token guard, the request and its timeout are the shared sender's:
    // this leg and the email approval question post to the same bot.
    const ok = await sendTelegramBotMessage(token, id, text);
    if (!ok) console.error(`[coding-agent] telegram notice to ${id} was not delivered`);
  }
}

/**
 * The owner's switch for the Telegram leg of the finish notice.
 *
 * A preference, stored where every other one is — `pref:<name>` in the config
 * store, written through POST /setup-api/preferences — and read on every
 * notice, so a change holds from the next run on without a restart. The name
 * carries the `ui_` prefix because that route skips a name without one of its
 * prefixes: a bare `coding_agent_telegram_notify` would be answered `ok: true`
 * and never stored.
 *
 * The web server's environment can say the same for a box its operator set
 * up: `CLAWBOX_CODING_AGENT_TELEGRAM=off`.
 *
 * Either one saying off is enough. Anything else — unset, true, "on", a value
 * this does not recognise, a store that cannot be read — leaves the leg ON:
 * that is what every box has done until now, and a switch that failed closed
 * would silence a box nobody asked to be quiet.
 *
 * Only the finish notice, and only its Telegram leg. The desktop card stays
 * whatever this says, and the Anthropic account-limit notices below still go
 * to Telegram: they are rare, and the auth one asks the owner to sign in again.
 */
export const CODING_AGENT_TELEGRAM_PREF = "ui_coding_agent_telegram_notify";
export const CODING_AGENT_TELEGRAM_ENV = "CLAWBOX_CODING_AGENT_TELEGRAM";

const OFF_WORDS: ReadonlySet<string> = new Set(["off", "false", "0", "no"]);

function saysOff(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return typeof value === "string" && OFF_WORDS.has(value.trim().toLowerCase());
}

/** Which of the two switched the Telegram leg off, or null when it is on. */
export async function codingAgentTelegramOff(): Promise<"env" | "pref" | null> {
  if (saysOff(process.env[CODING_AGENT_TELEGRAM_ENV])) return "env";
  try {
    if (saysOff(await configGet(`${PREFERENCE_KEY_PREFIX}${CODING_AGENT_TELEGRAM_PREF}`))) return "pref";
  } catch {
    // On, as above: a store that cannot be read is not the owner saying off.
  }
  return null;
}

/** The Telegram leg of a finish notice, behind the owner's switch; never throws. */
async function notifyTelegramUnlessOff(what: string, message: string): Promise<void> {
  try {
    const off = await codingAgentTelegramOff();
    if (off) {
      const by = off === "env" ? CODING_AGENT_TELEGRAM_ENV : `the ${CODING_AGENT_TELEGRAM_PREF} preference`;
      console.info(`[coding-agent] telegram notice for ${what} switched off by ${by}; desktop notice only`);
      return;
    }
    await notifyTelegram(message);
  } catch (err) {
    console.error("[coding-agent] telegram notice failed:", err instanceof Error ? err.message : err);
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
  await notifyTelegramUnlessOff(run.id, message);
}

/**
 * A coding TEAM's notice: ONE per team, when it settles, and none from its
 * member runs (coding-agent.ts sends no run notice while `run.team` is set).
 * A team of five used to put five run cards on the desktop and say nothing
 * about the team, so the assistant built itself a cron watcher per team.
 *
 * The same rule as the run's text, and the same reason: a fixed template
 * with the status, the task counts and the branch the box itself named —
 * never the goal, a task, a result, a review's notes or `board.error`, every
 * one of which carries a model's words. Exported so the test can pin that.
 */
export function buildTeamAnnouncement(board: TeamBoard): string {
  const where = board.projectId ? `project "${board.projectId}"` : "its folder";
  // A retired task will never be done: counted, a finished team reads as unfinished.
  const tasks = board.tasks.filter((t) => t.status !== "retired");
  const done = tasks.filter((t) => t.status === "complete").length;
  const notDone = tasks.filter((t) => t.status === "failed" || t.status === "rejected").length;
  const counts = `${done} of ${tasks.length} task${tasks.length === 1 ? "" : "s"} done`
    + (notDone > 0 ? `, ${notDone} failed` : "")
    + (board.branch ? `, on branch ${board.branch}` : "")
    // A team whose work the project did not take says where it is instead:
    // "did not finish" alone sent the reader looking in an empty folder.
    + (board.unlanded ? `, the work is on branch ${board.unlanded.branch} and not in the project` : "")
    + (board.pr ? `, pull request #${board.pr.number}` : "");
  switch (board.status) {
    case "done":
      return `Coding team ${board.id} finished in ${where} (${counts}). Ask your assistant for the summary, or open the Coding Agent app.`;
    case "stopped":
      return `Coding team ${board.id} in ${where} was stopped (${counts}). What it merged is still there — open the Coding Agent app to see.`;
    default:
      return `Coding team ${board.id} in ${where} did not finish (${counts}). Open the Coding Agent app for the reason.`;
  }
}

/**
 * The team's notice, both legs; never throws. On the desktop it is a
 * `coding_team settled` ring action — the same top-right FINISH CARD a run
 * gets, with an Open button that hands the app the team's id
 * (`handoffCodingTeam`) — named after the team so a desktop that sees it
 * twice shows it once. It used to be a plain toast, because the finish card
 * could only hand over a run id; the chat's cards and the team hand-off made
 * the card the right shape (2026-10-30).
 */
export async function announceCodingTeam(board: TeamBoard): Promise<void> {
  const message = buildTeamAnnouncement(board);
  // A retired task will never be done; counted, a finished team read as unfinished.
  const tasks = board.tasks.filter((t) => t.status !== "retired");
  try {
    await pushPendingAction({
      type: "coding_team",
      phase: "settled",
      teamId: board.id,
      projectId: board.projectId,
      status: board.status,
      tasksDone: tasks.filter((t) => t.status === "complete").length,
      tasksTotal: tasks.length,
      ...(board.pr ? { prNumber: board.pr.number } : {}),
      message: message.slice(0, MAX_TOAST_CHARS),
    }, `coding-team:${board.id}`);
  } catch (err) {
    console.error("[coding-team] desktop notice failed:", err instanceof Error ? err.message : err);
  }
  await notifyTelegramUnlessOff(board.id, message);
}

/**
 * An Anthropic account hit its usage limit (TASK-902).
 *
 * TWO notices, and deliberately only two: one when an account becomes limited
 * and the box moves to the next one, and one when that leaves NO account able
 * to answer. None when the box goes back to the preferred account after its
 * reset — that is the box working as intended, and a message about it every
 * five hours would teach the owner to ignore the other two.
 *
 * The words carry the owner's own LABELS and a clock, never an email or a
 * credential. They go where the finish notice goes — the desktop and the
 * owner's Telegram chat — but on the desktop as a plain notice that opens
 * Settings → Providers, not as a run card: the run card is deduped by run
 * id, and this would have taken the place of the run's own finish notice.
 */
export type AnthropicLimitNotice =
  | {
    kind: "switched";
    /** What took the account out (TASK-1260): its usage limit, or Anthropic refusing its credential. Absent is a limit. */
    reason?: "limit" | "auth";
    fromLabel: string;
    toLabel: string;
    resetAt: number | null;
    runId: string | null;
  }
  | { kind: "all_limited"; resetAt: number | null; runId: string | null };

export function buildAnthropicLimitNotice(notice: AnthropicLimitNotice, timeZone?: string): string {
  if (notice.kind === "switched") {
    const why = notice.reason === "auth"
      ? `was refused by Anthropic and needs to be signed in again (Settings → Providers)`
      : notice.resetAt !== null
        ? `hit its usage limit (back at ${formatResetClock(notice.resetAt, timeZone)})`
        : "hit its usage limit";
    // Since TASK-1260 the switch moves every Claude consumer on the box, not
    // only the run that hit it: the chat and its scheduled tasks too.
    return `Anthropic account "${notice.fromLabel}" ${why}.`
      + ` ClawBox switched everything that uses Claude to "${notice.toLabel}"${notice.runId ? ` and ${notice.runId} carried on` : ""}.`;
  }
  const when = notice.resetAt !== null ? `at ${formatResetClock(notice.resetAt, timeZone)}` : "as soon as one is back";
  return `Every Anthropic account on this ClawBox is at its usage limit.`
    + ` Coding runs and the chat's Claude work are waiting instead of failing, and pick up again ${when}.`;
}

export async function announceAnthropicLimit(notice: AnthropicLimitNotice): Promise<void> {
  const message = buildAnthropicLimitNotice(notice);
  try {
    await pushPendingAction({ type: "notify", message: message.slice(0, MAX_TOAST_CHARS), action: OPEN_ANTHROPIC_ACCOUNTS_SETTINGS });
  } catch (err) {
    console.error("[anthropic-accounts] desktop notice failed:", err instanceof Error ? err.message : err);
  }
  try {
    await notifyTelegram(message);
  } catch (err) {
    console.error("[anthropic-accounts] telegram notice failed:", err instanceof Error ? err.message : err);
  }
}
