import { NextRequest, NextResponse } from "next/server";
import os from "os";

import { createClawKeepState, writeClawKeepSession } from "@/lib/clawkeep-connect";
import { DEFAULT_PORTAL_SERVER } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// Mirrors src/app/setup-api/ai-models/clawai/start/route.ts. Returns
// { url, state } so the desktop ClawKeep app can open the same portal
// /connect page in a popup; the portal redirects back to the matching
// /pair/callback route once the user approves.
const ALLOWED_PROTOS = new Set(["http", "https"]);

function resolveOrigin(request: NextRequest) {
  // Trust x-forwarded-* only when the proto parses to http/https — same
  // pattern as gateway-proxy.ts. A naive `${proto}://${host}` would let an
  // attacker who can set request headers forge a different scheme.
  const rawProto = request.headers.get("x-forwarded-proto");
  const proto = rawProto
    ?.split(",")
    .map((t) => t.trim().toLowerCase())
    .find((t) => ALLOWED_PROTOS.has(t));
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (proto && forwardedHost) {
    return `${proto}://${forwardedHost}`;
  }
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  let body: { deviceName?: string; server?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine.
  }

  const server = (body.server?.trim() || DEFAULT_PORTAL_SERVER).replace(/\/+$/, "");
  const state = createClawKeepState();
  const origin = resolveOrigin(request);
  const redirectUri = `${origin}/setup-api/clawkeep/pair/callback`;
  const deviceName = body.deviceName?.trim() || os.hostname() || "ClawBox";

  await writeClawKeepSession({
    state,
    createdAt: Date.now(),
    status: "pending",
    redirectUri,
    deviceName,
    error: null,
  });

  const url = new URL(`${server}/portal/connect`);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("device_name", deviceName);

  return NextResponse.json(
    { url: url.toString(), state },
    { headers: { "Cache-Control": "no-store" } },
  );
}
