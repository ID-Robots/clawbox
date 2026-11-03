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
 * A third leg, for a run the ASSISTANT started from a ClawBox chat: a turn in
 * that chat, so the assistant wakes and tells the user how the run ended
 * instead of waiting to be asked — see "The chat that started the run" below.
 *
 * Every failure is swallowed and logged: a notice that does not arrive must
 * never turn a finished run into a failed one.
 */

import { pushPendingAction } from "@/lib/pending-actions";
import { get as configGet } from "@/lib/config-store";
import { kvGet, kvUpdateStrict } from "@/lib/kv-store";
import { PREFERENCE_KEY_PREFIX } from "@/lib/preference-schema";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { isOwnerChatTabKey, type ChatActiveRecord } from "@/lib/chat-tabs";
import { DESKTOP_TRANSCRIPT_KEY } from "@/lib/harness/transcript-key";
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
 * Fire every leg. Never throws; never blocks the caller on Telegram (the
 * Hermes CLI path alone can take seconds) or on the chat (a Hermes turn takes
 * as long as the assistant's answer), which is why it is `void`ed from the
 * run's completion handler — both of its call sites in coding-agent.ts, the
 * settle and the deliverable gate, which between them see every run that ends
 * through its process end once.
 */
export async function announceCodingAgent(run: CodingRun): Promise<void> {
  const message = buildAnnouncement(run);
  await notifyDesktop(run, message);
  await Promise.all([notifyTelegramUnlessOff(run.id, message), notifyOriginChat(run)]);
}

/**
 * The chat leg alone, for the endings that never reach the settle: a paused or
 * orphaned run the owner stops, a queued run canceled or refused its turn, a
 * queued start that could not spawn (coding-agent.ts). They sent no card and no
 * Telegram before this leg existed and send none now — each is the owner's own
 * gesture or shows on the run's page — but the chat that asked for the run was
 * told "started" or "queued", and would otherwise say so until asked. Never
 * throws; `void` it like {@link announceCodingAgent}.
 */
export async function announceCodingRunToChat(run: CodingRun): Promise<void> {
  await notifyOriginChat(run);
}

// ── The chat that started the run ────────────────────────────────────────────
//
// The assistant starts a run with `coding_agent_run`, answers "started", and
// its turn ends. The desktop card and Telegram tell the OWNER when the run
// ends; nothing told the assistant, so the chat stayed silent until the user
// asked "is it done?" (TASK-2132). This leg posts one turn into the chat that
// asked for the run, and the assistant answers it there.
//
// WHICH CHAT. A tool call carries no chat identity on either harness — the MCP
// server's requests hold the bearer and nothing else; OpenClaw spawns one per
// session key and calls its tools with no `_meta` and no session in the
// environment (read off the 2026.10.9 core), and Hermes runs one for every
// session — so the run route asks at the moment the call arrives, while the
// turn that made it is still running (`findChatOrigin`), and this module keeps
// the answer beside the run id in the kv-store until the run ends:
//   - Hermes: the ClawBox chat whose turn is running right now. Every ClawBox
//     Hermes turn is registered by its transcript key (hermes-live-turn.ts).
//   - OpenClaw: the owner's chat session the GATEWAY says has a turn running
//     (`sessions.list` with `activeOnly`, openclaw-gateway-ws.ts) — the main
//     conversation or one of their tabs. Only when the gateway cannot answer,
//     the conversation the owner last sent a turn in (the chat-tab registry's
//     `active`, stamped when the chat sends) stands for it, within
//     CHAT_ORIGIN_WINDOW_MS of that send.
//   Two owner chats busy at once, on either: the one the owner last sent in,
//   else the newest.
// Only the OWNER's chats. This is evidence, not proof. A run the assistant
// starts from a cron job or a ClawBox user's chat gets no chat notice while no
// owner chat has a turn in flight, and its owner still gets the card and
// Telegram. Started while the owner IS busy in a chat, it is told in that chat,
// which is where the owner is. (On OpenClaw a Telegram DM shares the main
// session by default, so a run asked for there is told in the main chat; the
// reply stays in the box's chat, `deliver: false`, and Telegram gets its own
// template from the leg above.)
//
// WHAT IT SAYS. The same rule as the card: ClawBox's template — status, run id,
// counts — never the task or the summary. The assistant reads those itself
// with `coding_agent_status`, as a tool result rather than as words ClawBox
// put in its mouth.
//
// ONCE. The record also holds the endings the chat has been told of — the
// status and the run's `completedAt` — written BEFORE the turn is sent, so a
// second announce of the same ending (a restart's recovery, two settle paths)
// sends nothing. Per ending rather than per run: a run that gave up and was
// resumed in place ends a second time, and that ending is news.
//
// WHEN. After the run's settle chain has committed its work (`waitForRun`),
// boundedly: the assistant answers the notice by reading coding_agent_status,
// and a status read before the commit describes a branch without the work.

/** Which ClawBox chat asked for a run, as the run route recorded it. */
export interface RunChatOrigin {
  /** The harness the chat ran on: a session key means nothing to the other one. */
  harness: Harness;
  /** The owner's tab, or null for their main conversation (whatever key the harness names it by). */
  key: string | null;
  /** When it was recorded — the box's clock. */
  at: number;
}

interface ChatNoticeRecord extends RunChatOrigin {
  /** The endings this run's chat has been told of, each `<status>@<completedAt>` (`endingOf`). */
  told: string[];
}

/** One kv-store entry per run, named after it: `coding-run-chat:<runId>`. */
export const CHAT_NOTICE_KEY_PREFIX = "coding-run-chat:";
/** Runs are kept a while; their chat records need not outlive them by much. */
const MAX_CHAT_NOTICE_RECORDS = 500;
const RUN_ID_RE = /^run-[a-z0-9]{1,32}$/;
/** The endings a chat hears of. A pause is the owner's own gesture, a queue is not an ending. */
const CHAT_NOTICE_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "gave_up", "stopped"]);
const ENDING_RE = /^(?:completed|failed|gave_up|stopped)@\d{1,16}$/;

/** One ending of a run: how, and when — a run resumed in place ends again, later. */
function endingOf(run: CodingRun): string {
  return `${run.status}@${Math.max(0, Math.floor(run.completedAt ?? 0))}`;
}

/**
 * OpenClaw: how long after the owner's last send in a chat a run the assistant
 * starts still counts as asked from that chat. The send opens the assistant's
 * turn and the tool call comes inside it — seconds later, or minutes when the
 * assistant scaffolds a project first. Longer than that, and the run was asked
 * for somewhere else (Telegram, a cron job) while the desktop sat idle.
 */
export const CHAT_ORIGIN_WINDOW_MS = 30 * 60_000;
/** How long the notice waits for the run's work to be committed (coding-agent.ts caps a wait at 2 min). */
const SETTLE_WAIT_MS = 120_000;
/** Hermes: how long the notice waits for a turn already running in the chat before it goes anyway. */
export const HERMES_BUSY_WAIT_MS = 20 * 60_000;
/** Hermes: the notice's own turn — the route answers when the assistant has. */
const HERMES_TURN_TIMEOUT_MS = 15 * 60_000;
const GATEWAY_SEND_TIMEOUT_MS = 15_000;
/** OpenClaw: a gateway that is restarting gets two more tries, this far apart. */
export const GATEWAY_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000];

function isOriginKey(key: unknown): key is string | null {
  return key === null || isOwnerChatTabKey(key);
}

/** One run's entry as the kv-store holds it, or null for none or one this module did not write. */
function parseChatNotice(raw: string | null | undefined): ChatNoticeRecord | null {
  if (!raw) return null;
  let r: Partial<ChatNoticeRecord> | null;
  try {
    r = JSON.parse(raw) as Partial<ChatNoticeRecord> | null;
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if ((r.harness !== "openclaw" && r.harness !== "hermes") || !isOriginKey(r.key ?? null)) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  const told = Array.isArray(r.told) ? r.told.filter((s): s is string => typeof s === "string" && ENDING_RE.test(s)) : [];
  return { harness: r.harness, key: r.key ?? null, at: r.at, told };
}

/**
 * Change the kv-store's entries for runs, in one read-modify-write. The
 * STRICT update: a store that is there and cannot be read throws instead of
 * reading as empty — written back, that empty store would forget every ending
 * already told (and everything else kv.json holds), and each of those chats
 * would be told again. Synchronous from read to rename, so no other request in
 * this process lands in between. Past MAX_CHAT_NOTICE_RECORDS the oldest go.
 */
function updateChatNotices<T>(mutate: (data: Record<string, string>) => T): T {
  return kvUpdateStrict((data) => {
    const result = mutate(data);
    const entries = Object.keys(data).filter((name) => name.startsWith(CHAT_NOTICE_KEY_PREFIX));
    if (entries.length > MAX_CHAT_NOTICE_RECORDS) {
      const age = (name: string) => parseChatNotice(data[name])?.at ?? 0;
      entries.sort((a, b) => age(a) - age(b));
      for (const name of entries.slice(0, entries.length - MAX_CHAT_NOTICE_RECORDS)) delete data[name];
    }
    return result;
  });
}

/**
 * Which of the owner's chats is asking, right now, for a run the assistant is
 * starting — see the section comment above. Null when none is; never throws.
 */
export async function findChatOrigin(now = Date.now()): Promise<RunChatOrigin | null> {
  try {
    const harness = await getActiveHarness();
    const { readOwnerChatTabs } = await import("@/lib/chat-tab-store");
    const { active } = readOwnerChatTabs();
    if (harness === "hermes") {
      const { liveTurnKeys } = await import("@/lib/harness/hermes-live-turn");
      const busy = liveTurnKeys()
        .map((turn) => turn.sessionKey)
        .filter((key) => key === DESKTOP_TRANSCRIPT_KEY || isOwnerChatTabKey(key))
        .map((key) => (key === DESKTOP_TRANSCRIPT_KEY ? null : key));
      const key = busiestChat(busy, active);
      return key === undefined ? null : { harness, key, at: now };
    }
    const busy = await openClawBusyChats();
    if (busy !== null) {
      const key = busiestChat(busy, active);
      return key === undefined ? null : { harness, key, at: now };
    }
    // The gateway could not say: the owner's last send stands for the turn.
    if (!active || now - active.at > CHAT_ORIGIN_WINDOW_MS || !isOriginKey(active.key)) return null;
    // One strip serves both harnesses on a dual box: a Hermes tab the owner
    // was in before a swap is no session the gateway has.
    if (active.key !== null && !active.key.startsWith("agent:")) return null;
    return { harness, key: active.key, at: now };
  } catch (err) {
    console.warn("[coding-agent] could not tell which chat asked for the run:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Of the owner's chats with a turn running (null is the main conversation,
 * newest first), the one the owner last sent in, else the newest; undefined
 * when none is running.
 */
function busiestChat(busy: Array<string | null>, active: ChatActiveRecord | null): string | null | undefined {
  if (busy.length === 0) return undefined;
  if (active && busy.includes(active.key ?? null)) return active.key ?? null;
  return busy[0];
}

/** How long the run's start waits for the gateway to say which session is busy. */
const ACTIVE_SESSIONS_TIMEOUT_MS = 4_000;

/**
 * OpenClaw: the owner's chats the gateway says have a turn running — null for
 * the main conversation, a tab's key otherwise; a channel's, a cron job's or a
 * ClawBox user's session is none of them. Null when the gateway could not be
 * asked (down, restarting, a core without `activeOnly`).
 */
async function openClawBusyChats(): Promise<Array<string | null> | null> {
  try {
    const { gatewayWsActiveSessions } = await import("@/lib/openclaw-gateway-ws");
    const { mainSessionKey, sessionKeys } = await gatewayWsActiveSessions({ timeoutMs: ACTIVE_SESSIONS_TIMEOUT_MS });
    const busy: Array<string | null> = [];
    for (const key of sessionKeys) {
      if (key === mainSessionKey) busy.push(null);
      else if (key.startsWith("agent:") && isOwnerChatTabKey(key)) busy.push(key);
    }
    return busy;
  } catch (err) {
    console.warn("[coding-agent] the gateway did not say which chat is busy; going by the owner's last send:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Keep `origin` beside the run until the run ends. Best effort; never throws. */
export function recordRunChatOrigin(runId: string, origin: RunChatOrigin): void {
  if (!RUN_ID_RE.test(runId) || !isOriginKey(origin.key)) return;
  try {
    updateChatNotices((data) => {
      const entry = `${CHAT_NOTICE_KEY_PREFIX}${runId}`;
      const told = parseChatNotice(data[entry])?.told ?? [];
      const record: ChatNoticeRecord = { harness: origin.harness, key: origin.key, at: origin.at, told };
      data[entry] = JSON.stringify(record);
    });
  } catch (err) {
    console.warn(`[coding-agent] could not record which chat asked for ${runId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Drop the record of a start that did not happen: the route refused it after
 * recording which chat asked, and the caller had the refusal as the tool's own
 * answer, so no run will ever end under that id. Best effort; never throws.
 */
export function forgetRunChatOrigin(runId: string): void {
  if (!RUN_ID_RE.test(runId)) return;
  const entry = `${CHAT_NOTICE_KEY_PREFIX}${runId}`;
  try {
    if (kvGet(entry) === null) return;
    updateChatNotices((data) => {
      delete data[entry];
    });
  } catch (err) {
    console.warn(`[coding-agent] could not forget which chat asked for ${runId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Mark `ending` as told for `runId` and answer the chat to tell — or null when
 * no chat asked for this run, or it has already been told of this ending.
 * Written before anything is sent: a notice lost to a crash is better than one
 * sent twice. The oldest endings go first past a handful: a run is resumed in
 * place a few times, not hundreds.
 */
function claimChatNotice(runId: string, ending: string): RunChatOrigin | null {
  const entry = `${CHAT_NOTICE_KEY_PREFIX}${runId}`;
  // Most runs were never asked for from a chat: a plain look first, so their
  // ending writes nothing. A store that cannot be read answers null here too —
  // no notice, which is the safe direction.
  if (kvGet(entry) === null) return null;
  return updateChatNotices((data) => {
    const record = parseChatNotice(data[entry]);
    if (!record || record.told.includes(ending)) return null;
    record.told = [...record.told, ending].slice(-20);
    data[entry] = JSON.stringify(record);
    return { harness: record.harness, key: record.key, at: record.at };
  });
}

/**
 * The turn the chat is sent. `message` is what the assistant reads; `display`
 * is the first sentence alone, for a transcript that shows a turn the way it
 * was meant for the user (Hermes' `displayText`).
 *
 * `NO_REPLY` only on OpenClaw, where the chat hides that answer: an assistant
 * the user asked to wait with them has told them already. Hermes' transcript
 * would show the word itself.
 */
export function buildChatNotice(run: CodingRun, harness: Harness): { message: string; display: string } {
  const where = run.projectId ? ` in project "${run.projectId}"` : "";
  const files = run.filesTouched.length;
  const counts = `${run.numTurns} turn${run.numTurns === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} changed, ${duration(run)}`;
  const tag = `[Coding run ${run.id}]`;
  let display: string;
  let ask: string;
  switch (run.status) {
    case "completed":
      display = `${tag} finished${where} (${counts}).`;
      ask = `Read coding_agent_status for ${run.id} and tell the user how it went, in a few lines.`;
      break;
    case "stopped":
      display = `${tag} was stopped${where} (${counts}).`;
      ask = `Tell the user it was stopped, and do not start it again unless they ask you to. coding_agent_status for ${run.id} says what it did.`;
      break;
    case "gave_up":
      display = `${tag} gave up before finishing${where} (${counts}).`;
      ask = `Read coding_agent_status for ${run.id} and tell the user why, in a few lines.`;
      break;
    default:
      display = `${tag} did not finish${where} (${counts}).`;
      ask = `Read coding_agent_status for ${run.id} and tell the user what went wrong, in a few lines.`;
  }
  const already = harness === "openclaw"
    ? "If you have already told them how this run ended, reply NO_REPLY."
    : "If you have already told them how this run ended, say so in one line.";
  return { message: `${display} ${ask} ${already}`, display };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

async function sendOpenClawChatNotice(key: string | null, message: string, idempotencyKey: string): Promise<void> {
  const gateway = await import("@/lib/openclaw-gateway-ws");
  for (let attempt = 0; ; attempt += 1) {
    try {
      // The same `chat.send` the chat's own turns are, so the gateway answers it
      // in that session and every chat open on it shows both; `deliver: false`
      // keeps the reply off any channel. The idempotency key is the run's and
      // the ending's, so a retry after a lost answer is the same turn.
      if (key === null) {
        await gateway.gatewayWsChatSendMain(message, { idempotencyKey, timeoutMs: GATEWAY_SEND_TIMEOUT_MS });
      } else {
        await gateway.gatewayWsCall("chat.send", { sessionKey: key, message, deliver: false, idempotencyKey }, { timeoutMs: GATEWAY_SEND_TIMEOUT_MS });
      }
      return;
    } catch (err) {
      const delay = GATEWAY_RETRY_DELAYS_MS[attempt];
      if (!(err instanceof gateway.GatewayWsUnavailableError) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

/** A notice turn that failed before the assistant answered anything. */
class HermesTurnRefused extends Error {}

/**
 * Hermes: a turn through the box's own chat route, as the chat's own turns
 * go — the route records the question and the answer in the transcript the
 * chat shows, resumes the Hermes session the chat is on, and registers the
 * turn live so an open chat follows it. Called with the agent's bearer, which
 * that route serves as the owner, the only person this leg writes to.
 *
 * After every turn running in that chat — one the owner sends during the wait
 * too: a second `hermes chat --resume` on a busy session is a second agent
 * beside the first, not a turn after it.
 *
 * Resolves "late" when the route had not answered within its timeout: the turn
 * belongs to the box and goes on without this request, so that is not a
 * notice lost.
 *
 * A resumed session the turn could not use — Hermes refuses one another of
 * its transports holds (`SESSION_NOT_OWNED`, seen on a board when the notice
 * went the CLI way into a session the dashboard had opened) — is tried once
 * more in a fresh session, but only when nothing was answered yet: the notice
 * names the run and asks for its status, so it stands without the
 * conversation before it.
 */
async function sendHermesChatNotice(key: string, notice: { message: string; display: string }): Promise<"sent" | "late"> {
  const { whenLiveTurnsSettle } = await import("@/lib/harness/hermes-live-turn");
  await Promise.race([whenLiveTurnsSettle(key), sleep(HERMES_BUSY_WAIT_MS)]);
  const { readTranscript } = await import("@/lib/harness/transcript-store");
  // Read after the wait: the turn just waited for may have moved the chat onto a new session.
  const sessionId = (await readTranscript(50, key)).findLast((record) => record.sessionId)?.sessionId;
  const body = { message: notice.message, displayText: notice.display, sessionKey: key };
  if (!sessionId) return hermesChatTurn(body);
  try {
    return await hermesChatTurn({ ...body, sessionId });
  } catch (err) {
    if (!(err instanceof HermesTurnRefused)) throw err;
    console.warn(`[coding-agent] the chat's session would not take the notice (${err.message}); sending it in a new session`);
    return hermesChatTurn(body);
  }
}

/**
 * One turn through the chat route, STREAMED, as the desktop chat sends its own
 * (`Accept: text/event-stream`): the route then resumes the session over the
 * same transport the chat's turns used, and the open chat follows the turn
 * live. The answer is read to its end — the stream's `done` or `error` frame
 * is the only word on how the turn went, its status being spent on the first
 * byte. A JSON answer is the route's CLI fallback when the dashboard is not up.
 */
async function hermesChatTurn(body: Record<string, unknown>): Promise<"sent" | "late"> {
  const { getMcpToken } = await import("@/lib/mcp-token");
  const port = /^\d{1,5}$/.test(process.env.PORT ?? "") ? process.env.PORT : "80";
  let res: Response;
  let text: string;
  try {
    res = await fetch(`http://127.0.0.1:${port}/setup-api/hermes/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${getMcpToken()}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HERMES_TURN_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return "late";
    throw err;
  }
  if (!res.ok) throw new HermesTurnRefused(`the chat answered ${res.status}${errorOf(parseJson(text))}`);
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return "sent";
  let answered = false;
  for (const block of text.split("\n\n")) {
    const event = /^event: (\S+)$/m.exec(block)?.[1];
    if (event === "delta") answered = true;
    if (event === "done") return "sent";
    if (event === "error") {
      const why = `the chat's turn failed${errorOf(parseJson(/^data: (.*)$/m.exec(block)?.[1] ?? ""))}`;
      throw answered ? new Error(why) : new HermesTurnRefused(why);
    }
  }
  // Cut off before it said how the turn went: the turn is the box's and goes on.
  return "late";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `: <the route's own sentence>`, or nothing — the route has already made it safe to show. */
function errorOf(data: unknown): string {
  const error = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
  return typeof error === "string" && error ? `: ${error.slice(0, 200)}` : "";
}

/** The chat leg; never throws. */
async function notifyOriginChat(run: CodingRun): Promise<void> {
  try {
    if (!CHAT_NOTICE_STATUSES.has(run.status)) return;
    const ending = endingOf(run);
    const origin = claimChatNotice(run.id, ending);
    if (!origin) return;
    const harness = await getActiveHarness();
    if (harness !== origin.harness) {
      console.info(`[coding-agent] ${run.id} was asked for from a ${origin.harness} chat and the box now runs ${harness}; chat notice not sent`);
      return;
    }
    // After the settle chain has committed the run's work — see WHEN above. A
    // run that never reached the settle (a queue, a stop on paper) answers at
    // once; the wait is capped, and a notice late by that much still goes.
    const { waitForRun } = await import("@/lib/coding-agent");
    await waitForRun(run.id, SETTLE_WAIT_MS);
    // Loaded here, as everything this leg reads: the module's other legs, and
    // the many tests that import it for them, need none of it. A tab the owner
    // has closed since is not where they will look; their main chat is.
    const { readOwnerChatTabs } = await import("@/lib/chat-tab-store");
    const key = origin.key !== null && readOwnerChatTabs().closed.includes(origin.key) ? null : origin.key;
    const notice = buildChatNotice(run, harness);
    if (harness === "openclaw") {
      await sendOpenClawChatNotice(key, notice.message, `coding-run-${run.id}-${ending.replace("@", "-")}`);
    } else if ((await sendHermesChatNotice(key ?? DESKTOP_TRANSCRIPT_KEY, notice)) === "late") {
      console.warn(`[coding-agent] the chat's turn about ${run.id} is still running after ${HERMES_TURN_TIMEOUT_MS / 60_000} min; it answers in the chat when it is done`);
      return;
    }
    console.info(`[coding-agent] told the chat that asked for ${run.id} that it ended ${run.status}`);
  } catch (err) {
    console.error(`[coding-agent] the chat that asked for ${run.id} was not told it ended:`, err instanceof Error ? err.message : err);
  }
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
