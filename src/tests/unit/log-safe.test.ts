import { describe, expect, it } from "vitest";
import { logSafe, LOG_FIELD_MAX_LENGTH } from "@/lib/log-safe";

// Control characters are built by code point so this file stays plain ASCII and
// the expectations are readable.
const NUL = String.fromCharCode(0x00);
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x9b);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("logSafe", () => {
  it("leaves an ordinary value alone", () => {
    expect(logSafe("TestNet-Home")).toBe("TestNet-Home");
    expect(logSafe("")).toBe("");
  });

  it.each([
    ["NUL", NUL],
    ["LF", LF],
    ["CR", CR],
    ["ESC", ESC],
    ["DEL", DEL],
    ["C1", C1],
  ])("replaces %s so the value stays one line of text", (_label, ch) => {
    expect(logSafe(`a${ch}b`)).toBe(`a${REPLACEMENT}b`);
  });

  it("keeps a value on a single line", () => {
    expect(logSafe(`first${CR}${LF}second`)).toBe(`first${REPLACEMENT}${REPLACEMENT}second`);
  });

  it("replaces rather than strips, so distinct values stay distinct", () => {
    expect(logSafe(`a${LF}b`)).not.toBe(logSafe("ab"));
  });

  it("keeps non-ASCII text that is not a control character", () => {
    expect(logSafe("мрежа-Дом")).toBe("мрежа-Дом");
  });

  it("caps a long value and says how much was dropped", () => {
    const out = logSafe("x".repeat(500));
    expect(out.startsWith("x".repeat(LOG_FIELD_MAX_LENGTH))).toBe(true);
    expect(out).toContain(`[+${500 - LOG_FIELD_MAX_LENGTH} chars]`);
    expect(out.length).toBeLessThan(LOG_FIELD_MAX_LENGTH + 40);
  });

  it("does not cap a value at exactly the limit", () => {
    const exact = "y".repeat(LOG_FIELD_MAX_LENGTH);
    expect(logSafe(exact)).toBe(exact);
  });

  it("honours an explicit cap", () => {
    expect(logSafe("abcdef", 3)).toBe("abc...[+3 chars]");
  });

  it("bounds the output whatever the input size", () => {
    const out = logSafe(`${LF.repeat(10_000)}tail`);
    expect(out.length).toBeLessThan(LOG_FIELD_MAX_LENGTH + 40);
  });
});
