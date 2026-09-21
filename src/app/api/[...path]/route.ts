import { NextRequest } from "next/server";
import { proxyGatewayRequest } from "@/lib/gateway-proxy";

export const dynamic = "force-dynamic";

// The OpenClaw gateway's own API surface. ClawBox's routes live under
// /setup-api precisely so this prefix stays the gateway's.
//
// This used to be a next.config.ts `beforeFiles` rewrite. It is a route
// handler now because Next's rewrite proxy adds x-forwarded-* headers of its
// own, and OpenClaw 2 answers 403 proxy_attribution_required to any hop it was
// not told to trust — see proxyGatewayRequest for the full story. Middleware
// still runs ahead of this (auth, and the Hermes 404 for gateway-only paths),
// exactly as it did ahead of the rewrite.
async function handler(request: NextRequest) {
  return proxyGatewayRequest(request);
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
