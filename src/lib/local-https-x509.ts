/**
 * The few X.509 structures Local HTTPS needs, built with `crypto` alone.
 *
 * The box makes its own key and hands the portal only a certificate signing
 * request (PKCS#10), so the private key never leaves it. Node can sign and
 * parse certificates but cannot BUILD a CSR, and the box must not depend on an
 * `openssl` binary or a new package for one, so this file writes the DER by
 * hand: a CSR for one DNS name (ECDSA P-256 / SHA-256, what Let's Encrypt
 * issues for), and — for the stub portal and the tests only — a certificate
 * issued from such a request by a CA of our own.
 *
 * See docs/design/local-https.md for where each of these travels.
 */

import crypto from "crypto";

// ── DER ──

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, value: Buffer) => tlv(0xa0 | n, value);
const octetString = (value: Buffer) => tlv(0x04, value);
const bitString = (value: Buffer, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
const utf8String = (value: string) => tlv(0x0c, Buffer.from(value, "utf8"));
const TRUE = tlv(0x01, Buffer.from([0xff]));

function objectId(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A non-negative INTEGER from its big-endian magnitude. */
function integer(magnitude: Buffer): Buffer {
  let value = magnitude;
  while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

function time(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  // RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
  return year < 2050 ? tlv(0x17, Buffer.from(`${String(year).slice(2)}${rest}`)) : tlv(0x18, Buffer.from(`${year}${rest}`));
}

const OID = {
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

const SIGNATURE_ALGORITHM = sequence(objectId(OID.ecdsaWithSha256));

function name(commonName: string): Buffer {
  return sequence(set(sequence(objectId(OID.commonName), utf8String(commonName))));
}

function extension(oid: string, value: Buffer, critical = false): Buffer {
  return sequence(objectId(oid), ...(critical ? [TRUE] : []), octetString(value));
}

function subjectAltName(dnsName: string): Buffer {
  // GeneralName dNSName is [2] IMPLICIT IA5String.
  return extension(OID.subjectAltName, sequence(tlv(0x82, Buffer.from(dnsName, "ascii"))));
}

function sign(data: Buffer, privateKey: crypto.KeyObject): Buffer {
  return crypto.sign("sha256", data, privateKey);
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function fromPem(label: string, pem: string): Buffer {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  if (!match) throw new Error(`not a PEM ${label.toLowerCase()}`);
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

// ── A DER reader just deep enough for a CSR ──

interface Node {
  tag: number;
  /** The whole TLV, header included. */
  raw: Buffer;
  /** The contents. */
  value: Buffer;
}

function readNode(buf: Buffer, offset: number): Node & { end: number } {
  if (offset + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[offset];
  let length = buf[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > buf.length) throw new Error("bad DER length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[offset + 2 + i];
    header += count;
  }
  const end = offset + header + length;
  if (end > buf.length) throw new Error("truncated DER");
  return { tag, raw: buf.subarray(offset, end), value: buf.subarray(offset + header, end), end };
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (let offset = 0; offset < node.value.length; ) {
    const child = readNode(node.value, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

function decodeObjectId(node: Node): string {
  const bytes = node.value;
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

// ── What the rest of the feature calls ──

/** A fresh ECDSA P-256 private key, PKCS#8 PEM. */
export function generatePrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** A PKCS#10 request for exactly one DNS name (CN and the only SAN), signed with `privateKeyPem`. */
export function buildCsr(privateKeyPem: string, dnsName: string): string {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const spki = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const requestInfo = sequence(
    integer(Buffer.from([0])),
    name(dnsName),
    spki,
    // attributes [0] IMPLICIT SET OF Attribute
    tlv(0xa0, sequence(objectId(OID.extensionRequest), set(sequence(subjectAltName(dnsName))))),
  );
  const csr = sequence(requestInfo, SIGNATURE_ALGORITHM, bitString(sign(requestInfo, privateKey)));
  return toPem("CERTIFICATE REQUEST", csr);
}

export interface ParsedCsr {
  publicKey: crypto.KeyObject;
  /** Every dNSName in the request's subjectAltName extension. */
  dnsNames: string[];
}

/**
 * Read a CSR and check its self-signature. What the portal does before it asks
 * for a certificate: the request must prove possession of its key and name
 * nothing but the box's own hostname. Throws on anything malformed.
 */
export function parseCsr(pem: string): ParsedCsr {
  const der = fromPem("CERTIFICATE REQUEST", pem);
  const root = readNode(der, 0);
  if (root.end !== der.length) throw new Error("trailing bytes after the CSR");
  const [requestInfo, , signature] = children(root);
  if (!requestInfo || !signature || signature.tag !== 0x03) throw new Error("not a CSR");
  const [, , spki, attributes] = children(requestInfo);
  if (!spki) throw new Error("CSR has no public key");
  const publicKey = crypto.createPublicKey({ key: spki.raw, format: "der", type: "spki" });
  if (!crypto.verify("sha256", requestInfo.raw, publicKey, signature.value.subarray(1))) {
    throw new Error("CSR signature does not verify");
  }
  const dnsNames: string[] = [];
  for (const attribute of attributes ? children(attributes) : []) {
    const [type, values] = children(attribute);
    if (!type || decodeObjectId(type) !== OID.extensionRequest || !values) continue;
    for (const extensions of children(values)) {
      for (const ext of children(extensions)) {
        const parts = children(ext);
        if (decodeObjectId(parts[0]) !== OID.subjectAltName) continue;
        const generalNames = readNode(parts[parts.length - 1].value, 0);
        for (const gn of children(generalNames)) {
          if (gn.tag === 0x82) dnsNames.push(gn.value.toString("ascii"));
        }
      }
    }
  }
  return { publicKey, dnsNames };
}

export interface IssueOptions {
  /** The key the certificate certifies. */
  subjectPublicKey: crypto.KeyObject;
  commonName: string;
  /** Present for a server certificate: its one SAN. */
  dnsName?: string;
  isCa?: boolean;
  notBefore: Date;
  notAfter: Date;
  /** The signer. Absent: self-signed with `selfPrivateKey`. */
  issuer?: { commonName: string; privateKeyPem: string };
  selfPrivateKeyPem?: string;
}

/**
 * A v3 certificate. Used by the STUB portal (a CA of the box's own, trusted
 * only while `CLAWBOX_LOCAL_HTTPS_PORTAL=stub`) and by tests — never to
 * produce what a browser is meant to trust.
 */
export function issueCertificate(opts: IssueOptions): string {
  const signerPem = opts.issuer?.privateKeyPem ?? opts.selfPrivateKeyPem;
  if (!signerPem) throw new Error("issueCertificate needs an issuer or a self-signing key");
  const signer = crypto.createPrivateKey(signerPem);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const extensions: Buffer[] = [];
  if (opts.isCa) {
    extensions.push(extension(OID.basicConstraints, sequence(TRUE), true));
    // keyCertSign (bit 5) | cRLSign (bit 6) → 0b0000_0110, one unused bit.
    extensions.push(extension(OID.keyUsage, bitString(Buffer.from([0x06]), 1), true));
  } else {
    extensions.push(extension(OID.basicConstraints, sequence(), true));
    // digitalSignature (bit 0) → 0b1000_0000, seven unused bits.
    extensions.push(extension(OID.keyUsage, bitString(Buffer.from([0x80]), 7), true));
    extensions.push(extension(OID.extKeyUsage, sequence(objectId(OID.serverAuth))));
  }
  if (opts.dnsName) extensions.push(subjectAltName(opts.dnsName));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    SIGNATURE_ALGORITHM,
    name(opts.issuer?.commonName ?? opts.commonName),
    sequence(time(opts.notBefore), time(opts.notAfter)),
    name(opts.commonName),
    opts.subjectPublicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(...extensions)),
  );
  return toPem("CERTIFICATE", sequence(tbs, SIGNATURE_ALGORITHM, bitString(sign(tbs, signer))));
}

/** A self-signed CA: its certificate and key, both PEM. */
export function createCa(commonName: string, notBefore: Date, notAfter: Date): { certPem: string; keyPem: string } {
  const keyPem = generatePrivateKeyPem();
  const certPem = issueCertificate({
    subjectPublicKey: crypto.createPublicKey(keyPem),
    commonName,
    isCa: true,
    notBefore,
    notAfter,
    selfPrivateKeyPem: keyPem,
  });
  return { certPem, keyPem };
}
