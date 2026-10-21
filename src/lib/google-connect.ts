/**
 * "Connect Google": the owner's Google account for the agent's Calendar and
 * Drive, through ClawBox's own Google client (`googleWorkspaceOAuth` in
 * oauth-config.ts). Off unless CLAWBOX_GOOGLE_CONNECT is exactly "1".
 *
 * Who reads the grant: Hermes' bundled google-workspace skill. It loads the
 * grant from `google_token.json` and its client from `google_client_secret.json`
 * under HERMES_HOME — the skill's `required_credential_files` — and Hermes has
 * no CLI or RPC that imports either; the skill's own setup writes them. So this
 * module writes the same two files, in the shapes that setup leaves (google-auth's
 * authorized-user JSON, and an "installed" client-secrets file), 0600, by atomic
 * rename. The tokens stay on the box: nothing here sends them anywhere but Google.
 *
 * register-mcp.sh keeps the skill in `skills.disabled` (a distractor that ends in
 * a setup nobody can finish) until the flag is on AND the token file holds a
 * refresh token; `applyGoogleSkill` re-runs it so a connect or a disconnect
 * lands now rather than at the next boot.
 *
 * Deliberately apart from the ai-models OAuth flow: its own state file, and it
 * never touches the AI-model handoff (`oauth-handoff.ts`), so starting one
 * sign-in cannot cancel the other.
 */

import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import { promisify } from "util";
import { NextResponse } from "next/server";

import { harnessesHere, restartHermesGatewayIfRunning } from "@/lib/clawbox-mcp-registration";
import { DATA_DIR, resolveConfigRoot } from "@/lib/config-store";
import { hermesHome } from "@/lib/hermes-env";
import {
  GOOGLE_WORKSPACE_SCOPES,
  isGoogleConnectEnabled,
  type OAuthAuthorizeConfig,
} from "@/lib/oauth-config";
import { requireSession } from "@/lib/route-auth";
import path, { untraced } from "@/lib/runtime-path";
import { isSameOriginRequest } from "@/lib/same-origin";

const execFileAsync = promisify(execFile);

export const GOOGLE_TOKEN_FILE = "google_token.json";
export const GOOGLE_CLIENT_SECRET_FILE = "google_client_secret.json";
export const GOOGLE_CONNECT_STATE_PATH = path.join(DATA_DIR, "google-connect-state.json");
/** How long a started sign-in may wait for the pasted address. */
export const GOOGLE_CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const REVOKE_URI = "https://oauth2.googleapis.com/revoke";
const REGISTER_SCRIPT = path.join("scripts", "register-mcp.sh");

export function googleTokenPath(): string {
  return path.join(hermesHome(), GOOGLE_TOKEN_FILE);
}

export function googleClientSecretPath(): string {
  return path.join(hermesHome(), GOOGLE_CLIENT_SECRET_FILE);
}

// ── Route guard ──

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

/**
 * The gate every /setup-api/google/connect route asks first. With the flag off
 * the routes answer 404, as if they did not exist — the box behaves as it did
 * before the feature. With it on: the owner only (never the agent's MCP bearer,
 * which must not connect or drop an account from a chat), and a write only from
 * this ClawBox's own pages.
 */
export async function guardGoogleConnect(req: Request, opts: { write: boolean }): Promise<NextResponse | null> {
  if (!isGoogleConnectEnabled()) return refuse(404, "not_found", "Not found.");
  const denied = await requireSession(req, { ownerOnly: true });
  if (denied) return denied;
  if (opts.write && !isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "Google can only be connected from this ClawBox's own pages.");
  }
  return null;
}

// ── Files ──

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Write JSON at 0600 by temp file + rename, so a reader never sees half of it. */
async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = untraced(`${file}.clawbox.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The parsed file, or null when it is absent, unreadable or not a JSON object. */
async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf-8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The grant on disk, when it is one: a refresh token is what makes it usable. */
async function readGrant(): Promise<{ clientId: string | null; refreshToken: string; accessToken: string | null; scopes: string[] } | null> {
  const token = await readJsonObject(googleTokenPath());
  const refreshToken = token ? nonEmpty(token.refresh_token) : null;
  if (!token || !refreshToken) return null;
  const scopes = Array.isArray(token.scopes)
    ? token.scopes.filter((s): s is string => typeof s === "string")
    : typeof token.scopes === "string"
      ? token.scopes.split(/\s+/).filter(Boolean)
      : [];
  return { clientId: nonEmpty(token.client_id), refreshToken, accessToken: nonEmpty(token.token), scopes };
}

interface PendingSignIn {
  codeVerifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
}

async function readPending(): Promise<PendingSignIn | null> {
  const raw = await readJsonObject(GOOGLE_CONNECT_STATE_PATH);
  if (!raw) return null;
  const { codeVerifier, state, clientId, redirectUri, createdAt } = raw;
  if (
    typeof codeVerifier !== "string" || typeof state !== "string" || typeof clientId !== "string"
    || typeof redirectUri !== "string" || typeof createdAt !== "number" || !Number.isFinite(createdAt)
  ) return null;
  return { codeVerifier, state, clientId, redirectUri, createdAt };
}

function isFresh(pending: PendingSignIn): boolean {
  const age = Date.now() - pending.createdAt;
  return age >= 0 && age <= GOOGLE_CONNECT_STATE_TTL_MS;
}

async function clearPending(): Promise<void> {
  await fs.unlink(GOOGLE_CONNECT_STATE_PATH).catch(() => {});
}

// ── Status ──

export interface GoogleConnectStatus {
  /** A ClawBox Google client id is provisioned on this box. */
  configured: boolean;
  /** This edition runs Hermes, whose google-workspace skill uses the grant. */
  hermes: boolean;
  /** A usable grant (one with a refresh token) is on the box. */
  connected: boolean;
  /** The grant was made with a client other than ClawBox's — the owner's own. */
  ownClient: boolean;
  /** The scopes the grant on the box holds. */
  scopes: string[];
  /** A sign-in was started and is still waiting for the pasted address. */
  pending: boolean;
}

export async function readGoogleConnectStatus(config: OAuthAuthorizeConfig | null): Promise<GoogleConnectStatus> {
  const [grant, pending] = await Promise.all([readGrant(), readPending()]);
  return {
    configured: config !== null,
    hermes: harnessesHere().hermes,
    connected: grant !== null,
    ownClient: grant !== null && (config === null || grant.clientId !== config.clientId),
    scopes: grant?.scopes ?? [],
    pending: pending !== null && isFresh(pending) && config !== null && pending.clientId === config.clientId,
  };
}

// ── Start ──

/**
 * Begin a sign-in: a PKCE verifier and a state, kept server-side at 0600, and
 * the Google consent URL for the browser. A new start replaces an older one.
 */
export async function startGoogleConnect(config: OAuthAuthorizeConfig): Promise<{ url: string }> {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(32));
  const pending: PendingSignIn = {
    codeVerifier,
    state,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    createdAt: Date.now(),
  };
  await writePrivateJson(GOOGLE_CONNECT_STATE_PATH, pending);
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    ...(config.extraParams ?? {}),
  });
  return { url: `${config.authorizeUrl}?${params.toString()}` };
}

// ── Finish ──

export type PastedRedirect =
  | { ok: true; code: string; state: string | null }
  | { ok: false; reason: "empty" | "denied" | "no_code"; detail?: string };

function decodeLoosely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * What the owner pasted: the whole address the browser landed on (the usual
 * case), its query alone, or the bare code. A `state` that came with it is
 * checked by the caller; a bare code has none, and PKCE still binds it to the
 * sign-in this box started.
 */
export function parsePastedRedirect(input: string): PastedRedirect {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "empty" };
  const query = (raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw).split("#")[0];
  if (/(^|&)(code|error|state)=/.test(query)) {
    const params = new URLSearchParams(query);
    const error = params.get("error");
    if (error) return { ok: false, reason: "denied", detail: error.slice(0, 100) };
    const code = params.get("code")?.trim();
    if (!code) return { ok: false, reason: "no_code" };
    return { ok: true, code, state: params.get("state") };
  }
  // A bare code: no spaces, no address. Google's codes carry a "/", which a
  // copy out of the address bar leaves percent-encoded.
  if (/\s/.test(raw) || raw.includes("://") || raw.length > 2048) return { ok: false, reason: "no_code" };
  return { ok: true, code: decodeLoosely(raw), state: null };
}

export type GoogleConnectResult =
  | { ok: true; scopes: string[] }
  | { ok: false; status: number; code: string; error: string };

function fail(status: number, code: string, error: string): GoogleConnectResult {
  return { ok: false, status, code, error };
}

function googleError(text: string, status: number): string {
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) {
      if (body.error === "invalid_grant") {
        return "Google did not accept that sign-in — it has expired or was already used. Start again.";
      }
      const detail = nonEmpty(body.error_description) ?? nonEmpty(body.error);
      if (detail) return `Google refused the sign-in: ${detail.slice(0, 200)}`;
    }
  } catch {
    // Not JSON; fall through to the status alone.
  }
  return `Google refused the sign-in (${status}).`;
}

/** Ask Google to forget a token. Best effort: false when it could not be done. */
async function revokeAtGoogle(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Google's expiry in the form google-auth reads back: seconds, UTC, a trailing Z. */
function expiryFrom(expiresIn: unknown): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return undefined;
  return new Date(Date.now() + expiresIn * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Write the client-secrets file the skill's setup would, unless the owner keeps
 * one of their OWN client there — an own client stays an option, and this flow
 * never overwrites it. The grant itself carries the client id and secret it
 * refreshes with, so it works either way.
 */
async function writeClientSecretUnlessOwn(config: OAuthAuthorizeConfig): Promise<void> {
  const file = googleClientSecretPath();
  let existing: Record<string, unknown> | null = null;
  try {
    await fs.access(file);
    existing = (await readJsonObject(file)) ?? {};
  } catch {
    existing = null;
  }
  if (existing !== null) {
    const installed = isRecord(existing.installed) ? existing.installed : isRecord(existing.web) ? existing.web : null;
    if (!installed || installed.client_id !== config.clientId) return;
  }
  await writePrivateJson(file, {
    installed: {
      client_id: config.clientId,
      client_secret: config.clientSecret ?? "",
      auth_uri: AUTH_URI,
      token_uri: TOKEN_URI,
      redirect_uris: [config.redirectUri],
    },
  });
}

/**
 * Finish a sign-in from the address the owner pasted: check it against the
 * pending sign-in, exchange the code with Google, and store the grant on the
 * box for the skill. Never throws for a refusal; the reason travels on the result.
 */
export async function finishGoogleConnect(config: OAuthAuthorizeConfig, pasted: string): Promise<GoogleConnectResult> {
  const parsed = parsePastedRedirect(pasted);
  if (!parsed.ok) {
    if (parsed.reason === "denied") {
      await clearPending();
      return fail(400, "denied", "Google sign-in was cancelled or refused, so nothing was connected. Start again to retry.");
    }
    return fail(400, "no_code", "That is not the address Google sent you to. Copy the whole address from the browser's address bar after you allow access.");
  }

  const pending = await readPending();
  if (!pending) {
    return fail(400, "no_session", "No Google sign-in is waiting. Press Connect Google to start one.");
  }
  if (!isFresh(pending)) {
    await clearPending();
    return fail(400, "expired", "The Google sign-in took too long and expired. Start again.");
  }
  if (pending.clientId !== config.clientId) {
    await clearPending();
    return fail(409, "client_changed", "ClawBox's Google client changed after this sign-in started. Start again.");
  }
  if (parsed.state !== null && parsed.state !== pending.state) {
    await clearPending();
    return fail(403, "state_mismatch", "That address belongs to a different sign-in. Start again and paste the address from that sign-in.");
  }

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: parsed.code,
    client_id: config.clientId,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
  };
  let res: Response;
  try {
    res = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return fail(504, "timeout", "Google did not answer in time. Try again.");
    }
    return fail(502, "unreachable", "Google could not be reached. Check the box's internet connection and try again.");
  }
  if (!res.ok) {
    return fail(502, "google_refused", googleError(await res.text().catch(() => ""), res.status));
  }

  let data: Record<string, unknown>;
  try {
    const parsedBody: unknown = await res.json();
    if (!isRecord(parsedBody)) throw new Error("not an object");
    data = parsedBody;
  } catch {
    return fail(502, "google_refused", "Google answered with something that is not a sign-in.");
  }
  const accessToken = nonEmpty(data.access_token);
  const refreshToken = nonEmpty(data.refresh_token);
  if (!accessToken || !refreshToken) {
    if (accessToken) await revokeAtGoogle(accessToken);
    return fail(502, "no_refresh_token", "Google did not hand over a lasting sign-in. Start again.");
  }

  // Google lets the owner untick a scope on its consent screen; keep what was
  // granted of ours, and refuse a grant with none of it.
  const granted = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [...GOOGLE_WORKSPACE_SCOPES];
  const scopes = GOOGLE_WORKSPACE_SCOPES.filter((s) => granted.includes(s));
  if (scopes.length === 0) {
    await revokeAtGoogle(refreshToken);
    await clearPending();
    return fail(400, "no_scopes", "Google allowed neither Calendar nor Drive, so nothing was connected. Start again and allow them.");
  }

  const expiry = expiryFrom(data.expires_in);
  await writePrivateJson(googleTokenPath(), {
    token: accessToken,
    refresh_token: refreshToken,
    token_uri: TOKEN_URI,
    client_id: config.clientId,
    // google-auth refuses an authorized-user file without this key at all.
    client_secret: config.clientSecret ?? "",
    scopes,
    ...(expiry ? { expiry } : {}),
  });
  try {
    await writeClientSecretUnlessOwn(config);
  } catch (err) {
    // The grant above already carries the client it refreshes with, so the
    // account IS connected; the client file only serves the skill's own setup.
    console.error("[google-connect] the client file could not be written:", err instanceof Error ? err.message : err);
  }
  await clearPending();
  return { ok: true, scopes };
}

// ── Disconnect ──

export type GoogleDisconnectResult =
  | { ok: true; revoked: boolean }
  | { ok: false; status: number; code: string; error: string };

/**
 * Drop the grant "Connect Google" made: revoke it at Google (best effort — the
 * file goes either way) and remove it and ClawBox's client file from the box.
 * A grant made with the owner's own client is theirs, and is left alone.
 */
export async function disconnectGoogle(config: OAuthAuthorizeConfig | null): Promise<GoogleDisconnectResult> {
  await clearPending();
  const grant = await readGrant();
  if (!grant) {
    // Nothing connected. A file without a refresh token is not one this flow
    // writes (its writes are atomic and always carry one), so it is left alone.
    return { ok: true, revoked: false };
  }
  if (!config || grant.clientId !== config.clientId) {
    return {
      ok: false,
      status: 409,
      code: "own_client",
      error: "This Google account was connected with a Google client of your own, not through ClawBox, so ClawBox leaves it alone.",
    };
  }
  const revoked = await revokeAtGoogle(grant.refreshToken);
  // Gone already is fine. Any other failure leaves the grant on the box for
  // the skill to load, so it is the route's disconnect_failed, never a 200.
  await fs.unlink(googleTokenPath()).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== "ENOENT") throw err;
  });
  const secret = await readJsonObject(googleClientSecretPath());
  if (secret && isRecord(secret.installed) && secret.installed.client_id === config.clientId) {
    await fs.unlink(googleClientSecretPath()).catch(() => {});
  }
  return { ok: true, revoked };
}

// ── Apply ──

/**
 * Make Hermes see the change now: re-run register-mcp.sh, which takes the
 * google-workspace skill off `skills.disabled` (or puts it back), then restart
 * a running messaging gateway — the path-guard switch's pattern. Never throws;
 * false with an error when it did not land (the next boot applies it).
 */
export async function applyGoogleSkill(): Promise<{ applied: boolean; error: string | null }> {
  if (!harnessesHere().hermes) return { applied: false, error: null };
  const root = resolveConfigRoot();
  try {
    await execFileAsync("/bin/bash", [path.join(root, REGISTER_SCRIPT)], {
      env: { ...process.env, CLAWBOX_ROOT: root, HOME: process.env.HOME || "/home/clawbox" },
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    console.error("[google-connect] register-mcp.sh failed:", err instanceof Error ? err.message : err);
    return { applied: false, error: "Saved on the box, but Hermes' skills could not be updated yet. The next restart applies it." };
  }
  const restarted = await restartHermesGatewayIfRunning();
  if (restarted === false) {
    return { applied: false, error: "Saved on the box, but the messaging gateway did not restart. Its next start applies it." };
  }
  return { applied: true, error: null };
}
