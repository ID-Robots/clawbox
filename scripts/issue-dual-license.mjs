#!/usr/bin/env node
// Mint a ClawBox "dual" premium license. Run this OFF-DEVICE with the private
// signing key (never ship the key to a device or commit it). The device only
// carries the matching PUBLIC key (src/lib/edition-license.ts) and verifies.
//
// Usage:
//   node scripts/issue-dual-license.mjs --key /path/to/dual-license-private.pem \
//        [--device <deviceId>] [--days <N>]
//
// Prints the license string. Install it on the device as data/dual-license.txt
// (or set CLAWBOX_DUAL_LICENSE) to unlock the switcher on a `dual` edition.
import crypto from "node:crypto";
import fs from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const keyPath = arg("key");
if (!keyPath) {
  console.error("error: --key <private-key.pem> is required");
  process.exit(1);
}
const device = arg("device");
const daysRaw = arg("days");

// --days is optional, but when it IS given it has to be a real, positive number
// of days. `Number("30d")` is NaN, and a NaN expiry does not survive
// JSON.stringify as a number — so an unchecked value here quietly produces a
// licence with no usable expiry at all while the operator believes one was set.
// Refuse the value instead of minting something that does not match the intent.
let days;
if (daysRaw !== undefined) {
  days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`error: --days must be a positive number (got ${JSON.stringify(daysRaw)})`);
    process.exit(1);
  }
}

const payload = {
  feature: "dual",
  iat: Math.floor(Date.now() / 1000),
  ...(days !== undefined ? { exp: Math.floor(Date.now() / 1000) + days * 86400 } : {}),
  ...(device ? { deviceId: device } : {}),
};

const payloadBuf = Buffer.from(JSON.stringify(payload));
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8"));
const sig = crypto.sign(null, payloadBuf, privateKey); // ed25519: algorithm = null
const license = `${payloadBuf.toString("base64url")}.${sig.toString("base64url")}`;

console.error(`Issued dual license: ${JSON.stringify(payload)}`);
console.log(license);
