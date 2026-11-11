export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { createSessionCookie, getSessionGeneration, getSessionSigningSecret, readSessionClaims } from "@/lib/auth";
import { changeUserPassword, rotateUserSessionVersion } from "@/lib/clawbox-users";
import { checkLockout, recordFailure, recordSuccess, SHARED_BUCKET_MAX_LOCK_MS } from "@/lib/login-rate-limit";
import { personSession } from "@/lib/owner-session";
import { sessionRequiredResponse } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { USER_PASSWORD_MAX, USER_PASSWORD_MIN } from "@/lib/username-rules";

/**
 * POST /setup-api/users/me/password `{ currentPassword, password }` — a
 * ClawBox user other than the owner changes their OWN Linux password
 * (Settings → Account). The owner's password is `system/credentials`', which
 * also bumps the session generation; this route answers the owner 409.
 *
 * A person's cookie and our own page only: never the agent's bearer, never
 * another site's page riding the cookie. The current password is checked as
 * root by the helper before anything changes (src/lib/clawbox-users.ts
 * `changeUserPassword`), so a session left open on a shared screen cannot be
 * used to take the account over. Wrong guesses are charged to the SAME
 * durable per-account bucket as the login's (`user:<name>`,
 * src/lib/login-rate-limit.ts), so this door and /login-api share one limit
 * that outlives a restart, and only one guess per account is in flight at a
 * time, so parallel requests cannot slip past it either.
 *
 * Never a 401 for a wrong current password: the desktop reads a 401 as
 * "signed out".
 *
 * A change ends every OTHER session of theirs, as the owner's change does: the
 * user's session version is rotated, and this browser is handed a fresh
 * cookie for the rest of its session's time.
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Accounts with a guess waiting on the helper: one at a time per account. */
const inFlight = new Set<string>();

/** The login's per-account bucket (src/app/login-api/route.ts), shared on purpose. */
const bucketOf = (username: string) => `user:${username}`;

/** Plain HTTP on the LAN cannot keep a Secure cookie; the tunnel is HTTPS. As /login-api decides it. */
function requestIsHttps(req: Request): boolean {
  const xfp = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (xfp) return xfp === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The seconds this request's own session has left (at least a minute), read from its verified cookie. */
async function secondsLeft(req: Request, secret: string): Promise<number> {
  const raw = /(?:^|;\s*)clawbox_session=([^;]*)/.exec(req.headers.get("cookie") ?? "")?.[1];
  let cookie = raw ?? "";
  try {
    cookie = decodeURIComponent(cookie);
  } catch {
    // as sent
  }
  const exp = cookie ? readSessionClaims(cookie, secret)?.exp : undefined;
  const left = typeof exp === "number" ? exp - Math.floor(Date.now() / 1000) : 0;
  return Math.max(60, left);
}

/**
 * End every other session of theirs and keep this one: a new session version,
 * and this browser's cookie re-minted under it. Part of the change's success:
 * false when the new version could not be stored (tried twice), so the caller
 * says so rather than report sessions ended that were not.
 */
async function keepOnlyThisSession(req: Request, username: string, res: NextResponse): Promise<boolean> {
  let sv: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      sv = await rotateUserSessionVersion(username);
      // No such user any more: their every cookie is dead already.
      if (sv === null) return true;
      break;
    } catch (err) {
      console.error("[users] could not end the user's other sessions:", err instanceof Error ? err.message : err);
    }
  }
  if (!sv) return false;
  try {
    const secret = await getSessionSigningSecret();
    const left = await secondsLeft(req, secret);
    const cookie = createSessionCookie(left, secret, await getSessionGeneration(), { u: username, sv });
    res.cookies.set("clawbox_session", cookie, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: left,
      secure: requestIsHttps(req),
    });
  } catch (err) {
    // The other sessions ARE ended; this browser signs in again.
    console.error("[users] could not re-sign this browser's session:", err instanceof Error ? err.message : err);
  }
  return true;
}

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function POST(req: Request) {
  const who = await personSession(req);
  if (!who) return sessionRequiredResponse();
  if (who.isOwner) {
    return refuse(409, "owner_password", "The owner's password is changed in Settings → System.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "Passwords can only be changed from this ClawBox's own pages.");
  }

  let currentPassword: unknown;
  let password: unknown;
  try {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    ({ currentPassword, password } = body as { currentPassword?: unknown; password?: unknown });
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }
  if (typeof currentPassword !== "string" || !currentPassword) {
    return refuse(400, "wrong_password", "Your current password is not right.");
  }
  if (typeof password !== "string") {
    return refuse(400, "invalid_password", `Passwords must be ${USER_PASSWORD_MIN}–${USER_PASSWORD_MAX} characters with no control characters.`);
  }

  // One guess per account at a time, decided before anything is awaited, so
  // guesses sent side by side cannot all pass the lockout check below.
  if (inFlight.has(who.username)) {
    return refuse(429, "too_many_attempts", "Too many wrong passwords. Try again in a few minutes.");
  }
  inFlight.add(who.username);
  let result: Awaited<ReturnType<typeof changeUserPassword>>;
  try {
    if ((await checkLockout(bucketOf(who.username))).locked) {
      return refuse(429, "too_many_attempts", "Too many wrong passwords. Try again in a few minutes.");
    }
    result = await changeUserPassword(who.username, currentPassword, password);
    if (result === "wrong") await recordFailure(bucketOf(who.username), { maxLockMs: SHARED_BUCKET_MAX_LOCK_MS });
    else if (result === "ok") await recordSuccess(bucketOf(who.username));
  } finally {
    inFlight.delete(who.username);
  }
  switch (result) {
    case "ok": {
      console.log(`[users] ${who.username} changed their own password`);
      const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
      if (!(await keepOnlyThisSession(req, who.username, res))) {
        return refuse(500, "sessions_not_ended", "Your password was changed, but your other sessions could not be signed out. Change it once more, or ask the owner to remove and re-add your account.");
      }
      return res;
    }
    case "wrong":
      return refuse(400, "wrong_password", "Your current password is not right.");
    case "invalid":
      return refuse(400, "invalid_password", `Passwords must be ${USER_PASSWORD_MIN}–${USER_PASSWORD_MAX} characters with no control characters.`);
    case "failed":
      return refuse(500, "password_change_failed", "The box could not save the new password. Nothing was changed.");
    default:
      return refuse(503, "password_change_unavailable", "This box cannot change passwords yet — the owner needs to update it first.");
  }
}
