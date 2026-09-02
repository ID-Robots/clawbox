/**
 * ClawKeep memory-management bridge.
 *
 * OpenClaw owns the memory index and its embedding provider. This module gives
 * the ClawKeep UI a deliberately small, sanitised view of that state and a
 * persistent, single-flight way to trigger incremental/full indexing. Raw CLI
 * output, database paths and provider errors never cross the API boundary.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMemoryShardEnabled, getMemoryShardSetupComplete } from "@/lib/memory-shard";

import { CLAWKEEP_DATA_DIR } from "@/lib/clawkeep";
import { findOpenclawBin } from "@/lib/openclaw-config";

export type MemoryScheduleFrequency = "daily" | "weekly";
export type MemoryIndexMode = "incremental" | "full";
export type MemoryIndexTrigger = "manual" | "schedule";
export type MemoryRunStatus = "idle" | "running" | "succeeded" | "failed";

export interface MemoryIndexSchedule {
  enabled: boolean;
  frequency: MemoryScheduleFrequency;
  /** HH:MM in device-local time. */
  timeOfDay: string;
  /** 0=Sunday ... 6=Saturday. */
  weekday: number;
}

interface PersistedMemoryRunState {
  status: MemoryRunStatus;
  mode: MemoryIndexMode | "";
  trigger: MemoryIndexTrigger | "";
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  error: string;
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
  /** Stable, non-secret digest of provider/model/sources. */
  fingerprint: string;
  /** The owner's switch for Memory Shard. Off on a box that has not been set
   *  up: indexing used to be unconditional, with no consent anywhere. */
  enabled: boolean;
  /** False until the owner finishes the setup wizard. The app shows the wizard
   *  instead of the index card while it is. */
  setupComplete: boolean;
  sourceCount: number;
  files: number;
  chunks: number;
  vectors: number;
  pendingFiles: number;
  failedItems: number;
  dirty: boolean;
  indexBytes: number;
  error: string;
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

const SCHEDULE_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index-schedule.json");
const RUN_STATE_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index-state.json");
const RUN_LOCK_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index.lock");
// Two minutes: the probe boots a whole OpenClaw process, and what it reports
// (provider, model, index health) changes through indexing runs — which call
// invalidateMemoryStatusCache — not on its own. Settings → Local AI polls the
// inventory every five seconds, so a short TTL here is a background OpenClaw
// boot every few polls.
const STATUS_CACHE_MS = 120_000;
const STATUS_TIMEOUT_MS = 90_000;
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
  childPid: 0,
};

let writeSeq = 0;
let cachedStatus: ClawKeepMemoryStatus | null = null;
let cachedStatusAtMs = 0;
let statusInFlight: Promise<ClawKeepMemoryStatus> | null = null;
/**
 * Bumped by every invalidation. A probe that was already running when a run
 * finished reports the index as it was mid-run; comparing the generation it
 * started under with the current one is how that answer is kept from being
 * served as fresh for the next two minutes.
 */
let statusGeneration = 0;

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
  const tmp = `${file}.tmp.${process.pid}.${++writeSeq}`;
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
    childPid: Number.isSafeInteger(raw.childPid) && Number(raw.childPid) > 0 ? Number(raw.childPid) : 0,
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
  const { status, mode, trigger, startedAtMs, finishedAtMs, durationMs, error } = state;
  return { status, mode, trigger, startedAtMs, finishedAtMs, durationMs, error };
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

const INTERRUPTED_MESSAGE = "Indexing was interrupted. Run it again.";

async function markInterrupted(state: PersistedMemoryRunState): Promise<PersistedMemoryRunState> {
  const finishedAtMs = Date.now();
  const failed: PersistedMemoryRunState = {
    ...state,
    status: "failed",
    finishedAtMs,
    durationMs: state.startedAtMs ? Math.max(0, finishedAtMs - state.startedAtMs) : 0,
    error: INTERRUPTED_MESSAGE,
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
    if (!stillStarting && (!processIsAlive(state.childPid) || age > INDEX_TIMEOUT_MS)) {
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

function identityStatus(value: unknown): ClawKeepMemoryStatus["indexIdentity"] {
  return value === "valid" || value === "missing" || value === "mismatched" ? value : "unknown";
}

function providerLocation(provider: string): ClawKeepMemoryStatus["location"] {
  if (!provider) return "unknown";
  if (provider === "none") return "disabled";
  if (provider === "ollama" || provider === "local") return "local";
  return "cloud";
}

export async function parseMemoryStatus(
  raw: unknown,
  run: MemoryRunState,
  schedule: MemoryIndexSchedule,
  now = new Date(),
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
  const indexIdentity = identityStatus(identity.status);
  const providerMode = cleanString(providerState.mode);
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
  else if (providerMode === "active" && indexIdentity === "valid") health = "healthy";

  return {
    available: Boolean(provider || model || files || chunks),
    provider,
    model,
    location: providerLocation(provider),
    health,
    semanticAvailable,
    indexIdentity,
    fingerprint,
    // Filled in by getMemoryStatus, which is the only caller with an await to
    // spend on the config store; the parser itself stays synchronous.
    enabled: false,
    setupComplete: false,
    sourceCount,
    files,
    chunks,
    vectors: semanticAvailable ? chunks : 0,
    pendingFiles,
    failedItems,
    dirty: status.dirty === true,
    indexBytes,
    error: indexIdentity === "mismatched"
      ? "The index does not match the configured embedding model. Run a full reindex."
      : indexIdentity === "missing"
        ? "The index fingerprint is missing. Run a full reindex."
        : health === "degraded"
          ? "The embedding model is not ready. Check the model, then try indexing again."
          : "",
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
    provider: "",
    model: "",
    location: "unknown",
    health: "unavailable",
    semanticAvailable: false,
    indexIdentity: "unknown",
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
  // The probe first, the run state after it. Read the other way round, a
  // cold answer carried the run state from when the probe STARTED — "running"
  // for a pass that had finished eight seconds before the answer arrived.
  const probe = await collectMemoryStatusJson().then(
    (raw) => ({ raw, ok: true as const }),
    () => ({ raw: null, ok: false as const }),
  );
  const [run, schedule] = await Promise.all([readMemoryRunState(), readMemorySchedule()]);
  if (!probe.ok) return unavailableStatus(run, schedule);
  try {
    return await parseMemoryStatus(probe.raw, run, schedule);
  } catch {
    return unavailableStatus(run, schedule);
  }
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

function reloadMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  if (!statusInFlight) {
    const generation = statusGeneration;
    statusInFlight = loadMemoryStatus().then((status) => {
      cachedStatus = status;
      // Invalidated while the probe ran: keep the answer, but as stale, so
      // the next reader refreshes it again instead of trusting a mid-run
      // reading for two minutes.
      cachedStatusAtMs = generation === statusGeneration ? Date.now() : 0;
      return status;
    }).finally(() => {
      statusInFlight = null;
    });
  }
  return statusInFlight;
}

/**
 * The CLI probe behind this takes ~8 s on a Jetson (a whole OpenClaw process
 * boots to answer it). Only a caller with NO reading yet waits for it: once a
 * status has been read, a stale one is answered at once and refreshed in the
 * background — otherwise Settings → Local AI, which polls the inventory every
 * five seconds, froze on a skeleton for eight seconds every half minute.
 *
 * The run state is read at answer time on both paths, so a caller that
 * joined a probe already in flight still gets the run as it is now.
 */
export async function getMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  let base = cachedStatus;
  if (!base) {
    base = await reloadMemoryStatus();
  } else if (Date.now() - cachedStatusAtMs >= STATUS_CACHE_MS) {
    reloadMemoryStatus().catch(() => { /* the next read tries again */ });
  }
  const [live, enabled, setupComplete] = await Promise.all([
    withLiveRunState(base),
    getMemoryShardEnabled(),
    getMemoryShardSetupComplete(),
  ]);
  return { ...live, enabled, setupComplete };
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
 * Answered from the cached reading when there is one (stale included: the
 * cost of a stale zero is one more pass over an index that was just built,
 * inside the ten seconds before the refresh lands). Only a box that has never
 * been probed waits for the probe — and `startMemoryIndex` asks this AFTER
 * declining a caller that overlaps a run, so that wait never overlaps one.
 */
export async function resolveIndexMode(requested: MemoryIndexMode): Promise<MemoryIndexMode> {
  if (requested === "full") return "full";
  try {
    const status = await getMemoryStatus();
    // `available` is load-bearing: a failed CLI probe returns the unavailable
    // status, which also reports zero chunks. Without this check a probe
    // timeout would silently turn a scheduled incremental pass into a --force
    // re-embed of an index that was perfectly fine.
    return status.available && status.chunks === 0 ? "full" : requested;
  } catch {
    // Same rule when the probe throws: run what was asked rather than
    // upgrading on a box we know nothing about.
    return requested;
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
  if (state.status === "running" && (stillStarting || (processIsAlive(state.childPid) && age <= INDEX_TIMEOUT_MS))) {
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

function fixedFailureMessage(timedOut: boolean, code: number | null, signal: NodeJS.Signals | null): string {
  if (timedOut || code === 124) return "Indexing timed out. Try again after the device is idle.";
  // Killed from outside — the OOM killer, an operator, a service restart. The
  // embedding model had nothing to do with it, so do not send the owner to
  // check it; the same words the reconcile uses for a run lost to a reboot.
  if (signal || code === null) return INTERRUPTED_MESSAGE;
  if (code === LOCK_BUSY_EXIT) return "The embedding model is still being set up. Try again in a few minutes.";
  if (EXEC_FAILURE_EXITS.has(code)) return "OpenClaw is not installed or could not be started.";
  return "Indexing failed. Check that the embedding model is available, then try again.";
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
 */
export async function startMemoryIndex(
  requested: MemoryIndexMode,
  trigger: MemoryIndexTrigger = "manual",
): Promise<{ accepted: boolean; run: MemoryRunState }> {
  const current = await readMemoryRunState();
  if (current.status === "running") return { accepted: false, run: current };

  const mode = await resolveIndexMode(requested);
  if (!await acquireRunLock()) {
    return { accepted: false, run: await readMemoryRunState() };
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
    childPid: 0,
  };
  try {
    await writeRunState(state);
  } catch (err) {
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true });
    throw err;
  }

  const args = ["memory", "index", "--agent", "main"];
  if (mode === "full") args.push("--force");
  // `-n -E 75` so a busy migration comes back as its own exit code rather than
  // looking like an indexing failure the customer should retry.
  //
  // `--no-fork` is load-bearing, not tidiness. util-linux `flock` defaults to
  // forking the command and waiting on it, so `child.pid` would be the WRAPPER:
  // killing it on the timeout or on a failed state write would leave
  // `openclaw memory index` running unsupervised while the lock it was holding
  // is released with the wrapper — the exact opposite of what both of those
  // paths are trying to achieve. With `--no-fork` flock execs into openclaw —
  // and with OPENCLAW_NO_RESPAWN in the environment (see openclawEnv) that is
  // the CLI itself rather than a launcher in front of it — so the pid we
  // record, supervise and signal is the indexer.
  const child = spawn(
    "flock",
    ["--no-fork", "-n", "-E", String(LOCK_BUSY_EXIT), EMBED_MIGRATION_LOCK, openclawBin(), ...args],
    { env: openclawEnv(), stdio: "ignore" },
  );
  // Listen BEFORE the first await. A busy migration lock makes `flock -n`
  // exit in a couple of milliseconds, inside the state write below; with the
  // listeners attached after it, that exit went unseen, the run stayed
  // "running" with a dead pid, and the reconcile later called it interrupted
  // — the one outcome `-E 75` exists to avoid. A spawn error is emitted on
  // the next tick, which without a listener is an unhandled event.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (err) => {
      resolve({ code: (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1, signal: null });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  state = { ...state, childPid: child.pid ?? 0 };
  try {
    await writeRunState(state);
  } catch (err) {
    // Without this, the child keeps indexing unsupervised while the lock stays
    // on disk with childPid 0; LOCK_START_GRACE_MS later the reconcile calls
    // the live run interrupted and frees the lock, and a second index starts
    // on top of the first. `exited` has no handler yet, so the child's end
    // cannot write a final state over this cleanup.
    terminate(child);
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // Deliberately no cache invalidation here: nothing the probe reports changes
  // until the pass ends, and dropping the reading at spawn time made the
  // panel's very next read block on the cold probe for the whole run.

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, INDEX_TIMEOUT_MS);
  const finish = async ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
    clearTimeout(timer);
    const finishedAtMs = Date.now();
    const ok = code === 0 && !timedOut;
    const finalState: PersistedMemoryRunState = {
      ...state,
      status: ok ? "succeeded" : "failed",
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      error: ok ? "" : fixedFailureMessage(timedOut, code, signal),
      childPid: 0,
    };
    await writeRunState(finalState).catch(() => { /* status route will reconcile */ });
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
    invalidateMemoryStatusCache();
    // Refresh behind the finished run rather than on the next read, so the new
    // counts are there by the time the owner looks, not ten seconds after.
    reloadMemoryStatus().catch(() => { /* the next read tries again */ });
  };
  void exited.then(finish);

  return { accepted: true, run: publicMemoryRunState(state) };
}
