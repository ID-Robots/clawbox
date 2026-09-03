/**
 * The one retry schedule for "the box answered with a placeholder, ask again".
 *
 * It lives here, in a module with no imports, rather than beside its first
 * caller, because more than one surface has to agree with it and one of them
 * cannot reach a hook: `useHermesModelOptions` (the model catalogue),
 * `ChatPopup` (the model pill), `useProviderStatus` (the Providers panel's
 * `checking` rows), and the test that pins the last of those against the
 * server's own window. A hook importing another hook also breaks every test
 * that replaces that hook wholesale, which is how this moved.
 *
 * Exponential, and BOUNDED, for the reason every one of those callers shares: a
 * box whose harness is not coming back must not be polled forever, and while
 * the retries run the surfaces read as LOADING. 1+2+4+8+8 spans ~23 s — twice
 * the measured boot window (`clawbox-setup` logs "Ready in 0ms" and starts
 * serving while `clawbox-hermes-dashboard` needs another 11-12 s) and short
 * enough that a box whose dashboard is genuinely gone reaches the honest empty
 * state promptly rather than sitting on a spinner.
 *
 * `DEGRADED_RETRY_ATTEMPTS` is the CATALOGUE's budget, and it is a COUNT
 * because that caller is waiting on nothing that reports its own progress. A
 * caller that IS — `useProviderStatus`, waiting on a server-side `checking`
 * window bounded by the dashboard unit's own start timeout — takes the delays
 * from here and bounds itself by that answer instead, so the rate is shared and
 * the stopping condition is not.
 */
export const DEGRADED_RETRY_BASE_MS = 1_000;
export const DEGRADED_RETRY_MAX_MS = 8_000;
export const DEGRADED_RETRY_ATTEMPTS = 5;

/** Delay before retry number `attempt` (0-based). */
export function degradedRetryDelayMs(attempt: number): number {
  return Math.min(DEGRADED_RETRY_BASE_MS * 2 ** attempt, DEGRADED_RETRY_MAX_MS);
}
