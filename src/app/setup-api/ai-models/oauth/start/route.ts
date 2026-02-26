import { NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

interface OAuthProviderConfig {
  clientId: string;
  redirectUri: string;
  scopes: string;
  authorizeUrl: string;
  extraParams?: Record<string, string>;
}

const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  anthropic: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    scopes:
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
    authorizeUrl: "https://claude.ai/oauth/authorize",
  },
  openai: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    scopes: "openid profile email offline_access",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    extraParams: {
      audience: "https://api.openai.com/v1",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    },
  },
};

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const STATE_DIR = path.join(CONFIG_ROOT, "data");
const STATE_PATH = path.join(STATE_DIR, "oauth-state.json");

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

    await fs.mkdir(STATE_DIR, { recursive: true });

    // Check that STATE_PATH is not a symlink
    try {
      const stat = await fs.lstat(STATE_PATH);
      if (stat.isSymbolicLink()) {
        await fs.unlink(STATE_PATH);
      }
    } catch {
      // File doesn't exist, which is fine
    }

    // Write atomically via temp file + rename
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
    let savedOrg: Record<string, string> = {};
    if (provider === "openai") {
      const ORG_PATH = path.join(STATE_DIR, "oauth-org.json");
      try {
        const orgData = JSON.parse(await fs.readFile(ORG_PATH, "utf-8"));
        if (orgData.organizationId) {
          savedOrg = { organization: orgData.organizationId };
          console.log("[oauth/start] Using saved organization:", orgData.organizationId);
          // Clean up — only needed once
          await fs.unlink(ORG_PATH).catch(() => {});
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
