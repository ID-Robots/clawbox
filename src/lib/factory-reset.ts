/**
 * The word the owner has to type before a factory reset runs.
 *
 * Shared by the route that enforces it and the dialog that asks for it, so the
 * two can never drift. It is deliberately NOT translated: the dialog shows the
 * literal token to type next to the field, the way a repository-deletion
 * confirmation does, and a translated token would mean a box set to a language
 * the owner cannot type could not be reset at all.
 */
export const FACTORY_RESET_CONFIRMATION = "RESET";

/** Accepts surrounding space and any casing — a typo guard, not a shibboleth. */
export function isFactoryResetConfirmed(typed: unknown): boolean {
  return typeof typed === "string" && typed.trim().toUpperCase() === FACTORY_RESET_CONFIRMATION;
}
