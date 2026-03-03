import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import {
  OPENAI_CLIENT_ID,
  OPENAI_DEVICE_TOKEN_URL,
  OPENAI_REDIRECT_URI,
  OPENAI_TOKEN_URL,
} from "@/lib/oauth-config";

export const dynamic = "force-dynamic";

const STATE_PATH = path.join(DATA_DIR, "oauth-device-state.json");

interface StoredState {
  provider?: string;
  device_id?: string;
  device_auth_id?: string; // Legacy field from old OpenAI-only format
  user_code: string;
  interval: number;
  createdAt: number;
}

async function pollOpenAI(stored: StoredState): Promise<NextResponse> {
  const deviceAuthId = stored.device_id || stored.device_auth_id;
  if (!deviceAuthId) {
    return NextResponse.json(
      { error: "Missing device_id in stored state. Restart the device auth flow." },
      { status: 400 },
    );
  }

  const pollRes = await fetch(OPENAI_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: deviceAuthId,
      user_code: stored.user_code,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  // 403/404 = user hasn't authorized yet
  if (pollRes.status === 403 || pollRes.status === 404) {
    return NextResponse.json({ status: "pending" });
  }

  if (!pollRes.ok) {
    const errText = await pollRes.text().catch(() => "");
    console.error("[device-poll/openai] Poll failed:", pollRes.status, errText);
    // 5xx = server error, surface it; 4xx (not 403/404) = client error
    if (pollRes.status >= 500) {
      return NextResponse.json(
        { error: `OpenAI poll error (${pollRes.status})` },
        { status: 502 },
      );
    }
    return NextResponse.json({ status: "pending" });
  }

  const pollData = await pollRes.json();
  console.log("[device-poll/openai] Poll response keys:", Object.keys(pollData));

  // If polling returns tokens directly
  if (pollData.access_token) {
    await fs.unlink(STATE_PATH).catch(() => {});
    return NextResponse.json({
      status: "complete",
      access_token: pollData.access_token,
      refresh_token: pollData.refresh_token,
      expires_in: pollData.expires_in,
    });
  }

  // If polling returns an authorization code, exchange it.
  const authCode = pollData.authorization_code || pollData.code;
  if (authCode) {
    const verifier = pollData.code_verifier;
    if (!verifier) {
      console.error("[device-poll/openai] No code_verifier in poll response:", pollData);
      await fs.unlink(STATE_PATH).catch(() => {});
      return NextResponse.json(
        { error: "OpenAI did not return code_verifier" },
        { status: 502 }
      );
    }
    const exchangeParams = {
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code: authCode,
      code_verifier: verifier,
      redirect_uri: OPENAI_REDIRECT_URI,
    };
    console.log("[device-poll/openai] Auth code received, exchanging tokens at", OPENAI_TOKEN_URL);
    console.log("[device-poll/openai] Exchange params:", JSON.stringify({
      ...exchangeParams,
      code: exchangeParams.code.slice(0, 10) + "...",
      code_verifier: exchangeParams.code_verifier.slice(0, 10) + "...",
    }));
    const exchangeRes = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(exchangeParams).toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!exchangeRes.ok) {
      const errText = await exchangeRes.text().catch(() => "");
      console.error(
        "[device-poll/openai] Token exchange failed:",
        exchangeRes.status,
        errText
      );
      await fs.unlink(STATE_PATH).catch(() => {});
      return NextResponse.json(
        { error: `Token exchange failed (${exchangeRes.status})` },
        { status: 502 }
      );
    }

    const tokenData = await exchangeRes.json();

    // Try id_token → API key exchange
    if (tokenData.id_token) {
      try {
        const apiKeyRes = await fetch(OPENAI_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type:
              "urn:ietf:params:oauth:grant-type:token-exchange",
            client_id: OPENAI_CLIENT_ID,
            requested_token: "openai-api-key",
            subject_token: tokenData.id_token,
            subject_token_type:
              "urn:ietf:params:oauth:token-type:id_token",
          }).toString(),
          signal: AbortSignal.timeout(30_000),
        });

        if (apiKeyRes.ok) {
          const apiKeyData = await apiKeyRes.json();
          console.log("[device-poll/openai] API key exchange succeeded");
          await fs.unlink(STATE_PATH).catch(() => {});
          return NextResponse.json({
            status: "complete",
            access_token:
              apiKeyData.access_token ||
              apiKeyData.api_key ||
              tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_in: apiKeyData.expires_in || tokenData.expires_in,
          });
        }
        console.log(
          "[device-poll/openai] API key exchange failed, using access_token"
        );
      } catch (e) {
        console.log(
          "[device-poll/openai] API key exchange error, using access_token:",
          e
        );
      }
    }

    await fs.unlink(STATE_PATH).catch(() => {});
    return NextResponse.json({
      status: "complete",
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
    });
  }

  // Unknown response — treat as pending
  console.log("[device-poll/openai] Unexpected response:", pollData);
  return NextResponse.json({ status: "pending" });
}

export async function POST() {
  try {
    let stored: StoredState;
    try {
      const raw = await fs.readFile(STATE_PATH, "utf-8");
      stored = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: "No pending device auth session. Start the flow first." },
        { status: 400 }
      );
    }

    // Backward compat: old state files have no provider field
    if (!stored.provider) stored.provider = "openai";
    if (!stored.device_id && stored.device_auth_id) stored.device_id = stored.device_auth_id;

    // 15-minute expiry
    if (Date.now() - stored.createdAt > 15 * 60 * 1000) {
      await fs.unlink(STATE_PATH).catch(() => {});
      return NextResponse.json(
        { error: "Device auth session expired. Please start again." },
        { status: 400 }
      );
    }

    return await pollOpenAI(stored);
  } catch (err) {
    console.error("[device-poll] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to poll device auth",
      },
      { status: 500 }
    );
  }
}
