// A Telegram access request is identified by one opaque token that the
// harness's `pairing approve` command accepts. The two harnesses mint
// different shapes, and both reach the same route, so normalisation lives here
// (isomorphic — imported by route handlers AND by client components).
//
//   - OpenClaw: the 8-char code the bot DM'd the requester, uppercase.
//   - Hermes:   the same 8-char code (if the requester relays it), OR the
//               16-hex request id from `hermes pairing list`. Hermes stores
//               codes hashed and never surfaces them, so the request id is the
//               only token our UI can offer a one-click Approve button for.
//
// The shapes cannot collide: they differ in length, and the pairing alphabet
// (ABCDEFGHJKLMNPQRSTUVWXYZ23456789) is uppercase while request ids are hex.

export const PAIRING_CODE_RE = /^[A-Z0-9]{8}$/;
export const PAIRING_REQUEST_ID_RE = /^[0-9a-f]{16}$/;
export const PAIRING_TOKEN_RE = /^(?:[A-Z0-9]{8}|[0-9a-f]{16})$/;

/**
 * Canonical form of a pairing token: request ids lowercase (Hermes looks them
 * up as raw dict keys, so an uppercased id would miss), codes uppercase.
 * Returns the trimmed input unchanged when it matches neither shape — the
 * caller validates with {@link isPairingToken}.
 */
export function normalizePairingToken(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (/^[0-9a-fA-F]{16}$/.test(value)) return value.toLowerCase();
  return value.toUpperCase();
}

/** True when `raw` normalises to a pairing code or a Hermes request id. */
export function isPairingToken(raw: unknown): boolean {
  return PAIRING_TOKEN_RE.test(normalizePairingToken(raw));
}

/** True when `raw` is a Hermes request id rather than a DM'd pairing code. */
export function isPairingRequestId(raw: unknown): boolean {
  return PAIRING_REQUEST_ID_RE.test(normalizePairingToken(raw));
}

/** Equality that survives either side arriving in the other's casing. */
export function samePairingToken(a: unknown, b: unknown): boolean {
  const left = normalizePairingToken(a);
  return left.length > 0 && left === normalizePairingToken(b);
}
