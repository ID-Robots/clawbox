"use client";

import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";

// The pieces ClawKeep and Memory Shard draw with in common.
//
// Memory Shard is the memory-index panel that used to be one card inside the
// ClawKeep window. It kept ClawKeep's card frame, its stat cells, its confirm
// dialog and its "3 hours ago" formatting when it moved out, because an owner
// reads the two windows as one family — the box's memory and the box's backups
// — and a second, slightly different confirm dialog is the kind of drift that
// makes a product feel assembled rather than made. Shared from here rather
// than exported off ClawKeepApp so that opening Memory Shard does not mean
// importing the whole backup app.

export const CARD = "rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-4";

export type Translator = (key: string, params?: Record<string, string | number>) => string;

export function timeAgo(ms: number, t: Translator): string {
  if (!ms) return t("clawkeep.never");
  const diff = Date.now() - ms;
  if (diff < 0) return t("clawkeep.inFuture");
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return t("clawkeep.justNow");
  if (minutes < 60) return t("clawkeep.minutesAgo", { count: minutes });
  if (hours < 24) return t("clawkeep.hoursAgo", { count: hours });
  return t("clawkeep.daysAgo", { count: days });
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "8 s", "2 min 10 s" — the length of a run, in units no locale spells out differently. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export async function jsonOrError<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export const WEEKDAY_LABEL_KEYS = [
  "clawkeep.weekday.sun",
  "clawkeep.weekday.mon",
  "clawkeep.weekday.tue",
  "clawkeep.weekday.wed",
  "clawkeep.weekday.thu",
  "clawkeep.weekday.fri",
  "clawkeep.weekday.sat",
];

export function formatNextRun(ms: number, t: Translator): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return t("clawkeep.anyMoment");
  const totalMin = Math.round(diff / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return t("clawkeep.inDays", { days, hours });
  if (hours > 0) return t("clawkeep.inHours", { hours, mins });
  return t("clawkeep.inMinutes", { mins });
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  // The desktop's one modal behaviour: Escape closes, Tab and Shift-Tab stay
  // inside the panel, the page behind is inert, and focus goes back to the
  // control that opened the dialog when it closes. This dialog used to
  // hand-roll Escape alone, so a keyboard user could Tab straight out of
  // "delete every backup?" into the window behind it.
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: onCancel });
  // Enter is handled by whichever button has focus, and that is Confirm to
  // begin with — the affordance this dialog has always had. The hook lands on
  // the FIRST control, which is Cancel; this runs after it (effects run in
  // declaration order) and moves focus on. Tabbing to Cancel and pressing
  // Enter still cancels.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const confirmClasses = danger
    ? "bg-red-500 hover:bg-red-400 text-white"
    : "bg-emerald-500 hover:bg-emerald-400 text-black";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
    >
      {/* The role sits on the PANEL, where the trap is attached: on the
          backdrop the accessible dialog would be the whole viewport. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clawkeep-confirm-title"
        className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-deep)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          <div
            className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
              danger ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"
            }`}
            aria-hidden="true"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 22 }}>
              {danger ? "warning" : "help"}
            </span>
          </div>
          <h2 id="clawkeep-confirm-title" className="text-base font-semibold text-gray-100 break-words">
            {title}
          </h2>
        </div>
        <div className="px-5 pt-3 pb-4 text-sm leading-relaxed text-[var(--text-secondary)]">
          {body}
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5 pt-2 border-t border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--border-subtle)] text-gray-200 hover:bg-white/5 cursor-pointer"
          >
            {t("clawkeep.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  // Wrapper div is load-bearing — each `<Stat>` is one cell of a 3-col grid.
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-base font-semibold text-gray-100 truncate">{value}</div>
    </div>
  );
}
