interface ProgressBarProps {
  currentStep: number;
}

const STEP_LABELS = ["WiFi", "Update", "Security", "AI Model", "Telegram", "Done"];

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
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              isDone
                ? "text-green-400 bg-green-500/10"
                : isActive
                  ? "text-orange-400 bg-orange-500/10"
                  : "text-gray-500 bg-gray-800"
            }`}
          >
            <span
              className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold text-white ${
                isDone
                  ? "bg-green-500"
                  : isActive
                    ? "bg-orange-500"
                    : "bg-gray-600"
              }`}
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
