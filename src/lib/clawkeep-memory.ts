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
import { CONFIG_PATH, findOpenclawBin, openclawIsAbsent } from "@/lib/openclaw-config";
import { resolveMemoryEmbedder } from "@/lib/memory-embedder";
import {
  IndexPassAbortedError,
  localMemoryStatusJson,
  runLocalIndexPass,
  type LocalIndexProgress,
  type LocalIndexProgressReporter,
} from "@/lib/memory-index-local";
import { isLoopbackBaseUrl } from "@/lib/embed-runtime-ids";
import { memoryStatusTimeoutMs } from "@/lib/memory-status-timeout";
import { processStore } from "@/lib/process-store";
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
  | "index_identity_mismatched"
  | "index_identity_missing"
  | "provider_mismatch"
  | "provider_degraded"
  | "status_unavailable";

export type MemoryRunErrorCode =
  | "timed_out"
  | "interrupted"
  | "migration_busy"
  | "openclaw_missing"
  | "provider_mismatch"
  | "index_failed";

const RUN_ERROR_CODES = new Set<string>([
  "timed_out",
  "interrupted",
  "migration_busy",
  "openclaw_missing",
  "provider_mismatch",
  "index_failed",
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
}

export type MemoryRunState = Omit<PersistedMemoryRunState, "childPid">;

export interface ClawKeepMemoryStatus {
  available: boolean;
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
const INDEX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
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

function runIsAlive(pid: number): boolean {
  return processIsAlive(pid) || (pid > 0 && settlingPasses().has(pid));
}

const INTERRUPTED_MESSAGE = "Indexing was interrupted. Run it again.";

async function markInterrupted(state: PersistedMemoryRunState): Promise<PersistedMemoryRunState> {
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
    error: INTERRUPTED_MESSAGE,
    errorCode: "interrupted",
    progress: null,
    childPid: 0,
  };
  await writeRunState(failed);
  await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
  return failed;
}

export async function readMemoryRunState(): Promise<MemoryRunState> {
  let state = await readPersistedRunState();
  if (state.status === "running") {
    const age = Date.now() - state.startedAtMs;
    const stillStarting = state.childPid === 0 && age >= 0 && age < LOCK_START_GRACE_MS;
    if (!stillStarting && (!runIsAlive(state.childPid) || age > INDEX_TIMEOUT_MS)) {
      state = await markInterrupted(state);
    }
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
  return {
    ...process.env,
    OPENCLAW_NO_RESPAWN: "1",
    PATH: parent ? `${prefix}${path.delimiter}${parent}` : prefix,
  };
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

function collectMemoryStatusJson(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(openclawBin(), ["memory", "status", "--agent", "main", "--deep", "--json"], {
      env: openclawEnv(),
      stdio: ["ignore", "pipe", "ignore"],
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
    }, STATUS_TIMEOUT_MS);
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
 * `memory.search.remote.baseUrl` (or its pre-2026.8 home), straight from
 * openclaw.json: the one fact providerLocation needs that the status probe
 * does not carry. Read from the file rather than the CLI because this runs
 * beside a probe that already costs a process boot. Null when unset or
 * unreadable — which providerLocation reports as "unknown", never as local.
 *
 * The file is `CONFIG_PATH`, never a path built from the home directory:
 * that constant honours `CLAWBOX_OPENCLAW_HOME` / `OPENCLAW_HOME`, and on an
 * installation that moves the state directory a hand-built `~/.openclaw`
 * read a file that is not there, so the card said "unknown" about an
 * embedder the boot script had just wired up.
 */
async function readEmbeddingRemoteBaseUrl(): Promise<string | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const pick = (root: unknown, keys: readonly string[]): string | null => {
      let node: unknown = root;
      for (const key of keys) node = asRecord(node)[key];
      return typeof node === "string" && node.trim() ? node.trim() : null;
    };
    return pick(config, ["memory", "search", "remote", "baseUrl"])
      ?? pick(config, ["agents", "defaults", "memorySearch", "remote", "baseUrl"]);
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
  health: ClawKeepMemoryStatus["health"];
}): { error: string; errorCode: MemoryStatusErrorCode | "" } {
  if (facts.fellBack) {
    return {
      error: "Memory search is not using the embedding model you configured. Re-run Memory Shard setup.",
      errorCode: "provider_mismatch",
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

export async function parseMemoryStatus(
  raw: unknown,
  run: MemoryRunState,
  schedule: MemoryIndexSchedule,
  now = new Date(),
  remoteBaseUrl: string | null = null,
): Promise<ClawKeepMemoryStatus> {
  const rows = Array.isArray(raw) ? raw : [raw];
  const row = asRecord(rows.find((entry) => cleanString(asRecord(entry).agentId) === "main") ?? rows[0]);
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
  const fellBack = Boolean(
    requestedProvider
    && provider
    && !PROVIDER_UNSPECIFIED.has(requestedProvider.toLowerCase())
    && requestedProvider.toLowerCase() !== provider.toLowerCase(),
  );
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
  if (!provider || provider === "none") health = "unavailable";
  else if (!semanticAvailable || providerMode === "degraded" || cleanString(custom.providerUnavailableReason)) health = "degraded";
  // A fallback embedder ANSWERS, so nothing above catches it: the core is
  // perfectly healthy embedding with the wrong model. Search still returns
  // results, they are just not the ones the owner's configuration would give,
  // which is the quietest way this can go wrong and so the one worth a chip.
  else if (fellBack) health = "degraded";
  else if (providerMode === "active" && indexIdentity === "valid") health = "healthy";
  // An index built by a different model — or one with no fingerprint at all —
  // is a KNOWN state, not an unknown one: search is degraded until it is
  // rebuilt, and the `error` below already says exactly that. Left as
  // "unknown", the chip contradicted the amber banner right beside it and
  // named nothing the owner could act on.
  else if (indexIdentity === "mismatched" || indexIdentity === "missing") health = "degraded";

  return {
    available: Boolean(provider || model || files || chunks),
    provider,
    model,
    location: providerLocation(provider, remoteBaseUrl),
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
    vectors: semanticAvailable ? chunks : 0,
    pendingFiles,
    failedItems,
    dirty: status.dirty === true,
    indexBytes,
    ...statusVerdict({ indexIdentity, indexIdentityCode, fellBack, health }),
    run,
    schedule,
    nextRunAtMs: computeNextMemoryRunMs(schedule, now),
  };
}

function unavailableStatus(
  run: MemoryRunState,
  schedule: MemoryIndexSchedule,
  now = new Date(),
): ClawKeepMemoryStatus {
  return {
    available: false,
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

async function loadMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  // Where there is no OpenClaw there is no CLI to probe: ClawBox's own index
  // answers the same shape, and everything below is unchanged.
  const local = openclawIsAbsent();
  // The probe first, the run state after it. Read the other way round, a
  // cold answer carried the run state from when the probe STARTED — "running"
  // for a pass that had finished eight seconds before the answer arrived.
  const probe = await (local ? localMemoryStatusJson() : collectMemoryStatusJson()).then(
    (raw) => ({ raw, ok: true as const }),
    () => ({ raw: null, ok: false as const }),
  );
  const [run, schedule, remoteBaseUrl] = await Promise.all([
    readMemoryRunState(),
    readMemorySchedule(),
    // openclaw.json is what points the OTHER arm's client at an embedder, and
    // on this SKU there is no such file — asked anyway it answers null, which
    // `providerLocation` reports as "unknown" and the card draws as an
    // embedder it cannot place. The local arm embeds through whichever of its
    // two endpoints it is pointed at, so THAT url is the answer: the loopback
    // proxy, or this box's ClawBox AI account. Hard-coded to the proxy, the
    // card said "On device" over an index being embedded in the cloud.
    local ? resolveMemoryEmbedder().then((embedder) => embedder.baseUrl) : readEmbeddingRemoteBaseUrl(),
  ]);
  if (!probe.ok) return unavailableStatus(run, schedule);
  try {
    const status = await parseMemoryStatus(probe.raw, run, schedule, new Date(), remoteBaseUrl);
    noteProviderFallback(status);
    return status;
  } catch {
    return unavailableStatus(run, schedule);
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
  return { ...live, enabled, setupComplete, planGate, nextRunAtMs: enabled ? live.nextRunAtMs : 0 };
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

/** Pay the cold probe at boot so the first Settings open after a restart does not. */
export function warmMemoryStatusCache(): Promise<void> {
  return reloadMemoryStatus().then(() => undefined);
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
 * Answered from the cached reading when there is one (stale included, and
 * one a run has changed since: the cost of a stale zero is one more pass
 * over an index that was just built, inside the ten seconds before the
 * refresh lands). Only a box that has never been probed waits for the probe —
 * `lastMemoryStatus` rather than `getMemoryStatus`, which now waits for the
 * settled reading after a run, and a click of "Index now" seconds after a
 * pass must not sit behind that probe — and `startMemoryIndex` asks this
 * AFTER declining a caller that overlaps a run, so that wait never overlaps
 * one.
 */
export async function resolveIndexMode(requested: MemoryIndexMode): Promise<MemoryIndexMode> {
  return (await planIndexPass(requested)).mode;
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
 */
async function planIndexPass(requested: MemoryIndexMode): Promise<{ mode: MemoryIndexMode; fellBack: boolean }> {
  if (requested === "full") {
    const seen = cachedStatus;
    return { mode: "full", fellBack: seen !== null && seen.available && providerFellBack(seen) };
  }
  try {
    const status = await lastMemoryStatus();
    // `available` is load-bearing: a failed CLI probe returns the unavailable
    // status, which also reports zero chunks AND an "unknown" identity. Without
    // this check a probe timeout would silently turn a scheduled incremental
    // pass into a --force re-embed of an index that was perfectly fine.
    if (!status.available) return { mode: requested, fellBack: false };
    return {
      mode: status.chunks === 0 || staleIndexIdentity(status) ? "full" : requested,
      fellBack: providerFellBack(status),
    };
  } catch {
    // Same rule when the probe throws: run what was asked rather than
    // upgrading on a box we know nothing about — and claim to know nothing
    // about its provider either, so the failure below is worded generically.
    return { mode: requested, fellBack: false };
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
  const age = Date.now() - state.startedAtMs;
  const stillStarting = state.status === "running" && state.childPid === 0 && age >= 0 && age < LOCK_START_GRACE_MS;
  if (state.status === "running" && (stillStarting || (runIsAlive(state.childPid) && age <= INDEX_TIMEOUT_MS))) {
    return false;
  }
  if (state.status === "running") await markInterrupted(state);
  else await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
  try {
    await fs.mkdir(RUN_LOCK_PATH, { mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

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
 * The CLI's own last word, for the device log.
 *
 * Only the tail is kept (see `createIndexProgressReader`): nothing here needs
 * the transcript — just whatever it said before it gave up.
 */
function lastMeaningfulLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
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
 * decline, the lock, the run-state file, the liveness reconcile, the two-hour
 * budget, the cache invalidation and the reload behind it — is written once and
 * is the same on both editions. Only the work in the middle differs.
 */
interface IndexPass {
  /**
   * Recorded as `childPid`, which `acquireRunLock` checks with
   * `processIsAlive`. The OpenClaw arm records the indexer's own pid. The local
   * arm records THIS process, which is the same fact for a pass that runs
   * inside it: while the web server is up the run is going, and a run lost to a
   * restart reads dead and is reconciled as interrupted — exactly as before.
   */
  pid: number;
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

function startOpenclawPass(mode: MemoryIndexMode, onProgress: LocalIndexProgressReporter): IndexPass {
  const host = ptyHost();
  const args = ["memory", "index", "--agent", "main"];
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
  // count is a database read. Off a terminal nothing is published at all and
  // `run.progress` stays null — a bar with numbers that never move would be a
  // claim the box cannot back.
  let poll: NodeJS.Timeout | null = null;
  if (host) {
    const dbPath = openclawAgentDbPath();
    const since = Date.now();
    let chunks = 0;
    poll = setInterval(() => {
      const counts = reader.latest();
      const counted = countIndexChunks(dbPath, since, { rebuild: mode === "full" });
      if (counted !== null) chunks = counted;
      onProgress({ filesDone: counts?.filesDone ?? 0, filesTotal: counts?.filesTotal ?? 0, chunks });
    }, OPENCLAW_PROGRESS_POLL_MS);
    poll.unref();
  }
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

function startLocalPass(mode: MemoryIndexMode, onProgress: LocalIndexProgressReporter): IndexPass {
  const controller = new AbortController();
  let tail = "";
  // `EMBED_MIGRATION_LOCK` is deliberately not taken here. Its only other
  // holder is `scripts/ensure-local-embeddings.sh`, which writes openclaw.json
  // and never runs on this SKU, so `RUN_LOCK_PATH` is the whole single-flight
  // and a second lock would only be a second thing to leave behind.
  const ended = runLocalIndexPass(mode, controller.signal, onProgress).then(
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
 */
export async function startMemoryIndex(
  requested: MemoryIndexMode,
  trigger: MemoryIndexTrigger = "manual",
): Promise<{ accepted: boolean; run: MemoryRunState; declined?: "running" | "disabled" }> {
  const current = await readMemoryRunState();
  if (current.status === "running") return { accepted: false, declined: "running", run: current };

  const { mode, fellBack } = await planIndexPass(requested);
  if (!await acquireRunLock()) {
    return { accepted: false, declined: "running", run: await readMemoryRunState() };
  }
  if (!(await getMemoryShardEnabled())) {
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
  };
  try {
    await writeRunState(state);
  } catch (err) {
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
    throw err;
  }

  // The one line that differs by edition. Everything above and below it — the
  // decline, the lock, the state file, the reconcile, the budget, the cache —
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
  /** The newest progress write, for `finish` to wait behind. */
  let progressWritten: Promise<void> = Promise.resolve();
  const publishProgress = (progress: LocalIndexProgress) => {
    if (settled || reportInFlight) return;
    const now = Date.now();
    // The first report always lands, so the bar gets its denominator the
    // moment the scan has one, whatever the clock says.
    if (reportedAtMs && now - reportedAtMs < PROGRESS_WRITE_EVERY_MS) return;
    reportedAtMs = now;
    reportInFlight = true;
    state = { ...state, progress };
    // Never worth failing a run over. `finish` waits on this handle before it
    // writes the settled record: `writeJsonAtomic` is a write-then-rename with
    // no ordering between two calls, so a report still in flight would
    // otherwise land after the final state and put a running run's bar back
    // over it — for good, since nothing writes the file again.
    progressWritten = writeRunState(state)
      .catch(() => { /* the next report tries again */ })
      .finally(() => { reportInFlight = false; });
  };
  const pass = openclawIsAbsent() ? startLocalPass(mode, publishProgress) : startOpenclawPass(mode, publishProgress);
  if (pass.pid) settlingPasses().add(pass.pid);
  state = { ...state, childPid: pass.pid };
  try {
    await writeRunState(state);
  } catch (err) {
    // Without this, the pass keeps indexing unsupervised while the lock stays
    // on disk with childPid 0; LOCK_START_GRACE_MS later the reconcile calls
    // the live run interrupted and frees the lock, and a second index starts
    // on top of the first. `finish` is not attached yet, so the pass's end
    // cannot write a final state over this cleanup.
    pass.abandon();
    settlingPasses().delete(pass.pid);
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // Deliberately no cache invalidation here: nothing the probe reports changes
  // until the pass ends, and dropping the reading at spawn time made the
  // panel's very next read block on the cold probe for the whole run.

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    pass.abandon();
  }, INDEX_TIMEOUT_MS);
  const finish = async (outcome: PassOutcome) => {
    // Before anything else: a report that lands after this point would put a
    // running run's bar back over the settled record.
    settled = true;
    clearTimeout(timer);
    const finishedAtMs = Date.now();
    const ok = !timedOut && outcome.kind === "exit" && outcome.code === 0;
    // The timeout first, because it is the one verdict that does not depend on
    // which arm ran: whatever the pass said on its way out, the budget is what
    // ended it. After that each arm is worded by its own mapper.
    const mapped = ok
      ? null
      : timedOut
        ? TIMED_OUT_FAILURE
        : outcome.kind === "threw"
          ? localFailure(outcome.error)
          : fixedFailure(outcome.code, outcome.signal);
    // The catch-all, and ONLY the catch-all, gives way to the cause the plan
    // already found. Every other verdict above is a fact about how this pass
    // ended — a timeout, a signal, a missing binary — and stays what it is:
    // a box whose config the core ignored can still be killed by the OOM
    // killer, and "re-run setup" would be the wrong thing to say about that.
    const failure = mapped && fellBack && mapped.errorCode === "index_failed"
      ? PROVIDER_MISMATCH_FAILURE
      : mapped;
    if (failure) {
      const how = outcome.kind === "exit"
        ? `exit ${outcome.code ?? "none"}${outcome.signal ? `, ${outcome.signal}` : ""}`
        : "threw";
      console.warn(
        `[clawkeep-memory] ${mode} index run failed (${failure.errorCode}, ${how}): `
        + `${lastMeaningfulLine(pass.tail()) || "it said nothing"}`,
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
    };
    // See `publishProgress`: no report may still be on its way to the file.
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
    settlingPasses().delete(pass.pid);
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
    reloadMemoryStatus().catch(() => { /* the next read tries again */ });
  };
  void pass.ended.then(finish);

  return { accepted: true, run: publicMemoryRunState(state) };
}
