import { randomUUID } from "crypto";
import fs from "fs";
import { resolveConfigRoot } from "./config-store";
import path from "./runtime-path";
import { processStore } from "./process-store";
import {
  followRootStep,
  followRootStepRun,
  type FollowRootStepResult,
  type RootStepRun,
} from "./root-step-follow";

/**
 * Long work started from Settings that must not care whether Settings is open.
 *
 * WHY THIS EXISTS. An install started from Settings used to live inside the
 * response stream that started it: the route spawned the work, wrote its
 * progress into that one stream, and kept its "already running" flag in a
 * module-level `let`. The work itself mostly ran on when the window closed —
 * but the progress went with the stream, and nothing could ask for it again:
 * reopened, Settings drew the row as if nothing were happening, and a second
 * click answered 409 `busy` with no way to see the first. The owner's only
 * signal that a 20-minute speech build was still going was the 409.
 *
 * A task here is that same work, owned by the web server instead of by a
 * request:
 *
 *  - It runs as a promise of the server process, never awaited by a request,
 *    so a client that leaves — a closed window, a reload, a dropped tunnel —
 *    does not touch it.
 *  - Its state is ONE record per task: steps, the current headline, byte
 *    progress, a ring of log lines, and how it ended. The record is persisted
 *    (`data/background-tasks.json`), so a reopened Settings, the desktop's
 *    corner card and a second browser all read the same thing.
 *  - Anyone may follow it again: {@link subscribeBackgroundTask} hands the live
 *    events to a new stream, which is how a reopened Settings re-attaches.
 *
 * What a restart of the web server does. The promise dies with the process; a
 * record still `running` that this process did not start is therefore an
 * orphan. Most are closed as `interrupted` with a sentence that says why,
 * rather than drawn as a bar that never moves. The exception is work the task
 * had handed to systemd: a root step runs in its own unit, which outlives the
 * web server, and a task whose current step is one ({@link
 * BackgroundTaskContext.rootStep} records which run) is ADOPTED by the next
 * server — it follows the same run again, by its journal and its invocation,
 * to the ending the run really had.
 *
 * Stopping half-way. A task whose work can be stopped safely says so
 * (`cancellable`) and honours {@link BackgroundTaskContext.signal}; the owner's
 * Cancel aborts it and the task ends `cancelled`. A root step is never
 * cancellable: the web server may only start the launcher's steps, not stop
 * them, and none of them has a safe stop half-way through.
 *
 * One process, many module copies: the registry lives in {@link processStore},
 * keyed by the file it persists, for the reason that module documents.
 */

export type BackgroundTaskState = "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
export type BackgroundTaskStepState = "pending" | "running" | "done" | "failed";

export interface BackgroundTaskStep {
  id: string;
  label: string;
  state: BackgroundTaskStepState;
  /** How much of the whole this step is, relative to the others. Default 1. */
  weight: number;
}

export interface BackgroundTask {
  id: string;
  /** What kind of work: the key Settings re-attaches by. */
  kind: string;
  /** Tasks in one group never run together (they would write the same files). */
  group: string;
  title: string;
  /** What the starting request asked for, so a second request can tell whether it is the same work. */
  meta: Record<string, unknown> | null;
  state: BackgroundTaskState;
  steps: BackgroundTaskStep[];
  /** The latest headline, as the work said it. */
  status: string | null;
  /** Byte (or item) progress inside the current step, when the work measures it. */
  completed: number | null;
  total: number | null;
  startedAt: number;
  updatedAt: number;
  /** When the current step began, for its own rate. */
  stepStartedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** The closing payload the starting route used to answer with. */
  result: Record<string, unknown> | null;
  /** The last {@link LOG_LIMIT} lines. */
  log: string[];
  /** How many lines were ever logged, so a follower can tell what it missed. */
  logCount: number;
  /** The server process that runs it; a record from another one is an orphan. */
  runner: string;
  /** Closed by the owner on the desktop card; still listed for Settings. */
  dismissed: boolean;
  /** The owner may stop it half-way (its work honours the abort). */
  cancellable: boolean;
  /** A Cancel was asked for and the work is stopping. */
  cancelRequested: boolean;
  /**
   * The root step the CURRENT step runs in, while it runs: what a restarted
   * server follows again. Cleared when the step changes.
   */
  unit: BackgroundTaskUnit | null;
  /** When a server that did not start it took it over, if one did. */
  adoptedAt: number | null;
}

/** A root step's run, as a task records it for {@link BackgroundTask.unit}. */
export interface BackgroundTaskUnit extends RootStepRun {
  /** The task step it belongs to (null for a task without steps). */
  taskStep: string | null;
  /**
   * Set when the unit is the task's last real work: what the task closes with
   * when a restarted server sees the unit end well. Without it, an adopted
   * task whose unit ended well still closes `interrupted` — whatever the work
   * did after the unit never ran.
   */
  finishes: Record<string, unknown> | null;
  /**
   * The boot the run was seen in (/proc/sys/kernel/random/boot_id). A unit
   * cannot outlive a reboot, and after one systemd answers an instance that
   * never loaded as "inactive", which the follow must never read as the run
   * having ended well. Null when it could not be read.
   */
  bootId: string | null;
}

/** What callers and the API see: the record plus figures derived from it. */
export interface BackgroundTaskView extends BackgroundTask {
  percent: number | null;
  etaSeconds: number | null;
}

export type BackgroundTaskEvent =
  | { type: "status"; line: string }
  | { type: "log"; line: string }
  | { type: "progress"; completed: number; total: number }
  | { type: "step"; step: string }
  | { type: "end"; task: BackgroundTaskView };

export interface BackgroundTaskContext {
  readonly id: string;
  /**
   * Aborted when the owner cancels. Only a `cancellable` task can be
   * cancelled; its work stops what it started and rejects.
   */
  readonly signal: AbortSignal;
  /** Close the running step and start `id`. A headline may come with it. */
  step(id: string, status?: string): void;
  /** A new headline; it also goes to the log. */
  status(line: string): void;
  /** A log line only (build output, a fetcher's chatter). */
  log(line: string): void;
  /** Byte or item progress inside the current step. */
  progress(completed: number, total: number): void;
  /**
   * Whether Cancel is offered from here on. Work that enters a part it must
   * not be stopped in (a switch-over that takes seconds) turns it off, so the
   * owner is not offered a stop that would only label that part's own
   * failure "cancelled".
   */
  cancellable(on: boolean): void;
  /**
   * Run `install.sh --step <step>` as the current step's work and follow it to
   * its end ({@link followRootStep}), with its journal lines as the headline.
   * The run is recorded on the task, so a web server that restarts while the
   * unit runs on adopts it instead of calling it lost. `finishes`: see
   * {@link BackgroundTaskUnit.finishes}.
   */
  rootStep(
    step: string,
    opts: { timeoutMs: number; label: string; finishes?: Record<string, unknown> },
  ): Promise<FollowRootStepResult>;
}

export interface StartBackgroundTaskSpec {
  kind: string;
  /** Defaults to `kind`. */
  group?: string;
  title: string;
  meta?: Record<string, unknown>;
  steps?: Array<{ id: string; label: string; weight?: number }>;
  /** The first headline, so a card drawn before the work says anything is not blank. */
  status?: string;
  /** The owner may stop it half-way: `run` honours `ctx.signal`. */
  cancellable?: boolean;
  /**
   * The work. Resolve with the payload the route used to close its stream
   * with; throw (or reject) to fail it — the message is what the owner reads.
   */
  run(ctx: BackgroundTaskContext): Promise<Record<string, unknown> | void>;
}

export type StartBackgroundTaskResult =
  | { started: true; task: BackgroundTaskView }
  | { started: false; running: BackgroundTaskView };

/** Raise from `run` to fail with a code the route's old error answer carried. */
export class BackgroundTaskFailure extends Error {
  constructor(message: string, readonly payload: Record<string, unknown> = {}) {
    super(message);
  }
}

/**
 * Raise from `run` once the owner's Cancel has stopped the work. Only this (or
 * an `AbortError`) ends a task `cancelled`: any other failure after a Cancel
 * is still that failure, said as such.
 */
export class BackgroundTaskCancelled extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "BackgroundTaskCancelled";
  }
}

function isCancellation(err: unknown): boolean {
  if (err instanceof BackgroundTaskCancelled) return true;
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/** This boot's id, or null. Read per call: it is one small procfs file. */
function currentBootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export const LOG_LIMIT = 200;
const LOG_LINE_MAX = 500;
/** Finished records kept for the card and for Settings to read how it ended. */
const FINISHED_KEEP = 20;
const FINISHED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Progress is persisted at most this often; an end is persisted at once. */
const PERSIST_THROTTLE_MS = 1_000;
/** Below this much of the whole, or this soon after the start, an ETA is a guess. */
const ETA_MIN_FRACTION = 0.02;
const ETA_MIN_ELAPSED_MS = 5_000;

export const INTERRUPTED_MESSAGE =
  "The ClawBox web server restarted while this was running, so its progress was lost. Check the result and start it again if it did not finish.";
/** The headline an adopted task opens with. */
export const ADOPTED_STATUS = "The ClawBox web server restarted; following the same run again.";
/** An adopted task whose unit ended well, but whose work after the unit never ran. */
export const ADOPTED_UNFINISHED_MESSAGE =
  "The install itself finished while the ClawBox web server restarted, but what comes after it did not run. Start it again to finish.";
export const CANCELLED_STATUS = "Cancelled.";
const CANCELLING_STATUS = "Stopping…";
/**
 * How long an adopted unit is followed: config/clawbox-root-update@.service's
 * TimeoutStartSec (2 h) from the run's own start, so systemd, not this
 * follow, ends a run that hangs — plus a margin for the last poll.
 */
const ADOPT_MAX_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;
const ADOPT_MIN_MS = 60 * 1000;

/** At call time, so a test that points `CLAWBOX_ROOT` elsewhere gets its own file and registry. */
function tasksFile(): string {
  return path.join(resolveConfigRoot(), "data", "background-tasks.json");
}

interface Registry {
  file: string;
  /** Unique per server process; see {@link BackgroundTask.runner}. */
  runner: string;
  loaded: boolean;
  tasks: Map<string, BackgroundTask>;
  listeners: Map<string, Set<(event: BackgroundTaskEvent) => void>>;
  /** The abort behind each running task of THIS process, for Cancel. */
  controllers: Map<string, AbortController>;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

/** The process's registry for the current file, as it is: not loaded here. */
function rawRegistry(): Registry {
  const file = tasksFile();
  const reg = processStore<Registry>(`background-tasks:${file}`, () => ({
    file,
    runner: randomUUID(),
    loaded: false,
    tasks: new Map(),
    listeners: new Map(),
    controllers: new Map(),
    persistTimer: null,
  }));
  // A registry an older copy of this module made (a dev server's hot reload)
  // predates the map.
  reg.controllers ??= new Map();
  return reg;
}

function registry(): Registry {
  const reg = rawRegistry();
  if (!reg.loaded) load(reg);
  return reg;
}

function isUnit(value: unknown): value is BackgroundTaskUnit {
  if (!value || typeof value !== "object") return false;
  const u = value as Partial<BackgroundTaskUnit>;
  return typeof u.step === "string" && typeof u.sinceMs === "number"
    && (u.invocationId === null || typeof u.invocationId === "string");
}

/**
 * Whether a restarted server can follow this orphan again: its current step
 * is a root step whose run it recorded. A task that had moved past the unit
 * (to work of the dead process) cannot be — that work is gone.
 */
function adoptable(task: BackgroundTask): boolean {
  if (!task.unit) return false;
  const running = task.steps.find((s) => s.state === "running")?.id ?? null;
  return task.unit.taskStep === running;
}

function isTask(value: unknown): value is BackgroundTask {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<BackgroundTask>;
  return typeof t.id === "string" && typeof t.kind === "string" && typeof t.title === "string"
    && typeof t.state === "string" && Array.isArray(t.steps) && Array.isArray(t.log)
    && typeof t.startedAt === "number";
}

/**
 * Read the persisted records once per process. A record left `running` by
 * another process is closed here, before anyone can read it as live.
 */
function load(reg: Registry): void {
  reg.loaded = true;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(reg.file, "utf-8"));
  } catch {
    return;
  }
  const list = raw && typeof raw === "object" ? (raw as { tasks?: unknown }).tasks : null;
  if (!Array.isArray(list)) return;
  const now = Date.now();
  let orphaned = false;
  const adopted: BackgroundTask[] = [];
  const cleanedUp: string[] = [];
  for (const entry of list) {
    if (!isTask(entry)) continue;
    const unit = (entry as { unit?: unknown }).unit;
    const task: BackgroundTask = {
      ...entry,
      group: typeof entry.group === "string" ? entry.group : entry.kind,
      meta: entry.meta && typeof entry.meta === "object" ? entry.meta : null,
      dismissed: entry.dismissed === true,
      logCount: typeof entry.logCount === "number" ? entry.logCount : entry.log.length,
      cancellable: entry.cancellable === true,
      cancelRequested: entry.cancelRequested === true,
      unit: isUnit(unit)
        ? {
          step: unit.step,
          sinceMs: unit.sinceMs,
          invocationId: unit.invocationId,
          taskStep: typeof unit.taskStep === "string" ? unit.taskStep : null,
          finishes: unit.finishes && typeof unit.finishes === "object" ? unit.finishes : null,
          bootId: typeof unit.bootId === "string" ? unit.bootId : null,
        }
        : null,
      adoptedAt: typeof entry.adoptedAt === "number" ? entry.adoptedAt : null,
    };
    if (task.state === "running" && task.runner !== reg.runner) {
      orphaned = true;
      if (adoptable(task)) {
        // Still running, now this process's. Its follow starts once the
        // registry is in place (below), never from inside the read.
        task.runner = reg.runner;
        task.adoptedAt = now;
        task.updatedAt = now;
        task.cancellable = false;
        adopted.push(task);
      } else {
        closeOrphan(task, now);
        cleanedUp.push(task.kind);
      }
    }
    reg.tasks.set(task.id, task);
  }
  if (orphaned) persistNow(reg);
  for (const task of adopted) setImmediate(() => { void adopt(reg, task); });
  // What a cut-off task of these kinds left half-done is undone once, here —
  // the work that would have done it died with the old process.
  for (const kind of new Set(cleanedUp)) {
    setImmediate(() => {
      void import("./background-task-finishers")
        .then(({ hooksFor }) => hooksFor(kind))
        .then((hooks) => hooks.cleanup?.())
        .catch((err) => console.warn("[background-tasks] cleanup after a restart failed:", err instanceof Error ? err.message : err));
    });
  }
}

function closeOrphan(task: BackgroundTask, now: number): void {
  task.state = "interrupted";
  task.error = INTERRUPTED_MESSAGE;
  task.finishedAt = now;
  task.updatedAt = now;
  task.unit = null;
  task.steps = task.steps.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s));
}

/**
 * Follow an adopted task's root step to its end and close the task the way
 * the run ended. The unit was the current step's work; what came after it in
 * the dead process is lost, which is what {@link BackgroundTaskUnit.finishes}
 * is for.
 */
async function adopt(reg: Registry, task: BackgroundTask): Promise<void> {
  const unit = task.unit;
  if (!unit || task.state !== "running") return;
  const ctx = contextFor(reg, task, new AbortController().signal);
  const hooks = await import("./background-task-finishers")
    .then(({ hooksFor }) => hooksFor(task.kind))
    .catch(() => ({} as Awaited<ReturnType<typeof import("./background-task-finishers").hooksFor>>));
  const cleanUp = () => hooks.finish?.(false).catch(() => undefined);

  // A reboot ends every unit; what systemd says about the instance afterwards
  // is a fresh, never-run view of it, not this run's ending.
  const boot = currentBootId();
  if (unit.bootId && boot && unit.bootId !== boot) {
    await cleanUp();
    finishTask(reg, task, "interrupted", { error: INTERRUPTED_MESSAGE });
    return;
  }

  ctx.status(ADOPTED_STATUS);
  const budget = Math.max(ADOPT_MIN_MS, unit.sinceMs + ADOPT_MAX_MS - Date.now());
  let outcome: FollowRootStepResult;
  try {
    outcome = await followRootStepRun(
      { step: unit.step, sinceMs: unit.sinceMs, invocationId: unit.invocationId },
      { timeoutMs: budget, label: task.title, onStatus: (line) => ctx.status(line) },
    );
  } catch (err) {
    outcome = { ok: false, lost: true, error: err instanceof Error ? err.message : undefined };
  }
  if (outcome.lost) {
    await cleanUp();
    finishTask(reg, task, "interrupted", { error: INTERRUPTED_MESSAGE });
  } else if (!outcome.ok) {
    await cleanUp();
    finishTask(reg, task, "failed", { error: outcome.error || `${task.title} did not finish.` });
  } else if (hooks.finish) {
    // The kind says what "ended well" means once the unit is done.
    const ended = await hooks.finish(true).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : undefined,
      result: undefined,
    }));
    if (ended.ok) finishTask(reg, task, "succeeded", { result: ended.result ?? unit.finishes ?? null });
    else finishTask(reg, task, "failed", { error: ended.error || `${task.title} did not finish.` });
  } else if (unit.finishes) {
    finishTask(reg, task, "succeeded", { result: unit.finishes });
  } else {
    finishTask(reg, task, "interrupted", { error: ADOPTED_UNFINISHED_MESSAGE });
  }
}

function prune(reg: Registry, now: number): void {
  const finished = [...reg.tasks.values()]
    .filter((t) => t.state !== "running")
    .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt));
  finished.forEach((task, index) => {
    const age = now - (task.finishedAt ?? task.updatedAt);
    if (index >= FINISHED_KEEP || age > FINISHED_MAX_AGE_MS) reg.tasks.delete(task.id);
  });
}

/**
 * Atomic: a reader never sees half a file. Best effort — a disk that refuses
 * the write leaves the live record in memory, which is what this process
 * answers from anyway; only a restart loses it.
 */
function persistNow(reg: Registry): void {
  if (reg.persistTimer) {
    clearTimeout(reg.persistTimer);
    reg.persistTimer = null;
  }
  prune(reg, Date.now());
  const tmp = `${reg.file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(reg.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: [...reg.tasks.values()] }), "utf-8");
    fs.renameSync(tmp, reg.file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    console.warn("[background-tasks] could not persist task state:", err instanceof Error ? err.message : err);
  }
}

function persistSoon(reg: Registry): void {
  if (reg.persistTimer) return;
  reg.persistTimer = setTimeout(() => {
    reg.persistTimer = null;
    persistNow(reg);
  }, PERSIST_THROTTLE_MS);
  reg.persistTimer.unref?.();
}

function emit(reg: Registry, id: string, event: BackgroundTaskEvent): void {
  const listeners = reg.listeners.get(id);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* a follower that broke is its own problem */ }
  }
}

/**
 * A line as the owner can read it: terminal colour codes and control bytes
 * out, trailing space off, a runaway line cut. Leading space stays — it is the
 * indentation of an installer's own sub-steps, and the routes always streamed
 * it as it came. A blank line is no line.
 */
function cleanLine(line: string): string {
  const plain = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trimEnd();
  if (!plain.trim()) return "";
  return plain.length > LOG_LINE_MAX ? `${plain.slice(0, LOG_LINE_MAX - 1)}…` : plain;
}

function appendLog(task: BackgroundTask, line: string): void {
  task.log.push(line);
  task.logCount += 1;
  if (task.log.length > LOG_LIMIT) task.log.splice(0, task.log.length - LOG_LIMIT);
}

/**
 * How far along the whole task is, 0–100. Done steps count whole, the running
 * one by its own byte fraction (0 when it measures nothing), by weight. A task
 * with no steps is its byte fraction alone, or unknown.
 */
export function taskPercent(task: Pick<BackgroundTask, "state" | "steps" | "completed" | "total">): number | null {
  if (task.state === "succeeded") return 100;
  const fraction = task.total && task.total > 0 && task.completed !== null
    ? Math.min(1, Math.max(0, task.completed / task.total))
    : null;
  if (task.steps.length === 0) return fraction === null ? null : Math.round(fraction * 1000) / 10;
  const whole = task.steps.reduce((sum, s) => sum + s.weight, 0);
  if (whole <= 0) return null;
  const done = task.steps.reduce((sum, s) => {
    if (s.state === "done") return sum + s.weight;
    if (s.state === "running") return sum + s.weight * (fraction ?? 0);
    return sum;
  }, 0);
  return Math.round((done / whole) * 1000) / 10;
}

/**
 * Seconds left, or null where any figure would be invented: before the work
 * has moved enough to have a rate, and once it has ended. Byte progress in the
 * current step gives the honest rate when it is the last step that matters;
 * otherwise the whole task's rate so far.
 */
export function taskEtaSeconds(
  task: Pick<BackgroundTask, "state" | "steps" | "completed" | "total" | "startedAt" | "stepStartedAt">,
  now: number,
): number | null {
  if (task.state !== "running") return null;
  const running = task.steps.findIndex((s) => s.state === "running");
  const lastWeighted = running >= 0 && task.steps.slice(running + 1).every((s) => s.weight === 0);
  if ((task.steps.length === 0 || lastWeighted) && task.total && task.total > 0 && task.completed !== null) {
    const fraction = task.completed / task.total;
    const elapsed = now - task.stepStartedAt;
    if (fraction >= ETA_MIN_FRACTION && fraction < 1 && elapsed >= ETA_MIN_ELAPSED_MS) {
      return Math.round((elapsed * (1 - fraction)) / fraction / 1000);
    }
    return null;
  }
  const percent = taskPercent(task);
  const elapsed = now - task.startedAt;
  if (percent === null || percent / 100 < ETA_MIN_FRACTION || percent >= 100 || elapsed < ETA_MIN_ELAPSED_MS) return null;
  const fraction = percent / 100;
  return Math.round((elapsed * (1 - fraction)) / fraction / 1000);
}

export function viewBackgroundTask(task: BackgroundTask, now = Date.now()): BackgroundTaskView {
  return {
    ...task,
    steps: task.steps.map((s) => ({ ...s })),
    log: [...task.log],
    percent: taskPercent(task),
    etaSeconds: taskEtaSeconds(task, now),
  };
}

/** Every kept task, newest first. */
export function listBackgroundTasks(filter: { kind?: string; group?: string } = {}): BackgroundTaskView[] {
  const reg = registry();
  const now = Date.now();
  return [...reg.tasks.values()]
    .filter((t) => (filter.kind ? t.kind === filter.kind : true) && (filter.group ? t.group === filter.group : true))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => viewBackgroundTask(t, now));
}

export function getBackgroundTask(id: string): BackgroundTaskView | null {
  const task = registry().tasks.get(id);
  return task ? viewBackgroundTask(task) : null;
}

/** The task of this group that is running now, if any. */
export function runningBackgroundTask(group: string): BackgroundTaskView | null {
  for (const task of registry().tasks.values()) {
    if (task.group === group && task.state === "running") return viewBackgroundTask(task);
  }
  return null;
}

/**
 * Start `spec.run` as a task of the server, or — when its group already has
 * one running — answer that one, so the caller can re-attach instead of
 * starting a second copy over the first.
 *
 * Synchronous up to the start: two requests that arrive together cannot both
 * pass the group check, because nothing awaits between it and the insert.
 */
export function startBackgroundTask(spec: StartBackgroundTaskSpec): StartBackgroundTaskResult {
  const reg = registry();
  const group = spec.group ?? spec.kind;
  const running = runningBackgroundTask(group);
  if (running) return { started: false, running };

  const now = Date.now();
  const task: BackgroundTask = {
    id: randomUUID(),
    kind: spec.kind,
    group,
    title: spec.title,
    meta: spec.meta ?? null,
    state: "running",
    steps: (spec.steps ?? []).map((s) => ({ id: s.id, label: s.label, state: "pending", weight: s.weight ?? 1 })),
    status: spec.status ?? null,
    completed: null,
    total: null,
    startedAt: now,
    updatedAt: now,
    stepStartedAt: now,
    finishedAt: null,
    error: null,
    result: null,
    log: [],
    logCount: 0,
    runner: reg.runner,
    dismissed: false,
    cancellable: spec.cancellable === true,
    cancelRequested: false,
    unit: null,
    adoptedAt: null,
  };
  if (task.status) appendLog(task, task.status);
  reg.tasks.set(task.id, task);
  persistNow(reg);

  const controller = new AbortController();
  reg.controllers.set(task.id, controller);
  const ctx = contextFor(reg, task, controller.signal);

  // Deferred a tick so the caller holds the task (and can subscribe) before
  // the work says its first word.
  setImmediate(() => {
    let work: Promise<Record<string, unknown> | void>;
    try {
      work = spec.run(ctx);
    } catch (err) {
      work = Promise.reject(err);
    }
    work.then(
      (result) => finishTask(reg, task, "succeeded", { result: result ?? null }),
      (err: unknown) => {
        // The owner asked for this ending: not a failure to paint red.
        if (task.cancelRequested && isCancellation(err)) {
          finishTask(reg, task, "cancelled", { result: { status: CANCELLED_STATUS } });
          return;
        }
        const payload = err instanceof BackgroundTaskFailure ? err.payload : null;
        finishTask(reg, task, "failed", {
          result: payload,
          error: err instanceof Error && err.message ? err.message : `${task.title} did not finish.`,
        });
      },
    );
  });

  return { started: true, task: viewBackgroundTask(task, now) };
}

/** The handle a task's work (or its adoption) writes the record through. */
function contextFor(reg: Registry, task: BackgroundTask, signal: AbortSignal): BackgroundTaskContext {
  const live = () => task.state === "running";
  const touch = () => {
    task.updatedAt = Date.now();
    persistSoon(reg);
  };
  const ctx: BackgroundTaskContext = {
    id: task.id,
    signal,
    step(stepId, status) {
      if (!live()) return;
      const target = task.steps.find((s) => s.id === stepId);
      if (!target) return;
      for (const s of task.steps) if (s.state === "running") s.state = "done";
      // Steps the work jumped over (an already-cached download) are done too:
      // they are behind it, and a bar that counts them as pending never fills.
      for (const s of task.steps) {
        if (s === target) break;
        if (s.state === "pending") s.state = "done";
      }
      target.state = "running";
      task.completed = null;
      task.total = null;
      // The last step's unit is behind it now; a restart in this step has no
      // run of systemd's to follow.
      task.unit = null;
      task.stepStartedAt = Date.now();
      task.updatedAt = task.stepStartedAt;
      // A step is rare and is what a reader after a restart most needs to know.
      persistNow(reg);
      emit(reg, task.id, { type: "step", step: stepId });
      if (status) ctx.status(status);
    },
    status(line) {
      if (!live()) return;
      const clean = cleanLine(line);
      if (!clean) return;
      task.status = clean;
      appendLog(task, clean);
      touch();
      emit(reg, task.id, { type: "status", line: clean });
    },
    log(line) {
      if (!live()) return;
      const clean = cleanLine(line);
      if (!clean) return;
      appendLog(task, clean);
      touch();
      emit(reg, task.id, { type: "log", line: clean });
    },
    progress(completed, total) {
      if (!live() || !Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return;
      task.completed = Math.max(0, completed);
      task.total = total;
      touch();
      emit(reg, task.id, { type: "progress", completed: task.completed, total });
    },
    cancellable(on) {
      if (!live() || task.cancellable === on) return;
      // Only work that was started stoppable can be stoppable again: there is
      // an abort to fire only then.
      if (on && !reg.controllers.has(task.id)) return;
      task.cancellable = on;
      task.updatedAt = Date.now();
      persistNow(reg);
    },
    async rootStep(step, opts) {
      const taskStep = task.steps.find((s) => s.state === "running")?.id ?? null;
      const result = await followRootStep(step, {
        timeoutMs: opts.timeoutMs,
        label: opts.label,
        onStatus: (line) => ctx.status(line),
        onRunning: (run) => {
          if (!live()) return;
          task.unit = { ...run, taskStep, finishes: opts.finishes ?? null, bootId: currentBootId() };
          // At once: this is the one fact a server that restarts in the next
          // second needs, and a throttled write could still be pending.
          persistNow(reg);
        },
      });
      if (live() && task.unit?.step === step) {
        task.unit = null;
        persistSoon(reg);
      }
      return result;
    },
  };
  return ctx;
}

type EndState = Exclude<BackgroundTaskState, "running">;

function finishTask(
  reg: Registry,
  task: BackgroundTask,
  state: EndState,
  outcome: { result?: Record<string, unknown> | null; error?: string },
): void {
  if (task.state !== "running") return;
  // A record this registry no longer holds (a test's reset; never a running
  // task in production) is not the one any follower is listening to.
  if (reg.tasks.get(task.id) !== task) return;
  const end = Date.now();
  task.state = state;
  task.finishedAt = end;
  task.updatedAt = end;
  task.result = outcome.result ?? null;
  task.error = outcome.error ?? null;
  task.unit = null;
  for (const s of task.steps) {
    // A cancelled step is not a failed one: it stops where the owner stopped it.
    if (s.state === "running") s.state = state === "succeeded" ? "done" : state === "cancelled" ? "pending" : "failed";
    else if (s.state === "pending" && state === "succeeded") s.state = "done";
  }
  if (task.error) appendLog(task, task.error);
  else if (state === "cancelled") appendLog(task, CANCELLED_STATUS);
  persistNow(reg);
  emit(reg, task.id, { type: "end", task: viewBackgroundTask(task, end) });
  reg.listeners.delete(task.id);
  reg.controllers.delete(task.id);
}

export type CancelBackgroundTaskResult =
  | { ok: true; task: BackgroundTaskView }
  | { ok: false; code: "unknown_task" | "not_running" | "not_cancellable" };

/**
 * Ask a running task to stop. Its work sees `ctx.signal` abort, stops what it
 * started and rejects; the task then ends `cancelled`. Answering is immediate —
 * the record says `cancelRequested` until the work has really stopped, so a
 * card can say "Stopping…" rather than claim a stop that has not happened.
 */
export function cancelBackgroundTask(id: string): CancelBackgroundTaskResult {
  const reg = registry();
  const task = reg.tasks.get(id);
  if (!task) return { ok: false, code: "unknown_task" };
  if (task.state !== "running") return { ok: false, code: "not_running" };
  const controller = reg.controllers.get(id);
  if (!task.cancellable || !controller) return { ok: false, code: "not_cancellable" };
  if (!task.cancelRequested) {
    task.cancelRequested = true;
    task.status = CANCELLING_STATUS;
    appendLog(task, CANCELLING_STATUS);
    task.updatedAt = Date.now();
    persistNow(reg);
    emit(reg, task.id, { type: "status", line: CANCELLING_STATUS });
    controller.abort();
  }
  return { ok: true, task: viewBackgroundTask(task) };
}

/**
 * Follow one task's live events. Answers false (and calls nothing) when the
 * task is unknown or has already ended — the caller reads its record instead.
 */
export function subscribeBackgroundTask(
  id: string,
  listener: (event: BackgroundTaskEvent) => void,
): (() => void) | null {
  const reg = registry();
  const task = reg.tasks.get(id);
  if (!task || task.state !== "running") return null;
  let set = reg.listeners.get(id);
  if (!set) {
    set = new Set();
    reg.listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    reg.listeners.get(id)?.delete(listener);
  };
}

/** Hide an ENDED task's card. A running one cannot be dismissed, only collapsed. */
export function dismissBackgroundTask(id: string): BackgroundTaskView | null {
  const reg = registry();
  const task = reg.tasks.get(id);
  if (!task || task.state === "running") return null;
  task.dismissed = true;
  task.updatedAt = Date.now();
  persistNow(reg);
  return viewBackgroundTask(task);
}

const encoder = new TextEncoder();

/**
 * One task as the NDJSON stream every install route already answers with —
 * `{status}` lines, `{completed,total}` lines, and ONE closing `{success:true,
 * …result}` or `{error, …payload}` — so the panels that read those streams read
 * this one unchanged. The first line carries `taskId`, which is all a reader
 * needs to follow the same work again after it lost the stream.
 *
 * Cancelling the stream (the window closed) only unsubscribes. The work is not
 * the stream's to stop.
 */
export function backgroundTaskStream(id: string): ReadableStream<Uint8Array> {
  let unsubscribe: (() => void) | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: Record<string, unknown>) => {
        try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { /* reader gone */ }
      };
      const close = () => {
        unsubscribe?.();
        unsubscribe = null;
        try { controller.close(); } catch { /* already closed */ }
      };
      const ending = (task: BackgroundTaskView) => {
        if (task.state === "succeeded") send({ ...(task.result ?? {}), success: true, taskId: task.id });
        // Still a closing `{error}` to every reader that predates Cancel (it is
        // not a success), with the flag a current reader tells it apart by.
        else if (task.state === "cancelled") send({ status: CANCELLED_STATUS, error: CANCELLED_STATUS, code: "cancelled", cancelled: true, taskId: task.id });
        else send({ ...(task.result ?? {}), error: task.error ?? `${task.title} did not finish.`, taskId: task.id });
        close();
      };
      const current = getBackgroundTask(id);
      if (!current) {
        send({ error: "That task is not known on this box.", code: "unknown_task" });
        close();
        return;
      }
      send({
        taskId: current.id,
        kind: current.kind,
        status: current.status ?? current.title,
        ...(current.total ? { completed: current.completed ?? 0, total: current.total } : {}),
      });
      if (current.state !== "running") {
        ending(current);
        return;
      }
      unsubscribe = subscribeBackgroundTask(id, (event) => {
        if (event.type === "status") send({ status: event.line });
        else if (event.type === "progress") send({ completed: event.completed, total: event.total });
        else if (event.type === "end") ending(event.task);
      });
      if (!unsubscribe) {
        const after = getBackgroundTask(id);
        if (after) ending(after);
        else close();
      }
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}

export function backgroundTaskResponse(id: string, init: { status?: number } = {}): Response {
  return new Response(backgroundTaskStream(id), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

/** For tests: forget this process's registry so the next call reloads the file. */
export function resetBackgroundTasksForTests(): void {
  // Not `registry()`: a reset must not load the file — and adopt what it
  // finds — on its way to forgetting it.
  const reg = rawRegistry();
  if (reg.persistTimer) clearTimeout(reg.persistTimer);
  reg.persistTimer = null;
  reg.tasks.clear();
  reg.listeners.clear();
  reg.controllers.clear();
  reg.loaded = false;
  reg.runner = randomUUID();
}
