import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const STATE_PATH = path.join(CONFIG_ROOT, "data", "oauth-state.json");

function parseErrorMessage(text: string, status: number): string {
  try {
    const j = JSON.parse(text);
    return j.error_description ?? j.error?.message ?? j.error ?? j.message
      ?? `Token exchange failed (${status})`;
  } catch {
    return text?.slice(0, 200) || `Token exchange failed (${status})`;
  }
}

export async function POST(request: Request) {
  try {
    let body: { code?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const rawCode = body.code?.trim();
    if (!rawCode) {
      return NextResponse.json(
        { error: "Authorization code is required" },
        { status: 400 }
      );
    }

    // The callback returns code#state — split them
    let code = rawCode;
    let codeState: string | undefined;
    if (rawCode.includes("#")) {
      const parts = rawCode.split("#");
      code = parts[0];
      codeState = parts[1];
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

    const exchangeBody = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: stored.codeVerifier,
      state: codeState || stored.state,
    };

    const tokenController = new AbortController();
    const tokenTimeout = setTimeout(() => tokenController.abort(), 30_000);

    let tokenRes: Response;
    try {
      tokenRes = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exchangeBody),
        signal: tokenController.signal,
      });
    } catch (fetchErr) {
      clearTimeout(tokenTimeout);
      if (fetchErr instanceof DOMException && fetchErr.name === "AbortError") {
        return NextResponse.json(
          { error: "Token exchange timed out" },
          { status: 504 }
        );
      }
      throw fetchErr;
    } finally {
      clearTimeout(tokenTimeout);
    }

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => "");
      return NextResponse.json(
        { error: parseErrorMessage(errText, tokenRes.status) },
        { status: 502 }
      );
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
