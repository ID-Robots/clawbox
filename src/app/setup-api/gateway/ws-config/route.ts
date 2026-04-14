import { NextRequest, NextResponse } from "next/server";
import { getGatewayToken } from "@/lib/gateway-proxy";
import fs from "fs/promises";
import { OPENCLAW_CONFIG_PATH } from "@/lib/runtime-paths";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host")?.replace(/:\d+$/, "") || "clawbox.local";
  const token = await getGatewayToken();

  let model = "";
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    model = config?.agents?.defaults?.model?.primary || "";
  } catch (err) {
    console.debug("[ws-config] Failed to read openclaw config:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({
    wsUrl: `ws://${host}:${GATEWAY_PORT}`,
    token: token || "",
    model,
  });
}
