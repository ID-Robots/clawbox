import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import { verifyPassword, createSessionCookie, getSessionSigningSecret } from "@/lib/auth";

export const dynamic = "force-dynamic";

const VALID_DURATIONS = new Set([1200, 21600, 43200, 86400]);

// Rate limiting
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const attempts = new Map<string, { count: number; first: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > RATE_LIMIT_WINDOW_MS) {
    // Prune stale entries periodically
    if (attempts.size > 100) {
      for (const [k, v] of attempts) {
        if (now - v.first > RATE_LIMIT_WINDOW_MS) attempts.delete(k);
      }
    }
    attempts.set(ip, { count: 1, first: now });
    return true;
  }
  rec.count++;
  return rec.count <= RATE_LIMIT_MAX;
}

function clientIP(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-real-ip")
    || req.headers.get("cf-connecting-ip")
    || null;
}

export async function POST(request: Request) {
  const ip = clientIP(request) || "no-ip";
  if (!rateLimit(ip)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
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
      return NextResponse.json({ error: "Password not configured. Complete setup first." }, { status: 400 });
    }
  }

  let body: { password?: string; duration?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { password, duration } = body;
  if (!password) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }
  if (!duration || !VALID_DURATIONS.has(duration)) {
    return NextResponse.json({ error: "Invalid session duration" }, { status: 400 });
  }

  const valid = await verifyPassword(password);
  if (!valid) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  // Reset rate limit on success
  attempts.delete(ip);

  const secret = await getSessionSigningSecret();
  const cookie = createSessionCookie(duration, secret);

  const res = NextResponse.json({ success: true });
  res.cookies.set("clawbox_session", cookie, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: duration,
    secure: false, // HTTP on local network
  });
  return res;
}
