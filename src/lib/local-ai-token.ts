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
const MIGRATED_FLAG_PATH = path.join(DATA_ROOT, "data", ".local-ai-token-migrated");

// Sentinels older builds wrote into openclaw.json. Existing installs
// upgrading to this version still send these in `Authorization: Bearer`
// until the user re-saves AI Models settings, which rotates openclaw.json's
// apiKey to the per-install random token AND calls `markLocalAiTokenMigrated()`
// to drop the flag file below — at which point legacy strings are rejected.
// Without the sunset, these public string constants would authenticate to
// the proxy indefinitely on any device they leak from.
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
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  if (
    presentedBuf.byteLength === expectedBuf.byteLength
    && crypto.timingSafeEqual(presentedBuf, expectedBuf)
  ) {
    return true;
  }

  // Legacy sentinels are only honored until the configure route writes
  // `data/.local-ai-token-migrated`, which it does the first time the
  // user re-saves AI Models post-upgrade. After that, the per-install
  // token is the only valid credential.
  if (legacyTokensStillAccepted() && LEGACY_TOKENS.has(presented)) {
    return true;
  }
  return false;
}

/**
 * Stamp the migration flag so `verifyLocalAiBearer` stops accepting the
 * `llamacpp-local` / `ollama-local` legacy sentinels. Idempotent — the
 * configure route calls this whenever it writes a fresh per-install
 * token to openclaw.json.
 */
export function markLocalAiTokenMigrated(): void {
  try {
    fs.mkdirSync(path.dirname(MIGRATED_FLAG_PATH), { recursive: true });
    fs.writeFileSync(MIGRATED_FLAG_PATH, `${new Date().toISOString()}\n`, { mode: 0o600 });
    legacyAcceptCache = { mtimeMs: -1, accept: false };
  } catch {
    // Disk write failed (read-only fs, permission). Legacy acceptance
    // stays open until the next successful configure save — not a
    // correctness issue, just delays the sunset.
  }
}

// Cache the flag-file stat so we don't hit the FS on every chat turn.
let legacyAcceptCache: { mtimeMs: number; accept: boolean } | null = null;
function legacyTokensStillAccepted(): boolean {
  try {
    const stat = fs.statSync(MIGRATED_FLAG_PATH);
    if (legacyAcceptCache && legacyAcceptCache.mtimeMs === stat.mtimeMs) {
      return legacyAcceptCache.accept;
    }
    legacyAcceptCache = { mtimeMs: stat.mtimeMs, accept: false };
    return false;
  } catch {
    legacyAcceptCache = { mtimeMs: -1, accept: true };
    return true;
  }
}

export function _resetLocalAiTokenCacheForTests(): void {
  cached = null;
  legacyAcceptCache = null;
}
