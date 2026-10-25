/**
 * A session that has run out, as the browser learns of it.
 *
 * The box answers a request that needs a session and has none (expired, or
 * revoked by a password change on another device) with a 401 — and so do a
 * handful of routes for reasons that have nothing to do with the session: a
 * wrong current password, a refused provider key, a bad login. Only the first
 * kind means "signed out", so the box marks it: the session gate's 401 carries
 * SESSION_EXPIRED_HEADER (src/middleware.ts, src/lib/route-auth.ts), and a
 * socket the box ends because its session ended closes with
 * SESSION_EXPIRED_CLOSE_CODE (scripts/upgrade-session-watch.js, which holds the
 * CommonJS copy of the code).
 *
 * Either one takes the whole page to /login — every open app, the chat and its
 * socket included — carrying the path it was on, so signing in again lands the
 * person back where they were.
 */

export const SESSION_EXPIRED_HEADER = "x-clawbox-session";
export const SESSION_EXPIRED_HEADER_VALUE = "expired";

/** An application close code (RFC 6455 §7.4.2): the box ended the socket because the session did. */
export const SESSION_EXPIRED_CLOSE_CODE = 4401;

/** Window event fired once, just before the page leaves for /login, so live connections stop at once. */
export const SESSION_EXPIRED_EVENT = "clawbox:session-expired";

/** The cheapest read every signed-in person may make — what a page asks to learn whether its session is still good. */
export const SESSION_PROBE_URL = "/setup-api/users/me";

/** What a chat shows for the moment between its session ending and the page reaching /login. */
export const SESSION_EXPIRED_CHAT_MESSAGE = "Your session has expired. Taking you to sign in again…";

/** The headers the session gate's 401 carries. */
export function sessionExpiredHeaders(): Record<string, string> {
  return { [SESSION_EXPIRED_HEADER]: SESSION_EXPIRED_HEADER_VALUE, "cache-control": "no-store" };
}

type ResponseLike = { status?: number; headers?: { get?: (name: string) => string | null } | null } | null | undefined;

/** The session gate's 401 — never a route's own 401 for a wrong password or a refused key. */
export function isSessionExpiredResponse(res: ResponseLike): boolean {
  if (!res || res.status !== 401) return false;
  try {
    return res.headers?.get?.(SESSION_EXPIRED_HEADER) === SESSION_EXPIRED_HEADER_VALUE;
  } catch {
    return false;
  }
}

/** A socket the box closed because its session ended. */
export function isSessionExpiredClose(event: { code?: number } | null | undefined): boolean {
  return event?.code === SESSION_EXPIRED_CLOSE_CODE;
}

/**
 * Where a page whose session the box no longer accepts goes: the login page,
 * carrying the path it was on the way the middleware does for a navigation
 * (`redirect` is the pathname alone — never the query, which a notice or a
 * deep link may still be sitting in — so the two agree and the person lands
 * back where they were).
 */
export function signedOutLoginPage(pathname: string = window.location.pathname): string {
  const params = new URLSearchParams({ redirect: pathname || "/" });
  return `/login?${params.toString()}`;
}

/**
 * Stop every live connection on the page and leave for /login. Safe to call
 * from every poll that sees the same lapsed session at the same moment: each
 * listener stops what is still running, and every call names the same page.
 */
export function signOutExpiredSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  } catch {
    // a listener's failure must not keep the page here
  }
  // `replace`, not `assign`: the page this leaves is one the middleware would
  // bounce straight back, so it must not be in history.
  window.location.replace(signedOutLoginPage());
}

/**
 * Ask the box whether this page's session is still good, and leave for /login
 * if it is not. For a page that has nothing else to ask — a socket that just
 * dropped, a tab that comes back from the background. A box that cannot be
 * reached is not a lapsed session: that answers `true`.
 */
export async function confirmSessionStillValid(): Promise<boolean> {
  try {
    const res = await fetch(SESSION_PROBE_URL, { cache: "no-store" });
    if (isSessionExpiredResponse(res)) {
      signOutExpiredSession();
      return false;
    }
  } catch {
    // offline, or the box restarting
  }
  return true;
}

/**
 * The page-wide 401 handler: every `fetch` the page makes is watched for the
 * session gate's answer, so an app that only shows its own "request failed"
 * still takes the page to /login. Returns the function that puts the original
 * `fetch` back.
 */
export function installSessionExpiryGuard(win: Window = window): () => void {
  const original = win.fetch;
  if (typeof original !== "function") return () => {};
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original.call(win, input, init);
    if (isSessionExpiredResponse(res)) signOutExpiredSession();
    return res;
  };
  // Cast: some runtimes' `typeof fetch` carries extras (Bun's `preconnect`) a
  // page never calls through this wrapper.
  win.fetch = guarded as typeof fetch;
  return () => {
    if (win.fetch === guarded) win.fetch = original;
  };
}
