// "Is the PERSON asking, or the agent?"
//
// WHY THIS EXISTS AT ALL. src/middleware.ts admits a caller to /setup-api/* on
// EITHER a session cookie OR the MCP bearer token (step 3c) — deliberately, so
// the MCP server, which has no cookie, can reach the device's own API. For
// almost every route that is exactly right: the agent is allowed to read the
// device's status, open apps, run tools.
//
// It is not right for an approval gate. The whole point of "ask me before
// sending" is to stop the AGENT from sending on its own — and the agent holds a
// token that middleware treats as authentication. A gate whose Approve button
// answers to the party being gated is not a gate; a prompt-injected agent would
// queue a draft and approve it in the next tool call, and the owner would see
// nothing but a sent message.
//
// So the approval route does not take middleware's word for it. It re-checks,
// and it accepts ONE of the two credentials: the owner's session cookie. The
// MCP bearer gets a 403 no matter how valid it is.
//
// This is a second, narrower check INSIDE a route middleware has already let
// through — never a replacement for it.

import { getSessionGeneration, getSessionSigningSecret, verifySessionCookie } from "@/lib/auth";

const SESSION_COOKIE_RE = /(?:^|;\s*)clawbox_session=([^;]+)/;

/**
 * True only when the request carries a valid, unexpired, un-revoked session
 * cookie — i.e. a browser someone logged into.
 *
 * Returns false, never throws: a caller failing this check must get a 403, not
 * a 500 that a client might read as "try again".
 */
export async function hasOwnerSession(request: Request): Promise<boolean> {
  const match = SESSION_COOKIE_RE.exec(request.headers.get("cookie") ?? "");
  if (!match) return false;

  let cookie: string;
  try {
    cookie = decodeURIComponent(match[1]);
  } catch {
    return false;
  }

  try {
    const secret = await getSessionSigningSecret();
    if (!secret) return false;
    // The generation check is what makes "change the password" revoke a
    // stolen cookie here too, exactly as it does in middleware.
    return verifySessionCookie(cookie, secret, await getSessionGeneration());
  } catch {
    return false;
  }
}
