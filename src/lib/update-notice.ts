/**
 * The weekly update check and the notice it sends (TASK-2260).
 *
 * WHAT THE OWNER GETS. Every Monday morning on the box's clock
 * (src/lib/update-notice-schedule.ts says exactly when) the box asks the
 * updater — the SAME check the Update screen runs, `getVersionInfo` with its
 * cache dropped, never a second checker — whether the branch it follows has
 * something newer than what is installed. If it has, the owner hears about it
 * ONCE: one Telegram message on the box's own bot with the version, a few
 * lines of what's new (the release notes' Highlights, `readUpdateWhatsNew`) and
 * an "Update" button; or, with no Telegram connected, a desktop notice that
 * opens Settings → Update. Nothing newer: nothing is sent. A version the owner
 * was already told about is never announced again (`lastNotifiedTarget`).
 *
 * THE BUTTON ONLY ASKS. Its tap goes to whoever polls the main bot — the
 * harness — and reaches ClawBox through the plugin hook the box already ships
 * (`before_dispatch` on OpenClaw, a scoped callback handler on Hermes) and
 * /setup-api/update/chat-command. That is the agent's process, which is why
 * src/lib/email-approval-telegram.ts refuses to let a main-bot button APPROVE
 * anything — and this one does not: a tap from an owner-allowlisted sender
 * becomes `requestPowerApproval("update")`, exactly what the MCP bearer gets
 * from /setup-api/update/request, and the update runs only when the owner
 * answers that question with Confirm on the desktop or the approvals bot.
 * There is no path from a chat message to `startUpdate`.
 *
 * /update in the owner's private chat is the same check on demand: it answers
 * "up to date", or sends the same message with the same button.
 *
 * SERVER ONLY.
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "@/lib/runtime-path";
import { get as configGet, resolveConfigRoot, set as configSet } from "@/lib/config-store";
import { processStore } from "@/lib/process-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { notifyOwner } from "@/lib/email-notify";
import { OPEN_UPDATE_SETTINGS } from "@/lib/notify-action";
import { isPreferenceLanguage, PREFERENCE_KEY_PREFIX } from "@/lib/preference-schema";
import {
  sendOwnerTelegramButtons,
  sendOwnerTelegramText,
  TELEGRAM_CHAT_ID_RE,
  type TelegramCallbackButton,
} from "@/lib/telegram-owner-send";
import { updateNoticeEn } from "@/lib/edition-translations/en-update-notice";
import { drawJitter, clampJitter, isCheckDue, type UpdateCheckPlan } from "@/lib/update-notice-schedule";

const TAG = "[update-notice]";

/** The owner's switch, a plain config key. Absent means ON — the default the brief asks for. */
export const WEEKLY_UPDATE_CHECK_KEY = "update_weekly_check";

/**
 * The Update button's `callback_data`, and the whole of it. No nonce: the tap
 * only ever ASKS (see the header), so there is nothing a replayed or forged tap
 * could spend. Deliberately not a `/` command: OpenClaw dispatches callback
 * data that starts with "/" as that command, and its OWN `/update` updates the
 * OpenClaw core underneath ClawBox. Outside OpenClaw's reserved prefixes
 * (`tga1:`, `tgcmd:`, `tgcb1:`, `mdl1~`) and Hermes' (`mp:`, `cp:`, `ea:`, …).
 */
export const UPDATE_BUTTON_DATA = "clawbox-update";

/** Approved senders are the household, not a mailing list (owner-telegram.ts uses the same cap). */
const MAX_RECIPIENTS = 5;
/** How many Highlights titles the message carries. A notice, not the release notes. */
const MAX_HIGHLIGHTS = 3;
/** The desktop notice's own ceiling (email-notify.ts cuts at 280). */
const MAX_DESKTOP_CHARS = 280;
/** A second /update inside this window reuses the last answer instead of asking GitHub again. */
export const FORCED_CHECK_MIN_INTERVAL_MS = 60_000;

// ── The words ───────────────────────────────────────────────────────────────

export type Translate = (key: string, params?: Record<string, string | number>) => string;

function interpolate(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : whole);
}

/** A `t` over one locale table, falling back to this feature's English. */
export function translatorFor(table: Record<string, string>): Translate {
  return (key, params) => interpolate(
    (Object.hasOwn(table, key) ? table[key] : undefined) ?? updateNoticeEn[key] ?? key,
    params,
  );
}

/** The box's language (the owner's — `pref:ui_language`). English when unset or unreadable. */
export async function boxTranslator(): Promise<Translate> {
  let lang: unknown = "en";
  try {
    lang = await configGet(`${PREFERENCE_KEY_PREFIX}ui_language`);
  } catch {
    // English, below.
  }
  try {
    const { loadLocaleTable } = await import("@/lib/translation-chunks");
    return translatorFor(await loadLocaleTable(isPreferenceLanguage(lang) ? lang : "en"));
  } catch {
    return translatorFor(updateNoticeEn);
  }
}

// ── What the updater says ───────────────────────────────────────────────────

export interface UpdateAvailability {
  /** `unknown`: the check could not reach the update remote — no verdict at all. */
  status: "available" | "current" | "unknown";
  /** The installed version, for people: `4.3.0`. */
  current: string;
  /** The updater's own name for the target (`v4.3.1`, `beta@1a2b3c4`); the notice's identity. */
  target: string | null;
  /** The target, for people: `4.3.1`, or `4.3.0 (beta@1a2b3c4)` for a branch build. */
  version: string | null;
  /** Up to three Highlights titles from the target's release notes. */
  highlights: string[];
}

/** `v4.3.0` → `4.3.0`; anything else as it came. */
export function displayVersion(raw: string | null | undefined): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return /^v\d/.test(value) ? value.slice(1) : value;
}

/** The target as the owner should read it, given what the notes say the target's package.json is. */
export function targetLabel(target: string, notesVersion: string | null): string {
  if (/^v\d/.test(target)) return displayVersion(target);
  return notesVersion ? `${notesVersion} (${target})` : target;
}

/** When the cache was last dropped — shared by the weekly run and /update, across module copies. */
const forced = processStore("update-notice:forced", () => ({ at: 0 }));

/** Tests only: forget the last forced check. */
export function resetForcedCheckForTests(): void {
  forced.at = 0;
}

/**
 * Ask the updater. `fresh` drops its 30-minute cache first — what the Update
 * screen's "Check for updates" does (`/update/versions?force=1`) — so the
 * weekly check really looks; a /update typed twice in a minute does not.
 * Never throws: a check that broke is a check that could not look.
 */
export async function checkForUpdate(fresh: boolean): Promise<UpdateAvailability> {
  try {
    const updater = await import("@/lib/updater");
    if (fresh) {
      updater.invalidateVersionCache();
      forced.at = Date.now();
    }
    const info = await updater.getVersionInfo();
    const current = displayVersion(info.clawbox.current);
    const target = info.clawbox.target;
    if (info.clawbox.updateAvailable === true && target) {
      let notesVersion: string | null = null;
      let highlights: string[] = [];
      try {
        const { readUpdateWhatsNew } = await import("@/lib/update-whats-new-server");
        const notes = await readUpdateWhatsNew();
        notesVersion = notes.version;
        // A tag names one version; Highlights that belong to another are not
        // this update's news. A branch build is whatever its ref says.
        if (!/^v\d/.test(target) || notes.version === displayVersion(target)) {
          highlights = notes.highlights.slice(0, MAX_HIGHLIGHTS).map((h) => h.title.trim()).filter(Boolean);
        }
      } catch {
        // The notice still says which version; the news is a bonus.
      }
      return { status: "available", current, target, version: targetLabel(target, notesVersion), highlights };
    }
    if (info.clawbox.updateAvailable === false) {
      return { status: "current", current, target: null, version: null, highlights: [] };
    }
    console.warn(`${TAG} the update remote could not be reached: ${info.remote.reason ?? "no reason given"}`);
    return { status: "unknown", current, target: null, version: null, highlights: [] };
  } catch (err) {
    console.warn(`${TAG} the update check failed:`, err instanceof Error ? err.message : err);
    return { status: "unknown", current: "", target: null, version: null, highlights: [] };
  }
}

/** Is an update running right now? Then there is nothing to announce or to ask for. */
async function updateRunning(): Promise<boolean> {
  try {
    const { getUpdateState } = await import("@/lib/updater");
    return getUpdateState().phase === "running";
  } catch {
    return false;
  }
}

// ── The message ─────────────────────────────────────────────────────────────

/** The Telegram message: version, a few lines of news, what the button does. */
export function buildTelegramNotice(a: UpdateAvailability, t: Translate): string {
  const lines = [t("updateNotice.available", { version: a.version ?? "", current: a.current })];
  if (a.highlights.length) {
    lines.push("", t("updateNotice.whatsNew"), ...a.highlights.map((h) => `• ${h}`));
  }
  lines.push("", t("updateNotice.tapUpdate"));
  return lines.join("\n");
}

/** The same notice without a button, for a send path that cannot carry one. */
export function buildPlainNotice(a: UpdateAvailability, t: Translate): string {
  return [
    t("updateNotice.available", { version: a.version ?? "", current: a.current }),
    ...(a.highlights.length ? ["", t("updateNotice.whatsNew"), ...a.highlights.map((h) => `• ${h}`)] : []),
    "",
    t("updateNotice.openSettings"),
  ].join("\n");
}

/** The desktop notice. Its click opens Settings → Update, which says the rest. */
export function buildDesktopNotice(a: UpdateAvailability, t: Translate): string {
  return t("updateNotice.available", { version: a.version ?? "", current: a.current }).slice(0, MAX_DESKTOP_CHARS);
}

export function updateButton(t: Translate): TelegramCallbackButton {
  return { text: t("updateNotice.button"), callback_data: UPDATE_BUTTON_DATA };
}

async function telegramOwners(harness: Harness): Promise<string[]> {
  try {
    // Lazy: email-approval sits in the approval poller's import cycle.
    const { ownerChatIds } = await import("@/lib/email-approval");
    return (await ownerChatIds(harness)).filter((id) => TELEGRAM_CHAT_ID_RE.test(id));
  } catch (err) {
    console.warn(`${TAG} could not read who may talk to the bot:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Say it in one chat: the message with its button, or — when this edition's
 * token cannot be read for a Bot API send — the same words in plain text,
 * which `hermes send` can still deliver.
 */
async function sendNoticeTo(chatId: string, a: UpdateAvailability, t: Translate, harness: Harness): Promise<boolean> {
  if (await sendOwnerTelegramButtons(chatId, buildTelegramNotice(a, t), [updateButton(t)], { harness })) return true;
  return sendOwnerTelegramText(chatId, buildPlainNotice(a, t), { harness });
}

export type NoticeChannel = "telegram" | "desktop";

/**
 * Tell the owner. Telegram when a bot is connected and somebody is paired with
 * it; the desktop otherwise — "No Telegram connected", and equally a bot that
 * reached nobody, because a notice that went nowhere has not been given.
 * Answers where it went, or null when it went nowhere at all.
 */
export async function deliverUpdateNotice(
  a: UpdateAvailability,
  t: Translate,
  harness?: Harness,
): Promise<NoticeChannel | null> {
  const which = harness ?? (await getActiveHarness());
  const owners = (await telegramOwners(which)).slice(0, MAX_RECIPIENTS);
  let delivered = 0;
  for (const owner of owners) {
    if (await sendNoticeTo(owner, a, t, which)) delivered += 1;
    else console.warn(`${TAG} the Telegram notice to one approved user was not delivered`);
  }
  if (delivered > 0) {
    console.log(`${TAG} told ${delivered} Telegram user(s) about ${a.target}`);
    return "telegram";
  }
  try {
    await notifyOwner(buildDesktopNotice(a, t), OPEN_UPDATE_SETTINGS);
    console.log(`${TAG} no Telegram reached anybody (${owners.length} paired); told the desktop about ${a.target}`);
    return "desktop";
  } catch (err) {
    console.error(`${TAG} the desktop notice failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── The state file ──────────────────────────────────────────────────────────

export type WeeklyOutcome =
  | "notified"
  | "already-notified"
  | "current"
  | "unknown"
  | "disabled"
  | "updating"
  | "undelivered";

export interface UpdateNoticeState {
  /** This box's fixed jitter, seconds after 10:00 (update-notice-schedule.ts). */
  jitterS: number;
  /** The week whose check finished or was switched off (`weekKey`). */
  lastCheckedWeek: string | null;
  /** When a check last failed to look or to deliver; cleared when one settles. */
  lastAttemptAt: number | null;
  /** When a check last got an answer. */
  lastCheckAt: number | null;
  lastResult: WeeklyOutcome | null;
  /** The updater's name for the last version announced — the "never twice" key. */
  lastNotifiedTarget: string | null;
  /** The same, for people. */
  lastNotifiedVersion: string | null;
  lastNotifiedAt: number | null;
  lastNotifiedVia: NoticeChannel | null;
}

export function updateNoticeStatePath(): string {
  return path.join(resolveConfigRoot(), "data", "update-notice.json");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const OUTCOMES: ReadonlySet<string> = new Set([
  "notified", "already-notified", "current", "unknown", "disabled", "updating", "undelivered",
]);

/** A state the rest of this file can trust, whatever was on disk. */
export function normalizeState(raw: unknown, newJitter: () => number = drawJitter): UpdateNoticeState {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const via = o.lastNotifiedVia === "telegram" || o.lastNotifiedVia === "desktop" ? o.lastNotifiedVia : null;
  return {
    jitterS: typeof o.jitterS === "number" && Number.isFinite(o.jitterS) ? clampJitter(o.jitterS) : newJitter(),
    lastCheckedWeek: str(o.lastCheckedWeek),
    lastAttemptAt: num(o.lastAttemptAt),
    lastCheckAt: num(o.lastCheckAt),
    lastResult: typeof o.lastResult === "string" && OUTCOMES.has(o.lastResult) ? o.lastResult as WeeklyOutcome : null,
    lastNotifiedTarget: str(o.lastNotifiedTarget),
    lastNotifiedVersion: str(o.lastNotifiedVersion),
    lastNotifiedAt: num(o.lastNotifiedAt),
    lastNotifiedVia: via,
  };
}

async function writeState(state: UpdateNoticeState): Promise<void> {
  const file = updateNoticeStatePath();
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * The state, created on first read so the jitter drawn for this box is the one
 * it keeps. A file that cannot be parsed is replaced rather than trusted —
 * the worst that costs is one repeated notice; a box that never checks again
 * because its state is garbage would cost every notice after it.
 */
export async function readUpdateNoticeState(): Promise<UpdateNoticeState> {
  let raw: string | null = null;
  try {
    raw = await readFile(updateNoticeStatePath(), "utf-8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { jitterS?: unknown }).jitterS === "number") {
        return normalizeState(parsed);
      }
    } catch {
      console.warn(`${TAG} ${path.basename(updateNoticeStatePath())} could not be read; starting it again`);
    }
  }
  const fresh = normalizeState(null);
  try {
    await writeState(fresh);
  } catch (err) {
    console.warn(`${TAG} could not save the schedule state:`, err instanceof Error ? err.message : err);
  }
  return fresh;
}

/** One read-modify-write at a time — across the module copies Next makes, hence processStore. */
const lock = processStore("update-notice:state-lock", () => ({ chain: Promise.resolve() as Promise<unknown> }));

async function updateState<T>(fn: (state: UpdateNoticeState) => Promise<{ next: UpdateNoticeState | null; value: T }>): Promise<T> {
  const run = lock.chain.then(async () => {
    const state = await readUpdateNoticeState();
    const { next, value } = await fn(state);
    if (next) await writeState(next);
    return value;
  });
  lock.chain = run.catch(() => undefined);
  return run;
}

// ── The owner's switch ──────────────────────────────────────────────────────

export async function isWeeklyUpdateCheckEnabled(): Promise<boolean> {
  try {
    return (await configGet(WEEKLY_UPDATE_CHECK_KEY)) !== false;
  } catch {
    // An unreadable config is not the owner saying "off".
    return true;
  }
}

export async function setWeeklyUpdateCheckEnabled(enabled: boolean): Promise<void> {
  await configSet(WEEKLY_UPDATE_CHECK_KEY, enabled);
}

// ── The weekly run ──────────────────────────────────────────────────────────

export interface WeeklyRunResult {
  ran: boolean;
  week?: string;
  outcome?: WeeklyOutcome;
  via?: NoticeChannel;
}

/**
 * What the scheduler calls when its timer fires (or at a start that finds the
 * week's slot behind it). Decides from the STATE whether a check is due, so a
 * timer that fired early, a second module copy or a restart cannot check
 * twice. Never throws.
 */
export async function runWeeklyUpdateCheck(now: Date = new Date()): Promise<WeeklyRunResult> {
  try {
    const before = await readUpdateNoticeState();
    const due: UpdateCheckPlan | null = isCheckDue(before, now);
    if (!due) return { ran: false };

    // Read when the slot FIRES: a switch turned off after the timer was armed is honoured.
    const enabled = await isWeeklyUpdateCheckEnabled();
    const running = enabled && (await updateRunning());
    const a = enabled && !running ? await checkForUpdate(true) : null;
    const t = a?.status === "available" ? await boxTranslator() : null;

    return await updateState(async (state) => {
      // Somebody settled this week while we were asking GitHub.
      if (state.lastCheckedWeek === due.week) return { next: null, value: { ran: false } };
      const settle = (outcome: WeeklyOutcome, extra: Partial<UpdateNoticeState> = {}) => ({
        next: { ...state, lastCheckedWeek: due.week, lastAttemptAt: null, lastResult: outcome, ...extra },
        value: { ran: true, week: due.week, outcome, ...(extra.lastNotifiedVia ? { via: extra.lastNotifiedVia } : {}) } as WeeklyRunResult,
      });
      if (!enabled) return settle("disabled");
      if (running || !a) return settle("updating");
      if (a.status === "unknown") {
        // No verdict, so the week is NOT done: try again in an hour.
        return {
          next: { ...state, lastAttemptAt: now.getTime(), lastResult: "unknown" },
          value: { ran: true, week: due.week, outcome: "unknown" },
        };
      }
      if (a.status === "current") return settle("current", { lastCheckAt: now.getTime() });
      if (a.target === state.lastNotifiedTarget) {
        console.log(`${TAG} ${a.target} is still the newest; the owner was already told`);
        return settle("already-notified", { lastCheckAt: now.getTime() });
      }
      const via = await deliverUpdateNotice(a, t ?? translatorFor(updateNoticeEn));
      if (!via) {
        return {
          next: { ...state, lastAttemptAt: now.getTime(), lastCheckAt: now.getTime(), lastResult: "undelivered" },
          value: { ran: true, week: due.week, outcome: "undelivered" },
        };
      }
      return settle("notified", {
        lastCheckAt: now.getTime(),
        lastNotifiedTarget: a.target,
        lastNotifiedVersion: a.version,
        lastNotifiedAt: now.getTime(),
        lastNotifiedVia: via,
      });
    });
  } catch (err) {
    console.error(`${TAG} the weekly check failed:`, err instanceof Error ? err.message : err);
    return { ran: false };
  }
}

// ── The owner's chat: /update and the Update button ─────────────────────────

export type UpdateChatCommand = "check" | "update";

/**
 * The two messages this feature answers, and nothing else:
 *
 *   `/update` (or `/update@<bot>`)   → check now                → "check"
 *   `clawbox-update`                 → the Update button's tap  → "update"
 *
 * The tap arrives as its bare callback data on Hermes (the plugin's own
 * callback handler) and as `callback_data: clawbox-update` on OpenClaw, which
 * turns a tap into a synthetic message in exactly that form. The plugins apply
 * the same shape before they ask (parity is pinned by a test), so ordinary
 * conversation never reaches the route.
 */
export function parseUpdateChatCommand(text: unknown): UpdateChatCommand | null {
  if (typeof text !== "string") return null;
  // The byte order mark off first, then the engine's own trim — the same order
  // the plugins use (email-approvals.mjs explains why the two languages differ).
  const trimmed = text.replace(/\ufeff/g, "").trim();
  if (/^\/update(?:@[A-Za-z0-9_]{1,64})?$/i.test(trimmed)) return "check";
  if (trimmed === UPDATE_BUTTON_DATA || trimmed === `callback_data: ${UPDATE_BUTTON_DATA}`) return "update";
  return null;
}

export interface UpdateChatInput {
  /** The Telegram user id the harness reports for the sender (or the presser). */
  senderId: string;
  /** The chat it was typed or tapped in; for a private chat this equals the sender. */
  chatId?: string | null;
  isGroup?: boolean;
  text: string;
  /** Whose bot it arrived on — the allowlist and the reply both belong to that harness. */
  harness: Harness;
}

export interface UpdateChatClaim {
  /** True when the harness must NOT pass the message on (to the agent or its own /update). */
  handled: boolean;
  outcome: "not_command" | "not_owner" | "group" | "check" | "update";
  /** The work that answers the owner — run in the background by the route. */
  run?: () => Promise<void>;
}

async function reply(chatId: string, text: string, harness: Harness): Promise<void> {
  if (await sendOwnerTelegramText(chatId, text, { harness })) return;
  // On Hermes the plain path is `hermes send`, a CLI of its own that can fail
  // where the bot works — a cold start that times out on a loaded box, or a
  // Bot API root it does not read (the lab stub). The same bot through the Bot
  // API, with Hermes' own token, is the path the notice itself takes.
  if (harness === "hermes" && (await sendOwnerTelegramButtons(chatId, text, [], { harness }))) return;
  console.warn(`${TAG} a reply in the owner's chat was not delivered`);
}

/**
 * Decide, quickly, whether this message is ours and who sent it. The harness
 * hook is waiting on the answer, so the slow part (the check, the question)
 * comes back as `run`, which the route starts after it has answered.
 *
 * THE GATE IS THE SENDER: the Telegram allowlist of the harness the message
 * arrived on — the same list, the same rule, that decides who may press the
 * approvals bot's buttons. A stranger is CLAIMED and refused, never passed on:
 * on Hermes the hook runs before the harness's own auth, and both harnesses
 * have a `/update` of their own that updates the harness underneath ClawBox.
 * The owner's PRIVATE chat only: a group's members are not the owner, and the
 * answer (a version, a button) belongs in the conversation he has with the box.
 */
export async function claimUpdateChatCommand(input: UpdateChatInput): Promise<UpdateChatClaim> {
  const command = parseUpdateChatCommand(input.text);
  if (!command) return { handled: false, outcome: "not_command" };
  const senderId = String(input.senderId ?? "").trim();
  const harness = input.harness;
  const owners = senderId ? await telegramOwners(harness) : [];
  const privateChat = input.isGroup !== true && (!input.chatId || String(input.chatId).trim() === senderId);

  if (!senderId || !owners.includes(senderId)) {
    console.error(`${TAG} /update or the Update button came from a user who is not on the owner allowlist; refused`);
    if (harness === "hermes") {
      // GIVEN BACK to Hermes, whose own auth runs right after this hook and
      // refuses an unknown sender (its pairing reply) before any command —
      // its own /update included — can run. Claiming it here instead was
      // measured on a lab board to leave Hermes' typing indicator running in
      // the stranger's chat for as long as the gateway stays up: the skip
      // path never stops the keep-typing loop ingress started for him.
      return { handled: false, outcome: "not_owner" };
    }
    // On OpenClaw a stranger never reaches the hook (the core's own sender
    // authorization runs first); one that does is claimed and refused, so his
    // message cannot fall through to the core's own /update.
    return {
      handled: true,
      outcome: "not_owner",
      // Answered only in a private chat — a group is not told anything.
      run: privateChat && TELEGRAM_CHAT_ID_RE.test(senderId)
        ? async () => reply(senderId, (await boxTranslator())("updateNotice.ownerOnly"), harness)
        : undefined,
    };
  }
  if (!privateChat) {
    return {
      handled: true,
      outcome: "group",
      run: async () => reply(senderId, (await boxTranslator())("updateNotice.privateOnly"), harness),
    };
  }
  return command === "check"
    ? { handled: true, outcome: "check", run: () => answerUpdateCommand(senderId, harness) }
    : { handled: true, outcome: "update", run: () => answerUpdateButton(senderId, harness) };
}

/** /update: look now, and say what was found — with the button when there is something to install. */
export async function answerUpdateCommand(chatId: string, harness: Harness): Promise<void> {
  const t = await boxTranslator();
  if (await updateRunning()) return reply(chatId, t("updateNotice.alreadyUpdating"), harness);
  const a = await checkForUpdate(Date.now() - forced.at >= FORCED_CHECK_MIN_INTERVAL_MS);
  if (a.status === "current") return reply(chatId, t("updateNotice.upToDate", { current: a.current }), harness);
  if (a.status === "unknown") return reply(chatId, t("updateNotice.couldNotCheck"), harness);
  if (!(await sendNoticeTo(chatId, a, t, harness))) {
    console.warn(`${TAG} the /update answer was not delivered`);
    return;
  }
  // Told now, so Monday's check does not tell him again.
  await updateState(async (state) => ({
    next: {
      ...state,
      lastCheckAt: Date.now(),
      lastNotifiedTarget: a.target,
      lastNotifiedVersion: a.version,
      lastNotifiedAt: Date.now(),
      lastNotifiedVia: "telegram",
    },
    value: undefined,
  })).catch((err) => console.warn(`${TAG} could not record the /update answer:`, err instanceof Error ? err.message : err));
}

/**
 * The Update button: ask the owner's question — the one /setup-api/update/
 * request asks for the agent — and say where to answer it. Nothing here starts
 * an update.
 */
export async function answerUpdateButton(chatId: string, harness: Harness): Promise<void> {
  const t = await boxTranslator();
  if (await updateRunning()) return reply(chatId, t("updateNotice.alreadyUpdating"), harness);
  // The cached answer is enough to know a button from last week is stale; the
  // updater itself decides what an update installs.
  const a = await checkForUpdate(false);
  if (a.status === "current") return reply(chatId, t("updateNotice.nothingToInstall", { current: a.current }), harness);
  try {
    const { requestPowerApproval } = await import("@/lib/power-approval");
    const prompt = await requestPowerApproval("update", "Update button in Telegram");
    console.log(`${TAG} the owner tapped Update in Telegram; asked for confirmation (${prompt.messages.length ? "desktop and approvals bot" : "desktop"})`);
    return reply(chatId, t(prompt.messages.length ? "updateNotice.confirmInApprovals" : "updateNotice.confirmOnDesktop"), harness);
  } catch (err) {
    const { PowerApprovalConflict } = await import("@/lib/power-approval");
    if (err instanceof PowerApprovalConflict) return reply(chatId, t("updateNotice.waitingOnAnother"), harness);
    console.error(`${TAG} could not ask for the update's confirmation:`, err instanceof Error ? err.message : err);
    return reply(chatId, t("updateNotice.openSettings"), harness);
  }
}
