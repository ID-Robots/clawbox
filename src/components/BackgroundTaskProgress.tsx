"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  BACKGROUND_TASK_EVENT,
  cancelBackgroundTask,
  canCancelBackgroundTask,
  fetchBackgroundTask,
  formatEtaParts,
  notifyBackgroundTaskStarted,
  type BackgroundTaskView,
} from "@/lib/background-task-client";

/**
 * One background task's progress, drawn the same way wherever it is drawn:
 * the desktop's corner card (BackgroundTaskCards) and, inline, the Settings
 * row or card that started it. Steps with their states, a bar with the
 * percentage, the time left once there is a rate, the live log behind a
 * disclosure, and — for work that can stop safely — Cancel.
 *
 * Settings and the card read the same record (src/lib/background-tasks.ts), so
 * what one says the other says; closing Settings loses neither the work nor
 * this view of it.
 */

type Translate = ReturnType<typeof useT>["t"];

function StepIcon({ state }: { state: BackgroundTaskView["steps"][number]["state"] }) {
  const icon = state === "done" ? "check_circle" : state === "failed" ? "cancel" : state === "running" ? "progress_activity" : "radio_button_unchecked";
  const tone = state === "done" ? "text-emerald-400" : state === "failed" ? "text-red-400" : state === "running" ? "text-orange-300 animate-spin" : "text-white/30";
  return <span className={`material-symbols-rounded shrink-0 ${tone}`} style={{ fontSize: 14 }} aria-hidden="true">{icon}</span>;
}

function etaText(t: Translate, seconds: number | null): string | null {
  const eta = formatEtaParts(seconds);
  if (eta === null) return null;
  if (eta.hours > 0) return t("backgroundTasks.etaHours", { hours: eta.hours, minutes: String(eta.minutes).padStart(2, "0") });
  if (eta.minutes <= 1) return t("backgroundTasks.etaUnderMinute");
  return t("backgroundTasks.etaMinutes", { minutes: eta.minutes });
}

/**
 * The figure the bar may show. Only where something was measured: bytes in
 * the running step, or steps already behind it. A step that reports lines but
 * no bytes (a build, a pip install) is most of every install, and "0%" over it
 * read as stuck — the bar goes indeterminate there instead.
 */
export function shownPercent(task: Pick<BackgroundTaskView, "percent" | "total">): number | null {
  const raw = task.percent === null ? null : Math.max(0, Math.min(100, task.percent));
  const measured = task.total !== null && task.total > 0;
  return raw !== null && (measured || raw > 0) ? raw : null;
}

/** The sentence a task's ending (or its current work) is summed up in. */
export function taskHeadline(t: Translate, task: BackgroundTaskView): string {
  if (task.state === "running") return task.status ?? task.steps.find((s) => s.state === "running")?.label ?? task.title;
  if (task.state === "failed" || task.state === "interrupted") return task.error ?? t("backgroundTasks.failed");
  if (task.state === "cancelled") return t("backgroundTasks.cancelled");
  return (typeof task.result?.status === "string" ? task.result.status : null) ?? t("backgroundTasks.done");
}

/** Ask the box to stop `task`, and have every view of it ask again at once. */
export function useCancelBackgroundTask(): { cancel: (id: string) => Promise<void>; asked: ReadonlySet<string> } {
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const cancel = useCallback(async (id: string) => {
    setAsked((prev) => new Set(prev).add(id));
    const ok = await cancelBackgroundTask(id);
    // Refused (it ended meanwhile, or the box did not answer): the button
    // comes back, and the record says what really happened.
    if (!ok) {
      setAsked((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
    notifyBackgroundTaskStarted(id);
  }, []);
  return { cancel, asked };
}

export function BackgroundTaskProgress({
  task,
  onCancel,
  cancelAsked = false,
  testId = "background-task",
}: {
  task: BackgroundTaskView;
  /** Offered only while the task can still be stopped. */
  onCancel?: (id: string) => void;
  /** This browser already asked; the box has not said so yet. */
  cancelAsked?: boolean;
  /** Prefix of every test id, so two views of one task on a page stay apart. */
  testId?: string;
}) {
  const { t } = useT();
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const running = task.state === "running";
  const percent = shownPercent(task);
  const eta = etaText(t, task.etaSeconds);
  const current = task.steps.find((s) => s.state === "running") ?? null;
  const stepIndex = current ? task.steps.indexOf(current) + 1 : null;
  const stopping = running && (task.cancelRequested === true || cancelAsked);
  const cancellable = onCancel !== undefined && canCancelBackgroundTask(task) && !cancelAsked;

  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logOpen, task.logCount]);

  return (
    <div data-testid={`${testId}-progress`}>
      {running && (
        <div className="pt-2">
          <div
            className="h-1.5 rounded-full bg-white/10 overflow-hidden"
            role="progressbar"
            aria-label={task.title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <div
              className={`h-full rounded-full bg-[var(--coral-bright)] ${percent === null ? "w-1/3 animate-pulse" : "transition-all duration-500"}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-white/50 tabular-nums">
            <span data-testid={`${testId}-percent`}>
              {stepIndex !== null && task.steps.length > 1 ? `${t("backgroundTasks.stepOf", { current: stepIndex, total: task.steps.length })} · ` : ""}
              {stopping ? t("backgroundTasks.cancelling") : percent === null ? t("backgroundTasks.working") : `${Math.floor(percent)}%`}
            </span>
            {eta && !stopping && <span data-testid={`${testId}-eta`}>{eta}</span>}
          </div>
        </div>
      )}

      {task.steps.length > 1 && (
        <ol className="pt-2 space-y-0.5" data-testid={`${testId}-steps`}>
          {task.steps.map((step) => (
            <li key={step.id} className={`flex items-center gap-1.5 text-[11px] ${step.state === "running" ? "text-white" : step.state === "pending" ? "text-white/40" : "text-white/60"}`}>
              <StepIcon state={step.state} />
              <span className="truncate">{step.label}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="pt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setLogOpen((open) => !open)}
          className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white bg-transparent border-none cursor-pointer p-0"
          aria-expanded={logOpen}
          data-testid={`${testId}-log-toggle`}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{logOpen ? "expand_less" : "expand_more"}</span>
          {logOpen ? t("backgroundTasks.hideLog") : t("backgroundTasks.showLog")}
        </button>
        {cancellable && (
          <button
            type="button"
            onClick={() => onCancel?.(task.id)}
            className="ml-auto text-[11px] px-2 py-0.5 rounded-md border border-white/15 text-white/70 hover:text-white hover:bg-white/10 bg-transparent cursor-pointer"
            data-testid={`${testId}-cancel`}
          >
            {t("backgroundTasks.cancel")}
          </button>
        )}
      </div>
      {logOpen && (
        <pre
          ref={logRef}
          data-testid={`${testId}-log`}
          className="mt-1.5 max-h-40 overflow-auto rounded-md bg-black/40 border border-white/5 p-2 text-[10px] leading-snug text-white/70 font-mono whitespace-pre-wrap break-words select-text"
        >
          {task.log.length > 0 ? task.log.join("\n") : t("backgroundTasks.noLog")}
        </pre>
      )}
    </div>
  );
}

const INLINE_POLL_MS = 1_500;

/**
 * One task's record, read again every 1.5 s while it runs and once more when
 * a surface says something changed (a Cancel, a re-attach). Stops at the
 * ending. Null until the first answer, and for an id the box does not know.
 */
export function useBackgroundTask(taskId: string | null): BackgroundTaskView | null {
  // Kept with the id it answers for, so a view handed another task never draws
  // the last one's record while the first read of the new one is out.
  const [read, setRead] = useState<{ id: string; task: BackgroundTaskView } | null>(null);
  const setTask = useCallback((next: BackgroundTaskView) => setRead({ id: next.id, task: next }), []);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let kicked = false;
    const tick = async () => {
      if (polling) {
        kicked = true;
        return;
      }
      polling = true;
      let next: BackgroundTaskView | null = null;
      try {
        next = await fetchBackgroundTask(taskId);
      } finally {
        polling = false;
      }
      if (cancelled) return;
      if (next) setTask(next);
      if (kicked) {
        kicked = false;
        void tick();
        return;
      }
      // Ended: nothing more will change. A failed read keeps trying.
      if (next && next.state !== "running") return;
      timer = setTimeout(tick, INLINE_POLL_MS);
    };
    const kick = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      void tick();
    };
    void tick();
    window.addEventListener(BACKGROUND_TASK_EVENT, kick);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener(BACKGROUND_TASK_EVENT, kick);
    };
  }, [taskId, setTask]);

  return read && read.id === taskId ? read.task : null;
}

/**
 * Design 3: the task inline in Settings, under the control that started it —
 * the same steps, percentage, time left and log the corner card draws, while
 * it runs. Its ending is the row's own business (its verdict line), so this
 * draws nothing once the task has ended.
 */
export function BackgroundTaskInline({
  taskId,
  testId = "settings-task",
  showHeadline = true,
  showHint = true,
}: {
  taskId: string | null;
  testId?: string;
  /** Off where the row already prints the live line itself. */
  showHeadline?: boolean;
  /** Off where the row already says it runs in the background. */
  showHint?: boolean;
}) {
  const { t } = useT();
  const task = useBackgroundTask(taskId);
  const { cancel, asked } = useCancelBackgroundTask();
  if (!task || task.state !== "running") return null;
  return (
    <div className="mt-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 pt-2 pb-2" data-testid={testId}>
      {showHeadline && (
        <p role="status" aria-live="polite" className="text-xs text-[var(--text-secondary)] break-words" data-testid={`${testId}-headline`}>
          {taskHeadline(t, task)}
        </p>
      )}
      <BackgroundTaskProgress task={task} onCancel={(id) => void cancel(id)} cancelAsked={asked.has(task.id)} testId={testId} />
      {showHint && <p className="mt-1.5 text-[11px] text-white/40">{t("backgroundTasks.closeHint")}</p>}
    </div>
  );
}
