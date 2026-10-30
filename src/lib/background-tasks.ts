import { randomUUID } from "crypto";
import fs from "fs";
import { resolveConfigRoot } from "./config-store";
import path from "./runtime-path";
import { processStore } from "./process-store";

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
 * orphan, and is closed as `interrupted` with a sentence that says why, rather
 * than drawn as a bar that never moves. Work that runs under systemd (a root
 * step) may well have finished on its own — the caller's own status read says
 * so; this record only says what this server saw.
 *
 * One process, many module copies: the registry lives in {@link processStore},
 * keyed by the file it persists, for the reason that module documents.
 */

export type BackgroundTaskState = "running" | "succeeded" | "failed" | "interrupted";
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
  /** Close the running step and start `id`. A headline may come with it. */
  step(id: string, status?: string): void;
  /** A new headline; it also goes to the log. */
  status(line: string): void;
  /** A log line only (build output, a fetcher's chatter). */
  log(line: string): void;
  /** Byte or item progress inside the current step. */
  progress(completed: number, total: number): void;
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
  persistTimer: ReturnType<typeof setTimeout> | null;
}

function registry(): Registry {
  const file = tasksFile();
  const reg = processStore<Registry>(`background-tasks:${file}`, () => ({
    file,
    runner: randomUUID(),
    loaded: false,
    tasks: new Map(),
    listeners: new Map(),
    persistTimer: null,
  }));
  if (!reg.loaded) load(reg);
  return reg;
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
  for (const entry of list) {
    if (!isTask(entry)) continue;
    const task: BackgroundTask = {
      ...entry,
      group: typeof entry.group === "string" ? entry.group : entry.kind,
      meta: entry.meta && typeof entry.meta === "object" ? entry.meta : null,
      dismissed: entry.dismissed === true,
      logCount: typeof entry.logCount === "number" ? entry.logCount : entry.log.length,
    };
    if (task.state === "running" && task.runner !== reg.runner) {
      task.state = "interrupted";
      task.error = INTERRUPTED_MESSAGE;
      task.finishedAt = now;
      task.updatedAt = now;
      task.steps = task.steps.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s));
      orphaned = true;
    }
    reg.tasks.set(task.id, task);
  }
  if (orphaned) persistNow(reg);
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
  };
  if (task.status) appendLog(task, task.status);
  reg.tasks.set(task.id, task);
  persistNow(reg);

  const live = () => task.state === "running";
  const touch = () => {
    task.updatedAt = Date.now();
    persistSoon(reg);
  };
  const ctx: BackgroundTaskContext = {
    id: task.id,
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
  };

  const finish = (state: "succeeded" | "failed", outcome: { result?: Record<string, unknown> | null; error?: string }) => {
    if (!live()) return;
    const end = Date.now();
    task.state = state;
    task.finishedAt = end;
    task.updatedAt = end;
    task.result = outcome.result ?? null;
    task.error = outcome.error ?? null;
    for (const s of task.steps) {
      if (s.state === "running") s.state = state === "succeeded" ? "done" : "failed";
      else if (s.state === "pending" && state === "succeeded") s.state = "done";
    }
    if (state === "failed" && task.error) appendLog(task, task.error);
    persistNow(reg);
    emit(reg, task.id, { type: "end", task: viewBackgroundTask(task, end) });
    reg.listeners.delete(task.id);
  };

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
      (result) => finish("succeeded", { result: result ?? null }),
      (err: unknown) => {
        const payload = err instanceof BackgroundTaskFailure ? err.payload : null;
        finish("failed", {
          result: payload,
          error: err instanceof Error && err.message ? err.message : `${task.title} did not finish.`,
        });
      },
    );
  });

  return { started: true, task: viewBackgroundTask(task, now) };
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
  const reg = registry();
  if (reg.persistTimer) clearTimeout(reg.persistTimer);
  reg.persistTimer = null;
  reg.tasks.clear();
  reg.listeners.clear();
  reg.loaded = false;
  reg.runner = randomUUID();
}
