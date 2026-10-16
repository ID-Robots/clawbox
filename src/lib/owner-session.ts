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
//
// THE PERSON is any signed-in ClawBox user. A box can have users besides the
// owner, each a real Linux account with a session of their own, and every one
// of them gets the owner's desktop — the approvals, the coding agent, ClawKeep
// and the rest — so `hasPersonSession` is the check those routes ask. Who a
// cookie speaks for is decided by src/lib/session-identity.ts.
//
// `hasOwnerSession` is the narrower question, kept for the few things that are
// the owner's alone: the gateway's shared token (it reads every conversation
// on the box, src/lib/gateway-proxy.ts) and the owner's account itself.

import { getSessionGeneration, getSessionSigningSecret, getSystemUsername, readSessionClaims } from "@/lib/auth";
import { get } from "@/lib/config-store";
import { identityFromClaims, parseUserRegistry, registryVersions, USERS_CONFIG_KEY, type SessionIdentity } from "@/lib/session-identity";

const NO_USERS: ReadonlyMap<string, string> = new Map();

const SESSION_COOKIE_RE = /(?:^|;\s*)clawbox_session=([^;]+)/;

/** The verified claims of the request's session cookie, or null. Never throws. */
async function cookieClaims(request: Request): Promise<Record<string, unknown> | null> {
  const match = SESSION_COOKIE_RE.exec(request.headers.get("cookie") ?? "");
  if (!match) return null;

  let cookie: string;
  try {
    cookie = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  try {
    const secret = await getSessionSigningSecret();
    if (!secret) return null;
    // The generation check is what makes "change the password" revoke a
    // stolen cookie here too, exactly as it does in middleware.
    return readSessionClaims(cookie, secret, await getSessionGeneration());
  } catch {
    return null;
  }
}

/**
 * True only when the request carries a valid, unexpired, un-revoked session
 * cookie issued to the OWNER — i.e. a browser the owner logged into. A cookie
 * from before multi-user (no `u` claim) is the owner's.
 *
 * Returns false, never throws: a caller failing this check must get a 403, not
 * a 500 that a client might read as "try again".
 */
export async function hasOwnerSession(request: Request): Promise<boolean> {
  const claims = await cookieClaims(request);
  if (!claims) return false;
  try {
    return identityFromClaims(claims, getSystemUsername(), NO_USERS)?.isOwner === true;
  } catch {
    return false;
  }
}

/**
 * The person a session cookie speaks for — the owner or another ClawBox user
 * the registry still lists under the cookie's session version — or null for
 * no cookie, a revoked one, or one of a removed user. Never the MCP bearer.
 */
export async function personSession(request: Request): Promise<SessionIdentity | null> {
  const claims = await cookieClaims(request);
  if (!claims) return null;
  try {
    const owner = getSystemUsername();
    // The owner's cookie needs no registry; anyone else's is checked against it.
    const owned = identityFromClaims(claims, owner, NO_USERS);
    if (owned) return owned;
    const users = registryVersions(parseUserRegistry(await get(USERS_CONFIG_KEY), owner));
    return identityFromClaims(claims, owner, users);
  } catch {
    return null;
  }
}

/**
 * True when a PERSON signed in to this box is asking — the owner or any other
 * ClawBox user — and false for the agent's MCP bearer, a revoked cookie or
 * none. The check every "the person, not the agent" route asks.
 */
export async function hasPersonSession(request: Request): Promise<boolean> {
  return (await personSession(request)) !== null;
}
