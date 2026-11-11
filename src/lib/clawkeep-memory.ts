/**
 * ClawKeep memory-management bridge.
 *
 * Gives the Memory Shard UI a deliberately small, sanitised view of the index
 * and a persistent, single-flight way to trigger incremental/full indexing. Raw
 * CLI output, database paths and provider errors never cross the API boundary.
 *
 * TWO ARMS BEHIND ONE FACE, chosen per call by `openclawIsAbsent()`. Where
 * there is an OpenClaw, OpenClaw owns the index and its embedding provider and
 * this module drives its CLI. On the Hermes SKU there is no such index to drive
 * — that harness ships none — so ClawBox owns one itself
 * (`src/lib/memory-index-local.ts`) and this module drives that instead.
 *
 * The seam is deliberately narrow: the local arm answers the SAME status JSON
 * the CLI does and runs behind the SAME lock, state file and reconcile, so
 * `parseMemoryStatus`, the health rules, the error-code catalogue and every
 * screen and locale pack downstream are shared rather than duplicated. The
 * predicate is `openclawIsAbsent()` and never `hasHermesHarness()`: on a `dual`
 * box the openclaw binary exists and its index is the one that must keep being
 * used, under either harness.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path, { untraced } from "@/lib/runtime-path";
import { getMemoryShardEnabled, getMemoryShardSetupComplete } from "@/lib/memory-shard";
import { planGateFor, type PlanGate } from "@/lib/paid-plan-gate";
import { readPlanGate } from "@/lib/paid-plan-gate-server";

import { CLAWKEEP_DATA_DIR } from "@/lib/clawkeep";
import { redactCredentialShapes } from "@/lib/incident-sanitize";
import { CONFIG_PATH, findOpenclawBin, openclawIsAbsent } from "@/lib/openclaw-config";
import { resolveMemoryEmbedder } from "@/lib/memory-embedder";
import {
  IndexPassAbortedError,
  IndexRebuildRequiredError,
  localMemoryStatusJson,
  runLocalIndexPass,
  type LocalIndexProgress,
  type LocalIndexProgressReporter,
} from "@/lib/memory-index-local";
import { isLoopbackBaseUrl } from "@/lib/embed-runtime-ids";
import { memoryStatusTimeoutMs } from "@/lib/memory-status-timeout";
import {
  memoryIndexStallMs,
  progressMark,
  stallMinutes,
  staleRunVerdict,
  startStallWatchdog,
  type StallWatchdog,
} from "@/lib/memory-index-stall";
import { processStore } from "@/lib/process-store";
import { memoryReindexAdvice, type MemoryReindexAdvice } from "@/lib/memory-reindex-advice";
import { isOpenclawMaintenanceRefusal, withOpenclawMaintenanceRetry } from "@/lib/openclaw-maintenance";
import { FALLBACK_AGENT_ID, openclawDefaultAgentId } from "@/lib/openclaw-default-agent";
import {
  countIndexChunks,
  createIndexProgressReader,
  openclawAgentDbPath,
  ptyHostArgs,
} from "@/lib/openclaw-index-progress";

export type MemoryScheduleFrequency = "daily" | "weekly";
export type MemoryIndexMode = "incremental" | "full";
export type MemoryIndexTrigger = "manual" | "schedule";
export type MemoryRunStatus = "idle" | "running" | "succeeded" | "failed";

/**
 * Stable, language-independent names for the sentences below.
 *
 * Every other ClawBox route carries a `code` beside its English `error`, and
 * this one did not: the panel could only print the server's English, so a
 * German desktop showed "The index does not match the configured embedding
 * model" among its own labels. The English stays — it is the floor for a
 * surface whose locale pack has not caught up — but the code is what a screen
 * words for itself.
 */
export type MemoryStatusErrorCode =
  | "index_rebuild_required"
  | "embedder_unavailable"
  | "index_keyword_only"
  | "index_identity_mismatched"
  | "index_identity_missing"
  | "provider_mismatch"
  | "provider_degraded"
  | "status_unavailable";

export type MemoryRunErrorCode =
  | "stalled"
  /** No pass is cut at a fixed age any more (TASK-2431); kept so a record an
   *  older build wrote, and `timeout`'s own exit 124, still read. */
  | "timed_out"
  | "interrupted"
  | "migration_busy"
  | "openclaw_missing"
  | "provider_mismatch"
  | "index_failed"
  | "full_reindex_required";

const RUN_ERROR_CODES = new Set<string>([
  "stalled",
  "timed_out",
  "interrupted",
  "migration_busy",
  "openclaw_missing",
  "provider_mismatch",
  "index_failed",
  "full_reindex_required",
]);

export interface MemoryIndexSchedule {
  enabled: boolean;
  frequency: MemoryScheduleFrequency;
  /** HH:MM in device-local time. */
  timeOfDay: string;
  /** 0=Sunday ... 6=Saturday. */
  weekday: number;
}

/**
 * How far the pass that is going has got.
 *
 * Only ever present while a run is `running`, and only where the pass can
 * actually count. ClawBox's own indexer knows how many files the scan found
 * and how many it has finished with. `openclaw memory index` reports the same
 * two numbers only to a terminal (`createCliProgress` answers the no-op
 * reporter for a non-TTY stream unless the fallback is `log`, and the memory
 * command asks for `line`), so its pass is run on a pseudo-terminal and the
 * counts are read off the reporter, with chunks counted in the index it is
 * writing — see openclaw-index-progress.ts. On a box with no terminal host the
 * field stays `null`, on purpose, and the card draws a bar with no percentage
 * rather than inventing one.
 *
 * FILES are the fraction and chunks are only a figure: the chunk total is not
 * knowable until every file has been read, and a bar whose 100% moves is worse
 * than no bar at all.
 */
export interface MemoryIndexProgress {
  /** Files the pass has finished with — indexed, skipped or refused alike. */
  filesDone: number;
  /** Files its scan found. 0 while the scan is still walking. */
  filesTotal: number;
  /** Chunks in the index as the pass has left it so far. */
  chunks: number;
}

interface PersistedMemoryRunState {
  status: MemoryRunStatus;
  mode: MemoryIndexMode | "";
  trigger: MemoryIndexTrigger | "";
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  error: string;
  /** The `error` above, as a name a UI can translate. Empty on a state file
   *  written before the codes existed, which is why no surface may key its
   *  rendering on the code alone. */
  errorCode: MemoryRunErrorCode | "";
  /** Null when the run is not going, and on an arm that cannot count. */
  progress: MemoryIndexProgress | null;
  /** Internal only. Never returned by publicMemoryRunState(). */
  childPid: number;
  /**
   * Internal only: when the pass last MOVED (see memory-index-stall.ts), 0
   * until it first does. What a process that is not supervising the pass
   * judges a stall by — the supervising one has its own watchdog.
   */
  progressAtMs: number;
}

export type MemoryRunState = Omit<PersistedMemoryRunState, "childPid" | "progressAtMs">;

export interface ClawKeepMemoryStatus {
  available: boolean;
  /**
   * The OpenClaw agent this reading is about: the box's default agent
   * (`@/lib/openclaw-default-agent`), which is not always called "main". One
   * agent's index; a box with several reports the default one.
   */
  agentId: string;
  provider: string;
  model: string;
  location: "local" | "cloud" | "disabled" | "unknown";
  health: "healthy" | "degraded" | "unavailable" | "unknown";
  semanticAvailable: boolean;
  indexIdentity: "valid" | "missing" | "mismatched" | "unknown";
  /**
   * WHY the identity does not match, as the core's own short name for it —
   * `chunking_version` for the 4.0 case, empty when it names none.
   *
   * A name, never the core's sentence: the reason string is CLI-generated
   * English and this field is read by a panel that words itself in ten
   * languages. It is also what separates "a different model built this index"
   * from "the update changed how text is cut up", which are the same
   * `mismatched` to everything else and two different sentences to the owner.
   */
  indexIdentityCode: string;
  /**
   * The provider the CONFIG asked for, when the core reports it, as against
   * `provider`, which is the one it actually ended up using. They differ
   * exactly when the core could not honour the configuration and fell back —
   * the state a box lands in when `memory.search` survives an update
   * half-written. Empty on a core that does not report it.
   */
  requestedProvider: string;
  /** Stable, non-secret digest of provider/model/sources. */
  fingerprint: string;
  /** The owner's switch for Memory Shard. Off on a box that has not been set
   *  up: indexing used to be unconditional, with no consent anywhere. */
  enabled: boolean;
  /** False until the owner finishes the setup wizard. The app shows the wizard
   *  instead of the index card while it is. */
  setupComplete: boolean;
  /**
   * Does this box's ClawBox AI plan pay for Memory Shard, and which plan is on
   * record? Owner's decision, 2026-09-14: Pro or Max.
   *
   * REPORTED here, enforced by `clawkeep/memory/enable`. A box already
   * indexing when its subscription lapsed is never auto-disabled; this is what
   * lets a panel say what is missing instead of leaving the owner to find out
   * at the button.
   */
  planGate: PlanGate;
  sourceCount: number;
  files: number;
  chunks: number;
  vectors: number;
  pendingFiles: number;
  failedItems: number;
  dirty: boolean;
  indexBytes: number;
  error: string;
  /** `error`'s stable name, for a surface that words it in the owner's
   *  language. Empty exactly when `error` is. */
  errorCode: MemoryStatusErrorCode | "";
  run: MemoryRunState;
  schedule: MemoryIndexSchedule;
  nextRunAtMs: number;
  /**
   * Why the index wants a pass, and which one — the reading of the fields
   * above that `memoryReindexAdvice` makes. Set by `getMemoryStatus`; absent
   * from the raw probe readings it is built on.
   */
  reindex?: MemoryReindexAdvice;
}

export const DEFAULT_MEMORY_SCHEDULE: MemoryIndexSchedule = {
  enabled: false,
  frequency: "daily",
  timeOfDay: "03:00",
  weekday: 0,
};

/**
 * The lock `scripts/ensure-local-embeddings.sh` already holds while it pulls a
 * model, flips the provider and forces a reindex at gateway start. A UI
 * reindex must not run alongside that: the two would be indexing for different
 * embedding dimensions at the same time. Taking the SAME file through `flock`
 * is what makes them mutually exclusive across processes — an in-process lock
 * cannot see a shell script.
 */
const EMBED_MIGRATION_LOCK =
  process.env.CLAWKEEP_MEMORY_EMBED_LOCK?.trim()
  || path.join(os.homedir(), "clawbox", "data", "local-embeddings.state.lock");
/** `flock -E` exit code for "someone else holds it", distinct from a failure. */
const LOCK_BUSY_EXIT = 75;
/**
 * What `flock` exits with when it cannot exec the command: 69 (EX_UNAVAILABLE)
 * on the util-linux 2.37 this box ships, 126/127 on newer releases and on a
 * shell. `findOpenclawBin` falls back to the bare name when nothing is
 * installed, so a missing OpenClaw reaches flock and comes back as one of these.
 */
const EXEC_FAILURE_EXITS = new Set([69, 126, 127]);
/** How long a SIGTERM gets to close SQLite cleanly before SIGKILL follows. */
const TERMINATE_GRACE_MS = 5_000;
/**
 * How long a pass that was given up on (a stop, the stall watchdog) may take
 * to end before its run is settled without it. The OpenClaw arm ends within
 * TERMINATE_GRACE_MS; the local arm at its next check of the signal, which an
 * extraction (60 s budget each) can hold off for up to a minute.
 */
const ABANDON_SETTLE_MS = 2 * 60_000;
/**
 * The floor between two progress writes. Half the card's fast poll (3 s), so
 * every read it makes carries a figure that moved, without the pass paying an
 * atomic write per file.
 */
const PROGRESS_WRITE_EVERY_MS = 1_500;
/** Writes of the record that says how a pass ended, before giving up on it. */
const SETTLED_WRITE_ATTEMPTS = 4;
/** Backoff between them, times the attempt: 0.25 s, 0.5 s, 0.75 s. */
const SETTLED_WRITE_RETRY_MS = 250;

const SCHEDULE_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index-schedule.json");
const RUN_STATE_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index-state.json");
const RUN_LOCK_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index.lock");
// Two minutes: the probe boots a whole OpenClaw process, and what it reports
// (provider, model, index health) changes through indexing runs — which call
// invalidateMemoryStatusCache — not on its own. Settings → Local AI polls the
// inventory every five seconds, so a short TTL here is a background OpenClaw
// boot every few polls.
const STATUS_CACHE_MS = 120_000;
const STATUS_TIMEOUT_MS = memoryStatusTimeoutMs(process.env.CLAWKEEP_MEMORY_STATUS_TIMEOUT_MS);
/**
 * How long a pass may go without progress before it counts as stuck. There is
 * deliberately NO cap on how long a pass may run (TASK-2431): a full pass on
 * the on-box embedder takes hours, and the two-hour budget that used to end
 * every pass ended every such pass while it was working. Read per pass, so an
 * environment that changes it (a test, a board check) does not need a reload.
 */
function indexStallMs(): number {
  return memoryIndexStallMs(process.env.CLAWKEEP_MEMORY_INDEX_STALL_MS);
}
const LOCK_START_GRACE_MS = 30_000;
const MAX_STATUS_OUTPUT_BYTES = 2 * 1024 * 1024;

const EMPTY_RUN_STATE: PersistedMemoryRunState = {
  status: "idle",
  mode: "",
  trigger: "",
  startedAtMs: 0,
  finishedAtMs: 0,
  durationMs: 0,
  error: "",
  errorCode: "",
  progress: null,
  childPid: 0,
  progressAtMs: 0,
};

let writeSeq = 0;
let cachedStatus: ClawKeepMemoryStatus | null = null;
let cachedStatusAtMs = 0;
let statusInFlight: Promise<ClawKeepMemoryStatus> | null = null;
/**
 * Bumped by every invalidation. A probe that was already running when a run
 * finished reports the index as it was mid-run; comparing the generation it
 * started under with the current one is how that answer is caught — probed
 * once more before it is stored (`probeMemoryStatusSettled`), and kept from
 * being served as fresh for the next two minutes when the retry straddles as
 * well.
 */
let statusGeneration = 0;
/**
 * True while the cached reading is of an index that a run has changed since,
 * or was changing while the probe read it: set by a probe that found a run
 * going when it came back, and by every run's finish (whatever the cache
 * holds then predates the pass — the post-run probe has not answered yet).
 * Cleared only by a probe that came back with no run going and no
 * invalidation under it.
 *
 * WHILE a run is going such a reading is still answered at once — nothing
 * better exists until the pass ends, and blocking every read for the whole
 * pass is the defect `invalidateMemoryStatusCache`'s comment names. Once no
 * run is going, `getMemoryStatus` WAITS for the probe instead of serving it:
 * that read is the one that flips the card out of "running", and answered
 * from the old reading it drew the amber "Run a full reindex" banner over an
 * index that had just been rebuilt (F-C of the real-browser sweep). A stale
 * reading past the TTL is a different thing and is still served at once.
 */
let cachedStatusUnsettled = false;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(CLAWKEEP_DATA_DIR, { recursive: true, mode: 0o700 });
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDataDir();
  const tmp = untraced(`${file}.tmp.${process.pid}.${++writeSeq}`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

function sanitiseMemorySchedule(value: unknown): MemoryIndexSchedule {
  const raw = asRecord(value);
  const frequency: MemoryScheduleFrequency = raw.frequency === "weekly" ? "weekly" : "daily";
  // Real hours and minutes, not just "two digits, colon, two digits". `25:99`
  // used to pass this check and persist, and computeNextMemoryRunMs then
  // returned 0 for it — an "enabled" schedule that could never fire, which is
  // precisely the silently-half-applied setting this panel exists to expose.
  const timeOfDay = typeof raw.timeOfDay === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.timeOfDay)
    ? raw.timeOfDay
    : DEFAULT_MEMORY_SCHEDULE.timeOfDay;
  const weekdayRaw = Number(raw.weekday);
  const weekday = Number.isInteger(weekdayRaw) && weekdayRaw >= 0 && weekdayRaw <= 6
    ? weekdayRaw
    : DEFAULT_MEMORY_SCHEDULE.weekday;
  return {
    enabled: raw.enabled === true,
    frequency,
    timeOfDay,
    weekday,
  };
}

export async function readMemorySchedule(): Promise<MemoryIndexSchedule> {
  try {
    return sanitiseMemorySchedule(JSON.parse(await fs.readFile(SCHEDULE_PATH, "utf8")));
  } catch {
    return { ...DEFAULT_MEMORY_SCHEDULE };
  }
}

export async function writeMemorySchedule(value: unknown): Promise<MemoryIndexSchedule> {
  const schedule = sanitiseMemorySchedule(value);
  await writeJsonAtomic(SCHEDULE_PATH, schedule);
  return schedule;
}

export function computeNextMemoryRunMs(schedule: MemoryIndexSchedule, now: Date): number {
  if (!schedule.enabled) return 0;
  const [hour, minute] = schedule.timeOfDay.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return 0;
  }
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (schedule.frequency === "daily") {
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  for (let hops = 0; hops < 9; hops++) {
    if (candidate.getDay() === schedule.weekday && candidate.getTime() > now.getTime()) {
      return candidate.getTime();
    }
    candidate.setDate(candidate.getDate() + 1);
  }
  return 0;
}

function sanitiseRunState(value: unknown): PersistedMemoryRunState {
  const raw = asRecord(value);
  const status: MemoryRunStatus = raw.status === "running" || raw.status === "succeeded" || raw.status === "failed"
    ? raw.status
    : "idle";
  return {
    status,
    mode: raw.mode === "full" || raw.mode === "incremental" ? raw.mode : "",
    trigger: raw.trigger === "manual" || raw.trigger === "schedule" ? raw.trigger : "",
    startedAtMs: finiteNonNegative(raw.startedAtMs),
    finishedAtMs: finiteNonNegative(raw.finishedAtMs),
    durationMs: finiteNonNegative(raw.durationMs),
    // Only our own fixed public strings are persisted, never CLI output.
    error: typeof raw.error === "string" && raw.error.length <= 240 ? raw.error : "",
    // An unknown name is dropped rather than passed through: this field exists
    // so a surface can look up a translation by it, and a state file written
    // by an older build carries none at all.
    errorCode: typeof raw.errorCode === "string" && RUN_ERROR_CODES.has(raw.errorCode)
      ? raw.errorCode as MemoryRunErrorCode
      : "",
    // Only for a run that is going: a settled record carrying a bar's numbers
    // would have a screen drawing one over a finished pass.
    progress: status === "running" ? sanitiseProgress(raw.progress) : null,
    childPid: Number.isSafeInteger(raw.childPid) && Number(raw.childPid) > 0 ? Number(raw.childPid) : 0,
    progressAtMs: status === "running" ? finiteNonNegative(raw.progressAtMs) : 0,
  };
}

/**
 * A progress record off disk, or null.
 *
 * Whole non-negative counts, and `filesDone` is never allowed past
 * `filesTotal` — a fraction over 1 is the one value that would make the bar
 * visibly lie, and the file this comes from is written by another copy of this
 * module while the pass runs, so it is read as untrusted like everything else
 * here. A record with no total at all is kept: that is the honest shape of a
 * pass whose scan is still walking, and the card draws it without a
 * percentage.
 */
function sanitiseProgress(value: unknown): MemoryIndexProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const whole = (v: unknown) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };
  const filesTotal = whole(raw.filesTotal);
  return {
    filesDone: filesTotal > 0 ? Math.min(whole(raw.filesDone), filesTotal) : whole(raw.filesDone),
    filesTotal,
    chunks: whole(raw.chunks),
  };
}

async function readPersistedRunState(): Promise<PersistedMemoryRunState> {
  try {
    return sanitiseRunState(JSON.parse(await fs.readFile(RUN_STATE_PATH, "utf8")));
  } catch {
    return { ...EMPTY_RUN_STATE };
  }
}

async function writeRunState(state: PersistedMemoryRunState): Promise<void> {
  await writeJsonAtomic(RUN_STATE_PATH, state);
}

/**
 * The UI's copy of a run.
 *
 * An explicit allow-list rather than `{ childPid, ...rest }`: with a rest
 * spread, the next internal field somebody adds to the persisted shape ships
 * itself to the browser by default. Here it does not.
 */
function publicMemoryRunState(state: PersistedMemoryRunState): MemoryRunState {
  const { status, mode, trigger, startedAtMs, finishedAtMs, durationMs, error, errorCode, progress } = state;
  return { status, mode, trigger, startedAtMs, finishedAtMs, durationMs, error, errorCode, progress };
}

function processIsAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pids of the passes THIS process started and has not finished settling.
 *
 * A pass's process is reaped a moment before its end is written down: Node
 * collects the exit, then the pipes close, then `finish` writes the settled
 * record. A status read inside that gap found "running" beside a pid that no
 * longer exists and wrote "interrupted" over a pass that had succeeded — the
 * card's three-second poll was enough to hit it, and a poll ten times faster
 * hit it every few runs. The process doing the supervising knows the pass is
 * not lost, so its word counts. Process-wide rather than per module copy
 * (see process-store.ts): the scheduler's copy starts passes that the routes'
 * copy reads.
 */
function settlingPasses(): Set<number> {
  return processStore("clawkeep-memory.settling-passes", () => new Set<number>());
}

/**
 * The pass this process is supervising, so a stop can reach it: the
 * `IndexPass` handle lives only inside `startMemoryIndex`, and on the local arm
 * the run record's `childPid` is this web server's own pid, so signalling by
 * pid would stop the server rather than the pass. Keyed by the run's
 * `startedAtMs`, so a stop aimed at a run that has since ended cannot reach the
 * next one. Process-wide for the same reason as `settlingPasses`.
 */
interface SupervisedPass {
  startedAtMs: number;
  abandon(): void;
  /** Set by `stopMemoryIndex`, read by `finish` to say "stopped" rather than "interrupted". */
  stopRequested: boolean;
}

function supervisedPass(): { current: SupervisedPass | null } {
  return processStore("clawkeep-memory.supervised-pass", () => ({ current: null as SupervisedPass | null }));
}

/**
 * The end of the last pass this process started, through everything its
 * `finish` does: the settled record, the freed lock and the status refresh
 * behind it. Process-wide for the same reason as `supervisedPass`.
 */
function passSettling(): { current: Promise<void> | null } {
  return processStore("clawkeep-memory.pass-settling", () => ({ current: null as Promise<void> | null }));
}

/**
 * Resolves once the last pass this process started has settled completely,
 * the status refresh its `finish` starts included. The run-state file reads
 * "succeeded" before that refresh has even begun, so a caller that must know
 * nothing the pass set off is still running (a test about to remove the
 * directory the refresh reads) waits on this, not on the file. Never rejects;
 * resolves at once when this process started no pass.
 */
export function memoryPassSettled(): Promise<void> {
  return (passSettling().current ?? Promise.resolve()).catch(() => { /* settled either way */ });
}

function runIsAlive(pid: number): boolean {
  return processIsAlive(pid) || (pid > 0 && settlingPasses().has(pid));
}

const INTERRUPTED_MESSAGE = "Indexing was interrupted. Run it again.";
const INTERRUPTED_FAILURE = { error: INTERRUPTED_MESSAGE, errorCode: "interrupted" as const };
/**
 * A pass that stopped moving (TASK-2431): nothing it reports — files, chunks,
 * passages, documents — changed for the stall window, so it was ended rather
 * than left holding the lock for ever. Said in plain words, and without the
 * window's length: it is configurable, and a sentence that names thirty
 * minutes on a box set to five would be untrue. Unlike the old two-hour
 * "timed out", it is never the verdict on a pass that was working.
 */
const STALLED_FAILURE = {
  error: "Indexing made no progress for a long time and was stopped. Run it again.",
  errorCode: "stalled" as const,
};

/**
 * Is this process the one supervising the run this record is about? Then its
 * watchdog judges a stall, with progress the throttled record does not carry
 * yet, and no reader here second-guesses it.
 */
function supervisedHere(state: PersistedMemoryRunState): boolean {
  return supervisedPass().current?.startedAtMs === state.startedAtMs
    || (state.childPid > 0 && settlingPasses().has(state.childPid));
}

/**
 * What a `running` record really is (TASK-2431): process liveness plus the
 * stall rule, never its age. `going` for a pass still in its start grace
 * (the record is written before the spawn), for one this process supervises,
 * and for one whose process is there and which moved inside the window.
 */
function runningRecordVerdict(state: PersistedMemoryRunState): "going" | "lost" | "stalled" {
  const now = Date.now();
  const age = now - state.startedAtMs;
  if (state.childPid === 0 && age >= 0 && age < LOCK_START_GRACE_MS) return "going";
  if (supervisedHere(state)) return "going";
  return staleRunVerdict(
    { startedAtMs: state.startedAtMs, progressAtMs: state.progressAtMs, alive: runIsAlive(state.childPid) },
    now,
    indexStallMs(),
  );
}

async function markInterrupted(
  state: PersistedMemoryRunState,
  failure: { error: string; errorCode: MemoryRunErrorCode } = INTERRUPTED_FAILURE,
): Promise<PersistedMemoryRunState> {
  // Read once more before overwriting: the record this verdict was reached on
  // may be the "running" row the pass's own `finish` has just replaced with
  // how it really ended, and that answer is the better one.
  const current = await readPersistedRunState();
  if (current.status !== "running" || current.startedAtMs !== state.startedAtMs) return current;
  const finishedAtMs = Date.now();
  const failed: PersistedMemoryRunState = {
    ...state,
    status: "failed",
    finishedAtMs,
    durationMs: state.startedAtMs ? Math.max(0, finishedAtMs - state.startedAtMs) : 0,
    error: failure.error,
    errorCode: failure.errorCode,
    progress: null,
    childPid: 0,
    progressAtMs: 0,
  };
  await writeRunState(failed);
  await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
  return failed;
}

export async function readMemoryRunState(): Promise<MemoryRunState> {
  let state = await readPersistedRunState();
  if (state.status === "running") {
    const verdict = runningRecordVerdict(state);
    if (verdict !== "going") state = await markInterrupted(state, verdict === "stalled" ? STALLED_FAILURE : INTERRUPTED_FAILURE);
  }
  return publicMemoryRunState(state);
}

function openclawBin(): string {
  const override = process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN?.trim();
  return override || findOpenclawBin();
}

function openclawEnv(): NodeJS.ProcessEnv {
  const bin = openclawBin();
  const dirs = new Set<string>();
  // The package can remain in an older nvm prefix after Node is upgraded.
  // Its env-node shebang must use the server's runtime: respawn is disabled
  // below so OpenClaw cannot recover from selecting that prefix's old Node.
  dirs.add(path.dirname(process.execPath));
  if (bin !== "openclaw") dirs.add(path.dirname(bin));
  dirs.add(path.join(os.homedir(), ".npm-global", "bin"));
  dirs.add(path.join(os.homedir(), ".local", "bin"));
  const prefix = Array.from(dirs).join(path.delimiter);
  const parent = process.env.PATH || "";
  // `openclaw` on the box is a launcher (openclaw.mjs) that re-spawns the real
  // CLI as a detached grandchild and only forwards SIGTERM to it. With the
  // launcher's own opt-out, the pid this module records, supervises and
  // signals IS the CLI — verified: same JSON output, no child process.
  //
  // THE CONFIG THE INDEXER READS IS NAMED, never left to the CLI's own lookup.
  // `memory.search` — the provider, `remote.baseUrl`, `remote.apiKey` — reaches
  // the core only through the openclaw.json it loads, and OpenClaw's memory
  // docs say a rebuild runs "using [the gateway's] profile and environment,
  // including any OPENCLAW_STATE_DIR or OPENCLAW_CONFIG_PATH". This module reads
  // and writes `CONFIG_PATH`, which honours `CLAWBOX_OPENCLAW_HOME` and
  // ClawBox's own meaning of `OPENCLAW_HOME` (the `.openclaw` directory itself);
  // the CLI ignores the first and takes `OPENCLAW_HOME` for the ACCOUNT home,
  // looking in `$OPENCLAW_HOME/.openclaw`. With either one set and nothing
  // pinned, the pass would index against a config with no embedder in it — and
  // the core's answer to "no provider" is an index of text only, written into
  // whichever state directory it resolved. The same two pins and the same
  // removal as `openclawChildEnv` in updater.ts,
  // `gateway-pre-start.sh` and `ensure-local-embeddings.sh`.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: CONFIG_PATH,
    OPENCLAW_STATE_DIR: path.dirname(CONFIG_PATH),
    OPENCLAW_NO_RESPAWN: "1",
    PATH: parent ? `${prefix}${path.delimiter}${parent}` : prefix,
  };
  delete env.OPENCLAW_HOME;
  return env;
}

/**
 * SIGTERM first, SIGKILL only if the process is still there after the grace.
 *
 * Never SIGKILL straight away: an older launcher that ignores
 * OPENCLAW_NO_RESPAWN forwards SIGTERM to the indexer and force-kills it
 * itself, whereas SIGKILL stops at the launcher and leaves the indexer
 * writing the same SQLite file the next run opens. SIGTERM also lets the
 * indexer close the database cleanly.
 */
function terminate(child: ChildProcess): void {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }, TERMINATE_GRACE_MS);
  escalate.unref();
}

/**
 * `openclaw memory status`, asked again while the core's state is under
 * offline maintenance (a gateway start, a doctor run): that refusal read as
 * "status unavailable", and a read probe is exactly what may simply ask again.
 * See `@/lib/openclaw-maintenance`.
 *
 * About ONE agent, the box's default (`@/lib/openclaw-default-agent`), named
 * with `--agent`: left out, the core probes every configured agent in turn,
 * and `--deep` costs seconds per agent on a Jetson.
 */
function collectMemoryStatusJson(agentId: string): Promise<unknown> {
  return withOpenclawMaintenanceRetry(
    (timeoutMs) => collectMemoryStatusJsonOnce(timeoutMs, agentId),
    { timeoutMs: STATUS_TIMEOUT_MS, label: "openclaw memory status" },
  );
}

/** One `openclaw memory status --agent <agentId> --deep --json` probe, parsed; rejects on a failure or a timeout. */
function collectMemoryStatusJsonOnce(timeoutMs: number, agentId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(openclawBin(), ["memory", "status", "--agent", agentId, "--deep", "--json"], {
      env: openclawEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Only the start of stderr is kept: it is read for the core's maintenance
    // sentence and nothing else, and draining it keeps a chatty run from
    // blocking on a full pipe.
    let errText = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errText.length < 4096) errText += chunk.toString("utf8");
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    // terminate() arms its own SIGKILL escalation, so it must fire once:
    // every chunk after the overflow would otherwise add a signal and a timer.
    let overflowed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STATUS_OUTPUT_BYTES) {
        if (!overflowed) {
          overflowed = true;
          terminate(child);
        }
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => finish(() => reject(new Error("memory status unavailable"))));
    child.once("close", (code) => finish(() => {
      if (!timedOut && code !== 0) {
        const said = `${errText}\n${Buffer.concat(chunks).toString("utf8")}`;
        if (isOpenclawMaintenanceRefusal(said)) {
          reject(new Error(`memory status unavailable: ${said.trim().slice(0, 600)}`));
          return;
        }
      }
      if (timedOut || bytes > MAX_STATUS_OUTPUT_BYTES || code !== 0) {
        reject(new Error("memory status unavailable"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("memory status unavailable"));
      }
    }));
  });
}

/**
 * What the core says about the index it is holding.
 *
 * THE VERDICT IS NOT ONLY THE WORD. This read three spellings of `status` and
 * answered "unknown" to everything else, which is how a box that had just been
 * updated to 4.0 showed nothing to act on: the new core reports the chunking
 * change as `{ status, reason: "index chunking implementation changed",
 * owner: "openclaw", code: "chunking_version" }`, and a `status` this list does
 * not carry made the whole block invisible — health "unknown", no banner, and
 * "Index now" running the incremental pass that cannot succeed against it.
 *
 * So a status the list knows is taken as it comes, and any OTHER non-empty
 * status that arrives WITH a reason or a code is read as `mismatched`: the core
 * only fills those in when it has decided the index no longer belongs to the
 * configuration, and "it named a reason" is a far more stable signal than the
 * particular word it chose this release. An identity block with no status and
 * no reason at all stays "unknown" — that is a core that does not report this,
 * not a core reporting a problem.
 */
function readIndexIdentity(value: unknown): { status: ClawKeepMemoryStatus["indexIdentity"]; code: string } {
  const identity = asRecord(value);
  const status = cleanString(identity.status);
  // `code` is a short machine name (`chunking_version`); `reason` is the CLI's
  // English sentence, kept only as evidence that a verdict was reached and
  // never surfaced — it is neither translated nor guaranteed free of paths.
  const code = cleanString(identity.code);
  const reason = cleanString(identity.reason);
  if (status === "valid" || status === "missing" || status === "mismatched") {
    return { status, code };
  }
  if (status && (code || reason)) return { status: "mismatched", code };
  return { status: "unknown", code };
}

/**
 * Is this index stale because the CORE changed under it, rather than because
 * the owner pointed memory at a different model?
 *
 * Both are `mismatched`, and they are two different sentences: one is answered
 * by a button, the other is the owner being told their index belongs to a model
 * they moved off. `chunking_version` is the name the 4.0 core gives the first,
 * and the prefix is there so a later release that versions the same thing under
 * a longer name is still read as the update's doing and not as the owner's.
 */
function identityChangedByUpdate(code: string): boolean {
  return code.startsWith("chunking");
}

/**
 * Requested-provider values that name no provider at all, so the core picking
 * one for itself cannot be a fallback. `none` is memory search switched off,
 * which `health` already reports as unavailable.
 */
const PROVIDER_UNSPECIFIED = new Set(["", "auto", "default", "none"]);

/**
 * What the core reports as `requestedProvider` when `memory.search.provider` is
 * unset (2026.10). Only meaningful beside a config that could be read.
 */
const CORE_DEFAULT_PROVIDER = "openai";

/**
 * Where the embedder runs, from the provider id the core reports.
 *
 * `openai-compatible` is one id for two things: ClawBox's own embedder behind
 * the loopback proxy (what the wizard and the boot script configure), and a
 * server somewhere else the owner pointed OpenClaw at by hand. The status the
 * core answers names the provider but never its URL, so the caller reads
 * `memory.search.remote.baseUrl` from the config and passes it here — a
 * loopback host is this box, anything else is not, and no URL at all is an
 * answer this function refuses to guess at rather than claim "on device".
 */
function providerLocation(provider: string, remoteBaseUrl: string | null): ClawKeepMemoryStatus["location"] {
  if (!provider) return "unknown";
  if (provider === "none") return "disabled";
  if (provider === "ollama" || provider === "local") return "local";
  if (provider === "openai-compatible") {
    if (!remoteBaseUrl) return "unknown";
    return isLoopbackBaseUrl(remoteBaseUrl) ? "local" : "cloud";
  }
  return "cloud";
}

/**
 * The embedder openclaw.json NAMES — `memory.search.provider` ("" when it names
 * none) and `memory.search.remote.baseUrl` (or their pre-2026.8 home) —
 * straight from the file: the two facts the status probe does not carry. Read
 * from the file rather than the CLI because this runs beside a probe that
 * already costs a process boot. Null when the file cannot be read, which is
 * "not known", never "none"; a null `baseUrl` is what providerLocation reports
 * as "unknown", never as local.
 *
 * The provider is wanted because the core's own report cannot say it: with
 * `provider` unset the 2026.10 core reports its DEFAULT (`openai`) as the
 * requested provider, so "the core was asked for an embedder and could not
 * start it" and "nobody ever set one" read the same from the probe alone.
 *
 * The file is `CONFIG_PATH`, never a path built from the home directory:
 * that constant honours `CLAWBOX_OPENCLAW_HOME` / `OPENCLAW_HOME`, and on an
 * installation that moves the state directory a hand-built `~/.openclaw`
 * read a file that is not there, so the card said "unknown" about an
 * embedder the boot script had just wired up.
 */
async function readEmbeddingConfig(): Promise<{ provider: string; baseUrl: string | null } | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const pick = (root: unknown, keys: readonly string[]): string | null => {
      let node: unknown = root;
      for (const key of keys) node = asRecord(node)[key];
      return typeof node === "string" && node.trim() ? node.trim() : null;
    };
    return {
      provider: pick(config, ["memory", "search", "provider"])
        ?? pick(config, ["agents", "defaults", "memorySearch", "provider"])
        ?? "",
      baseUrl: pick(config, ["memory", "search", "remote", "baseUrl"])
        ?? pick(config, ["agents", "defaults", "memorySearch", "remote", "baseUrl"]),
    };
  } catch {
    return null;
  }
}

/**
 * The one thing wrong with this index, worst first, in a sentence and in a name.
 *
 * ORDER IS THE WHOLE DESIGN. Every one of these can be true at once on a box
 * that has just been updated, and the panel has room for one banner — so it
 * names the fault that has to be fixed FIRST, because fixing the others while
 * it stands is wasted work. A box embedding with a model its configuration
 * never asked for rebuilds its index with that model: the customer on
 * TASK-1024 ran Full reindex, it "succeeded", and search was no better. So the
 * fallback outranks the stale index, which in turn outranks the general
 * "provider is unwell" line it used to be flattened into.
 *
 * The English is the floor a locale pack has not reached yet; the code beside
 * it is what a screen words for itself (see {@link MemoryStatusErrorCode}).
 */
function statusVerdict(facts: {
  indexIdentity: ClawKeepMemoryStatus["indexIdentity"];
  indexIdentityCode: string;
  fellBack: boolean;
  embedderUnavailable: boolean;
  keywordOnly: boolean;
  health: ClawKeepMemoryStatus["health"];
}): { error: string; errorCode: MemoryStatusErrorCode | "" } {
  if (facts.fellBack) {
    return {
      error: "Memory search is not using the embedding model you configured. Re-run Memory Shard setup.",
      errorCode: "provider_mismatch",
    };
  }
  // The core could not start the embedder openclaw.json names and answers with
  // none at all. Not a fallback — no other model is embedding — and not the
  // index's fault either: a full reindex would only fail the same way until the
  // embedder answers, so the sentence sends the owner to the embedder first.
  if (facts.embedderUnavailable) {
    return {
      error: "Memory search has fallen back to keyword-only: the embedding model it is set to use did not answer. Check the embedder, then run a full reindex.",
      errorCode: "embedder_unavailable",
    };
  }
  // Above the mismatch it usually arrives with: the core calls an index it
  // built with no embedder "built for model fts-only" once one is set, and
  // "does not match the configured embedding model" sent the owner to a model
  // panel where everything was fine — while every search matched words only.
  if (facts.keywordOnly) {
    return {
      error: "Memory search is keyword-only: the index holds no embeddings. Run a full reindex.",
      errorCode: "index_keyword_only",
    };
  }
  if (facts.indexIdentity === "mismatched") {
    // The 4.0 case, and the reason this function exists: an index the update
    // itself invalidated was being reported as one built by the wrong model,
    // which sent the owner to a model panel where everything was fine.
    return identityChangedByUpdate(facts.indexIdentityCode)
      ? {
        error: "The index must be rebuilt after the update. Run a full reindex.",
        errorCode: "index_rebuild_required",
      }
      : {
        error: "The index does not match the configured embedding model. Run a full reindex.",
        errorCode: "index_identity_mismatched",
      };
  }
  if (facts.indexIdentity === "missing") {
    return { error: "The index fingerprint is missing. Run a full reindex.", errorCode: "index_identity_missing" };
  }
  if (facts.health === "degraded") {
    return {
      error: "The embedding model is not ready. Check the model, then try indexing again.",
      errorCode: "provider_degraded",
    };
  }
  return { error: "", errorCode: "" };
}

/**
 * `agentId`'s row in a `memory status --json` answer, or the first row when
 * none names it. The core answers a list, one row per agent it was asked
 * about; asked with `--agent` that is one row, so the first is a fallback for
 * a core that labels it some other way, never a pick among agents.
 */
function agentStatusRow(raw: unknown, agentId: string): Record<string, unknown> {
  const rows = Array.isArray(raw) ? raw : [raw];
  return asRecord(rows.find((entry) => cleanString(asRecord(entry).agentId) === agentId) ?? rows[0]);
}

/**
 * The status the panel and the API answer, from the core's `memory status
 * --json` answer `raw` about `agentId` (its row, see `agentStatusRow`), the
 * run on record and the schedule. `loadMemoryStatus` reports a parse that
 * rejects as the unavailable status.
 */
export async function parseMemoryStatus(
  raw: unknown,
  run: MemoryRunState,
  schedule: MemoryIndexSchedule,
  now = new Date(),
  remoteBaseUrl: string | null = null,
  // The provider openclaw.json names ("" for none), or null when that is not
  // known — then the core's own `requestedProvider` stands in for it.
  configuredProvider: string | null = null,
  // The agent the reading was asked about (`openclawDefaultAgentId`).
  agentId: string = FALLBACK_AGENT_ID,
): Promise<ClawKeepMemoryStatus> {
  const row = agentStatusRow(raw, agentId);
  const status = asRecord(row.status);
  const vector = asRecord(status.vector);
  const batch = asRecord(status.batch);
  const custom = asRecord(status.custom);
  const providerState = asRecord(custom.providerState);
  const identity = asRecord(custom.indexIdentity);
  const recovery = asRecord(custom.readonlyRecovery);
  const scan = asRecord(row.scan);
  const provider = cleanString(status.provider);
  const model = cleanString(status.model);
  const requestedProvider = cleanString(status.requestedProvider);
  const files = finiteNonNegative(status.files);
  const chunks = finiteNonNegative(status.chunks);
  const totalFiles = finiteNonNegative(scan.totalFiles);
  const pendingFiles = Math.max(0, totalFiles - files);
  // Scan issues are NOT failures. A stock box reports "memory directory
  // missing" here before anything has ever been written, and counting that as
  // a failed item put a red "Failed: 1" on a perfectly healthy new device.
  // Only real embedding failures are counted. Their text is not surfaced
  // either — it is CLI-generated and carries paths.
  const failedItems = finiteNonNegative(batch.failures) + finiteNonNegative(recovery.failures);
  const semanticAvailable = vector.semanticAvailable === true || vector.available === true;
  const { status: indexIdentity, code: indexIdentityCode } = readIndexIdentity(identity);
  const providerMode = cleanString(providerState.mode);
  // THE CORE'S OWN REPORT THAT IT DID NOT DO WHAT THE CONFIG ASKED. Compared
  // here rather than against openclaw.json because this is the one comparison
  // that cannot be wrong about which key the core actually resolves from: both
  // sides come out of the same probe. A box whose `memory.search` survived the
  // 4.0 update half-written reports `requestedProvider` "openai-compatible"
  // beside `provider` "ollama", and every surface used to show only the second
  // of those — so the panel named a model the owner never chose, and a full
  // reindex rebuilt the index with it.
  //
  // A REQUEST THAT NAMED NO PROVIDER IS NOT ONE THAT WAS IGNORED. `auto` is a
  // value this box's own boot script recognises and migrates
  // (scripts/ensure-local-embeddings.sh, `""|auto|ollama`), and it means "pick
  // one" — so the core resolving it to a concrete id is the configuration
  // being honoured, not overridden. Called a fallback it would put an amber
  // banner, a degraded chip and a "re-run setup" on the failure of every box
  // that never pinned a provider. The comparison is case-insensitive for the
  // same reason: a difference of spelling is not a difference of provider.
  //
  // `none` is not a provider the core fell back TO: it is no embedder at all,
  // which `embedderUnavailable` below names. Read as a fallback it sent the
  // owner to re-run setup over a configuration that was right, and logged that
  // the core was "embedding with none".
  const fellBack = Boolean(
    requestedProvider
    && provider
    && provider.toLowerCase() !== "none"
    && !PROVIDER_UNSPECIFIED.has(requestedProvider.toLowerCase())
    && requestedProvider.toLowerCase() !== provider.toLowerCase(),
  );
  // NO EMBEDDER AT ALL, WHERE ONE WAS ASKED FOR. The pinned core (2026.10.6)
  // reports `provider: "none"` (with `custom.searchMode: "fts-only"`) when it
  // could not start the embedder its config names — a refused key, an endpoint
  // that does not answer — and from then on it can only match words. The
  // configuration is the half the probe cannot vouch for (an unset provider is
  // reported as the core's default), so openclaw.json is asked; only a box that
  // could not read it falls back on the core's own `requestedProvider` — and
  // never on that default, which from the probe alone is as likely to be "no
  // provider was set" as a choice. ClawBox never writes it.
  const askedFor = configuredProvider
    ?? (requestedProvider.toLowerCase() === CORE_DEFAULT_PROVIDER ? "" : requestedProvider);
  const embedderUnavailable = provider.toLowerCase() === "none"
    && Boolean(askedFor) && !PROVIDER_UNSPECIFIED.has(askedFor.toLowerCase());
  // KEYWORD-ONLY: text chunks in the index and not one vector beside them, under
  // a configuration that names an embedder. `vector.index.state` is the core's
  // typed answer (`empty` | `complete` | `incomplete` | `unverified` in the
  // pinned SDK's MemoryProviderStatus), so this reads no English. It is how an
  // index built while no embedder answered stays after one is set: the core
  // pauses vector search over it and re-embeds nothing by itself, and every
  // search is answered by keywords alone. `provider: "none"` under a config
  // that names none is keyword-only search chosen on purpose, which `health`
  // already reports, not a fault; under one that names an embedder it is
  // `embedderUnavailable`, above.
  const keywordOnly = chunks > 0
    && Boolean(provider) && provider !== "none"
    && cleanString(asRecord(vector.index).state) === "empty";
  const sources = Array.isArray(status.sources) ? status.sources.filter((v) => typeof v === "string") as string[] : [];
  const sourceCounts = Array.isArray(status.sourceCounts) ? status.sourceCounts : [];
  const sourceCount = sourceCounts.length || sources.length;
  // Identifies the configuration the index was built for, so the UI can show
  // "this index belongs to this model" without printing a model path or a key.
  // Deliberately no vector dimension: `openclaw memory status --deep --json`
  // does not report one (verified against a real box), and hashing a constant
  // zero would look like data.
  const fingerprint = provider || model
    ? createHash("sha256")
        .update(JSON.stringify({ provider, model, sources: [...sources].sort() }))
        .digest("hex")
        .slice(0, 12)
    : "";

  // Size only. The file's mtime is NOT "last indexed": the status probe itself
  // touches the database every time it runs. When an index run finished is
  // `run.finishedAtMs`, which the panel already shows.
  let indexBytes = 0;
  const dbPath = cleanString(status.dbPath);
  if (dbPath) {
    try {
      const stat = await fs.stat(dbPath);
      if (stat.isFile()) indexBytes = stat.size;
    } catch { /* a missing index is represented by the identity/status fields */ }
  }

  let health: ClawKeepMemoryStatus["health"] = "unknown";
  // Degraded, not unavailable: memory search is ON and the core still matches
  // words — it is the configured embedder that is missing.
  if (embedderUnavailable) health = "degraded";
  else if (!provider || provider === "none") health = "unavailable";
  else if (!semanticAvailable || providerMode === "degraded" || cleanString(custom.providerUnavailableReason)) health = "degraded";
  // A fallback embedder ANSWERS, so nothing above catches it: the core is
  // perfectly healthy embedding with the wrong model. Search still returns
  // results, they are just not the ones the owner's configuration would give,
  // which is the quietest way this can go wrong and so the one worth a chip.
  else if (fellBack) health = "degraded";
  // Search answers, so nothing above catches this either: it just never uses
  // the embedder the card names.
  else if (keywordOnly) health = "degraded";
  else if (providerMode === "active" && indexIdentity === "valid") health = "healthy";
  // An index built by a different model — or one with no fingerprint at all —
  // is a KNOWN state, not an unknown one: search is degraded until it is
  // rebuilt, and the `error` below already says exactly that. Left as
  // "unknown", the chip contradicted the amber banner right beside it and
  // named nothing the owner could act on.
  else if (indexIdentity === "mismatched" || indexIdentity === "missing") health = "degraded";

  return {
    available: Boolean(provider || model || files || chunks),
    // The agent ASKED about, never the label on the row: a fallback row a core
    // labels some other way (the roster key as written, say) is still the
    // answer about this agent, and `getMemoryStatus` reloads any reading whose
    // id is not the default agent's, so the row's label made every read wait
    // on a cold probe. `rebuildKeywordOnlyIndex` keys its claim on it too.
    agentId,
    provider,
    model,
    // Where the embedder that did not answer is SUPPOSED to be, rather than
    // "disabled" — memory search was not switched off.
    location: providerLocation(embedderUnavailable ? askedFor : provider, remoteBaseUrl),
    health,
    semanticAvailable,
    indexIdentity,
    indexIdentityCode,
    requestedProvider,
    fingerprint,
    // Filled in by getMemoryStatus, which is the only caller with an await to
    // spend on the config store; the parser itself stays synchronous. The gate
    // is placed here for the same reason, and with the same floor: a value
    // nothing has read yet must not be a PASS.
    enabled: false,
    setupComplete: false,
    planGate: planGateFor(null),
    sourceCount,
    files,
    chunks,
    // `semanticAvailable` says vector search COULD run; over a keyword-only
    // index there is nothing for it to search, and counting every chunk as a
    // vector was the card vouching for embeddings the index does not have.
    vectors: semanticAvailable && !keywordOnly && !embedderUnavailable ? chunks : 0,
    pendingFiles,
    failedItems,
    dirty: status.dirty === true,
    indexBytes,
    ...statusVerdict({ indexIdentity, indexIdentityCode, fellBack, embedderUnavailable, keywordOnly, health }),
    run,
    schedule,
    nextRunAtMs: computeNextMemoryRunMs(schedule, now),
  };
}

/** The status for a probe that failed or could not be read: about `agentId`, with nothing known of its index. */
function unavailableStatus(
  run: MemoryRunState,
  schedule: MemoryIndexSchedule,
  agentId: string,
  now = new Date(),
): ClawKeepMemoryStatus {
  return {
    available: false,
    agentId,
    enabled: false,
    setupComplete: false,
    planGate: planGateFor(null),
    provider: "",
    model: "",
    location: "unknown",
    health: "unavailable",
    semanticAvailable: false,
    indexIdentity: "unknown",
    indexIdentityCode: "",
    requestedProvider: "",
    fingerprint: "",
    sourceCount: 0,
    files: 0,
    chunks: 0,
    vectors: 0,
    pendingFiles: 0,
    failedItems: 0,
    dirty: false,
    indexBytes: 0,
    error: "Memory status is unavailable. Try again.",
    errorCode: "status_unavailable",
    run,
    schedule,
    nextRunAtMs: computeNextMemoryRunMs(schedule, now),
  };
}

async function withLiveRunState(base: ClawKeepMemoryStatus): Promise<ClawKeepMemoryStatus> {
  // Run/schedule state changes independently from the expensive CLI probe.
  const [run, schedule] = await Promise.all([readMemoryRunState(), readMemorySchedule()]);
  return { ...base, run, schedule, nextRunAtMs: computeNextMemoryRunMs(schedule, new Date()) };
}

/**
 * One fresh reading about the box's default agent: the core's probe (or the
 * local index's answer where there is no OpenClaw), then the run state and the
 * schedule. A probe that fails, or an answer that cannot be parsed, is the
 * unavailable status rather than a rejection.
 */
async function loadMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  // Where there is no OpenClaw there is no CLI to probe: ClawBox's own index
  // answers the same shape, and everything below is unchanged.
  const local = openclawIsAbsent();
  // Which agent is asked about, read from openclaw.json on every probe (a
  // `stat` while the file is unchanged); `getMemoryStatus` does not answer a
  // cached reading about another one. The local arm answers under the same
  // id, so its row is the one picked.
  const agentId = await openclawDefaultAgentId();
  // The probe first, the run state after it. Read the other way round, a
  // cold answer carried the run state from when the probe STARTED — "running"
  // for a pass that had finished eight seconds before the answer arrived.
  const probe = await (local ? localMemoryStatusJson(agentId) : collectMemoryStatusJson(agentId)).then(
    (raw) => ({ raw, ok: true as const }),
    () => ({ raw: null, ok: false as const }),
  );
  const [run, schedule, embedding] = await Promise.all([
    readMemoryRunState(),
    readMemorySchedule(),
    // openclaw.json is what points the OTHER arm's client at an embedder, and
    // on this SKU there is no such file — asked anyway it answers null, which
    // `providerLocation` reports as "unknown" and the card draws as an
    // embedder it cannot place. The local arm embeds through whichever of its
    // two endpoints it is pointed at, so THAT url is the answer: the loopback
    // proxy, or this box's ClawBox AI account. Hard-coded to the proxy, the
    // card said "On device" over an index being embedded in the cloud.
    // A resolver that throws is "not known" (null), as an unreadable file is
    // on the other arm — never a rejected status read.
    local
      ? resolveMemoryEmbedder().then(
        (embedder) => ({ provider: embedder.provider, baseUrl: embedder.baseUrl }),
        () => null,
      )
      : readEmbeddingConfig(),
  ]);
  if (!probe.ok) return unavailableStatus(run, schedule, agentId);
  try {
    const status = await parseMemoryStatus(
      probe.raw, run, schedule, new Date(), embedding?.baseUrl ?? null, embedding ? embedding.provider : null, agentId,
    );
    noteProviderFallback(status);
    noteEmbedderUnavailable(status, probe.raw);
    noteKeywordOnly(status);
    return status;
  } catch {
    return unavailableStatus(run, schedule, agentId);
  }
}

/**
 * The two sides of the configuration, in the device log, for whoever has to
 * confirm they agree after an update.
 *
 * TASK-1024 was diagnosed by asking a customer to run the CLI by hand and read
 * two numbers back, because nothing the box wrote down said which embedder the
 * core had actually settled on — only which one it was using, which looks the
 * same whether or not it was asked for. Neither side is a secret: both are
 * provider ids and model names, never the endpoint and never the key.
 *
 * Said ONCE per verdict. The panel polls this reading every few seconds, and a
 * line per poll is a log nobody can read.
 */
let loggedProviderFallback = "";
function noteProviderFallback(status: ClawKeepMemoryStatus): void {
  const verdict = providerFellBack(status) ? `${status.requestedProvider}>${status.provider}/${status.model}` : "";
  if (verdict === loggedProviderFallback) return;
  loggedProviderFallback = verdict;
  if (!verdict) return;
  console.warn(
    `[clawkeep-memory] the core was configured for "${status.requestedProvider}" and is embedding with `
    + `"${status.provider}" (${status.model || "no model named"}); memory search will not match openclaw.json `
    + "until Memory Shard setup is run again",
  );
}

/**
 * A configured embedder the core could not start, in the device log, once per
 * verdict like the line above — with the core's own reason, which is the one
 * thing that tells a refused key from an endpoint that is not there.
 *
 * The reason is the core's (already redacted by it for tools) and is put
 * through the credential shapes here as well, with addresses and paths taken
 * out: it is the device log, and the rule of the line above holds — never the
 * endpoint and never the key. It never reaches the status the API answers.
 */
let loggedEmbedderUnavailable = "";
function noteEmbedderUnavailable(status: ClawKeepMemoryStatus, raw: unknown): void {
  const verdict = status.errorCode === "embedder_unavailable" ? `${status.requestedProvider}/${status.location}` : "";
  if (verdict === loggedEmbedderUnavailable) return;
  loggedEmbedderUnavailable = verdict;
  if (!verdict) return;
  const reason = coreEmbedderFailure(raw, status.agentId);
  console.warn(
    `[clawkeep-memory] memory search has fallen back to keyword-only: the core could not start the embedder `
    + `openclaw.json names ("${status.requestedProvider}"${status.location === "unknown" ? "" : `, ${status.location}`})`
    + `${reason ? ` — ${reason}` : ""}; ${status.chunks} chunks and no embeddings until it answers and a full reindex runs`,
  );
}

/** The core's own sentence for why no embedder started, made safe for the device log. */
function coreEmbedderFailure(raw: unknown, agentId: string): string {
  const custom = asRecord(asRecord(agentStatusRow(raw, agentId).status).custom);
  const said = cleanString(custom.providerUnavailableReason) || cleanString(asRecord(custom.providerState).reason);
  if (!said) return "";
  return redactCredentialShapes(said, "[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[endpoint]")
    .replace(/(?:~|\/(?:home|root|tmp|var|srv|opt|usr|etc|mnt|media|data))\/\S*/g, "[path]")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/**
 * A keyword-only index, in the device log, once per verdict like the line
 * above. Nothing else on the box said it: the core logs the fallback only
 * while it builds, and on the board this was found on that was nine hours
 * earlier, under a configuration that named no embedder at all.
 */
let loggedKeywordOnly = "";
function noteKeywordOnly(status: ClawKeepMemoryStatus): void {
  const verdict = status.errorCode === "index_keyword_only" ? `${status.provider}/${status.model}` : "";
  if (verdict === loggedKeywordOnly) return;
  loggedKeywordOnly = verdict;
  if (!verdict) return;
  console.warn(
    `[clawkeep-memory] the memory index is keyword-only: ${status.chunks} chunks and no embeddings, while memory `
    + `search is set to "${status.provider}" (${status.model || "no model named"}); every search matches words only `
    + "until a full reindex embeds them",
  );
}

/**
 * Marks the reading stale rather than dropping it. Dropping it made the very
 * next read after every run — the panel's — block on the cold probe, so the
 * button sat on a disabled "Index now" for the whole pass. A stale reading
 * is answered at once with the live run state and refreshed behind it.
 */
export function invalidateMemoryStatusCache(): void {
  statusGeneration++;
  cachedStatusAtMs = 0;
}

/**
 * How many times one reload probes again because the generation moved while
 * its probe ran. One, and bounded on purpose: a run that settles during the
 * probe is the ordinary case (the card polls every 3 s while a run is going,
 * and the probe takes ~8 s), a second invalidation during the retry is a rare
 * one, and a loop that waited for a quiet moment could wait through a whole
 * scheduled pass.
 */
const STATUS_STRADDLE_RETRIES = 1;

/**
 * The probe, repeated once when a run settled underneath it. Observed on the
 * box: the read that flipped the card's `running` off — the one that then
 * polls only every 30 s — carried the MID-REBUILD reading (identity
 * "mismatched", one pending file), so the amber "Run a full reindex" banner
 * sat over an index that had just been rebuilt. A straddled reading is
 * neither stored nor handed to a caller waiting on this probe: the retry's
 * reading is. (A caller that already holds a reading does not wait on this
 * at all — what THAT caller is answered with is `getMemoryStatus`'s rule,
 * through `cachedStatusUnsettled`.)
 *
 * Only the reading that is returned is stored. A straddled one that is about
 * to be probed again is not: the reading already in the cache — from before
 * the run, answered stale to anyone who peeks — is at least consistent, and
 * a mid-rebuild one was never the index the owner will see.
 */
async function probeMemoryStatusSettled(): Promise<ClawKeepMemoryStatus> {
  for (let attempt = 0; ; attempt++) {
    const generation = statusGeneration;
    const status = await loadMemoryStatus();
    const settled = generation === statusGeneration;
    if (settled || attempt >= STATUS_STRADDLE_RETRIES) {
      cachedStatus = status;
      // Invalidated during the retry as well: keep the answer, but as stale,
      // so the next reader refreshes it again instead of trusting a mid-run
      // reading for two minutes.
      cachedStatusAtMs = settled ? Date.now() : 0;
      // A reading taken while a pass was writing the index is of no index
      // the owner will see, and a run's finish marks it so as well — but a
      // pass started by a web server that has since restarted has no finish
      // here, so the probe judges it for itself from the run state it read
      // AFTER the CLI answered. Not stored stale on that account: a stale
      // reading kicks a probe behind every read, and that would boot an
      // OpenClaw process every few seconds for the length of the pass.
      cachedStatusUnsettled = !settled || status.run.status === "running";
      return status;
    }
  }
}

/**
 * The reading this box has — stale, or of an index a run has changed since —
 * or the cold probe when it has none. For the caller that wants a figure
 * from the LAST reading and must never wait for a settled one.
 */
function lastMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  return cachedStatus ? Promise.resolve(cachedStatus) : reloadMemoryStatus();
}

function reloadMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  if (!statusInFlight) {
    // Single-flight: every caller joins the probe already going, retry
    // included, so a burst of reads still boots one OpenClaw process.
    statusInFlight = probeMemoryStatusSettled().finally(() => {
      statusInFlight = null;
    });
  }
  return statusInFlight;
}

/**
 * The CLI probe behind this takes ~8 s on a Jetson (a whole OpenClaw process
 * boots to answer it). A caller with NO reading yet waits for it; once a
 * status has been read, a stale one is answered at once and refreshed in the
 * background — otherwise Settings → Local AI, which polls the inventory every
 * five seconds, froze on a skeleton for eight seconds every half minute.
 *
 * The one other wait is the read after a run: while the cached reading is of
 * an index a pass has changed since (`cachedStatusUnsettled`) and no pass is
 * going now, the answer is the probe's, not the cache's. That read is the
 * card's flip out of "running", and the probe it waits on is the one the
 * finish already started — ~8 s, up to 90 s on a cold box — so the card
 * says "Indexing…" for the length of the probe rather than drawing the
 * mid-rebuild identity for 30 s. `peekMemoryStatus` never waits, and
 * `resolveIndexMode` reads through `lastMemoryStatus` for the same reason.
 *
 * The run state is read at answer time on every path, so a caller that
 * joined a probe already in flight still gets the run as it is now.
 */
export async function getMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  let base = cachedStatus;
  if (!base) {
    base = await reloadMemoryStatus();
  } else if (base.agentId !== await openclawDefaultAgentId()) {
    // The owner renamed or re-pointed the default agent since this reading
    // (a `stat` while openclaw.json is unchanged): it describes an agent the
    // box no longer means, while the next pass already indexes the new one,
    // so the answer waits for a reading about the right one.
    base = await reloadMemoryStatus();
  } else if (cachedStatusUnsettled && (await readMemoryRunState()).status !== "running") {
    // Bounded by the probe, not by a quiet moment: when a second pass
    // settled under the retry as well, this answers the retry's reading —
    // flagged unsettled still — and the NEXT read pays one more probe.
    base = await reloadMemoryStatus();
  } else if (Date.now() - cachedStatusAtMs >= STATUS_CACHE_MS) {
    reloadMemoryStatus().catch(() => { /* the next read tries again */ });
  }
  const [live, enabled, setupComplete, planGate] = await Promise.all([
    withLiveRunState(base),
    getMemoryShardEnabled(),
    getMemoryShardSetupComplete(),
    readPlanGate(),
  ]);
  // A "next run" while the switch is off would name an hour at which nothing
  // happens: the scheduler arms no timer at all in that state, and this is the
  // number every surface prints. The schedule itself is left as the owner saved
  // it, so switching back on restores the hour they chose.
  // A keyword-only index read here is rebuilt behind the answer, not before it.
  rebuildKeywordOnlyIndex(live).catch(() => { /* a later read asks again */ });
  return {
    ...live,
    enabled,
    setupComplete,
    planGate,
    nextRunAtMs: enabled ? live.nextRunAtMs : 0,
    reindex: memoryReindexAdvice(live, openclawIsAbsent() ? "local" : "openclaw"),
  };
}

/**
 * The reading this box already has, or null when it has never been probed —
 * and in that case, start the probe in the background.
 *
 * For the caller that must not wait: the probe boots a whole OpenClaw process
 * (~8 s on a Jetson), and Settings → Local AI polls its inventory every five
 * seconds. Blocking that page on the one row that costs a process boot is what
 * made the first open after a restart sit on a skeleton. A caller that gets
 * null shows everything else and picks this row up on its next poll.
 *
 * Deliberately without the run/schedule refresh `getMemoryStatus` does: this
 * answers "which model embeds, and is it answering", not "is an index run in
 * flight", and it must stay synchronous to be useful here.
 */
export function peekMemoryStatus(): ClawKeepMemoryStatus | null {
  if (!cachedStatus) {
    reloadMemoryStatus().catch(() => { /* the next peek asks again */ });
    return null;
  }
  if (Date.now() - cachedStatusAtMs >= STATUS_CACHE_MS) {
    reloadMemoryStatus().catch(() => { /* keep serving the reading we have */ });
  }
  return cachedStatus;
}

/**
 * Pay the cold probe at boot so the first Settings open after a restart does
 * not — and act on what it read: a keyword-only index gets its rebuild here
 * (see {@link rebuildKeywordOnlyIndex}).
 */
export function warmMemoryStatusCache(): Promise<void> {
  return reloadMemoryStatus()
    .then((status) => rebuildKeywordOnlyIndex(status))
    .then(() => undefined);
}

/**
 * The setting a keyword-only rebuild was last asked for in this process, and
 * when it may be asked for again. After {@link KEYWORD_ONLY_RETRY_MS} when
 * nothing could start (a pass running, the lock held, an update) — otherwise
 * every status read, and the card polls them, would ask again and spawn a lock
 * probe each time. Once a pass started (`startedAtMs`): not again while that
 * pass is the last word or once it SUCCEEDED (a forced rebuild that ran and
 * still left text only would leave it again) — but a pass that FAILED (a wake
 * that timed out, a dropped connection) is asked for again the same interval
 * after it ended. Nothing else retries it on a box where no gateway start
 * comes round and Memory Shard's own passes are off.
 */
let keywordOnlyRebuild: { setting: string; retryAtMs: number; startedAtMs: number | null } | null = null;
const KEYWORD_ONLY_RETRY_MS = 10 * 60_000;

/**
 * THE REBUILD THE CORE NEVER MAKES BY ITSELF, asked for by the web server and
 * not only by a gateway start.
 *
 * An OpenClaw index built while `memory.search` named no embedder holds text
 * only (`memory_index_meta`: model `fts-only`, provider `none` — the pinned
 * core's creation-time fallback). Once an embedder is set the core reads the
 * config, starts the embedder — and leaves that index as it is: its own syncs
 * only mark an index of another model dirty, and a rebuild is the CLI's
 * `openclaw memory index --force` (verified in 2026.10.6's memory-core). The
 * box asked for that rebuild in two places, and both are OpenClaw events: the
 * gateway pre-start (a GATEWAY START, three attempts per setting) and the one
 * pass after ClawBox itself writes the cloud embedder. With Hermes the harness
 * in play on a dual box neither comes round again — switching to Hermes,
 * linking ClawBox AI from Hermes' side and every Hermes turn leave the
 * OpenClaw gateway running as it is, and Memory Shard's own passes are off
 * until the owner turns them on — so the agent's memory stayed keyword-only
 * under a configuration that was right.
 *
 * So the status reading this box already takes (at boot, and whenever the
 * owner or the assistant asks) asks for it too: the same full pass the
 * embedder's write asks for (`embedderChanged`, which the Memory Shard switch
 * does not govern on this arm — the index is the agent's own memory files),
 * through the same `openclaw memory index --agent <default agent> --force`.
 *
 * Only when it can work and only once: a verdict of `index_keyword_only`,
 * which means the core STARTED the configured embedder (one that does not
 * answer is `embedder_unavailable`, where a pass could only fail); no pass
 * running; the lock the gateway's own rebuild and the embeddings check hold
 * free (a pass that met it would end as a failure on the owner's card); no
 * update owning the box; and once per agent and embedder setting per process — a pass
 * that ran and still left text only is not run again until the setting
 * changes or the web server restarts, and the card's "Run a full reindex"
 * stays the owner's way to try again. One that could not start, or started
 * and failed, is asked for again ten minutes later, not on the next read. Nothing here on the edition without
 * OpenClaw, whose index is ClawBox's own and never holds text without vectors.
 */
export async function rebuildKeywordOnlyIndex(status: ClawKeepMemoryStatus): Promise<boolean> {
  if (status.errorCode !== "index_keyword_only" || openclawIsAbsent()) return false;
  // Per agent too: a renamed agent's index is a different index, and one
  // rebuilt for the old name says nothing about it.
  const setting = `${status.agentId}/${status.provider}/${status.model}/${status.location}`;
  // A reading about an agent the box no longer means (renamed or re-pointed
  // since) is no reason to force the index of the one it means now. It claims
  // nothing, so it cannot overwrite the claim of the agent the box does mean:
  // the next reading, about that one, decides. Asked BEFORE the claim is read,
  // so nothing is awaited between reading the claim and taking it.
  if (status.agentId !== await openclawDefaultAgentId()) return false;
  const claim = keywordOnlyRebuild;
  if (claim?.setting === setting) {
    // The run the reading carries is the live one (both callers read it after
    // the probe), so the pass this process started is judged by its own end.
    const run = status.run;
    const startedPassFailed = claim.startedAtMs !== null
      && run?.status === "failed" && run.startedAtMs >= claim.startedAtMs;
    const retryAtMs = startedPassFailed ? run.finishedAtMs + KEYWORD_ONLY_RETRY_MS : claim.retryAtMs;
    if (Date.now() < retryAtMs) return false;
  }
  // Claimed with no await since the claim was read, so two reads that arrive
  // together cannot both start one; every path that started nothing leaves a
  // retry time.
  keywordOnlyRebuild = { setting, retryAtMs: Number.POSITIVE_INFINITY, startedAtMs: null };
  let started = false;
  let askedAtMs = 0;
  try {
    if ((await readMemoryRunState()).status === "running") return false;
    if (!(await embedLockFree())) return false;
    const { updateInFlight } = await import("@/lib/updater");
    if (await updateInFlight()) return false;
    console.warn(
      `[clawkeep-memory] the memory index is keyword-only while "${status.provider}" (${status.model || "no model named"}) `
      + "answers; asking OpenClaw for one full rebuild (memory index --force)",
    );
    askedAtMs = Date.now();
    const result = await startMemoryIndex("full", "manual", { embedderChanged: true, forAgent: status.agentId });
    started = result.accepted;
    if (started) keywordOnlyRebuild = { setting, retryAtMs: Number.POSITIVE_INFINITY, startedAtMs: askedAtMs };
    else console.warn(`[clawkeep-memory] the keyword-only rebuild was not started: ${result.declined ?? "declined"}`);
    return started;
  } catch (err) {
    console.warn("[clawkeep-memory] the keyword-only rebuild could not be started:", err instanceof Error ? err.message : err);
    return false;
  } finally {
    if (!started) keywordOnlyRebuild = { setting, retryAtMs: Date.now() + KEYWORD_ONLY_RETRY_MS, startedAtMs: null };
  }
}

/**
 * Is the lock every `memory index` on this box takes free right now? Asked the
 * way the pass will take it — `flock -n` — so "free" means the pass would not
 * meet it. Anything but a clean yes (busy, no flock, no data directory) is no.
 */
function embedLockFree(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("flock", ["-n", "-E", String(LOCK_BUSY_EXIT), EMBED_MIGRATION_LOCK, "true"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/**
 * Has the core disowned this index? Only ever answered from a reading the
 * probe really produced — `unknown` is the value an unavailable status carries,
 * and it must never be read as a verdict.
 */
function staleIndexIdentity(status: Pick<ClawKeepMemoryStatus, "indexIdentity">): boolean {
  return status.indexIdentity === "mismatched" || status.indexIdentity === "missing";
}

/** The status verdict this module keys its own behaviour on, said once. */
function providerFellBack(status: Pick<ClawKeepMemoryStatus, "errorCode">): boolean {
  return status.errorCode === "provider_mismatch";
}

/**
 * What "Index now" should actually run.
 *
 * Observed on .177, not reasoned about: on a box whose vector index has never
 * been built, `openclaw memory index` WITHOUT `--force` exits 1 with
 * `no such table: memory_index_chunks_vec`, while the same command with
 * `--force` exits 0 and builds it. So the very first click of "Index now" —
 * the most likely click a new owner ever makes — would have failed with a
 * message telling them to check a model that was perfectly fine.
 *
 * There is nothing to preserve when the index is empty, so the first build IS
 * the full build. The run records the mode it really used, and the panel
 * prints it, so "Index now" never claims an incremental pass it did not do.
 *
 * THE SAME RULE FOR AN INDEX THE CORE HAS DISOWNED (TASK-1024). An incremental
 * pass adds and replaces rows inside an index whose identity the core has
 * already rejected; it cannot make that index valid again, so it fails, and
 * every route to it — the owner's "Index now", the nightly schedule — used to
 * fail the same way until somebody found the Full reindex button. After the 4.0
 * update, which changed how text is cut into chunks, that was every box that
 * had ever indexed. There is nothing to preserve in an index that will be
 * thrown away, so here too the honest pass IS the full one, and the run line
 * says "full" because that is what ran.
 *
 * …FOR THE OWNER, NEVER FOR THE SCHEDULE (TASK-1197). A full pass over a
 * disowned index throws away every embedding the box has and spends hours
 * making them again, and that is a decision somebody makes, not one a timer
 * makes at 03:00 because a fingerprint went missing. So a scheduled request
 * against a disowned index answers `null` — no pass at all — and the slot is
 * declined with `full_reindex_required`; the amber banner the status already
 * draws ("… Run a full reindex") is what tells the owner, and the button is how
 * they answer it. Running the incremental pass instead would be no kinder: it
 * cannot make the index valid, so it would fail every night with a message that
 * blames the model. The EMPTY index keeps its upgrade on every trigger, the
 * schedule's included: there is nothing in it to throw away, and a first build
 * is exactly the work an incremental pass into no index would have done.
 *
 * Answered from the cached reading when there is one (stale included, and
 * one a run has changed since: the cost of a stale zero is one more pass
 * over an index that was just built, inside the ten seconds before the
 * refresh lands). Only a box that has never been probed — or whose reading is
 * about another agent than the default, which counts as none (see
 * planIndexPass) — waits for the probe —
 * `lastMemoryStatus` rather than `getMemoryStatus`, which now waits for the
 * settled reading after a run, and a click of "Index now" seconds after a
 * pass must not sit behind that probe — and `startMemoryIndex` asks this
 * AFTER declining a caller that overlaps a run, so that wait never overlaps
 * one.
 */
export async function resolveIndexMode(
  requested: MemoryIndexMode,
  trigger: MemoryIndexTrigger = "manual",
): Promise<MemoryIndexMode | null> {
  const plan = await planIndexPass(requested, trigger, await openclawDefaultAgentId());
  return plan.heldBack ? null : plan.mode;
}

/** What {@link planIndexPass} decided: a pass to run, or none. */
interface IndexPassPlan {
  mode: MemoryIndexMode;
  fellBack: boolean;
  /**
   * The index needs the full pass this trigger may not start: a scheduled
   * request against an index the core has disowned. Nothing runs, and
   * `startMemoryIndex` declines with `full_reindex_required`.
   */
  heldBack: boolean;
}

/**
 * The mode {@link resolveIndexMode} answers, plus the one other thing the same
 * reading already knows: whether the core is embedding with a model the
 * configuration never asked for.
 *
 * Carried forward rather than asked for again at the end, because by the time a
 * pass has failed the cached reading has been dropped (`finish` unsettles it on
 * purpose) and re-probing to word a failure would put a process boot between
 * the owner and their error message.
 *
 * A `full` request STILL COSTS NOTHING. There is nothing to decide about a pass
 * that is already full, and putting a probe in front of the Full reindex button
 * would be a regression for every box that presses it — so that arm reads
 * `cachedStatus` straight and takes "no reading yet" for an answer. NOT
 * `peekMemoryStatus`, which starts a probe in the background when the cache is
 * cold or aged: that is right for a panel that will be rendered again in five
 * seconds and wrong here, where it would boot a second OpenClaw alongside the
 * indexer this call is about to spawn.
 *
 * A box in this state has a reading: the panel carrying the button polls the
 * status to draw the banner that names it, and `warmMemoryStatusCache` pays for
 * the first one at boot. Without one the pass is worded the way it always was.
 *
 * ONLY A READING ABOUT `agentId`, the agent the pass will index, decides
 * anything (TASK-2248). A cached reading from before the owner renamed or
 * re-pointed the default agent is about an index this pass will not touch: its
 * zero chunks would send `--force` to the new agent's populated index unasked.
 * Such a reading counts as none — a box never probed for this agent, which
 * waits for the probe — and if even that answer is about another agent (the
 * config moved again under it) the pass runs as asked, as for a box we know
 * nothing about.
 */
async function planIndexPass(
  requested: MemoryIndexMode,
  trigger: MemoryIndexTrigger,
  agentId: string,
): Promise<IndexPassPlan> {
  if (requested === "full") {
    const seen = cachedStatus?.agentId === agentId ? cachedStatus : null;
    return { mode: "full", fellBack: seen !== null && seen.available && providerFellBack(seen), heldBack: false };
  }
  try {
    // The schedule pays for a FRESH reading. Nobody is waiting on a 03:00 slot,
    // and "empty" is the one verdict that sends `--force` to the core unasked:
    // a cached zero from before a manual pass filled the index would re-embed
    // that index on a timer. The owner's click keeps the cached reading, for the
    // reasons above.
    let status = await (trigger === "schedule" ? reloadMemoryStatus() : lastMemoryStatus());
    if (status.agentId !== agentId) status = await reloadMemoryStatus();
    if (status.agentId !== agentId) return { mode: requested, fellBack: false, heldBack: false };
    // `available` is load-bearing: a failed CLI probe returns the unavailable
    // status, which also reports zero chunks AND an "unknown" identity. Without
    // this check a probe timeout would silently turn a scheduled incremental
    // pass into a --force re-embed of an index that was perfectly fine.
    if (!status.available) return { mode: requested, fellBack: false, heldBack: false };
    const fellBack = providerFellBack(status);
    // Nothing indexed: the first build IS the full one, on every trigger.
    if (status.chunks === 0) return { mode: "full", fellBack, heldBack: false };
    // Nothing EMBEDDED is the same case for the vectors, and the schedule's too:
    // a keyword-only index holds no embedding a full pass could throw away, so
    // holding the slot back for the owner (TASK-1197's reason) protects nothing
    // and leaves search matching words only until somebody clicks.
    if (status.errorCode === "index_keyword_only") return { mode: "full", fellBack, heldBack: false };
    if (staleIndexIdentity(status)) {
      // Disowned: the owner's request is upgraded (TASK-1024), the schedule's
      // is held back (TASK-1197) — see resolveIndexMode.
      return trigger === "schedule"
        ? { mode: requested, fellBack, heldBack: true }
        : { mode: "full", fellBack, heldBack: false };
    }
    return { mode: requested, fellBack, heldBack: false };
  } catch {
    // Same rule when the probe throws: run what was asked rather than
    // upgrading on a box we know nothing about — and claim to know nothing
    // about its provider either, so the failure below is worded generically.
    return { mode: requested, fellBack: false, heldBack: false };
  }
}

async function acquireRunLock(): Promise<boolean> {
  await ensureDataDir();
  try {
    await fs.mkdir(RUN_LOCK_PATH, { mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const state = await readPersistedRunState();
  if (state.status === "running") {
    const verdict = runningRecordVerdict(state);
    if (verdict === "going") return false;
    await markInterrupted(state, verdict === "stalled" ? STALLED_FAILURE : INTERRUPTED_FAILURE);
  } else {
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
  }
  try {
    await fs.mkdir(RUN_LOCK_PATH, { mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * A pass `stopMemoryIndex` ended. The same code as any other interruption —
 * the index is in the same state either way — worded so nobody reads a stop
 * they asked for as a fault, and worded BY MODE, because the two leave
 * different things behind. A stopped incremental pass committed every file it
 * finished, and the next incremental pass skips them. A stopped FULL pass did
 * not: ClawBox's own rebuild empties the store and drops its identity first,
 * and OpenClaw's `--force` builds into a temporary database it never swaps in.
 * The next pass that completes it is a full one (planIndexPass upgrades an
 * incremental ask over the stale identity), so saying "an incremental pass
 * carries on" there would send the assistant to a pass that is not one.
 */
const STOPPED_FAILURE = {
  error: "Indexing was stopped before it finished. An incremental pass carries on from the files already indexed.",
  errorCode: "interrupted" as const,
};
/**
 * A stopped FULL pass, by arm. OpenClaw's `--force` builds into a temporary
 * database it never swapped in, so its index stays as it was. ClawBox's own
 * rebuild emptied the store before it began, so the index holds only what it
 * re-embedded by the stop — "stays as it was" would be untrue there.
 */
const STOPPED_FULL_FAILURE = {
  openclaw: {
    error: "The full reindex was stopped before it finished; the index stays as it was. Only a new full reindex rebuilds it, and that needs the owner's go.",
    errorCode: "interrupted" as const,
  },
  local: {
    error: "The full reindex was stopped before it finished; the index holds only the files it re-embedded so far. Only a new full reindex rebuilds it, and that needs the owner's go.",
    errorCode: "interrupted" as const,
  },
};

/** The two verdicts both arms can reach, said once. */
const TIMED_OUT_FAILURE = {
  error: "Indexing timed out. Try again after the device is idle.",
  errorCode: "timed_out" as const,
};
const INDEX_FAILED_FAILURE = {
  error: "Indexing failed. Check that the embedding model is available, then try again.",
  errorCode: "index_failed" as const,
};
/**
 * A scheduled pass stopped short of rebuilding an index (TASK-1197): the
 * vectors on disk answer to another embedder, and throwing them away is the
 * owner's call, not the schedule's. Nothing was deleted.
 *
 * Says what happened to the pass and stops there, for the reason
 * PROVIDER_MISMATCH_FAILURE gives: the amber banner beside it already carries
 * "Run a full reindex", and the card must not print that instruction twice.
 */
const FULL_REINDEX_REQUIRED_FAILURE = {
  error: "Scheduled run stopped: this index needs a full reindex, which only you can start.",
  errorCode: "full_reindex_required" as const,
};
/**
 * The one failure this module can name a cause for, and the reason TASK-1024
 * needed more than a catch-all.
 *
 * "Check that the embedding model is available" is a fine last word when the
 * box knows nothing, and a bad one when it knows this: the model in the panel
 * is installed, answering and irrelevant, because the core never asked it. The
 * customer checked it, found it healthy, and was left with a button that did
 * not help. Said here instead of left to the banner because the run line is
 * what a failed pass puts in front of the owner.
 *
 * DELIBERATELY NOT THE BANNER'S SENTENCE. The two fire together — the run code
 * is decided from the same verdict the banner is drawn from — and the card
 * showed the identical ninety characters twice, telling the owner to re-run
 * setup in both. This one states what happened to the pass; the banner above it
 * gives the instruction. It still stands alone, because a config put right
 * between the pass and the render clears the banner and leaves this line.
 */
const PROVIDER_MISMATCH_FAILURE = {
  error: "Indexing failed: the embedding model in use is not the one you configured.",
  errorCode: "provider_mismatch" as const,
};

function fixedFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
): { error: string; errorCode: MemoryRunErrorCode } {
  // 124 is `timeout`'s own verdict, which is the same fact arriving as an exit
  // code rather than as this module's budget.
  if (code === 124) return TIMED_OUT_FAILURE;
  // Killed from outside — the OOM killer, an operator, a service restart. The
  // embedding model had nothing to do with it, so do not send the owner to
  // check it; the same words the reconcile uses for a run lost to a reboot.
  if (signal || code === null) return { error: INTERRUPTED_MESSAGE, errorCode: "interrupted" };
  if (code === LOCK_BUSY_EXIT) {
    return { error: "The embedding model is still being set up. Try again in a few minutes.", errorCode: "migration_busy" };
  }
  if (EXEC_FAILURE_EXITS.has(code)) {
    return { error: "OpenClaw is not installed or could not be started.", errorCode: "openclaw_missing" };
  }
  return INDEX_FAILED_FAILURE;
}

/**
 * What the CLI prints on its way out WHATEVER happened, so never the reason a
 * pass failed (TASK-2431). OpenClaw's agent database logs a "clean-close
 * receipt" each time a CLI closes it, and while the gateway holds the same
 * database the receipt is `active-leases` — on every pass, the ones that
 * succeed included. Taken as the last word, it is what the device log said
 * about a pass that had really failed on the memory workspace lock, and it
 * sent the diagnosis after the wrong thing. Also skipped: the stale-lease
 * notice the next pass prints as it reaps a dead pass's lease (recovery, not
 * a fault), and `script`'s own line when it is told to end the session.
 */
const SIGN_OFF_LINES = [
  /\[state\/agent-db\] agent database clean-close receipt:/,
  /\[state\/agent-db\] agent database stale lease:/,
  /^Session terminated, killing shell/,
];

/**
 * The CLI's own last word, for the device log.
 *
 * Only the tail is kept (see `createIndexProgressReader`): nothing here needs
 * the transcript — just whatever it said before it gave up, sign-off lines
 * aside (see SIGN_OFF_LINES).
 */
function lastMeaningfulLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const said = lines.filter((line) => !SIGN_OFF_LINES.some((re) => re.test(line)));
  const last = said.length ? said[said.length - 1] : lines[lines.length - 1];
  return last ? last.slice(0, 300) : "";
}

/**
 * How a pass ENDED, in the vocabulary of whichever arm ran it.
 *
 * Deliberately raw. The two arms fail in genuinely different ways — an exit
 * code and a signal on one, a thrown error on the other — and flattening that
 * at the source would mean each arm privately deciding what the owner is told.
 * `fixedFailure` and `localFailure` do the wording, in one place, below.
 */
type PassOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "threw"; error: unknown };

/**
 * One indexing pass, however it is performed.
 *
 * The whole point of the interface is that everything AROUND a pass — the
 * decline, the lock, the run-state file, the liveness reconcile, the stall
 * watchdog, the cache invalidation and the reload behind it — is written once
 * and is the same on both editions. Only the work in the middle differs.
 */
interface IndexPass {
  /**
   * Recorded as `childPid`, which `acquireRunLock` checks with
   * `processIsAlive`. The OpenClaw arm records the indexer's own pid — the
   * CURRENT one, after a retry (see startOpenclawPass). The local arm records
   * THIS process, which is the same fact for a pass that runs inside it: while
   * the web server is up the run is going, and a run lost to a restart reads
   * dead and is reconciled as interrupted — exactly as before.
   */
  readonly pid: number;
  /** Settles when the pass has ended, whatever became of it. */
  ended: Promise<PassOutcome>;
  /** Give up on it. Not the same as failing: the caller decides what to say. */
  abandon(): void;
  /** Its own last words, for the device log and never for the response. */
  tail(): string;
}

/**
 * The pseudo-terminal host for the OpenClaw pass, or null when the box has
 * none — in which case the pass runs on a pipe exactly as it always did and
 * the card keeps its bar with no numbers. See openclaw-index-progress.ts for
 * why a terminal is the only way to get them.
 */
function ptyHost(): string | null {
  const override = process.env.CLAWKEEP_MEMORY_PTY_HOST?.trim();
  for (const candidate of override ? [override] : ["/usr/bin/script", "/bin/script"]) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}

/** How often the OpenClaw arm reads its progress. `publishProgress` throttles the writes. */
const OPENCLAW_PROGRESS_POLL_MS = 1_000;
/**
 * The same reading off a terminal, where there are no counts to SHOW but the
 * stall watchdog still has to see the pass move: the chunks in the index it is
 * writing, on a slower clock — it is a COUNT over the whole index, on the web
 * server's event loop — and never drawn on the card.
 */
const OPENCLAW_ACTIVITY_POLL_MS = 15_000;

/**
 * How far a pass has got, on its way to the card and the stall watchdog.
 * `shown: false` is for the watchdog alone: off a terminal the OpenClaw arm
 * has a chunk count but no file counts, and a bar with numbers that never move
 * would be a claim the box cannot back.
 */
type PassProgressReporter = (progress: LocalIndexProgress, shown?: boolean) => void;

/**
 * OpenClaw's memory workspace lock (memory-core `short-term-locks`), named in
 * the error a pass gives up with when another process holds it (TASK-2431).
 *
 * A pass that dies holding it — ended by a stop or by the stall watchdog, the
 * OOM killer — leaves the entry behind. memory-core takes over an entry only
 * once it is more than 60 s old AND its owner is dead, and waits only 10 s for
 * it, so a pass started inside that minute exits 1 with "Timed out waiting for
 * memory workspace lock … (held by <the dead pid>)". That is the failure the
 * box logged as `clean-close receipt: active-leases`: the receipt is only the
 * last thing the CLI prints (see SIGN_OFF_LINES). The agent-database lease the
 * dead pass leaves too is not the problem — the next pass reaps it itself
 * ("stale lease: owner-pid-dead"). Waiting the minute out and running the pass
 * again is the recovery; a live holder (the gateway's own memory work) is
 * waited for the same way.
 */
const WORKSPACE_LOCK_HELD_RE = /Timed out waiting for memory workspace lock/;
/** Past memory-core's 60 s, with room for the CLI's boot. */
const DEFAULT_WORKSPACE_LOCK_RETRY_MS = 65_000;
/** Retries after the first attempt, before the pass is let fail. */
const WORKSPACE_LOCK_RETRIES = 2;
/** How often the wait between two attempts tells the stall watchdog it is waiting on purpose. */
const WORKSPACE_LOCK_WAIT_BEAT_MS = 1_000;

/** Overridable for tests only: nothing a test can wait out takes 65 s. */
function workspaceLockRetryMs(): number {
  const parsed = Number(process.env.CLAWKEEP_MEMORY_LOCK_RETRY_MS?.trim() || NaN);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 10 * 60_000 ? parsed : DEFAULT_WORKSPACE_LOCK_RETRY_MS;
}

function workspaceLockWasHeld(outcome: PassOutcome, tail: string): boolean {
  return outcome.kind === "exit" && outcome.signal === null && outcome.code !== null && outcome.code !== 0
    && WORKSPACE_LOCK_HELD_RE.test(tail);
}

/**
 * Runs the OpenClaw pass, and runs it again when the CLI gave up on a
 * memory workspace lock that someone else holds — up to WORKSPACE_LOCK_RETRIES
 * times, WORKSPACE_LOCK_RETRY_MS apart (see WORKSPACE_LOCK_HELD_RE). One pass
 * to the caller: `ended` is the last attempt's, `abandon` reaches whichever
 * attempt is current or the wait between two, and `onRespawn` names the new
 * process so the record and the liveness check follow it. The wait is told to
 * the stall watchdog as it starts and as it ends (`onWaiting`): it is the pass
 * doing what it should, not a pass that has hung, and a stall window set
 * shorter than it would otherwise end the pass in the middle of it.
 */
function startOpenclawPass(
  mode: MemoryIndexMode,
  onProgress: PassProgressReporter,
  agentId: string,
  onRespawn: (pid: number) => void,
  onWaiting: () => void,
): IndexPass {
  let current = startOpenclawAttempt(mode, onProgress, agentId);
  let abandoned = false;
  let wake: (() => void) | null = null;
  const ended = (async (): Promise<PassOutcome> => {
    for (let retry = 1; ; retry += 1) {
      const outcome = await current.ended;
      if (abandoned || retry > WORKSPACE_LOCK_RETRIES || !workspaceLockWasHeld(outcome, current.tail())) return outcome;
      const waitMs = workspaceLockRetryMs();
      console.warn(
        `[clawkeep-memory] ${mode} index pass found OpenClaw's memory workspace lock held`
        + ` (a pass that ended without releasing it, or the gateway's own memory work);`
        + ` running it again in ${Math.round(waitMs / 1000)} s (${retry}/${WORKSPACE_LOCK_RETRIES})`,
      );
      // Told to the watchdog all through the wait, not only at its two ends: a
      // window shorter than the wait would otherwise fire inside it.
      onWaiting();
      const beat = setInterval(onWaiting, WORKSPACE_LOCK_WAIT_BEAT_MS);
      beat.unref?.();
      try {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      } finally {
        clearInterval(beat);
        wake = null;
      }
      if (abandoned) return outcome;
      onWaiting();
      try {
        current = startOpenclawAttempt(mode, onProgress, agentId);
      } catch (error) {
        // `spawn` throws at once for some failures (ENOMEM, E2BIG) rather
        // than emitting "error". The pass ends on it like on any other end,
        // so `finish` still settles the record and frees the lock.
        return { kind: "threw", error };
      }
      onRespawn(current.pid);
    }
  })();
  return {
    get pid() { return current.pid; },
    ended,
    abandon: () => {
      abandoned = true;
      wake?.();
      current.abandon();
    },
    tail: () => current.tail(),
  };
}

/**
 * Starts `openclaw memory index --agent <agentId>` (`--force` for a full pass)
 * under the lock every `memory index` on the box takes. Where there is a
 * terminal to run it on, its progress comes from the counts it prints there
 * and from that agent's own database.
 */
function startOpenclawAttempt(mode: MemoryIndexMode, onProgress: PassProgressReporter, agentId: string): IndexPass {
  const host = ptyHost();
  // The agent the status reads (`openclawDefaultAgentId`), so the card's
  // counts and the pass that moves them are about the same index.
  const args = ["memory", "index", "--agent", agentId];
  if (mode === "full") args.push("--force");
  // `--verbose` is what selects the reporter's `line` face — the one that
  // prints the counts. Only asked for where there is a terminal to print them
  // on; on a pipe the reporter prints nothing either way.
  if (host) args.push("--verbose");
  // `-n -E 75` so a busy migration comes back as its own exit code rather than
  // looking like an indexing failure the customer should retry.
  //
  // `--no-fork` is load-bearing, not tidiness. util-linux `flock` defaults to
  // forking the command and waiting on it, so the process under supervision
  // would be the WRAPPER: killing it on the timeout or on a failed state write
  // would leave `openclaw memory index` running unsupervised while the lock it
  // was holding is released with the wrapper — the exact opposite of what both
  // of those paths are trying to achieve. With `--no-fork` flock execs into
  // openclaw — and with OPENCLAW_NO_RESPAWN in the environment (see
  // openclawEnv) that is the CLI itself rather than a launcher in front of it.
  const indexer = [
    "flock", "--no-fork", "-n", "-E", String(LOCK_BUSY_EXIT), EMBED_MIGRATION_LOCK, openclawBin(), ...args,
  ];
  // On a terminal, `script` is the one process between this module and the
  // indexer, and it is a faithful stand-in for it: it execs the command (via
  // `sh -c 'exec …'`, so there is no shell left in between), exits when the
  // indexer exits and with its code (`-e`), and forwards the SIGTERM `terminate`
  // sends. SIGKILL, the escalation, closes the terminal under the indexer,
  // which ends it with SIGHUP — nothing in `memory index` handles that — so the
  // lock it holds is released with it rather than outliving the record.
  //
  // stdin is a pipe nothing writes to, never /dev/null: `script` on a
  // non-terminal stdin reacts to EOF, and the pass must not depend on how a
  // given util-linux release does.
  const child = host
    ? spawn(/* turbopackIgnore: true */ host, ptyHostArgs(indexer), {
      env: { ...openclawEnv(), SHELL: "/bin/sh" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    : spawn(indexer[0], indexer.slice(1), { env: openclawEnv(), stdio: ["ignore", "ignore", "pipe"] });
  child.stdin?.on("error", () => { /* nothing is ever written to it */ });
  // What the CLI says — on a terminal its stdout and stderr arrive as one
  // stream — is kept for the device log and NOT for the response: this
  // module's contract is that raw CLI output, paths and provider errors stop
  // here. Without it a run that failed in 1.3 s left the owner with the
  // catch-all "check that the embedding model is available" — about a model
  // that was answering perfectly — and nothing anywhere on the box said why.
  // Draining the pipes is also what keeps a chatty run from blocking on a full
  // one. The same reader picks the reporter's counts out of it.
  const reader = createIndexProgressReader();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (text: string) => reader.push(text));
  }
  // Files come from the reporter, chunks from the index being written; the
  // two are joined here, on a clock rather than per write, because the chunk
  // count is a database read. Off a terminal nothing is SHOWN and
  // `run.progress` stays null — a bar with numbers that never move would be a
  // claim the box cannot back — but the chunks are still counted, slower, for
  // the stall watchdog (TASK-2431).
  // The environment the pass was spawned with, so the database watched is
  // the one its pinned state directory names.
  const dbPath = openclawAgentDbPath(agentId, openclawEnv());
  const since = Date.now();
  let chunks = 0;
  let poll: NodeJS.Timeout | null = setInterval(() => {
    const counts = host ? reader.latest() : null;
    const counted = countIndexChunks(dbPath, since, { rebuild: mode === "full" });
    if (counted !== null) chunks = counted;
    onProgress({ filesDone: counts?.filesDone ?? 0, filesTotal: counts?.filesTotal ?? 0, chunks }, host !== null);
  }, host ? OPENCLAW_PROGRESS_POLL_MS : OPENCLAW_ACTIVITY_POLL_MS);
  poll.unref();
  const stopPolling = () => {
    if (poll) clearInterval(poll);
    poll = null;
  };
  // Listen BEFORE the first await. A busy migration lock makes `flock -n`
  // exit in a couple of milliseconds, inside the state write below; with the
  // listeners attached after it, that exit went unseen, the run stayed
  // "running" with a dead pid, and the reconcile later called it interrupted
  // — the one outcome `-E 75` exists to avoid. A spawn error is emitted on
  // the next tick, which without a listener is an unhandled event.
  const ended = new Promise<PassOutcome>((resolve) => {
    child.once("error", (err) => {
      stopPolling();
      resolve({ kind: "exit", code: (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1, signal: null });
    });
    child.once("close", (code, signal) => {
      stopPolling();
      resolve({ kind: "exit", code, signal });
    });
  });
  return {
    pid: child.pid ?? 0,
    ended,
    abandon: () => {
      stopPolling();
      terminate(child);
    },
    tail: () => reader.tail(),
  };
}

function startLocalPass(
  mode: MemoryIndexMode,
  onProgress: LocalIndexProgressReporter,
  onHeartbeat: () => void,
  mayDiscard: boolean,
): IndexPass {
  const controller = new AbortController();
  let tail = "";
  // `EMBED_MIGRATION_LOCK` is deliberately not taken here. Its only other
  // holder is `scripts/ensure-local-embeddings.sh`, which writes openclaw.json
  // and never runs on this SKU, so `RUN_LOCK_PATH` is the whole single-flight
  // and a second lock would only be a second thing to leave behind.
  //
  // `mayDiscard` is false for the schedule: the plan's reading can be minutes
  // old, so the pass re-checks the store itself before it empties anything.
  const ended = runLocalIndexPass(mode, controller.signal, onProgress, { mayDiscard, onHeartbeat }).then(
    (result): PassOutcome => {
      // The pass's own numbers exist nowhere else — the run record keeps a
      // status and a duration, not a count — so they are said once, here.
      console.warn(
        `[memory-index] ${mode} pass: ${result.files} files, ${result.chunks} chunks`
        + (result.failures ? `, ${result.failures} unreadable` : "")
        + (result.capped ? " (the index reached its ceiling)" : ""),
      );
      // A success is an exit 0, in the vocabulary the other arm already speaks,
      // so `finish` has one shape to reason about instead of two.
      return { kind: "exit", code: 0, signal: null };
    },
    (error): PassOutcome => {
      tail = error instanceof Error ? error.message : String(error);
      return { kind: "threw", error };
    },
  );
  return {
    pid: process.pid,
    ended,
    abandon: () => controller.abort(),
    tail: () => tail,
  };
}

/**
 * What the owner is told when the LOCAL pass threw.
 *
 * Mapped onto the codes that already exist rather than adding new ones: every
 * one of them is already worded in ten languages, and none of these outcomes is
 * a thing the owner would act on differently. An embedder that would not answer
 * IS "check that the embedding model is available" — including the 502 the
 * MemAvailable guard answers a wake with, which is the box saying it is too
 * busy right now.
 */
function localFailure(error: unknown): { error: string; errorCode: MemoryRunErrorCode } {
  if (error instanceof IndexPassAbortedError) {
    return { error: INTERRUPTED_MESSAGE, errorCode: "interrupted" };
  }
  // A scheduled pass that found, on the store itself, an index its plan had
  // read as valid. Nothing was deleted; what it needs is the owner's rebuild,
  // and "check the embedding model" would send them to a model that is fine.
  if (error instanceof IndexRebuildRequiredError) return FULL_REINDEX_REQUIRED_FAILURE;
  // Everything else — the embedder refusing (EmbeddingUnavailableError), an
  // unreadable store, a bug — reads the same to the owner and has the same
  // next step.
  return INDEX_FAILED_FAILURE;
}

/**
 * Start one indexing pass, or decline because one is going.
 *
 * Takes the mode the caller ASKED for; the mode actually run (an incremental
 * pass on an empty index becomes a full build, see resolveIndexMode) is what
 * the run records. The decline comes first and costs a file read plus a pid
 * check — never the CLI probe. Resolving the mode before the decline made a
 * second "Index now" wait on the cold probe for as long as the run itself
 * took, then start a second run over the first one's record instead of
 * answering 409. The lock afterwards is the authoritative single-flight for
 * the few milliseconds two callers can both pass the read.
 *
 * The owner's switch is read inside that lock, and `declined` says which of
 * the two refusals happened. Both callers check it before they get here, but
 * neither check is the authorisation: the work between it and this point can
 * take seconds — resolveIndexMode may wait on a cold CLI probe — and a switch
 * flipped inside that window would otherwise start the very pass it forbids.
 * Here the read and the start are on the same side of the lock, so an "off"
 * either prevents a run or lands after one had already begun.
 *
 * The third refusal is the schedule's alone: `full_reindex_required`, for an
 * index the core has disowned, which only the owner rebuilds (see
 * resolveIndexMode). It starts nothing, so it takes no lock and writes no run
 * record — the status banner already says what the owner has to do.
 *
 * `embedderChanged` is the one pass the switch does not govern, and only on
 * the OpenClaw arm: the rebuild the box owes the CORE'S OWN index after it
 * wrote a new embedder into `memory.search` itself. That index exists whether
 * or not Memory Shard is on — it is the agent's MEMORY.md, USER.md and
 * memory/*.md, which the core indexes for its own memory search — and after
 * the write the core pauses vector search over it until a forced rebuild.
 * `ensure-local-embeddings.sh` runs that same rebuild for the other direction
 * with no regard for the switch, and so does the gateway pre-start's for a
 * change of the index's settings. Where ClawBox is the indexer its index holds
 * only the folders the owner chose, so there the switch still decides.
 *
 * `forAgent` is for a caller whose reason to index is a reading about one
 * agent (the keyword-only rebuild): when the box's default agent is no longer
 * that one by the time the pass is planned, nothing starts and the answer is
 * `agent_changed` — a verdict about one agent's index never forces another's.
 */
export async function startMemoryIndex(
  requested: MemoryIndexMode,
  trigger: MemoryIndexTrigger = "manual",
  options: { embedderChanged?: boolean; forAgent?: string } = {},
): Promise<{
  accepted: boolean;
  run: MemoryRunState;
  declined?: "running" | "disabled" | "full_reindex_required" | "agent_changed";
}> {
  const current = await readMemoryRunState();
  if (current.status === "running") return { accepted: false, declined: "running", run: current };

  // The agent this pass is about, bound before the plan (the read never
  // rejects): the reading that decides the mode and the pass that runs it
  // answer for the same agent, so a default re-pointed in between cannot have
  // the old agent's empty index send `--force` to the new one's populated
  // index. The plan may wait seconds on a probe, so the id is read again after
  // it, and a re-point inside that wait is planned once more for the agent
  // the box means now. Read before the run is on record, too, so nothing
  // between the state write and the spawn below waits on the disk.
  let agentId = await openclawDefaultAgentId();
  let plan = await planIndexPass(requested, trigger, agentId);
  const repointed = await openclawDefaultAgentId();
  if (repointed !== agentId) {
    agentId = repointed;
    plan = await planIndexPass(requested, trigger, agentId);
  }
  const { mode, fellBack, heldBack } = plan;
  if (options.forAgent !== undefined && options.forAgent !== agentId) {
    return { accepted: false, declined: "agent_changed", run: await readMemoryRunState() };
  }
  if (heldBack) return { accepted: false, declined: "full_reindex_required", run: await readMemoryRunState() };
  if (!await acquireRunLock()) {
    return { accepted: false, declined: "running", run: await readMemoryRunState() };
  }
  const coreIndexRebuild = options.embedderChanged === true && !openclawIsAbsent();
  if (!coreIndexRebuild && !(await getMemoryShardEnabled())) {
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
    return { accepted: false, declined: "disabled", run: await readMemoryRunState() };
  }

  const startedAtMs = Date.now();
  let state: PersistedMemoryRunState = {
    status: "running",
    mode,
    trigger,
    startedAtMs,
    finishedAtMs: 0,
    durationMs: 0,
    error: "",
    errorCode: "",
    progress: null,
    childPid: 0,
    progressAtMs: 0,
  };
  try {
    await writeRunState(state);
  } catch (err) {
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
    throw err;
  }

  // The one line that differs by edition. Everything above and below it — the
  // decline, the lock, the state file, the reconcile, the watchdog, the cache —
  // is the same work whoever does the indexing.
  // How far the pass has got, on its way to the card's bar.
  //
  // The run-state file is the only thing every reader of a run shares — the
  // route, the scheduler, another copy of this module (see process-store.ts) —
  // so progress rides on it rather than on an in-memory channel the route
  // handler might not be looking at. That makes each report an atomic file
  // write, which is why the reporter is throttled rather than passed through:
  // a pass over a folder of unchanged files walks thousands of them a second,
  // and the card reads every three.
  let settled = false;
  let reportedAtMs = 0;
  let reportInFlight = false;
  /** The newest write of the running record, for `finish` to wait behind. */
  let progressWritten: Promise<void> = Promise.resolve();
  /**
   * Writes the running record as it is NOW, after every write before it.
   * Never worth failing a run over. `finish` waits on `progressWritten` before
   * it writes the settled record: `writeJsonAtomic` is a write-then-rename with
   * no ordering between two calls, so a report still in flight would otherwise
   * land after the final state and put a running run's bar back over it — for
   * good, since nothing writes the file again. Chained for the same reason, so
   * a retry's new pid (see startOpenclawPass) cannot be overtaken by an older
   * progress write naming the process before it.
   */
  const persistState = (): Promise<void> => {
    progressWritten = progressWritten
      .then(() => writeRunState(state))
      .catch(() => { /* the next write tries again */ });
    return progressWritten;
  };
  const persistThrottled = () => {
    if (settled || reportInFlight) return;
    const now = Date.now();
    // The first report always lands, so the bar gets its denominator the
    // moment the scan has one, whatever the clock says.
    if (reportedAtMs && now - reportedAtMs < PROGRESS_WRITE_EVERY_MS) return;
    reportedAtMs = now;
    reportInFlight = true;
    void persistState().finally(() => { reportInFlight = false; });
  };
  // TASK-2431: the stall watchdog, and the record's own note of when the pass
  // last moved for a reader in another process. Created once the pass is on
  // record, below; a report before that only moves `progressAtMs`.
  let watchdog: StallWatchdog | null = null;
  let progressAtMs = 0;
  let lastMark = "";
  const noteMoved = () => {
    if (settled) return;
    progressAtMs = Date.now();
    watchdog?.touch();
    state = { ...state, progressAtMs };
    persistThrottled();
  };
  const publishProgress: PassProgressReporter = (progress, shown = true) => {
    if (settled) return;
    // The record carries the counts and nothing else: the reporter's object
    // is the pass's own and may grow fields no screen should get.
    if (shown) {
      state = {
        ...state,
        progress: { filesDone: progress.filesDone, filesTotal: progress.filesTotal, chunks: progress.chunks },
      };
    }
    const mark = progressMark(progress);
    if (mark === lastMark) {
      persistThrottled();
      return;
    }
    lastMark = mark;
    noteMoved();
  };
  const localArm = openclawIsAbsent();
  /** Every process this pass has run as: one, unless the OpenClaw arm retried. */
  const passPids = new Set<number>();
  const pass = localArm
    ? startLocalPass(mode, publishProgress, noteMoved, trigger !== "schedule")
    : startOpenclawPass(mode, publishProgress, agentId, (pid) => {
      // An attempt whose spawn failed has no pid (its "error" ends it at
      // once): the record keeps the last real one, which stays in
      // `settlingPasses` until `finish`, so no reader takes the run for lost
      // in between.
      if (settled || !pid) return;
      passPids.add(pid);
      settlingPasses().add(pid);
      state = { ...state, childPid: pid };
      void persistState();
    }, noteMoved);
  if (pass.pid) {
    passPids.add(pass.pid);
    settlingPasses().add(pass.pid);
  }
  state = { ...state, childPid: pass.pid };
  try {
    // The first write that names the pass, which must land (see the catch);
    // later writes queue behind it.
    const named = writeRunState(state);
    progressWritten = named.catch(() => { /* answered by the await below */ });
    await named;
  } catch (err) {
    // Without this, the pass keeps indexing unsupervised while the lock stays
    // on disk with childPid 0; LOCK_START_GRACE_MS later the reconcile calls
    // the live run interrupted and frees the lock, and a second index starts
    // on top of the first. `finish` is not attached yet, so the pass's end
    // cannot write a final state over this cleanup.
    settled = true;
    pass.abandon();
    for (const pid of passPids) settlingPasses().delete(pid);
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // Every way a run is given up on — the owner's stop, the stall watchdog —
  // comes through here, and a pass given up on is settled even if it never
  // ends: the OpenClaw arm is SIGKILLed TERMINATE_GRACE_MS after the SIGTERM,
  // but the local arm can only stop at its next check of the signal, and a
  // pass that never reached one must not hold the lock for ever.
  let abandonGrace: NodeJS.Timeout | null = null;
  let settleAbandoned: ((outcome: PassOutcome) => void) | null = null;
  const abandonedEnd = new Promise<PassOutcome>((resolve) => { settleAbandoned = resolve; });
  const giveUp = () => {
    pass.abandon();
    if (abandonGrace) return;
    abandonGrace = setTimeout(() => {
      console.warn(
        `[clawkeep-memory] the ${mode} index pass had not ended ${Math.round(ABANDON_SETTLE_MS / 1000)} s`
        + " after it was given up on; recording it as ended",
      );
      settleAbandoned?.({ kind: "exit", code: null, signal: null });
    }, ABANDON_SETTLE_MS);
    abandonGrace.unref?.();
  };
  const supervised: SupervisedPass = { startedAtMs, abandon: giveUp, stopRequested: false };
  supervisedPass().current = supervised;
  // Deliberately no cache invalidation here: nothing the probe reports changes
  // until the pass ends, and dropping the reading at spawn time made the
  // panel's very next read block on the cold probe for the whole run.

  // NO CAP on how long a pass runs (TASK-2431). The two-hour budget that was
  // here ended every full pass the on-box embedder needs 2.5 to 9 hours for,
  // while it was working. A pass is given up on only once it has stopped
  // MOVING for the stall window — see memory-index-stall.ts.
  const stallMs = indexStallMs();
  let stalled = false;
  watchdog = startStallWatchdog(stallMs, () => {
    stalled = true;
    giveUp();
  });
  const finish = async (outcome: PassOutcome) => {
    // Before anything else: a report that lands after this point would put a
    // running run's bar back over the settled record.
    settled = true;
    watchdog?.stop();
    if (abandonGrace) clearTimeout(abandonGrace);
    if (supervisedPass().current === supervised) supervisedPass().current = null;
    const finishedAtMs = Date.now();
    // An OpenClaw pass that was given up on is never a success, whatever came
    // back: on a terminal `script` answers the SIGTERM it passes on with an
    // exit 0 of its own, and a stopped pass was recorded as "succeeded". The
    // local arm's outcome is the pass's own word — one that finished before
    // it reached a check of the signal did finish.
    const givenUp = stalled || supervised.stopRequested;
    const ok = outcome.kind === "exit" && outcome.code === 0 && (localArm || !givenUp);
    // The stall first, because it is the one verdict that does not depend on
    // which arm ran: whatever the pass said on its way out, the watchdog is
    // what ended it. After that each arm is worded by its own mapper.
    const mapped = ok
      ? null
      : stalled
        ? STALLED_FAILURE
        : supervised.stopRequested
          ? (mode === "full" ? STOPPED_FULL_FAILURE[localArm ? "local" : "openclaw"] : STOPPED_FAILURE)
          : outcome.kind === "threw"
            ? localFailure(outcome.error)
            : fixedFailure(outcome.code, outcome.signal);
    // The catch-all, and ONLY the catch-all, gives way to the cause the plan
    // already found. Every other verdict above is a fact about how this pass
    // ended — a stall, a signal, a missing binary — and stays what it is:
    // a box whose config the core ignored can still be killed by the OOM
    // killer, and "re-run setup" would be the wrong thing to say about that.
    const failure = mapped && fellBack && mapped.errorCode === "index_failed"
      ? PROVIDER_MISMATCH_FAILURE
      : mapped;
    if (failure) {
      const how = outcome.kind === "exit"
        ? `exit ${outcome.code ?? "none"}${outcome.signal ? `, ${outcome.signal}` : ""}`
        : "threw";
      const why = stalled ? `no progress for ${stallMinutes(stallMs)} min; ` : "";
      console.warn(
        `[clawkeep-memory] ${mode} index run failed (${failure.errorCode}, ${how}): `
        + `${why}${lastMeaningfulLine(pass.tail()) || "it said nothing"}`,
      );
    }
    const finalState: PersistedMemoryRunState = {
      ...state,
      status: ok ? "succeeded" : "failed",
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      error: failure ? failure.error : "",
      errorCode: failure ? failure.errorCode : "",
      // The bar belongs to a pass that is going. A finished run says what it
      // did in its own line — mode, trigger, duration — and the index's real
      // counts are the card's own figures by then.
      progress: null,
      childPid: 0,
      progressAtMs: 0,
    };
    // See `persistState`: no report may still be on its way to the file.
    await progressWritten;
    // Tried more than once: left unwritten, the record says "running" beside a
    // reaped pid and the next read calls this pass interrupted, whatever it
    // did. Not for ever, though — the lock and the marker below are released
    // either way, because holding them over a disk that stays full would
    // refuse every later run until the web server restarted, and the reconcile
    // then says "interrupted", which is at worst the owner being told to run
    // it again.
    for (let attempt = 1; attempt <= SETTLED_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await writeRunState(finalState);
        break;
      } catch (err) {
        if (attempt === SETTLED_WRITE_ATTEMPTS) {
          console.warn(`[clawkeep-memory] could not record how the ${mode} index run ended:`, err);
        } else {
          await new Promise((resolve) => setTimeout(resolve, SETTLED_WRITE_RETRY_MS * attempt));
        }
      }
    }
    // Only now: until the settled record is on disk, a reader must not take
    // the reaped pid for a lost run.
    for (const pid of passPids) settlingPasses().delete(pid);
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
    // Whatever the cache holds now — the reading from before the pass, or one
    // a TTL probe took while the pass was writing the index — predates the
    // index the owner will see. The invalidation alone only marked it stale,
    // and the very next read was answered from it: the card's flip out of
    // "running", drawing "Run a full reindex" over an index that had just
    // been rebuilt (F-C). Unsettled, the next read that finds no run going
    // waits for the probe below instead.
    cachedStatusUnsettled = true;
    invalidateMemoryStatusCache();
    // Refresh behind the finished run rather than on the next read, so the new
    // counts are there by the time the owner looks, not ten seconds after.
    // Awaited only so that `memoryPassSettled` resolves after it: nothing
    // waits on `finish` itself, and the probe starts at this same moment.
    await reloadMemoryStatus().catch(() => { /* the next read tries again */ });
  };
  // A pass that rejected instead of ending is settled the same way: left
  // unhandled, the record would say "running" and the lock stay for good.
  passSettling().current = Promise.race([pass.ended, abandonedEnd])
    .then(finish, (error: unknown) => finish({ kind: "threw", error }));

  return { accepted: true, run: publicMemoryRunState(state) };
}

/**
 * Stop the running pass, if this process is supervising it. The pass ends the
 * way an interrupted one does — on the local arm between two files, on the
 * OpenClaw arm by SIGTERM to its CLI child — and its own `finish` writes the
 * settled record, frees the lock and refreshes the status, so a stop leaves
 * nothing behind that the next pass trips over. Files an incremental pass
 * indexed before the stop stay indexed; a stopped full pass is completed only
 * by another full one (see STOPPED_FULL_FAILURE).
 *
 * `stopped: false` when there is nothing this process can stop: no pass
 * running, or a run record that is not the pass held here (one a restarted
 * server left behind is reconciled by `readMemoryRunState` itself).
 */
export async function stopMemoryIndex(): Promise<{ stopped: boolean; run: MemoryRunState }> {
  const run = await readMemoryRunState();
  const held = supervisedPass().current;
  if (run.status !== "running" || !held || held.startedAtMs !== run.startedAtMs) return { stopped: false, run };
  held.stopRequested = true;
  held.abandon();
  return { stopped: true, run };
}
