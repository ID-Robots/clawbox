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

/**
 * TASK-1014 / CodeQL alerts 545 and 534 (js/log-injection).
 *
 * `logSafe` always replaced CR and LF — they are inside `\p{Cc}` — but a
 * Unicode property escape is not something the scanner can read, so it judged
 * the helper an unrelated branch and every caller kept its alert. That is why
 * the maxParallelRuns line in setup-api/coding-agent/enable/route.ts had to
 * drop its value from the log rather than sanitise it.
 *
 * The fix is a literal `[\r\n]` pass in front of the class. It changes no
 * output — these pin that — and it is the shape a reader and a scanner can
 * both check, so it is pinned as source too: dropping it back to one pass
 * would silently re-open both alerts while every behavioural test stayed green.
 */
describe("the line-break pass", () => {
  it("still replaces CR and LF exactly as the control class did", () => {
    expect(logSafe(`a${CR}b`)).toBe(`a${REPLACEMENT}b`);
    expect(logSafe(`a${LF}b`)).toBe(`a${REPLACEMENT}b`);
    expect(logSafe(`${CR}${LF}`)).toBe(`${REPLACEMENT}${REPLACEMENT}`);
  });

  it("is idempotent and length-preserving, so no index can shift", () => {
    const value = `id${CR}${LF}forged: line`;
    const once = logSafe(value);
    expect(once).toHaveLength(value.length);
    expect(logSafe(once)).toBe(once);
  });

  it("cannot be used to forge a second log record", () => {
    const forged = logSafe(`run-abc12345${CR}${LF}[Browser] download saved for attacker`);
    expect(forged).not.toContain(LF);
    expect(forged).not.toContain(CR);
  });

  it("names the line breaks literally, where the scanner can read them", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/log-safe.ts"),
      "utf-8",
    );
    // A literal character class over CR and LF, applied with .replace …
    expect(source).toMatch(/const LINE_BREAKS = \/\[\\r\\n\]\/g;/);
    expect(source).toMatch(/\.replace\(LINE_BREAKS, REPLACEMENT\)/);
    // … and the broader control class still runs after it, not instead of it.
    expect(source).toMatch(/\.replace\(CONTROL_CHARACTERS, REPLACEMENT\)/);
  });
});
