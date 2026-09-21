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

// The two places a pre-b0c6e452 build wrote its credential for the local-AI
// providers: the agent's auth profiles and the provider block in openclaw.json.
// Same resolution as the configure route and src/lib/openclaw-config.ts.
const OPENCLAW_HOME_DIR = process.env.OPENCLAW_HOME
  || path.join(process.env.HOME ?? "/home/clawbox", ".openclaw");
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME_DIR, "openclaw.json");
const AUTH_PROFILES_PATH = path.join(OPENCLAW_HOME_DIR, "agents", "main", "agent", "auth-profiles.json");

// Sentinels older builds wrote into openclaw.json. An install upgrading from
// one of those still sends them in `Authorization: Bearer` until the user
// re-saves AI Models settings, which rotates openclaw.json's apiKey to the
// per-install random token AND calls `markLocalAiTokenMigrated()`.
//
// They are public string constants, so they are only honoured on POSITIVE
// evidence of that upgrade: the sentinel has to be the credential openclaw's
// own config currently holds for the provider. A fresh install never wrote
// one, so on a fresh install they authenticate to nothing — the previous
// rule ("accept until the flag file exists") left every box that had not
// re-saved a local provider open to anyone on the LAN who had read the
// source, because the flag was only ever written by that re-save.
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

  // A legacy sentinel is honoured only while openclaw's config still carries
  // it as the credential (a genuine in-place upgrade that has not re-saved
  // AI Models yet) and the migration flag has not been stamped. After either,
  // the per-install token is the only valid credential.
  if (LEGACY_TOKENS.has(presented) && legacySentinelStillConfigured(presented)) {
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
    legacyCache = null;
  } catch {
    // Disk write failed (read-only fs, permission). The sentinel stays
    // accepted only for as long as openclaw.json still carries it, so this
    // delays nothing that matters — the next configure save rewrites both.
  }
}

/** The credential strings a JSON file holds under `apiKey` / `key`. */
function collectCredentials(file: string, into: Set<string>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return;
  }
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === "apiKey" || key === "key") && typeof value === "string") into.add(value);
      else walk(value, depth + 1);
    }
  };
  walk(parsed, 0);
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

// Cache the file stats so a chat turn does not re-parse openclaw's config.
let legacyCache: { flag: number; config: number; profiles: number; sentinels: Set<string> } | null = null;
function legacySentinelStillConfigured(sentinel: string): boolean {
  const flag = mtimeOf(MIGRATED_FLAG_PATH);
  const config = mtimeOf(OPENCLAW_CONFIG_PATH);
  const profiles = mtimeOf(AUTH_PROFILES_PATH);
  if (!legacyCache || legacyCache.flag !== flag || legacyCache.config !== config || legacyCache.profiles !== profiles) {
    const sentinels = new Set<string>();
    // The stamped flag is the sunset: nothing is accepted after it, whatever
    // an unrewritten config still says.
    if (flag < 0) {
      const found = new Set<string>();
      collectCredentials(OPENCLAW_CONFIG_PATH, found);
      collectCredentials(AUTH_PROFILES_PATH, found);
      for (const legacy of LEGACY_TOKENS) if (found.has(legacy)) sentinels.add(legacy);
    }
    legacyCache = { flag, config, profiles, sentinels };
  }
  return legacyCache.sentinels.has(sentinel);
}

export function _resetLocalAiTokenCacheForTests(): void {
  cached = null;
  legacyCache = null;
}
