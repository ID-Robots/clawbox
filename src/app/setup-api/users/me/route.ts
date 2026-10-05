import { NextResponse } from "next/server";
import { listUsers } from "@/lib/clawbox-users";
import { sessionIdentity } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

// Who is signed in on this browser (TASK-1256). The one users route a
// non-owner reaches (src/lib/non-owner-scope.ts): the desktop asks it once to
// know whose name to show and whether to offer the owner's apps.
//
// Cookie only — the MCP bearer is the agent, not a person, and gets 401.
export async function GET(request: Request) {
  const identity = await sessionIdentity(request);
  if (!identity) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  let multiUser = false;
  try {
    multiUser = (await listUsers()).length > 0;
  } catch {
    multiUser = false;
  }
  return NextResponse.json(
    { username: identity.username, isOwner: identity.isOwner, multiUser },
    { headers: { "cache-control": "no-store" } },
  );
}
