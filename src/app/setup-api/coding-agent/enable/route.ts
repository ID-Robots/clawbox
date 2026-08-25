import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { getCodingAgentStatus, setCodingAgentEnabled } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * POST { enabled: boolean } → flip the owner's switch; answers the same
 * payload as GET /setup-api/coding-agent/status.
 *
 * OWNER ONLY — the one thing in this subtree the agent must never be able to
 * do to itself. Middleware admits every /setup-api/* call on the MCP bearer,
 * and the agent holds that bearer; a route that trusted middleware here (or
 * requireSession, which also accepts the bearer) would let a prompt-injected
 * agent switch on its own delegated shell. Same rule and same helper as
 * email/pending: a real browser session or a 403, identical for "no
 * credential" and "valid bearer" alike.
 */
function forbidden() {
  return NextResponse.json(
    { error: "Changing the coding agent switch needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "Invalid body. Expected { enabled: boolean }." }, { status: 400 });
  }

  try {
    await setCodingAgentEnabled(enabled);
    console.error(`[coding-agent] switched ${enabled ? "on" : "off"} by the owner`);
    return NextResponse.json(await getCodingAgentStatus());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to change the coding agent setting" },
      { status: 500 },
    );
  }
}
