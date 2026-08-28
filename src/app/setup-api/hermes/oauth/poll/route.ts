export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { readUsableProviderIds, refreshProviderToolsIfSetChanged } from "@/lib/provider-mcp-refresh";
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

  // Sampled BEFORE the tick that may report the sign-in, because after it the
  // answer already includes the provider that just connected and no change can
  // be seen. It is a read of the SWR-cached catalogue the panel is holding open
  // anyway (FRESH_MS = 60 s), not a dashboard round-trip per tick — and the
  // guard below is what keeps a pending tick from asking the agent for anything.
  const providersBefore = await readUsableProviderIds();

  try {
    const res = await dashboardFetch(`/api/providers/oauth/${providerId}/poll/${sessionId}`);
    // On the terminal "approved" tick the credential has just landed on the
    // dashboard; drop our cached catalogue so the next /providers/status read
    // sees the provider as connected rather than waiting out FRESH_MS. Only on
    // "approved" — a poll fires every few seconds, and busting the cache on
    // every "pending" tick would defeat the cache entirely.
    let approved = false;
    const relayed = await relayJson(res, POLL_KEYS, (data) => {
      if (data.status === "approved") {
        invalidateModelOptions();
        approved = true;
      }
    });
    // The browser has been told; the RUNNING AGENT has not. Its `ai_set_provider`
    // enum was built from a provider list probed once, at MCP-server boot — see
    // `provider-mcp-refresh.ts`. Only on the terminal tick, and only if the set
    // really moved: a reload respawns every MCP child and invalidates the model's
    // prompt cache, so a client that keeps polling a finished session must not be
    // able to charge the owner for one per tick.
    if (approved) {
      await refreshProviderToolsIfSetChanged(providersBefore, await readUsableProviderIds());
    }
    return relayed;
  } catch {
    return dashboardUnreachable();
  }
}
