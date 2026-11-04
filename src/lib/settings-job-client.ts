/**
 * The browser's half of src/lib/settings-jobs.ts: Settings actions that are
 * not instant, run by the box as jobs (TASK-2148) — how a surface starts one
 * and waits for it, and how it reads the ones the box is running.
 *
 * Client-safe: fetch and window events only; the server module's types come
 * in as types.
 */
import {
  notifyBackgroundTaskStarted,
  waitForBackgroundTaskEnd,
  type BackgroundTaskView,
} from "@/lib/background-task-client";
import { SETTINGS_JOB_KINDS } from "@/lib/background-task-kinds";

/** One settings job, as a Settings surface needs it. */
export interface SettingsJob {
  id: string;
  kind: string;
  group: string;
  /** What it is about: a provider's row id, a channel. */
  subject: string;
  /** Which way: `sign-in`, `configure`, `disconnect`, … */
  action: string;
  /** The subject's name, as the box said it. */
  label: string;
  title: string;
  state: BackgroundTaskView["state"];
  /** The running step's id; null once ended. */
  step: string | null;
  /** The latest headline. */
  status: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  startedAt: number;
  finishedAt: number | null;
}

/** Whether a background task is a settings job (the corner card turns a ring for it). */
export function isSettingsJob(task: Pick<BackgroundTaskView, "kind">): boolean {
  return SETTINGS_JOB_KINDS.includes(task.kind);
}

/** The settings job behind a background task, or null for any other task. */
export function settingsJobOf(task: BackgroundTaskView): SettingsJob | null {
  if (!isSettingsJob(task)) return null;
  const meta = task.meta ?? {};
  const subject = typeof meta.subject === "string" && meta.subject ? meta.subject : null;
  const action = typeof meta.action === "string" && meta.action ? meta.action : null;
  if (!subject || !action) return null;
  return {
    id: task.id,
    kind: task.kind,
    group: task.group,
    subject,
    action,
    label: typeof meta.label === "string" && meta.label ? meta.label : subject,
    title: task.title,
    state: task.state,
    step: task.state === "running" ? task.steps.find((s) => s.state === "running")?.id ?? null : null,
    status: task.status,
    error: task.error,
    result: task.result,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

/** Said when the box no longer knows the job a surface was following. */
const JOB_LOST = "The box no longer knows this change. Check its state in Settings, and try again if it did not happen.";

/**
 * `fetch` for a Settings action the box runs as a job: asks the route for one
 * (`background: true` in the JSON body, `?background=1` for a body-less
 * request), follows it to its end, and answers the Response the route would
 * have answered in-request — the action's own status and JSON, which the
 * caller already knows how to read. A route that answers in-request anyway
 * (a refusal said at once, an older server) is answered as it is.
 *
 * Aborting `init.signal` stops the following — the job goes on on the box —
 * and rejects with an AbortError, as `fetch` does.
 */
export async function settingsJobFetch(
  url: string,
  init: RequestInit = {},
  opts: { onStarted?: (taskId: string) => void; onUpdate?: (task: BackgroundTaskView) => void } = {},
): Promise<Response> {
  let target = url;
  let body = init.body;
  if (typeof body === "string" && body.trim().startsWith("{")) {
    body = JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), background: true });
  } else if (body === undefined || body === null) {
    target = `${url}${url.includes("?") ? "&" : "?"}background=1`;
  }
  const res = await fetch(target, { ...init, body });
  if (res.status !== 202) return res;
  const started = (await res.clone().json().catch(() => ({}))) as { taskId?: unknown };
  if (typeof started.taskId !== "string" || !started.taskId) return res;
  const taskId = started.taskId;
  opts.onStarted?.(taskId);
  // The corner card asks at once rather than at its next poll.
  notifyBackgroundTaskStarted(taskId);
  const ended = await waitForBackgroundTaskEnd(taskId, { signal: init.signal ?? undefined, onUpdate: opts.onUpdate });
  if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const json = (payload: unknown, status: number) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  if (!ended) return json({ error: JOB_LOST, taskId }, 500);
  const result = ended.result ?? {};
  const status = typeof result.httpStatus === "number" && result.httpStatus >= 200 && result.httpStatus <= 599
    ? result.httpStatus
    : ended.state === "succeeded" ? 200 : 500;
  if (ended.state === "succeeded") return json({ ...result, taskId }, status);
  const error = typeof result.error === "string" && result.error ? result.error : ended.error ?? JOB_LOST;
  // A failure the route answered 2xx (`success: false`) keeps its status; one
  // with none is a failure all the same.
  return json({ ...result, error, taskId }, status >= 400 || result.success === false ? status : 500);
}
