/**
 * The browser's half of src/lib/background-tasks.ts: where a surface asks
 * about long work the server is running, and how it follows it again.
 *
 * Client-safe: fetch and window events only. The types are imported as types,
 * so nothing of the server module reaches the bundle.
 */
import type { BackgroundTaskView } from "@/lib/background-tasks";
import { readInstallStream, type InstallOutcome, type InstallProgress } from "@/lib/install-stream";

export type { BackgroundTaskView } from "@/lib/background-tasks";

export const BACKGROUND_TASKS_URL = "/setup-api/background-jobs/tasks";

/**
 * Fired when a surface has just started (or re-attached to) a task, so the
 * desktop's corner card asks at once instead of at its next slow poll.
 */
export const BACKGROUND_TASK_EVENT = "clawbox:background-task";

export function notifyBackgroundTaskStarted(taskId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BACKGROUND_TASK_EVENT, { detail: { taskId: taskId ?? null } }));
}

export async function fetchBackgroundTasks(filter: { kind?: string } = {}): Promise<BackgroundTaskView[] | null> {
  const query = filter.kind ? `?kind=${encodeURIComponent(filter.kind)}` : "";
  try {
    const res = await fetch(`${BACKGROUND_TASKS_URL}${query}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { tasks?: unknown };
    return Array.isArray(body.tasks) ? (body.tasks as BackgroundTaskView[]) : null;
  } catch {
    return null;
  }
}

/** The running task of any of these kinds, or null — how a reopened panel finds its work. */
export async function findRunningBackgroundTask(kinds: readonly string[]): Promise<BackgroundTaskView | null> {
  const tasks = await fetchBackgroundTasks();
  return tasks?.find((task) => task.state === "running" && kinds.includes(task.kind)) ?? null;
}

/**
 * Follow a task again, as the NDJSON stream its starting route answered with —
 * hand the response to `readInstallStream` like the original one.
 */
export function followBackgroundTask(id: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${BACKGROUND_TASKS_URL}/follow?id=${encodeURIComponent(id)}`, { cache: "no-store", signal });
}

/**
 * How long a reader keeps following a task whose stream was cut short: the
 * web server restarting mid-install (a Jetson's takes a minute or two, and it
 * is exactly when a root step's task is adopted), or a dropped tunnel.
 */
const REFOLLOW_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000];

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Read an install route's stream to its verdict — following the TASK again
 * when the stream is cut short after naming it, instead of calling an install
 * that is still running (or that a restarted server adopted) a failure. A
 * stream that never named a task is read as before. Gives up — the cut-short
 * outcome — once the box no longer knows the task, or after about two and a
 * half minutes without an answer.
 */
export async function readTaskStream(
  res: Response,
  onProgress: (progress: InstallProgress) => void,
  onTask?: (taskId: string) => void,
  signal?: AbortSignal,
): Promise<InstallOutcome> {
  let taskId: string | null = null;
  const named = (id: string) => {
    taskId = id;
    onTask?.(id);
  };
  let current = res;
  let tries = 0;
  for (;;) {
    let outcome: InstallOutcome;
    try {
      outcome = await readInstallStream(current, onProgress, named);
    } catch (err) {
      if (signal?.aborted || taskId === null) throw err;
      outcome = { ok: false, lost: true };
    }
    if (!outcome.lost || taskId === null) return outcome;
    let next: Response | null = null;
    while (next === null) {
      if (signal?.aborted || tries >= REFOLLOW_DELAYS_MS.length) return outcome;
      await pause(REFOLLOW_DELAYS_MS[tries], signal);
      tries += 1;
      if (signal?.aborted) return outcome;
      try {
        const answer = await followBackgroundTask(taskId, signal);
        if (answer.ok) next = answer;
        // The box answered, and does not know it: nothing left to follow.
        else if (answer.status === 404) return outcome;
      } catch {
        // Not back yet.
      }
    }
    current = next;
  }
}

export async function dismissBackgroundTaskCard(id: string): Promise<void> {
  try {
    await fetch(BACKGROUND_TASKS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "dismiss" }),
    });
  } catch {
    // The card is already gone locally; the next poll shows it again if the
    // server did not hear, which is the honest outcome.
  }
}

/**
 * Ask the box to stop a running task. True when it took the request — the
 * work then stops and the task ends `cancelled`; the caller keeps reading the
 * task for that ending rather than assuming it.
 */
export async function cancelBackgroundTask(id: string): Promise<boolean> {
  try {
    const res = await fetch(BACKGROUND_TASKS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "cancel" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** One task with its whole log ring, or null when the box does not know it (or did not answer). */
export async function fetchBackgroundTask(id: string): Promise<BackgroundTaskView | null> {
  try {
    const res = await fetch(`${BACKGROUND_TASKS_URL}?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { task?: unknown };
    return body.task && typeof body.task === "object" ? (body.task as BackgroundTaskView) : null;
  } catch {
    return null;
  }
}

/** Whether the owner can still stop it: running, stoppable, and not already stopping. */
export function canCancelBackgroundTask(task: Pick<BackgroundTaskView, "state" | "cancellable" | "cancelRequested">): boolean {
  return task.state === "running" && task.cancellable === true && task.cancelRequested !== true;
}

/** Seconds as the card says them: "<1 min", "12 min", "1 h 05 min". Null for no figure. */
export function formatEtaParts(seconds: number | null): { hours: number; minutes: number } | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.ceil(seconds / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/** Finished successes stay this long before the card hides itself. */
export const SUCCESS_CARD_MS = 30_000;
/** A success older than this is not news on a desktop that just loaded. */
export const SUCCESS_STALE_MS = 10 * 60 * 1000;

/**
 * Which tasks the corner card draws: every running one; an ended one until it
 * is dismissed — a success (or a stop the owner asked for) only while it is
 * fresh, a failure or an interruption until the owner has seen it.
 */
export function visibleBackgroundTasks(tasks: readonly BackgroundTaskView[], now: number): BackgroundTaskView[] {
  return tasks.filter((task) => {
    if (task.state === "running") return true;
    if (task.dismissed) return false;
    if (endsQuietly(task)) return now - (task.finishedAt ?? task.updatedAt) < SUCCESS_STALE_MS;
    return true;
  });
}

/** An ending that is not news to keep on screen: a success, or the owner's own Cancel. */
export function endsQuietly(task: Pick<BackgroundTaskView, "state">): boolean {
  return task.state === "succeeded" || task.state === "cancelled";
}
