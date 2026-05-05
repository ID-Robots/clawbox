import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Per-install bearer token used to authenticate openclaw → Next.js when
 * openclaw calls our local-ai proxy at `/setup-api/local-ai/<provider>/...`.
 *
 * The proxy lives behind the same Next.js server that serves the desktop
 * UI, so once the setup wizard finishes the middleware gates everything
 * under `/setup-api/*` on the user's session cookie. openclaw runs as a
 * separate process with no cookie, so without this carve-out every chat
 * turn against a llamacpp/ollama model gets 401'd by middleware.ts and
 * trips an "auth issue" cooldown on the openclaw side.
 *
 * The fix is service-to-service auth: middleware lets the proxy paths
 * through, the proxy validates `Authorization: Bearer <token>` against
 * a token persisted to `data/.local-ai-token` (mirrors the existing
 * `data/.session-secret` pattern). The configure route writes the same
 * token into openclaw.json so openclaw forwards it on every call.
 *
 * The token is created lazily on first read if production-server.js
 * hasn't already seeded it (covers tests, dev shells, and any deploy
 * that doesn't go through production-server.js).
 */

const DATA_ROOT = process.env.CLAWBOX_ROOT
  || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
const TOKEN_PATH = path.join(DATA_ROOT, "data", ".local-ai-token");

// Sentinels older builds wrote into openclaw.json. Existing installs
// upgrading to this version still send these in `Authorization: Bearer`
// until the user re-saves AI Models settings (which rotates the value
// to the per-install random token). Accepting them here keeps those
// installs working through the upgrade window.
const LEGACY_TOKENS: ReadonlySet<string> = new Set(["llamacpp-local", "ollama-local"]);

let cached: string | null = null;

function readOrCreateToken(): string {
  const fromEnv = process.env.LOCAL_AI_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  try {
    const raw = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    if (raw && raw.length >= 16) return raw;
  } catch {
    // fall through to mint a fresh token
  }

  const fresh = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, fresh, { mode: 0o600 });
  } catch {
    // Disk write failed (read-only fs in tests, permission). The token
    // is still valid for this process; we just can't share it back to
    // openclaw. Caller surfaces the 401 if openclaw sends a stale token.
  }
  return fresh;
}

export function getLocalAiToken(): string {
  if (!cached) cached = readOrCreateToken();
  return cached;
}

export function verifyLocalAiBearer(headerValue: string | null): boolean {
  if (!headerValue) return false;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();
  if (!presented) return false;

  const expected = getLocalAiToken();

  if (presented.length === expected.length) {
    let diff = 0;
    for (let i = 0; i < presented.length; i++) {
      diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) return true;
  }

  return LEGACY_TOKENS.has(presented);
}

export function _resetLocalAiTokenCacheForTests(): void {
  cached = null;
}
