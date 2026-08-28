import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { readEdition } from "@/lib/edition-source";
import { isBootstrapAllowedPath } from "@/lib/setup-api-gate";

// ─── Setup completion ────────────────────────────────────────────────────────
//
// Before the owner has set a password there is no session cookie to have, so a
// narrow allow-list of wizard routes must pass through unauthenticated. We
// mirror config-store's CONFIG_ROOT resolution to read that state. Cached by
// mtime so the per-request hit is one stat() in the steady state.

const CONFIG_ROOT = process.env.CLAWBOX_ROOT
  || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
const CONFIG_PATH = path.join(CONFIG_ROOT, "data", "config.json");

interface ConfigSnapshot {
  mtimeMs: number;
  setupComplete: boolean;
  passwordConfigured: boolean;
  sessionGen: number;
}

let configCache: ConfigSnapshot | null = null;

function readConfigCached(): ConfigSnapshot {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (configCache && configCache.mtimeMs === stat.mtimeMs) return configCache;
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      setup_complete?: unknown;
      password_configured?: unknown;
      session_generation?: unknown;
    };
    const sessionGen = typeof parsed.session_generation === "number" && Number.isFinite(parsed.session_generation)
      ? parsed.session_generation
      : 0;
    configCache = {
      mtimeMs: stat.mtimeMs,
      setupComplete: parsed.setup_complete === true,
      passwordConfigured: parsed.password_configured === true,
      sessionGen,
    };
    return configCache;
  } catch (err) {
    // A config.json that is genuinely ABSENT is a first-boot device: the
    // bootstrap window has to open or the wizard can never run.
    //
    // A config.json that EXISTS but won't parse is a different animal — a
    // provisioned box with a corrupt or truncated file, or one an attacker
    // just clobbered. Treating that as "pre-setup" is fail-OPEN and hands
    // back the whole unauthenticated window on a device that has an owner
    // (TASK-446, crit11 note). Fail closed instead: assume set up and
    // password-configured, so everything needs a session.
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    configCache = {
      mtimeMs: -1,
      setupComplete: !missing,
      passwordConfigured: !missing,
      sessionGen: 0,
    };
    return configCache;
  }
}

/**
 * The first-boot bootstrap window: no owner credential exists yet, so a subset
 * of /setup-api/* (see src/lib/setup-api-gate.ts) is reachable without a
 * session because there is no session to have.
 *
 * Gated on `password_configured`, NOT on `setup_complete`. The old gate used
 * setup_complete alone, which meant a box that had set a password but not
 * finished (or resumed) the wizard — and, after the factory-reset incident, a
 * box whose config.json had simply lost the key — served setup/reset,
 * update/run, system/power and install/run-step to anyone on the open AP.
 * Once a password exists there is someone to log in as, so the window shuts.
 *
 * `password_configured` here is the config-store flag only; middleware is a
 * synchronous hot path and cannot shell out to `passwd -S` per request. The
 * handlers that care about config-vs-shadow drift (system/credentials) resolve
 * the authoritative answer themselves via src/lib/system-password.ts.
 */
function isBootstrapWindowOpen(): boolean {
  const cfg = readConfigCached();
  return !cfg.setupComplete && !cfg.passwordConfigured;
}

// Current session generation — bumped on password change to revoke every cookie
// minted earlier (see src/lib/auth.ts). Defaults to 0, so cookies are only ever
// rejected here once a password change has actually happened.
function currentSessionGeneration(): number {
  return readConfigCached().sessionGen;
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
  "/login-api",
  "/_next/",
  "/fonts/",
  "/images/",
];

// The wizard PAGE. Public only while the device has no owner credential — the
// same window its API surface is open in.
//
// Once a password exists, a half-finished or resumed wizard has to log in
// first. That isn't just tidiness: it is what makes the API allow-list
// survivable. CredentialsStep's password POST hands back a session cookie, so
// steps 4-5 (AI models, Telegram, setup/complete) run authenticated and need no
// pre-auth carve-out at all. A user who comes back in a fresh browser gets
// /login?redirect=/setup and lands right back on the step they left.
const WIZARD_PAGE_PREFIX = "/setup";

function isWizardPagePath(pathname: string): boolean {
  return pathname === WIZARD_PAGE_PREFIX || pathname.startsWith(WIZARD_PAGE_PREFIX + "/");
}

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

// Loopback proxy paths used by openclaw (a separate process with no session
// cookie) to reach llama.cpp / Ollama through Next.js. The proxy routes
// enforce their own service-to-service bearer-token check via
// `verifyLocalAiBearer` in src/lib/local-ai-proxy.ts, so the session gate
// here would only break openclaw without adding any real security: a stale
// 401 from middleware just trips openclaw's auth-failure cooldown and
// kills every chat turn against a local model.
const LOOPBACK_PROXY_PREFIXES = [
  "/setup-api/local-ai/llamacpp",
  "/setup-api/local-ai/ollama",
];

// Which /setup-api/* routes are reachable during the first-boot bootstrap
// window lives in src/lib/setup-api-gate.ts as an ALLOW-list. See that file for
// why the previous deny-list (`PRE_AUTH_SENSITIVE_PREFIXES`) was inverted:
// every route nobody remembered to name was served unauthenticated on the open
// `ClawBox-Setup` AP, which is how setup/reset, update/run, system/power and
// install/run-step ended up pre-auth (TASK-443/446).

// Paths that exist ONLY because next.config.ts rewrites them to the OpenClaw
// gateway (see the edition check in the middleware body).
const GATEWAY_ONLY_EXACT = new Set(["/favicon.svg", "/favicon-32.png"]);
const GATEWAY_ONLY_PREFIXES = ["/api", "/assets"];

function isGatewayOnlyPath(pathname: string): boolean {
  if (GATEWAY_ONLY_EXACT.has(pathname)) return true;
  return GATEWAY_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const PUBLIC_EXACT = new Set([
  "/manifest.json",
  // The service worker script. A browser that once registered /sw.js re-fetches
  // it on navigations to look for an update — and treats a redirect (to /login)
  // as "no update", so an old worker with its cache-first rules stayed in
  // charge forever and the desktop kept showing the previous build. The file
  // is public by nature (it is what every visitor already holds).
  "/sw.js",
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
  // `/setup-api/...` also starts with `/setup`, so this must not be a bare
  // prefix test — isWizardPagePath matches on a segment boundary.
  if (isWizardPagePath(pathname) && isBootstrapWindowOpen()) return true;
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
  for (const prefix of LOOPBACK_PROXY_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return true;
  }
  return false;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Verify HMAC-SHA256 session cookie using Web Crypto API (available in Node 22+). */
async function verifySessionCookie(cookie: string, expectedGen: number): Promise<boolean> {
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
    if (typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return false;
    // Reject cookies from before the last password change (session revocation).
    if ((typeof data.gen === "number" ? data.gen : 0) !== expectedGen) return false;
    return true;
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

  // 1b. Gateway paths on a Hermes device.
  //
  // next.config.ts rewrites /api/*, /assets/* and the two gateway favicons to
  // the OpenClaw gateway at 127.0.0.1:18789. On the Hermes SKU that gateway is
  // disabled+masked, so every one of those requests 502s. The rewrites can't be
  // made conditional there: they are compiled into routes-manifest.json at
  // BUILD time, install.sh builds via `su - clawbox` (which drops
  // CLAWBOX_EDITION) and before the edition lock is baked — a build-time gate
  // would evaluate on the wrong value. Middleware runs before beforeFiles
  // rewrites (verified on-device: /api/zzz answered 401 from here, never the
  // gateway), always sees the current edition, and survives a stale build.
  //
  // Nothing on the ClawBox side owns these paths: there is no src/app/api, no
  // /assets route, and public/ has neither favicon.svg nor favicon-32.png.
  if (isGatewayOnlyPath(pathname) && readEdition() === "hermes") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  // 2. Public paths — no auth needed
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // 3. If no session secret configured, auth is not active (pre-setup)
  if (!process.env.SESSION_SECRET) {
    return NextResponse.next();
  }

  // 3a. First-boot bootstrap — production-server.js always provisions
  // SESSION_SECRET so the env-var short-circuit above never fires in real
  // deployments. While the device has no owner credential the wizard runs
  // without a session cookie, so the handful of routes steps 1-3 need are let
  // through; everything else falls to the session / MCP-bearer checks below.
  //
  // Two changes from the old gate, both load-bearing (TASK-443):
  //   - ALLOW-list, not deny-list. The default is now 401.
  //   - keyed on `password_configured`, not `setup_complete`. A box that has a
  //     password but an unfinished wizard is a box with an owner.
  if (pathname.startsWith("/setup-api/") && isBootstrapWindowOpen()) {
    if (isBootstrapAllowedPath(pathname)) {
      return NextResponse.next();
    }
  }

  // 3b. Trusted-test-environment escape hatch for the e2e-install harness.
  // Scoped to /setup-api/* and the wizard page — every other page request
  // still goes through the normal /login redirect so the login-round-trip
  // spec can verify it. The harness drives the wizard past the password step
  // over plain HTTP with no cookie jar, which the session gate on /setup
  // would otherwise stop.
  // Mirrors the convention src/lib/network.ts uses to skip hardware-only
  // nmcli paths; both are gated on the flag install.sh writes when it
  // boots under CLAWBOX_TEST_MODE.
  if (
    process.env.CLAWBOX_TEST_MODE === "1"
    && (pathname.startsWith("/setup-api/") || isWizardPagePath(pathname))
  ) {
    return NextResponse.next();
  }

  // 3c. MCP server bearer-token bypass. The ClawBox MCP runs as a stdio
  // subprocess of openclaw (mcp/clawbox-mcp.ts) and has no session
  // cookie, so every /setup-api/* fetch it makes would be 307'd to
  // /login without this carve-out — POSTs surface as 405, GETs return
  // HTML that JSON.parse chokes on. Mirrors the local-ai-proxy pattern:
  // service-to-service auth via a per-install bearer (see
  // src/lib/mcp-token.ts), scoped to /setup-api/* only so the dashboard
  // and login flow still go through the normal session gate.
  if (pathname.startsWith("/setup-api/")) {
    const authHeader = request.headers.get("authorization");
    if (authHeader && verifyMcpBearer(authHeader)) {
      return NextResponse.next();
    }
  }

  // 4. Check session cookie
  const sessionCookie = request.cookies.get("clawbox_session")?.value;
  if (sessionCookie && await verifySessionCookie(sessionCookie, currentSessionGeneration())) {
    return NextResponse.next();
  }

  // 5. Auth failed — choose a JSON 401 or an HTML login redirect.
  //
  // Everything under /setup-api/* (and /api/*) is an API surface consumed by
  // fetch()/XHR that parses the body as JSON. A raw fetch() sends
  // `Accept: */*`, so the old `accept.includes("application/json")` gate missed
  // it and fell through to the login *redirect* — whose HTML body then made the
  // caller's `.json()` throw on an expired session. #231/#303 patched this one
  // caller at a time; return a JSON 401 for the whole prefix instead so every
  // caller (~30 across ~15 files) gets a structured 401 it can detect, with no
  // client changes (#304).
  //
  // Deliberate trade-off: a few /setup-api/* routes are loaded by direct
  // browser navigation/embedding (webapps?app= iframes, apps/icon/[appId]
  // <img>, file downloads) rather than fetch(), and now get a 401 too instead
  // of a login page. That's fine — a login page rendered inside an <img> or a
  // download stream is useless anyway, and the desktop shell drives the real
  // re-login. Genuine top-level page navigations (no /setup-api/ or /api/
  // prefix) still redirect below.
  const accept = request.headers.get("accept") || "";
  if (
    pathname.startsWith("/setup-api/") ||
    pathname.startsWith("/api/") ||
    accept.includes("application/json")
  ) {
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
