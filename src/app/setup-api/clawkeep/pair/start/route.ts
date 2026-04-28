import { NextRequest, NextResponse } from "next/server";
import os from "os";

import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import {
  CLAWKEEP_USER_CODE_LENGTH,
  createClawKeepDeviceId,
  createClawKeepUserCode,
  writeClawKeepSession,
} from "@/lib/clawkeep-connect";

export const dynamic = "force-dynamic";

// Mirrors src/app/setup-api/ai-models/clawai/start/route.ts. RFC 8628
// device-code flow: ask the portal for a code, return it to the desktop
// so the user can type it on the verification URL on their phone, then
// poll /pair/poll until the portal issues a token.
const CLAWKEEP_DEVICE_START_URL =
  process.env.CLAWKEEP_DEVICE_START_URL?.trim()
  || "https://openclawhardware.dev/api/clawkeep/device-start";
const CLAWKEEP_VERIFICATION_URL =
  process.env.CLAWKEEP_VERIFICATION_URL?.trim()
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
  let parsed: unknown = {};
  try {
    parsed = await request.json();
  } catch {
    // Empty body is fine.
  }
  if (parsed !== null && typeof parsed !== "object") {
    return NextResponse.json(
      { error: "request body must be an object" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = (parsed ?? {}) as { deviceName?: unknown };
  const deviceNameRaw = typeof body.deviceName === "string" ? body.deviceName : "";
  const deviceName = deviceNameRaw.trim() || os.hostname() || "ClawBox";

  let userCode: string | null = null;
  let deviceId: string | null = null;
  let interval = DEFAULT_INTERVAL_SECONDS;
  let verificationUrl = CLAWKEEP_VERIFICATION_URL;

  // Try the upstream first so a fleet of devices that share a portal
  // account can't accidentally collide on a locally-generated code.
  // Falls back to a device-generated code so the UI still has something
  // to render when offline / against a dev portal without the endpoint.
  try {
    const upstreamRes = await fetch(CLAWKEEP_DEVICE_START_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: deviceName }),
      signal: AbortSignal.timeout(15_000),
    });
    if (upstreamRes.ok) {
      const data = (await upstreamRes.json()) as UpstreamDeviceStartResponse;
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
      console.warn("[clawkeep/start] upstream device-start failed", upstreamRes.status, errText.slice(0, 200));
    }
  } catch (err) {
    console.warn(
      "[clawkeep/start] upstream device-start unreachable; using local fallback",
      err instanceof Error ? err.message : err,
    );
  }

  if (!userCode || !deviceId) {
    userCode = createClawKeepUserCode();
    deviceId = createClawKeepDeviceId();
  }

  await writeClawKeepSession({
    device_id: deviceId,
    user_code: userCode,
    interval,
    createdAt: Date.now(),
    status: "pending",
    deviceName,
    verificationUrl,
    error: null,
  });

  return NextResponse.json(
    {
      user_code: userCode,
      verification_url: verificationUrl,
      interval,
      code_length: CLAWKEEP_USER_CODE_LENGTH,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
