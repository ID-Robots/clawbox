import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { readEdition } from "@/lib/edition-source";

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

let configCache: { mtimeMs: number; setupComplete: boolean; sessionGen: number } | null = null;

function readConfigCached(): { setupComplete: boolean; sessionGen: number } {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (configCache && configCache.mtimeMs === stat.mtimeMs) return configCache;
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { setup_complete?: unknown; session_generation?: unknown };
    const setupComplete = parsed.setup_complete === true;
    const sessionGen = typeof parsed.session_generation === "number" && Number.isFinite(parsed.session_generation)
      ? parsed.session_generation
      : 0;
    configCache = { mtimeMs: stat.mtimeMs, setupComplete, sessionGen };
    return configCache;
  } catch {
    // Missing/unreadable config = pre-setup. Cache the negative answer so we
    // don't statSync on every request before config.json is first written.
    configCache = { mtimeMs: -1, setupComplete: false, sessionGen: 0 };
    return configCache;
  }
}

function isSetupComplete(): boolean {
  return readConfigCached().setupComplete;
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

// Sensitive /setup-api/* surfaces that must NEVER be reachable without a session
// (or the MCP bearer) — not even during the pre-setup wizard window. These are
// desktop-app / agent backends (file access, browser automation, the code
// workspace, the remote-desktop bridge, and the gateway-token endpoints) with
// no role in first-boot onboarding. The blanket pre-setup pass below used to
// expose them unauthenticated while the open `ClawBox-Setup` AP was up, turning
// otherwise-local issues into network-adjacent, pre-auth ones.
const PRE_AUTH_SENSITIVE_PREFIXES = [
  "/setup-api/files",
  "/setup-api/browser",
  "/setup-api/code",        // code workspace file ops / build (also /code/*)
  "/setup-api/code-server",
  "/setup-api/webapps",
  "/setup-api/vnc",
  "/setup-api/terminal",
  "/setup-api/clawkeep",    // backup restore/encryption/pairing — data-injection surface
  "/setup-api/tunnel",      // enabling remote tunnel access
  "/setup-api/portal",      // same privileged tunnel start/stop/enable as /tunnel
  "/setup-api/apps/install",
  "/setup-api/apps/uninstall",
  "/setup-api/apps/settings",  // privileged `openclaw config set skills.*` + credential writes
  "/setup-api/gateway/ws-config", // hands back the live gateway auth token
  // Hermes edition. During setup the device broadcasts an OPEN `ClawBox-Setup`
  // AP, so anything left pre-auth is reachable by anyone in radio range.
  //   - /hermes/chat runs a full agent turn with shell/tool access, unlimited.
  //   - /hermes/skills/* installs & uninstalls agent skills (code execution).
  //   - /harness/select rewrites which agent the device runs.
  // None of the three has any onboarding role: chat is only called from
  // ChatPopup, the skills store only from HermesSkillsStore (both desktop-only,
  // mounted from page.tsx), and the harness picker only from SettingsApp.
  //
  // Deliberately NOT listed — the wizard calls these BEFORE setup completes, so
  // gating them would make the Hermes SKU unprovisionable:
  //   /setup-api/harness/active         (AIModelsStep.tsx — the ONLY harness
  //                                      route the wizard touches; /status is
  //                                      HarnessPicker-only, so it is gated)
  //   /setup-api/hermes/models          (HermesProviderConfig + useHermesModelOptions)
  //   /setup-api/hermes/clawai          (ClawBox AI sign-in during onboarding)
  //   /setup-api/hermes/oauth           (provider OAuth status during onboarding)
  //   /setup-api/hermes/provider-key    (writes the provider key the wizard collects)
  // That is exactly the same pre-auth exposure the OpenClaw SKU already accepts
  // for /setup-api/ai-models/* on the same AP, and the read paths return status
  // booleans (hasToken/loggedIn), never the stored secrets.
  "/setup-api/hermes/chat",
  "/setup-api/hermes/skills",
  "/setup-api/harness/select",
  "/setup-api/harness/status",  // probes both harnesses; only the desktop picker calls it
];
// Exact-match only: a bare `/setup-api/gateway` subtree deny would also catch
// `/setup-api/gateway/health`, which the wizard's readiness check legitimately
// polls before setup completes. The SPA proxy at the bare path injects the
// gateway token into HTML, so it stays gated.
const PRE_AUTH_SENSITIVE_EXACT = new Set([
  "/setup-api/gateway",
]);

function isSensitiveSetupApi(pathname: string): boolean {
  // Normalize a trailing slash so `/setup-api/gateway/` can't dodge the exact
  // match (Next.js may not always redirect it before middleware runs).
  const p0 = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (PRE_AUTH_SENSITIVE_EXACT.has(p0)) return true;
  for (const p of PRE_AUTH_SENSITIVE_PREFIXES) {
    if (p0 === p || p0.startsWith(p + "/")) return true;
  }
  return false;
}

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

  // 3a. Setup wizard bootstrap — production-server.js always provisions
  // SESSION_SECRET so the env-var short-circuit above never fires in real
  // deployments. While setup_complete is not yet true the wizard runs without
  // a session cookie; let it reach its API surface so it can configure WiFi,
  // run the updater, set the password, etc. Once setup completes the gate
  // closes and every /setup-api/* request requires a valid session.
  if (pathname.startsWith("/setup-api/") && !isSetupComplete()) {
    // ...except the sensitive surfaces above, which stay gated even pre-setup
    // (they play no part in onboarding). They fall through to the session /
    // MCP-bearer checks below, so an authenticated caller still reaches them.
    if (!isSensitiveSetupApi(pathname)) {
      return NextResponse.next();
    }
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
