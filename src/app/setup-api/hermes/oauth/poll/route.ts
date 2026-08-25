export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { dashboardUnreachable, hermesGate, isValidProviderId, isValidSessionId, relayJson } from "../shared";

// Poll a device-code session until the user approves it on the provider's
// verification page. Terminal statuses: "approved" | "error" | "expired";
// anything else means keep polling.
const POLL_KEYS = ["session_id", "status", "error_message", "expires_at"] as const;

export async function GET(request: Request) {
  const gate = await hermesGate();
  if (gate) return gate;

  const params = new URL(request.url).searchParams;
  const providerId = params.get("providerId");
  const sessionId = params.get("sessionId");
  if (!isValidProviderId(providerId)) {
    return NextResponse.json({ error: "Invalid provider id" }, { status: 400 });
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  try {
    const res = await dashboardFetch(`/api/providers/oauth/${providerId}/poll/${sessionId}`);
    // On the terminal "approved" tick the credential has just landed on the
    // dashboard; drop our cached catalogue so the next /providers/status read
    // sees the provider as connected rather than waiting out FRESH_MS. Only on
    // "approved" — a poll fires every few seconds, and busting the cache on
    // every "pending" tick would defeat the cache entirely.
    return await relayJson(res, POLL_KEYS, (data) => {
      if (data.status === "approved") invalidateModelOptions();
    });
  } catch {
    return dashboardUnreachable();
  }
}
