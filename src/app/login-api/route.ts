import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import { verifyPassword, createSessionCookie, getSessionSigningSecret, getSessionGeneration } from "@/lib/auth";
import {
  checkLockout,
  recordFailure,
  recordSuccess,
  padResponseTime,
  SHARED_BUCKET_MAX_LOCK_MS,
} from "@/lib/login-rate-limit";

export const dynamic = "force-dynamic";

const VALID_DURATIONS = new Set([1200, 21600, 43200, 86400]);

// On a LAN device the request socket IP isn't easy to recover from a
// Next.js Request, and any client can spoof X-Forwarded-For. CF-Connecting-IP
// is the only header upstream rewrites cleanly when the device is fronted by
// the cloudflared tunnel; fall back to a single "global" bucket so an
// IP-rotating attacker still hits the cap.
// A trusted per-client key gets the full escalating lockout; the shared LAN
// fallback bucket is capped (see maxLockMs) so it can't be used to lock the
// owner out. `maxLockMs` undefined = no cap.
function rateLimitKey(req: Request): { key: string; maxLockMs?: number } {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return { key: `cf:${cf}` };
  return { key: "global", maxLockMs: SHARED_BUCKET_MAX_LOCK_MS };
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

function lockoutResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: "Too many failed attempts. Try again later.",
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
  const { key, maxLockMs } = rateLimitKey(request);

  const lock = await checkLockout(key);
  if (lock.locked) {
    await padResponseTime(startedAt);
    return lockoutResponse(lock.retryAfterSeconds);
  }

  // If password not configured, check if this is an upgrade from a pre-auth version
  const configured = await get("password_configured");
  if (!configured) {
    const setupComplete = await get("setup_complete");
    if (setupComplete) {
      // Auto-migrate: user completed setup before auth was added
      await set("password_configured", true);
      await set("password_configured_at", new Date().toISOString());
    } else {
      await padResponseTime(startedAt);
      return NextResponse.json({ error: "Password not configured. Complete setup first." }, { status: 400 });
    }
  }

  let body: { password?: string; duration?: number };
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

  const valid = await verifyPassword(password);
  if (!valid) {
    const after = await recordFailure(key, { maxLockMs });
    await padResponseTime(startedAt);
    if (after.locked) {
      return lockoutResponse(after.retryAfterSeconds);
    }
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  await recordSuccess(key);

  const secret = await getSessionSigningSecret();
  const gen = await getSessionGeneration();
  const cookie = createSessionCookie(duration, secret, gen);

  await padResponseTime(startedAt);
  const res = NextResponse.json({ success: true });
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
