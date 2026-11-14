// The card entry format, validation (Luhn, brand, expiry, CVV), masking and
// the scrubber that keeps card numbers and CVVs out of MCP replies and logs.
import { describe, expect, test } from "bun:test";
import {
  cardBrand,
  cardMetaOf,
  cardNameFor,
  containsCardNumber,
  defaultLabel,
  formatExpiry,
  formatNumber,
  isCardName,
  isExpired,
  luhnValid,
  maskCvv,
  maskNumber,
  parseCard,
  parseExpiry,
  redactCardNumbers,
  redactCvvs,
  scrubCardData,
  scrubDeep,
  serializeCard,
  validateCardNumber,
  validateCardText,
  validateCvv,
  validateExpiry,
} from "../src/shared/card";
import { ValidationError } from "../src/shared/entry";
import { scrub } from "../src/mcp/tools";

const VISA = "4242424242424242";
const NOW = new Date("2026-10-31T12:00:00Z");

describe("entry format", () => {
  test("parse and serialize round-trip; unknown lines are kept in order", () => {
    const text = [VISA, "name: Jane Q Doe", "exp: 12/34", "cvv: 123", "label: Company Visa", "note: travel only", "pin-hint: ask finance", "x"].join("\n") + "\n";
    const card = parseCard(text);
    expect(card).toEqual({
      number: VISA,
      cardholder: "Jane Q Doe",
      exp: "12/34",
      cvv: "123",
      label: "Company Visa",
      note: "travel only",
      extra: ["pin-hint: ask finance", "x"],
    });
    expect(serializeCard(card)).toBe(text);
  });

  test("a grouped number on line 1 parses to digits; empty fields are left out", () => {
    const card = parseCard("4242 4242 4242 4242\nexp: 01/30\n");
    expect(card.number).toBe(VISA);
    expect(serializeCard(card)).toBe(`${VISA}\nexp: 01/30\n`);
  });

  test("a repeated known field is kept as an extra line, not lost", () => {
    const card = parseCard(`${VISA}\nnote: one\nnote: two\n`);
    expect(card.note).toBe("one");
    expect(card.extra).toEqual(["note: two"]);
    expect(serializeCard(card)).toContain("note: two");
  });

  test("names live under cards/ and slug the label", () => {
    expect(cardNameFor("Company Visa")).toBe("cards/company-visa");
    expect(cardNameFor("  Фирмена карта  ")).toBe("cards/фирмена-карта");
    expect(cardNameFor("../../etc")).toBe("cards/etc");
    expect(cardNameFor("")).toBe("cards/card");
    expect(isCardName("cards/company-visa")).toBe(true);
    expect(isCardName("cardsharing.com/me")).toBe(false);
  });

  test("metadata has label, brand, last 4, expiry, cardholder and dates only", () => {
    const meta = cardMetaOf("cards/x", parseCard(`${VISA}\nname: Jane\nexp: 12/34\ncvv: 123\n`), NOW, NOW);
    expect(meta).toEqual({ name: "cards/x", label: "Visa 4242", brand: "visa", last4: "4242", exp: "12/34", expired: false, cardholder: "Jane", updated: NOW.toISOString() });
    expect(JSON.stringify(meta)).not.toContain(VISA);
    expect(JSON.stringify(meta)).not.toContain("123");
  });
});

describe("Luhn, brand, expiry, CVV", () => {
  test("Luhn", () => {
    for (const n of [VISA, "4000056655665556", "5555555555554444", "2223003122003222", "378282246310005", "6011111111111117", "3056930009020004", "3566002020360505", "6200000000000005"]) {
      expect({ n, ok: luhnValid(n) }).toEqual({ n, ok: true });
    }
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("42424242a4242424")).toBe(false);
  });

  test("brand from the issuer prefix", () => {
    const cases: Array<[string, string]> = [
      [VISA, "visa"],
      ["5555555555554444", "mastercard"],
      ["2223003122003222", "mastercard"],
      ["378282246310005", "amex"],
      ["6011111111111117", "discover"],
      ["3056930009020004", "diners"],
      ["3566002020360505", "jcb"],
      ["6200000000000005", "unionpay"],
      ["2200000000000004", "mir"],
      ["6759649826438453", "maestro"],
      ["9999999999999995", "unknown"],
    ];
    for (const [n, brand] of cases) expect({ n, brand: cardBrand(n) as string }).toEqual({ n, brand });
  });

  test("validation accepts spaces and dashes, refuses bad numbers without quoting them", () => {
    expect(validateCardNumber("4242 4242-4242 4242")).toBe(VISA);
    expect(validateCardNumber("378282246310005")).toBe("378282246310005");
    const bad = ["4242424242424241", "4242", "42424242424242424242", "4242x42424242424", "", "37828224631000"];
    for (const n of bad) {
      let err: unknown;
      try {
        validateCardNumber(n);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      if (n.length >= 4) expect((err as Error).message).not.toContain(n);
    }
  });

  test("expiry: formats, end of month, past and absurd dates", () => {
    expect(parseExpiry("12/34")).toEqual({ month: 12, year: 2034 });
    expect(parseExpiry("1/2034")).toEqual({ month: 1, year: 2034 });
    expect(parseExpiry("12 / 34")).toEqual({ month: 12, year: 2034 });
    expect(parseExpiry("1234")).toEqual({ month: 12, year: 2034 });
    expect(parseExpiry("13/34")).toBeNull();
    expect(parseExpiry("12/3")).toBeNull();
    expect(formatExpiry({ month: 3, year: 2031 })).toBe("03/31");
    expect(validateExpiry("12/2034", NOW)).toBe("12/34");
    expect(validateExpiry("10/26", NOW)).toBe("10/26"); // valid through the end of October
    expect(isExpired("10/26", NOW)).toBe(false);
    expect(isExpired("09/26", NOW)).toBe(true);
    expect(() => validateExpiry("09/26", NOW)).toThrow("expired");
    expect(() => validateExpiry("12/99", NOW)).toThrow("too far");
    expect(() => validateExpiry("", NOW)).toThrow(ValidationError);
  });

  test("CVV: optional; 3 digits, 4 for American Express", () => {
    expect(validateCvv(undefined, "visa")).toBe("");
    expect(validateCvv("123", "visa")).toBe("123");
    expect(validateCvv("1234", "amex")).toBe("1234");
    expect(() => validateCvv("1234", "visa")).toThrow(ValidationError);
    expect(() => validateCvv("123", "amex")).toThrow(ValidationError);
    expect(() => validateCvv("12a", "visa")).toThrow(ValidationError);
  });

  test("labels, cardholders and notes may not carry a card number", () => {
    expect(validateCardText("Company Visa", "label", 60)).toBe("Company Visa");
    expect(() => validateCardText(`my ${VISA}`, "label", 60)).toThrow("must not contain a card number");
    expect(() => validateCardText("note\nsecond line", "note", 100)).toThrow(ValidationError);
  });
});

describe("masking", () => {
  test("only the last four digits show", () => {
    expect(maskNumber(VISA)).toBe("•••• 4242");
    expect(maskNumber("378282246310005")).toBe("•••• 0005");
    expect(maskCvv("123")).toBe("•••");
    expect(maskCvv("")).toBe("");
    expect(defaultLabel("5555555555554444")).toBe("Mastercard 4444");
  });

  test("grouping for display and for input masks", () => {
    expect(formatNumber(VISA)).toBe("4242 4242 4242 4242");
    expect(formatNumber("378282246310005")).toBe("3782 822463 10005");
    expect(formatNumber(VISA, "-")).toBe("4242-4242-4242-4242");
    expect(formatNumber("4242424242424242123")).toBe("4242 4242 4242 4242 123");
  });
});

describe("scrubber", () => {
  test("Luhn-valid 13–19 digit sequences, plain or grouped", () => {
    expect(redactCardNumbers(`card ${VISA} end`)).toBe("card [redacted] end");
    expect(redactCardNumbers("4242 4242 4242 4242")).toBe("[redacted]");
    expect(redactCardNumbers("4242-4242-4242-4242")).toBe("[redacted]");
    expect(redactCardNumbers("amex 3782 822463 10005.")).toBe("amex [redacted].");
    // a number with the CVV right after it, separated or glued
    expect(redactCardNumbers(`${VISA} 123`)).toBe("[redacted] 123");
    expect(redactCardNumbers(`${VISA}123`)).not.toContain(VISA);
    expect(containsCardNumber(`{"n":"${VISA}"}`)).toBe(true);
  });

  test("leaves timestamps, short numbers and Luhn-invalid digit runs alone", () => {
    const keep = ["2026-10-31T10:12:34.567Z", "order 12345", "4242424242424241", "id 1234567890123", "last 4: 4242", "exp 12/34"];
    for (const t of keep.filter((x) => !containsCardNumber(x))) expect(redactCardNumbers(t)).toBe(t);
    expect(redactCardNumbers("2026-10-31T10:12:34.567Z")).toBe("2026-10-31T10:12:34.567Z");
    expect(redactCardNumbers("4242424242424241")).toBe("4242424242424241");
  });

  test("CVVs next to their keyword, in text and JSON, English, German and Bulgarian", () => {
    expect(redactCvvs("cvv: 123")).toBe("cvv: [redacted]");
    expect(redactCvvs('{"cvc":"4321"}')).toBe('{"cvc":"[redacted]"}');
    expect(redactCvvs('{"cvv": 123}')).toBe('{"cvv": [redacted]}');
    expect(redactCvvs("the security code is 987")).toBe("the security code is [redacted]");
    expect(redactCvvs("Prüfnummer 456")).toBe("Prüfnummer [redacted]");
    expect(redactCvvs("CVV код 321")).toBe("CVV код [redacted]");
    expect(redactCvvs("4 cards, limit 200")).toBe("4 cards, limit 200");
  });

  test("scrubCardData and scrubDeep: known secrets, numbers, codes, nested JSON and numeric values", () => {
    expect(scrubCardData("pw Sekr3t!x and 4242424242424242", ["Sekr3t!x"])).toBe("pw [redacted] and [redacted]");
    const deep: unknown = scrubDeep({ a: [{ n: VISA, cvv: "cvv 123" }], num: 4242424242424242, ok: 42, at: "2026-10-31" }, (s) => scrubCardData(s));
    expect(deep).toEqual({ a: [{ n: "[redacted]", cvv: "cvv [redacted]" }], num: "[redacted]", ok: 42, at: "2026-10-31" });
  });

  test("the MCP scrub keeps structured content valid JSON", () => {
    const r = scrub(
      { content: [{ type: "text", text: `number ${VISA}, cvc: 123` }], structuredContent: { card: { number: Number(VISA), note: `"${VISA}"` } } },
      [],
    );
    expect(r.content[0]!.text).toBe("number [redacted], cvc: [redacted]");
    expect(r.structuredContent).toEqual({ card: { number: "[redacted]", note: '"[redacted]"' } });
  });
});
