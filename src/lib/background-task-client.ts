/**
 * The browser's half of src/lib/background-tasks.ts: where a surface asks
 * about long work the server is running, and how it follows it again.
 *
 * Client-safe: fetch and window events only. The types are imported as types,
 * so nothing of the server module reaches the bundle.
 */
import type { BackgroundTaskView } from "@/lib/background-tasks";

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
 * is dismissed — a success only while it is fresh, a failure or an interruption
 * until the owner has seen it.
 */
export function visibleBackgroundTasks(tasks: readonly BackgroundTaskView[], now: number): BackgroundTaskView[] {
  return tasks.filter((task) => {
    if (task.state === "running") return true;
    if (task.dismissed) return false;
    if (task.state === "succeeded") return now - (task.finishedAt ?? task.updatedAt) < SUCCESS_STALE_MS;
    return true;
  });
}
