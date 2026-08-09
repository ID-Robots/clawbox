import { useT } from "@/lib/i18n";

interface ProgressBarProps {
  currentStep: number;
}

function stepColors(isDone: boolean, isActive: boolean): string {
  if (isDone) return "text-[#00e5cc] bg-[rgba(0,229,204,0.1)]";
  if (isActive) return "text-[#f97316] bg-[rgba(249,115,22,0.15)] ring-1 ring-[#f97316]/30";
  return "text-[var(--text-muted)] bg-[var(--bg-surface)]";
}

function badgeColor(isDone: boolean, isActive: boolean): string {
  if (isDone) return "bg-[#00e5cc]";
  if (isActive) return "bg-[#f97316] shadow-[0_0_8px_rgba(249,115,22,0.5)]";
  return "bg-[var(--text-muted)]";
}

export default function ProgressBar({ currentStep }: ProgressBarProps) {
  const { t } = useT();
  const STEP_LABELS = [
    t("progress.wifi"),
    t("progress.update"),
    t("progress.security"),
    t("settings.aiProvider"),
    t("progress.telegram"),
  ];

  return (
    <div
      className="flex items-center justify-center gap-1"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={STEP_LABELS.length}
      aria-valuenow={currentStep}
      aria-label={t("progress.label", { current: currentStep, total: STEP_LABELS.length })}
    >
      {STEP_LABELS.map((label, i) => {
        const num = i + 1;
        const isCurrent = num === currentStep;
        const isDone = num < currentStep;
        return (
          <div
            key={num}
            aria-current={isCurrent ? "step" : undefined}
            aria-disabled={num > currentStep ? true : undefined}
            className={`flex items-center gap-1.5 px-1.5 py-1.5 sm:px-3 rounded-full text-xs font-medium transition-[transform,color,background-color,box-shadow] duration-200 ${stepColors(isDone, isCurrent)} ${isCurrent ? "scale-105" : ""}`}
          >
            {/* Fixed 24px badge; the current step is emphasised via transform
                scale (GPU-composited) instead of animating w/h — the latter
                reflowed the sticky header (micro-CLS) on every step change. */}
            <span
              className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold text-white shrink-0 transition-transform duration-200 ${badgeColor(isDone, isCurrent)} ${isCurrent ? "" : "scale-[0.83]"}`}
            >
              {isDone ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7" /></svg>
              ) : num}
            </span>
            <span className={isCurrent ? "inline font-semibold" : "hidden sm:inline"}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
