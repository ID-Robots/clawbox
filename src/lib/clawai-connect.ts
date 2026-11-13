import crypto from "crypto";
import fs from "fs/promises";
import path, { untraced } from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { processStore } from "@/lib/process-store";

// `configuring` is the intermediate state held while the device-side
// configure pipeline is restarting the gateway after upstream issued a
// token. Without it the poll route would have to hold the HTTP request
// open for the full ~50 s gateway restart, which the embedded Chromium
// often drops mid-flight — leaving the UI stuck on the device-code
// page even though the server already finished.
export type ClawAiConnectStatus = "pending" | "configuring" | "complete" | "error";
export type ClawAiTier = "free" | "flash" | "pro";

/**
 * What the token the portal issues is FOR.
 *
 * - `primary` / `local` — ClawBox AI becomes a chat model of this box, in that
 *   slot; the poll hands the token to the configure route (or to Hermes).
 * - `entitlement` — the subscription is linked for its PLAN alone
 *   (`@/lib/subscription-link`, TASK-2501): plan-gated features unlock, and no
 *   provider, model or gateway setting is touched.
 */
export type ClawAiConnectScope = "primary" | "local" | "entitlement";

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
  scope: ClawAiConnectScope;
  tier?: ClawAiTier;
  deviceName?: string;
  verificationUrl?: string;
  error?: string | null;
  /**
   * What the configure answered BESIDE success: a save that landed and could
   * not do all of it (today: the session sweep the doctor stop defers). It
   * travels on the session for the same reason `error` does — the configure
   * runs off the poll request that started it, so the sentence has to survive
   * until the UI's next tick — and the poll answers it with `status:
   * "complete"` so Settings can render it instead of a plain "Configured".
   */
  warning?: string | null;
  completedAt?: number;
  /**
   * When the session entered the `configuring` state. Used by the poll
   * route to time out a session whose background configure never reported
   * back (e.g. the process died mid gateway-restart), instead of leaving
   * the UI polling `configuring` forever.
   */
  configuringStartedAt?: number;
  /**
   * The provider sign-in task finishing this session (src/lib/provider-auth-tasks.ts),
   * once the token landed: the poll answers from it while it runs, and from
   * how it ended when a web server that restarted under it never wrote the
   * session.
   */
  taskId?: string;
}

const STATE_PATH = path.join(DATA_DIR, "clawai-connect-state.json");
const SESSION_TTL_MS = 15 * 60 * 1000;

export const CLAWAI_USER_CODE_LENGTH = 8;

/**
 * Max time a session may sit in `configuring` before the poll route gives up
 * on the background configure and surfaces a retryable error. A gateway
 * restart takes ~50 s; 3 min leaves comfortable headroom for a slow Jetson.
 * The sign-out (src/lib/provider-sign-out.ts) reads the same window as "a
 * sign-in is still writing its token".
 */
export const CLAWAI_CONFIGURING_TIMEOUT_MS = 3 * 60 * 1000;

/** Is this session's background configure still within its window? */
export function isClawAiSessionConfiguring(session: ClawAiConnectSession, now = Date.now()): boolean {
  return session.status === "configuring"
    && now - (session.configuringStartedAt ?? session.createdAt) <= CLAWAI_CONFIGURING_TIMEOUT_MS;
}

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

/**
 * Every write of the session goes through one queue, shared by every copy of
 * this module in the process, so a conditional write
 * ({@link writeClawAiSessionIfCurrent}) reads and writes with no other write
 * in between.
 */
const sessionWrites = processStore("clawai-connect:session-writes", () => ({ queue: Promise.resolve() as Promise<unknown> }));

function serializedSessionWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = sessionWrites.queue.then(work, work);
  sessionWrites.queue = next.catch(() => undefined);
  return next;
}

async function writeSessionNow(session: ClawAiConnectSession) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpPath = untraced(`${STATE_PATH}.tmp.${crypto.randomBytes(4).toString("hex")}`);
  await fs.writeFile(tmpPath, JSON.stringify(session), { mode: 0o600 });
  await fs.rename(tmpPath, STATE_PATH);
}

export async function writeClawAiSession(session: ClawAiConnectSession) {
  await serializedSessionWrite(() => writeSessionNow(session));
}

/**
 * Write `next` only while the stored session is still `owner`'s — the same
 * device code, started at the same moment. A finish that waited on the portal
 * must not replace a newer sign-in someone started meanwhile with its own
 * ending. Answers whether it wrote.
 */
export async function writeClawAiSessionIfCurrent(
  owner: Pick<ClawAiConnectSession, "device_id" | "createdAt">,
  next: ClawAiConnectSession,
): Promise<boolean> {
  return serializedSessionWrite(async () => {
    const current = await readClawAiSession();
    if (!current || current.device_id !== owner.device_id || current.createdAt !== owner.createdAt) return false;
    await writeSessionNow(next);
    return true;
  });
}

export async function readClawAiSession() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return JSON.parse(raw) as ClawAiConnectSession;
  } catch {
    return null;
  }
}

/** Through the same queue as every write: a conditional write never recreates a session cleared meanwhile. */
export async function clearClawAiSession() {
  await serializedSessionWrite(() => fs.unlink(STATE_PATH).catch(() => {}));
}

export function isClawAiSessionExpired(session: ClawAiConnectSession) {
  return Date.now() - session.createdAt > SESSION_TTL_MS;
}
