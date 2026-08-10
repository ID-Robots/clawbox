import { useT } from "@/lib/i18n";

interface ProgressBarProps {
  currentStep: number;
}

/**
 * The wizard's progress rail.
 *
 * Five segments capped at 560px — the card's 520px measure plus 20px of
 * shoulder on each side — so the rail visibly spans the card rather than
 * floating above it at an unrelated width. It never stretches: the labels are
 * 108px apart at 1920 exactly as they are at 940.
 *
 * The current station is marked by thickness and length (3px → 5px, coral,
 * with the shipped 0 0 8px glow), which is the same emphasis ChromeShelf uses
 * for its active app pill. Done segments recede to cyan at 55% — finished, not
 * competing. Below 940px the track becomes the bar's own bottom edge, full
 * bleed, and the counter rides inline, so the header stays one row at 390px
 * even in Bulgarian.
 */
export default function ProgressBar({ currentStep }: ProgressBarProps) {
  const { t } = useT();
  const STEP_LABELS = [
    t("progress.wifi"),
    t("progress.update"),
    t("progress.security"),
    t("settings.aiProvider"),
    t("progress.telegram"),
  ];

  const total = STEP_LABELS.length;
  // Step 6 is the completion overlay: every station is behind the customer,
  // so the rail closes into one continuous bar rather than showing a sixth.
  const finished = currentStep > total;
  const clamped = Math.min(Math.max(currentStep, 1), total);
  const label = t("progress.label", { current: clamped, total });

  return (
    <nav className="setup-rail" aria-label={label}>
      <div
        className={`setup-rail-track${finished ? " is-finished" : ""}`}
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={clamped}
        aria-label={label}
      >
        {STEP_LABELS.map((stepLabel, i) => {
          const num = i + 1;
          const isCurrent = !finished && num === currentStep;
          const isDone = finished || num < currentStep;
          return (
            <span
              key={stepLabel}
              aria-hidden="true"
              className={`setup-seg${isDone ? " is-done" : ""}${isCurrent ? " is-now" : ""}`}
            >
              <i />
            </span>
          );
        })}
      </div>

      <ol className="setup-rail-labels">
        {STEP_LABELS.map((stepLabel, i) => {
          const num = i + 1;
          const isCurrent = !finished && num === currentStep;
          const isDone = finished || num < currentStep;
          return (
            <li
              key={stepLabel}
              aria-current={isCurrent ? "step" : undefined}
              className={`${isDone ? "is-done" : ""}${isCurrent ? " is-now" : ""}`}
            >
              {stepLabel}
            </li>
          );
        })}
      </ol>

      {/* Not aria-hidden: below 940px this is the only station name on screen,
          and above it the labelled list replaces it via display:none, so the
          two forms can never both be announced. */}
      <p className={`setup-rail-here${finished ? " is-finished" : ""}`}>
        <b>{clamped} / {total}</b>
        <span>{STEP_LABELS[clamped - 1]}</span>
      </p>
    </nav>
  );
}
