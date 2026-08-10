import { NextRequest, NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { redirectToSetup, serveGatewayHTML } from "@/lib/gateway-proxy";
import { readEdition } from "@/lib/edition-source";

export const dynamic = "force-dynamic";

// Catch-all route for gateway SPA paths (e.g. /chat, /sessions, /logs).
// Serves the same gateway HTML with ClawBox bar and auth token injection.

export async function GET(request: NextRequest) {
  try {
    const config = await getAll();
    if (!config.setup_complete) {
      return redirectToSetup(request);
    }
    // On the Hermes SKU there is no OpenClaw gateway — it is disabled and
    // masked by install.sh — so proxying to 127.0.0.1:18789 is a guaranteed
    // ECONNREFUSED. This route matches EVERY otherwise-unhandled path (it wins
    // over next.config.ts's `fallback` rewrite, which is why gating the rewrite
    // alone was not enough), so without this check /chat, /sessions and every
    // typo answered with a 500 from the catch below instead of a plain 404.
    if (readEdition() === "hermes") {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return serveGatewayHTML(request);
  } catch (err) {
    console.error("[gateway] Error serving gateway route:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
