import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { padResponseTime } from "@/lib/login-rate-limit";
import {
  checkReproveLockout,
  lockoutBuckets,
  reproveOwnerPassword,
} from "@/lib/password-reprove";

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
 * The throttling that fixed it now lives in `@/lib/password-reprove`, shared
 * with the factory-reset route, which is the other oracle of this shape.
 */
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
  const locked = await checkReproveLockout(buckets, startedAt);
  if (locked) return locked;

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const refused = await reproveOwnerPassword(body.password ?? "", buckets, startedAt);
  if (refused) return refused;

  await padResponseTime(startedAt);
  return NextResponse.json({ ok: true });
}
