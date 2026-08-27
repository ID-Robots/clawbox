export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import {
  dashboardUnreachable,
  isValidProviderId,
  isValidSessionId,
  ownerGate,
  readJsonBody,
  relayJson,
} from "../shared";

// Complete a PKCE session with the code the user pasted from the provider's
// consent page (Anthropic redirects to console.anthropic.com/oauth/code/callback
// and shows the code there — which is exactly why this works through a tunnel:
// nothing ever has to redirect back to the device). The dashboard reports
// failure as { ok:false, status, message }; both shapes relay through.
const SUBMIT_KEYS = ["ok", "status", "message"] as const;

// The pasted authorization code. Printable ASCII only (Anthropic's includes a
// "#" separator), bounded, and never a flag-looking value — same posture as
// the provider-key route's API_KEY_RE.
const CODE_RE = /^[!-~]{4,2048}$/;

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
  if (!isValidSessionId(body.sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  try {
    const res = await dashboardFetch(`/api/providers/oauth/${body.providerId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: body.sessionId, code }),
    });
    // A completed PKCE exchange flips this provider's `authenticated` flag on
    // the dashboard, so our cached catalogue is now wrong. Drop it — exactly as
    // the API-key route does after `hermes auth add` — so the very next
    // /setup-api/providers/status read (the wizard fires one on connect) sees
    // the provider as connected instead of serving a stale "not connected" for
    // up to FRESH_MS. This was the row-vs-card mismatch: the OAuth card flipped
    // to Connected from local state while the row kept reading the stale cache.
    return await relayJson(res, SUBMIT_KEYS, (data, ok) => {
      if (ok && data.ok !== false) invalidateModelOptions();
    });
  } catch {
    return dashboardUnreachable();
  }
}
