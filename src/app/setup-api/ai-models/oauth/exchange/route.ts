import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

interface OAuthProviderConfig {
  clientId: string;
  redirectUri: string;
  tokenEndpoint: string;
}

const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  anthropic: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
  },
  openai: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    tokenEndpoint: "https://auth.openai.com/oauth/token",
  },
};

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
    // Anthropic expects state in the token exchange; OpenAI does not
    if (provider === "anthropic") {
      exchangeBody.state = codeState || stored.state;
    }

    // Anthropic accepts JSON; OpenAI requires form-urlencoded
    const useFormEncoding = provider === "openai";
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
          const apiKeyData = await apiKeyRes.json();
          apiKeyToken = apiKeyData.access_token || apiKeyData.api_key;
          apiKeyExpires = apiKeyData.expires_in;
          console.log("[oauth/exchange] API key exchange succeeded");
        } else {
          console.log("[oauth/exchange] API key exchange failed, using access_token:", apiKeyRes.status);
        }
      } catch (e) {
        console.log("[oauth/exchange] API key exchange error, using access_token:", e);
      }

      await fs.unlink(STATE_PATH).catch(() => {});

      return NextResponse.json({
        access_token: apiKeyToken || tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: apiKeyExpires || tokenData.expires_in,
      });
    }

    // Only delete state file on success
    await fs.unlink(STATE_PATH).catch(() => {});

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
