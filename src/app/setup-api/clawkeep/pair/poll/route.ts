import { NextResponse } from "next/server";

import { writeToken } from "@/lib/clawkeep";
import {
  type ClawKeepConnectSession,
  clearClawKeepSession,
  isClawKeepSessionExpired,
  readClawKeepSession,
  writeClawKeepSession,
} from "@/lib/clawkeep-connect";

export const dynamic = "force-dynamic";

// Mirrors src/app/setup-api/ai-models/clawai/poll/route.ts. The desktop
// app polls this every `interval` seconds while the user types the code
// on the portal; once the upstream issues a token we write it to
// ~/.clawkeep/token in the background and the next poll resolves.
const CLAWKEEP_DEVICE_POLL_URL =
  process.env.CLAWKEEP_DEVICE_POLL_URL?.trim()
  || "https://openclawhardware.dev/api/clawkeep/device-poll";

interface UpstreamPollResponse {
  status?: string;
  access_token?: string;
  token?: string;
  error?: string;
  message?: string;
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.error || parsed.message || text;
  } catch {
    return text;
  }
}

// Save the token off the request lifecycle (mirrors the clawai/poll
// "configuring" pattern). Holding the poll open for the full file write
// + chmod cycle isn't strictly needed for ClawKeep — the disk write is
// fast — but the same state-machine keeps the UI logic uniform between
// the two flows.
async function persistTokenInBackground(session: ClawKeepConnectSession, accessToken: string) {
  try {
    await writeToken(accessToken);
    await writeClawKeepSession({
      ...session,
      status: "complete",
      error: null,
      completedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save ClawKeep token.";
    console.error("[clawkeep/poll] token save failed", err);
    await writeClawKeepSession({ ...session, status: "error", error: message });
  }
}

export async function POST() {
  const session = await readClawKeepSession();
  if (!session) {
    return NextResponse.json(
      { status: "error", error: "No pending ClawKeep session." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Terminal/intermediate states first — the next poll tick after a
  // browser sleep / disconnected fetch sees them without re-querying
  // upstream.
  if (session.status === "complete") {
    return NextResponse.json({ status: "complete" }, { headers: { "Cache-Control": "no-store" } });
  }
  if (session.status === "configuring") {
    return NextResponse.json({ status: "configuring" }, { headers: { "Cache-Control": "no-store" } });
  }
  if (session.status === "error" && session.error) {
    return NextResponse.json(
      { status: "error", error: session.error },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (isClawKeepSessionExpired(session)) {
    await clearClawKeepSession();
    return NextResponse.json(
      { status: "error", error: "ClawKeep code expired. Please request a new one." },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(CLAWKEEP_DEVICE_POLL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: session.device_id,
        user_code: session.user_code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // user_code is *not* logged — it's the secret the user types on the portal.
    console.warn(
      `[clawkeep/poll] upstream unreachable url=${CLAWKEEP_DEVICE_POLL_URL} device_id=${session.device_id}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ status: "pending" }, { headers: { "Cache-Control": "no-store" } });
  }

  if (upstreamRes.status === 202 || upstreamRes.status === 403 || upstreamRes.status === 404) {
    return NextResponse.json({ status: "pending" }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!upstreamRes.ok) {
    const errText = await readErrorBody(upstreamRes);
    if (upstreamRes.status === 410 || upstreamRes.status === 400) {
      const message = errText || "ClawKeep session is no longer valid.";
      await writeClawKeepSession({ ...session, status: "error", error: message });
      return NextResponse.json(
        { status: "error", error: message },
        { status: 410, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.warn("[clawkeep/poll] upstream poll failed", upstreamRes.status, errText.slice(0, 200));
    return NextResponse.json({ status: "pending" }, { headers: { "Cache-Control": "no-store" } });
  }

  const data = (await upstreamRes.json()) as UpstreamPollResponse;
  const upstreamStatus = (data.status || "").toLowerCase();

  if (upstreamStatus === "pending" || upstreamStatus === "authorization_pending") {
    return NextResponse.json({ status: "pending" }, { headers: { "Cache-Control": "no-store" } });
  }

  const accessToken = (data.access_token || data.token || "").trim();
  if (!accessToken) {
    if (upstreamStatus === "error") {
      const message = data.error || data.message || "ClawKeep authorisation failed.";
      await writeClawKeepSession({ ...session, status: "error", error: message });
      return NextResponse.json(
        { status: "error", error: message },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ status: "pending" }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!accessToken.startsWith("claw_")) {
    const message = "Portal returned malformed ClawKeep token.";
    await writeClawKeepSession({ ...session, status: "error", error: message });
    return NextResponse.json(
      { status: "error", error: message },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Move to `configuring` first so a concurrent poll can't fire two
  // background writes; ack the poll quickly so embedded Chromium doesn't
  // drop the request mid-write.
  const configuring: ClawKeepConnectSession = { ...session, status: "configuring", error: null };
  await writeClawKeepSession(configuring);
  void persistTokenInBackground(configuring, accessToken);

  return NextResponse.json({ status: "configuring" }, { headers: { "Cache-Control": "no-store" } });
}
