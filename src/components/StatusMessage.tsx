interface StatusMessageProps {
  type: "success" | "error" | "info";
  message: string;
}

// Ink, 10% fill and 20% edge, all mixed from ONE role per state. The three
// roles are deliberately edition-invariant — cyan means DONE, red means
// FAILED and amber means CAUTION on every box — so this is a literal→role
// swap that moves no pixel on a ClawBox device while letting the banner sit on
// a Hermes ground without a hardcoded `#00e5cc` fighting the palette around it.
const STYLES: Record<StatusMessageProps["type"], string> = {
  success:
    "bg-[color-mix(in_srgb,var(--set-success)_10%,transparent)] text-[var(--set-success)] border border-[color-mix(in_srgb,var(--set-success)_20%,transparent)]",
  error:
    "bg-[color-mix(in_srgb,var(--set-error)_10%,transparent)] text-[var(--set-error)] border border-[color-mix(in_srgb,var(--set-error)_20%,transparent)]",
  info:
    "bg-[color-mix(in_srgb,var(--set-warning)_10%,transparent)] text-[var(--set-warning)] border border-[color-mix(in_srgb,var(--set-warning)_20%,transparent)]",
};

export default function StatusMessage({ type, message }: StatusMessageProps) {
  return (
    <output
      aria-live={type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`mt-3 px-3.5 py-2.5 rounded-lg text-xs leading-relaxed block ${STYLES[type]}`}
    >
      {message}
    </output>
  );
}
