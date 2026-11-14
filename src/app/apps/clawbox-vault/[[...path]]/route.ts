import type { NextRequest } from "next/server";

import { verifyMcpBearer } from "@/lib/mcp-token";
import { ownerOnlyResponse, sessionIdentity, sessionRequiredResponse } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  VAULT_MAX_BODY_BYTES,
  VAULT_PROXY_METHODS,
  vaultRequestHeaders,
  vaultResponseHeaders,
  vaultServicePort,
  vaultUpstreamPath,
} from "@/lib/vault-proxy";

// ClawBox Vault's desktop app: the vault service's own page, for the OWNER
// only. Why this is a route of its own and not the generic /apps/<id> proxy,
// and what it does and does not reach, is in src/lib/vault-proxy.ts.

export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 30_000;

function refuse(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, { status, headers: { "cache-control": "no-store" } });
}

/** The service is stopped or still starting: said in words where a person is looking at the window. */
function vaultDown(request: NextRequest): Response {
  const wantsPage = (request.headers.get("accept") ?? "").includes("text/html");
  if (!wantsPage) return refuse(502, "ClawBox Vault is not running.", "vault_down");
  const html =
    '<!doctype html><meta charset="utf-8"><title>ClawBox Vault</title>' +
    '<body style="font:16px system-ui,sans-serif;margin:3rem;color:#444">' +
    "<h1 style=\"font-size:1.2rem\">ClawBox Vault is not running</h1>" +
    "<p>The vault service on this ClawBox did not answer. It starts with the box; close this window and open it again in a minute.</p></body>";
  return new Response(html, { status: 502, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function handle(request: NextRequest): Promise<Response> {
  // The owner's cookie, on every request: the page, its files and its API.
  // No test-mode or first-boot opening, and never the agent's bearer.
  const who = await sessionIdentity(request);
  if (!who) {
    const bearer = request.headers.get("authorization");
    if (bearer && verifyMcpBearer(bearer)) return ownerOnlyResponse();
    return sessionRequiredResponse();
  }
  if (!who.isOwner) return ownerOnlyResponse();

  const method = request.method.toUpperCase();
  if (!VAULT_PROXY_METHODS.includes(method)) return refuse(405, "Method not allowed.", "method_not_allowed");
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead && !isSameOriginRequest(request)) return refuse(403, "This request did not come from ClawBox.", "cross_origin");

  // As typed: `nextUrl` folds a trailing slash away, and the list is exact.
  const url = new URL(request.url);
  const upstreamPath = vaultUpstreamPath(url.pathname);
  if (!upstreamPath) return refuse(404, "Not found.", "not_found");

  let body: ArrayBuffer | undefined;
  if (!isRead) {
    body = await request.arrayBuffer();
    if (body.byteLength > VAULT_MAX_BODY_BYTES) return refuse(413, "Request too large.", "too_large");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${vaultServicePort()}${upstreamPath}${url.search}`, {
      method,
      headers: vaultRequestHeaders(request.headers),
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return vaultDown(request);
  }
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: vaultResponseHeaders(upstream.headers) });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const DELETE = handle;
export const PUT = handle;
export const PATCH = handle;
