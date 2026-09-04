import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Per-install bearer token used to authenticate the ClawBox MCP server
 * back to its own Next.js API at `/setup-api/*`.
 *
 * The MCP server (`mcp/clawbox-mcp.ts`) runs as a stdio subprocess of
 * openclaw and has no session cookie. Once the setup wizard finishes,
 * `src/middleware.ts` gates every `/setup-api/*` request on a valid
 * HMAC-signed session cookie, so without this carve-out every tool
 * call from a Codex / Claude agent gets 307'd to `/login` — POSTs
 * surface as 405 (the login route is GET-only), GETs receive the
 * login HTML page that `JSON.parse` chokes on with "Failed to parse
 * JSON".
 *
 * Token semantics mirror `src/lib/local-ai-token.ts` exactly: a
 * per-install secret persisted to `data/.mcp-token`, env-overridable
 * for tests via `CLAWBOX_MCP_TOKEN`, lazy creation on first read so
 * `production-server.js` doesn't have to be the only seeder. No
 * legacy sentinels — this is a fresh capability with no upgrade
 * compatibility window to maintain.
 *
 * Verification is constant-time via `crypto.timingSafeEqual` to keep
 * the bearer check robust against timing oracles.
 */

const DATA_ROOT = process.env.CLAWBOX_ROOT
  || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
const TOKEN_PATH = path.join(DATA_ROOT, "data", ".mcp-token");

let cached: string | null = null;
/** Epoch ms of the last disk re-read triggered by a FAILED bearer check. */
let lastRecheck = 0;
/**
 * The failure path is the one an unauthenticated caller controls, so the
 * re-read below is rate-limited: a bad-bearer flood must not become one disk
 * read per request. A second is well under a restart and well over a flood.
 */
const RECHECK_INTERVAL_MS = 1000;

function readTokenFile(): string | null {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    if (raw && raw.length >= 16) return raw;
  } catch {
    // absent, or unreadable to this uid
  }
  return null;
}

function readOrCreateToken(): string {
  const fromEnv = process.env.CLAWBOX_MCP_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const onDisk = readTokenFile();
  if (onDisk) return onDisk;

  const fresh = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, fresh, { mode: 0o600 });
  } catch {
    // Disk write failed (read-only fs in tests, permission). The token
    // is still valid for this process; we just can't share it back to
    // the MCP subprocess. Caller surfaces a 401 if the MCP sends a
    // stale (or missing) credential.
  }
  return fresh;
}

export function getMcpToken(): string {
  if (!cached) cached = readOrCreateToken();
  return cached;
}

function matches(presented: string, expected: string): boolean {
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  return (
    presentedBuf.byteLength === expectedBuf.byteLength
    && crypto.timingSafeEqual(presentedBuf, expectedBuf)
  );
}

export function verifyMcpBearer(headerValue: string | null): boolean {
  if (!headerValue) return false;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();
  if (!presented) return false;

  if (matches(presented, getMcpToken())) return true;

  // The token on disk can be ROTATED under a running web server:
  // scripts/gateway-pre-start.sh replaces it when the gateway can neither read
  // nor re-harden it, and the reconcile it runs afterwards reaches the MCP
  // subprocess only. This process is the verifier, and it holds its own copy —
  // `cached` above, seeded from CLAWBOX_MCP_TOKEN which production-server.js
  // pins at Next.js boot. Nothing orders clawbox-setup.service against
  // clawbox-gateway.service, so a gateway restart mid-uptime (a model/config
  // change, or Restart=always after a crash) used to 401 every /setup-api/*
  // call from the agent's device tools until clawbox-setup happened to restart.
  //
  // Re-read the file once, rate-limited, and only on a check that already
  // failed. This widens nothing: data/.mcp-token is 0600 under a directory this
  // uid owns and it is the source `cached` was read from in the first place —
  // the stale value is what has no authority, not the file. TASK-657.
  const now = Date.now();
  if (now - lastRecheck < RECHECK_INTERVAL_MS) return false;
  lastRecheck = now;

  const onDisk = readTokenFile();
  if (!onDisk || onDisk === cached) return false;
  if (!matches(presented, onDisk)) return false;

  // Adopt it, so the superseded value stops being accepted and the MCP
  // subprocess's env copy agrees with ours.
  cached = onDisk;
  process.env.CLAWBOX_MCP_TOKEN = onDisk;
  return true;
}

export function _resetMcpTokenCacheForTests(): void {
  cached = null;
  lastRecheck = 0;
}
