import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
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

/** Verify password against the Linux user `clawbox` using unix_chkpwd (PAM helper). */
export async function verifyPassword(password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/usr/sbin/unix_chkpwd", ["clawbox", "nullok"], {
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
