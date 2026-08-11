// Premium "dual harness" license gate.
//
// The dual edition (both harnesses + the runtime switcher) is a paid feature.
// Setting CLAWBOX_EDITION=dual is NOT enough — the switcher only unlocks when a
// license WE signed verifies against the embedded ED25519 public key. The
// private signing key never ships on a device, so a customer can't forge or
// extract a working code from the image.
//
// License format: `<base64url(payloadJSON)>.<base64url(ed25519 signature)>`,
// supplied via env CLAWBOX_DUAL_LICENSE or the file data/dual-license.txt.
// payload = { feature: "dual", iat: <unix>, exp?: <unix>, deviceId?: <string> }.
//
// The keypair exists and the real public key is embedded below, so licensing is
// live: verifyDualLicense() enforces it, and dual stays locked until a licence
// we signed verifies. A missing or unverifiable licence keeps the device locked,
// which is the safe posture (single-harness editions never call this).

import crypto from "crypto";
import fs from "fs";
import path from "path";

// PEM SPKI ed25519 PUBLIC key for the dual-harness premium license. Safe to
// ship — it can only VERIFY licenses, never mint them (the private signing key
// lives off-device and is never committed).
//
// NOT overridable from the environment. It used to be
// `(process.env.CLAWBOX_LICENSE_PUBKEY || EMBEDDED).trim()`, which was a
// licence bypass on a device the customer has a shell on: a WHITESPACE-only
// value wins the `||` (a non-empty string is truthy), `.trim()` then reduces it
// to "", enforcement reads as "off", and dual unlocked with no licence at all.
// And the env var was directly settable — /home/clawbox/clawbox/.env is
// clawbox-owned and loaded by clawbox-setup.service. A trust anchor must not be
// replaceable by the party it is meant to constrain.
const DUAL_LICENSE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWZcFqaHm1SfUH/6Mjh6bpxwQvjnZfsPZK9gBt8fiz+E=
-----END PUBLIC KEY-----`.trim();

/** True once a signing public key is configured. Kept for diagnostics/tests:
 *  callers must NOT treat "not enforced" as "unlocked" — a missing key means
 *  we cannot verify anything, which is a reason to stay LOCKED, not to open up
 *  (see isDualUnlocked in src/lib/harness.ts). */
export function isDualLicenseEnforced(): boolean {
  return DUAL_LICENSE_PUBKEY.length > 0;
}

export interface LicensePayload {
  feature?: string;
  iat?: number;
  exp?: number;
  deviceId?: string;
}

/**
 * Field-level checks applied to a licence payload AFTER its signature has been
 * verified. Exported so the rules can be exercised directly.
 *
 * `exp` is optional — a licence without one is perpetual by design. But when
 * the field is PRESENT it has to be a finite number: an absent `exp` and an
 * `exp` we cannot read as a timestamp are different things, and treating the
 * second as the first would skip the expiry check entirely. Anything present
 * and not finite (null, a string, NaN) is rejected outright.
 */
export function isLicensePayloadValid(payload: LicensePayload, nowSec: number): boolean {
  if (payload.feature !== "dual") return false;

  if (payload.exp !== undefined) {
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return false;
    if (payload.exp <= nowSec) return false;
  }

  // Optional device binding: if the license names a device, it must match.
  if (payload.deviceId) {
    const deviceId = (process.env.CLAWBOX_DEVICE_ID || "").trim();
    if (!deviceId || deviceId !== payload.deviceId) return false;
  }
  return true;
}

function readLicenseString(): string | null {
  const env = process.env.CLAWBOX_DUAL_LICENSE?.trim();
  if (env) return env;
  try {
    const root = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
    const raw = fs.readFileSync(path.join(root, "data", "dual-license.txt"), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Verify the dual-harness premium license. Returns true only when a genuine,
 * unexpired license signed by our private key is present. Fails closed on any
 * error (missing key, bad format, bad signature, expired).
 */
export function verifyDualLicense(): boolean {
  if (!DUAL_LICENSE_PUBKEY) return false; // nothing to verify against → locked
  const license = readLicenseString();
  if (!license) return false;

  const dot = license.indexOf(".");
  if (dot <= 0 || dot === license.length - 1) return false;
  const payloadB64 = license.slice(0, dot);
  const sigB64 = license.slice(dot + 1);

  try {
    const payloadBuf = Buffer.from(payloadB64, "base64url");
    const sigBuf = Buffer.from(sigB64, "base64url");
    const key = crypto.createPublicKey(DUAL_LICENSE_PUBKEY);
    // ed25519: algorithm arg must be null.
    if (!crypto.verify(null, payloadBuf, key, sigBuf)) return false;

    const payload = JSON.parse(payloadBuf.toString("utf8")) as LicensePayload;
    return isLicensePayloadValid(payload, Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}
