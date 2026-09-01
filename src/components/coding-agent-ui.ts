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
  "inline-flex items-center justify-center gap-1.5 shrink-0 select-none no-underline cursor-pointer"
  + " rounded-lg px-3 py-1.5 text-xs font-medium"
  + " transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
  + " focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)]"
  + " disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * The one action a screen is for.
 *
 * `btn-gradient` and NOTHING else: that class (globals.css) already carries the
 * coral fill, its own `box-shadow` and its own `:hover { opacity: .9 }`, and it
 * is the product's single sanctioned primary — 32 uses across src/. The
 * `shadow-[…]` and `hover:brightness-110` that used to be here were a second
 * shadow stacked on a class that already had one.
 */
export const BTN_PRIMARY = `${BTN_BASE} btn-gradient text-white font-semibold`;

/**
 * Everything else you can do from a screen.
 *
 * The product's recipe, taken from the code rather than invented: one flat step
 * up the same fill on hover, over the ONE border token. What was here before —
 * a 180° white gradient, an inset highlight and `border-white/[0.14]` — appears
 * nowhere else in ClawBox: that inset had five occurrences in all of src/ and
 * every one was this file, and the border alpha had exactly one. The rest of
 * the product uses `--border-subtle` 188 times. That mismatch is why the Coding
 * Agent's settings stopped looking like the rest of the desktop.
 */
export const BTN_SECONDARY =
  `${BTN_BASE} border border-[var(--border-subtle)] bg-[var(--fill-1)] text-[var(--text-secondary)]`
  + " hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)]";

/**
 * For a control that should stay out of the way until it is wanted.
 *
 * `border border-transparent` rather than the product's `border-none`, for one
 * reason: it keeps a quiet button exactly level with a secondary beside it in a
 * row. It paints identically. Nothing in ClawBox grows a border on hover, so
 * the old `hover:border-white/10` is gone.
 */
export const BTN_QUIET =
  `${BTN_BASE} border border-transparent bg-transparent text-[var(--text-muted)]`
  + " hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)]";

/** A confirmed destructive step — the product's tinted-accent recipe in red. */
export const BTN_DANGER =
  `${BTN_BASE} border border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25 font-semibold`;

/**
 * A segmented control: a darker WELL holding the options.
 *
 * The product has this exact construction (the provider tabs in AIModelsStep,
 * the wallpaper-fit picker in Settings) and globals.css names it: `--bg-deep`
 * is "the INSET colour: the well under a segmented tab tray". No border, no
 * inset shadow, and the chosen segment is a flat `--fill-3` rung rather than a
 * coral gradient with a glow.
 */
export const SEGMENTED_TRACK = "flex w-full gap-1 p-1 rounded-lg bg-[var(--bg-deep)]";

export const SEGMENT =
  "flex-1 rounded-lg px-2 py-1.5 text-xs font-medium capitalize border-none cursor-pointer"
  + " transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
  + " focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--coral-ring)]"
  + " disabled:opacity-50 disabled:cursor-not-allowed";

export const SEGMENT_ON = `${SEGMENT} bg-[var(--fill-3)] text-[var(--text-primary)]`;

export const SEGMENT_OFF = `${SEGMENT} bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]`;

/**
 * A surface. `--surface-card` over the one border token — the same card the
 * rest of the desktop draws. The faint white gradient that was here is one of
 * the six 180° control-face gradients in src/components, and all six were this
 * file; the other two `linear-gradient` uses in the product are a window title
 * bar and a danger panel tint, neither of them a surface like this.
 */
export const CARD = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5";

/** A text input, matched to the button height so a field + button row is level. */
export const FIELD =
  "rounded-lg border border-[var(--border-subtle)] bg-[var(--fill-2)] px-3 py-1.5 text-[var(--text-primary)]"
  + " outline-none transition-colors focus:border-[var(--coral-bright)]/50";

/** Small caps section label — the rhythm every list on these pages starts with. */
export const SECTION_LABEL =
  "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]";
