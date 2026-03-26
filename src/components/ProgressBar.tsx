interface ProgressBarProps {
  currentStep: number;
}

const STEP_LABELS = ["WiFi", "Update", "Security", "AI Model", "Telegram"];

function stepColors(isDone: boolean, isActive: boolean): string {
  if (isDone) return "text-[#00e5cc] bg-[rgba(0,229,204,0.1)]";
  if (isActive) return "text-[#f97316] bg-[rgba(249,115,22,0.1)]";
  return "text-[var(--text-muted)] bg-[var(--bg-surface)]";
}

function badgeColor(isDone: boolean, isActive: boolean): string {
  if (isDone) return "bg-[#00e5cc]";
  if (isActive) return "bg-[#f97316]";
  return "bg-[var(--text-muted)]";
}

export default function ProgressBar({ currentStep }: ProgressBarProps) {
  return (
    <div
      className="flex items-center justify-center gap-1 sm:gap-1"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={STEP_LABELS.length}
      aria-valuenow={currentStep}
      aria-label={`Setup progress: step ${currentStep} of ${STEP_LABELS.length}`}
    >
      {STEP_LABELS.map((label, i) => {
        const num = i + 1;
        const isActive = num <= currentStep;
        const isDone = num < currentStep;
        return (
          <div
            key={num}
            aria-current={num === currentStep ? "step" : undefined}
            aria-disabled={num > currentStep ? true : undefined}
            className={`flex items-center gap-1.5 px-1.5 py-1.5 sm:px-3 rounded-full text-xs font-medium transition-all ${stepColors(isDone, isActive)}`}
          >
            <span
              className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold text-white shrink-0 ${badgeColor(isDone, isActive)}`}
            >
              {num}
            </span>
            <span className="hidden sm:inline">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
