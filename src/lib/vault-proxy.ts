/**
 * ClawBox Vault's desktop app, as the web server hands it to the owner.
 *
 * WHAT. The vault is a service of its own on 127.0.0.1:4796 (vault/,
 * config/clawbox-vault.service) and never listens anywhere else. Its window on
 * the desktop is that service's own page, proxied here under
 * `/apps/clawbox-vault/` by src/app/apps/clawbox-vault/[[...path]]/route.ts.
 *
 * WHY NOT THE GENERIC APP PROXY (src/lib/app-proxy.ts). That one serves a
 * project's server inside a sandboxed frame with an opaque origin, so the
 * frame's own requests carry no cookie and the proxy lets them through without
 * one: fine for an app the owner wrote, wrong for the owner's passwords. This
 * route is the opposite on both counts. The page is ClawBox's own code, served
 * same-origin, so every request it makes carries the session cookie, and every
 * request is refused unless that cookie is the OWNER's.
 *
 * WHAT IT REACHES. Only the desktop app's half of the service: its page, its
 * three static files, the health check and `/api/ui/*` (which the service
 * itself guards with the vault PIN). The extension's API, the agent's API and
 * the pairing routes are for callers on the box and are not proxied at all, so
 * nothing on the network can ask for a pairing token or a fill.
 *
 * Pure: no `fs`, no Next. The route does the I/O; vault-proxy.test.ts judges
 * exactly these tables.
 */

/** The desktop app id (src/lib/desktop-apps.ts) and the proxied tree. */
export const VAULT_DESKTOP_APP_ID = "vault";
export const VAULT_PROXY_PREFIX = "/apps/clawbox-vault";
export const VAULT_DEFAULT_PORT = 4796;

/** The largest body the vault's own API reads (vault/src/server/http.ts). */
export const VAULT_MAX_BODY_BYTES = 64 * 1024;

export const VAULT_PROXY_METHODS: readonly string[] = ["GET", "HEAD", "POST", "DELETE"];

const STATIC_PATHS: ReadonlySet<string> = new Set(["/", "/index.html", "/app.js", "/app.css", "/favicon.png"]);

/** `/api/ui/status`, `/api/ui/card-reveal`, `/api/ui/pairing/auto`: lower-case words, at most two deep. */
const UI_API_RE = /^\/api\/ui\/[a-z][a-z-]{0,39}(\/[a-z][a-z-]{0,39})?$/;

/** The vault service's port: the unit's default unless the box sets another. */
export function vaultServicePort(env: Record<string, string | undefined> = process.env): number {
  const port = Number(env.CLAWBOX_VAULT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : VAULT_DEFAULT_PORT;
}

/**
 * The path on the vault service for a request under `/apps/clawbox-vault`, or
 * null when that path is not the desktop app's to ask for. Exact strings only:
 * a path with an encoded character, a dot segment or a doubled slash is not on
 * the list and so is refused rather than normalised.
 */
export function vaultUpstreamPath(pathname: string): string | null {
  if (pathname !== VAULT_PROXY_PREFIX && !pathname.startsWith(`${VAULT_PROXY_PREFIX}/`)) return null;
  const rest = pathname.slice(VAULT_PROXY_PREFIX.length) || "/";
  if (STATIC_PATHS.has(rest) || rest === "/api/health" || UI_API_RE.test(rest)) return rest;
  return null;
}

/**
 * What goes on to the service: the vault's own session token (the page sends
 * it as a bearer after the PIN unlocked it) and the body's type. Never the
 * ClawBox cookie, which the service has no use for, and never Origin or Host:
 * the service is asked as a local client, which is what this proxy is.
 */
export function vaultRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const name of ["authorization", "content-type", "accept"]) {
    const value = incoming.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

/**
 * What comes back to the browser. The service's own policy headers are kept
 * (its page allows scripts and styles from itself only), and the page may be
 * framed by this origin alone: the desktop's window, nothing else.
 */
export function vaultResponseHeaders(upstream: Headers): Headers {
  const out = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  for (const name of ["content-type", "retry-after"]) {
    const value = upstream.get(name);
    if (value) out.set(name, value);
  }
  const csp = upstream.get("content-security-policy");
  if (csp) out.set("content-security-policy", /frame-ancestors/i.test(csp) ? csp : `${csp}; frame-ancestors 'self'`);
  return out;
}
