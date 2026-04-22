import { NextRequest, NextResponse } from "next/server";
import { getGatewayToken } from "@/lib/gateway-proxy";
import fs from "fs/promises";

export const dynamic = "force-dynamic";

const OPENCLAW_CONFIG = process.env.OPENCLAW_HOME
  ? `${process.env.OPENCLAW_HOME}/openclaw.json`
  : "/home/clawbox/.openclaw/openclaw.json";

/**
 * Infer the scheme the client used to reach us. Behind Cloudflare Tunnel the
 * request arrives at our HTTP listener over plain HTTP, but the browser's
 * original scheme was HTTPS — we must match it or the browser will refuse the
 * ws:// upgrade under mixed-content.
 */
function inferWsScheme(request: NextRequest): "ws" | "wss" {
  const xfp = request.headers.get("x-forwarded-proto");
  if (xfp?.split(",")[0]?.trim() === "https") return "wss";
  const cfVisitor = request.headers.get("cf-visitor");
  if (cfVisitor && /"scheme"\s*:\s*"https"/.test(cfVisitor)) return "wss";
  if (request.nextUrl.protocol === "https:") return "wss";
  return "ws";
}

export async function GET(request: NextRequest) {
  const host = request.headers.get("host") || "clawbox.local";
  const scheme = inferWsScheme(request);
  const token = await getGatewayToken();

  let model = "";
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
    const config = JSON.parse(raw);
    model = config?.agents?.defaults?.model?.primary || "";
  } catch (err) {
    console.debug("[ws-config] Failed to read openclaw config:", err instanceof Error ? err.message : err);
  }

  // Point clients at the same origin they came in on. The production server's
  // upgrade proxy forwards these WS upgrades to the OpenClaw gateway on 18789,
  // which keeps the flow working on the LAN, through the Cloudflare tunnel,
  // and under HTTPS (no mixed-content, no external port exposure).
  return NextResponse.json({
    wsUrl: `${scheme}://${host}`,
    token: token || "",
    model,
  });
}
