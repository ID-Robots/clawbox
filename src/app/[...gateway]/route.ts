import { NextRequest } from "next/server";
import { getAll } from "@/lib/config-store";
import { redirectToSetup, serveGatewayHTML } from "@/lib/gateway-proxy";

export const dynamic = "force-dynamic";

// Catch-all route for gateway SPA paths (e.g. /chat, /sessions, /logs).
// Serves the same gateway HTML with ClawBox bar and auth token injection.
export async function GET(request: NextRequest) {
  const config = await getAll();
  if (!config.setup_complete) {
    return redirectToSetup(request);
  }
  return serveGatewayHTML(request);
}
