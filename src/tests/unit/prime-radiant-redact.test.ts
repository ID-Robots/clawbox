/**
 * Every "secret" here is synthetic and assembled at run time, so no scanner
 * mistakes this file for a leak: documented example numbers (the 4111… test
 * card, the GB82 WEST… example IBAN) and keys made of repeated characters.
 */
import { describe, expect, it } from "vitest";
import {
  entropy,
  ibanValid,
  looksLikeUnixTimestamp,
  luhnValid,
  placeholder,
  redactPath,
  redactText,
  scanSecrets,
} from "@/lib/prime-radiant/redact";

const fakeKey = (prefix: string, body: string) => prefix + body;
const MIXED = "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";

describe("redaction", () => {
  it("replaces private keys whole", () => {
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA" + "x".repeat(40), "-----END RSA PRIVATE KEY-----"].join("\n"); // public-hygiene: allow synthetic redaction fixture
    const r = redactText(`before\n${pem}\nafter`);
    expect(r.text).toBe(`before\n${placeholder("PRIVATE_KEY")}\nafter`);
    expect(r.kinds).toEqual(["PRIVATE_KEY"]);
  });

  it("replaces provider key shapes", () => {
    const keys = [
      fakeKey("sk-", MIXED),
      fakeKey("sk-ant-", MIXED),
      fakeKey("gh" + "p_", MIXED),
      fakeKey("github_" + "pat_", MIXED),
      fakeKey("AKIA", "IOSFODNN7EXAMPLE"),
      fakeKey("xox" + "b-", "1234567890-abcdefghij"),
      fakeKey("sk_" + "live_", MIXED),
    ];
    for (const key of keys) {
      const r = redactText(`token ${key} end`);
      expect(r.text, key.slice(0, 8)).toBe(`token ${placeholder("API_KEY")} end`);
    }
  });

  it("keeps the key of a password pair and drops the value", () => {
    expect(redactText("password=Hunter22!").text).toBe(`password=${placeholder("PASSWORD")}`);
    expect(redactText('"passwd": "correct horse"').text).toBe(`"passwd": ${placeholder("PASSWORD")}`);
    expect(redactText("PWD: s3cret").text).toBe(`PWD: ${placeholder("PASSWORD")}`);
  });

  it("does not read policy prose as a password", () => {
    for (const prose of ["password: rotate", "password: required", "Password = none", "password: <your password>", "password: ****"]) {
      expect(redactText(prose).text, prose).toBe(prose);
    }
  });

  it("replaces generic high-entropy secrets in key=value form only", () => {
    expect(redactText(`client_secret = ${MIXED}`).text).toBe(`client_secret = ${placeholder("SECRET")}`);
    expect(redactText(`API_KEY="${MIXED}"`).text).toBe(`API_KEY=${placeholder("SECRET")}`);
    // low entropy, or no key name: left alone
    expect(redactText("auth_token = aaaaaaaaaaaaaaaaaaaa").text).toBe("auth_token = aaaaaaaaaaaaaaaaaaaa");
    expect(redactText(`build ${MIXED}`).text).toBe(`build ${MIXED}`);
    expect(entropy("aaaa")).toBe(0);
  });

  it("replaces IBANs that pass mod-97 and nothing else shaped like one", () => {
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(redactText("Pay to GB82 WEST 1234 5698 7654 32 today").text).toBe(`Pay to ${placeholder("IBAN")} today`);
    expect(redactText("Pay to GB82WEST12345698765432.").text).toBe(`Pay to ${placeholder("IBAN")}.`);
    expect(redactText("ref GB82 WEST 1234 5698 7654 33").kinds).not.toContain("IBAN");
  });

  it("replaces Luhn-valid card numbers with or without separators", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(redactText("card 4111 1111 1111 1111 exp").text).toBe(`card ${placeholder("CARD")} exp`);
    expect(redactText("card 4111-1111-1111-1111").text).toBe(`card ${placeholder("CARD")}`);
    expect(redactText("card 4111111111111111").text).toBe(`card ${placeholder("CARD")}`);
    expect(redactText("order 4111111111111112").kinds).not.toContain("CARD");
  });

  it("never mistakes a Unix timestamp for a card number", () => {
    // A millisecond timestamp that happens to pass Luhn.
    let ms = 1_760_000_000_000;
    while (!luhnValid(String(ms))) ms++;
    expect(looksLikeUnixTimestamp(String(ms))).toBe(true);
    expect(redactText(`at ${ms} the job ran`).text).toBe(`at ${ms} the job ran`);
    expect(looksLikeUnixTimestamp("1760000000")).toBe(true);
    expect(looksLikeUnixTimestamp("0000000001")).toBe(false);
    // The same digits WITH separators are written like a card, and redacted as one.
    const grouped = String(ms).replace(/^(\d{4})(\d{4})(\d{5})$/, "$1 $2 $3");
    expect(redactText(grouped).kinds).toContain("CARD");
    // A 13-digit card outside the timestamp range is still a card.
    expect(looksLikeUnixTimestamp("4222222222222")).toBe(false);
    expect(redactText("visa 4222222222222").kinds).toContain("CARD");
  });

  it("masks e-mail addresses and phone numbers unless asked not to", () => {
    const text = "Write to orders@example.com or call +44 20 7946 0958 or (555) 010-0199.";
    expect(redactText(text).text).toBe(`Write to ${placeholder("EMAIL")} or call ${placeholder("PHONE")} or ${placeholder("PHONE")}.`);
    expect(redactText(text, { maskEmails: false, maskPhones: false }).text).toBe(text);
  });

  it("leaves dates, versions and ordinary numbers alone", () => {
    const text = "Released 2026-10-14 as v4.3.0; 1,250 widgets at 12.50 each, order #40213, build 20261014.";
    expect(redactText(text).text).toBe(text);
  });

  it("is idempotent", () => {
    const once = redactText(`password=Hunter22! card 4111 1111 1111 1111 ${fakeKey("sk-", MIXED)} a@example.com`).text;
    expect(redactText(once).text).toBe(once);
    expect(scanSecrets(once)).toEqual([]);
  });

  it("scans for secrets without counting personal data unless asked", () => {
    expect(scanSecrets("mail a@example.com")).toEqual([]);
    expect(scanSecrets("mail a@example.com", { includePii: true })).toEqual(["EMAIL"]);
    expect(scanSecrets("card 4111 1111 1111 1111")).toEqual(["CARD"]);
  });

  it("redacts paths: the home folder and any segment", () => {
    expect(redactPath("/home/someone/Documents/acme.pdf").text).toBe("~/Documents/acme.pdf"); // public-hygiene: allow synthetic redaction fixture
    expect(redactPath("/Users/someone/x.md").text).toBe("~/x.md"); // public-hygiene: allow synthetic redaction fixture
    expect(redactPath("/srv/box/data/notes.md", { homeDir: "/srv/box" }).text).toBe("~/data/notes.md");
    const r = redactPath("/home/someone/invoices/orders@example.com/4111 1111 1111 1111.pdf"); // public-hygiene: allow synthetic redaction fixture
    expect(r.text).toBe(`~/invoices/${placeholder("EMAIL")}/${placeholder("CARD")}.pdf`);
    expect(r.kinds).toEqual(["CARD", "EMAIL"]);
  });
});
