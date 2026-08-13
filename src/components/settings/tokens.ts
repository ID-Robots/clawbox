/**
 * The Material 3 scales the Settings primitives are built from.
 *
 * These are NUMBERS, not colours. Every colour in this folder comes from a
 * `--set-*` role declared on `.settings-pane` in `src/app/globals.css`; no
 * `.tsx` in here may carry a colour literal, because a literal cannot follow
 * the Hermes palette and the whole point of the role layer is that it can.
 *
 * Shape:   4 / 8 / 12 / 16 / 28
 * Spacing: 4 / 8 / 12 / 16 / 20 / 24
 * Nothing off-scale ships.
 */

export const SHAPE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 28,
} as const;

export const SPACE = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
} as const;

/** M3 type roles, exactly as the visual spec's §5 table states them. */
export const TYPE = {
  /** Section title. */
  titleMedium: { fontSize: 16, fontWeight: 500 },
  /** Row label. */
  bodyLarge: { fontSize: 14, fontWeight: 400 },
  /** Row value. */
  bodyMedium: { fontSize: 14, fontWeight: 400 },
  /** Description, helper text. */
  bodySmall: { fontSize: 12, fontWeight: 400 },
  /** Buttons, nav labels. */
  labelLarge: { fontSize: 14, fontWeight: 500 },
  /** Group header. */
  labelSmall: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
} as const;

/** The minimum touch target, in both trees. */
export const TOUCH_TARGET = 44;
