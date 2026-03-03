export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { OAUTH_PROVIDERS } from "@/lib/oauth-config";

const STATE_PATH = path.join(DATA_DIR, "oauth-state.json");

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED" as const,
  platform: "PLATFORM_UNSPECIFIED" as const,
  pluginType: "GEMINI" as const,
};
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";

/**
 * Discover (or provision) the Google Cloud Code Assist project ID.
 * Replicates the flow from OpenClaw's google-gemini-cli-auth plugin:
 *   1. loadCodeAssist → if currentTier exists, extract projectId
 *   2. Otherwise onboardUser (free-tier) → poll LRO → extract projectId
 */
async function discoverGoogleProject(accessToken: string): Promise<string | undefined> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/openclaw",
  };

  // Step 1: loadCodeAssist
  const loadBody = { metadata: CODE_ASSIST_METADATA };

  const loadRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify(loadBody),
    signal: AbortSignal.timeout(30_000),
  });

  if (!loadRes.ok) {
    const errText = await loadRes.text().catch(() => "");
    console.error("[oauth/exchange] loadCodeAssist failed:", loadRes.status, errText);
    throw new Error(`loadCodeAssist failed: ${loadRes.status}`);
  }

  const data = await loadRes.json() as {
    currentTier?: { id?: string };
    cloudaicompanionProject?: string | { id?: string };
    allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  };

  // If already onboarded, extract projectId from response
  if (data.currentTier) {
    const project = data.cloudaicompanionProject;
    if (typeof project === "string" && project) return project;
    if (typeof project === "object" && project?.id) return project.id;
    console.warn("[oauth/exchange] currentTier exists but no projectId in response");
    return undefined;
  }

  // Step 2: Not onboarded yet — call onboardUser
  console.log("[oauth/exchange] No currentTier, onboarding user to free-tier...");
  const defaultTier = data.allowedTiers?.find((t) => t.isDefault);
  const tierId = defaultTier?.id || TIER_FREE;

  // Only free-tier can be provisioned without an existing project
  if (tierId !== TIER_FREE && tierId !== TIER_LEGACY) {
    console.warn("[oauth/exchange] Non-free tier requires existing project, skipping onboard");
    return undefined;
  }

  const onboardBody = { tierId, metadata: CODE_ASSIST_METADATA };

  const onboardRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify(onboardBody),
    signal: AbortSignal.timeout(30_000),
  });

  if (!onboardRes.ok) {
    const errText = await onboardRes.text().catch(() => "");
    console.error("[oauth/exchange] onboardUser failed:", onboardRes.status, errText);
    throw new Error(`onboardUser failed: ${onboardRes.status}`);
  }

  let lro = await onboardRes.json() as {
    done?: boolean;
    name?: string;
    response?: { cloudaicompanionProject?: { id?: string } };
  };

  // Step 3: Poll LRO if not immediately done
  if (!lro.done && lro.name) {
    console.log("[oauth/exchange] Polling onboard LRO:", lro.name);
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${lro.name}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json() as typeof lro;
      if (pollData.done) {
        lro = pollData;
        break;
      }
    }
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) {
    console.log("[oauth/exchange] Onboarded successfully, projectId:", projectId);
    return projectId;
  }

  console.warn("[oauth/exchange] Onboard completed but no projectId in response");
  return undefined;
}

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
