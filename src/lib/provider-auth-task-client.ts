/**
 * The browser's half of src/lib/provider-auth-tasks.ts: the provider sign-ins
 * and sign-outs the box runs as settings jobs (TASK-2148,
 * src/lib/settings-job-client.ts), read as the provider each is about.
 *
 * Client-safe.
 */
import type { BackgroundTaskView } from "@/lib/background-task-client";
import { PROVIDER_SIGN_IN_KIND, PROVIDER_SIGN_OUT_KIND } from "@/lib/background-task-kinds";
import { settingsJobOf, type SettingsJob } from "@/lib/settings-job-client";

export type ProviderAuthAction = "sign-in" | "sign-out";

/** One provider job, as Settings needs it: a settings job, named by its provider. */
export interface ProviderAuthTask extends SettingsJob {
  /** The provider's row id (the job's `subject`). */
  provider: string;
  action: ProviderAuthAction;
}

/** Whether a background task is a provider sign-in or sign-out. */
export function isProviderAuthTask(task: Pick<BackgroundTaskView, "kind">): boolean {
  return task.kind === PROVIDER_SIGN_IN_KIND || task.kind === PROVIDER_SIGN_OUT_KIND;
}

/** The provider job behind a settings job (or a background task), or null for any other. */
export function providerAuthTaskOf(job: SettingsJob | BackgroundTaskView): ProviderAuthTask | null {
  const settings = "subject" in job ? job : settingsJobOf(job);
  if (!settings || !isProviderAuthTask(settings)) return null;
  return {
    ...settings,
    provider: settings.subject,
    action: settings.kind === PROVIDER_SIGN_IN_KIND ? "sign-in" : "sign-out",
  };
}
