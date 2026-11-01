import { NextResponse } from "next/server";
import { listUsers } from "@/lib/clawbox-users";
import { sessionIdentity } from "@/lib/route-auth";
import { readOpenclawShared } from "@/lib/openclaw-sharing";
import { sessionExpiredHeaders } from "@/lib/session-expiry";

export const dynamic = "force-dynamic";

// Who is signed in on this browser (TASK-1256). The one users route a
// non-owner reaches (src/lib/non-owner-scope.ts): the desktop asks it once to
// know whose name to show and whether to offer the owner's apps — OpenClaw
// among them while the owner shares it (`openclawShared`, not a secret).
//
// Cookie only — the MCP bearer is the agent, not a person, and gets 401.
// Also the probe a page sends to learn whether its session is still good
// (SESSION_PROBE_URL, src/lib/session-expiry.ts), so its 401 is marked as the
// session gate's.
export async function GET(request: Request) {
  const identity = await sessionIdentity(request);
  if (!identity) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: sessionExpiredHeaders() });
  }
  let multiUser = false;
  try {
    multiUser = (await listUsers()).length > 0;
  } catch {
    multiUser = false;
  }
  const openclawShared = await readOpenclawShared();
  return NextResponse.json(
    { username: identity.username, isOwner: identity.isOwner, multiUser, openclawShared },
    { headers: { "cache-control": "no-store" } },
  );
}
