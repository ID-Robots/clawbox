import { NextRequest } from "next/server";
import { proxyGatewayRequest } from "@/lib/gateway-proxy";

export const dynamic = "force-dynamic";

// A gateway-owned favicon (public/ has no copy). Same rewrite-to-handler move
// as /assets — without it the Control UI's icons 403 on every page load.
async function handler(request: NextRequest) {
  return proxyGatewayRequest(request);
}

export const GET = handler;
export const HEAD = handler;
