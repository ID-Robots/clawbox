/**
 * Scheduled-job alerts (TASK-2179): tell the owner when a scheduled job or
 * automation fails silently. Design and scope: docs/design/scheduled-job-alerts.md.
 *
 * A heavy user's box runs dozens of scheduled jobs; when one of them died
 * quietly nothing said so. Every few minutes this reads the ACTIVE harness's
 * own record of its jobs (src/lib/job-alerts-sources.ts — OpenClaw's
 * `cron.list`, Hermes' `cron/jobs.json`), judges each job, and tells the owner
 * on the two paths the box already has: the desktop notice ring and Telegram
 * (src/lib/owner-telegram.ts, the coding agent's fan-out).
 *
 * WHAT IS A PROBLEM ({@link judgeJob})
 *   stopped   switched off after its last run failed (OpenClaw's auto-disable
 *             after ten failures, Hermes' `state: error`, or — seen on a
 *             board — an agent repair turn that quietly disabled it).
 *   failing   the last run failed — at once when the next try is more than an
 *             hour away, on the SECOND failure in a row when it is sooner: a
 *             job that retries within the hour gets one more chance before the
 *             owner is bothered, a daily job is not left broken for a day.
 *   skipping  skipped three times in a row (OpenClaw: a local provider down, a
 *             run still busy). One skip is often by design.
 *   overdue   a job on a clock whose next run is more than fifteen minutes in
 *             the past and is not running — the ticker died, the gateway is
 *             down, a Hermes box has no gateway at all. Not judged in the web
 *             server's first fifteen minutes, while the scheduler catches up.
 *
 * NOISE: one notice per job per INCIDENT — when the job goes from fine to a
 * problem — and one more when it runs normally again, only if the first was
 * sent. A job that goes bad again within six hours of its last alert is shown
 * in Settings but not pushed until that cooldown has passed, so a job flapping
 * every five minutes costs two messages per six hours, not two per ten
 * minutes. Every change found in one check is ONE message, so a gateway that
 * dies under twenty jobs is one alert, not twenty.
 *
 * The incidents are kept in data/job-alerts.json, written BEFORE anything is
 * sent: a check that crashes mid-send can lose a notice but never repeat one.
 *
 * SERVER ONLY.
 */

import { promises as fs } from "fs";
import path from "./runtime-path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import { notifyOwner } from "@/lib/email-notify";
import { jobAlertsEn } from "@/lib/edition-translations/en-job-alerts";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { readJobs, type JobSource, type WatchedJob } from "@/lib/job-alerts-sources";
import { OPEN_HARNESS_SETTINGS } from "@/lib/notify-action";
import { notifyOwnerTelegram } from "@/lib/owner-telegram";
import { isPreferenceLanguage, PREFERENCE_KEY_PREFIX } from "@/lib/preference-schema";
import { processStore } from "@/lib/process-store";

export type JobProblem = "stopped" | "failing" | "skipping" | "overdue";

/** A job on a clock this long past its due time, and not running, is overdue. */
export const OVERDUE_GRACE_MS = 15 * 60_000;
/** A failed job whose next try is at most this far away gets that try before an alert. */
export const QUICK_RETRY_MS = 60 * 60_000;
/** Skipped runs in a row before a skip is a problem. */
export const SKIP_THRESHOLD = 3;
/** No second failure alert for the same job within this long of the last one. */
export const REALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * The owner's switch, a preference like every other one (`pref:<name>`,
 * written by this feature's route and by POST /setup-api/preferences — the
 * `ui_` prefix is what lets that route store it). ON unless something says
 * off; the operator's environment can say it too.
 */
export const JOB_ALERTS_PREF = "ui_job_alerts";
export const JOB_ALERTS_ENV = "CLAWBOX_JOB_ALERTS";

const OFF_WORDS: ReadonlySet<string> = new Set(["off", "false", "0", "no"]);
const MAX_TOAST_CHARS = 280;
const MAX_NAMES_IN_NOTICE = 3;
const MAX_KNOWN_JOBS = 1_000;

function saysOff(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return typeof value === "string" && OFF_WORDS.has(value.trim().toLowerCase());
}

/**
 * Which of the two switched the alerts off, or null when they are on. A store
 * that cannot be read is NOT the owner saying off: a switch that failed closed
 * would silence exactly the box that is having trouble.
 */
export async function jobAlertsOff(): Promise<"env" | "pref" | null> {
  if (saysOff(process.env[JOB_ALERTS_ENV])) return "env";
  try {
    if (saysOff(await configGet(`${PREFERENCE_KEY_PREFIX}${JOB_ALERTS_PREF}`))) return "pref";
  } catch {
    // On, as above.
  }
  return null;
}

export async function setJobAlertsEnabled(enabled: boolean): Promise<void> {
  await configSet(`${PREFERENCE_KEY_PREFIX}${JOB_ALERTS_PREF}`, enabled);
}

// ── Judging one job ─────────────────────────────────────────────────────────

export interface JobVerdict {
  problem: JobProblem | null;
  /** Failures or skips in a row behind the verdict; 0 where it says nothing. */
  count: number;
}

/**
 * `lateness: false` leaves "overdue" out — see {@link advanceJobAlerts}'s
 * warm-up. Every other verdict stands.
 */
export function judgeJob(job: WatchedJob, now: number, lateness = true): JobVerdict {
  if (job.stopped) return { problem: "stopped", count: job.consecutiveErrors ?? 0 };
  // A skip after failures leaves the failure streak standing (OpenClaw counts
  // the two apart), so a failing job that is skipped once has not recovered.
  const errors = job.lastStatus === "error"
    ? Math.max(1, job.consecutiveErrors ?? 1)
    : job.lastStatus === "skipped" ? job.consecutiveErrors ?? 0 : 0;
  if (errors > 0) {
    const retrySoon = job.nextRunAtMs !== null && job.nextRunAtMs - now <= QUICK_RETRY_MS;
    if (errors >= (retrySoon ? 2 : 1)) return { problem: "failing", count: errors };
  }
  if (job.lastStatus === "skipped" && (job.consecutiveSkipped ?? 0) >= SKIP_THRESHOLD) {
    return { problem: "skipping", count: job.consecutiveSkipped ?? 0 };
  }
  if (lateness && job.timed && !job.running && job.nextRunAtMs !== null && now - job.nextRunAtMs > OVERDUE_GRACE_MS) {
    return { problem: "overdue", count: 0 };
  }
  return { problem: null, count: 0 };
}

// ── What is remembered between checks ───────────────────────────────────────

export interface JobMemo {
  name: string;
  /** The open incident, or null for a job kept only for its cooldown. */
  problem: JobProblem | null;
  count: number;
  /** When the open incident was first seen. */
  since: number;
  /** Whether the owner was told about the open incident. */
  alerted: boolean;
  /** The last failure alert for this job, across incidents — the cooldown's clock. */
  lastAlertAt: number;
  error: string | null;
}

interface KnownJob {
  name: string;
  timed: boolean;
  nextRunAtMs: number | null;
}

export interface JobAlertsState {
  version: 1;
  runtime: Harness | null;
  checkedAt: number;
  reachable: boolean;
  watched: number;
  jobs: Record<string, JobMemo>;
  /** Every job of the last READABLE answer: what lateness is judged on while the scheduler does not answer. */
  known: Record<string, KnownJob>;
}

export function emptyJobAlertsState(): JobAlertsState {
  return { version: 1, runtime: null, checkedAt: 0, reachable: false, watched: 0, jobs: {}, known: {} };
}

export interface NoticeItem {
  id: string;
  name: string;
  problem: JobProblem;
  count: number;
}

export interface CheckOutcome {
  state: JobAlertsState;
  alerts: NoticeItem[];
  recoveries: NoticeItem[];
}

function unknownJob(id: string, known: KnownJob): WatchedJob {
  return {
    id,
    name: known.name,
    timed: known.timed,
    lastStatus: null,
    lastRunAtMs: null,
    nextRunAtMs: known.nextRunAtMs,
    running: false,
    consecutiveErrors: null,
    consecutiveSkipped: null,
    stopped: false,
    error: null,
  };
}

/**
 * One check's step: the remembered incidents plus what the scheduler says now
 * give the new memory and the notices to send. Pure — the clock is handed in.
 *
 *   - fine → problem: a new incident, alerted unless the job's cooldown runs.
 *   - problem → problem: the same incident; alerted now only if it was held
 *     back by the cooldown and the cooldown has since passed (a job that kept
 *     failing after a "running again" must not stay silent for good).
 *   - problem → fine: a recovery, announced only when the incident was.
 *   - a job that is gone (deleted, paused by the owner) is forgotten without
 *     a word, and so is everything from the OTHER harness after a swap.
 *
 * While the scheduler does not answer, the jobs it last listed are judged on
 * their due times alone and no incident is closed: an unreachable gateway has
 * recovered nothing.
 *
 * WARM-UP (`lateness: false`, the web server's first {@link OVERDUE_GRACE_MS}):
 * no job is newly judged late, and an open "overdue" closes only once the job
 * has actually run. A box that was off or
 * updating comes back with every due time in the past, and the scheduler's
 * own catch-up runs them in its first minutes — calling each one overdue and
 * then recovered would be two messages per job after every reboot.
 */
export function advanceJobAlerts(
  prev: JobAlertsState,
  source: JobSource,
  now: number,
  { lateness = true }: { lateness?: boolean } = {},
): CheckOutcome {
  const sameRuntime = prev.runtime === source.runtime;
  const before = sameRuntime ? prev.jobs : {};
  const known: Record<string, KnownJob> = {};
  let jobs: WatchedJob[];
  if (source.reachable) {
    jobs = source.jobs;
    for (const job of jobs.slice(0, MAX_KNOWN_JOBS)) {
      known[job.id] = { name: job.name, timed: job.timed, nextRunAtMs: job.nextRunAtMs };
    }
  } else {
    Object.assign(known, sameRuntime ? prev.known : {});
    jobs = Object.entries(known).map(([id, k]) => unknownJob(id, k));
  }

  const next: JobAlertsState = {
    version: 1,
    runtime: source.runtime,
    checkedAt: now,
    reachable: source.reachable,
    watched: jobs.length,
    jobs: {},
    known,
  };
  const alerts: NoticeItem[] = [];
  const recoveries: NoticeItem[] = [];

  for (const job of jobs) {
    const was = Object.hasOwn(before, job.id) ? before[job.id] : undefined;
    let verdict = judgeJob(job, now, lateness);
    // Still late by the plain rule: the warm-up holds it open, neither new nor closed.
    if (!lateness && was?.problem === "overdue" && !verdict.problem && judgeJob(job, now).problem === "overdue") {
      verdict = { problem: "overdue", count: 0 };
    }
    if (!source.reachable && was?.problem && !verdict.problem) {
      verdict = { problem: was.problem, count: was.count };
    }
    const coolingUntil = was && was.lastAlertAt > 0 ? was.lastAlertAt + REALERT_COOLDOWN_MS : 0;

    if (verdict.problem) {
      const open = was?.problem ? was : null;
      let alerted = open?.alerted ?? false;
      let lastAlertAt = was?.lastAlertAt ?? 0;
      if (!alerted && now >= coolingUntil) {
        alerted = true;
        lastAlertAt = now;
        alerts.push({ id: job.id, name: job.name, problem: verdict.problem, count: verdict.count });
      }
      next.jobs[job.id] = {
        name: job.name,
        problem: verdict.problem,
        count: verdict.count,
        since: open?.since ?? now,
        alerted,
        lastAlertAt,
        error: job.error ?? open?.error ?? null,
      };
      continue;
    }

    if (was?.problem && was.alerted) {
      recoveries.push({ id: job.id, name: job.name, problem: was.problem, count: was.count });
    }
    if (was && now < coolingUntil) {
      next.jobs[job.id] = { name: job.name, problem: null, count: 0, since: 0, alerted: false, lastAlertAt: was.lastAlertAt, error: null };
    }
  }
  return { state: next, alerts, recoveries };
}

// ── The words ───────────────────────────────────────────────────────────────

export type Translate = (key: string, params?: Record<string, string | number>) => string;

function interpolate(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : whole);
}

/** A `t` over one locale table, falling back to this feature's English. */
export function translatorFor(table: Record<string, string>): Translate {
  return (key, params) => interpolate(
    (Object.hasOwn(table, key) ? table[key] : undefined) ?? jobAlertsEn[key] ?? key,
    params,
  );
}

/** The box's language (the owner's — `pref:ui_language`), as a translator. English when unset or unreadable. */
export async function boxTranslator(): Promise<Translate> {
  let lang: unknown = "en";
  try {
    lang = await configGet(`${PREFERENCE_KEY_PREFIX}ui_language`);
  } catch {
    // English, below.
  }
  try {
    // The whole table, English's too: the notice names a Settings section by
    // the sidebar's own label (`settings.harness`), which is not this feature's.
    const { loadLocaleTable } = await import("@/lib/translation-chunks");
    return translatorFor(await loadLocaleTable(isPreferenceLanguage(lang) ? lang : "en"));
  } catch {
    return translatorFor(jobAlertsEn);
  }
}

function namesOf(items: NoticeItem[]): string {
  const shown = items.slice(0, MAX_NAMES_IN_NOTICE).map((item) => `“${item.name}”`).join(", ");
  return items.length > MAX_NAMES_IN_NOTICE ? `${shown} +${items.length - MAX_NAMES_IN_NOTICE}` : shown;
}

const NOTICE_KEYS: Record<JobProblem, string> = {
  stopped: "jobAlerts.notice.stopped",
  failing: "jobAlerts.notice.failing",
  skipping: "jobAlerts.notice.skipping",
  overdue: "jobAlerts.notice.overdue",
};

/** The alert for one check's new incidents: one sentence for one job, one for many. */
export function buildAlertText(items: NoticeItem[], t: Translate): string {
  if (items.length === 1) {
    const [item] = items;
    const key = item.problem === "failing" && item.count <= 1 ? "jobAlerts.notice.failedOnce" : NOTICE_KEYS[item.problem];
    return t(key, { name: item.name, count: item.count });
  }
  return t("jobAlerts.notice.many", { count: items.length, names: namesOf(items) });
}

export function buildRecoveryText(items: NoticeItem[], t: Translate): string {
  if (items.length === 1) return t("jobAlerts.notice.recovered", { name: items[0].name });
  return t("jobAlerts.notice.recoveredMany", { count: items.length, names: namesOf(items) });
}

/**
 * Both legs, best-effort. The desktop notice carries the button into Settings
 * → Harness, where the card lists the jobs; Telegram has no button, so its
 * text says where to look instead.
 */
async function deliver(text: string, t: Translate): Promise<void> {
  const telegramText = `${text} ${t("jobAlerts.notice.where", { section: t("settings.harness") })}`;
  // The words themselves, once, in the journal: "the alert said X" is the
  // first thing support asks, and neither leg records what it was handed.
  console.log(`[job-alerts] notice: ${telegramText}`);
  try {
    await notifyOwner(text.slice(0, MAX_TOAST_CHARS), OPEN_HARNESS_SETTINGS);
  } catch (err) {
    console.error("[job-alerts] desktop notice failed:", err instanceof Error ? err.message : err);
  }
  try {
    await notifyOwnerTelegram(telegramText, "job-alerts");
  } catch (err) {
    console.error("[job-alerts] telegram notice failed:", err instanceof Error ? err.message : err);
  }
}

// ── The state file ──────────────────────────────────────────────────────────

export function jobAlertsFile(): string {
  return path.join(DATA_DIR, "job-alerts.json");
}

function isMemo(value: unknown): value is JobMemo {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return typeof m.name === "string" && typeof m.alerted === "boolean"
    && typeof m.lastAlertAt === "number" && typeof m.since === "number" && typeof m.count === "number"
    && (m.problem === null || m.problem === "stopped" || m.problem === "failing" || m.problem === "skipping" || m.problem === "overdue");
}

/** The remembered state; a missing or damaged file is a fresh start. */
export async function readJobAlertsState(): Promise<JobAlertsState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(jobAlertsFile(), "utf8"));
  } catch {
    return emptyJobAlertsState();
  }
  const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const state = emptyJobAlertsState();
  if (raw.runtime === "openclaw" || raw.runtime === "hermes") state.runtime = raw.runtime;
  if (typeof raw.checkedAt === "number") state.checkedAt = raw.checkedAt;
  if (typeof raw.reachable === "boolean") state.reachable = raw.reachable;
  if (typeof raw.watched === "number") state.watched = raw.watched;
  for (const [id, memo] of Object.entries((raw.jobs as Record<string, unknown>) ?? {})) {
    if (isMemo(memo)) state.jobs[id] = { ...memo, error: typeof memo.error === "string" ? memo.error : null };
  }
  for (const [id, k] of Object.entries((raw.known as Record<string, unknown>) ?? {})) {
    const job = k as Partial<KnownJob> | null;
    if (job && typeof job.name === "string" && typeof job.timed === "boolean") {
      state.known[id] = { name: job.name, timed: job.timed, nextRunAtMs: typeof job.nextRunAtMs === "number" ? job.nextRunAtMs : null };
    }
  }
  return state;
}

async function writeJobAlertsState(state: JobAlertsState): Promise<void> {
  const file = jobAlertsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

// ── The check ───────────────────────────────────────────────────────────────

export interface JobAlertsProblem {
  id: string;
  name: string;
  problem: JobProblem;
  count: number;
  since: number;
  error: string | null;
}

/** What GET /setup-api/job-alerts answers, and Settings draws. */
export interface JobAlertsStatus {
  enabled: boolean;
  off: "env" | "pref" | null;
  runtime: Harness | null;
  reachable: boolean;
  /** 0 = never checked. */
  checkedAt: number;
  watched: number;
  problems: JobAlertsProblem[];
}

export function statusFrom(state: JobAlertsState, off: "env" | "pref" | null): JobAlertsStatus {
  const problems: JobAlertsProblem[] = [];
  for (const [id, memo] of Object.entries(state.jobs)) {
    if (memo.problem) {
      problems.push({ id, name: memo.name, problem: memo.problem, count: memo.count, since: memo.since, error: memo.error });
    }
  }
  problems.sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  return {
    enabled: off === null,
    off,
    runtime: state.runtime,
    reachable: state.reachable,
    checkedAt: state.checkedAt,
    watched: state.watched,
    problems,
  };
}

const runtime = processStore("job-alerts:check", () => ({
  inFlight: null as Promise<JobAlertsStatus> | null,
}));

async function checkOnce(now: number): Promise<JobAlertsStatus> {
  const off = await jobAlertsOff();
  if (off) return statusFrom(await readJobAlertsState(), off);
  const harness = await getActiveHarness();
  const source = await readJobs(harness);
  const prev = await readJobAlertsState();
  const lateness = process.uptime() * 1000 >= OVERDUE_GRACE_MS;
  const { state, alerts, recoveries } = advanceJobAlerts(prev, source, now, { lateness });
  // Remembered BEFORE anything is sent: a state that cannot be written would
  // otherwise repeat the same alert every few minutes for as long as it fails.
  await writeJobAlertsState(state);
  if (alerts.length > 0 || recoveries.length > 0) {
    const t = await boxTranslator();
    if (alerts.length > 0) {
      console.log(`[job-alerts] ${harness}: alerting on ${alerts.map((a) => `${a.id} (${a.problem})`).join(", ")}`);
      await deliver(`⚠️ ${buildAlertText(alerts, t)}`, t);
    }
    if (recoveries.length > 0) {
      console.log(`[job-alerts] ${harness}: recovered ${recoveries.map((r) => r.id).join(", ")}`);
      await deliver(`✅ ${buildRecoveryText(recoveries, t)}`, t);
    }
  }
  return statusFrom(state, null);
}

/**
 * Check the active harness's jobs now and send what has changed. A check
 * already running is joined rather than doubled, so the timer and a Settings
 * read can never send the same alert twice.
 */
export function checkScheduledJobs(now: number = Date.now()): Promise<JobAlertsStatus> {
  if (runtime.inFlight) return runtime.inFlight;
  const run = checkOnce(now).finally(() => {
    if (runtime.inFlight === run) runtime.inFlight = null;
  });
  runtime.inFlight = run;
  return run;
}

/** The last check's answer without checking. */
export async function readJobAlertsStatus(): Promise<JobAlertsStatus> {
  return statusFrom(await readJobAlertsState(), await jobAlertsOff());
}
