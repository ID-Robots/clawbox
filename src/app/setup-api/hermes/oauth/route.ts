export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";

// Surface Hermes' native provider-OAuth catalog + connection status so the
// AI-provider panel can offer "Sign in with Anthropic / OpenAI / …" and show
// which are already connected. The actual OAuth (PKCE / device-code) runs
// inline in the panel through the start/submit/poll/cancel routes next to this
// one — never by sending the browser to the dashboard's :8090 proxy, which a
// tunnel does not forward. `cli_command` rides along for flow "external"
// providers, whose only sign-in path is the Hermes CLI.
interface RawOAuthProvider {
  id?: string;
  name?: string;
  flow?: string;
  docs_url?: string;
  cli_command?: string;
  status?: { logged_in?: boolean };
}

export async function GET() {
  if ((await getActiveHarness()) !== "hermes") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const res = await dashboardFetch("/api/providers/oauth");
    if (!res.ok) return NextResponse.json({ providers: [] });
    const data = (await res.json()) as { providers?: RawOAuthProvider[] };
    const providers = (data.providers ?? []).map((p) => ({
      id: typeof p.id === "string" ? p.id : "",
      name: typeof p.name === "string" ? p.name : p.id,
      flow: typeof p.flow === "string" ? p.flow : "",
      loggedIn: Boolean(p.status?.logged_in),
      docsUrl: typeof p.docs_url === "string" ? p.docs_url : undefined,
      cliCommand: typeof p.cli_command === "string" ? p.cli_command : undefined,
    }));
    return NextResponse.json({ providers });
  } catch {
    return NextResponse.json({ providers: [] });
  }
}
