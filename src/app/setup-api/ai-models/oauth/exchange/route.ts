export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { OAUTH_PROVIDERS, isGoogleConfigured } from "@/lib/oauth-config";
import { discoverGoogleProject } from "@/lib/google-project";

const STATE_PATH = path.join(DATA_DIR, "oauth-state.json");

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

    let stored: { codeVerifier: string; state: string; provider: string; createdAt: number };
    try {
      const raw = await fs.readFile(STATE_PATH, "utf-8");
      stored = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: "No pending OAuth session. Start the connection flow first." },
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

    const provider = stored.provider || "anthropic";
    if (provider === "google" && !isGoogleConfigured) {
      await fs.unlink(STATE_PATH).catch(() => {});
      return NextResponse.json(
        { error: "Google OAuth credentials not configured. Run install.sh to set them up." },
        { status: 500 }
      );
    }
    const config = OAUTH_PROVIDERS[provider];
    if (!config) {
      await fs.unlink(STATE_PATH).catch(() => {});
      return NextResponse.json(
        { error: `OAuth not supported for provider: ${provider}` },
        { status: 400 }
      );
    }

    const exchangeBody: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: stored.codeVerifier,
    };
    // Anthropic expects state in the token exchange; OpenAI does not.
    // Validate state to enforce CSRF protection.
    if (provider === "anthropic") {
      if (!codeState || codeState !== stored.state) {
        await fs.unlink(STATE_PATH).catch(() => {});
        console.error("[oauth/exchange] State mismatch:", { codeState, expected: stored.state });
        return NextResponse.json(
          { error: "OAuth state mismatch. Please restart the authorization flow." },
          { status: 403 }
        );
      }
      exchangeBody.state = codeState;
    }

    // Google requires client_secret in the token exchange
    if (config.clientSecret) {
      exchangeBody.client_secret = config.clientSecret;
    }

    // Anthropic accepts JSON; OpenAI and Google require form-urlencoded
    const useFormEncoding = provider !== "anthropic";
    let tokenRes: Response;
    try {
      tokenRes = await fetch(config.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": useFormEncoding
            ? "application/x-www-form-urlencoded"
            : "application/json",
        },
        body: useFormEncoding
          ? new URLSearchParams(exchangeBody).toString()
          : JSON.stringify(exchangeBody),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (fetchErr) {
      if (fetchErr instanceof DOMException && fetchErr.name === "TimeoutError") {
        return NextResponse.json(
          { error: "Token exchange timed out" },
          { status: 504 }
        );
      }
      throw fetchErr;
    }

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => "");
      return NextResponse.json(
        { error: parseErrorMessage(errText, tokenRes.status) },
        { status: 502 }
      );
    }

    const tokenData = await tokenRes.json();

    // OpenAI: try second exchange (id_token → API key), fall back to access_token
    // OpenAI/Codex (subscription): keep the raw OAuth JWTs — access_token +
    // id_token + refresh_token. Do NOT exchange the id_token for an
    // `openai-api-key`: that returns an `sk-` key (not a JWT) which gets stored
    // as the codex `access` / synthesized id_token and fails with "invalid ID
    // token format". Mirrors the device-poll (device-code) flow.
    if (provider === "openai") {
      await fs.unlink(STATE_PATH).catch(() => {});
      // Clean up saved org file now that exchange succeeded
      const orgPath = path.join(path.dirname(STATE_PATH), "oauth-org.json");
      await fs.unlink(orgPath).catch(() => {});

      return NextResponse.json({
        access_token: tokenData.access_token,
        id_token: tokenData.id_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
      });
    }

    // Only delete state file on success
    await fs.unlink(STATE_PATH).catch(() => {});

    // For Google: discover (or provision) the Cloud Code Assist project ID
    // so the google-gemini-cli provider can build correct API requests.
    let projectId: string | undefined;
    if (provider === "google" && tokenData.access_token) {
      try {
        projectId = await discoverGoogleProject(tokenData.access_token);
        console.log("[oauth/exchange] Google projectId:", projectId ?? "(not found)");
      } catch (e) {
        console.error("[oauth/exchange] Failed to discover Google projectId:", e);
      }
    }

    return NextResponse.json({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      ...(projectId ? { projectId } : {}),
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
