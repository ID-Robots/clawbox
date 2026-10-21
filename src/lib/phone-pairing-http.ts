/**
 * The HTTP rules every /setup-api/nodes route shares. SERVER ONLY.
 *
 * Owner routes: the owner's session only (a signed-in ClawBox user is 403
 * `owner_only`, the assistant's MCP bearer too — an agent must not be able to
 * pair a phone to itself), state changes only from the box's own pages, and a
 * 409 on a box without OpenClaw, which has no gateway for a phone to join.
 *
 * The two public routes a phone's browser calls (`request`, `request/status`)
 * have no session to check: they are answered only while the owner has phone
 * pairing switched on, and only to whoever holds an invite or a claim.
 */

import { NextResponse } from "next/server";

import { readJsonObject as readBoundedJsonObject } from "@/lib/bounded-json";
import { openclawIsAbsent } from "@/lib/openclaw-config";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";

export function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Null when the owner may run this route; otherwise the refusal to answer with. */
export async function ownerGate(request: Request, opts: { write: boolean }): Promise<NextResponse | null> {
  const denied = await requireSession(request, { ownerOnly: true });
  if (denied) return denied;
  if (opts.write && !isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "Phones can only be paired from this ClawBox's own pages.");
  }
  if (openclawIsAbsent()) {
    return refuse(409, "no_openclaw", "Phones pair with the OpenClaw gateway, and this ClawBox does not run it.");
  }
  return null;
}

/** Every body these routes take is a few short ids and a phone's name; nothing larger is read. */
export const NODES_BODY_LIMIT = 4096;

/**
 * The request's JSON body: `body` is the object, or null when the request sent
 * none or something else. Larger than {@link NODES_BODY_LIMIT} is `refusal`,
 * the 413 to answer. Metered (src/lib/bounded-json.ts) rather than
 * `request.json()`, because two of these routes are public: a phone-sized
 * request must not be able to make the box buffer and parse megabytes.
 */
export async function readJsonObject(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; refusal: NextResponse }> {
  const read = await readBoundedJsonObject(request, NODES_BODY_LIMIT);
  if (read.ok) return { ok: true, body: read.body };
  if (read.reason === "too_long") return { ok: false, refusal: refuse(413, "too_long", "That request body is too large.") };
  return { ok: true, body: null };
}

/** An opaque id from a body: a non-empty string of at most `max` characters, else null. */
export function idField(body: Record<string, unknown> | null, key: string, max = 256): string | null {
  const value = body?.[key];
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value ? value : null;
}

/**
 * The address the phone's browser connected from, when the box can tell: the
 * tunnel's CF-Connecting-IP, which only survives scripts/proxy-peer.js on a
 * loopback peer (cloudflared). A label for the owner, never a credential.
 */
export function requestAddress(request: Request): string | null {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  return value && /^[0-9A-Fa-f:.]+$/.test(value) && value.length <= 45 ? value : null;
}

/** What a failed gateway call said, for the owner; never a stack. */
export function gatewayMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 300) || "The gateway did not answer.";
}

export function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
