import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ─── Captive Portal ──────────────────────────────────────────────────────────

function getPortalUrl(): string {
  const raw = process.env.PORTAL_URL;
  if (raw) {
    try {
      new URL(raw);
      return raw;
    } catch {
      console.error(`[middleware] Invalid PORTAL_URL: ${raw}, using default`);
    }
  }
  return "http://10.42.0.1/";
}

const PORTAL_URL = getPortalUrl();

const REDIRECT_PATHS = new Set([
  "/generate_204",
  "/gen_204",
  "/connecttest.txt",
  "/redirect",
  "/ncsi.txt",
  "/canonical.html",
  "/success.txt",
]);

const APPLE_PATHS = new Set([
  "/hotspot-detect.html",
  "/library/test/success.html",
]);

// ─── Auth ────────────────────────────────────────────────────────────────────

const PUBLIC_PREFIXES = [
  "/login",
  "/portal/",
  "/setup",
  "/setup-api/",
  "/login-api",
  "/_next/",
  "/fonts/",
  "/images/",
];

const PUBLIC_EXACT = new Set([
  "/manifest.json",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-32.png",
  "/clawbox-crab.png",
  "/clawbox-icon.png",
  "/clawbox-logo.png",
  "/portal",
  "/portal/subscribe",
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Verify HMAC-SHA256 session cookie using Web Crypto API (Edge Runtime compatible) */
async function verifySessionCookie(cookie: string): Promise<boolean> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const dotIdx = cookie.indexOf(".");
  if (dotIdx < 0) return false;
  const payload = cookie.substring(0, dotIdx);
  const sig = cookie.substring(dotIdx + 1);
  if (!payload || !sig) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    const expectedHex = bytesToHex(expected);

    // Constant-time comparison
    if (sig.length !== expectedHex.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    if (diff !== 0) return false;

    // Check expiration
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(decoded);
    return typeof data.exp === "number" && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// ─── Proxy ────────────────────────────────────────────────────────────────────

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname.toLowerCase();

  // 1. Captive portal detection
  if (REDIRECT_PATHS.has(pathname)) {
    return NextResponse.redirect(PORTAL_URL, 302);
  }
  if (APPLE_PATHS.has(pathname)) {
    return new NextResponse(
      "<!DOCTYPE html><HTML><HEAD><TITLE>ClawBox Setup</TITLE></HEAD><BODY>Please complete setup.</BODY></HTML>",
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  }

  // 2. Public paths — no auth needed
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // 3. If no session secret configured, auth is not active (pre-setup)
  if (!process.env.SESSION_SECRET) {
    return NextResponse.next();
  }

  // 4. Check session cookie
  const sessionCookie = request.cookies.get("clawbox_session")?.value;
  if (sessionCookie && await verifySessionCookie(sessionCookie)) {
    return NextResponse.next();
  }

  // 5. API requests get 401, page requests redirect to login
  const accept = request.headers.get("accept") || "";
  if (accept.includes("application/json") || pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Match all paths except static assets
    "/((?!_next/static|_next/image|fonts/|images/).*)",
  ],
};
