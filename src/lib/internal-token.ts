import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Per-install token for ClawBox's OWN systemd units calling back into the web
 * app — currently just clawbox-heartbeat.timer.
 *
 * WHY: `GET /setup-api/portal/heartbeat-tick` is pre-auth (the timer curls it on
 * a device where nobody has logged in), and when the advertised tunnel hostname
 * has stopped resolving the handler restarts clawbox-tunnel. That made an
 * unauthenticated GET — from anyone on the LAN, or through the public tunnel
 * itself — a way to bounce a systemd unit up to four times an hour, rate-limited
 * only by the 15-minute restart cooldown. The tick has to stay reachable without
 * a session; what it must NOT be is anonymous.
 *
 * The file is written in `KEY=value` form rather than as a bare token so systemd
 * can read it with `EnvironmentFile=`. That matters: the heartbeat unit runs
 * with `ProtectHome=yes` and cannot open anything under /home, but PID 1 parses
 * EnvironmentFile as root BEFORE the sandbox applies, and then substitutes the
 * value into ExecStart. So the unit keeps its sandbox and still presents the
 * credential.
 *
 * Same lifecycle as the MCP and local-AI tokens: seeded by production-server.js
 * at boot, minted lazily here if that did not happen (tests, dev shells).
 */

function dataRoot(): string {
  // Resolved per call, not at module load: the value has to follow
  // CLAWBOX_ROOT, and a module-load snapshot pins whichever value happened to
  // be set the first time anything imported this.
  return process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
}

export const INTERNAL_TOKEN_ENV_VAR = "CLAWBOX_INTERNAL_TOKEN";
/** Sent by ClawBox's own units; never by a browser. */
export const INTERNAL_TOKEN_HEADER = "x-clawbox-internal-token";

function tokenPath(): string {
  return path.join(dataRoot(), "data", "internal-token.env");
}

function parseEnvFile(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${INTERNAL_TOKEN_ENV_VAR}=(.*)$`).exec(line);
    if (!m) continue;
    const value = m[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (value.length >= 32) return value;
  }
  return null;
}

let cached: string | null = null;

function readOrCreateToken(): string {
  const fromEnv = process.env[INTERNAL_TOKEN_ENV_VAR]?.trim();
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  const file = tokenPath();
  try {
    const onDisk = parseEnvFile(fs.readFileSync(file, "utf-8"));
    if (onDisk) return onDisk;
  } catch {
    // fall through and mint one
  }

  const fresh = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${INTERNAL_TOKEN_ENV_VAR}=${fresh}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    // Read-only fs (tests, a container). The token still works for this
    // process; the unit simply cannot present it, and the tick's restart half
    // stays closed — which is the safe direction.
  }
  return fresh;
}

export function getInternalToken(): string {
  if (!cached) cached = readOrCreateToken();
  return cached;
}

/**
 * True when a request carries this install's internal token.
 *
 * Never mints one: on a device where the token file could not be written we
 * would otherwise compare against a value that exists only in this process and
 * changes on every restart, which is a confusing way to say "no".
 */
export function verifyInternalToken(headerValue: string | null | undefined): boolean {
  const presented = typeof headerValue === "string" ? headerValue.trim() : "";
  if (presented.length < 32) return false;
  const expected = getInternalToken();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
}

/** True when the request is one of our own units. */
export function isInternalRequest(request: Request): boolean {
  return verifyInternalToken(request.headers.get(INTERNAL_TOKEN_HEADER));
}

export function _resetInternalTokenCacheForTests(): void {
  cached = null;
}
