import { NextResponse } from "next/server";
import fs from "fs/promises";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const STATE_PATH = "/tmp/clawbox-oauth-state.json";

export async function POST(request: Request) {
  try {
    let body: { code?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { code } = body;
    if (!code) {
      return NextResponse.json(
        { error: "Authorization code is required" },
        { status: 400 }
      );
    }

    let stored: { codeVerifier: string; state: string; createdAt: number };
    try {
      const raw = await fs.readFile(STATE_PATH, "utf-8");
      stored = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: "No pending OAuth session. Click 'Connect with Claude' first." },
        { status: 400 }
      );
    }

    // Reject if state is older than 10 minutes
    if (Date.now() - stored.createdAt > 10 * 60 * 1000) {
      await fs.unlink(STATE_PATH).catch(() => {});
      return NextResponse.json(
        { error: "OAuth session expired. Please start again." },
        { status: 400 }
      );
    }

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: stored.codeVerifier,
      state: stored.state,
    });

    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    if (!tokenRes.ok) {
      // Don't delete state file on failure so user can retry
      const errText = await tokenRes.text().catch(() => "");
      let errMsg = `Token exchange failed (${tokenRes.status})`;
      try {
        const errJson = JSON.parse(errText);
        if (typeof errJson.error_description === "string") {
          errMsg = errJson.error_description;
        } else if (typeof errJson.error === "string") {
          errMsg = errJson.error;
        } else if (errJson.error?.message) {
          errMsg = String(errJson.error.message);
        } else if (typeof errJson.message === "string") {
          errMsg = errJson.message;
        }
      } catch {
        if (errText) errMsg = errText.slice(0, 200);
      }
      return NextResponse.json({ error: errMsg }, { status: 400 });
    }

    // Only delete state file on success
    await fs.unlink(STATE_PATH).catch(() => {});

    const tokenData = await tokenRes.json();

    return NextResponse.json({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to exchange token",
      },
      { status: 500 }
    );
  }
}
