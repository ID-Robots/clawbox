/**
 * Phone pairing — the server half. SERVER ONLY.
 *
 * THE DECISION. A phone never receives the box's shared gateway key. Each
 * phone asks to pair from its own browser (the owner's QR invite opens
 * /phone-pair), the owner approves THAT phone in the box UI, and only then
 * does the box mint a per-phone setup code and hand it to the browser that
 * asked. Each paired phone is revoked on its own.
 *
 * NATIVE MECHANISM (OpenClaw 2026.10.3, read from the pinned core):
 *  - the per-phone code is the core's own `device.pair.setupCode` with
 *    `bootstrapProfile: "limited"`: a base64url payload of
 *    `{ url, bootstrapToken, expiresAtMs }` whose bootstrap token is
 *    single-use, expires after 10 minutes and hands the phone a node token
 *    plus an operator token WITHOUT operator.admin. The core never puts the
 *    shared token in it; {@link assertPerPhoneSetupCode} still checks, and
 *    refuses to hand out a code that carries anything more;
 *  - the paired and pending phones are `device.pair.list`, the owner's
 *    approval of a request the gateway holds is `device.pair.approve`, a
 *    refusal `device.pair.reject`, and revoking a phone is
 *    `device.pair.remove`, which deletes its record and tokens and
 *    disconnects it. Nothing here writes the gateway's pairing store;
 *  - the phone link is attributed (scripts/phone-upgrade.js), which needs
 *    `gateway.trustedProxies` to list loopback while phone pairing is on —
 *    written through the core's own `config set` by
 *    {@link applyPhonePairingSwitch}, and taken back out when it goes off.
 *
 * WHY THE APPROVAL COMES BEFORE THE CODE. The core silently admits an official
 * phone app that redeems a valid setup code (`allowSetupCodeHandoffBootstrapPairing`)
 * and has no setting to hold it for approval. So the owner's "yes" has to be
 * given before the code exists: an approved request is the only thing that
 * mints one, and only the browser holding that request's claim can collect it.
 *
 * The invite store (data/phone-pairing.json, 0600) is ClawBox's own: which QR
 * invites are open, which phone asked on each, and the code waiting for that
 * phone. Every change to it is one synchronous read-modify-write, so two
 * requests in this process cannot interleave inside one.
 */

import crypto from "crypto";
import fs from "fs";

import { getKnown, resolveConfigRoot, set as setConfig } from "@/lib/config-store";
import { getGatewayToken } from "@/lib/gateway-proxy";
import { readNamedTunnelCredential, readTunnelMode } from "@/lib/named-tunnel";
import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";
import {
  callGatewayRpc,
  readConfigStrict,
  runOpenclawConfigSet,
  runOpenclawConfigUnset,
} from "@/lib/openclaw-config";
import {
  INVITE_TTL_MS,
  MAX_LIVE_INVITES,
  PHONE_PAIR_PAGE_PATH,
  PHONE_PAIRING_CONFIG_KEY,
  PHONE_WS_PATH,
  SETUP_CODE_TTL_MS,
  defaultPhoneName,
  type PairedPhoneView,
  type PendingPhoneView,
  type PhoneApprovedView,
  type PhoneInviteView,
  type PhonePlatform,
  type PhoneRequestStatus,
  type PhoneRequestView,
} from "@/lib/phone-pairing-shared";
import path, { untraced } from "@/lib/runtime-path";

// ─── The owner's switch ──────────────────────────────────────────────────────

/** Only the boolean `true` is on — the same rule production-server.js applies. */
export async function readPhonePairingEnabled(): Promise<boolean> {
  const { value, known } = await getKnown(PHONE_PAIRING_CONFIG_KEY);
  return known && value === true;
}

/** The trusted-proxy entries the phone link needs: the upgrade proxy connects from loopback. */
export const LOOPBACK_PROXIES = ["127.0.0.1", "::1"] as const;

/** Which of {@link LOOPBACK_PROXIES} this switch added, so turning it off removes those and nothing else. */
export const ADDED_PROXIES_CONFIG_KEY = "phone_pairing_trusted_proxies_added";

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Make the gateway's trusted proxies match the switch.
 *
 * On: add the loopback entries the list lacks (an owner's own entries stay),
 * and remember which ones this added. Off: remove exactly the remembered ones,
 * and unset the key when nothing else is left in it. The gateway applies
 * `gateway.trustedProxies` live (src/lib/gateway-hot-apply.ts lists it hot).
 *
 * A config that cannot be read throws rather than being treated as empty: a
 * write over a list nobody could read would replace the owner's entries. The
 * same goes for the record of what this switch added — an unreadable record
 * read as "nothing" would leave loopback trusted with the switch off.
 *
 * On, the record is written BEFORE the gateway's list: a list write that
 * landed with its record lost would be loopback trusted that switch-off never
 * takes back. A record ahead of a failed write costs nothing, because off
 * removes only entries the list really holds.
 */
export async function applyPhonePairingSwitch(enabled: boolean): Promise<void> {
  const config = (await readConfigStrict()) as { gateway?: { trustedProxies?: unknown } };
  const current = stringList(config.gateway?.trustedProxies);
  const { value: addedValue, known: addedKnown } = await getKnown(ADDED_PROXIES_CONFIG_KEY);
  if (!addedKnown) throw new Error("The ClawBox settings file could not be read, so the trusted proxies phone pairing added are not known.");
  const added = stringList(addedValue);

  if (enabled) {
    const missing = LOOPBACK_PROXIES.filter((p) => !current.includes(p));
    const remembered = [...new Set([...added, ...missing])];
    if (remembered.length !== added.length) await setConfig(ADDED_PROXIES_CONFIG_KEY, remembered);
    if (missing.length > 0) {
      await runOpenclawConfigSet(["gateway.trustedProxies", JSON.stringify([...current, ...missing]), "--json"]);
    }
    return;
  }

  const remaining = current.filter((p) => !added.includes(p));
  if (remaining.length !== current.length) {
    if (remaining.length > 0) {
      await runOpenclawConfigSet(["gateway.trustedProxies", JSON.stringify(remaining), "--json"]);
    } else {
      await runOpenclawConfigUnset("gateway.trustedProxies");
    }
  }
  if (added.length > 0) await setConfig(ADDED_PROXIES_CONFIG_KEY, undefined);
}

// ─── Where phones reach the box ──────────────────────────────────────────────

/**
 * The box's permanent `<boxHandle>.clawbox.tech` name while the named tunnel
 * runs, or null. A quick tunnel's address changes on every restart, which
 * would strand every paired phone, so phones pair over the permanent link only.
 */
export async function phonePairingHost(): Promise<string | null> {
  const [mode, credential] = await Promise.all([readTunnelMode(), readNamedTunnelCredential()]);
  return mode === "named" && credential ? credential.hostname : null;
}

export function phoneGatewayUrl(host: string): string {
  return `wss://${host}${PHONE_WS_PATH}`;
}

export function phoneInviteUrl(host: string, invite: string): string {
  // The invite rides the fragment, which a browser never sends: it does not
  // reach the tunnel's or this box's access logs.
  return `https://${host}${PHONE_PAIR_PAGE_PATH}#${invite}`;
}

// ─── The core's device records ───────────────────────────────────────────────

/** A pairing request or paired device that is a phone running the official app. */
export function isPhoneRecord(record: Record<string, unknown>): boolean {
  const clientId = typeof record.clientId === "string" ? record.clientId : "";
  if (clientId === "openclaw-ios" || clientId === "openclaw-android") return true;
  const family = typeof record.deviceFamily === "string" ? record.deviceFamily.toLowerCase() : "";
  if (["android", "iphone", "ipad", "ios"].includes(family)) return true;
  const platform = typeof record.platform === "string" ? record.platform.toLowerCase() : "";
  return /^(?:ios|ipados|android)(?:\s|$)/.test(platform);
}

function platformOf(record: Record<string, unknown>): PhonePlatform {
  const text = [record.clientId, record.deviceFamily, record.platform]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (/android/.test(text)) return "android";
  if (/ios|iphone|ipad/.test(text)) return "ios";
  return "other";
}

function nameOf(record: Record<string, unknown>, platform: PhonePlatform): string {
  for (const key of ["operatorLabel", "displayName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return defaultPhoneName(platform);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v))
    : [];
}

/**
 * Paired and pending phones, from the core's `device.pair.list`. The box's own
 * devices are left out.
 *
 * `poll: true` is the Phones panel's refresh: the gateway's own socket only.
 * {@link callGatewayRpc} falls back to starting the CLI when the socket is not
 * there, ten seconds of a Jetson's CPU, and a panel that refreshes every few
 * seconds while the gateway is down would keep one running. The panel shows
 * "could not be asked" instead; the actions keep the fallback.
 */
export async function listPhoneDevices(
  opts: { poll?: boolean } = {},
): Promise<{ paired: PairedPhoneView[]; pending: PendingPhoneView[] }> {
  const result = opts.poll
    ? await gatewayWsCall("device.pair.list", {})
    : await callGatewayRpc("device.pair.list", {});
  if (!Array.isArray(result.paired) || !Array.isArray(result.pending)) {
    throw new Error("device.pair.list answered without its paired and pending lists");
  }
  const paired = records(result.paired)
    .filter((r) => typeof r.deviceId === "string" && r.deviceId && isPhoneRecord(r))
    .map((r): PairedPhoneView => {
      const platform = platformOf(r);
      return {
        deviceId: r.deviceId as string,
        name: nameOf(r, platform),
        platform,
        connected: typeof r.connected === "boolean" ? r.connected : null,
        lastSeenAtMs: numberOrNull(r.lastSeenAtMs),
        approvedAtMs: numberOrNull(r.approvedAtMs),
      };
    });
  const pending = records(result.pending)
    .filter((r) => typeof r.requestId === "string" && r.requestId && isPhoneRecord(r))
    .map((r): PendingPhoneView => {
      const platform = platformOf(r);
      return {
        requestId: r.requestId as string,
        deviceId: typeof r.deviceId === "string" ? r.deviceId : "",
        name: nameOf(r, platform),
        platform,
        address: typeof r.remoteIp === "string" && r.remoteIp ? r.remoteIp : null,
        requestedAtMs: numberOrNull(r.ts),
      };
    });
  return { paired, pending };
}

/** Thrown when the id names nothing the Phones list shows: no such phone, or one of the box's own devices. */
export class NotAPhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAPhoneError";
  }
}

/** Revoke one paired phone: the core's `device.pair.remove`. Only a phone the list shows. */
export async function revokePhone(deviceId: string): Promise<void> {
  const { paired } = await listPhoneDevices();
  if (!paired.some((p) => p.deviceId === deviceId)) throw new NotAPhoneError("No paired phone has that id.");
  await callGatewayRpc("device.pair.remove", { deviceId });
}

/** Approve one pairing request the gateway holds for a phone: `device.pair.approve`. */
export async function approvePendingPhone(requestId: string): Promise<void> {
  const { pending } = await listPhoneDevices();
  if (!pending.some((p) => p.requestId === requestId)) throw new NotAPhoneError("No phone is waiting with that request id.");
  await callGatewayRpc("device.pair.approve", { requestId });
}

/** Refuse one pairing request the gateway holds for a phone: `device.pair.reject`. */
export async function rejectPendingPhone(requestId: string): Promise<void> {
  const { pending } = await listPhoneDevices();
  if (!pending.some((p) => p.requestId === requestId)) throw new NotAPhoneError("No phone is waiting with that request id.");
  await callGatewayRpc("device.pair.reject", { requestId });
}

// ─── The per-phone code ──────────────────────────────────────────────────────

/** Thrown when a code the gateway produced is not a one-phone credential for the phone link. */
export class SetupCodeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupCodeRefusedError";
  }
}

const SETUP_PAYLOAD_KEYS = new Set(["url", "urls", "bootstrapToken", "expiresAtMs", "tlsFingerprint"]);
/** Shorter than this is no secret worth looking for; it would only produce false refusals. */
const MIN_SECRET_LENGTH = 8;

/**
 * Prove a setup code is what the owner approved: a single-phone bootstrap
 * for the phone link, and never the box's shared key.
 *
 * Decodes the payload (base64url JSON, the core's own format) and refuses
 * when it holds any field but the bootstrap ones, names any address but the
 * phone link, has no bootstrap token, or contains one of the shared secrets
 * anywhere in its text.
 *
 * The substring check knows only the secrets the box can read. On an install
 * whose gateway token is a SecretRef or a `${ENV}` value, getGatewayToken()
 * answers "" and only the literal password is compared, so there the field
 * whitelist is the one guard on `bootstrapToken` and `tlsFingerprint`.
 */
export function assertPerPhoneSetupCode(setupCode: unknown, expectedUrl: string, sharedSecrets: readonly string[]): string {
  if (typeof setupCode !== "string" || !/^[A-Za-z0-9_-]+$/.test(setupCode)) {
    throw new SetupCodeRefusedError("The gateway answered without a setup code.");
  }
  let text: string;
  let payload: unknown;
  try {
    text = Buffer.from(setupCode, "base64url").toString("utf8");
    payload = JSON.parse(text);
  } catch {
    throw new SetupCodeRefusedError("The gateway's setup code could not be read.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SetupCodeRefusedError("The gateway's setup code could not be read.");
  }
  const fields = payload as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!SETUP_PAYLOAD_KEYS.has(key)) {
      throw new SetupCodeRefusedError(`The gateway's setup code carries a "${key}" field; only a one-phone bootstrap may be handed out.`);
    }
  }
  if (typeof fields.bootstrapToken !== "string" || fields.bootstrapToken.length < 16) {
    throw new SetupCodeRefusedError("The gateway's setup code carries no one-phone bootstrap credential.");
  }
  const urls = fields.urls === undefined ? [] : fields.urls;
  if (fields.url !== expectedUrl || !Array.isArray(urls) || urls.some((u) => u !== expectedUrl)) {
    throw new SetupCodeRefusedError("The gateway's setup code points somewhere other than this box's phone link.");
  }
  for (const secret of sharedSecrets) {
    if (secret.length >= MIN_SECRET_LENGTH && (text.includes(secret) || setupCode.includes(secret))) {
      throw new SetupCodeRefusedError("The gateway's setup code contains the box's shared key. It was not handed out.");
    }
  }
  return setupCode;
}

async function sharedGatewaySecrets(): Promise<string[]> {
  const secrets: string[] = [];
  const token = await getGatewayToken();
  if (token) secrets.push(token);
  try {
    const config = (await readConfigStrict()) as { gateway?: { auth?: { password?: unknown } } };
    const password = config.gateway?.auth?.password;
    if (typeof password === "string" && password) secrets.push(password);
  } catch {
    // The token check above still runs; an unreadable config holds no password we could compare.
  }
  return secrets;
}

export interface MintedSetupCode {
  setupCode: string;
  setupId: string | null;
  expiresAtMs: number;
}

/** One per-phone setup code from the core, checked by {@link assertPerPhoneSetupCode}. */
export async function mintPhoneSetupCode(host: string, now = Date.now()): Promise<MintedSetupCode> {
  const url = phoneGatewayUrl(host);
  const result = await callGatewayRpc("device.pair.setupCode", {
    publicUrl: url,
    bootstrapProfile: "limited",
    includeQr: false,
  });
  const setupCode = assertPerPhoneSetupCode(result.setupCode, url, await sharedGatewaySecrets());
  const coreExpiry = numberOrNull(result.expiresAtMs);
  return {
    setupCode,
    setupId: typeof result.setupId === "string" ? result.setupId : null,
    expiresAtMs: Math.min(coreExpiry ?? now + SETUP_CODE_TTL_MS, now + SETUP_CODE_TTL_MS),
  };
}

// ─── The invite store ────────────────────────────────────────────────────────

interface InviteRecord {
  id: string;
  createdAtMs: number;
  /** Until a phone asks: when the invite closes. Once it has: when the ask lapses. */
  expiresAtMs: number;
  state: "open" | "requested" | "approved" | "rejected";
  name?: string;
  platform?: PhonePlatform;
  address?: string | null;
  requestedAtMs?: number;
  /** SHA-256 of the claim the asking browser holds; the claim itself is never stored. */
  claimHash?: string;
  setupCode?: string;
  setupId?: string | null;
  setupExpiresAtMs?: number;
  deliveredAtMs?: number;
  decidedAtMs?: number;
}

interface InviteStore {
  invites: InviteRecord[];
}

/** A decided invite is kept this long so the phone's page can still say what happened. */
const DECIDED_GRACE_MS = 10 * 60_000;

export const INVITE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const CLAIM_RE = /^[A-Za-z0-9_-]{32}$/;

function storePath(): string {
  return path.join(resolveConfigRoot(), "data", "phone-pairing.json");
}

function readStore(): InviteStore {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { invites: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written or hand-mangled file holds nothing anyone can use: every
    // entry in it lapses within minutes anyway. Start over rather than refuse
    // every phone until someone deletes it. A file that cannot be READ still
    // throws above — that is not evidence the store is empty.
    console.warn("[phone-pairing] data/phone-pairing.json is not JSON; starting a fresh invite store");
    return { invites: [] };
  }
  const invites = (parsed as { invites?: unknown } | null)?.invites;
  return { invites: Array.isArray(invites) ? (invites as InviteRecord[]).filter((i) => i && typeof i.id === "string") : [] };
}

function writeStore(store: InviteStore): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = untraced(`${file}.tmp`);
  // Holds per-phone bootstrap codes while they wait to be collected.
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Drop what has lapsed: unused invites, unanswered asks, uncollected codes, and decisions past their grace. */
function prune(store: InviteStore, now: number): boolean {
  const before = store.invites.length;
  store.invites = store.invites.filter((i) => {
    if (i.state === "open" || i.state === "requested") return i.expiresAtMs > now - DECIDED_GRACE_MS;
    if (i.state === "approved") return (i.setupExpiresAtMs ?? 0) > now - DECIDED_GRACE_MS;
    return (i.decidedAtMs ?? 0) > now - DECIDED_GRACE_MS;
  });
  // A code nobody can use any more is not kept on disk.
  let scrubbed = false;
  for (const i of store.invites) {
    if (i.setupCode && (i.setupExpiresAtMs ?? 0) <= now) {
      delete i.setupCode;
      scrubbed = true;
    }
  }
  return scrubbed || store.invites.length !== before;
}

/** One read-modify-write, synchronous end to end. */
function mutate<T>(now: number, change: (store: InviteStore) => T): T {
  const store = readStore();
  prune(store, now);
  const result = change(store);
  writeStore(store);
  return result;
}

function hashClaim(claim: string): string {
  return crypto.createHash("sha256").update(claim).digest("hex");
}

function claimMatches(record: InviteRecord, claim: string): boolean {
  if (!record.claimHash) return false;
  const a = Buffer.from(record.claimHash, "hex");
  const b = Buffer.from(hashClaim(claim), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Thrown for a store action the invite's state does not allow. */
export class InviteStateError extends Error {
  constructor(
    message: string,
    readonly code: "too_many" | "unknown" | "used" | "expired" | "not_requested",
  ) {
    super(message);
    this.name = "InviteStateError";
  }
}

function live(i: InviteRecord, now: number): boolean {
  return (i.state === "open" || i.state === "requested") && i.expiresAtMs > now;
}

/** Open one QR invite. At most {@link MAX_LIVE_INVITES} may be live. */
export function createInvite(now = Date.now()): { invite: string; expiresAtMs: number } {
  return mutate(now, (store) => {
    if (store.invites.filter((i) => live(i, now)).length >= MAX_LIVE_INVITES) {
      throw new InviteStateError("Too many phone invites are open. Let one expire or decide on the phones that asked.", "too_many");
    }
    const invite = crypto.randomBytes(16).toString("base64url");
    const expiresAtMs = now + INVITE_TTL_MS;
    store.invites.push({ id: invite, createdAtMs: now, expiresAtMs, state: "open" });
    return { invite, expiresAtMs };
  });
}

/**
 * A phone asks to pair on an open invite. One ask per invite: the first
 * browser to ask holds the claim, and the owner sees its name, platform and
 * address before deciding. Answers the claim the browser keeps.
 */
export function requestOnInvite(
  invite: string,
  ask: { name: string; platform: PhonePlatform; address: string | null },
  now = Date.now(),
): { claim: string; expiresAtMs: number } {
  return mutate(now, (store) => {
    const record = store.invites.find((i) => i.id === invite);
    if (!record) throw new InviteStateError("This pairing link is not valid.", "unknown");
    if (record.state !== "open") throw new InviteStateError("This pairing link was already used.", "used");
    if (record.expiresAtMs <= now) throw new InviteStateError("This pairing link has expired.", "expired");
    const claim = crypto.randomBytes(24).toString("base64url");
    record.state = "requested";
    record.name = ask.name || defaultPhoneName(ask.platform);
    record.platform = ask.platform;
    record.address = ask.address;
    record.requestedAtMs = now;
    record.expiresAtMs = now + INVITE_TTL_MS;
    record.claimHash = hashClaim(claim);
    return { claim, expiresAtMs: record.expiresAtMs };
  });
}

/**
 * What the asking browser is told. Only the claim's holder learns anything,
 * and only it ever receives the code. Null when the claim does not match.
 */
export function requestStatus(invite: string, claim: string, now = Date.now()): PhoneRequestStatus | null {
  return mutate(now, (store): PhoneRequestStatus | null => {
    const record = store.invites.find((i) => i.id === invite);
    if (!record || !claimMatches(record, claim)) return null;
    if (record.state === "rejected") return { state: "rejected" };
    if (record.state === "approved") {
      if (!record.setupCode || (record.setupExpiresAtMs ?? 0) <= now) return { state: "expired" };
      record.deliveredAtMs ??= now;
      return { state: "approved", setupCode: record.setupCode, expiresAtMs: record.setupExpiresAtMs ?? now };
    }
    if (record.state === "requested" && record.expiresAtMs > now) {
      return { state: "waiting", expiresAtMs: record.expiresAtMs };
    }
    return { state: "expired" };
  });
}

/** The ask on `invite`, while it still waits for the owner. Throws otherwise. */
export function pendingAsk(invite: string, now = Date.now()): { name: string; platform: PhonePlatform } {
  const store = readStore();
  const record = store.invites.find((i) => i.id === invite);
  if (!record) throw new InviteStateError("That phone's request is gone.", "unknown");
  if (record.state !== "requested") throw new InviteStateError("That phone's request was already decided.", "not_requested");
  if (record.expiresAtMs <= now) throw new InviteStateError("That phone's request has expired.", "expired");
  return { name: record.name ?? "", platform: record.platform ?? "other" };
}

/** The owner approved the ask on `invite`: keep the minted code for its browser to collect. */
export function approveAsk(invite: string, minted: MintedSetupCode, now = Date.now()): void {
  mutate(now, (store) => {
    const record = store.invites.find((i) => i.id === invite);
    if (!record) throw new InviteStateError("That phone's request is gone.", "unknown");
    if (record.state !== "requested") throw new InviteStateError("That phone's request was already decided.", "not_requested");
    if (record.expiresAtMs <= now) throw new InviteStateError("That phone's request has expired.", "expired");
    record.state = "approved";
    record.setupCode = minted.setupCode;
    record.setupId = minted.setupId;
    record.setupExpiresAtMs = minted.expiresAtMs;
    record.decidedAtMs = now;
  });
}

/** The owner refused the ask on `invite`, or closed an invite nobody used. */
export function rejectInvite(invite: string, now = Date.now()): void {
  mutate(now, (store) => {
    const record = store.invites.find((i) => i.id === invite);
    if (!record) throw new InviteStateError("That invite is gone.", "unknown");
    if (record.state === "approved" || record.state === "rejected") {
      throw new InviteStateError("That phone's request was already decided.", "not_requested");
    }
    if (record.state === "open") {
      store.invites = store.invites.filter((i) => i !== record);
      return;
    }
    // The claim stays, so the browser that asked is told "no" rather than
    // "this link is not valid"; the decision is all it can learn with it.
    record.state = "rejected";
    record.decidedAtMs = now;
  });
}

/** Phone pairing went off: no invite or uncollected code survives it. */
export function closeAllInvites(now = Date.now()): void {
  mutate(now, (store) => {
    for (const record of store.invites) {
      if (record.state === "open" || record.state === "requested" || record.state === "approved") {
        record.state = "rejected";
        record.decidedAtMs = now;
        delete record.setupCode;
      }
    }
  });
}

/** The owner's view of the store: open invites, phones waiting for a decision, approved phones still collecting. */
export function inviteViews(host: string | null, now = Date.now()): {
  invites: PhoneInviteView[];
  requests: PhoneRequestView[];
  approved: PhoneApprovedView[];
} {
  const store = readStore();
  if (prune(store, now)) writeStore(store);
  const invites = store.invites
    .filter((i) => i.state === "open" && i.expiresAtMs > now && host)
    .map((i) => ({ invite: i.id, url: phoneInviteUrl(host as string, i.id), expiresAtMs: i.expiresAtMs }));
  const requests = store.invites
    .filter((i) => i.state === "requested" && i.expiresAtMs > now)
    .map((i) => ({
      invite: i.id,
      name: i.name ?? defaultPhoneName(i.platform ?? "other"),
      platform: i.platform ?? "other",
      address: i.address ?? null,
      requestedAtMs: i.requestedAtMs ?? i.createdAtMs,
      expiresAtMs: i.expiresAtMs,
    }));
  const approved = store.invites
    .filter((i) => i.state === "approved" && (i.setupExpiresAtMs ?? 0) > now)
    .map((i) => ({
      invite: i.id,
      name: i.name ?? defaultPhoneName(i.platform ?? "other"),
      platform: i.platform ?? "other",
      expiresAtMs: i.setupExpiresAtMs ?? now,
      delivered: typeof i.deliveredAtMs === "number",
    }));
  return { invites, requests, approved };
}
