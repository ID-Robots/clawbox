"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  BACKGROUND_TASK_EVENT,
  SUCCESS_CARD_MS,
  dismissBackgroundTaskCard,
  endsQuietly,
  fetchBackgroundTasks,
  visibleBackgroundTasks,
  type BackgroundTaskView,
} from "@/lib/background-task-client";
import { BackgroundTaskProgress, taskHeadline, useCancelBackgroundTask } from "@/components/BackgroundTaskProgress";

/**
 * The desktop's corner card for long work Settings started — an install, a
 * model download — which the server runs whether or not Settings is open
 * (src/lib/background-tasks.ts). One card per task in the top-right notice
 * column: its steps, a bar with the percentage and, once the rate is known,
 * the time left, the live log behind a disclosure, and Cancel for work that
 * can stop safely (BackgroundTaskProgress, which Settings draws inline too).
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

  // A success (or the owner's own Cancel) says so for a while and then steps
  // aside on its own; a failure stays until it has been read.
  useEffect(() => {
    const timers = all
      .filter((t) => endsQuietly(t) && !t.dismissed && !hidden.has(t.id))
      .map((t) => {
        const left = Math.max(0, (t.finishedAt ?? now) + SUCCESS_CARD_MS - Date.now());
        return setTimeout(() => dismiss(t.id), left);
      });
    return () => timers.forEach(clearTimeout);
  }, [all, hidden, now, dismiss]);

  const tasks = enabled ? visibleBackgroundTasks(all, now).filter((t) => !hidden.has(t.id)) : [];
  return { tasks, dismiss };
}

const BackgroundTaskCard = memo(function BackgroundTaskCard({
  task,
  onDismiss,
  onCancel,
  cancelAsked,
}: {
  task: BackgroundTaskView;
  onDismiss: (id: string) => void;
  onCancel: (id: string) => void;
  cancelAsked: boolean;
}) {
  const { t } = useT();
  const running = task.state === "running";
  const failed = task.state === "failed" || task.state === "interrupted";
  const cancelled = task.state === "cancelled";
  const headline = taskHeadline(t, task);
  const tone = failed
    ? { ring: "bg-red-500/15 border-red-500/30", icon: "text-red-400", name: "error" }
    : running
      ? { ring: "bg-orange-500/15 border-orange-500/30", icon: "text-orange-400", name: "downloading" }
      : cancelled
        ? { ring: "bg-white/10 border-white/20", icon: "text-white/60", name: "block" }
        : { ring: "bg-emerald-500/15 border-emerald-500/30", icon: "text-emerald-400", name: "task_alt" };

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
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 border ${tone.ring}`}>
          <span className={`material-symbols-rounded ${tone.icon}`} style={{ fontSize: 20 }} aria-hidden="true">
            {tone.name}
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

      <div className="px-4 pb-3">
        <BackgroundTaskProgress task={task} onCancel={onCancel} cancelAsked={cancelAsked} />
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
  const { cancel, asked } = useCancelBackgroundTask();
  const onCancel = useCallback((id: string) => { void cancel(id); }, [cancel]);
  if (tasks.length === 0) return null;
  return (
    <>
      {tasks.map((task) => (
        <BackgroundTaskCard key={task.id} task={task} onDismiss={onDismiss} onCancel={onCancel} cancelAsked={asked.has(task.id)} />
      ))}
    </>
  );
}
