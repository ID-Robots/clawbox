"use client";

import { useMemo } from "react";
import { useSettingsJobs } from "@/hooks/useSettingsJobs";
import { PROVIDER_AUTH_GROUP } from "@/lib/background-task-kinds";
import { providerAuthTaskOf, type ProviderAuthTask } from "@/lib/provider-auth-task-client";
import { notifyProvidersChanged } from "@/lib/ui-events";

function notifyEnded(): void {
  notifyProvidersChanged();
}

/**
 * The provider sign-ins and sign-outs the box is running (TASK-2148), as
 * Settings → Providers draws them: the shared settings-job hook
 * (`useSettingsJobs`) on the provider group. Opened half-way, in another tab
 * or on another device, the provider surfaces draw the change in progress;
 * when one has ended since the last read, every provider surface hears it
 * (`notifyProvidersChanged`) and re-reads the box while Settings is open.
 */
export function useProviderAuthTasks(enabled = true): {
  /** Every provider task the box keeps, newest first. */
  tasks: ProviderAuthTask[];
  /** The one running now, if any (the box runs one at a time). */
  running: ProviderAuthTask | null;
  /** The box has answered at least once. */
  loaded: boolean;
  refresh: () => void;
} {
  const { jobs, loaded, refresh } = useSettingsJobs(PROVIDER_AUTH_GROUP, { enabled, onEnded: notifyEnded });
  const tasks = useMemo(
    () => jobs.map(providerAuthTaskOf).filter((task): task is ProviderAuthTask => task !== null),
    [jobs],
  );
  return { tasks, running: tasks.find((task) => task.state === "running") ?? null, loaded, refresh };
}
