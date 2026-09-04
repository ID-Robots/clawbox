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
 * PRECEDENCE, and it is not symmetric. `CLAWBOX_MCP_TOKEN` wins when
 * the value is first resolved — that is what makes it a test override
 * and what lets `production-server.js` seed it before the first
 * request. But the FILE is the rotation's authority: it is what
 * `mcp/lib/api.ts` presents and what `scripts/gateway-pre-start.sh`
 * rewrites, so once the file changes under this process the next
 * failed bearer check adopts its contents and the earlier value stops
 * being accepted. An env pin therefore holds only until the file is
 * rotated, never after — which costs nothing in production, where the
 * only setter of the variable is `production-server.js` and it sets it
 * to that same file's contents.
 *
 * Verification is constant-time via `crypto.timingSafeEqual` to keep
 * the bearer check robust against timing oracles.
 */

const DATA_ROOT = process.env.CLAWBOX_ROOT
  || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
const TOKEN_PATH = path.join(DATA_ROOT, "data", ".mcp-token");

let cached: string | null = null;
/**
 * `mtimeMs` of the token file the last time a FAILED bearer check re-read it.
 *
 * The failure path is the one an unauthenticated caller controls, so the
 * re-read has to be bounded — but NOT by a wall clock. A time slot is a shared
 * resource an attacker can consume: at more than one bad bearer per interval,
 * the flood takes every slot and the legitimate rotated bearer keeps being
 * rejected, which re-opens the very defect the re-read closes. Gating on the
 * file's mtime instead makes the bound exact: a rotation always changes it, so
 * the file is read at most ONCE per rotation no matter how many checks fail,
 * and a flood costs one `statSync` per request rather than one read.
 */
let lastReadMtimeMs: number | null = null;

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
  // Re-read the file, once per rotation, and only on a check that already
  // failed. This widens nothing: data/.mcp-token is 0600 under a directory this
  // uid owns and it is the source `cached` was read from in the first place —
  // the stale value is what has no authority, not the file. TASK-657.
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(TOKEN_PATH).mtimeMs;
  } catch {
    // No file to reconcile against; the cached value is all there is.
    return false;
  }
  if (mtimeMs === lastReadMtimeMs) return false;
  lastReadMtimeMs = mtimeMs;

  const onDisk = readTokenFile();
  if (!onDisk || onDisk === cached) return false;

  // Adopt on the ROTATION, not on a caller presenting the new value. Making the
  // adoption conditional on `matches(presented, onDisk)` reintroduces the
  // starvation this mtime bound exists to remove: the first failed check after
  // a rotation consumes the one read that mtime allows, and if that check came
  // from a bad bearer the new value is never adopted, so the legitimate one
  // keeps failing until the file is rotated AGAIN. Reading the file is what
  // settles the question — whoever wrote it already holds the credential, and
  // `getMcpToken` would return exactly this value in a process that started now.
  //
  // Only `cached` is written: `process.env.CLAWBOX_MCP_TOKEN` is the value this
  // process STARTED from, and overwriting it would leave a rotated secret in the
  // environment of everything spawned afterwards for no gain — `getMcpToken`
  // consults the env only while `cached` is null.
  cached = onDisk;
  return matches(presented, onDisk);
}

export function _resetMcpTokenCacheForTests(): void {
  cached = null;
  lastReadMtimeMs = null;
}
