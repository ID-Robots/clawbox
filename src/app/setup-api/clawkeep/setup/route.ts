import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
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
  let body: { setupComplete?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body.setupComplete !== "boolean") {
    return NextResponse.json({ error: "Expected { setupComplete: boolean }." }, { status: 400 });
  }
  await setClawKeepSetupComplete(body.setupComplete);
  return NextResponse.json({ setupComplete: await getClawKeepSetupComplete() }, { headers: { "Cache-Control": "no-store" } });
}
