export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { dashboardFetch } from "@/lib/hermes-dashboard-auth";
import { cliLoginAvailable, cliLoginDriverFor, startCliLogin } from "@/lib/hermes-cli-login";

/**
 * ClawBox drives a provider's CLI login only when the harness's own dashboard
 * will not run it — its catalogue says `flow: "external"`. A Hermes build whose
 * dashboard still runs the login itself keeps that path; the native mechanism
 * is never bypassed on a box that has it. With the dashboard unreachable the
 * catalogue cannot say, and the relay below would fail anyway, so a driver
 * decides.
 */
async function dashboardDelegatesToCli(providerId: string): Promise<boolean> {
  if (!cliLoginDriverFor(providerId)) return false;
  try {
    const res = await dashboardFetch("/api/providers/oauth");
    if (!res.ok) return true;
    const data = (await res.json()) as { providers?: { id?: unknown; flow?: unknown }[] };
    const row = (data.providers ?? []).find((p) => p?.id === providerId);
    return !row || row.flow === "external";
  } catch {
    return true;
  }
}
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

  // Providers the dashboard marks "external" sign in through Hermes' own
  // attended CLI login; ClawBox drives that and answers in the dashboard's
  // session shape, so the panel runs one state machine for both.
  if (await dashboardDelegatesToCli(body.providerId)) {
    if (!(await cliLoginAvailable(body.providerId))) {
      return NextResponse.json(
        { error: "The sign-in tool is not installed on this box.", code: "cli_missing" },
        { status: 409 },
      );
    }
    const session = await startCliLogin(body.providerId);
    // A tool that is already signed in prints no link and exits 0: that is a
    // sign-in, finished before it started, not a failure.
    if (session.status === "approved") {
      return NextResponse.json({ session_id: session.id, flow: session.flow, status: "approved" });
    }
    if (session.status !== "pending") {
      return NextResponse.json(
        { error: session.error || "Could not start sign-in", code: "cli_login_failed" },
        { status: 502 },
      );
    }
    return NextResponse.json({
      session_id: session.id,
      flow: session.flow,
      auth_url: session.authUrl,
      user_code: session.userCode,
      verification_url: session.verificationUrl,
      expires_in: Math.max(1, Math.round((session.expiresAt - Date.now()) / 1000)),
      poll_interval: 3,
    });
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
