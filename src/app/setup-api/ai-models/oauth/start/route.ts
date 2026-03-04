export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { OAUTH_PROVIDERS, isGoogleConfigured } from "@/lib/oauth-config";

const STATE_PATH = path.join(DATA_DIR, "oauth-state.json");

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function POST(request: Request) {
  try {
    let body: { provider?: string } = {};
    try {
      body = await request.json();
    } catch {
      // No body or invalid JSON — default to anthropic
    }

    const provider = body.provider || "anthropic";
    if (provider === "google" && !isGoogleConfigured) {
      return NextResponse.json(
        { error: "Google OAuth credentials not configured. Run install.sh to set them up." },
        { status: 500 }
      );
    }
    const config = OAUTH_PROVIDERS[provider];
    if (!config) {
      return NextResponse.json(
        { error: `OAuth not supported for provider: ${provider}` },
        { status: 400 }
      );
    }

    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(
      crypto.createHash("sha256").update(codeVerifier).digest()
    );
    const state = base64url(crypto.randomBytes(32));

    await fs.mkdir(DATA_DIR, { recursive: true });

    // Write atomically via temp file + rename (rename replaces symlinks atomically)
    const tmpPath = STATE_PATH + `.tmp.${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({ codeVerifier, state, provider, createdAt: Date.now() }),
      { mode: 0o600 }
    );
    await fs.rename(tmpPath, STATE_PATH);

    // For OpenAI: check if a previous attempt saved an organization_id.
    // Including `organization` in the authorize URL causes Auth0 to embed
    // organization_id as a flat field in the id_token JWT, which is required
    // for the token exchange to succeed on ChatGPT Plus accounts.
    // We leave oauth-org.json intact here so retries can reuse it;
    // it is cleaned up in the exchange handler on successful token exchange.
    let savedOrg: Record<string, string> = {};
    if (provider === "openai") {
      const ORG_PATH = path.join(DATA_DIR, "oauth-org.json");
      try {
        const orgData = JSON.parse(await fs.readFile(ORG_PATH, "utf-8"));
        if (orgData.organizationId) {
          savedOrg = { organization: orgData.organizationId };
          console.log("[oauth/start] Using saved organization:", orgData.organizationId);
        }
      } catch {
        // No saved org, that's fine
      }
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: config.redirectUri,
      scope: config.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      ...(config.extraParams || {}),
      ...savedOrg,
    });

    return NextResponse.json({
      url: `${config.authorizeUrl}?${params.toString()}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start OAuth" },
      { status: 500 }
    );
  }
}
