import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { DATA_DIR, get, set } from "./config-store";

const SECRET_PATH = path.join(DATA_DIR, ".session-secret");

/** Get or create a persistent HMAC secret for session cookies. */
export async function getOrCreateSecret(): Promise<string> {
  try {
    const existing = (await fs.readFile(SECRET_PATH, "utf-8")).trim();
    if (existing.length >= 32) return existing;
  } catch { /* doesn't exist yet */ }

  const secret = crypto.randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(SECRET_PATH), { recursive: true });
  await fs.writeFile(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

/** Prefer the live session secret used by middleware when available. */
export async function getSessionSigningSecret(): Promise<string> {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret) return envSecret;
  return getOrCreateSecret();
}

/** Resolve the install user across default, sudo-launched, and x64 setups. */
export function getSystemUsername(): string {
  let osUsername: string | undefined;
  try {
    osUsername = os.userInfo().username;
  } catch {
    osUsername = undefined;
  }

  return process.env.CLAWBOX_USER
    || process.env.SUDO_USER
    || process.env.USER
    || osUsername
    || "clawbox";
}

// Reject CR/LF/NUL/C0/DEL to prevent shell/PAM injection and terminal control
// sequences from sneaking into stored credentials.
export const PASSWORD_CONTROL_CHAR_RE = /[\r\n\x00-\x1f\x7f]/;

export function isSafePasswordChars(s: string): boolean {
  return !PASSWORD_CONTROL_CHAR_RE.test(s);
}

/**
 * Verify the configured Linux user's password using unix_chkpwd (PAM helper).
 * NOTE: no `nullok` — a blank/unset OS password must never authenticate, so a
 * stale `password_configured=true` flag can't be logged into against an empty
 * credential.
 */
export async function verifyPassword(password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/usr/sbin/unix_chkpwd", [getSystemUsername()], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    child.stdin.end(password + "\0");
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

// ── Session revocation via a generation counter ──────────────────────────────
//
// The signing secret is stable (rotating it would need a service restart), so a
// leaked/old cookie would otherwise stay valid until it expires. We stamp each
// cookie with the current `session_generation` and bump it on a password change
// — every prior cookie then fails the generation check and the user is forced to
// re-authenticate. Defaults to 0 everywhere, so it is inert until the first bump
// (existing sessions keep working across the upgrade).

export async function getSessionGeneration(): Promise<number> {
  const g = await get("session_generation");
  return typeof g === "number" && Number.isFinite(g) ? g : 0;
}

/** Invalidate every existing session (e.g. after a password change). */
export async function bumpSessionGeneration(): Promise<number> {
  const next = (await getSessionGeneration()) + 1;
  await set("session_generation", next);
  return next;
}

/** Create a signed session cookie value bound to the given generation. */
export function createSessionCookie(durationSeconds: number, secret: string, gen: number = 0): string {
  const exp = Math.floor(Date.now() / 1000) + durationSeconds;
  const payload = Buffer.from(JSON.stringify({ exp, gen })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Verify a session cookie — returns true if valid and not expired. When
 * `expectedGen` is provided, the cookie's generation must match (a mismatch
 * means it was minted before the last password change and is revoked).
 */
export function verifySessionCookie(cookie: string, secret: string, expectedGen?: number): boolean {
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return false;
  // Validate sig is valid hex and correct length (SHA-256 = 64 hex chars)
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false;

  try {
    const expectedSig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return false;
    }

    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return false;
    if (expectedGen !== undefined && (typeof data.gen === "number" ? data.gen : 0) !== expectedGen) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
