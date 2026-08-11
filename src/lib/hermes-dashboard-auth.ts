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
    // The caller's `init.signal` only covers `attempt()` below — login runs
    // before it and would otherwise be unbounded.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
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

// Fetch a dashboard API path with a valid session, re-logging in once on 401.
export async function dashboardFetch(apiPath: string, init?: RequestInit): Promise<Response> {
  if (!cachedCookie) cachedCookie = await loginWithBackoff();
  const attempt = () =>
    fetch(`${DASH_ORIGIN}${apiPath}`, {
      ...init,
      // Callers that don't bring their own deadline still get one — no request
      // from this module may be able to hang indefinitely.
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
