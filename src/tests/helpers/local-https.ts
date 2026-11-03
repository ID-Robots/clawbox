import crypto from "crypto";
import fs from "fs";
import path from "path";

import { createCa, generatePrivateKeyPem, issueCertificate } from "@/lib/local-https-x509";

/**
 * Local HTTPS fixtures: a CA of the test's own, server certificates it issues,
 * and the data/local-https/ files the box writes — all under a temp root.
 */

export const HOST = "k3x9q2m7v4t8p1rz.lan.clawbox.com";
export const OTHER_HOST = "aaaabbbbccccdddd.lan.clawbox.com";
export const DAY = 24 * 3600 * 1000;

export interface TestCa {
  name: string;
  certPem: string;
  keyPem: string;
}

export function testCa(name = "Local HTTPS test CA", now = Date.now()): TestCa {
  return { name, ...createCa(name, new Date(now - DAY), new Date(now + 365 * DAY)) };
}

export function leafFor(
  ca: TestCa,
  opts: { hostname?: string; keyPem?: string; notBefore?: number; notAfter?: number } = {},
): { keyPem: string; certPem: string; chainPem: string } {
  const now = Date.now();
  const keyPem = opts.keyPem ?? generatePrivateKeyPem();
  const certPem = issueCertificate({
    subjectPublicKey: crypto.createPublicKey(keyPem),
    commonName: opts.hostname ?? HOST,
    dnsName: opts.hostname ?? HOST,
    notBefore: new Date(opts.notBefore ?? now - 60_000),
    notAfter: new Date(opts.notAfter ?? now + 90 * DAY),
    issuer: { commonName: ca.name, privateKeyPem: ca.keyPem },
  });
  return { keyPem, certPem, chainPem: certPem + ca.certPem };
}

export function localHttpsDirOf(root: string): string {
  return path.join(root, "data", "local-https");
}

export function writeStateFile(root: string, state: Record<string, unknown>): void {
  fs.mkdirSync(localHttpsDirOf(root), { recursive: true });
  fs.writeFileSync(path.join(localHttpsDirOf(root), "state.json"), JSON.stringify(state));
}

export function writeTlsFile(root: string, tls: { hostname: string; key: string; cert: string }): void {
  fs.mkdirSync(localHttpsDirOf(root), { recursive: true });
  fs.writeFileSync(path.join(localHttpsDirOf(root), "tls.json"), JSON.stringify(tls), { mode: 0o600 });
}

/** Trust `ca` the way the stub portal's CA is trusted: stub-ca.pem plus `stubPortal: true`. */
export function writeStubCa(root: string, ca: TestCa): void {
  fs.mkdirSync(localHttpsDirOf(root), { recursive: true });
  fs.writeFileSync(path.join(localHttpsDirOf(root), "stub-ca.pem"), ca.certPem);
}
