import { describe, expect, test } from "bun:test";
import { parseEntry, serializeEntry, validateLine, validateName, validatePassword } from "../src/shared/entry";
import { clampLength, entropyBits, generatePassword } from "../src/shared/generator";

describe("pass entry format", () => {
  test("parses line 1 as password and the known fields", () => {
    const e = parseEntry("s3cret pass\nlogin: alice@example.com\nurl: https://example.com/login\n2fa: otpauth://totp/x\nnote: billing\n");
    expect(e).toEqual({
      password: "s3cret pass",
      login: "alice@example.com",
      url: "https://example.com/login",
      twofa: "otpauth://totp/x",
      note: "billing",
      extra: [],
    });
  });
  test("keeps unknown lines and round-trips the exact format", () => {
    const text = "pw\nlogin: bob\nurl: https://x.example\ncustomer-id: 1234\nfree text line\n";
    const e = parseEntry(text);
    expect(e.extra).toEqual(["customer-id: 1234", "free text line"]);
    expect(serializeEntry(e)).toBe(text);
  });
  test("serializes only present fields, in the documented order", () => {
    expect(serializeEntry({ password: "p", login: "l", url: "", twofa: "", note: "n", extra: [] })).toBe("p\nlogin: l\nnote: n\n");
  });
});

describe("validation", () => {
  test("names", () => {
    expect(validateName("example.com/alice")).toBe("example.com/alice");
    expect(validateName("_test/clawbox-vault-smoke")).toBe("_test/clawbox-vault-smoke");
    for (const bad of ["", "../etc/passwd", "a/../b", "/abs", "a//b", ".git/config", "a/.gpg-id", "x.gpg", "-rf", "a/-b", "a\nb", "a\\b", "a/ b"]) {
      expect(() => validateName(bad)).toThrow();
    }
  });
  test("single-line fields and passwords", () => {
    expect(() => validateLine("a\nb", "login")).toThrow();
    expect(() => validatePassword("")).toThrow();
    expect(() => validatePassword("two\nlines")).toThrow();
    expect(validatePassword("  spaced  ")).toBe("  spaced  ");
  });
});

describe("generator", () => {
  test("length is clamped to 8..128", () => {
    expect(clampLength(2)).toBe(8);
    expect(clampLength(500)).toBe(128);
    expect(clampLength(undefined)).toBe(24);
    expect(generatePassword({ length: 40 })).toHaveLength(40);
  });
  test("every enabled class appears; symbols can be turned off", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 12 });
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^a-zA-Z0-9]/);
      expect(generatePassword({ length: 12, symbols: false })).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });
  test("no quotes, spaces or backslashes; values differ", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).not.toMatch(/["'`\\\s<>]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
    expect(entropyBits({ length: 24 })).toBeGreaterThan(140);
  });
});
