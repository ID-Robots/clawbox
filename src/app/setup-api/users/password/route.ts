export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { getSystemUsername, isSafePasswordChars } from "@/lib/auth";
import { readJsonObject } from "@/lib/bounded-json";
import { findUser, resetUserPassword, rotateUserSessionVersion } from "@/lib/clawbox-users";
import { personSession } from "@/lib/owner-session";
import { beginPasswordChange, endPasswordChange } from "@/lib/password-change-lock";
import { isSameOriginRequest } from "@/lib/same-origin";
import { USER_PASSWORD_MAX, USER_PASSWORD_MIN, checkUsername } from "@/lib/username-rules";

/**
 * POST /setup-api/users/password `{ username, password }` — the OWNER resets
 * another ClawBox user's Linux password (Settings → System → Users, TASK-2377):
 * for a member of staff who forgot theirs. Their own change is
 * `users/me/password`; the owner's own password is `system/credentials`.
 *
 * The owner's cookie and our own page only: never another user (403
 * `owner_only`), never the agent's MCP bearer, never another site's page
 * riding the owner's cookie (403 `cross_origin`). The same rules as a user's
 * own change, in the same order:
 *
 *   1. the new password's rules (8–256 characters, no control characters);
 *   2. every session of theirs is ended FIRST — a new session version — and
 *      if that cannot be stored nothing changes (500 `sessions_not_ended`);
 *   3. only then the helper's `setpasswd` verb (root, `clawbox-users` members
 *      only, one record to chpasswd, the password on STDIN).
 *
 * The change holds src/lib/password-change-lock.ts, which /login-api reads, so
 * no sign-in for the account is issued while it runs. Never a 401.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 8 * 1024;

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

const INVALID = () =>
  refuse(400, "invalid_password", `Passwords must be ${USER_PASSWORD_MIN}–${USER_PASSWORD_MAX} characters with no control characters.`);
const UNAVAILABLE = () =>
  refuse(503, "password_change_unavailable", "This box cannot reset passwords yet — update it first.");

export async function POST(req: Request) {
  const who = await personSession(req);
  if (!who?.isOwner) return refuse(403, "owner_only", "Only the box owner can reset another user's password.");
  if (!isSameOriginRequest(req)) return refuse(403, "cross_origin", "Passwords can only be reset from this ClawBox's own pages.");

  const read = await readJsonObject(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === "too_long" ? refuse(413, "body_too_large", "That request body is too large.") : refuse(400, "bad_body", "Invalid JSON.");
  }
  const { username, password } = read.body as { username?: unknown; password?: unknown };
  // The owner's own name first: it may be a reserved name (`clawbox`) the user rule refuses.
  if (username === getSystemUsername()) {
    return refuse(409, "owner_password", "The owner's password is changed in Settings → System.");
  }
  if (typeof username !== "string" || checkUsername(username) !== "ok") return refuse(400, "invalid_username", "That is not a username.");
  if (typeof password !== "string" || password.length < USER_PASSWORD_MIN || password.length > USER_PASSWORD_MAX || !isSafePasswordChars(password)) {
    return INVALID();
  }
  let user;
  try {
    user = await findUser(username);
  } catch {
    return refuse(500, "store_unreadable", "The list of users could not be read. Nothing was changed.");
  }
  if (!user) return refuse(404, "unknown_user", `There is no user named "${username}" on this box.`);

  if (!beginPasswordChange(username)) return refuse(409, "password_changing", "That user's password is being changed right now. Try again in a moment.");
  try {
    // 2. Every session of theirs ends before anything changes.
    let stored = false;
    for (let attempt = 0; attempt < 2 && !stored; attempt++) {
      try {
        await rotateUserSessionVersion(username);
        stored = true;
      } catch (err) {
        console.error("[users] could not end the user's sessions:", err instanceof Error ? err.message : err);
      }
    }
    if (!stored) return refuse(500, "sessions_not_ended", "The user's sessions could not be signed out, so the password was not changed. Try again.");

    // 3. The password.
    const result = await resetUserPassword(username, password);
    switch (result) {
      case "ok":
        console.log(`[users] the owner reset ${username}'s password`);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      case "wrong":
        return refuse(404, "unknown_user", `"${username}" is not a ClawBox user's account on this box.`);
      case "invalid":
        return INVALID();
      case "failed":
        return refuse(500, "password_change_failed", "The box could not save the new password; the password is unchanged.");
      default:
        return UNAVAILABLE();
    }
  } finally {
    endPasswordChange(username);
  }
}
