/**
 * Centralized OAuth provider credentials.
 * The AI-model providers use public client IDs embedded in open-source CLIs;
 * ClawBox's own Google client ("Connect Google") is provisioned per box via env.
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
export const isGoogleConfigured = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

// ── ClawBox's own Google client ("Connect Google": Calendar + Drive) ──
// A SEPARATE client from the Gemini CLI one above: other scopes, its own consent
// screen and its own Google verification, so it never borrows
// GOOGLE_OAUTH_CLIENT_ID and the Gemini client never borrows it. It is not an
// AI-model provider either, so it stays out of OAUTH_PROVIDERS below — the
// ai-models oauth routes and their provider list must not be able to reach it.
// Off unless CLAWBOX_GOOGLE_CONNECT is exactly "1"; the client id (and, for a
// Desktop-type client, its secret) come from the box's .env, never this repo.
// Read at call time, unlike the Gemini constants: nothing here is captured
// before the env that decides it.

/** The only scopes "Connect Google" asks for — no Gmail (restricted scope). */
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.file",
] as const;

/**
 * Where Google sends the browser after consent. A Desktop client may only
 * redirect to loopback, and the box is not the owner's loopback, so nothing
 * answers there: the owner pastes the address the browser lands on back into
 * Settings. Port 1 so a local web server can never receive the code.
 */
export const GOOGLE_WORKSPACE_DEFAULT_REDIRECT_URI = "http://127.0.0.1:1";

type Env = Record<string, string | undefined>;

/** The "Connect Google" feature flag: exactly "1", anything else is off. */
export function isGoogleConnectEnabled(env: Env = process.env): boolean {
  return env.CLAWBOX_GOOGLE_CONNECT === "1";
}

function workspaceRedirectUri(env: Env): string {
  const raw = env.CLAWBOX_GOOGLE_REDIRECT_URI?.trim();
  if (!raw) return GOOGLE_WORKSPACE_DEFAULT_REDIRECT_URI;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return raw;
  } catch {
    // Not a URL — fall back rather than send Google something it will refuse.
  }
  return GOOGLE_WORKSPACE_DEFAULT_REDIRECT_URI;
}

/**
 * The ClawBox Google client, or null while the flag is off or no client id is
 * provisioned. The secret is optional here — Google wants one for a Desktop
 * client's token exchange, and refuses the exchange with its own message when
 * it is missing.
 */
export function googleWorkspaceOAuth(env: Env = process.env): OAuthAuthorizeConfig | null {
  if (!isGoogleConnectEnabled(env)) return null;
  const clientId = env.CLAWBOX_GOOGLE_CLIENT_ID?.trim() ?? "";
  if (!clientId) return null;
  const clientSecret = env.CLAWBOX_GOOGLE_CLIENT_SECRET?.trim() || undefined;
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri: workspaceRedirectUri(env),
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: GOOGLE_WORKSPACE_SCOPES.join(" "),
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    extraParams: {
      // A refresh token, every time: the skill on the box refreshes on its own.
      access_type: "offline",
      prompt: "consent",
    },
  };
}

/** {@link googleWorkspaceOAuth} as a yes/no. */
export function isGoogleWorkspaceConfigured(env: Env = process.env): boolean {
  return googleWorkspaceOAuth(env) !== null;
}

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

