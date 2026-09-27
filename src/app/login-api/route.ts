import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import {
  verifyPassword,
  createSessionCookie,
  getSessionSigningSecret,
  getSessionGeneration,
  getSystemUsername,
} from "@/lib/auth";
import { hasOwnerPassword } from "@/lib/system-password";
import { findUser, verifyUserPassword } from "@/lib/clawbox-users";
import {
  checkLockout,
  recordFailure,
  recordSuccess,
  padResponseTime,
  SHARED_BUCKET_MAX_LOCK_MS,
} from "@/lib/login-rate-limit";

export const dynamic = "force-dynamic";

const VALID_DURATIONS = new Set([1200, 21600, 43200, 86400]);

// Every attempt is counted against TWO buckets, and both must be clear for the
// attempt to proceed.
//
//   global      — always. Capped at SHARED_BUCKET_MAX_LOCK_MS (5 min) so it can
//                 never be driven to the 24h tier and used to lock the owner
//                 out, but it does throttle everyone, including an attacker who
//                 is rotating headers.
//   cf:<ip>     — when CF-Connecting-IP is present. Full escalating schedule up
//                 to 24h, because behind the cloudflared tunnel that header is
//                 rewritten by the edge and is a real per-client identity.
//
// Why both: the box serves plain HTTP on port 80 with no reverse proxy, so on
// the LAN CF-Connecting-IP is just a header the client picks. Keying only on it
// meant every new value minted a fresh, empty, un-capped bucket — the escalating
// lockout was one `-H 'CF-Connecting-IP: <random>'` away from irrelevant, which
// is exactly what the live validation demonstrated. The global bucket is now
// always in the path, so header rotation buys an attacker nothing beyond the
// 5-minute shared cap. X-Forwarded-For is still deliberately never consulted.
// TASK-444c.
function rateLimitBuckets(req: Request): Array<{ key: string; maxLockMs?: number }> {
  const buckets: Array<{ key: string; maxLockMs?: number }> = [
    { key: "global", maxLockMs: SHARED_BUCKET_MAX_LOCK_MS },
  ];
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) buckets.unshift({ key: `cf:${cf}` });
  return buckets;
}

// Cookies are marked Secure only when the request actually arrived over HTTPS
// (e.g. through the Cloudflare tunnel). On plain-HTTP LAN access Secure would
// stop the browser from ever sending the cookie back, breaking login.
function requestIsHttps(req: Request): boolean {
  const xfp = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (xfp) return xfp === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

// Multi-user (TASK-1256): a third bucket per ACCOUNT, `user:<name>`, charged
// alongside the two above. It is what stops a person who holds one valid login
// from clearing the shared `global` bucket with it (a success clears every
// bucket it was charged against) and then guessing the owner's password at full
// speed. It is capped like `global` — anyone can charge it, so the 24h tier
// would let a stranger on the LAN lock the owner out for a day by typing at the
// user picker — and it exists only for accounts that exist, so spraying made-up
// names cannot fill the tracked-key table and lock real users out of it.
function userBucket(username: string): { key: string; maxLockMs: number } {
  return { key: `user:${username}`, maxLockMs: SHARED_BUCKET_MAX_LOCK_MS };
}

/** Who a login is for: the owner when no name (or the owner's name) is given, a registered user, or nobody. */
async function resolveLoginTarget(requested: string): Promise<
  { kind: "owner"; username: string } | { kind: "user"; username: string; sv: string } | { kind: "unknown" }
> {
  const owner = getSystemUsername();
  if (!requested || requested === owner) return { kind: "owner", username: owner };
  const record = await findUser(requested).catch(() => null);
  return record ? { kind: "user", username: record.username, sv: record.sv } : { kind: "unknown" };
}

function lockoutResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: "Too many failed attempts. Try again later.",
      code: "locked",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const buckets = rateLimitBuckets(request);

  for (const bucket of buckets) {
    const lock = await checkLockout(bucket.key);
    if (lock.locked) {
      await padResponseTime(startedAt);
      return lockoutResponse(lock.retryAfterSeconds);
    }
  }

  // If password not configured, check if this is an upgrade from a pre-auth version
  const configured = await get("password_configured");
  if (!configured) {
    const setupComplete = await get("setup_complete");
    if (setupComplete) {
      // Auto-migrate: user completed setup before auth was added
      await set("password_configured", true);
      await set("password_configured_at", new Date().toISOString());
    } else if ((await hasOwnerPassword()) === true) {
      // /etc/shadow is the authority, the flag is only a cache — the same
      // argument system/credentials already makes (TASK-444a). When the two
      // disagree in this direction the box is otherwise UNCLAIMABLE:
      //
      //   this route          — flag says "no password"  → 400 "Complete setup first"
      //   system/credentials  — shadow says "owned"      → 401 "Authentication required"
      //
      // Neither gate can be satisfied, so the wizard cannot claim the box and
      // the owner cannot log in. Nothing in the UI recovers it. That state is
      // reachable without anything exotic: a box imaged by a rig that pre-sets
      // the account password, a restore that brings back the OS account but not
      // data/config.json, or an installer who just ran `passwd` over SSH before
      // opening the wizard.
      //
      // Trusting shadow here does NOT weaken the gate. hasOwnerPassword() is
      // false for both "no password" and the published factory default, so an
      // as-flashed box still gets the 400 and still cannot be logged into with
      // the default everyone knows — only a password somebody deliberately set
      // opens this path, and the caller must still prove it below.
      await set("password_configured", true);
      await set("password_configured_at", new Date().toISOString());
    } else {
      await padResponseTime(startedAt);
      return NextResponse.json({ error: "Password not configured. Complete setup first." }, { status: 400 });
    }
  }

  let body: { username?: unknown; password?: string; duration?: number };
  try {
    body = await request.json();
  } catch {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { password, duration } = body;
  if (!password) {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }
  if (!duration || !VALID_DURATIONS.has(duration)) {
    await padResponseTime(startedAt);
    return NextResponse.json({ error: "Invalid session duration" }, { status: 400 });
  }

  // No name, or the owner's name, is the owner — the single-user login every
  // box had before multi-user, unchanged. A name that is not the owner's must
  // be a user Settings → Users created; anything else is refused exactly like
  // a wrong password, so the answer never says which names exist.
  const requested = typeof body.username === "string" ? body.username.trim() : "";
  const target = await resolveLoginTarget(requested);
  if (target.kind !== "unknown") {
    buckets.push(userBucket(target.username));
    const lock = await checkLockout(`user:${target.username}`);
    if (lock.locked) {
      await padResponseTime(startedAt);
      return lockoutResponse(lock.retryAfterSeconds);
    }
  }

  const valid = target.kind === "owner"
    ? await verifyPassword(password)
    : target.kind === "user"
      ? await verifyUserPassword(target.username, password)
      : false;
  if (!valid || target.kind === "unknown") {
    // Record against every bucket, then report the longest lock in force so the
    // client's Retry-After is honest about when it can actually try again.
    let worstRetryAfter = 0;
    for (const bucket of buckets) {
      const after = await recordFailure(bucket.key, { maxLockMs: bucket.maxLockMs });
      if (after.locked) worstRetryAfter = Math.max(worstRetryAfter, after.retryAfterSeconds);
    }
    await padResponseTime(startedAt);
    if (worstRetryAfter > 0) {
      return lockoutResponse(worstRetryAfter);
    }
    return requested
      ? NextResponse.json({ error: "Incorrect username or password", code: "bad_credentials" }, { status: 401 })
      : NextResponse.json({ error: "Incorrect password", code: "bad_credentials" }, { status: 401 });
  }

  // A correct password clears every bucket it was charged against, so the owner
  // who fat-fingers it a few times and then gets it right is not left sitting
  // behind the shared cap.
  for (const bucket of buckets) await recordSuccess(bucket.key);

  const secret = await getSessionSigningSecret();
  const gen = await getSessionGeneration();
  // The cookie names who signed in (src/lib/session-identity.ts): `u` always,
  // and for a user other than the owner the registry's session version, which
  // removing or re-creating that user changes.
  const cookie = target.kind === "user"
    ? createSessionCookie(duration, secret, gen, { u: target.username, sv: target.sv })
    : createSessionCookie(duration, secret, gen, { u: target.username });

  await padResponseTime(startedAt);
  const res = NextResponse.json({ success: true, username: target.username });
  res.cookies.set("clawbox_session", cookie, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: duration,
    // Secure only over HTTPS (tunnel); plain-HTTP LAN can't set it or the cookie
    // would never be sent back.
    secure: requestIsHttps(request),
  });
  return res;
}
