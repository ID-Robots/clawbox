import { NextResponse } from "next/server";
import { POST as configureAiModelsPost } from "@/app/setup-api/ai-models/configure/route";
import {
  type ClawAiConnectSession,
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

// Terminal portal errors that should stop the poll loop and surface an
// actionable message instead of being treated as "user hasn't entered
// the code yet". Adding a new gate is a one-row change here.
const TERMINAL_PORTAL_ERRORS: ReadonlyArray<{
  httpStatus: number;
  code: string;
  message: string;
}> = [
  {
    httpStatus: 403,
    code: "email_not_verified",
    message: "Please verify your email address in the ClawBox portal before authorising this device, then request a new device code.",
  },
  {
    httpStatus: 402,
    code: "paid_plan_required",
    message: "This tier needs a paid subscription. Subscribe to Pro or Max in the ClawBox portal, then request a new device code.",
  },
];

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

// Run the configure pipeline server-side AFTER acknowledging the poll
// request. Holding the poll's HTTP response open for the full ~50 s
// gateway restart left the embedded Chromium dropping the connection
// mid-flight, which stranded the UI on the device-code page even
// though provisioning had completed. The session-status state machine
// (pending → configuring → complete) lets a subsequent quick poll see
// that finalisation finished and trigger the success overlay.
async function runConfigureInBackground(session: ClawAiConnectSession, accessToken: string) {
  try {
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
      return;
    }

    await writeClawAiSession({
      ...session,
      status: "complete",
      error: null,
      completedAt: Date.now(),
    });
  } catch (err) {
    const userFacing = formatUserFacingError(err instanceof Error ? err.message : "Failed to save ClawBox AI token.");
    console.error("[clawai/poll] Background configure threw", err);
    await writeClawAiSession({ ...session, status: "error", error: userFacing });
  }
}

export async function POST() {
  const session = await readClawAiSession();
  if (!session) {
    return NextResponse.json({ status: "error", error: "No pending ClawBox AI session." }, { status: 400 });
  }

  // Terminal states first — return without re-querying upstream so the
  // UI sees the resolved state on its very next poll tick after a long
  // outage / browser sleep / disconnected fetch.
  if (session.status === "complete") {
    return NextResponse.json({ status: "complete" });
  }
  if (session.status === "configuring") {
    return NextResponse.json({ status: "configuring" });
  }
  if (session.status === "error" && session.error) {
    return NextResponse.json({ status: "error", error: session.error });
  }

  if (isClawAiSessionExpired(session)) {
    await clearClawAiSession();
    return NextResponse.json({ status: "error", error: "ClawBox AI code expired. Please request a new code." }, { status: 410 });
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
    // Include the upstream URL and device_id so a single log line is enough
    // to correlate a transient failure to the affected device pairing flow.
    // user_code is *not* logged — it's the secret the user types on the
    // portal to claim this session.
    console.warn(
      `[clawai/poll] Upstream unreachable url=${CLAWBOX_AI_DEVICE_POLL_URL} device_id=${session.device_id}:`,
      err instanceof Error ? err.message : err,
    );
    // Treat transient failures as pending so the UI keeps polling — the
    // user may simply be on a flaky uplink; turning every blip into a
    // hard error would drop them back to the start of the flow.
    return NextResponse.json({ status: "pending" });
  }

  // 202/403/404 are common "user hasn't entered the code yet" responses.
  // Exception: a status carrying a known terminal error code (e.g. 403
  // email_not_verified, 402 paid_plan_required) means the portal will
  // never advance — write the error to the session and surface it so
  // the UI stops polling and renders the actionable instruction
  // instead of stalling on the device-code page.
  const terminal = TERMINAL_PORTAL_ERRORS.find((e) => e.httpStatus === upstreamRes.status);
  if (terminal) {
    const errCode = (await readErrorBody(upstreamRes)).trim().toLowerCase();
    if (errCode === terminal.code) {
      await writeClawAiSession({ ...session, status: "error", error: terminal.message });
      return NextResponse.json({ status: "error", error: terminal.message }, { status: terminal.httpStatus });
    }
    return NextResponse.json({ status: "pending" });
  }
  if (upstreamRes.status === 202 || upstreamRes.status === 404) {
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

  // Upstream issued a token. Mark the session as `configuring` first so
  // a concurrent poll (which can happen if the client is on a fast
  // interval) doesn't fire a second background configure. Then kick
  // off the configure off the request lifecycle and acknowledge the
  // poll quickly. The next poll tick — typically within `interval`
  // seconds — sees `configuring` or `complete` and the UI advances.
  const configuringSession: ClawAiConnectSession = { ...session, status: "configuring", error: null };
  await writeClawAiSession(configuringSession);
  void runConfigureInBackground(configuringSession, accessToken);

  return NextResponse.json({ status: "configuring" });
}
