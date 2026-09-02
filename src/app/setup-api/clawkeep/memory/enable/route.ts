import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import {
  getMemoryShardEnabled,
  getMemoryShardSetupComplete,
  setMemoryShardEnabled,
  setMemoryShardSetupComplete,
} from "@/lib/memory-shard";

export const dynamic = "force-dynamic";

/**
 * The owner's switch for Memory Shard, and the wizard's completion flag.
 *
 * OWNER ONLY. Middleware admits the MCP bearer on every /setup-api route and
 * the agent holds it, so a route that trusted middleware here would let the
 * assistant switch on the indexing of the owner's own documents. Same helper
 * and same rule as coding-agent/enable.
 *
 * POST { enabled?: boolean, setupComplete?: boolean } → the new state.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the memory index switch needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: { enabled?: unknown; setupComplete?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const hasEnabled = typeof body.enabled === "boolean";
  const hasSetup = typeof body.setupComplete === "boolean";
  if (!hasEnabled && !hasSetup) {
    return NextResponse.json(
      { error: "Expected { enabled: boolean } or { setupComplete: boolean }." },
      { status: 400 },
    );
  }

  if (hasEnabled) {
    await setMemoryShardEnabled(body.enabled as boolean);
    console.error(`[memory-shard] switched ${body.enabled ? "on" : "off"} by the owner`);
  }
  if (hasSetup) {
    await setMemoryShardSetupComplete(body.setupComplete as boolean);
  }

  return NextResponse.json({
    enabled: await getMemoryShardEnabled(),
    setupComplete: await getMemoryShardSetupComplete(),
  });
}
