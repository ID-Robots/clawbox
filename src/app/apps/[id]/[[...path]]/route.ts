import { NextRequest, NextResponse } from "next/server";
import { APP_PROXY_CSP, resolveAppProxyTarget } from "@/lib/app-proxy";

export const dynamic = "force-dynamic";

/**
 * `/apps/<id>/…` → `http://127.0.0.1:<port>/apps/<id>/…` — a project's own
 * server, reached on the box's origin so its link works from any host the
 * desktop is viewed from (see src/lib/app-proxy.ts for the why and the
 * containment). Every method; the body streamed both ways; redirects handed
 * back to the browser rather than followed on its behalf.
 */

/** Hop-by-hop headers, never forwarded in either direction. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const UPSTREAM_TIMEOUT_MS = 120_000;

async function proxy(request: NextRequest, params: Promise<{ id: string; path?: string[] }>): Promise<Response> {
  const { id } = await params;
  const target = await resolveAppProxyTarget(id);
  if (!target) {
    return new NextResponse("No app is served under this name. A project declares its server's port in clawbox.json.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
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
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      // A streamed request body needs this in Node's fetch.
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    } as RequestInit);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return new NextResponse(`The app's server on port ${target.port} did not answer (${detail}). Start it in its project folder — its clawbox.json says how.`, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return;
    // Framed by the desktop on purpose; the app's own refusal to be framed
    // would blank the window.
    if (key === "x-frame-options") return;
    if (key === "content-length" && upstream.headers.get("content-encoding")) return;
    out.append(key, value);
  });
  const type = upstream.headers.get("content-type") ?? "";
  if (type.includes("text/html")) {
    // The containment (see app-proxy.ts): an opaque origin for every
    // document, appended to whatever policy the app set for itself.
    out.append("content-security-policy", APP_PROXY_CSP);
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
