// A connect the gateway refuses only because it is still booting, and the
// ladder both chat surfaces climb through it.
//
// Extracted from ChatPopup for the reason chat-reasoning.ts was ("so the gating
// is unit-testable without rendering the whole chat component") and for the
// repo's own "minimise JavaScript bundle size" rule: ChatApp — the full page at
// `/app/clawbox`, which is what a phone lands on — imported this predicate from
// ChatPopup and so dragged the mascot chat's entire import graph (chat cards,
// email batch, approvals, speech, tool events) into that route's chunk. The
// predicate is pure and has always had tests that need no component.

/**
 * The gateway's `details.reason` for a connect refused only because its startup
 * sidecars are still coming up (`GATEWAY_STARTUP_UNAVAILABLE_REASON` in the
 * core's `packages/gateway-protocol/src/startup-unavailable.ts`, v2026.9.3).
 */
const GATEWAY_STARTUP_UNAVAILABLE_REASON = "startup-sidecars";

/**
 * The full page's ladder, in the mascot chat's units: a restart is ten to
 * twenty seconds, so forty tries three seconds apart outlasts a slow one and
 * still ends.
 */
export const STARTING_RETRY_DELAY_MS = 3000;
export const STARTING_MAX_RETRIES = 40;

/** The fields of an `error` frame a client keeps, so a refusal can be judged on
 *  the gateway's own protocol rather than on its English. */
export interface GatewayRefusal {
  message?: string;
  code?: string;
  retryable?: boolean;
  details?: unknown;
}

/**
 * Build the rejection for an `ok: false` frame, carrying the structured fields
 * rather than dropping them for the message alone.
 */
export function gatewayFrameError(error: Record<string, unknown> | undefined): Error & GatewayRefusal {
  const err = new Error((error?.message as string) || "Request failed") as Error & GatewayRefusal;
  if (typeof error?.code === "string") err.code = error.code;
  if (typeof error?.retryable === "boolean") err.retryable = error.retryable;
  if (error && "details" in error) err.details = error.details;
  return err;
}

/**
 * Is this a connect the gateway refuses ONLY because it is not finished booting?
 *
 * The core answers that question in its own protocol, and this is its predicate
 * (`isRetryableGatewayStartupUnavailableError`, same file as the reason above):
 * `code === "UNAVAILABLE"` AND `retryable === true` AND
 * `details.reason === "startup-sidecars"`. All three are needed — the gateway
 * sends `UNAVAILABLE` for a Control-UI build mismatch (`retryable: false`) and
 * for an unsupported socket receiver too, and retrying either is a loop.
 *
 * The prose test is the FALLBACK, for a gateway too old to send a code (and
 * only then): it reads the sentence this build sends verbatim, "gateway
 * starting; retry shortly". It is anchored on that wording rather than on a
 * bare `starting`/`not ready`, because an unanchored match silently retries a
 * refusal that will never change — which is the failure the structured test
 * above exists to remove.
 */
export function isGatewayStartingRefusal(refusal: GatewayRefusal | string | undefined): boolean {
  const err: GatewayRefusal = typeof refusal === "string" ? { message: refusal } : refusal ?? {};
  const reason = (err.details as { reason?: unknown } | undefined)?.reason;
  if (typeof err.code === "string") {
    return err.code === "UNAVAILABLE"
      && err.retryable === true
      && reason === GATEWAY_STARTUP_UNAVAILABLE_REASON;
  }
  return /\bgateway (is )?starting\b|\bretry shortly\b|\bstartup (is )?pending\b/i.test(err.message ?? "");
}
