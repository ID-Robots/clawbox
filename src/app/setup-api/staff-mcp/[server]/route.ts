export const dynamic = "force-dynamic";

import { relayStaffMcp } from "@/lib/staff-mcp-relay";
import { isServerName } from "@/lib/staff-mcp";

/**
 * /setup-api/staff-mcp/<server> — the loopback relay a member of staff's
 * OpenClaw agent reaches a granted MCP server through, with that member's own
 * credential (TASK-2377; src/lib/staff-mcp-relay.ts holds every rule).
 *
 * The gateway has no session cookie, so middleware lets this tree through
 * (LOOPBACK_PROXY_PREFIXES) and the relay authenticates the call itself: a
 * member's relay token or nothing. A browser — any user's, the owner's
 * included — holds no relay token and is answered 401.
 */

type Params = { params: Promise<{ server: string }> };

async function handle(req: Request, { params }: Params): Promise<Response> {
  const { server } = await params;
  if (!isServerName(server)) {
    return new Response(JSON.stringify({ error: "Unknown server.", code: "bad_server" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return relayStaffMcp(req, server);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
