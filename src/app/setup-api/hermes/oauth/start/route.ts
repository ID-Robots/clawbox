export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { dashboardUnreachable, isValidProviderId, ownerGate, readJsonBody, relayJson } from "../shared";

// Start a Hermes provider-OAuth session on behalf of the wizard. The dashboard
// answers with the flow it runs for this provider:
//   pkce        → { session_id, flow, auth_url, expires_in } — the panel opens
//                 auth_url in a new tab and the user pastes the code back
//   device_code → { session_id, flow, user_code, verification_url, expires_in,
//                 poll_interval } — the panel shows the code and polls
// A provider whose flow is "external" (CLI-only) gets a 400 from the dashboard,
// relayed as-is; the panel never offers Sign in for those.
const START_KEYS = [
  "session_id",
  "flow",
  "auth_url",
  "user_code",
  "verification_url",
  "expires_in",
  "poll_interval",
] as const;

export async function POST(request: Request) {
  const gate = await ownerGate(request);
  if (gate) return gate;

  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isValidProviderId(body.providerId)) {
    return NextResponse.json({ error: "Invalid provider id" }, { status: 400 });
  }

  try {
    const res = await dashboardFetch(`/api/providers/oauth/${body.providerId}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    return await relayJson(res, START_KEYS);
  } catch {
    return dashboardUnreachable();
  }
}
