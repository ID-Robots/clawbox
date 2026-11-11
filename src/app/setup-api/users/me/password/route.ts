export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { changeUserPassword } from "@/lib/clawbox-users";
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
    case "ok":
      wrongAttempts.delete(who.username);
      console.log(`[users] ${who.username} changed their own password`);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
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
