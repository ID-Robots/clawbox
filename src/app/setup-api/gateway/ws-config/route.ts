import { NextRequest, NextResponse } from "next/server";
import { getGatewayToken } from "@/lib/gateway-proxy";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host")?.replace(/:\d+$/, "") || "clawbox.local";
  const token = await getGatewayToken();
  return NextResponse.json({
    wsUrl: `ws://${host}:${GATEWAY_PORT}`,
    token: token || "",
  });
}
