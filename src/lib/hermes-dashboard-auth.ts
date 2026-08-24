import fs from "fs/promises";
import path from "path";

// Server-side helper to call the Hermes dashboard's own API (127.0.0.2:9119)
// from a ClawBox setup-api route, authenticated the same way the reverse proxy
// does: log in with the server-side dashboard password, then reuse the session
// cookies. Lets us read Hermes' native provider-OAuth status without exposing
// the (cross-origin, gated) dashboard API to the browser.
//
// The dashboard binds 127.0.0.2 (non-loopback → gated cookie auth). undici sets
// the Host header to that authority automatically, satisfying the dashboard's
// DNS-rebind guard.

const DASH_HOST = process.env.HERMES_DASH_HOST || "127.0.0.2";
const DASH_PORT = process.env.HERMES_PORT || "9119";
const DASH_ORIGIN = `http://${DASH_HOST}:${DASH_PORT}`;
const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const USERNAME = process.env.HERMES_DASH_USERNAME || "clawbox";

let cachedCookie: string | null = null;
// Same guard as scripts/hermes-dashboard-proxy.js: when the dashboard is down or
// the stored password is out of sync, a failed login per call would double every
// request's latency against a dead socket. Back off instead of re-trying hot.
let loginFailedAt = 0;
const LOGIN_RETRY_COOLDOWN_MS = 10_000;
// Node's fetch has NO default request timeout. A dashboard that accepts the TCP
// connection but never answers (paused / half-dead process — exactly the failure
// the callers' SWR layers exist to survive) would otherwise hang this promise
// forever, and hermes-model-options' single-flight would then hand that dead
// promise to every later caller until the server is restarted. Every request
// this module issues is therefore bounded.
const REQUEST_TIMEOUT_MS = 8_000;
// Every request below sets this. Node's fetch defaults to "follow", which makes
// a redirect invisible to the caller — the response that comes back is the one
// from wherever Location pointed, not from the path we asked for, and a
// redirected request can carry its body and headers there. Resolving redirects
// manually keeps each call's answer the answer to the call it made: a 3xx from
// the dashboard means the request did not reach the API, which is what the
// callers below already treat as "not signed in". Same rule and same reason as
// mcp/lib/api.ts.
const REDIRECT_POLICY = "manual";

async function readPassword(): Promise<string> {
  try {
    return (await fs.readFile(path.join(CLAWBOX_ROOT, "data", ".hermes-dashboard-pw"), "utf8")).trim();
  } catch {
    return "";
  }
}

async function login(): Promise<string | null> {
  const pw = await readPassword();
  if (!pw) return null;
  const res = await fetch(`${DASH_ORIGIN}/auth/password-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "basic", username: USERNAME, password: pw, next: "/" }),
    redirect: REDIRECT_POLICY,
    // The caller's `init.signal` only covers `attempt()` below — login runs
    // before it and would otherwise be unbounded.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // A redirect here is not a login: the cookies are read off THIS response, so
  // treat anything that is not a 2xx as "no session".
  if (!res.ok) return null;
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(";", 1)[0]).filter(Boolean).join("; ");
  return cookie || null;
}

async function loginWithBackoff(): Promise<string | null> {
  if (Date.now() - loginFailedAt < LOGIN_RETRY_COOLDOWN_MS) return null;
  const cookie = await login().catch(() => null);
  loginFailedAt = cookie ? 0 : Date.now();
  return cookie;
}

/**
 * A single-use ticket for a dashboard WebSocket upgrade, or null.
 *
 * A browser cannot put an Authorization header on a WebSocket handshake, so the
 * dashboard mints a 30-second single-use ticket for the authenticated session
 * and takes it as `?ticket=` on the upgrade. Server-side callers are in the same
 * position for a different reason — the socket is opened by a library that
 * speaks the handshake itself — so they use the same door the SPA does.
 *
 * Minted per connection, never cached: the store consumes it on first use, so a
 * kept copy is worth nothing to a second connection and everything to a leak.
 */
export async function dashboardWsTicket(signal?: AbortSignal): Promise<string | null> {
  const res = await dashboardFetch("/api/auth/ws-ticket", { method: "POST", ...(signal ? { signal } : {}) }).catch(
    () => null,
  );
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { ticket?: unknown } | null;
  return typeof body?.ticket === "string" && body.ticket ? body.ticket : null;
}

/** Where the dashboard's WebSocket endpoints live, for a caller that opens one. */
export const DASHBOARD_WS_ORIGIN = `ws://${DASH_HOST}:${DASH_PORT}`;

// Fetch a dashboard API path with a valid session, re-logging in once on 401.
export async function dashboardFetch(apiPath: string, init?: RequestInit): Promise<Response> {
  if (!cachedCookie) cachedCookie = await loginWithBackoff();
  const attempt = () =>
    fetch(`${DASH_ORIGIN}${apiPath}`, {
      ...init,
      redirect: REDIRECT_POLICY,
      // No request from this module may be able to hang indefinitely — and a
      // caller that brings its own signal used to REPLACE that guarantee
      // rather than add to it, so the one call that forwards a signal
      // (`dashboardWsTicket`) was the one call with no deadline at all. Both
      // now apply: whichever fires first ends the request.
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...(init?.headers || {}), cookie: cachedCookie || "" },
    });
  let res = await attempt();
  if (res.status === 401) {
    // Session expired or the dashboard rotated its signing secret on restart.
    const fresh = await loginWithBackoff();
    if (fresh) {
      cachedCookie = fresh;
      res = await attempt();
    }
  }
  return res;
}
