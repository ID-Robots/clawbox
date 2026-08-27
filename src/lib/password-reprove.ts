import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth";
import {
  checkLockout,
  recordFailure,
  recordSuccess,
  padResponseTime,
  SHARED_BUCKET_MAX_LOCK_MS,
} from "@/lib/login-rate-limit";

/**
 * Re-proving the owner's OS password behind an existing session.
 *
 * Two routes ask for it — `/setup-api/system/credentials/verify` before a
 * password change, and `/setup-api/setup/reset` before a factory wipe — and
 * both are right/wrong password oracles. An oracle is only as strong as the
 * throttle in front of it, so the throttle lives here once rather than being
 * re-derived per route: the same persisted escalating lockout as `/login-api`,
 * the same shared-bucket cap, and the same MIN_RESPONSE_MS pad on every exit
 * path, so "malformed request" and "wrong password" stay indistinguishable by
 * timing. TASK-444b established that shape; this module is where it is kept.
 */

/** Same dual-bucket keying as /login-api — see the comment there. */
export function lockoutBuckets(req: Request): Array<{ key: string; maxLockMs?: number }> {
  const buckets: Array<{ key: string; maxLockMs?: number }> = [
    { key: "global", maxLockMs: SHARED_BUCKET_MAX_LOCK_MS },
  ];
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) buckets.unshift({ key: `cf:${cf}` });
  return buckets;
}

export function lockoutResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Please try again later.", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/**
 * Check the caller is not locked out yet. Returns the response to send when it
 * is, or null to carry on.
 *
 * Split from {@link reproveOwnerPassword} because callers must refuse a locked
 * out client BEFORE they read the request body — the point of the lockout is
 * that a locked client costs nothing to turn away.
 */
export async function checkReproveLockout(
  buckets: ReturnType<typeof lockoutBuckets>,
  startedAt: number,
): Promise<NextResponse | null> {
  for (const bucket of buckets) {
    const lock = await checkLockout(bucket.key);
    if (lock.locked) {
      await padResponseTime(startedAt);
      return lockoutResponse(lock.retryAfterSeconds);
    }
  }
  return null;
}

/**
 * Verify `password` against the OS account, recording the attempt in every
 * bucket. Returns the response to send on failure, or null when it checked
 * out. The caller is responsible for padding its own success path.
 */
export async function reproveOwnerPassword(
  password: string,
  buckets: ReturnType<typeof lockoutBuckets>,
  startedAt: number,
): Promise<NextResponse | null> {
  if (!password) {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  const ok = await verifyPassword(password);
  if (!ok) {
    let worst = 0;
    for (const bucket of buckets) {
      const after = await recordFailure(bucket.key, { maxLockMs: bucket.maxLockMs });
      if (after.locked) worst = Math.max(worst, after.retryAfterSeconds);
    }
    await padResponseTime(startedAt);
    if (worst > 0) return lockoutResponse(worst);
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  for (const bucket of buckets) await recordSuccess(bucket.key);
  return null;
}
