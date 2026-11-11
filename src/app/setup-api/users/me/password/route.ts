export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { createSessionCookie, getSessionGeneration, getSessionSigningSecret, readSessionClaims } from "@/lib/auth";
import { changeUserPassword, rotateUserSessionVersion } from "@/lib/clawbox-users";
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
 * used to take the account over; a few wrong guesses in a row are then
 * refused for a while, so the check cannot be ground through either.
 *
 * Never a 401 for a wrong current password: the desktop reads a 401 as
 * "signed out".
 *
 * A change ends every OTHER session of theirs, as the owner's change does: the
 * user's session version is rotated, and this browser is handed a fresh
 * cookie for the rest of its session's time.
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Wrong current passwords one user may give in a window before the route stops asking the helper. */
const MAX_WRONG = 5;
const WRONG_WINDOW_MS = 15 * 60 * 1000;
const wrongAttempts = new Map<string, number[]>();

function recentWrong(username: string, now: number): number[] {
  const kept = (wrongAttempts.get(username) ?? []).filter((t) => now - t < WRONG_WINDOW_MS);
  if (kept.length) wrongAttempts.set(username, kept);
  else wrongAttempts.delete(username);
  return kept;
}

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
 * and this browser's cookie re-minted under it. Best effort — the password has
 * changed either way, and a failure here is logged, never the change's.
 */
async function keepOnlyThisSession(req: Request, username: string, res: NextResponse): Promise<void> {
  try {
    const sv = await rotateUserSessionVersion(username);
    if (!sv) return;
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
    console.error("[users] could not end the user's other sessions:", err instanceof Error ? err.message : err);
  }
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

  const now = Date.now();
  if (recentWrong(who.username, now).length >= MAX_WRONG) {
    return refuse(429, "too_many_attempts", "Too many wrong passwords. Try again in a few minutes.");
  }

  const result = await changeUserPassword(who.username, currentPassword, password);
  switch (result) {
    case "ok": {
      wrongAttempts.delete(who.username);
      console.log(`[users] ${who.username} changed their own password`);
      const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
      await keepOnlyThisSession(req, who.username, res);
      return res;
    }
    case "wrong":
      wrongAttempts.set(who.username, [...recentWrong(who.username, now), now]);
      return refuse(400, "wrong_password", "Your current password is not right.");
    case "invalid":
      return refuse(400, "invalid_password", `Passwords must be ${USER_PASSWORD_MIN}–${USER_PASSWORD_MAX} characters with no control characters.`);
    case "failed":
      return refuse(500, "password_change_failed", "The box could not save the new password. Nothing was changed.");
    default:
      return refuse(503, "password_change_unavailable", "This box cannot change passwords yet — the owner needs to update it first.");
  }
}
