// Checking a Microsoft Teams bot's credentials against Microsoft itself.
//
// A Teams bot is an Azure AD application: an App (client) ID, a client secret,
// and the Directory (tenant) ID of a single-tenant registration. Bot Framework
// accepts it when the app can mint a token for `https://api.botframework.com`
// with the client-credentials grant — so that token request is the check, the
// same one the bot itself makes on every reply. Nothing is kept from it.
//
// Checking before anything is written is the Discord rule: a save that skipped
// it would report success for a bot that can never answer, and the gateway log
// would be the only place that said so. Nothing here logs or returns the
// secret; the repo is public and these errors reach the UI.

// Hardcoded, with no override: the one destination the secret is ever sent to.
const LOGIN_BASE = "https://login.microsoftonline.com";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const VALIDATE_TIMEOUT_MS = 10_000;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A tenant may also be named by its domain (contoso.onmicrosoft.com). Either
// way it becomes a URL path segment, so nothing else gets through.
const TENANT_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function isTeamsAppId(value: string): boolean {
  return GUID_RE.test(value);
}

export function isTeamsTenantId(value: string): boolean {
  return GUID_RE.test(value) || (value.length <= 253 && TENANT_DOMAIN_RE.test(value));
}

/** Which part Microsoft refused — each has a different remedy. */
export type TeamsCredentialProblem =
  /** The secret is wrong, expired, or the ID was pasted instead of the Value. */
  | "secret_rejected"
  /** No such application in that tenant (wrong App ID, or a multi-tenant mix-up). */
  | "app_not_found"
  /** No such tenant. */
  | "tenant_not_found";

export class TeamsAuthError extends Error {
  constructor(readonly problem: TeamsCredentialProblem) {
    super(`Microsoft refused the bot credentials (${problem})`);
    this.name = "TeamsAuthError";
  }
}

/** Microsoft could not be asked: offline, DNS, TLS, timeout, throttled or 5xx. Never a verdict. */
export class TeamsUnavailableError extends Error {
  constructor() {
    super("Microsoft could not be reached");
    this.name = "TeamsUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The AADSTS code in an OAuth error answer. Microsoft's `error` field is
 * coarse (`invalid_client` covers a bad secret and an unknown app alike); the
 * code is what tells them apart.
 */
function aadstsCode(data: Record<string, unknown>): number | null {
  const codes = Array.isArray(data.error_codes) ? data.error_codes : [];
  const first = codes.find((c): c is number => typeof c === "number");
  if (first !== undefined) return first;
  const description = typeof data.error_description === "string" ? data.error_description : "";
  const match = description.match(/AADSTS(\d+)/);
  return match ? Number(match[1]) : null;
}

function verdict(data: Record<string, unknown>): TeamsCredentialProblem | null {
  const code = aadstsCode(data);
  // 7000215 invalid secret, 7000222 expired secret, 7000216 secret missing.
  if (code === 7000215 || code === 7000222 || code === 7000216) return "secret_rejected";
  // 700016 application not found in the directory.
  if (code === 700016) return "app_not_found";
  // 90002 tenant not found, 900023 malformed tenant, 90013/90014 bad input.
  if (code === 90002 || code === 900023) return "tenant_not_found";
  if (data.error === "invalid_client") return "secret_rejected";
  if (data.error === "unauthorized_client") return "app_not_found";
  return null;
}

/**
 * Prove the three values make a working bot identity. Resolves on success;
 * throws TeamsAuthError for a verdict, TeamsUnavailableError for anything else.
 */
export async function checkTeamsCredentials(
  appId: string,
  appPassword: string,
  tenantId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!isTeamsAppId(appId)) throw new TeamsAuthError("app_not_found");
  if (!isTeamsTenantId(tenantId)) throw new TeamsAuthError("tenant_not_found");
  let res: Response;
  try {
    res = await fetch(`${LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: appPassword,
        scope: BOT_FRAMEWORK_SCOPE,
      }).toString(),
      // The caller's signal adds a reason to give up; it never removes the ceiling.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(VALIDATE_TIMEOUT_MS)])
        : AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch {
    throw new TeamsUnavailableError();
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new TeamsUnavailableError();
  }
  if (res.ok && isRecord(data) && typeof data.access_token === "string") return;
  // A 4xx with an OAuth error body is Microsoft's answer about the values; a
  // 429 or a 5xx is about Microsoft.
  if (res.status >= 400 && res.status < 500 && res.status !== 429 && isRecord(data)) {
    const problem = verdict(data);
    if (problem) throw new TeamsAuthError(problem);
  }
  throw new TeamsUnavailableError();
}
