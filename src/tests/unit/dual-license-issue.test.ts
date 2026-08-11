import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isLicensePayloadValid } from "@/lib/edition-license";

/**
 * The minting tool and the verifier have to agree on what an expiry IS.
 *
 * `--days` reaches the payload through `Number()`, which turns anything that
 * is not a number into NaN — and a NaN expiry does not survive JSON as one.
 * So an unchecked argument produced a correctly signed licence whose expiry
 * the device could not read, while the operator believed a term had been set.
 * These pin both ends: the tool refuses the argument, and the verifier refuses
 * a payload whose `exp` is present but not a usable timestamp.
 */

const SCRIPT = path.join(process.cwd(), "scripts", "issue-dual-license.mjs");

/** A throwaway ed25519 private key on disk, so the tool gets past --key. */
function writeTempKey(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-license-"));
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const file = path.join(dir, "private.pem");
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  return file;
}

function issue(args: string[]) {
  return spawnSync("node", [SCRIPT, "--key", writeTempKey(), ...args], { encoding: "utf-8" });
}

describe("issue-dual-license --days", () => {
  it("refuses a non-numeric term", () => {
    const run = issue(["--days", "abc"]);
    expect(run.status).not.toBe(0);
    expect(run.stdout.trim()).toBe("");
    expect(run.stderr).toContain("--days");
  });

  it("refuses a term that looks numeric but is not", () => {
    // The realistic slip: a unit suffix on an otherwise sensible number.
    const run = issue(["--days", "30d"]);
    expect(run.status).not.toBe(0);
    expect(run.stdout.trim()).toBe("");
  });

  it("refuses a zero or negative term rather than minting an already-dead licence", () => {
    expect(issue(["--days", "0"]).status).not.toBe(0);
    expect(issue(["--days", "-5"]).status).not.toBe(0);
  });

  it("still mints on a valid term, with an expiry the verifier can read", () => {
    const run = issue(["--days", "30"]);
    expect(run.status).toBe(0);

    const [payloadB64] = run.stdout.trim().split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    expect(typeof payload.exp).toBe("number");
    expect(Number.isFinite(payload.exp)).toBe(true);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("still mints a perpetual licence when no term is given", () => {
    const run = issue([]);
    expect(run.status).toBe(0);
    const [payloadB64] = run.stdout.trim().split(".");
    expect(JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")).exp).toBeUndefined();
  });
});

describe("licence payload expiry rules", () => {
  const NOW = 1_800_000_000;

  it("accepts a payload with no expiry", () => {
    expect(isLicensePayloadValid({ feature: "dual" }, NOW)).toBe(true);
  });

  it("accepts an expiry in the future", () => {
    expect(isLicensePayloadValid({ feature: "dual", exp: NOW + 60 }, NOW)).toBe(true);
  });

  it("rejects an expiry that has passed", () => {
    expect(isLicensePayloadValid({ feature: "dual", exp: NOW - 1 }, NOW)).toBe(false);
    expect(isLicensePayloadValid({ feature: "dual", exp: NOW }, NOW)).toBe(false);
  });

  it("rejects a present-but-unreadable expiry instead of treating it as absent", () => {
    // Each of these is what an unvalidated term leaves behind. Skipping the
    // expiry check for them is the difference between a term and no term.
    for (const exp of [NaN, Infinity, -Infinity]) {
      expect(isLicensePayloadValid({ feature: "dual", exp }, NOW)).toBe(false);
    }
    type Payload = Parameters<typeof isLicensePayloadValid>[0];
    for (const exp of [null, "30", "", {}, []] as unknown[]) {
      expect(isLicensePayloadValid({ feature: "dual", exp } as unknown as Payload, NOW)).toBe(false);
    }
  });

  it("rejects a payload for a different feature", () => {
    expect(isLicensePayloadValid({ feature: "something-else" }, NOW)).toBe(false);
    expect(isLicensePayloadValid({}, NOW)).toBe(false);
  });
});
