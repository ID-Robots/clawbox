import { NextRequest, NextResponse } from "next/server";
import os from "os";
import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import { createClawAiState, writeClawAiSession } from "@/lib/clawai-connect";

export const dynamic = "force-dynamic";

function resolveOrigin(request: NextRequest) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  let body: { scope?: "primary" | "local"; deviceName?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine.
  }

  const scope = body.scope === "local" ? "local" : "primary";
  const state = createClawAiState();
  const origin = resolveOrigin(request);
  const redirectUri = `${origin}/setup-api/ai-models/clawai/callback`;
  const deviceName = body.deviceName?.trim() || os.hostname() || "ClawBox";
  await writeClawAiSession({
    state,
    createdAt: Date.now(),
    status: "pending",
    provider: "clawai",
    scope,
    redirectUri,
    deviceName,
    error: null,
  });

  const url = new URL(`${PORTAL_LOGIN_URL}/connect`);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("device_name", deviceName);

  return NextResponse.json({
    url: url.toString(),
    state,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
