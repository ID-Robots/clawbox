"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BACKGROUND_TASK_EVENT, fetchBackgroundTasks } from "@/lib/background-task-client";
import { settingsJobOf, type SettingsJob } from "@/lib/settings-job-client";

/**
 * The Settings actions of one group the box runs as jobs (TASK-2148,
 * src/lib/settings-jobs.ts), as a Settings section draws them: read from the
 * box when the section mounts — so a Settings reopened half-way, or opened in
 * another tab or on another device, shows the action in progress rather than
 * the state before it — and again every 1.5 s while one runs, slowly
 * otherwise, and at once when a surface says it started one
 * (BACKGROUND_TASK_EVENT).
 *
 * `onEnded` hears every job that has ended since the last read — one this hook
 * saw running, or one that ran and ended between two reads (a quick change in
 * another tab) — so the section re-reads what the job changed while it is
 * open: the ending is the box's, not the window's. The first read is the
 * state the section was read in, and is no news.
 */

const FAST_POLL_MS = 1_500;
const SLOW_POLL_MS = 15_000;

export function useSettingsJobs(
  group: string,
  options: { enabled?: boolean; onEnded?: (jobs: SettingsJob[]) => void } = {},
): {
  /** Every job of the group the box keeps, newest first. */
  jobs: SettingsJob[];
  /** The one running now, if any (one per group at a time). */
  running: SettingsJob | null;
  /** The box has answered at least once. */
  loaded: boolean;
  refresh: () => void;
} {
  const enabled = options.enabled ?? true;
  const [jobs, setJobs] = useState<SettingsJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** What the last read held: the ids running, and the ids ended. Null before the first. */
  const seen = useRef<{ running: Set<string>; ended: Set<string> } | null>(null);
  const kickRef = useRef<() => void>(() => undefined);
  const onEndedRef = useRef(options.onEnded);
  useEffect(() => { onEndedRef.current = options.onEnded; }, [options.onEnded]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One loop: a kick during a poll is answered by one more poll after it
    // (the corner card's rule, BackgroundTaskCards).
    let polling = false;
    let kicked = false;
    let anyRunning = false;
    const tick = async () => {
      if (polling) {
        kicked = true;
        return;
      }
      polling = true;
      let list: Awaited<ReturnType<typeof fetchBackgroundTasks>> = null;
      try {
        list = await fetchBackgroundTasks({ group });
      } finally {
        polling = false;
      }
      if (cancelled) return;
      if (list) {
        const next = list.map(settingsJobOf).filter((job): job is SettingsJob => job !== null);
        const now = {
          running: new Set(next.filter((job) => job.state === "running").map((job) => job.id)),
          ended: new Set(next.filter((job) => job.state !== "running").map((job) => job.id)),
        };
        const before = seen.current;
        seen.current = now;
        anyRunning = now.running.size > 0;
        setJobs(next);
        setLoaded(true);
        if (before) {
          const endedNow = next.filter((job) => job.state !== "running" && !before.ended.has(job.id));
          // One seen running that the box no longer keeps ended too, how is not known.
          const gone = [...before.running].some((id) => !now.running.has(id) && !now.ended.has(id));
          if (endedNow.length > 0 || gone) onEndedRef.current?.(endedNow);
        }
      }
      if (kicked) {
        kicked = false;
        void tick();
        return;
      }
      timer = setTimeout(tick, anyRunning ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    const kick = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      void tick();
    };
    kickRef.current = kick;
    void tick();
    window.addEventListener(BACKGROUND_TASK_EVENT, kick);
    return () => {
      cancelled = true;
      kickRef.current = () => undefined;
      if (timer) clearTimeout(timer);
      window.removeEventListener(BACKGROUND_TASK_EVENT, kick);
    };
  }, [enabled, group]);

  const refresh = useCallback(() => kickRef.current(), []);
  const shown = enabled ? jobs : [];
  return {
    jobs: shown,
    running: shown.find((job) => job.state === "running") ?? null,
    loaded: enabled && loaded,
    refresh,
  };
}
