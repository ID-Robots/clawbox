"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  BACKGROUND_TASK_EVENT,
  SUCCESS_CARD_MS,
  dismissBackgroundTaskCard,
  fetchBackgroundTasks,
  formatEtaParts,
  visibleBackgroundTasks,
  type BackgroundTaskView,
} from "@/lib/background-task-client";

/**
 * The desktop's corner card for long work Settings started — an install, a
 * model download — which the server runs whether or not Settings is open
 * (src/lib/background-tasks.ts). One card per task in the top-right notice
 * column: its steps, a bar with the percentage and, once the rate is known,
 * the time left, and the live log behind a disclosure.
 *
 * Polled, like every other card in that column: every two seconds while
 * something runs, and slowly otherwise, so work started in another browser or
 * before this desktop loaded still shows up. A surface that starts a task fires
 * BACKGROUND_TASK_EVENT, which asks at once.
 */

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 20_000;

export function useBackgroundTasks(enabled: boolean): {
  tasks: BackgroundTaskView[];
  dismiss: (id: string) => void;
} {
  const [all, setAll] = useState<BackgroundTaskView[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const runningRef = useRef(false);

  const refresh = useCallback(async () => {
    const tasks = await fetchBackgroundTasks();
    if (tasks) {
      setAll(tasks);
      runningRef.current = tasks.some((t) => t.state === "running");
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // ONE loop. A kick that lands while a poll is in flight is remembered and
    // answered by one more poll right after it — starting a second `tick` then
    // left two loops running for good, one more per such kick.
    let polling = false;
    let kicked = false;
    const tick = async () => {
      if (polling) {
        kicked = true;
        return;
      }
      polling = true;
      try {
        await refresh();
      } finally {
        polling = false;
      }
      if (cancelled) return;
      if (kicked) {
        kicked = false;
        void tick();
        return;
      }
      timer = setTimeout(tick, runningRef.current ? FAST_POLL_MS : SLOW_POLL_MS);
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
  }, [enabled, refresh]);

  const dismiss = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
    void dismissBackgroundTaskCard(id);
  }, []);

  // A success says so for a while and then steps aside on its own; a failure
  // stays until it has been read.
  useEffect(() => {
    const timers = all
      .filter((t) => t.state === "succeeded" && !t.dismissed && !hidden.has(t.id))
      .map((t) => {
        const left = Math.max(0, (t.finishedAt ?? now) + SUCCESS_CARD_MS - Date.now());
        return setTimeout(() => dismiss(t.id), left);
      });
    return () => timers.forEach(clearTimeout);
  }, [all, hidden, now, dismiss]);

  const tasks = enabled ? visibleBackgroundTasks(all, now).filter((t) => !hidden.has(t.id)) : [];
  return { tasks, dismiss };
}

function StepIcon({ state }: { state: BackgroundTaskView["steps"][number]["state"] }) {
  const icon = state === "done" ? "check_circle" : state === "failed" ? "cancel" : state === "running" ? "progress_activity" : "radio_button_unchecked";
  const tone = state === "done" ? "text-emerald-400" : state === "failed" ? "text-red-400" : state === "running" ? "text-orange-300 animate-spin" : "text-white/30";
  return <span className={`material-symbols-rounded shrink-0 ${tone}`} style={{ fontSize: 14 }} aria-hidden="true">{icon}</span>;
}

const BackgroundTaskCard = memo(function BackgroundTaskCard({
  task,
  onDismiss,
}: {
  task: BackgroundTaskView;
  onDismiss: (id: string) => void;
}) {
  const { t } = useT();
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const running = task.state === "running";
  const failed = task.state === "failed" || task.state === "interrupted";
  const rawPercent = task.percent === null ? null : Math.max(0, Math.min(100, task.percent));
  // A figure only where something was measured: bytes in the running step, or
  // steps already behind it. A step that reports lines but no bytes (a build,
  // a pip install) is most of every install, and "0%" over it read as stuck —
  // the bar goes indeterminate there instead.
  const measured = task.total !== null && task.total > 0;
  const percent = rawPercent !== null && (measured || rawPercent > 0) ? rawPercent : null;
  const eta = formatEtaParts(task.etaSeconds);
  const current = task.steps.find((s) => s.state === "running") ?? null;
  const stepIndex = current ? task.steps.indexOf(current) + 1 : null;

  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logOpen, task.logCount]);

  const etaText = eta === null
    ? null
    : eta.hours > 0
      ? t("backgroundTasks.etaHours", { hours: eta.hours, minutes: String(eta.minutes).padStart(2, "0") })
      : eta.minutes <= 1
        ? t("backgroundTasks.etaUnderMinute")
        : t("backgroundTasks.etaMinutes", { minutes: eta.minutes });

  const headline = running
    ? task.status ?? current?.label ?? task.title
    : failed
      ? task.error ?? t("backgroundTasks.failed")
      : (typeof task.result?.status === "string" ? task.result.status : null) ?? t("backgroundTasks.done");

  return (
    <div
      data-testid="background-task-card"
      data-task-kind={task.kind}
      data-task-state={task.state}
      className="pointer-events-auto rounded-xl bg-[var(--bg-elevated)] border border-white/10 shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3 px-4 pt-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 border ${failed ? "bg-red-500/15 border-red-500/30" : running ? "bg-orange-500/15 border-orange-500/30" : "bg-emerald-500/15 border-emerald-500/30"}`}>
          <span className={`material-symbols-rounded ${failed ? "text-red-400" : running ? "text-orange-400" : "text-emerald-400"}`} style={{ fontSize: 20 }} aria-hidden="true">
            {failed ? "error" : running ? "downloading" : "task_alt"}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white truncate" title={task.title}>{task.title}</div>
          <div className={`text-xs mt-0.5 break-words ${failed ? "text-red-300" : "text-white/60"}`} data-testid="background-task-headline">
            {headline}
          </div>
        </div>
        {!running && (
          <button
            type="button"
            onClick={() => onDismiss(task.id)}
            className="w-7 h-7 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
            aria-label={t("backgroundTasks.dismiss")}
            data-testid="background-task-dismiss"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        )}
      </div>

      {running && (
        <div className="px-4 pt-2">
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
          <div className="flex items-center justify-between mt-1 text-[11px] text-white/50 tabular-nums">
            <span data-testid="background-task-percent">
              {stepIndex !== null && task.steps.length > 1 ? `${t("backgroundTasks.stepOf", { current: stepIndex, total: task.steps.length })} · ` : ""}
              {percent === null ? t("backgroundTasks.working") : `${Math.floor(percent)}%`}
            </span>
            {etaText && <span data-testid="background-task-eta">{etaText}</span>}
          </div>
        </div>
      )}

      {task.steps.length > 1 && (
        <ol className="px-4 pt-2 space-y-0.5" data-testid="background-task-steps">
          {task.steps.map((step) => (
            <li key={step.id} className={`flex items-center gap-1.5 text-[11px] ${step.state === "running" ? "text-white" : step.state === "pending" ? "text-white/40" : "text-white/60"}`}>
              <StepIcon state={step.state} />
              <span className="truncate">{step.label}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="px-4 pt-2 pb-3">
        <button
          type="button"
          onClick={() => setLogOpen((open) => !open)}
          className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white bg-transparent border-none cursor-pointer p-0"
          aria-expanded={logOpen}
          data-testid="background-task-log-toggle"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{logOpen ? "expand_less" : "expand_more"}</span>
          {logOpen ? t("backgroundTasks.hideLog") : t("backgroundTasks.showLog")}
        </button>
        {logOpen && (
          <pre
            ref={logRef}
            data-testid="background-task-log"
            className="mt-1.5 max-h-40 overflow-auto rounded-md bg-black/40 border border-white/5 p-2 text-[10px] leading-snug text-white/70 font-mono whitespace-pre-wrap break-words select-text"
          >
            {task.log.length > 0 ? task.log.join("\n") : t("backgroundTasks.noLog")}
          </pre>
        )}
      </div>
    </div>
  );
});

export default function BackgroundTaskCards({
  tasks,
  onDismiss,
}: {
  tasks: BackgroundTaskView[];
  onDismiss: (id: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <>
      {tasks.map((task) => (
        <BackgroundTaskCard key={task.id} task={task} onDismiss={onDismiss} />
      ))}
    </>
  );
}
