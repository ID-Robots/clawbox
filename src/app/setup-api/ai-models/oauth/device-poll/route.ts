import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
// Codex CLI: redirect_uri = "{issuer}/deviceauth/callback"
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const TOKEN_URL = `${ISSUER}/oauth/token`;

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const STATE_PATH = path.join(CONFIG_ROOT, "data", "oauth-device-state.json");

export async function POST() {
  try {
    let stored: {
      device_auth_id: string;
      user_code: string;
      interval: number;
      createdAt: number;
    };
    try {
      const raw = await fs.readFile(STATE_PATH, "utf-8");
      stored = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: "No pending device auth session. Start the flow first." },
        { status: 400 }
      );
    }

    // 15-minute expiry
    if (Date.now() - stored.createdAt > 15 * 60 * 1000) {
      await fs.unlink(STATE_PATH).catch(() => {});
      return NextResponse.json(
        { error: "Device auth session expired. Please start again." },
        { status: 400 }
      );
    }

    // Poll OpenAI for authorization status
    const pollRes = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: stored.device_auth_id,
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
      console.error("[device-poll] Poll failed:", pollRes.status, errText);
      // Treat other errors as pending to allow retry
      return NextResponse.json({ status: "pending" });
    }

    const pollData = await pollRes.json();
    console.log("[device-poll] Poll response keys:", Object.keys(pollData));

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
    // OpenAI returns { status: "success", authorization_code: "...", code_verifier: "..." }
    const authCode = pollData.authorization_code || pollData.code;
    if (authCode) {
      // OpenAI's device auth poll returns its own code_verifier
      const verifier = pollData.code_verifier;
      if (!verifier) {
        console.error("[device-poll] No code_verifier in poll response:", pollData);
        await fs.unlink(STATE_PATH).catch(() => {});
        return NextResponse.json(
          { error: "OpenAI did not return code_verifier" },
          { status: 502 }
        );
      }
      const exchangeParams = {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authCode,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      };
      console.log("[device-poll] Auth code received, exchanging tokens at", TOKEN_URL);
      console.log("[device-poll] Exchange params:", JSON.stringify({
        ...exchangeParams,
        code: exchangeParams.code.slice(0, 10) + "...",
        code_verifier: exchangeParams.code_verifier.slice(0, 10) + "...",
      }));
      const exchangeRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(exchangeParams).toString(),
        signal: AbortSignal.timeout(30_000),
      });

      if (!exchangeRes.ok) {
        const errText = await exchangeRes.text().catch(() => "");
        console.error(
          "[device-poll] Token exchange failed:",
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

      // Try id_token → API key exchange (same as regular OAuth flow)
      if (tokenData.id_token) {
        try {
          const apiKeyRes = await fetch(TOKEN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type:
                "urn:ietf:params:oauth:grant-type:token-exchange",
              client_id: CLIENT_ID,
              requested_token: "openai-api-key",
              subject_token: tokenData.id_token,
              subject_token_type:
                "urn:ietf:params:oauth:token-type:id_token",
            }).toString(),
            signal: AbortSignal.timeout(30_000),
          });

          if (apiKeyRes.ok) {
            const apiKeyData = await apiKeyRes.json();
            console.log("[device-poll] API key exchange succeeded");
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
            "[device-poll] API key exchange failed, using access_token"
          );
        } catch (e) {
          console.log(
            "[device-poll] API key exchange error, using access_token:",
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
    console.log("[device-poll] Unexpected response:", pollData);
    return NextResponse.json({ status: "pending" });
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
