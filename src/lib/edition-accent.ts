// The one accent pair, and which edition wears which.
//
// WHY IT IS SHARED. Two surfaces now ask a customer to agree to something
// consequential — the Step-3 write-down dialog, and the outgoing-email batch
// card in chat — and both take their colour from the edition rather than from
// the palette. A second copy of these six values is a second thing to forget
// when the green moves, and the failure mode is not cosmetic: two consent
// surfaces in different greens read as two different products.
//
// The DANGER family is deliberately not in here. Red is the semantic colour for
// "this cannot be undone" and stays red on both editions, so it belongs with
// whatever is being warned about, not with the brand accent.

export interface Accent {
  /** Solid fill — a control that is hot, or has just fired. */
  solid: string;
  /** The gradient the primary action and the checked box carry. */
  gradient: string;
  /** Quiet fill behind an accent control at rest. */
  dim: string;
  /** Edge an interactive surface takes on hover. */
  edge: string;
  /** The glow under the primary action. */
  glow: string;
  /** Text that sits ON the solid accent. */
  on: string;
}

export const HERMES_ACCENT: Accent = {
  solid: "#12d6a4",
  gradient: "linear-gradient(135deg, #3ef08b 0%, #12d6a4 100%)",
  dim: "rgba(62, 240, 139, 0.14)",
  edge: "rgba(62, 240, 139, 0.45)",
  glow: "0 6px 24px rgba(18, 214, 164, 0.30)",
  on: "#04231c",
};

export const OPENCLAW_ACCENT: Accent = {
  solid: "var(--coral-bright)",
  gradient: "linear-gradient(135deg, var(--coral-bright) 0%, var(--coral-dark) 100%)",
  dim: "var(--coral-tint)",
  edge: "var(--coral-edge)",
  glow: "0 6px 24px var(--shadow-coral-mid)",
  on: "#ffffff",
};

/** The accent for an edition, named so call sites read as intent rather than as a ternary. */
export function accentFor(hermes: boolean): Accent {
  return hermes ? HERMES_ACCENT : OPENCLAW_ACCENT;
}
