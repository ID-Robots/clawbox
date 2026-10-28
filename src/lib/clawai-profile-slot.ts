/**
 * The credential slot ClawBox AI signs in to — the `deepseek:default` profile
 * of the OpenClaw gateway's auth store — and what a sign-in may do with
 * whatever already holds it.
 *
 * WHY. ClawBox AI stores its portal token there with `openclaw models auth
 * paste-api-key`, and the pinned core refuses that paste when the profile at
 * the id is not an API key of the same provider ("The API-key profile belongs
 * to another sign-in. Manage that saved sign-in first."). Boxes carry an
 * `oauth` profile at that id — earlier ClawBox versions wrote the portal token
 * as an OAuth bundle — so a fresh sign-in failed at its very last step, and the
 * provider sat in the auth cooldown its old credential had earned.
 *
 * THE RULE, decided once here so the configure route, the fallback pass and
 * the Settings removal agree:
 *  - nothing there, or exactly the token being stored → nothing to do;
 *  - a ClawBox AI portal token (any account) → the paste replaces it;
 *  - an OAuth sign-in, a token of another kind or another provider's profile
 *    → stale: backed up, logged out with core's own verb, then pasted over;
 *  - an API key that is NOT ClawBox AI's is the owner's own DeepSeek key. It
 *    is replaced only when DeepSeek refuses it (asked live, or — when DeepSeek
 *    cannot be asked — core's own record of an auth failure on it). A key
 *    that still works, or one nobody can judge, is never overwritten: the
 *    sign-in is refused with a sentence that says how to remove it.
 *
 * The credential never leaves this module: it is compared and, for the owner's
 * key alone, sent to the provider it belongs to. Backups go under
 * `data/auth-profile-backups/` (0600, not a public data subtree).
 */

import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { isClawboxAiToken } from "@/lib/clawai-token";
import {
  backupGatewayAuthProfile,
  clearGatewayAuthProfileFailures,
  readGatewayProviderAuth,
  withGatewayAuthProfileCredential,
  type GatewayAuthBackupResult,
  type GatewayAuthClearResult,
} from "@/lib/openclaw-auth-store";

/** The profile id ClawBox AI's credential lives at. */
export const CLAWAI_PROFILE_ID = `${CLAWBOX_AI_PROVIDER}:default`;

/** Where a replaced or removed profile is kept. Resolved at call time, like every DATA_DIR path a route can be loaded without. */
export function authProfileBackupDir(): string {
  return path.join(DATA_DIR, "auth-profile-backups");
}

/** DeepSeek's own API, where an owner's DeepSeek key is asked whether it still works. */
export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";

const KEY_CHECK_TIMEOUT_MS = 5_000;

/** The failure reasons core records when a provider refuses the credential itself (not billing, not a rate limit). */
const AUTH_FAILURE_REASONS = new Set(["auth", "auth_permanent"]);

export type ClawaiSlot =
  /** Nothing there — or a store this box cannot read, which the paste then meets as it always did. */
  | { kind: "free" }
  /** Exactly the API key being stored. */
  | { kind: "same" }
  /** A ClawBox AI portal token: one this box holds (`known`), or another account's. */
  | { kind: "clawai"; known: boolean }
  /**
   * Nothing this slot can use: a sign-in (`oauth`), or a profile of another
   * type or provider (`foreign`). `ours`: its credential is a ClawBox AI portal
   * token, i.e. ClawBox's own credential written in the wrong shape.
   */
  | { kind: "stale"; reason: "oauth" | "foreign"; type: string; ours: boolean }
  /**
   * A DeepSeek key that is not ClawBox AI's: the owner's own. `rejected` —
   * does DeepSeek refuse it: true, false, or null when that could not be told;
   * `evidence` says who answered.
   */
  | { kind: "owner-key"; type: string; rejected: boolean | null; evidence: "provider" | "gateway" | null };

export type KeyVerdict = "works" | "rejected" | "unknown";

export interface InspectOptions {
  /** The token about to be stored, if any. */
  token?: string;
  /** ClawBox AI tokens this box holds (its stored one, the one being stored). */
  knownTokens?: readonly string[];
  /** Ask DeepSeek about an owner's key. Off for the cheap reads (the fallback pass, the Settings notice). */
  checkOwnerKey?: boolean;
  /** Where the owner's key is sent when it is used: the configured endpoint when it is not a ClawBox host. */
  ownerKeyBaseUrl?: string | null;
}

/**
 * What holds the slot, read from the store the gateway resolves. Never throws.
 * Asks DeepSeek only for an owner's key and only with `checkOwnerKey`.
 */
export async function inspectClawaiSlot(options: InspectOptions = {}): Promise<ClawaiSlot> {
  const known = new Set((options.knownTokens ?? []).filter((t) => typeof t === "string" && t !== ""));
  if (options.token) known.add(options.token);
  let check: (() => Promise<KeyVerdict>) | null = null;
  const slot = withGatewayAuthProfileCredential(CLAWAI_PROFILE_ID, (credential): ClawaiSlot => {
    const { type, provider, secret } = credential;
    const ours = secret !== null && (known.has(secret) || isClawboxAiToken(secret));
    if (type === "oauth") return { kind: "stale", reason: "oauth", type, ours };
    if (provider !== CLAWBOX_AI_PROVIDER || (type !== "api_key" && type !== "token")) {
      return { kind: "stale", reason: "foreign", type, ours };
    }
    if (secret !== null && isClawboxAiToken(secret)) {
      // core refuses an API key over a `token` profile too, so only an API key
      // can simply be pasted over.
      if (type !== "api_key") return { kind: "stale", reason: "foreign", type, ours: true };
      if (secret === options.token) return { kind: "same" };
      return { kind: "clawai", known: known.has(secret) };
    }
    if (secret !== null && secret === options.token && type === "api_key") return { kind: "same" };
    // The owner's key. Behind a SecretRef (`secret === null`) it cannot be
    // asked about — and nobody but its owner put it there.
    if (secret !== null && options.checkOwnerKey) {
      const key = secret;
      check = () => checkDeepseekKey(key, options.ownerKeyBaseUrl);
    }
    return { kind: "owner-key", type, rejected: null, evidence: null };
  }) ?? { kind: "free" };
  if (slot.kind !== "owner-key") return slot;
  const pending = check as (() => Promise<KeyVerdict>) | null;
  const verdict = pending ? await pending() : "unknown";
  if (verdict !== "unknown") return { ...slot, rejected: verdict === "rejected", evidence: "provider" };
  // DeepSeek could not be asked: core's own record of the last attempt — an
  // auth failure it saw on this profile — is the next best witness.
  return gatewayRefusedSlot() ? { ...slot, rejected: true, evidence: "gateway" } : slot;
}

/** Did core record that the provider refused the credential at the slot? Never throws. */
function gatewayRefusedSlot(): boolean {
  const read = readGatewayProviderAuth(CLAWBOX_AI_PROVIDER);
  if (read.kind !== "present") return false;
  const failure = read.failures[CLAWAI_PROFILE_ID];
  if (!failure) return false;
  return [failure.cooldownReason, failure.disabledReason].some((reason) => reason !== null && AUTH_FAILURE_REASONS.has(reason));
}

/**
 * Ask the endpoint the key is used against whether it still takes it:
 * `GET <base>/models`, which DeepSeek's API answers 401 for a key it refuses.
 * Anything but a clear yes or no — a timeout, a 5xx, a 429 — is `unknown`.
 */
export async function checkDeepseekKey(key: string, baseUrl?: string | null): Promise<KeyVerdict> {
  const base = (baseUrl && /^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : DEEPSEEK_API_BASE_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
      cache: "no-store",
    });
    // Nothing of the body is needed; release it.
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) return "rejected";
    return res.ok ? "works" : "unknown";
  } catch {
    return "unknown";
  }
}

/** The owner's key may stay: a sign-in must not overwrite it. */
export function slotBlocksSignIn(slot: ClawaiSlot): boolean {
  return slot.kind === "owner-key" && slot.rejected !== true;
}

/** What is there must go before a paste can land: core refuses an API key over it. */
export function slotNeedsLogout(slot: ClawaiSlot): boolean {
  return slot.kind === "stale" || (slot.kind === "owner-key" && slot.type !== "api_key");
}

/** Worth a copy before it is replaced: anything but this box's own ClawBox AI token. */
export function slotNeedsBackup(slot: ClawaiSlot): boolean {
  if (slot.kind === "free" || slot.kind === "same") return false;
  if (slot.kind === "clawai") return !slot.known;
  return true;
}

/** One phrase for a log line: what held the slot, never its credential. */
export function describeClawaiSlot(slot: ClawaiSlot): string {
  switch (slot.kind) {
    case "free": return "nothing";
    case "same": return "this very key";
    case "clawai": return slot.known ? "this box's previous ClawBox AI token" : "another ClawBox AI account's token";
    case "stale": return `a stale ${slot.reason === "oauth" ? "OAuth sign-in" : `${slot.type || "untyped"} profile`}${slot.ours ? " holding a ClawBox AI token" : ""}`;
    case "owner-key": {
      const verdict = slot.rejected === true ? "refused by DeepSeek" : slot.rejected === false ? "accepted by DeepSeek" : "not verifiable";
      return `the owner's own DeepSeek key (${verdict}${slot.evidence === "gateway" ? ", per the gateway's auth failures" : ""})`;
    }
  }
}

/** Copy the slot's profile aside before it is replaced or removed. */
export function backupClawaiSlot(): GatewayAuthBackupResult {
  return backupGatewayAuthProfile(CLAWAI_PROFILE_ID, authProfileBackupDir());
}

/** Clear core's cooldown and auth-failure record for the slot (see clearGatewayAuthProfileFailures). */
export function clearClawaiSlotFailures(): GatewayAuthClearResult {
  return clearGatewayAuthProfileFailures([CLAWAI_PROFILE_ID]);
}
