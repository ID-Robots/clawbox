"use client";

/**
 * The Coding Agent's toggle, as one component.
 *
 * It lived inside CodingAgentSettingsPanel while that panel drew every switch
 * the feature has. The secrets card (CodingAgentSecretsCard) draws one of its
 * own, and a second copy of this markup would be a second set of focus rings,
 * spinner sizes and disabled alphas to keep in step — the same drift
 * `window-snap.ts`'s DESKTOP_GAP records. Its own module rather than an export
 * off the panel, because the panel imports the cards: the other direction would
 * be a cycle.
 *
 * Behaviour worth keeping as it was: `busy` shows the spinner AND disables the
 * button, so a switch cannot be flipped twice while its write is in flight, and
 * the spinner is `motion-safe` because an owner who asked the OS for reduced
 * motion must not be given a thing that turns forever.
 */
export default function CodingAgentSwitch({
  checked, busy, disabled, label, onChange, testId = "coding-agent-switch",
}: {
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
  /** The main switch keeps the id it always had; every other one has its own. */
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {busy && (
        // motion-safe: a spinner that keeps turning for an owner who asked
        // the OS for reduced motion is the one thing a spinner must not do.
        <span
          className="material-symbols-rounded motion-safe:animate-spin text-[var(--text-muted)]"
          style={{ fontSize: 18 }}
          aria-hidden="true"
          data-testid={`${testId}-busy`}
        >
          progress_activity
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        aria-busy={busy}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        data-testid={testId}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
          checked ? "bg-[var(--coral-bright)]" : "bg-gray-600"
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}
