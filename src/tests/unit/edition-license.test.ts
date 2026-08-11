import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyDualLicense } from "@/lib/edition-license";

/**
 * The key the verifier trusts is a module constant, and it stays one.
 *
 * The rule these pin: the answer comes from the embedded key and from nothing
 * the running device can set. The verifier reads the licence itself from the
 * environment and from disk — both writable by the account the service runs as
 * — so the key it checks that licence against is the one thing that has to be
 * fixed. It used to be `(process.env.CLAWBOX_LICENSE_PUBKEY || EMBEDDED)`, and
 * these hold that shape from coming back.
 *
 * Each case signs a licence with a key of its own and offers the matching
 * public key through every environment name the module has ever read, plus the
 * shapes that made the old expression fall through to a blank key.
 */

const ENV_KEYS = [
  "CLAWBOX_LICENSE_PUBKEY",
  "CLAWBOX_DUAL_LICENSE_PUBKEY",
  "CLAWBOX_LICENSE_PUBLIC_KEY",
];
const TOUCHED = [...ENV_KEYS, "CLAWBOX_DUAL_LICENSE", "CLAWBOX_ROOT", "CLAWBOX_DEVICE_ID"];

const saved = new Map<string, string | undefined>();
for (const name of TOUCHED) saved.set(name, process.env[name]);

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A licence in the module's format, signed by a freshly minted keypair. */
function mintLicence(payload: Record<string, unknown>) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = crypto.sign(null, payloadBuf, privateKey);
  return {
    licence: `${payloadBuf.toString("base64url")}.${signature.toString("base64url")}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

function perpetualDualLicence() {
  return mintLicence({ feature: "dual", iat: Math.floor(Date.now() / 1000) });
}

describe("verifyDualLicense", () => {
  it("does not accept a licence signed by a key named in the environment", () => {
    const { licence, publicKeyPem } = perpetualDualLicence();
    process.env.CLAWBOX_DUAL_LICENSE = licence;
    for (const name of ENV_KEYS) process.env[name] = publicKeyPem;

    expect(verifyDualLicense()).toBe(false);
  });

  it("does not accept a licence when the environment offers a blank key", () => {
    // The shapes that used to win a `||` and then reduce to an empty string,
    // which read as "nothing to verify against".
    const { licence } = perpetualDualLicence();
    process.env.CLAWBOX_DUAL_LICENSE = licence;

    for (const blank of [" ", "\t", "\n", "   \r\n  ", ""]) {
      for (const name of ENV_KEYS) process.env[name] = blank;
      expect(verifyDualLicense()).toBe(false);
    }
  });

  it("does not accept a licence read from disk and signed by an environment key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-licence-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const { licence, publicKeyPem } = perpetualDualLicence();
    fs.writeFileSync(path.join(root, "data", "dual-license.txt"), licence);

    delete process.env.CLAWBOX_DUAL_LICENSE;
    process.env.CLAWBOX_ROOT = root;
    for (const name of ENV_KEYS) process.env[name] = publicKeyPem;

    expect(verifyDualLicense()).toBe(false);
  });

  it("answers false when there is no licence at all", () => {
    delete process.env.CLAWBOX_DUAL_LICENSE;
    process.env.CLAWBOX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-licence-"));

    expect(verifyDualLicense()).toBe(false);
  });

  it("answers false for a licence that is not in the expected format", () => {
    process.env.CLAWBOX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-licence-"));
    for (const bad of ["", ".", "no-dot", ".leading", "trailing.", "a.b"]) {
      process.env.CLAWBOX_DUAL_LICENSE = bad;
      expect(verifyDualLicense()).toBe(false);
    }
  });
});
