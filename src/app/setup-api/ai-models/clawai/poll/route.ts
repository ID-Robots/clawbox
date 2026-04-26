import { NextResponse } from "next/server";
import { POST as configureAiModelsPost } from "@/app/setup-api/ai-models/configure/route";
import {
  clearClawAiSession,
  isClawAiSessionExpired,
  readClawAiSession,
  writeClawAiSession,
} from "@/lib/clawai-connect";

export const dynamic = "force-dynamic";

const CLAWBOX_AI_DEVICE_POLL_URL =
  process.env.CLAWBOX_AI_DEVICE_POLL_URL?.trim()
  || "https://openclawhardware.dev/api/clawbox-ai/device-poll";

interface UpstreamPollResponse {
  status?: string;
  access_token?: string;
  token?: string;
  error?: string;
  message?: string;
}

function formatUserFacingError(message: string) {
  const normalized = message.trim();
  if (/token limit reached/i.test(normalized)) {
    return "ClawBox AI could not authorise this device because your account has reached its token limit. Remove an old token in the portal or upgrade your plan, then try again.";
  }
  return normalized || "ClawBox AI authorisation failed.";
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

export async function POST() {
  const session = await readClawAiSession();
  if (!session) {
    return NextResponse.json({ status: "error", error: "No pending ClawBox AI session." }, { status: 400 });
  }

  if (isClawAiSessionExpired(session)) {
    await clearClawAiSession();
    return NextResponse.json({ status: "error", error: "ClawBox AI code expired. Please request a new code." }, { status: 410 });
  }

  if (session.status === "complete") {
    return NextResponse.json({ status: "complete" });
  }
  if (session.status === "error" && session.error) {
    return NextResponse.json({ status: "error", error: session.error });
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(CLAWBOX_AI_DEVICE_POLL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: session.device_id,
        user_code: session.user_code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.warn("[clawai/poll] Upstream unreachable", err instanceof Error ? err.message : err);
    // Treat transient failures as pending so the UI keeps polling — the
    // user may simply be on a flaky uplink; turning every blip into a
    // hard error would drop them back to the start of the flow.
    return NextResponse.json({ status: "pending" });
  }

  // 202/403/404 are common "user hasn't entered the code yet" responses.
  if (upstreamRes.status === 202 || upstreamRes.status === 403 || upstreamRes.status === 404) {
    return NextResponse.json({ status: "pending" });
  }

  if (!upstreamRes.ok) {
    const errText = await readErrorBody(upstreamRes);
    if (upstreamRes.status === 410 || upstreamRes.status === 400) {
      const userFacing = formatUserFacingError(errText || "ClawBox AI session is no longer valid.");
      await writeClawAiSession({ ...session, status: "error", error: userFacing });
      return NextResponse.json({ status: "error", error: userFacing }, { status: 410 });
    }
    console.warn("[clawai/poll] Upstream poll failed", upstreamRes.status, errText.slice(0, 200));
    // 5xx — don't burn the session; let the UI retry.
    return NextResponse.json({ status: "pending" });
  }

  const data = await upstreamRes.json() as UpstreamPollResponse;
  const upstreamStatus = (data.status || "").toLowerCase();

  if (upstreamStatus === "pending" || upstreamStatus === "authorization_pending") {
    return NextResponse.json({ status: "pending" });
  }

  const accessToken = (data.access_token || data.token || "").trim();
  if (!accessToken) {
    if (upstreamStatus === "error") {
      const userFacing = formatUserFacingError(data.error || data.message || "ClawBox AI authorisation failed.");
      await writeClawAiSession({ ...session, status: "error", error: userFacing });
      return NextResponse.json({ status: "error", error: userFacing });
    }
    // Unknown payload — keep polling rather than aborting.
    return NextResponse.json({ status: "pending" });
  }

  // Authorised — drive the configure pipeline server-side so the gateway
  // restart happens before we report success to the UI. Without this
  // round-trip the chat would briefly point at the old (no-token)
  // provider until the next configure call.
  const configureResponse = await configureAiModelsPost(new Request("http://localhost/setup-api/ai-models/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: session.scope,
      provider: "clawai",
      apiKey: accessToken,
      authMode: "subscription",
      clawaiTier: session.tier ?? "flash",
    }),
  }));

  if (!configureResponse.ok) {
    const configureBody = await configureResponse.text().catch(() => "");
    const userFacing = formatUserFacingError(configureBody || "Failed to save ClawBox AI token.");
    console.error("[clawai/poll] Token save failed", configureResponse.status, configureBody.slice(0, 200));
    await writeClawAiSession({ ...session, status: "error", error: userFacing });
    return NextResponse.json({ status: "error", error: userFacing });
  }

  await writeClawAiSession({
    ...session,
    status: "complete",
    error: null,
    completedAt: Date.now(),
  });

  return NextResponse.json({ status: "complete" });
}
