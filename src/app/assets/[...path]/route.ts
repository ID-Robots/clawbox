import { NextRequest } from "next/server";
import { proxyGatewayRequest } from "@/lib/gateway-proxy";

export const dynamic = "force-dynamic";

// The Control UI's hashed JS/CSS bundles. Was a next.config.ts rewrite; see
// src/app/api/[...path]/route.ts for why it is a route handler now.
async function handler(request: NextRequest) {
  return proxyGatewayRequest(request);
}

export const GET = handler;
export const HEAD = handler;
