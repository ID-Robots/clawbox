export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { dashboardUnreachable, hermesGate, isValidProviderId, isValidSessionId, relayJson } from "../shared";

// Poll a device-code session until the user approves it on the provider's
// verification page. Terminal statuses: "approved" | "error" | "expired";
// anything else means keep polling.
const POLL_KEYS = ["session_id", "status", "error_message", "expires_at"] as const;

// The one route in this directory that stops at `hermesGate` rather than
// `ownerGate`, and deliberately so. Middleware refuses it without a session
// exactly like its three siblings — it is not on the bootstrap allow-list, so
// the pre-setup answer is 401 either way (TASK-527, asserted in
// src/tests/middleware/middleware.test.ts). What it does NOT carry is the
// second, in-handler check the write routes have.
//
// That asymmetry follows what the second line is for. `@/lib/route-auth` exists
// so a handler that CHANGES something still refuses when the gate in front of
// it is wrong; this one changes nothing. It reads back a status the caller must
// already hold a dashboard-minted session id to name, and relays four fields —
// session_id, status, error_message, expires_at — none of them credential
// material (`relayJson`'s whitelist is what guarantees that). Minting the id it
// needs goes through `start`, which is gated twice.
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
    return await relayJson(res, POLL_KEYS);
  } catch {
    return dashboardUnreachable();
  }
}
