import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth";
import { requireSession } from "@/lib/route-auth";
import {
  checkLockout,
  recordFailure,
  recordSuccess,
  padResponseTime,
  SHARED_BUCKET_MAX_LOCK_MS,
} from "@/lib/login-rate-limit";

export const dynamic = "force-dynamic";

/**
 * Re-prove the current OS password (SettingsApp asks for it before a password
 * change and before factory reset).
 *
 * This route is a right/wrong password oracle, so it must be exactly as
 * expensive to ask as /login-api is — it used to answer in ~64 ms against
 * /login-api's 300 ms pad, and it used the in-memory per-XFF `rate-limit.ts`
 * bucket, which a client can reset at will by changing a header it fully
 * controls. An attacker who could reach it therefore had a fast, effectively
 * unthrottled oracle sitting next to a carefully throttled login. TASK-444b.
 *
 * Now it shares /login-api's machinery outright: the same persisted escalating
 * lockout, the same shared-bucket cap, and the same MIN_RESPONSE_MS pad on
 * every exit path — including the 400s, so "malformed request" and "wrong
 * password" are indistinguishable by timing too.
 */

/** Same dual-bucket keying as /login-api — see the comment there. */
function lockoutBuckets(req: Request): Array<{ key: string; maxLockMs?: number }> {
  const buckets: Array<{ key: string; maxLockMs?: number }> = [
    { key: "global", maxLockMs: SHARED_BUCKET_MAX_LOCK_MS },
  ];
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) buckets.unshift({ key: `cf:${cf}` });
  return buckets;
}

function lockoutResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Please try again later.", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  // Verifying a password has no first-boot role: CredentialsStep sets the
  // initial password, it never re-proves one. So no bootstrap carve-out — this
  // never answers an anonymous caller.
  const unauthorized = await requireSession(request);
  if (unauthorized) {
    await padResponseTime(startedAt);
    return unauthorized;
  }

  const buckets = lockoutBuckets(request);
  for (const bucket of buckets) {
    const lock = await checkLockout(bucket.key);
    if (lock.locked) {
      await padResponseTime(startedAt);
      return lockoutResponse(lock.retryAfterSeconds);
    }
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const password = body.password ?? "";
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

  await padResponseTime(startedAt);
  return NextResponse.json({ ok: true });
}
