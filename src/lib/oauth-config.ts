/**
 * Centralized OAuth provider credentials.
 * All providers use public client IDs embedded in open-source CLIs.
 */

// ── Auth-code (browser redirect) flow ──

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  tokenEndpoint: string;
}

export interface OAuthAuthorizeConfig extends OAuthProviderConfig {
  scopes: string;
  authorizeUrl: string;
  extraParams?: Record<string, string>;
}

// ── OpenAI constants (used in multiple configs below) ──

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/token`;
export const OPENAI_REDIRECT_URI = `${OPENAI_ISSUER}/deviceauth/callback`;
export const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;

// ── Google Gemini CLI public credentials ──
// Installed-app client — secret is not confidential per Google's OAuth docs.
// Source: https://github.com/google-gemini/gemini-cli (packages/core/src/code_assist/oauth2.ts)
// Loaded from env vars (set by install.sh from .env.example).
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

export const OAUTH_PROVIDERS: Record<string, OAuthAuthorizeConfig> = {
  anthropic: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
    scopes:
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
    authorizeUrl: "https://claude.ai/oauth/authorize",
  },
  openai: {
    clientId: OPENAI_CLIENT_ID,
    redirectUri: "http://localhost:1455/auth/callback",
    tokenEndpoint: OPENAI_TOKEN_URL,
    scopes: "openid profile email offline_access",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    extraParams: {
      audience: "https://api.openai.com/v1",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
  },
  google: {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: "https://codeassist.google.com/authcode",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: GOOGLE_SCOPES,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    extraParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },
};

// ── Device-code flow (OpenAI) ──

export interface DeviceAuthProviderConfig {
  clientId: string;
  deviceCodeUrl: string;
  verificationUrl?: string;
  scope?: string;
  requestFormat: "json" | "form";
  responseFields: {
    deviceId: string;
    userCode: string;
    interval: string;
  };
}

export const DEVICE_AUTH_PROVIDERS: Record<string, DeviceAuthProviderConfig> = {
  openai: {
    clientId: OPENAI_CLIENT_ID,
    deviceCodeUrl: `${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`,
    verificationUrl: `${OPENAI_ISSUER}/codex/device`,
    requestFormat: "json",
    responseFields: {
      deviceId: "device_auth_id",
      userCode: "user_code",
      interval: "interval",
    },
  },
};

