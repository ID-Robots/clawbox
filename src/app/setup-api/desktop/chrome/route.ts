export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { desktopChromeStatus, launchDesktopChrome } from "@/lib/desktop-chrome";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * GET  /setup-api/desktop/chrome            → { available }
 * POST /setup-api/desktop/chrome { url? }   → opens Google Chrome on the screen
 *
 * The desktop's Google Chrome icon (src/lib/desktop-chrome.ts). `available`
 * is true only while the ClawBox Desktop session is up and a Chrome is
 * installed; every other box answers false with a 200 and the POST answers the
 * same shape with a 503 — the normal state of most boxes, not an error.
 *
 * The POST is the OWNER's (cookie, never the MCP bearer) and OUR PAGE's (same
 * origin): it starts a program on the owner's screen, and a cross-site POST
 * riding the cookie must not be able to put a page there.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function GET() {
  return NextResponse.json(desktopChromeStatus(), { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return refuse("Only the owner's own session may open Chrome on the screen", "owner_only", 403);
  }
  if (!isSameOriginRequest(req)) {
    return refuse("This request did not come from the ClawBox page", "cross_origin", 403);
  }

  let body: Record<string, unknown> = {};
  const raw = await req.text();
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse("Invalid JSON body", "invalid_body", 400);
      body = parsed as Record<string, unknown>;
    } catch {
      return refuse("Invalid JSON body", "invalid_body", 400);
    }
  }

  const result = await launchDesktopChrome(body.url);
  if (!result.available) {
    return NextResponse.json({ available: false, ok: false }, { status: 503, headers: NO_STORE });
  }
  if (!result.ok) {
    return NextResponse.json({ available: true, ok: false, error: result.error, code: result.code }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json({ available: true, ok: true }, { headers: NO_STORE });
}
