import { NextRequest, NextResponse } from "next/server";
import os from "os";
import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import {
  CLAWAI_USER_CODE_LENGTH,
  createClawAiDeviceId,
  createClawAiUserCode,
  writeClawAiSession,
} from "@/lib/clawai-connect";

export const dynamic = "force-dynamic";

const CLAWBOX_AI_DEVICE_START_URL =
  process.env.CLAWBOX_AI_DEVICE_START_URL?.trim()
  || "https://openclawhardware.dev/api/clawbox-ai/device-start";
const CLAWBOX_AI_VERIFICATION_URL =
  process.env.CLAWBOX_AI_VERIFICATION_URL?.trim()
  || `${PORTAL_LOGIN_URL}/connect`;
const DEFAULT_INTERVAL_SECONDS = 5;

interface UpstreamDeviceStartResponse {
  user_code?: string;
  device_id?: string;
  device_code?: string;
  interval?: number;
  verification_url?: string;
  verification_uri?: string;
}

export async function POST(request: NextRequest) {
  let body: { scope?: "primary" | "local"; deviceName?: string; tier?: "flash" | "pro" } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — defaults applied below.
  }

  const scope = body.scope === "local" ? "local" : "primary";
  const tier = body.tier === "pro" ? "pro" : "flash";
  const deviceName = body.deviceName?.trim() || os.hostname() || "ClawBox";

  // Try the upstream device-start endpoint first. The portal owns the
  // user_code <-> device_id mapping in production so codes survive a
  // device reboot mid-flow. If the upstream is unreachable (offline
  // network, dev environment without portal access), fall through to a
  // device-generated code so the UI still renders something useful.
  let userCode: string | null = null;
  let deviceId: string | null = null;
  let interval = DEFAULT_INTERVAL_SECONDS;
  let verificationUrl = CLAWBOX_AI_VERIFICATION_URL;

  try {
    const upstreamRes = await fetch(CLAWBOX_AI_DEVICE_START_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: deviceName, tier }),
      signal: AbortSignal.timeout(15_000),
    });
    if (upstreamRes.ok) {
      const data = await upstreamRes.json() as UpstreamDeviceStartResponse;
      const upstreamCode = (data.user_code || "").trim();
      const upstreamDeviceId = (data.device_id || data.device_code || "").trim();
      if (upstreamCode && upstreamDeviceId) {
        userCode = upstreamCode;
        deviceId = upstreamDeviceId;
        if (typeof data.interval === "number" && data.interval > 0) interval = data.interval;
        const upstreamVerification = (data.verification_url || data.verification_uri || "").trim();
        if (upstreamVerification) verificationUrl = upstreamVerification;
      }
    } else {
      const errText = await upstreamRes.text().catch(() => "");
      console.warn("[clawai/start] Upstream device-start failed", upstreamRes.status, errText.slice(0, 200));
    }
  } catch (err) {
    console.warn("[clawai/start] Upstream device-start unreachable; using local fallback", err instanceof Error ? err.message : err);
  }

  if (!userCode || !deviceId) {
    userCode = createClawAiUserCode();
    deviceId = createClawAiDeviceId();
  }

  await writeClawAiSession({
    device_id: deviceId,
    user_code: userCode,
    interval,
    createdAt: Date.now(),
    status: "pending",
    provider: "clawai",
    scope,
    tier,
    deviceName,
    verificationUrl,
    error: null,
  });

  return NextResponse.json({
    user_code: userCode,
    verification_url: verificationUrl,
    interval,
    code_length: CLAWAI_USER_CODE_LENGTH,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
