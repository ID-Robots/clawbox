/**
 * The Coding Agent's shared visual vocabulary.
 *
 * The app, its settings page and its setup wizard each grew their own button
 * strings — `text-xs px-2.5 py-1`, `text-[11px] px-2.5 py-1`, a `text-sm px-4
 * py-2` gradient — so controls that sit next to each other were different
 * heights and no two hovers matched. These are the same three roles everywhere,
 * with ONE geometry, so a primary and a secondary can be paired in a toolbar.
 *
 * Roles, not looks: PRIMARY is the single action a screen is for, SECONDARY is
 * everything else you can do from it, QUIET is for controls that should
 * disappear until wanted, DANGER for a confirmed destructive step.
 */
export const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium leading-none px-3 py-2 transition-colors no-underline shrink-0 disabled:opacity-40 disabled:cursor-not-allowed";

export const BTN_PRIMARY =
  `${BTN_BASE} btn-gradient text-white font-semibold shadow-sm shadow-[rgba(249,115,22,0.25)] hover:brightness-110`;

export const BTN_SECONDARY =
  `${BTN_BASE} border border-white/10 bg-white/[0.03] text-[var(--text-secondary)] hover:bg-white/[0.07] hover:text-[var(--text-primary)]`;

export const BTN_QUIET =
  `${BTN_BASE} px-2.5 py-1.5 text-[var(--text-muted)] hover:bg-white/5 hover:text-[var(--text-primary)]`;

export const BTN_DANGER =
  `${BTN_BASE} border border-red-400/40 bg-red-500/[0.08] text-red-300 hover:bg-red-500/[0.14]`;

/**
 * A surface. The faint top-down wash is what keeps a stack of these from
 * reading as flat grey boxes — the border alone gave no sense of depth on the
 * deep background these windows sit on.
 */
export const CARD =
  "rounded-2xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5";

/** A text input, matched to the button height so a field + button row is level. */
export const FIELD =
  "rounded-lg bg-black/20 border border-white/[0.08] px-3 py-2 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--coral-bright)]/50";

/** Small caps section label — the rhythm every list on these pages starts with. */
export const SECTION_LABEL =
  "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]";
