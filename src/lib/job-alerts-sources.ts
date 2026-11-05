/**
 * Where each harness keeps its scheduled jobs' run state, read for the
 * scheduled-job alerts (src/lib/job-alerts.ts, docs/design/scheduled-job-alerts.md).
 *
 * HARNESS FIRST: both readers take the harness's OWN record of its jobs — the
 * state its scheduler writes after every run — and neither keeps a run history
 * of its own.
 *
 *   OpenClaw  the gateway's `cron.list` over its loopback WebSocket
 *             (openclaw-gateway-ws.ts: ~20 ms, no CLI start-up). Jobs and run
 *             history live in the shared SQLite state database, which the
 *             docs say to reach through the CLI or the Gateway API only.
 *             Every job carries `state` — `lastRunStatus` (ok | error |
 *             skipped), `consecutiveErrors`, `consecutiveSkipped`,
 *             `nextRunAtMs`, `runningAtMs`, `autoDisabled`.
 *   Hermes    `<HERMES_HOME>/cron/jobs.json`, plus one per profile under
 *             `<HERMES_HOME>/profiles/<name>/cron/jobs.json` — the files
 *             Hermes' ticker writes (`cron/jobs.py`). `last_status`,
 *             `failure_streak`, `last_error`, `next_run_at`, `fire_claim`
 *             while a run is in flight. A file read: it answers even when the
 *             Hermes gateway (which runs the ticker) is down, which is exactly
 *             when its jobs stop firing.
 *
 * Both readers answer the same normalised {@link WatchedJob}; a job the owner
 * paused is left out, a job the scheduler stopped is kept and says so.
 *
 * SERVER ONLY.
 */

import { promises as fs } from "fs";
import path from "./runtime-path";
import { hermesHome } from "@/lib/hermes-env";
import type { Harness } from "@/lib/harness";

export type JobLastStatus = "ok" | "error" | "skipped";

export interface WatchedJob {
  /** The harness's own id; unique within one store. */
  id: string;
  /** What the owner calls it — sanitised, never the raw string (see {@link cleanJobName}). */
  name: string;
  /** Recurring or one-shot on a clock; event-driven jobs never count as overdue. */
  timed: boolean;
  lastStatus: JobLastStatus | null;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  running: boolean;
  /** Consecutive failed runs as the scheduler counts them; null when it does not say. */
  consecutiveErrors: number | null;
  consecutiveSkipped: number | null;
  /** The scheduler switched the job off itself (OpenClaw after 10 failures, Hermes' `state: error`). */
  stopped: boolean;
  /** The scheduler's last error, for Settings only — never put into a notice. */
  error: string | null;
}

export interface JobSource {
  runtime: Harness;
  /** False when the store could not be read at all — the jobs are then unknown, not absent. */
  reachable: boolean;
  jobs: WatchedJob[];
}

const MAX_NAME_CHARS = 60;
const MAX_ERROR_CHARS = 300;
const MAX_JOBS = 1_000;
const OPENCLAW_PAGE = 200;
/** A Hermes fire claim older than this is a crashed run, not a live one. */
const HERMES_CLAIM_LIVE_MS = 2 * 60 * 60_000;

// C0/C1 controls and the bidi overrides — a name is shown inside a sentence,
// and a right-to-left override in it would reorder the sentence around it.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A job name fit to put inside a notice: one line, no controls, bounded. */
export function cleanJobName(raw: unknown, fallbackId: string): string {
  const text = typeof raw === "string" ? raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim() : "";
  const name = text || fallbackId.slice(0, 12) || "job";
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name;
}

function cleanError(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ── OpenClaw ────────────────────────────────────────────────────────────────

const OPENCLAW_TIMED_KINDS = new Set(["at", "every", "cron"]);

/**
 * One `cron.list` row as a {@link WatchedJob}, or null for a row this feature
 * does not watch: the heartbeat (its skips — "no-route", quiet hours, an empty
 * HEARTBEAT.md — are how it is meant to work, and Settings → Working on its own
 * is its switch) and a job the owner disabled.
 */
export function openclawJob(row: unknown): WatchedJob | null {
  const job = record(row);
  if (!job || typeof job.id !== "string" || !job.id) return null;
  const payload = record(job.payload);
  if (payload?.kind === "heartbeat") return null;
  const state = record(job.state) ?? {};
  const stopped = job.enabled === false && record(state.autoDisabled) !== null;
  if (job.enabled === false && !stopped) return null;
  const schedule = record(job.schedule);
  const status = state.lastRunStatus ?? state.lastStatus;
  return {
    id: job.id,
    name: cleanJobName(job.name, job.id),
    timed: typeof schedule?.kind === "string" && OPENCLAW_TIMED_KINDS.has(schedule.kind),
    lastStatus: status === "ok" || status === "error" || status === "skipped" ? status : null,
    lastRunAtMs: finiteMs(state.lastRunAtMs),
    nextRunAtMs: finiteMs(state.nextRunAtMs),
    running: finiteMs(state.runningAtMs) !== null,
    consecutiveErrors: count(state.consecutiveErrors),
    consecutiveSkipped: count(state.consecutiveSkipped),
    stopped,
    error: cleanError(state.lastError),
  };
}

/**
 * Every OpenClaw job, disabled ones included (a job the scheduler switched off
 * is one this feature must see). Paged, because `cron.list` answers at most 200
 * rows a call. Unreachable — gateway down, still starting, a refused call — is
 * `reachable: false`, never an empty list: no jobs and unknown jobs are not the
 * same answer.
 */
export async function readOpenclawJobs(): Promise<JobSource> {
  const { gatewayWsCall } = await import("@/lib/openclaw-gateway-ws");
  const jobs: WatchedJob[] = [];
  let offset = 0;
  try {
    while (offset < MAX_JOBS) {
      const page = await gatewayWsCall(
        "cron.list",
        { includeDisabled: true, limit: OPENCLAW_PAGE, offset },
        { timeoutMs: 8_000 },
      );
      const rows = Array.isArray(page.jobs) ? page.jobs : [];
      for (const row of rows) {
        const job = openclawJob(row);
        if (job) jobs.push(job);
      }
      const next = typeof page.nextOffset === "number" ? page.nextOffset : null;
      if (page.hasMore !== true || next === null || next <= offset || rows.length === 0) break;
      offset = next;
    }
  } catch (err) {
    console.info("[job-alerts] OpenClaw scheduler not readable:", err instanceof Error ? err.message : err);
    return { runtime: "openclaw", reachable: false, jobs: [] };
  }
  return { runtime: "openclaw", reachable: true, jobs };
}

// ── Hermes ──────────────────────────────────────────────────────────────────

const HERMES_TIMED_KINDS = new Set(["once", "interval", "cron"]);

/**
 * One `jobs.json` entry as a {@link WatchedJob}, or null for one this feature
 * does not watch: paused by the owner, or a one-shot that has completed.
 * `delivery_failed` is a run that worked whose output did not arrive — not a
 * failed job; Hermes keeps it apart from `failure_streak` too.
 */
export function hermesJob(entry: unknown, nowMs: number): WatchedJob | null {
  const job = record(entry);
  if (!job || typeof job.id !== "string" || !job.id) return null;
  const state = typeof job.state === "string" ? job.state : "";
  if (state === "completed") return null;
  if (state === "paused" || job.enabled === false || job.paused_at) return null;
  const schedule = record(job.schedule);
  const status = job.last_status === "ok" || job.last_status === "delivery_failed"
    ? "ok"
    : job.last_status === "error" ? "error" : null;
  const claim = record(job.fire_claim);
  const claimedAt = isoMs(claim?.at);
  return {
    id: job.id,
    name: cleanJobName(job.name, job.id),
    timed: typeof schedule?.kind === "string" && HERMES_TIMED_KINDS.has(schedule.kind),
    lastStatus: status,
    lastRunAtMs: isoMs(job.last_run_at),
    nextRunAtMs: isoMs(job.next_run_at),
    running: claimedAt !== null && nowMs - claimedAt < HERMES_CLAIM_LIVE_MS,
    consecutiveErrors: count(job.failure_streak),
    consecutiveSkipped: null,
    // Hermes marks a RECURRING job `state: error` when it could not compute the
    // next run, and leaves it enabled so the schedule is not silently dropped.
    stopped: state === "error",
    error: cleanError(job.last_error),
  };
}

/** The job stores of every Hermes profile: the root one first, then each profile's. */
export async function hermesJobFiles(home = hermesHome()): Promise<string[]> {
  const files = [path.join(home, "cron", "jobs.json")];
  try {
    const profiles = await fs.readdir(path.join(home, "profiles"), { withFileTypes: true });
    for (const entry of profiles) {
      if (entry.isDirectory() && /^[A-Za-z0-9._-]{1,64}$/.test(entry.name) && !entry.name.startsWith(".")) {
        files.push(path.join(home, "profiles", entry.name, "cron", "jobs.json"));
      }
    }
  } catch {
    // No profiles directory: the root store alone.
  }
  return files;
}

/**
 * Every Hermes job across its profiles. A profile's id is prefixed onto the
 * job id (`coder/daily-brief`), because two profiles may each have a
 * `daily-brief`. A store that does not exist is a profile with no jobs; one
 * that exists and cannot be parsed makes the whole answer unreachable, so a
 * half-written file never reads as "every job recovered".
 */
export async function readHermesJobs(nowMs = Date.now(), home = hermesHome()): Promise<JobSource> {
  const jobs: WatchedJob[] = [];
  for (const file of await hermesJobFiles(home)) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      console.info("[job-alerts] Hermes job store not readable:", (err as Error).message);
      return { runtime: "hermes", reachable: false, jobs: [] };
    }
    let entries: unknown[];
    try {
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : record(parsed)?.jobs;
      entries = Array.isArray(list) ? list : [];
    } catch {
      console.info(`[job-alerts] Hermes job store ${file} is not JSON right now`);
      return { runtime: "hermes", reachable: false, jobs: [] };
    }
    const profile = path.basename(path.dirname(path.dirname(file)));
    const prefix = file === path.join(home, "cron", "jobs.json") ? "" : `${profile}/`;
    for (const entry of entries) {
      const job = hermesJob(entry, nowMs);
      if (job && jobs.length < MAX_JOBS) jobs.push({ ...job, id: `${prefix}${job.id}` });
    }
  }
  return { runtime: "hermes", reachable: true, jobs };
}

/** The active harness's jobs. */
export function readJobs(runtime: Harness): Promise<JobSource> {
  return runtime === "hermes" ? readHermesJobs() : readOpenclawJobs();
}
