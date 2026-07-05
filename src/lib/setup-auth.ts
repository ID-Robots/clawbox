// Client-side detection of an expired/absent setup session.
//
// When the session cookie is missing or invalid, src/middleware.ts responds to
// a /setup-api/* request in one of two ways (see middleware.ts:250-258):
//   - request accepts JSON  -> 401 { error: "Authentication required" }
//   - otherwise             -> 307 redirect to /login
// `fetch` transparently follows the redirect, so a caller that forgets the
// Accept header ends up with a 200 HTML login page — which blows up any
// `res.json()`. Send JSON_ACCEPT_HEADERS to get the clean 401, and use
// isAuthExpired() to catch both shapes before parsing a body.

export const JSON_ACCEPT_HEADERS = { Accept: "application/json" } as const;

export function isAuthExpired(res: Response): boolean {
  if (res.status === 401) return true;
  // A followed redirect whose final URL is the login page also means the
  // session expired (the HTML-client path).
  if (res.redirected) {
    try {
      return new URL(res.url).pathname === "/login";
    } catch {
      return false;
    }
  }
  return false;
}
