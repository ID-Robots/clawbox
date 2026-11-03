import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildCsr, createCa, generatePrivateKeyPem, issueCertificate, parseCsr } from "@/lib/local-https-x509";
import { DAY, HOST, testCa } from "@/tests/helpers/local-https";

/**
 * The hand-built DER Local HTTPS sends the portal (a PKCS#10 request) and the
 * stub portal's certificates. Read back by Node's own X509 parser and, where
 * the machine has one, by openssl — an independent reader of the same bytes.
 */

// openssl is started as a real process to read the bytes back.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-https-x509-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("buildCsr / parseCsr", () => {
  it("names exactly the one host and proves the key", () => {
    const key = generatePrivateKeyPem();
    const csr = buildCsr(key, HOST);
    expect(csr).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n/);
    const parsed = parseCsr(csr);
    expect(parsed.dnsNames).toEqual([HOST]);
    const expected = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
    expect(parsed.publicKey.export({ type: "spki", format: "der" }).equals(expected)).toBe(true);
  });

  it("uses an ECDSA P-256 key the private key never leaves", () => {
    const key = generatePrivateKeyPem();
    expect(crypto.createPrivateKey(key).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(buildCsr(key, HOST)).not.toContain("PRIVATE KEY");
  });

  it("refuses a request whose signature does not verify", () => {
    const csr = buildCsr(generatePrivateKeyPem(), HOST);
    const der = Buffer.from(csr.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
    // Flip a byte of the hostname inside the signed part.
    const at = der.indexOf(Buffer.from(HOST));
    der[at] ^= 0x01;
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString("base64")}\n-----END CERTIFICATE REQUEST-----\n`;
    expect(() => parseCsr(tampered)).toThrow(/signature/);
  });

  it("refuses what is not a CSR at all", () => {
    expect(() => parseCsr("hello")).toThrow();
    expect(() => parseCsr("-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n")).toThrow();
  });

  it.skipIf(!hasOpenssl())("is a request openssl verifies, for the same name", () => {
    const file = path.join(tmp, "req.csr");
    fs.writeFileSync(file, buildCsr(generatePrivateKeyPem(), HOST));
    const out = execFileSync("openssl", ["req", "-in", file, "-noout", "-verify", "-text"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain(`DNS:${HOST}`);
    expect(out).toContain("ecdsa-with-SHA256");
  });
});

describe("issueCertificate", () => {
  it("issues a server certificate for the CSR's key that chains to its CA", () => {
    const ca = testCa();
    const key = generatePrivateKeyPem();
    const now = Date.now();
    const leaf = new crypto.X509Certificate(
      issueCertificate({
        subjectPublicKey: parseCsr(buildCsr(key, HOST)).publicKey,
        commonName: HOST,
        dnsName: HOST,
        notBefore: new Date(now - 1000),
        notAfter: new Date(now + 90 * DAY),
        issuer: { commonName: ca.name, privateKeyPem: ca.keyPem },
      }),
    );
    const caCert = new crypto.X509Certificate(ca.certPem);
    expect(leaf.checkHost(HOST)).toBe(HOST);
    expect(leaf.checkHost(`x.${HOST}`)).toBeUndefined();
    expect(leaf.checkPrivateKey(crypto.createPrivateKey(key))).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(caCert.ca).toBe(true);
    expect(leaf.checkIssued(caCert)).toBe(true);
    expect(leaf.verify(caCert.publicKey)).toBe(true);
    expect(Date.parse(leaf.validTo) - now).toBeGreaterThan(89 * DAY);
  });

  it("writes GeneralizedTime from 2050 on", () => {
    const key = generatePrivateKeyPem();
    const cert = new crypto.X509Certificate(
      issueCertificate({
        subjectPublicKey: crypto.createPublicKey(key),
        commonName: "far",
        notBefore: new Date("2049-12-31T00:00:00Z"),
        notAfter: new Date("2051-01-01T00:00:00Z"),
        selfPrivateKeyPem: key,
      }),
    );
    expect(Date.parse(cert.validTo)).toBe(Date.parse("2051-01-01T00:00:00Z"));
    expect(Date.parse(cert.validFrom)).toBe(Date.parse("2049-12-31T00:00:00Z"));
  });

  it("needs a signer", () => {
    const key = generatePrivateKeyPem();
    expect(() =>
      issueCertificate({ subjectPublicKey: crypto.createPublicKey(key), commonName: "x", notBefore: new Date(), notAfter: new Date() }),
    ).toThrow(/issuer/);
  });

  it.skipIf(!hasOpenssl())("is a chain openssl verifies", () => {
    const ca = createCa("openssl check CA", new Date(Date.now() - DAY), new Date(Date.now() + DAY));
    const key = generatePrivateKeyPem();
    fs.writeFileSync(path.join(tmp, "ca.pem"), ca.certPem);
    fs.writeFileSync(
      path.join(tmp, "leaf.pem"),
      issueCertificate({
        subjectPublicKey: crypto.createPublicKey(key),
        commonName: HOST,
        dnsName: HOST,
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + DAY),
        issuer: { commonName: "openssl check CA", privateKeyPem: ca.keyPem },
      }),
    );
    const out = execFileSync("openssl", ["verify", "-purpose", "sslserver", "-CAfile", path.join(tmp, "ca.pem"), path.join(tmp, "leaf.pem")], {
      encoding: "utf-8",
    });
    expect(out.trim()).toMatch(/: OK$/);
  });
});
