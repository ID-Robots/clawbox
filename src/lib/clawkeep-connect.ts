/**
 * Pairing-session helpers for ClawKeep — RFC 8628 device-code grant,
 * mirroring src/lib/clawai-connect.ts.
 *
 * Two TS modules instead of one generalised helper because the storage
 * locations and resulting actions are different (ClawAI writes to
 * auth-profiles.json + agent config; ClawKeep writes a single bearer token
 * to $CLAWKEEP_DATA_DIR/token), but the wire shape with the portal is
 * identical: `user_code` → portal/connect → upstream device-poll → token.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { CLAWKEEP_DATA_DIR } from "@/lib/clawkeep";

// `configuring` matches the ClawAI session machine: the upstream issued a
// token, we're writing it to disk, and the next poll resolves to `complete`.
// Lets the poll route acknowledge quickly so embedded Chromium doesn't drop
// the request mid-flight while disk writes happen.
export type ClawKeepConnectStatus = "pending" | "configuring" | "complete" | "error";

export interface ClawKeepConnectSession {
  device_id: string;
  user_code: string;
  interval: number;
  createdAt: number;
  status: ClawKeepConnectStatus;
  deviceName: string;
  verificationUrl: string;
  error?: string | null;
  completedAt?: number;
}

const STATE_PATH = path.join(CLAWKEEP_DATA_DIR, "pair-state.json");
const SESSION_TTL_MS = 15 * 60 * 1000;

export const CLAWKEEP_USER_CODE_LENGTH = 8;

export function createClawKeepUserCode(): string {
  // Crockford's Base32 minus easily-confused characters — same alphabet
  // ClawAI uses so the portal can render both flows with one component.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(CLAWKEEP_USER_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CLAWKEEP_USER_CODE_LENGTH; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function createClawKeepDeviceId(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function isValidSession(value: unknown): value is ClawKeepConnectSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Record<keyof ClawKeepConnectSession, unknown>>;
  if (typeof v.device_id !== "string" || !v.device_id) return false;
  if (typeof v.user_code !== "string" || !v.user_code) return false;
  if (typeof v.interval !== "number" || !Number.isFinite(v.interval)) return false;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return false;
  if (
    v.status !== "pending"
    && v.status !== "configuring"
    && v.status !== "complete"
    && v.status !== "error"
  ) return false;
  if (typeof v.deviceName !== "string") return false;
  if (typeof v.verificationUrl !== "string") return false;
  if (v.error !== undefined && v.error !== null && typeof v.error !== "string") return false;
  if (v.completedAt !== undefined && typeof v.completedAt !== "number") return false;
  return true;
}

export async function writeClawKeepSession(session: ClawKeepConnectSession) {
  await fs.mkdir(CLAWKEEP_DATA_DIR, { recursive: true, mode: 0o700 });
  const tmpPath = `${STATE_PATH}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmpPath, JSON.stringify(session), { mode: 0o600 });
  await fs.rename(tmpPath, STATE_PATH);
}

export async function readClawKeepSession(): Promise<ClawKeepConnectSession | null> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isValidSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearClawKeepSession() {
  await fs.unlink(STATE_PATH).catch(() => {});
}

export function isClawKeepSessionExpired(session: ClawKeepConnectSession) {
  return Date.now() - session.createdAt > SESSION_TTL_MS;
}
