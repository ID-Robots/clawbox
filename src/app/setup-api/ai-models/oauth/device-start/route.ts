import { NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const VERIFICATION_URL = "https://auth.openai.com/codex/device";

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const STATE_DIR = path.join(CONFIG_ROOT, "data");
const STATE_PATH = path.join(STATE_DIR, "oauth-device-state.json");

export async function POST() {
  try {
    // OpenAI device auth: server generates its own PKCE pair.
    // We do NOT send code_challenge — the poll response will include
    // the code_verifier we need for the token exchange.
    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[device-start] Failed:", res.status, errText);
      return NextResponse.json(
        { error: `Device auth request failed (${res.status})` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const { device_auth_id, user_code, interval } = data;

    if (!device_auth_id || !user_code) {
      console.error("[device-start] Unexpected response:", data);
      return NextResponse.json(
        { error: "Unexpected response from OpenAI device auth" },
        { status: 502 }
      );
    }

    await fs.mkdir(STATE_DIR, { recursive: true });

    // Atomic write
    const tmpPath =
      STATE_PATH + `.tmp.${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({
        device_auth_id,
        user_code,
        interval: interval || 5,
        createdAt: Date.now(),
      }),
      { mode: 0o600 }
    );
    await fs.rename(tmpPath, STATE_PATH);

    return NextResponse.json({
      verification_url: VERIFICATION_URL,
      user_code,
      interval: interval || 5,
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
