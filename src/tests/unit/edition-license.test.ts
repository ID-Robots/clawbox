import { afterAll, afterEach, describe, expect, it } from "vitest";
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
 * public key through `CLAWBOX_LICENSE_PUBKEY` — the name the old expression
 * read — plus the shapes that made it fall through to a blank key.
 */

const PUBKEY_ENV = "CLAWBOX_LICENSE_PUBKEY";
const TOUCHED = [PUBKEY_ENV, "CLAWBOX_DUAL_LICENSE", "CLAWBOX_ROOT", "CLAWBOX_DEVICE_ID"];

const saved = new Map<string, string | undefined>();
for (const name of TOUCHED) saved.set(name, process.env[name]);

const tempRoots: string[] = [];
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-licence-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
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
    process.env[PUBKEY_ENV] = publicKeyPem;

    expect(verifyDualLicense()).toBe(false);
  });

  // The shapes that used to win a `||` and then reduce to an empty string,
  // which read as "nothing to verify against".
  it.each([
    ["a single space", " "],
    ["a tab", "\t"],
    ["a newline", "\n"],
    ["mixed whitespace", "   \r\n  "],
    ["an empty string", ""],
  ])("does not accept a licence when the environment offers %s as the key", (_label, blank) => {
    const { licence } = perpetualDualLicence();
    process.env.CLAWBOX_DUAL_LICENSE = licence;
    process.env[PUBKEY_ENV] = blank;

    expect(verifyDualLicense()).toBe(false);
  });

  it("does not accept a licence read from disk and signed by an environment key", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const { licence, publicKeyPem } = perpetualDualLicence();
    fs.writeFileSync(path.join(root, "data", "dual-license.txt"), licence);

    delete process.env.CLAWBOX_DUAL_LICENSE;
    process.env.CLAWBOX_ROOT = root;
    process.env[PUBKEY_ENV] = publicKeyPem;

    expect(verifyDualLicense()).toBe(false);
  });

  it("answers false when there is no licence at all", () => {
    delete process.env.CLAWBOX_DUAL_LICENSE;
    process.env.CLAWBOX_ROOT = tempRoot();

    expect(verifyDualLicense()).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["a bare separator", "."],
    ["no separator", "no-dot"],
    ["nothing before the separator", ".leading"],
    ["nothing after the separator", "trailing."],
    ["two parts that are not a signed payload", "a.b"],
  ])("answers false for a licence that is %s", (_label, bad) => {
    process.env.CLAWBOX_ROOT = tempRoot();
    process.env.CLAWBOX_DUAL_LICENSE = bad;

    expect(verifyDualLicense()).toBe(false);
  });
});
