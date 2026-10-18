/**
 * Every "secret" here is synthetic and assembled at run time, so no scanner
 * mistakes this file for a leak: documented example numbers (the 4111… test
 * card, the GB82 WEST… example IBAN) and keys made of repeated characters.
 */
import { describe, expect, it } from "vitest";
import {
  entropy,
  IBAN_LENGTHS,
  ibanValid,
  looksLikeUnixTimestamp,
  luhnValid,
  placeholder,
  redactPath,
  redactText,
  scanSecrets,
} from "@/lib/prime-radiant/redact";
import { safeUploadName } from "@/lib/prime-radiant/ingest-upload";

const fakeKey = (prefix: string, body: string) => prefix + body;
const MIXED = "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";

const IBAN_DIGITS = "0123456789";
/** No vowels: random letters never spell "IBAN", or a word another pattern reads. */
const IBAN_LETTERS = "BCDFGHJKLMNPRSTVWXZ";

/** A deterministic pick in [0, n), so a generated page is the same on every run. */
function picker(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 2 ** 32) * n);
  };
}

/** `cc`, check digits and `bban`: a valid IBAN, or with `ok` false check digits one off (mod-97 leaves 2, never 1). */
function withCheckDigits(cc: string, bban: string, ok = true): string {
  let rem = 0;
  for (const ch of `${bban}${cc}00`) {
    const code = ch.charCodeAt(0);
    for (const d of code >= 65 ? String(code - 55) : ch) rem = (rem * 10 + Number(d)) % 97;
  }
  return `${cc}${String(98 - rem + (ok ? 0 : 1)).padStart(2, "0")}${bban}`;
}

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

  it("replaces IBANs that pass mod-97, and nothing else shaped like one", () => {
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(redactText("Pay to GB82 WEST 1234 5698 7654 32 today").text).toBe(`Pay to ${placeholder("IBAN")} today`);
    expect(redactText("Pay to GB82WEST12345698765432.").text).toBe(`Pay to ${placeholder("IBAN")}.`);
    // Too short for a British IBAN, or an unregistered country with bad check digits: not one.
    expect(redactText("ref GB82 WEST 1234 5698 7654").kinds).not.toContain("IBAN");
    expect(redactText("code XX12345678901234567890 here").kinds).not.toContain("IBAN");
    expect(redactText("AT12 ORDER NUMBER FOR THE CLIENT").kinds).not.toContain("IBAN");
  });

  // The live import: an unspaced Bulgarian IBAN came out as "BG80BNBG[REDACTED:CARD]".
  it("replaces a whole IBAN, spaced or not, and never masks its account part as a card", () => {
    const bg = ["BG80", "BNBG", "9661", "1020", "3456", "78"];
    const unspaced = bg.join("");
    const spaced = bg.join(" ");
    const whole = `IBAN: ${placeholder("IBAN")}.`;
    expect(redactText(`IBAN: ${unspaced}.`).text).toBe(whole);
    expect(redactText(`IBAN: ${spaced}.`).text).toBe(whole);
    expect(redactText(`IBAN: BG80BNBG 9661 1020 3456 78.`).text).toBe(whole);
    // Run into the word before it, or the one after it, as extracted PDF text does.
    expect(redactText(`IBAN${unspaced}`).text).toBe(`IBAN${placeholder("IBAN")}`);
    expect(redactText(`${unspaced}EUR`).text).toBe(`${placeholder("IBAN")}EUR`);
    expect(redactText(`${spaced} BIC BNBGBGSD`).text).toBe(`${placeholder("IBAN")} BIC BNBGBGSD`);
    // Two side by side are two.
    const two = redactText(`${unspaced} GB82WEST12345698765432 done`);
    expect(two.text).toBe(`${placeholder("IBAN")} ${placeholder("IBAN")} done`);
    expect(two.counts.IBAN).toBe(2);
    // Mistyped check digits: still an account number of exactly the Bulgarian shape.
    const typo = redactText(`${unspaced.slice(0, -1)}9 and ${spaced.slice(0, -1)}9`);
    expect(typo.text).toBe(`${placeholder("IBAN")} and ${placeholder("IBAN")}`);
    expect(typo.kinds).toEqual(["IBAN"]);
    // An IBAN-shaped word that is no IBAN keeps its digits: half of it masked as a card would read as safe.
    expect(redactText("BG80BNBG4111111111111111").text).toBe("BG80BNBG4111111111111111");
    // Digits glued to a word are part of that word (a code, a hash), not a card standing alone.
    expect(redactText("card4111111111111111").kinds).not.toContain("CARD");
    expect(redactText("card:4111111111111111").text).toBe(`card:${placeholder("CARD")}`);
    expect(redactText(`IBAN ${unspaced}, card 4111 1111 1111 1111`).kinds).toEqual(["IBAN", "CARD"]);
  });

  // Where an IBAN ends is tried at every length from the longest down; a page
  // of IBAN-shaped runs must stay quick and come out run by run as it always did.
  it("redacts a page of IBAN-shaped runs quickly, each where its IBAN ends", () => {
    const pick = picker(1195);
    const from = (chars: string) => chars[pick(chars.length)];
    const many = (chars: string, n: number) => Array.from({ length: n }, () => from(chars)).join("");
    // Digits with a letter every fourth character: never 13 digits in a row, which a card would be.
    const kindAt = (i: number) => ((i - 4) % 4 === 3 ? IBAN_LETTERS : IBAN_DIGITS);
    const body = (n: number) => Array.from({ length: n }, (_, i) => from(kindAt(i + 4))).join("");
    // `compact` grown by `n` characters, each chosen so that no prefix of 15 or more passes mod-97.
    const growInvalid = (compact: string, n: number) => {
      let s = compact;
      for (let i = 0; i < n; i++) {
        const chars = kindAt(s.length);
        let ch = from(chars);
        while (ibanValid(s + ch)) ch = chars[(chars.indexOf(ch) + 1) % chars.length];
        s += ch;
      }
      return s;
    };
    const fours = (compact: string) => compact.replace(/(.{4})(?=.)/g, "$1 ");
    const singles = (compact: string) => `${compact.slice(0, 4)} ${compact.slice(4).split("").join(" ")}`;
    const IBAN = placeholder("IBAN");
    const runs: Array<[run: string, redacted: string]> = [];

    // Registered countries at their registered length, 15 to 33.
    for (const cc of ["NO", "BE", "DK", "MK", "AT", "CH", "GB", "GI", "AD", "PT", "IS", "FR", "AL", "BR", "JO", "MT", "LC", "RU"]) {
      const length = IBAN_LENGTHS[cc];
      const valid = withCheckDigits(cc, body(length - 4));
      runs.push([valid, IBAN], [fours(valid), IBAN], [`${valid}EUR`, `${IBAN}EUR`]);
      // Check digits off: still an account number of exactly the country's shape …
      runs.push([withCheckDigits(cc, many(IBAN_DIGITS, length - 4), false), IBAN]);
      // … unless it holds too few digits to be one.
      const wordy = withCheckDigits(cc, many(IBAN_LETTERS, length - 7) + many(IBAN_DIGITS, 3), false);
      runs.push([wordy, wordy]);
    }

    // Unregistered countries at every length from 15 to 34: mod-97 alone decides.
    const unregistered = ["ZZ", "QQ", "WW", "YY"];
    expect(unregistered.filter((cc) => cc in IBAN_LENGTHS)).toEqual([]);
    for (let length = 15; length <= 34; length++) {
      const cc = unregistered[length % unregistered.length];
      const valid = withCheckDigits(cc, body(length - 4));
      const off = withCheckDigits(cc, body(length - 4), false);
      runs.push([valid, IBAN], [off, off], [singles(valid), IBAN]);
      // Spaced a character at a time every length is a possible end: the longest that passes is the IBAN …
      const tail = growInvalid(valid, Math.min(1 + pick(4), 36 - length)).slice(length);
      runs.push([singles(valid + tail), `${IBAN} ${tail.split("").join(" ")}`]);
      // … and with none that passes there is none, up to the 36 characters a run can hold.
      const none = singles(growInvalid(cc + many(IBAN_DIGITS, 2), length - 4 + pick(3)));
      runs.push([none, none]);
    }
    expect(runs.length).toBeGreaterThanOrEqual(100);

    const started = performance.now();
    const r = redactText(runs.map(([run]) => run).join("\n"));
    const elapsed = performance.now() - started;
    expect(r.text.split("\n")).toEqual(runs.map(([, redacted]) => redacted));
    expect(r.counts.IBAN).toBe(runs.filter(([, redacted]) => redacted.startsWith(IBAN)).length);
    expect(r.kinds).toEqual(["IBAN"]);
    expect(elapsed).toBeLessThan(1000);
  });

  it("replaces Luhn-valid card numbers with or without separators", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(redactText("card 4111 1111 1111 1111 exp").text).toBe(`card ${placeholder("CARD")} exp`);
    expect(redactText("card 4111-1111-1111-1111").text).toBe(`card ${placeholder("CARD")}`);
    expect(redactText("card 4111111111111111").text).toBe(`card ${placeholder("CARD")}`);
    expect(redactText("order 4111111111111112").kinds).not.toContain("CARD");
    // Amex 4-6-5, a 19-digit card as 4-4-4-4-3, and test cards of other networks.
    expect(redactText("amex 3782 822463 10005.").text).toBe(`amex ${placeholder("CARD")}.`);
    expect(redactText("amex 3782-822463-10005").text).toBe(`amex ${placeholder("CARD")}`);
    expect(redactText("amex 378282246310005").kinds).toContain("CARD");
    expect(redactText("(5555 5555 5555 4444)").text).toBe(`(${placeholder("CARD")})`);
    expect(redactText("long 6011 0000 0000 0000 001").text).toBe(`long ${placeholder("CARD")}`);
    expect(redactText("scan_4111111111111111.pdf").text).toBe(`scan_${placeholder("CARD")}.pdf`);
  });

  it("never reads a hex hash or a column of small numbers as a card", () => {
    // A hash whose first 15 characters are digits (Luhn-valid) and the 16th a letter.
    expect(luhnValid("854177235498113")).toBe(true);
    for (const hash of ["854177235498113d", "commit 854177235498113d", "d854177235498113", "x4111111111111111y"]) {
      expect(redactText(hash).text).toBe(hash);
      expect(scanSecrets(hash)).toEqual([]);
    }
    // A memory table row: groups of one to four digits, 17 digits that pass Luhn.
    const row = "Mem:           7607 1214 138 14 6254";
    expect(luhnValid("76071214138146254")).toBe(true);
    expect(redactText(row).text).toBe(row);
    expect(scanSecrets(`              total        used        free      shared  buff/cache   available\n${row}`)).toEqual([]);
    // Digits of another script touch it just as ASCII ones do.
    expect(redactText("٣4111111111111111").kinds).not.toContain("CARD");
    // Separators mixed, or groups that are no card's: not a card either.
    expect(redactText("4111 1111-1111 1111").kinds).not.toContain("CARD");
    expect(redactText("41 1111 1111 1111 11").kinds).not.toContain("CARD");
    expect(redactText("4111  1111  1111  1111").kinds).not.toContain("CARD");
  });

  it("never mistakes a Unix timestamp for a card number", () => {
    // A millisecond timestamp that happens to pass Luhn.
    let ms = 1_760_000_000_000;
    while (!luhnValid(String(ms))) ms++;
    expect(looksLikeUnixTimestamp(String(ms))).toBe(true);
    expect(redactText(`at ${ms} the job ran`).text).toBe(`at ${ms} the job ran`);
    expect(looksLikeUnixTimestamp("1760000000")).toBe(true);
    expect(looksLikeUnixTimestamp("0000000001")).toBe(false);
    // Grouped 4-4-5 it is no card's way of writing 13 digits either.
    const grouped = String(ms).replace(/^(\d{4})(\d{4})(\d{5})$/, "$1 $2 $3");
    expect(redactText(grouped).kinds).not.toContain("CARD");
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

  it("redacts phone numbers a file name joins to its other parts", () => {
    const P = placeholder("PHONE");
    expect(redactPath("upload/b/555-010-0199-report.md").text).toBe(`upload/b/${P}-report.md`);
    expect(redactPath("upload/b/call_555.010.0199.txt").text).toBe(`upload/b/call_${P}.txt`);
    expect(redactPath("upload/b/notes 555 010 0199.md").text).toBe(`upload/b/notes ${P}.md`);
    expect(redactPath("upload/b/+44 20 7946 0958_acme.md").text).toBe(`upload/b/${P}_acme.md`);
    // An upload's rebuilt name joins every part with `_`.
    expect(redactPath("upload/b/call_555_010_0199.md").text).toBe(`upload/b/call_${P}.md`);
    expect(redactPath("upload/b/+44_20_7946_0958_acme.md").text).toBe(`upload/b/${P}_acme.md`);
    const staged = safeUploadName("call#555#010#0199.md")?.name;
    expect(staged).toBe("call_555_010_0199.md");
    expect(redactPath(`upload/b/${staged}`).text).toBe(`upload/b/call_${P}.md`);
    // Dates, versions and bare digit runs (timestamps, invoice numbers) stay.
    for (const keep of ["2026-10-14-minutes.md", "2026_10_14_minutes.md", "v1.2.3-notes.md", "1760400000-export.md", "invoice-55501234.pdf"]) {
      expect(redactPath(`upload/b/${keep}`).text).toBe(`upload/b/${keep}`);
    }
    // Phones off means off for names too.
    expect(redactPath("upload/b/555-010-0199.md", { maskPhones: false }).text).toBe("upload/b/555-010-0199.md");
  });
});
