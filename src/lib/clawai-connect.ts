import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

export type ClawAiConnectStatus = "pending" | "complete" | "error";

export interface ClawAiConnectSession {
  state: string;
  createdAt: number;
  status: ClawAiConnectStatus;
  provider: "clawai";
  scope: "primary" | "local";
  redirectUri?: string;
  deviceName?: string;
  model?: string;
  error?: string | null;
  completedAt?: number;
}

const STATE_PATH = path.join(DATA_DIR, "clawai-connect-state.json");
const SESSION_TTL_MS = 10 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createClawAiState() {
  return base64url(crypto.randomBytes(32));
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
