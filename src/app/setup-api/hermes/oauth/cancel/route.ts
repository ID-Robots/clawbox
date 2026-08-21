export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { dashboardUnreachable, hermesGate, isValidSessionId, readJsonBody, relayJson } from "../shared";

// Abandon an in-flight OAuth session (panel unmounted, user hit Start over).
// Best-effort on the panel's side, but routed anyway so the dashboard doesn't
// accumulate half-open sessions until their expiry.
const CANCEL_KEYS = ["ok", "status", "message"] as const;

export async function DELETE(request: Request) {
  const gate = await hermesGate();
  if (gate) return gate;

  const body = await readJsonBody(request);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isValidSessionId(body.sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  try {
    const res = await dashboardFetch(`/api/providers/oauth/sessions/${body.sessionId}`, {
      method: "DELETE",
    });
    return await relayJson(res, CANCEL_KEYS);
  } catch {
    return dashboardUnreachable();
  }
}
