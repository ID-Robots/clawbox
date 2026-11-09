import { NextRequest, NextResponse } from "next/server";
import {
  APP_API_PREFLIGHT_MAX_AGE_S,
  APP_API_PREFLIGHT_METHODS,
  APP_PROXY_CSP,
  NEXT_ROUTER_PREFLIGHT_METHODS,
  appProxyAllowOrigin,
  appUpstreamOrigin,
  exposeAllHeaders,
  isAppApiPath,
  isDocumentRequest,
  isNextRouterPreflight,
  isNextRouterRequest,
  mergeExposedHeaders,
  resolveAppProxyTarget,
  type AppProxyResolution,
} from "@/lib/app-proxy";
import { appStartFailureHtml, appStartFailureText, readAppStartFailure } from "@/lib/app-start-failure";
import { hasOwnerSession } from "@/lib/owner-session";
import { APP_PROXY_NEXT_URL_HEADER } from "@/lib/app-window";

export const dynamic = "force-dynamic";

/**
 * `/apps/<id>/…` → `http://127.0.0.1:<port>/apps/<id>/…` — a registered
 * project's own server, reached on the box's origin so its link works from
 * any host the desktop is viewed from (see src/lib/app-proxy.ts for the why,
 * the listener check and the containment). Every method; the body streamed
 * both ways; redirects handed back to the browser rather than followed on
 * its behalf; the sandbox on every response — and, for the app's own `/api`
 * tree and the Next.js App Router's own fetches, the CORS answer that
 * sandbox makes necessary.
 */

/** Hop-by-hop headers, never forwarded in either direction. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
/**
 * The encodings Node's fetch unwraps for us before `upstream.body` is read.
 *
 * This is the other half of the blank window. `fetch` decompresses a response
 * it understands, so the bytes we relay are PLAIN — and forwarding the
 * `content-encoding` that came with them tells the browser to gunzip text
 * that is already text: ERR_CONTENT_DECODING_FAILED, an asset that never
 * arrives, and an empty `#root` with nothing on screen to say why. The
 * request below asks the app for `identity` (this hop is loopback, so
 * compressing it buys nothing), and anything that answers with an encoding
 * regardless has that header dropped alongside its now-wrong content-length.
 * An encoding NOT on this list was not touched by fetch and is passed
 * through with its header intact.
 */
const DECODED_BY_FETCH = new Set(["gzip", "deflate", "br", "zstd", "x-gzip"]);
/** How long the app has to ANSWER — its headers. The body streams for as long as it likes (a download, an event stream); only the client going away ends it. */
const HEADERS_TIMEOUT_MS = 120_000;

function plain(text: string, status: number): NextResponse {
  return new NextResponse(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": APP_PROXY_CSP } });
}

/**
 * A window loading the app's page — a document the middleware let through
 * only with a session (the caller checks it is the OWNER's) — as opposed to
 * one of the app's own fetches, which reach this route with no session at all
 * (src/middleware.ts, step 2b): those, and anything from the sandbox's opaque
 * origin, never get the page, whose lines are the app's own output.
 */
function ownerWindow(request: NextRequest): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (isNextRouterRequest(request.headers) || request.headers.get("origin") === "null") return false;
  return isDocumentRequest(request.headers);
}

/**
 * An app the proxy cannot reach. When its last start failed (it was never
 * registered, or it is registered and nothing listens), the answer says so as
 * a 503: the owner's window gets a page with what failed and the end of what
 * it printed (src/lib/app-start-failure.ts), anything else one sentence that
 * names nothing of it. That
 * used to be the 404 "No app is served under this name" for every window,
 * reopen and App Router fetch of a Store app whose own build failed
 * (TASK-2323). Otherwise the listener's own refusal, as before.
 */
async function unreachable(request: NextRequest, id: string, resolved: Exclude<AppProxyResolution, { ok: true }>): Promise<Response> {
  if (resolved.reason === "unregistered" || resolved.reason === "not_listening") {
    const failure = await readAppStartFailure(id);
    if (failure) {
      // The page is the app's own output: the owner's alone. A signed-in
      // user of the box who is not the owner gets the sentence.
      if (!ownerWindow(request) || !(await hasOwnerSession(request))) return plain(appStartFailureText(failure), 503);
      const html = await appStartFailureHtml(failure);
      return new NextResponse(request.method.toUpperCase() === "HEAD" ? null : html, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": APP_PROXY_CSP, "cache-control": "no-store" },
      });
    }
  }
  return plain(resolved.detail, resolved.reason === "unregistered" ? 404 : 502);
}

async function proxy(request: NextRequest, params: Promise<{ id: string; path?: string[] }>): Promise<Response> {
  const { id } = await params;
  const resolved = await resolveAppProxyTarget(id);
  if (!resolved.ok) return unreachable(request, id, resolved);
  const { target } = resolved;
  const incoming = request.nextUrl;
  const prefix = `/apps/${id}`;
  const rest = incoming.pathname.slice(prefix.length) || "/";
  const upstreamPath = target.stripBasePath ? rest : incoming.pathname;
  const url = `http://127.0.0.1:${target.port}${upstreamPath}${incoming.search}`;
  const apiPath = isAppApiPath(rest);
  const routerFetch = isNextRouterRequest(request.headers);
  const requestOrigin = request.headers.get("origin");

  // A preflight from the app's own sandboxed document for its own API (see
  // appProxyAllowOrigin) or for one of the App Router's fetches — a
  // client-side navigation, a server action (NEXT_ROUTER_REQUEST_HEADERS):
  // answered here, so an app whose server never heard of OPTIONS still works
  // from inside the frame. Any other preflight goes to the app as before.
  const routerPreflight = !apiPath && isNextRouterPreflight(request.headers);
  if (request.method.toUpperCase() === "OPTIONS" && (apiPath || routerPreflight) && requestOrigin === "null" && request.headers.has("access-control-request-method")) {
    const headers = new Headers({
      "access-control-allow-origin": "null",
      "access-control-allow-methods": apiPath ? APP_API_PREFLIGHT_METHODS : NEXT_ROUTER_PREFLIGHT_METHODS,
      "access-control-allow-headers": request.headers.get("access-control-request-headers") || "Content-Type, Range, Accept, Authorization, X-Requested-With",
      "access-control-max-age": String(APP_API_PREFLIGHT_MAX_AGE_S),
      vary: "Origin",
      "content-security-policy": APP_PROXY_CSP,
    });
    return new NextResponse(null, { status: 204, headers });
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return;
    // The owner's session never reaches the app: it is the desktop's, and a
    // document served here has an opaque origin that could not use one anyway.
    if (key === "cookie") return;
    // The App Router's Next-Url, which the box's Next.js deleted before this
    // handler ran: back under its own name (src/lib/app-window.ts).
    if (key === APP_PROXY_NEXT_URL_HEADER) {
      if (!request.headers.has("next-url")) headers.set("next-url", value);
      return;
    }
    headers.set(key, value);
  });
  headers.set("host", `127.0.0.1:${target.port}`);
  // Loopback: compressing this hop costs CPU and saves nothing, and an
  // uncompressed answer is one the relay below cannot mislabel.
  headers.set("accept-encoding", "identity");
  const forwardedHost = request.headers.get("host") ?? incoming.host;
  const forwardedProto = incoming.protocol.replace(":", "");
  headers.set("x-forwarded-host", forwardedHost);
  headers.set("x-forwarded-proto", forwardedProto);
  headers.set("x-forwarded-prefix", prefix);
  // A server action from the sandboxed document says `Origin: null`, which
  // Next.js refuses; see appUpstreamOrigin.
  const upstreamOrigin = appUpstreamOrigin(requestOrigin, request.headers, forwardedHost, forwardedProto);
  if (upstreamOrigin !== null) headers.set("origin", upstreamOrigin);

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  // One controller, two reasons to abort: the app not answering in time
  // (cleared the moment its headers arrive — the body is never cut for
  // being long), and the client going away (kept for the body's lifetime).
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(new Error("headers timeout")), HEADERS_TIMEOUT_MS);
  const onClientAbort = () => control.abort(new Error("client went away"));
  request.signal?.addEventListener("abort", onClientAbort, { once: true });
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      // A streamed request body needs this in Node's fetch.
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
      signal: control.signal,
    } as RequestInit);
  } catch (err) {
    clearTimeout(timer);
    const detail = err instanceof Error ? err.message : String(err);
    return plain(`The app's server on port ${target.port} did not answer (${detail}). Start it in its project folder — its clawbox.json says how.`, 502);
  }
  clearTimeout(timer);

  const upstreamEncoding = (upstream.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const bodyWasDecoded = upstreamEncoding !== "" && upstreamEncoding.split(",").every((part) => DECODED_BY_FETCH.has(part.trim()));
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return;
    // Framed by the desktop on purpose; the app's own refusal to be framed
    // would blank the window.
    if (key === "x-frame-options") return;
    // No cookie of the app's comes back here (every Cookie header is stripped
    // on the way in), so a Set-Cookie could only write the BOX's cookie jar —
    // `clawbox_session` included: one answer to a page the window reopened
    // with the owner's session could sign the owner out, or sit a cookie of
    // that name beside theirs. None go out.
    if (key === "set-cookie") return;
    // Both describe bytes that no longer exist once fetch has unwrapped them.
    // An encoding it did NOT unwrap keeps both: those bytes are still the
    // upstream's, the length is still true, and dropping it would take the
    // total off a download's progress bar for nothing.
    if (bodyWasDecoded && (key === "content-encoding" || key === "content-length")) return;
    out.append(key, value);
  });
  // The containment (see app-proxy.ts): an opaque origin for EVERY response
  // — a document whatever its declared type says, and it costs an asset
  // nothing — appended to whatever policy the app set for itself.
  out.append("content-security-policy", APP_PROXY_CSP);
  // …and the CORS that sandbox makes necessary: the document's origin is
  // `null`, so its module scripts and `crossorigin` stylesheets are CORS
  // fetches the app's server was never asked to answer (see
  // appProxyAllowOrigin). Vary on Origin, since the answer now depends on it.
  const allowOrigin = appProxyAllowOrigin(requestOrigin, out.get("access-control-allow-origin"), out.get("content-type"), apiPath || routerFetch);
  if (allowOrigin) {
    out.set("access-control-allow-origin", allowOrigin);
    const vary = out.get("vary");
    if (!vary) out.set("vary", "Origin");
    else if (!/(^|,)\s*origin\s*(,|$)/i.test(vary)) out.set("vary", `${vary}, Origin`);
  }
  // The app's API: a media player reads Content-Range off a 206, a list its
  // paging headers — none of which a CORS response exposes by default.
  // Whenever the final answer lets the requesting origin read it (our grant
  // or the app's own), those headers are exposed too, merged into any list
  // the app sent rather than replacing it or being skipped because of it.
  const finalAllow = out.get("access-control-allow-origin")?.trim();
  if (apiPath && requestOrigin && (finalAllow === "*" || finalAllow === requestOrigin)) {
    out.set("access-control-expose-headers", mergeExposedHeaders(out.get("access-control-expose-headers")));
  }
  // The App Router reads its own headers off the answer; our grant exposes
  // them all (exposeAllHeaders). An answer the app made itself is left alone.
  else if (routerFetch && allowOrigin) {
    out.set("access-control-expose-headers", exposeAllHeaders(out.get("access-control-expose-headers")));
  }
  return new NextResponse(method === "HEAD" ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

type Ctx = { params: Promise<{ id: string; path?: string[] }> };
export const GET = (request: NextRequest, ctx: Ctx) => proxy(request, ctx.params);
export const HEAD = (request: NextRequest, ctx: Ctx) => proxy(request, ctx.params);
export const POST = (request: NextRequest, ctx: Ctx) => proxy(request, ctx.params);
export const PUT = (request: NextRequest, ctx: Ctx) => proxy(request, ctx.params);
export const PATCH = (request: NextRequest, ctx: Ctx) => proxy(request, ctx.params);
export const DELETE = (request: NextRequest, ctx: Ctx) => proxy(request, ctx.params);
export const OPTIONS = (request: NextRequest, ctx: Ctx) => proxy(request, ctx.params);
