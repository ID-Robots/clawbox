/**
 * ClawKeep memory-management bridge.
 *
 * OpenClaw owns the memory index and its embedding provider. This module gives
 * the ClawKeep UI a deliberately small, sanitised view of that state and a
 * persistent, single-flight way to trigger incremental/full indexing. Raw CLI
 * output, database paths and provider errors never cross the API boundary.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  sourceCount: number;
  files: number;
  chunks: number;
  vectors: number;
  pendingFiles: number;
  failedItems: number;
  dirty: boolean;
  indexBytes: number;
  lastIndexedAtMs: number;
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

const SCHEDULE_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index-schedule.json");
const RUN_STATE_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index-state.json");
const RUN_LOCK_PATH = path.join(CLAWKEEP_DATA_DIR, "memory-index.lock");
const STATUS_CACHE_MS = 30_000;
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

async function markInterrupted(state: PersistedMemoryRunState): Promise<PersistedMemoryRunState> {
  const finishedAtMs = Date.now();
  const failed: PersistedMemoryRunState = {
    ...state,
    status: "failed",
    finishedAtMs,
    durationMs: state.startedAtMs ? Math.max(0, finishedAtMs - state.startedAtMs) : 0,
    error: "Indexing was interrupted. Run it again.",
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
  return { ...process.env, PATH: parent ? `${prefix}${path.delimiter}${parent}` : prefix };
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
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, STATUS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STATUS_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
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

  let indexBytes = 0;
  let lastIndexedAtMs = 0;
  const dbPath = cleanString(status.dbPath);
  if (dbPath) {
    try {
      const stat = await fs.stat(dbPath);
      if (stat.isFile()) {
        indexBytes = stat.size;
        lastIndexedAtMs = stat.mtimeMs;
      }
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
    sourceCount,
    files,
    chunks,
    vectors: semanticAvailable ? chunks : 0,
    pendingFiles,
    failedItems,
    dirty: status.dirty === true,
    indexBytes,
    lastIndexedAtMs,
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
    lastIndexedAtMs: 0,
    error: "Memory status is unavailable. Try again.",
    run,
    schedule,
    nextRunAtMs: computeNextMemoryRunMs(schedule, now),
  };
}

async function loadMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  const [run, schedule] = await Promise.all([readMemoryRunState(), readMemorySchedule()]);
  try {
    return await parseMemoryStatus(await collectMemoryStatusJson(), run, schedule);
  } catch {
    return unavailableStatus(run, schedule);
  }
}

export function invalidateMemoryStatusCache(): void {
  cachedStatus = null;
  cachedStatusAtMs = 0;
}

export async function getMemoryStatus(): Promise<ClawKeepMemoryStatus> {
  const now = Date.now();
  if (cachedStatus && now - cachedStatusAtMs < STATUS_CACHE_MS) {
    // Run/schedule state changes independently from the expensive CLI probe.
    const [run, schedule] = await Promise.all([readMemoryRunState(), readMemorySchedule()]);
    return {
      ...cachedStatus,
      run,
      schedule,
      nextRunAtMs: computeNextMemoryRunMs(schedule, new Date()),
    };
  }
  if (!statusInFlight) {
    statusInFlight = loadMemoryStatus().then((status) => {
      cachedStatus = status;
      cachedStatusAtMs = Date.now();
      return status;
    }).finally(() => {
      statusInFlight = null;
    });
  }
  return statusInFlight;
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

function fixedFailureMessage(timedOut: boolean, code: number | null): string {
  if (timedOut || code === 124) return "Indexing timed out. Try again after the device is idle.";
  if (code === LOCK_BUSY_EXIT) return "The embedding model is still being set up. Try again in a few minutes.";
  if (code === 127) return "OpenClaw is not installed or could not be started.";
  return "Indexing failed. Check that the embedding model is available, then try again.";
}

export async function startMemoryIndex(
  mode: MemoryIndexMode,
  trigger: MemoryIndexTrigger = "manual",
): Promise<{ accepted: boolean; run: MemoryRunState }> {
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
  // `flock -n -E 75` so a busy migration comes back as its own exit code
  // instead of looking like an indexing failure the customer should retry.
  const child = spawn(
    "flock",
    ["-n", "-E", String(LOCK_BUSY_EXIT), EMBED_MIGRATION_LOCK, openclawBin(), ...args],
    { env: openclawEnv(), stdio: "ignore" },
  );
  state = { ...state, childPid: child.pid ?? 0 };
  await writeRunState(state);
  invalidateMemoryStatusCache();

  let settled = false;
  let timedOut = false;
  const finish = async (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const finishedAtMs = Date.now();
    const ok = code === 0 && !timedOut;
    const finalState: PersistedMemoryRunState = {
      ...state,
      status: ok ? "succeeded" : "failed",
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      error: ok ? "" : fixedFailureMessage(timedOut, code),
      childPid: 0,
    };
    await writeRunState(finalState).catch(() => { /* status route will reconcile */ });
    await fs.rm(RUN_LOCK_PATH, { recursive: true, force: true }).catch(() => {});
    invalidateMemoryStatusCache();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, INDEX_TIMEOUT_MS);
  child.once("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1;
    void finish(code);
  });
  child.once("close", (code) => { void finish(code); });

  return { accepted: true, run: publicMemoryRunState(state) };
}
