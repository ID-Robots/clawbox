"use client";

// ── The one disclosure control Settings uses ──
//
// Three blocks in Settings are drawn only when the owner asks for them: the
// ClawBox AI usage figures beside that provider's row, and the per-core CPU
// bars and busiest-processes table on System. Each one costs something to keep
// open — the usage card polls the portal, and the processes table is `ps aux`,
// 91% of `/setup-api/system/stats`'s cost, every three seconds — so the point
// of the button is not tidiness, it is that a collapsed block is not paid for.
//
// It is ONE component rather than three inline toggles because the accessible
// half of a disclosure is the half that gets forgotten: `aria-expanded` is what
// tells a screen-reader user the control opens something and whether it is open
// right now, and `aria-controls` is what says which region. Written out three
// times, the third one loses a attribute. Here it cannot.
//
// The panel itself stays with the caller: a card header and a control tucked
// into a list row are different shapes, and folding both into one wrapper would
// mean a `children` slot that has to satisfy both. The caller renders the
// region, gives it the `controls` id and mounts it only while `open` — which is
// what stops the collapsed block from fetching, because an unmounted component
// has no effect to run.

interface SettingsDisclosureButtonProps {
  open: boolean;
  onToggle: () => void;
  /** The panel's own name. The button says what it reveals and nothing else. */
  label: string;
  /** `id` of the region this opens — must match the panel the caller renders. */
  controls: string;
  /** Material Symbols ligature drawn before the label. Card headers carry one. */
  icon?: string;
  /**
   * `card` titles a whole card and is rendered as that card's heading, so the
   * section keeps its place in the document outline; `inline` is a small pill
   * that sits among other controls in a row.
   */
  variant?: "card" | "inline";
  testId?: string;
}

const CARD_BUTTON =
  "flex items-center gap-2 bg-transparent border-none p-0 cursor-pointer text-left " +
  "text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest " +
  "hover:text-[var(--text-secondary)] transition-colors";

const INLINE_BUTTON =
  "flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 " +
  "text-[var(--text-secondary)] hover:bg-white/5 cursor-pointer shrink-0 transition-colors";

export default function SettingsDisclosureButton({
  open,
  onToggle,
  label,
  controls,
  icon,
  variant = "card",
  testId,
}: SettingsDisclosureButtonProps) {
  const button = (
    <button
      type="button"
      onClick={onToggle}
      // The two attributes this component exists to guarantee. `aria-controls`
      // names the region even while it is closed and therefore unmounted: the
      // relationship is a fact about the button, and dropping it on collapse is
      // how the association disappears exactly when it is needed to promise
      // that something will appear.
      aria-expanded={open}
      aria-controls={controls}
      data-testid={testId}
      className={variant === "card" ? CARD_BUTTON : INLINE_BUTTON}
    >
      {icon && (
        <span
          className="material-symbols-rounded text-[var(--coral-bright)]"
          style={{ fontSize: 18 }}
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <span>{label}</span>
      {/* Decorative: `aria-expanded` above already says open or closed, and a
          chevron that also announced itself would say it twice. */}
      <span
        className="material-symbols-rounded text-[var(--text-muted)]"
        style={{ fontSize: variant === "card" ? 16 : 14 }}
        aria-hidden="true"
      >
        {open ? "expand_less" : "expand_more"}
      </span>
    </button>
  );

  // A card's disclosure IS that card's title, so it stays a heading rather than
  // becoming a bare button floating where the heading used to be.
  return variant === "card" ? <h3 className="m-0">{button}</h3> : button;
}
