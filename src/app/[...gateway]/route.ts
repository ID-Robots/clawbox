import { NextRequest, NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { proxyGatewayRequest, redirectToSetup, serveGatewayHTML } from "@/lib/gateway-proxy";
import { isGatewayStaticPath } from "@/lib/gateway-static";
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
    // /setup-api/ is ClawBox's OWN namespace — the route handlers live there
    // precisely so they cannot collide with the gateway's /api/* — and the
    // gateway serves nothing under it. A /setup-api path that reached this
    // catch-all is therefore a route that does not exist, and the honest
    // answer is 404: proxied, it came back 502 from a gateway that had never
    // heard of it (or the SPA shell, before the resource rule below), and a
    // client probing for an endpoint could not tell "not here" from "down".
    if (request.nextUrl.pathname.startsWith("/setup-api/")) {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    // A STATIC path is served as bytes, not as the SPA shell. The Control UI
    // keeps whole trees outside /assets — /themes/*.css, /fonts/*.css,
    // /provider-icons, /file-icons, /app-art — and this route answers every
    // path Next did not match. So `<link href="/fonts/geist.css">` was being
    // answered 200 text/html with the 19 KB app shell, which is precisely the
    // "Styles failed to load, so the page may look broken." banner: a
    // stylesheet that parses as nothing.
    if (isGatewayStaticPath(request.nextUrl.pathname)) {
      return proxyGatewayRequest(request);
    }

    // Only a NAVIGATION gets the SPA shell. This route exists so a deep link
    // like /chat/main renders the app — but it was answering EVERY unmatched
    // path that way, including the resources the app then fetches for itself:
    //   /control-ui-config.json  (twice per page load; JSON.parse fails)
    //   /__openclaw__/plugin-icon/…, /__openclaw__/catalog-icon/…, and 11 more
    //   /avatar/<agent>, /avatar/<agent>?meta=1
    //   /health, /healthz        (an uptime monitor got HTML that parses as nothing)
    // Every one of those is fetched by script or by an <img>, never navigated
    // to, so the fetch metadata separates them from a real page load exactly.
    // `Sec-Fetch-Mode` is sent by every current browser and is the authority
    // when present: a script `fetch()` that asks for text/html still says
    // `cors`, and it wants the resource, not the shell. The Accept sniff is
    // ONLY the fallback for a client that sends no fetch metadata at all (curl
    // asks for */*, and gets the real resource, which is what a monitor needs).
    const secFetchMode = request.headers.get("sec-fetch-mode");
    const navigating = secFetchMode
      ? secFetchMode === "navigate"
      : (request.headers.get("accept") ?? "").includes("text/html");
    if (!navigating) {
      return proxyGatewayRequest(request);
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
