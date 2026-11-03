/**
 * In-handler authentication for /setup-api/* route handlers.
 *
 * Middleware (src/middleware.ts) is the primary gate, but it is one
 * hand-maintained list in front of a ~100-route surface: one mis-ordered
 * `startsWith`, one rewrite, one route reached by a path the matcher doesn't
 * cover, and a destructive handler runs unauthenticated. TASK-443's
 * factory-reset incident is exactly that failure mode — `setup/reset` was
 * `export async function POST()`, a handler that could not have read a cookie
 * if it wanted to.
 *
 * So the destructive handlers check for themselves too. `requireSession`
 * returns a 401 NextResponse to return verbatim, or `null` to proceed.
 *
 * Deliberately self-contained: this module reads data/config.json and
 * data/.session-secret directly rather than going through `@/lib/config-store`
 * and `@/lib/auth`. That mirrors middleware's own resolution (so the two can't
 * drift), keeps the second line of defence independent of the app modules it is
 * defending, and means a route test that mocks config-store doesn't
 * accidentally mock the auth check out of existence. Those reads live in
 * ./session-lease, which judges the cookie for this module and, again later,
 * for a response that outlives its request.
 */

import { NextResponse } from "next/server";
import { verifyMcpBearer } from "./mcp-token";
import { hasOwnerPassword } from "./system-password";
import { type SessionIdentity } from "./session-identity";
import { judgeSessionCookie, readConfigFacts, readSessionCookie } from "./session-lease";
import { sessionExpiredHeaders } from "./session-expiry";

/**
 * Fail-closed setup flags for the pre-auth /login ⇄ /setup handoff, mirroring
 * middleware's readConfigCached failure semantics exactly: an ABSENT
 * config.json is a first-boot box (both false, bootstrap window open); an
 * unreadable/corrupt one is a provisioned box (both true, everything gated).
 *
 * setup/status must serve THESE rather than config-store's fail-OPEN read
 * (which returns {} on a parse error): that told an unauthenticated /login
 * page the wizard was open while middleware kept /setup shut, and the two
 * redirects chased each other forever on a box with a damaged config — the
 * same loop class as the password_configured bounce, one truncated file away.
 */
export function readSetupGateFacts(): { setupComplete: boolean; passwordConfigured: boolean } {
  const { setupComplete, passwordConfigured } = readConfigFacts();
  return { setupComplete, passwordConfigured };
}

export interface RequireSessionOptions {
  /**
   * Refuse every signed-in ClawBox user but the owner, with 403 `owner_only`.
   * Off by default: every ClawBox user gets the owner's desktop, so a route
   * is theirs too unless it is one of the few that are the owner's alone —
   * the owner's account itself (src/lib/non-owner-scope.ts names them).
   */
  ownerOnly?: boolean;
  /**
   * Let the request through while the device is in the genuine first-boot
   * bootstrap window — no password has ever been set, so there is no owner to
   * authenticate as and no credential to protect. Set this ONLY for routes the
   * wizard must reach before CredentialsStep runs (wifi/connect, update/run).
   * Everything destructive leaves it false and fails closed.
   */
  allowBootstrap?: boolean;
}

/**
 * True once the device has an owner credential — the point from which every
 * sensitive route must fail closed.
 *
 * Checks BOTH sources deliberately. `password_configured` lives in
 * data/config.json, which factory reset wipes and a partial restore can drop;
 * /etc/shadow is the real thing. TASK-444a is precisely that drift: config.json
 * says "no password" while the account has one, and the initial-set path
 * re-opens to an anonymous caller.
 *
 * "Has one" means a password somebody chose. The shipped image and a factory
 * reset both leave the published default on the account, and an account anyone
 * can already log in to has no owner — keying on the bare /etc/shadow hash
 * locked the first-boot wizard (wifi/connect, update/run) out of every new box.
 */
export async function deviceHasOwner(): Promise<boolean> {
  if (readConfigFacts().passwordConfigured) return true;
  return (await hasOwnerPassword()) === true;
}

/**
 * Who the request's session cookie speaks for (TASK-1256), or `null` when it
 * carries no cookie this box still honours — expired, revoked by a password
 * change, or issued to a user who has since been removed. Cookie only: the MCP
 * bearer is the agent, not a person, and is answered by `hasValidSession`.
 */
export async function sessionIdentity(request: Request | undefined): Promise<SessionIdentity | null> {
  if (!request || typeof request.headers?.get !== "function") return null;
  const cookie = readSessionCookie(request);
  if (!cookie) return null;
  return judgeSessionCookie(cookie)?.identity ?? null;
}

/**
 * True when the request carries the MCP bearer or a valid session cookie of a
 * person signed in to this box — the owner or any other ClawBox user, who all
 * get the owner's desktop. `setup/status` trims its answer for anyone who is
 * neither, and `requireSession` gates on it.
 *
 * Deliberately does NOT honour `CLAWBOX_TEST_MODE`, unlike `requireSession`
 * below. The two answer different questions: `requireSession` is a GATE ("may
 * this request run at all"), and test mode is the documented escape hatch that
 * opens the whole /setup-api surface to the e2e-install harness. This is an
 * IDENTITY question ("is this the owner"), asked by handlers that shape their
 * response — `setup/status` serves a trimmed payload to anyone who isn't. A
 * harness that can reach a route still isn't the owner, and letting test mode
 * say otherwise would mean the trimmed payload is never exercised end-to-end.
 */
export async function hasValidSession(request: Request | undefined): Promise<boolean> {
  // Next.js always hands a Request to a route handler; a caller that doesn't
  // (an older test, a direct invocation) gets "not authenticated" rather than
  // a TypeError that a `catch` upstream could turn into a success path.
  if (!request || typeof request.headers?.get !== "function") return false;

  const authHeader = request.headers.get("authorization");
  if (authHeader && verifyMcpBearer(authHeader)) return true;

  return (await sessionIdentity(request)) !== null;
}

/** The 403 a signed-in non-owner gets from an owner route — never a 401, which the desktop reads as "session expired". */
export function ownerOnlyResponse(): NextResponse {
  return NextResponse.json(
    { error: "Only the box owner can do this.", code: "owner_only" },
    { status: 403 },
  );
}

/**
 * Returns a 401 response when the caller may not run this route, or `null`
 * when it may. Mirrors middleware's decision order so the two can't disagree:
 * MCP bearer → session cookie → test mode → bootstrap window. Every signed-in
 * ClawBox user passes; with `ownerOnly`, anyone but the owner (and the agent's
 * bearer) is answered 403 `owner_only`.
 */
export async function requireSession(
  request: Request | undefined,
  opts: RequireSessionOptions = {},
): Promise<NextResponse | null> {
  if (opts.ownerOnly) {
    const who = await sessionIdentity(request);
    if (who?.isOwner) return null;
    if (who) return ownerOnlyResponse();
    // The agent's bearer is not the owner either; the test harness and the
    // bootstrap window below still answer for a route that allows them.
    const authHeader = request?.headers?.get?.("authorization");
    if (authHeader && verifyMcpBearer(authHeader)) return ownerOnlyResponse();
  } else if (await hasValidSession(request)) {
    return null;
  }

  // Same escape hatch middleware §3b uses for the e2e-install harness, which
  // drives the whole wizard over HTTP with no cookie jar. install.sh only
  // writes this flag when it boots under CLAWBOX_TEST_MODE.
  if (process.env.CLAWBOX_TEST_MODE === "1") return null;

  if (opts.allowBootstrap && !(await deviceHasOwner())) return null;

  return sessionRequiredResponse();
}

/**
 * The 401 for a request that needs a session and has none — the same answer,
 * marked the same way, as the middleware's session gate, so the page reads it
 * as "signed out" (src/lib/session-expiry.ts) rather than as a route's own 401.
 */
export function sessionRequiredResponse(): NextResponse {
  return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: sessionExpiredHeaders() });
}
