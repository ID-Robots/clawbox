/**
 * Pairing-session helpers for ClawKeep, mirroring src/lib/clawai-connect.ts.
 *
 * Two TS modules instead of one generalised helper because the storage
 * locations and resulting actions are different (ClawAI writes to
 * auth-profiles.json + agent config; ClawKeep writes a single bearer token
 * to $CLAWKEEP_DATA_DIR/token), but the wire shape with the portal is
 * identical: `state` → portal/connect → `code` → /api/portal/connect/exchange.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { CLAWKEEP_DATA_DIR } from "@/lib/clawkeep";

export type ClawKeepConnectStatus = "pending" | "complete" | "error";

export interface ClawKeepConnectSession {
  state: string;
  createdAt: number;
  status: ClawKeepConnectStatus;
  redirectUri: string;
  deviceName: string;
  error?: string | null;
  completedAt?: number;
}

const STATE_PATH = path.join(CLAWKEEP_DATA_DIR, "pair-state.json");
const SESSION_TTL_MS = 10 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createClawKeepState() {
  return base64url(crypto.randomBytes(32));
}

export async function writeClawKeepSession(session: ClawKeepConnectSession) {
  await fs.mkdir(CLAWKEEP_DATA_DIR, { recursive: true, mode: 0o700 });
  const tmpPath = `${STATE_PATH}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmpPath, JSON.stringify(session), { mode: 0o600 });
  await fs.rename(tmpPath, STATE_PATH);
}

function isValidSession(value: unknown): value is ClawKeepConnectSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Record<keyof ClawKeepConnectSession, unknown>>;
  if (typeof v.state !== "string" || !v.state) return false;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return false;
  if (v.status !== "pending" && v.status !== "complete" && v.status !== "error") return false;
  if (typeof v.redirectUri !== "string") return false;
  if (typeof v.deviceName !== "string") return false;
  if (v.error !== undefined && v.error !== null && typeof v.error !== "string") return false;
  if (v.completedAt !== undefined && typeof v.completedAt !== "number") return false;
  return true;
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
