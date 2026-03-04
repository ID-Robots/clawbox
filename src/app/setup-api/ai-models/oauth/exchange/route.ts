export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { OAUTH_PROVIDERS } from "@/lib/oauth-config";
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
    const tokenController = new AbortController();
    const tokenTimeout = setTimeout(() => tokenController.abort(), 30_000);

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

    const tokenData = await tokenRes.json();

    // OpenAI: try second exchange (id_token → API key), fall back to access_token
    if (provider === "openai" && tokenData.id_token) {
      let apiKeyToken: string | undefined;
      let apiKeyExpires: number | undefined;

      try {
        const exchangeParams: Record<string, string> = {
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          client_id: config.clientId,
          requested_token: "openai-api-key",
          subject_token: tokenData.id_token,
          subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        };

        const apiKeyRes = await fetch(config.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(exchangeParams).toString(),
          signal: AbortSignal.timeout(30_000),
        });

        if (apiKeyRes.ok) {
          try {
            const apiKeyData = await apiKeyRes.json();
            apiKeyToken = apiKeyData.access_token || apiKeyData.api_key;
            apiKeyExpires = apiKeyData.expires_in;
            console.log("[oauth/exchange] API key exchange succeeded");
          } catch (parseErr) {
            const raw = await apiKeyRes.text().catch(() => "(unreadable)");
            console.error("[oauth/exchange] API key exchange JSON parse error:", parseErr, "raw:", raw);
          }
        } else {
          const errBody = await apiKeyRes.text().catch(() => "");
          console.error("[oauth/exchange] API key exchange failed:", apiKeyRes.status, errBody);
        }
      } catch (e) {
        console.error("[oauth/exchange] API key exchange error, using access_token:", e);
      }

      await fs.unlink(STATE_PATH).catch(() => {});
      // Clean up saved org file now that exchange succeeded
      const orgPath = path.join(path.dirname(STATE_PATH), "oauth-org.json");
      await fs.unlink(orgPath).catch(() => {});

      return NextResponse.json({
        access_token: apiKeyToken || tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: apiKeyExpires || tokenData.expires_in,
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
