export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { createSessionCookie, getSessionGeneration, getSessionSigningSecret, isSafePasswordChars, readSessionClaims } from "@/lib/auth";
import { changeUserPassword, checkUserPassword, rotateUserSessionVersion } from "@/lib/clawbox-users";
import { checkLockout, recordFailure, recordSuccess, SHARED_BUCKET_MAX_LOCK_MS } from "@/lib/login-rate-limit";
import { personSession } from "@/lib/owner-session";
import { beginPasswordChange, endPasswordChange } from "@/lib/password-change-lock";
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
 * another site's page riding the cookie.
 *
 * In this order, so a password can never change while sessions issued before
 * it stay valid:
 *
 *   1. The current password is checked as root (the helper's `verify`). Wrong
 *      guesses are charged to the SAME durable per-account bucket as the
 *      login's (`user:<name>`, src/lib/login-rate-limit.ts), so this door and
 *      /login-api share one limit; a lock the bucket could not store is kept
 *      in this process as well. One guess per account is in flight at a time.
 *   2. Every other session is ended: the user's session version is rotated
 *      and this browser re-signed under the new one. If that cannot be
 *      stored, NOTHING changes and the route says so (500
 *      `sessions_not_ended`).
 *   3. Only then is the password changed (the helper's `passwd`, which checks
 *      the current password again before chpasswd).
 *
 * The whole change holds src/lib/password-change-lock.ts, which /login-api
 * reads: no sign-in is issued for the account while it runs, nor by one that
 * began before it — the old password still works until step 3.
 *
 * Never a 401 for a wrong current password: the desktop reads a 401 as
 * "signed out".
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Locks the shared limiter reported but could not store (a full table): held here until they end. */
const heldLocks = new Map<string, number>();

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

type FreshCookie = { value: string; maxAge: number; secure: boolean };

/**
 * End every session of theirs but this one: a new session version, and this
 * browser's cookie re-minted under it. `ok: false` when the new version could
 * not be stored (tried twice) — nothing was revoked, and nothing must change.
 */
async function endOtherSessions(req: Request, username: string): Promise<{ ok: boolean; cookie: FreshCookie | null }> {
  let sv: string | null = null;
  let stored = false;
  for (let attempt = 0; attempt < 2 && !stored; attempt++) {
    try {
      sv = await rotateUserSessionVersion(username);
      stored = true;
    } catch (err) {
      console.error("[users] could not end the user's other sessions:", err instanceof Error ? err.message : err);
    }
  }
  if (!stored) return { ok: false, cookie: null };
  // No such user any more: every cookie of theirs is dead already.
  if (!sv) return { ok: true, cookie: null };
  try {
    const secret = await getSessionSigningSecret();
    const maxAge = await secondsLeft(req, secret);
    const value = createSessionCookie(maxAge, secret, await getSessionGeneration(), { u: username, sv });
    return { ok: true, cookie: { value, maxAge, secure: requestIsHttps(req) } };
  } catch (err) {
    // The other sessions ARE ended; this browser signs in again.
    console.error("[users] could not re-sign this browser's session:", err instanceof Error ? err.message : err);
    return { ok: true, cookie: null };
  }
}

/** Every answer after the rotation carries the re-signed cookie, or this browser would be signed out by its own request. */
function withCookie(res: NextResponse, cookie: FreshCookie | null): NextResponse {
  if (cookie) {
    res.cookies.set("clawbox_session", cookie.value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: cookie.maxAge,
      secure: cookie.secure,
    });
  }
  return res;
}

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

const TOO_MANY = () => refuse(429, "too_many_attempts", "Too many wrong passwords. Try again in a few minutes.");
const INVALID = () =>
  refuse(400, "invalid_password", `Passwords must be ${USER_PASSWORD_MIN}–${USER_PASSWORD_MAX} characters with no control characters.`);

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
  // The new password's rules first: nothing is asked of the box for one it would refuse.
  if (
    typeof password !== "string"
    || password.length < USER_PASSWORD_MIN
    || password.length > USER_PASSWORD_MAX
    || !isSafePasswordChars(password)
  ) {
    return INVALID();
  }

  const username = who.username;
  // One change (one guess) per account at a time — and, while it runs, no
  // sign-in for the account (src/lib/password-change-lock.ts).
  if (!beginPasswordChange(username)) return TOO_MANY();
  try {
    const held = heldLocks.get(username);
    if (held !== undefined && held > Date.now()) return TOO_MANY();
    if (held !== undefined) heldLocks.delete(username);
    if ((await checkLockout(bucketOf(username))).locked) return TOO_MANY();

    // 1. The current password.
    const verdict = await checkUserPassword(username, currentPassword);
    if (verdict === "unavailable") {
      return refuse(503, "password_change_unavailable", "This box cannot change passwords yet — the owner needs to update it first.");
    }
    if (verdict === "wrong") {
      const lock = await recordFailure(bucketOf(username), { maxLockMs: SHARED_BUCKET_MAX_LOCK_MS });
      if (lock.locked) heldLocks.set(username, Date.now() + lock.retryAfterSeconds * 1000);
      return refuse(400, "wrong_password", "Your current password is not right.");
    }

    // 2. Every other session ends before anything changes.
    const ended = await endOtherSessions(req, username);
    if (!ended.ok) {
      return refuse(500, "sessions_not_ended", "Your other sessions could not be signed out, so your password was not changed. Try again.");
    }

    // 3. The password.
    const result = await changeUserPassword(username, currentPassword, password);
    switch (result) {
      case "ok":
        await recordSuccess(bucketOf(username));
        console.log(`[users] ${username} changed their own password`);
        return withCookie(NextResponse.json({ ok: true }, { headers: NO_STORE }), ended.cookie);
      case "wrong":
        // Changed between the check and the change: charged like any wrong guess.
        await recordFailure(bucketOf(username), { maxLockMs: SHARED_BUCKET_MAX_LOCK_MS });
        return withCookie(refuse(400, "wrong_password", "Your current password is not right."), ended.cookie);
      case "invalid":
        return withCookie(INVALID(), ended.cookie);
      case "failed":
        return withCookie(
          refuse(500, "password_change_failed", "The box could not save the new password; your password is unchanged."),
          ended.cookie,
        );
      default:
        return withCookie(
          refuse(503, "password_change_unavailable", "This box cannot change passwords yet — the owner needs to update it first."),
          ended.cookie,
        );
    }
  } finally {
    endPasswordChange(username);
  }
}
