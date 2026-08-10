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
// Until we generate the keypair and drop the real public key below (+ start
// issuing licenses), DUAL_LICENSE_PUBKEY stays empty and verifyDualLicense()
// returns false — so dual is locked everywhere by default, which is the safe
// posture (single-harness editions never call this).

import crypto from "crypto";
import fs from "fs";
import path from "path";

// PEM SPKI ed25519 public key. EMPTY until productionized. While empty,
// licensing is NOT ENFORCED — dual stays open (today's behavior) so existing
// installs aren't disrupted. Once we generate the keypair and paste the public
// key here (or set CLAWBOX_LICENSE_PUBKEY), dual becomes license-gated.
const DUAL_LICENSE_PUBKEY = (process.env.CLAWBOX_LICENSE_PUBKEY || "").trim();

/** True once a signing public key is configured, i.e. dual-license enforcement
 *  is turned on. Until then dual is unlocked without a license. */
export function isDualLicenseEnforced(): boolean {
  return DUAL_LICENSE_PUBKEY.length > 0;
}

interface LicensePayload {
  feature?: string;
  iat?: number;
  exp?: number;
  deviceId?: string;
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
  if (!DUAL_LICENSE_PUBKEY) return false; // licensing not wired yet → locked
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
    if (payload.feature !== "dual") return false;
    if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) {
      return false;
    }
    // Optional device binding: if the license names a device, it must match.
    if (payload.deviceId) {
      const deviceId = (process.env.CLAWBOX_DEVICE_ID || "").trim();
      if (!deviceId || deviceId !== payload.deviceId) return false;
    }
    return true;
  } catch {
    return false;
  }
}
