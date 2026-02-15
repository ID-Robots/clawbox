interface ProgressBarProps {
  currentStep: number;
}

const STEP_LABELS = ["WiFi", "AI Model", "Done"];

function stepColors(isDone: boolean, isActive: boolean): string {
  if (isDone) return "text-green-400 bg-green-500/10";
  if (isActive) return "text-orange-400 bg-orange-500/10";
  return "text-gray-500 bg-gray-800";
}

function badgeColor(isDone: boolean, isActive: boolean): string {
  if (isDone) return "bg-green-500";
  if (isActive) return "bg-orange-500";
  return "bg-gray-600";
}

export default function ProgressBar({ currentStep }: ProgressBarProps) {
  return (
    <div
      className="flex gap-1 flex-wrap"
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
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${stepColors(isDone, isActive)}`}
          >
            <span
              className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold text-white ${badgeColor(isDone, isActive)}`}
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
