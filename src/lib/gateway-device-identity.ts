"use client";

/**
 * The browser half of OpenClaw 2's device identity.
 *
 * Since 2026.8, a Control-UI/webchat client must present a device identity in
 * its connect handshake: an Ed25519 keypair minted BY THE BROWSER, whose
 * public key the gateway pairs once (auto-approved for loopback TCP peers
 * that already passed gateway token auth — which is exactly what every
 * ClawBox page is, because production-server proxies the socket from port 80
 * to the loopback gateway without forwarding headers). The retired
 * `gateway.controlUi.dangerouslyDisableDeviceAuth` switch used to stand in
 * for all of this; v2 made it inert, which is why the chat showed
 * "control ui requires device identity" the moment the gateway moved.
 *
 * Pure-JS crypto on purpose: ClawBox pages are served over plain HTTP on the
 * LAN, where `crypto.subtle` does not exist. @noble/ed25519 + @noble/hashes
 * are the same primitives OpenClaw's own Control UI relies on.
 *
 * The signed payload is OpenClaw's `buildDeviceAuthPayloadV3` — the exact
 * field order and normalization are copied from the installed gateway
 * (dist/device-auth-*.js on 2026.8.1) and verified against a live gateway
 * before this file was written:
 *   v3|deviceId|clientId|clientMode|role|scopes,csv|signedAtMs|token|nonce|platform|deviceFamily
 * The gateway recomputes this string from the connect params it received and
 * verifies the Ed25519 signature over it, so every value signed here must be
 * byte-identical to what the connect frame carries.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// noble's sync API needs the hash wired in once (subtle-free environments).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const STORAGE_KEY = "clawbox-gateway-device-identity-v1";

interface StoredIdentity {
  /** base64url raw 32-byte Ed25519 seeds/keys. */
  priv: string;
  pub: string;
}

function toB64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(value: string): Uint8Array {
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The browser's device identity, minted once and kept for ever: the gateway
 * pairs the PUBLIC key, so a new key would be a new device asking for a new
 * approval. Returns null where localStorage is unavailable (the identity
 * could not be kept, so pairing it would ask again on every load).
 */
function loadOrCreateIdentity(): { priv: Uint8Array; pub: Uint8Array } | null {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (typeof parsed?.priv === "string" && typeof parsed?.pub === "string") {
        const priv = fromB64u(parsed.priv);
        const pub = fromB64u(parsed.pub);
        // The pair must actually BE a pair: a half-corrupted store (one key
        // survives, the other does not) would otherwise sign challenges the
        // gateway can never verify, for ever, with no self-heal. A mismatch
        // falls through to minting a fresh identity — one new pairing beats
        // an unusable chat.
        if (priv.length === 32 && pub.length === 32
            && toB64u(ed.getPublicKey(priv)) === toB64u(pub)) {
          return { priv, pub };
        }
      }
    }
  } catch {
    /* fall through to minting a fresh one */
  }
  try {
    const priv = ed.utils.randomPrivateKey();
    const pub = ed.getPublicKey(priv);
    try {
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ priv: toB64u(priv), pub: toB64u(pub) } satisfies StoredIdentity));
    } catch {
      // Storage refused (private window, blocked site data): keep the
      // identity for THIS page load anyway. The device pairs afresh next
      // time — with loopback auto-approval that is invisible; without it,
      // one approval per visit still beats never connecting at all.
    }
    return { priv, pub };
  } catch {
    return null;
  }
}

/** OpenClaw's normalizeDeviceMetadataForAuth: trim, ASCII-lowercase, '' for non-strings. */
function normalizeMetadata(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export interface DeviceConnectParams {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

export interface DeviceConnectInput {
  /** From the connect.challenge event. Both required — an old gateway that
   *  sends no `ts` never checks device identity either. */
  nonce: unknown;
  ts: unknown;
  /** Must match the connect frame byte for byte. */
  token: string;
  role: string;
  scopes: readonly string[];
  clientId: string;
  clientMode: string;
  platform: string;
}

/**
 * The `device` object for the connect params, or null when it cannot be
 * built (no challenge timestamp — a pre-2026.8 gateway — or no storage for
 * the key). Null simply omits the field, which is the pre-v2 handshake.
 */
export function buildDeviceConnectParams(input: DeviceConnectInput): DeviceConnectParams | null {
  const nonce = typeof input.nonce === "string" && input.nonce ? input.nonce : null;
  const signedAt = typeof input.ts === "number" && Number.isFinite(input.ts) ? input.ts : null;
  if (!nonce || signedAt === null) return null;
  const identity = loadOrCreateIdentity();
  if (!identity) return null;
  try {
    const deviceId = bytesToHex(sha256(identity.pub));
    const payload = [
      "v3",
      deviceId,
      input.clientId,
      input.clientMode,
      input.role,
      input.scopes.join(","),
      String(signedAt),
      input.token ?? "",
      nonce,
      normalizeMetadata(input.platform),
      normalizeMetadata(undefined), // deviceFamily: ClawBox sends none
    ].join("|");
    const signature = ed.sign(new TextEncoder().encode(payload), identity.priv);
    return {
      id: deviceId,
      publicKey: toB64u(identity.pub),
      signature: toB64u(signature),
      signedAt,
      nonce,
    };
  } catch {
    return null;
  }
}
