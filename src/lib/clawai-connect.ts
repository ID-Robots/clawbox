import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

// `configuring` is the intermediate state held while the device-side
// configure pipeline is restarting the gateway after upstream issued a
// token. Without it the poll route would have to hold the HTTP request
// open for the full ~50 s gateway restart, which the embedded Chromium
// often drops mid-flight — leaving the UI stuck on the device-code
// page even though the server already finished.
export type ClawAiConnectStatus = "pending" | "configuring" | "complete" | "error";
export type ClawAiTier = "flash" | "pro";

// Device-authorization session: a code the user types on the portal,
// plus the device_id we use to poll the upstream service for token
// issuance. Modelled after RFC 8628 device-flow state — same shape used
// by the OpenAI device-auth path so the UI can render both with one
// component.
export interface ClawAiConnectSession {
  device_id: string;
  user_code: string;
  interval: number;
  createdAt: number;
  status: ClawAiConnectStatus;
  provider: "clawai";
  scope: "primary" | "local";
  tier?: ClawAiTier;
  deviceName?: string;
  verificationUrl?: string;
  error?: string | null;
  completedAt?: number;
}

const STATE_PATH = path.join(DATA_DIR, "clawai-connect-state.json");
const SESSION_TTL_MS = 15 * 60 * 1000;

export const CLAWAI_USER_CODE_LENGTH = 8;

export function createClawAiUserCode(): string {
  // Crockford's Base32 minus easily-confused characters. Eight chars
  // collide once per ~1.1e12, which is comfortably below the chance of
  // two simultaneous sessions on the same proxy.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(CLAWAI_USER_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CLAWAI_USER_CODE_LENGTH; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function createClawAiDeviceId(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export async function writeClawAiSession(session: ClawAiConnectSession) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpPath = `${STATE_PATH}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmpPath, JSON.stringify(session), { mode: 0o600 });
  await fs.rename(tmpPath, STATE_PATH);
}

export async function readClawAiSession() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return JSON.parse(raw) as ClawAiConnectSession;
  } catch {
    return null;
  }
}

export async function clearClawAiSession() {
  await fs.unlink(STATE_PATH).catch(() => {});
}

export function isClawAiSessionExpired(session: ClawAiConnectSession) {
  return Date.now() - session.createdAt > SESSION_TTL_MS;
}
