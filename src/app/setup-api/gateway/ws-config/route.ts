import { NextRequest, NextResponse } from "next/server";
import { getGatewayToken } from "@/lib/gateway-proxy";
import fs from "fs/promises";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";
const OPENCLAW_CONFIG = process.env.OPENCLAW_HOME
  ? `${process.env.OPENCLAW_HOME}/openclaw.json`
  : "/home/clawbox/.openclaw/openclaw.json";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host")?.replace(/:\d+$/, "") || "clawbox.local";
  const token = await getGatewayToken();

  let model = "";
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
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
