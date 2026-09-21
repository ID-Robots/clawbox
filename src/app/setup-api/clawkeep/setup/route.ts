import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { getClawKeepSetupComplete, setClawKeepSetupComplete } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

/**
 * The ClawKeep setup wizard's completion flag.
 *
 * OWNER ONLY, like the coding agent's and Memory Shard's: middleware admits
 * the MCP bearer on every /setup-api route, and the wizard is the owner's
 * front door, not the agent's to close.
 *
 * POST { setupComplete: boolean } → { setupComplete }.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Finishing ClawKeep setup needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  // And from OUR page: the cookie rides on a POST any other site fires at
  // the box, and a `text/plain` body needs no preflight (same-origin.ts).
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "ClawKeep setup only works from this ClawBox's own pages.", kind: "cross_origin" },
      { status: 403 },
    );
  }
  let body: { setupComplete?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body.setupComplete !== "boolean") {
    return NextResponse.json({ error: "Expected { setupComplete: boolean }." }, { status: 400 });
  }
  try {
    await setClawKeepSetupComplete(body.setupComplete);
    return NextResponse.json({ setupComplete: await getClawKeepSetupComplete() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.warn("[setup-api/clawkeep/setup] could not save the setup state:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not save the ClawKeep setup state." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
