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
 * Exponential and SATURATING, so no caller can end up hammering the box: the
 * delay settles at `DEGRADED_RETRY_MAX_MS` however many times it is asked.
 *
 * How long to keep going is each caller's own question, and the two answers
 * differ because the waits do. `DEGRADED_RETRY_ATTEMPTS` is the CATALOGUE's
 * budget — a COUNT, because that caller waits on nothing that reports its own
 * progress, and a box whose harness is not coming back must not be polled for
 * ever.
 *
 * The count is one MORE than the span suggests, and that is the point. A
 * degraded read is served from cache while the dashboard is re-asked BEHIND the
 * request (`getModelOptions`'s degraded branch — awaiting it was tried in #599
 * and is wrong for reasons written down there), so a poll can only return what
 * a PREVIOUS poll's refresh installed. The last poll therefore cannot recover
 * anything: the deciding one is the SECOND-TO-LAST. With six attempts the
 * requests land at 0, 1, 3, 7, 15, 23 and 31 s, so the dashboard has until
 * ~23 s to come up — roughly twice the measured boot window (`clawbox-setup`
 * logs "Ready in 0ms" and starts serving while `clawbox-hermes-dashboard` needs
 * another 11-12 s). Five attempts read as ~23 s and were really ~15 s, about
 * three seconds of margin over a boot that has been measured at twelve.
 *
 * Past the budget the box settles on what it has, and says so through
 * `scope.stale` — which the Settings panel renders and the chat header does
 * not. `useHermesModelOptions` also sets its `error` on that path, for the same
 * fact and in the same shape as its rejected-request branch, but NO component
 * destructures that field today; it is a contract, not a rendered state.
 *
 * The other caller, `useProviderStatus`, waits on a server-side `checking`
 * window that IS bounded and reported — so it takes the delays from here and
 * stops on the answer instead of on a count.
 */
export const DEGRADED_RETRY_BASE_MS = 1_000;
export const DEGRADED_RETRY_MAX_MS = 8_000;
export const DEGRADED_RETRY_ATTEMPTS = 6;

/** Delay before retry number `attempt` (0-based). */
export function degradedRetryDelayMs(attempt: number): number {
  return Math.min(DEGRADED_RETRY_BASE_MS * 2 ** attempt, DEGRADED_RETRY_MAX_MS);
}
