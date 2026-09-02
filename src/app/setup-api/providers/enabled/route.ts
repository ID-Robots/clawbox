export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { logSafe } from "@/lib/log-safe";
import { hasOwnerSession } from "@/lib/owner-session";
import { setProviderEnabled } from "@/lib/provider-enablement";
import { notifyProviderSetChanged } from "@/app/setup-api/ai-models/catalog/route";
import { readProviderStatus } from "@/lib/provider-status";

/**
 * "Switch this provider off (or back on)."
 *
 * POST { provider: string, enabled: boolean } → the same payload as GET
 * /setup-api/providers/status, re-read after the change, so the strip can
 * repaint from the answer without a second round-trip.
 *
 * OWNER ONLY. Middleware admits every /setup-api/* call on the MCP bearer, and
 * the agent holds that bearer; a route that trusted it here would let a
 * prompt-injected agent switch a provider off — or back on — behind the
 * owner's back. Same rule and same helper as coding-agent/enable: a real
 * browser session or a 403, identical for "no credential" and "valid bearer".
 *
 * The refusals are the rule's, passed through with their own status: 409 for
 * the default (the fix is to pick another default first, and the message says
 * so) and 404 for an id this harness has no row for.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing an AI provider's switch needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // `in` throws on a body that is a bare string, number or boolean — all legal
  // JSON — so the shape is checked before any field is read.
  const fields = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { provider?: unknown; enabled?: unknown })
    : {};
  const provider = typeof fields.provider === "string" ? fields.provider.trim() : "";
  if (!provider || typeof fields.enabled !== "boolean") {
    return NextResponse.json(
      { error: "Invalid body. Expected { provider: string, enabled: boolean }." },
      { status: 400 },
    );
  }

  const result = await setProviderEnabled(provider, fields.enabled);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, kind: result.kind },
      { status: result.kind === "is_default" ? 409 : 404 },
    );
  }
  // The id is one the rule just matched to a row, but it is still the body's
  // spelling of it: one line per flip, whatever the body carried.
  console.error(`[providers] ${logSafe(provider)} switched ${fields.enabled ? "on" : "off"} by the owner`);

  // A switch flip IS a provider-set change, and this route is one of the two
  // that used to make one without telling the catalogue — the client's
  // `?refresh=1` was its only signal, and a non-browser caller had none at all.
  // Switching a provider off empties its `openclaw models list`; switching it
  // back on is what makes it enumerable again. Out-of-band, not awaited: the
  // strip repaints from the status read below, not from the catalogue.
  notifyProviderSetChanged(provider);

  const summary = await readProviderStatus();
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
