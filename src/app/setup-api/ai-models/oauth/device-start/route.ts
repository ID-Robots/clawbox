import { NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { DEVICE_AUTH_PROVIDERS } from "@/lib/oauth-config";

export const dynamic = "force-dynamic";

const STATE_PATH = path.join(DATA_DIR, "oauth-device-state.json");

export async function POST(request: Request) {
  try {
    let body: { provider?: string } = {};
    try {
      body = await request.json();
    } catch {
      // No body or invalid JSON — default to openai for backward compat
    }

    const providerName = body.provider || "openai";
    const config = DEVICE_AUTH_PROVIDERS[providerName];
    if (!config) {
      return NextResponse.json(
        { error: `Device auth not supported for provider: ${providerName}` },
        { status: 400 }
      );
    }

    const reqBody =
      config.requestFormat === "form"
        ? new URLSearchParams({ client_id: config.clientId }).toString()
        : JSON.stringify({ client_id: config.clientId });
    const contentType =
      config.requestFormat === "form"
        ? "application/x-www-form-urlencoded"
        : "application/json";

    const res = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: reqBody,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[device-start/${providerName}] Failed:`, res.status, errText);
      return NextResponse.json(
        { error: `Device auth request failed (${res.status})` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const deviceId = data[config.responseFields.deviceId];
    const userCode = data[config.responseFields.userCode];
    const interval = data[config.responseFields.interval] || 5;
    const verificationUrl = config.verificationUrl;

    if (!deviceId || !userCode) {
      console.error(`[device-start/${providerName}] Unexpected response:`, data);
      return NextResponse.json(
        { error: `Unexpected response from ${providerName} device auth` },
        { status: 502 }
      );
    }

    await fs.mkdir(DATA_DIR, { recursive: true });

    // Atomic write
    const tmpPath =
      STATE_PATH + `.tmp.${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({
        provider: providerName,
        device_id: deviceId,
        user_code: userCode,
        interval,
        createdAt: Date.now(),
      }),
      { mode: 0o600 }
    );
    await fs.rename(tmpPath, STATE_PATH);

    return NextResponse.json({
      verification_url: verificationUrl,
      user_code: userCode,
      interval,
    });
  } catch (err) {
    console.error("[device-start] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to start device auth",
      },
      { status: 500 }
    );
  }
}
