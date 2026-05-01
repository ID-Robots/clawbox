import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

// ─── Setup completion ────────────────────────────────────────────────────────
//
// While the wizard is still running there is no session cookie yet, so every
// /setup-api/* call would be 307'd to /login. We mirror config-store's
// CONFIG_ROOT resolution and treat "config.json missing" or "setup_complete
// not yet true" as the bootstrap window where /setup-api/* must pass through.
// Cached by mtime so the per-request hit is one stat() in the steady state.

const CONFIG_ROOT = process.env.CLAWBOX_ROOT
  || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
const CONFIG_PATH = path.join(CONFIG_ROOT, "data", "config.json");

let setupCompleteCache: { mtimeMs: number; value: boolean } | null = null;

function isSetupComplete(): boolean {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (setupCompleteCache && setupCompleteCache.mtimeMs === stat.mtimeMs) {
      return setupCompleteCache.value;
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { setup_complete?: unknown };
    const value = parsed.setup_complete === true;
    setupCompleteCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    // Missing/unreadable config = pre-setup. Cache the negative answer so we
    // don't statSync on every request before config.json is first written.
    setupCompleteCache = { mtimeMs: -1, value: false };
    return false;
  }
}

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
  "/setup",
  "/login-api",
  "/_next/",
  "/fonts/",
  "/images/",
];

// Endpoints the unauthenticated /login + /setup pages must reach before a
// session exists. Everything else under /setup-api/ requires a session
// once SESSION_SECRET is provisioned (i.e. post-setup); pre-setup the
// SESSION_SECRET short-circuit below keeps the wizard fully functional.
const PRE_AUTH_API_PATHS = new Set([
  "/setup-api/setup/status",
  // Hit by the clawbox-heartbeat.timer systemd unit every 5 min via curl
  // against loopback. The handler itself does no privileged work — it
  // just nudges the in-process portal-heartbeat helper, which only POSTs
  // to the portal when a `claw_*` token is already configured. Letting
  // it through pre-auth keeps the timer working on a freshly-booted
  // device before the user has logged in (or after they've logged out).
  "/setup-api/portal/heartbeat-tick",
]);

const PUBLIC_EXACT = new Set([
  "/manifest.json",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-32.png",
  "/clawbox-crab.png",
  "/clawbox-icon.png",
  "/clawbox-logo.png",
  "/portal/subscribe",
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (PRE_AUTH_API_PATHS.has(pathname)) return true;
  // Match each prefix on a path-segment boundary. Bare `startsWith("/setup")`
  // would also match `/setup-api/...` and silently expose every protected
  // setup-api route — that was the original auth-bypass.
  for (const prefix of PUBLIC_PREFIXES) {
    if (prefix.endsWith("/")) {
      if (pathname.startsWith(prefix)) return true;
    } else if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return true;
    }
  }
  return false;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Verify HMAC-SHA256 session cookie using Web Crypto API (available in Node 22+). */
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

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function middleware(request: NextRequest) {
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

  // 3a. Setup wizard bootstrap — production-server.js always provisions
  // SESSION_SECRET so the env-var short-circuit above never fires in real
  // deployments. While setup_complete is not yet true the wizard runs without
  // a session cookie; let it reach its API surface so it can configure WiFi,
  // run the updater, set the password, etc. Once setup completes the gate
  // closes and every /setup-api/* request requires a valid session.
  if (pathname.startsWith("/setup-api/") && !isSetupComplete()) {
    return NextResponse.next();
  }

  // 3b. Trusted-test-environment escape hatch for the e2e-install harness.
  // Scoped to /setup-api/* only — page requests still go through the
  // normal /login redirect so the login-round-trip spec can verify it.
  // Mirrors the convention src/lib/network.ts uses to skip hardware-only
  // nmcli paths; both are gated on the flag install.sh writes when it
  // boots under CLAWBOX_TEST_MODE.
  if (process.env.CLAWBOX_TEST_MODE === "1" && pathname.startsWith("/setup-api/")) {
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
  // Node runtime: middleware reads data/config.json to detect whether the
  // setup wizard has finished, which the Edge runtime can't do (no fs).
  runtime: "nodejs",
  matcher: [
    // Match all paths except static assets
    "/((?!_next/static|_next/image|fonts/|images/).*)",
  ],
};
