/**
 * Phone pairing — the parts the browser and the server share.
 *
 * The owner's decision: a phone never gets the box's shared gateway key. Each
 * phone asks to pair from its own browser, the owner approves THAT phone in
 * the box UI, and only then does the box mint a per-phone setup code — the
 * OpenClaw core's own short-lived, single-use bootstrap credential — and hand
 * it to the browser that asked. Each paired phone is revoked on its own.
 *
 * No fs, no child processes: this module is imported by client components.
 * The server half is src/lib/phone-pairing.ts.
 */

/** Where every phone pairing code points the app: `wss://<host>/phone-ws`. Mirrors scripts/phone-upgrade.js. */
export const PHONE_WS_PATH = "/phone-ws";

/** The public page a phone opens from the owner's QR code. */
export const PHONE_PAIR_PAGE_PATH = "/phone-pair";

/** The owner's switch in data/config.json. Absent means OFF. Mirrors scripts/phone-upgrade.js. */
export const PHONE_PAIRING_CONFIG_KEY = "phone_pairing_enabled";

/** How long a QR invite stays usable before a phone has to ask, and how long a phone's ask waits for the owner. */
export const INVITE_TTL_MS = 10 * 60_000;

/** The longest a minted setup code is kept for the phone to collect (the core expires it at 10 minutes too). */
export const SETUP_CODE_TTL_MS = 10 * 60_000;

/** How many invites may be live at once. */
export const MAX_LIVE_INVITES = 5;

export const MAX_PHONE_NAME_LENGTH = 40;

export type PhonePlatform = "ios" | "android" | "other";

/** A phone that asked to pair from the QR link and is waiting for the owner. */
export interface PhoneRequestView {
  invite: string;
  name: string;
  platform: PhonePlatform;
  /** The address the box saw the phone's browser at, when it could tell. */
  address: string | null;
  requestedAtMs: number;
  expiresAtMs: number;
}

/** An invite the owner opened (QR shown) that no phone has used yet. */
export interface PhoneInviteView {
  invite: string;
  url: string;
  expiresAtMs: number;
}

/** A phone the owner approved whose code is waiting to be collected and used. */
export interface PhoneApprovedView {
  invite: string;
  name: string;
  platform: PhonePlatform;
  /** When the code the phone collected (or will collect) stops working. */
  expiresAtMs: number;
  delivered: boolean;
}

/** A phone the gateway has paired (its own device record). */
export interface PairedPhoneView {
  deviceId: string;
  name: string;
  platform: PhonePlatform;
  connected: boolean | null;
  lastSeenAtMs: number | null;
  approvedAtMs: number | null;
}

/** A pairing request the gateway itself is holding for approval. */
export interface PendingPhoneView {
  requestId: string;
  deviceId: string;
  name: string;
  platform: PhonePlatform;
  address: string | null;
  requestedAtMs: number | null;
}

/** GET /setup-api/nodes */
export interface PhonesState {
  /** False on a box without OpenClaw (Hermes edition): there is no gateway to pair with. */
  available: boolean;
  enabled: boolean;
  /** The box's permanent clawbox.tech hostname while the named tunnel runs, else null. */
  host: string | null;
  invites: PhoneInviteView[];
  requests: PhoneRequestView[];
  approved: PhoneApprovedView[];
  /** Null when the gateway could not be asked; `gatewayError` says why. */
  paired: PairedPhoneView[] | null;
  pending: PendingPhoneView[] | null;
  gatewayError?: string;
}

/** What the phone's page is told about its own ask. */
export type PhoneRequestStatus =
  | { state: "waiting"; expiresAtMs: number }
  | { state: "approved"; setupCode: string; expiresAtMs: number }
  | { state: "rejected" }
  | { state: "expired" };

/** The phone's family from its browser's User-Agent; only ever a label. */
export function phonePlatformFromUserAgent(userAgent: string | null | undefined): PhonePlatform {
  const ua = userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/**
 * The name a phone gave itself, made safe to show and store: control
 * characters out, whitespace collapsed, at most {@link MAX_PHONE_NAME_LENGTH}
 * characters (by code point, so an emoji is not cut in half). Empty means the
 * caller picks a default.
 */
export function cleanPhoneName(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, MAX_PHONE_NAME_LENGTH).join("").trim();
}

/** "iPhone", "Android phone" or "Phone" — what a phone is called when it gave no name. */
export function defaultPhoneName(platform: PhonePlatform): string {
  if (platform === "ios") return "iPhone";
  if (platform === "android") return "Android phone";
  return "Phone";
}
