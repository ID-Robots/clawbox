export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { localHttpsStatus, setLocalHttpsEnabled } from "@/lib/local-https";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * Settings → Network → Secure local address (docs/design/local-https.md).
 *
 * GET   the card's status: the switch, the hostname, whether :443 serves it,
 *       the certificate's dates, the DNS verdict and the last problem.
 * POST  `{ enabled: boolean }` — the owner's switch.
 *
 * The OWNER's alone, in a browser, on this box's own pages. Switching it on
 * sends the box's LAN address to the portal, which publishes it in public DNS
 * — a disclosure only the owner can consent to, so neither another user nor
 * the MCP bearer (the assistant) may flip it, and a page on another origin
 * cannot either. Read is owner-only too: it names the address.
 */

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return refuse(403, "owner_only", "Only the box owner can see the secure local address.");
  }
  return NextResponse.json(await localHttpsStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return refuse(403, "owner_only", "Only the box owner can switch the secure local address, from a signed-in browser.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "The secure local address can only be switched from this ClawBox's own pages.");
  }
  let enabled: boolean;
  try {
    const parsed: unknown = await req.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { enabled?: unknown }).enabled
      : undefined;
    if (typeof candidate !== "boolean") return refuse(400, "bad_body", "enabled must be true or false.");
    enabled = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }
  try {
    return NextResponse.json(await setLocalHttpsEnabled(enabled), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[local-https] the switch could not be saved:", err instanceof Error ? err.message : err);
    return refuse(500, "store_write_failed", "The switch could not be saved — data/local-https/ could not be written. Nothing was changed.");
  }
}
