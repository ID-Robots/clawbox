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
 * The chat composer's own recipe (ChatPopup draws its buttons inline with
 * these exact alphas): a white veil of 0.06 that steps to 0.12 on hover, over
 * a 0.08 hairline. The Coding Agent sits beside the chat, and the desktop's
 * `--border-subtle`/`--fill-1` pair read a shade lighter and cooler next to
 * it — the mismatch the owner called "not the chat's darker colours".
 */
export const BTN_SECONDARY =
  `${BTN_BASE} border border-white/[0.08] bg-white/[0.06] text-[var(--text-secondary)]`
  + " hover:bg-white/[0.12] hover:text-[var(--text-primary)]";

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
  + " hover:bg-white/[0.06] hover:text-[var(--text-primary)]";

/** A confirmed destructive step — the product's tinted-accent recipe in red. */
export const BTN_DANGER =
  `${BTN_BASE} border border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25 font-semibold`;

/**
 * A segmented control: a darker WELL holding the options.
 *
 * The same construction the provider tabs and the wallpaper-fit picker use,
 * in the chat's shades: a black well and a flat white rung for the chosen
 * segment rather than a coral gradient with a glow.
 */
export const SEGMENTED_TRACK = "flex w-full gap-1 p-1 rounded-lg bg-black/30";

export const SEGMENT =
  "flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium capitalize border-none cursor-pointer"
  + " transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]"
  + " focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--coral-ring)]"
  + " disabled:opacity-50 disabled:cursor-not-allowed";

export const SEGMENT_ON = `${SEGMENT} bg-white/[0.12] text-[var(--text-primary)]`;

export const SEGMENT_OFF = `${SEGMENT} bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]`;

/**
 * The Coding Agent wears the chat's shell (window-chrome.ts): the ground is
 * `--win-ground` (#0d1117), a card is a black veil over it with a white
 * hairline, a hover is `--fill-2`. It used to sit on `--bg-deep` with
 * lighter cards, and beside the chat it read as a different app.
 */
export const APP_GROUND = "bg-[var(--win-ground)]";
/** A card: the composer's own ground and hairline. */
export const CARD_SURFACE = "rounded-xl bg-black/20 border border-white/[0.07]";
/** A quieter inset inside a card — a row, a log, a viewer. */
export const INSET_SURFACE = "rounded-lg bg-black/25 border border-white/[0.06]";
/** The sidebar and a pane's header strip. */
export const RAIL_SURFACE = "bg-black/30 border-white/[0.06]";

export const CARD = `rounded-2xl border border-white/[0.07] bg-black/20 p-5`;

/** A text input, matched to the button height so a field + button row is level. */
export const FIELD =
  "rounded-lg border border-white/[0.08] bg-black/20 px-3 py-1.5 text-[var(--text-primary)]"
  + " outline-none transition-colors focus:border-[var(--coral-bright)]/50";

/** Small caps section label — the rhythm every list on these pages starts with. */
export const SECTION_LABEL =
  "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]";
