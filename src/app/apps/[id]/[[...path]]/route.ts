import { NextRequest, NextResponse } from "next/server";
import { APP_PROXY_CSP, resolveAppProxyTarget } from "@/lib/app-proxy";

export const dynamic = "force-dynamic";

/**
 * `/apps/<id>/…` → `http://127.0.0.1:<port>/apps/<id>/…` — a registered
 * project's own server, reached on the box's origin so its link works from
 * any host the desktop is viewed from (see src/lib/app-proxy.ts for the why,
 * the listener check and the containment). Every method; the body streamed
 * both ways; redirects handed back to the browser rather than followed on
 * its behalf; the sandbox on every response.
 */

/** Hop-by-hop headers, never forwarded in either direction. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
/** How long the app has to ANSWER — its headers. The body streams for as long as it likes (a download, an event stream); only the client going away ends it. */
const HEADERS_TIMEOUT_MS = 120_000;

function plain(text: string, status: number): NextResponse {
  return new NextResponse(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": APP_PROXY_CSP } });
}

async function proxy(request: NextRequest, params: Promise<{ id: string; path?: string[] }>): Promise<Response> {
  const { id } = await params;
  const resolved = await resolveAppProxyTarget(id);
  if (!resolved.ok) return plain(resolved.detail, resolved.reason === "unregistered" ? 404 : 502);
  const { target } = resolved;
  const incoming = request.nextUrl;
  const prefix = `/apps/${id}`;
  const upstreamPath = target.stripBasePath
    ? (incoming.pathname.slice(prefix.length) || "/")
    : incoming.pathname;
  const url = `http://127.0.0.1:${target.port}${upstreamPath}${incoming.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return;
    // The owner's session never reaches the app: it is the desktop's, and a
    // document served here has an opaque origin that could not use one anyway.
    if (key === "cookie") return;
    headers.set(key, value);
  });
  headers.set("host", `127.0.0.1:${target.port}`);
  headers.set("x-forwarded-host", request.headers.get("host") ?? incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  headers.set("x-forwarded-prefix", prefix);

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

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return;
    // Framed by the desktop on purpose; the app's own refusal to be framed
    // would blank the window.
    if (key === "x-frame-options") return;
    if (key === "content-length" && upstream.headers.get("content-encoding")) return;
    out.append(key, value);
  });
  // The containment (see app-proxy.ts): an opaque origin for EVERY response
  // — a document whatever its declared type says, and it costs an asset
  // nothing — appended to whatever policy the app set for itself.
  out.append("content-security-policy", APP_PROXY_CSP);
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
