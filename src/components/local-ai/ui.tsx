"use client";

import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import { progressPercent, type InstallOutcome, type InstallProgress } from "@/lib/install-stream";

/**
 * The pieces every install card on Settings → Local AI draws the same way.
 *
 * One module rather than a copy per card: the cards and the panel's own row
 * buttons show a download's progress and its verdict, and the first two cards
 * had already drifted into two different words for "failed" before this
 * existed.
 */

/** The keyboard ring the whole panel uses — the wizard's, so one ring across the app. */
export const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--coral-ring)]";

export const CARD = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]";
export const BUTTON = `text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 disabled:cursor-default shrink-0 ${FOCUS_RING}`;
export const PRIMARY_BUTTON = `text-[11px] px-2.5 py-1 rounded-lg border border-[var(--coral-bright)]/40 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/10 disabled:opacity-50 disabled:cursor-default shrink-0 ${FOCUS_RING}`;

export function CardHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 pt-4 pb-2">
      <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
      {hint && <p className="text-xs text-[var(--text-secondary)] mt-0.5">{hint}</p>}
    </div>
  );
}

/**
 * What a download costs against what the box has.
 *
 * Shown BEFORE the button is pressed, which is the point: an install that
 * cannot fit is refused by the route too, but a row that says so first saves
 * the owner a click and a wait. A box whose filesystem would not answer shows
 * the requirement alone rather than inventing a free figure.
 */
export function DiskNote({
  requiredBytes,
  freeBytes,
  locale,
  testId,
}: { requiredBytes: number | null; freeBytes: number | null; locale?: string; testId?: string }) {
  const { t } = useT();
  const need = requiredBytes === null ? null : formatBytes(requiredBytes, locale);
  const free = freeBytes === null ? null : formatBytes(freeBytes, locale);
  if (!need && !free) return null;
  return (
    <span className="text-xs text-[var(--text-secondary)]" data-testid={testId}>
      {need && free
        ? t("localModels.install.diskBoth", { need, free })
        : need
          ? t("localModels.install.diskNeed", { need })
          : t("localModels.install.diskFree", { free: free as string })}
    </span>
  );
}

/**
 * The live half of an install: the last line the route sent, and a bar when it
 * sent enough bytes to draw one.
 *
 * `role="status"` with `aria-live="polite"`, because on a card whose only other
 * feedback is a disabled button this sentence IS the answer to "is anything
 * happening".
 */
export function InstallProgressView({
  progress,
  testId,
}: { progress: InstallProgress | null; testId: string }) {
  const percent = progressPercent(progress);
  if (!progress) return null;
  return (
    <div className="mt-2" data-testid={testId}>
      {progress.status && (
        <p role="status" aria-live="polite" className="text-xs text-[var(--text-secondary)] break-words">
          {progress.status}
        </p>
      )}
      {percent !== null && (
        <div
          className="mt-1 h-1.5 w-full rounded-full bg-white/[0.08] overflow-hidden"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid={`${testId}-bar`}
        >
          <div className="h-full rounded-full bg-[var(--coral-bright)] transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * The settled half: installed, or failed with the reason the box gave.
 *
 * Deliberately not a toast. The row the owner pressed is where the answer
 * belongs, and a failure has to stay on screen next to the button that can be
 * pressed again.
 */
export function InstallOutcomeView({
  outcome,
  testId,
}: { outcome: InstallOutcome | null; testId: string }) {
  const { t } = useT();
  if (!outcome) return null;
  return (
    <p
      role={outcome.ok ? "status" : "alert"}
      className={`text-xs mt-1 break-words ${outcome.ok ? "text-cyan-300" : "text-red-300"}`}
      data-testid={testId}
    >
      {outcome.ok
        ? t("localModels.install.installed")
        : t("localModels.install.failed", { reason: outcome.error ?? t("localModels.error.changeFailed") })}
    </p>
  );
}
