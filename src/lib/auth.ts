import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { DATA_DIR } from "./config-store";

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

/** Verify the configured Linux user's password using unix_chkpwd (PAM helper). */
export async function verifyPassword(password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/usr/sbin/unix_chkpwd", [getSystemUsername(), "nullok"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    child.stdin.end(password + "\0");
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/** Create a signed session cookie value. */
export function createSessionCookie(durationSeconds: number, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + durationSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/** Verify a session cookie — returns true if valid and not expired. */
export function verifySessionCookie(cookie: string, secret: string): boolean {
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
    return typeof data.exp === "number" && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
