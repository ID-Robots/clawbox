import { describe, expect, it } from "vitest";
import { humanizeApiError } from "@/lib/api-error-message";

/**
 * The wizard must never render a response body.
 *
 * What a real box put on the setup wizard, verbatim, when a ClawBox AI
 * device-code sign-in failed its credential migration:
 *
 *     {"error":"Credential migration failed. The subscription sign-in was
 *     rolled back — try again, or run 'openclaw doctor --fix' from the
 *     Terminal."}
 *
 * The sentence was fine. The braces were the bug, and they came from one hop
 * reading the response with `.text()` and passing the string on as a message.
 */

const ROLLED_BACK =
  "Credential migration failed. The subscription sign-in was rolled back — try again,"
  + " or run 'openclaw doctor --fix' from the Terminal.";

describe("humanizeApiError", () => {
  it("unwraps the exact body that reached the wizard", () => {
    expect(humanizeApiError(JSON.stringify({ error: ROLLED_BACK }), "fallback")).toBe(ROLLED_BACK);
  });

  it("never returns a string that still looks like a body", () => {
    const shown = humanizeApiError(JSON.stringify({ error: ROLLED_BACK }), "fallback");
    expect(shown.startsWith("{")).toBe(false);
    expect(shown).not.toContain('"error"');
  });

  it("unwraps an already-parsed body", () => {
    expect(humanizeApiError({ error: ROLLED_BACK }, "fallback")).toBe(ROLLED_BACK);
  });

  it("takes a plain sentence unchanged", () => {
    expect(humanizeApiError(ROLLED_BACK, "fallback")).toBe(ROLLED_BACK);
  });

  it("reads `message` when there is no `error`", () => {
    expect(humanizeApiError({ message: "Upstream said no." }, "fallback")).toBe("Upstream said no.");
  });

  it("prefers `error` over `message`", () => {
    expect(humanizeApiError({ error: "first", message: "second" }, "fallback")).toBe("first");
  });

  it("unwraps a nested error object", () => {
    expect(humanizeApiError({ error: { message: "Nested." } }, "fallback")).toBe("Nested.");
  });

  it("unwraps a body that was double-encoded on the way through", () => {
    // Exactly the hazard of a chain four hops long: one hop stringifies a body
    // that already carried a stringified body.
    expect(humanizeApiError({ error: JSON.stringify({ error: ROLLED_BACK }) }, "fallback"))
      .toBe(ROLLED_BACK);
  });

  it("falls back rather than showing a body it cannot read", () => {
    // The one-way rule: no sentence means the caller's fallback, never the
    // input. "Show it anyway" is how the braces got on screen.
    expect(humanizeApiError(JSON.stringify({ trace: [1, 2, 3] }), "Failed to configure"))
      .toBe("Failed to configure");
    expect(humanizeApiError({ status: 502 }, "Failed to configure")).toBe("Failed to configure");
  });

  it("falls back on the values a field can actually hold at runtime", () => {
    for (const value of [undefined, null, 502, true, {}, [], "", "   "]) {
      expect(humanizeApiError(value, "Failed to configure")).toBe("Failed to configure");
    }
  });

  it("keeps prose that merely starts with a brace", () => {
    // Not JSON, so not a body: it is the sentence, and it must survive.
    const prose = "{unexpected} placeholder left in the template";
    expect(humanizeApiError(prose, "fallback")).toBe(prose);
  });

  it("reads the first usable member of an array body", () => {
    expect(humanizeApiError([{ detail: "" }, { detail: "Second one speaks." }], "fallback"))
      .toBe("Second one speaks.");
  });

  it("trims surrounding whitespace", () => {
    expect(humanizeApiError("  spaced out  ", "fallback")).toBe("spaced out");
  });

  it("does not recurse forever on a self-referential body", () => {
    const loop: Record<string, unknown> = {};
    loop.error = loop;
    expect(humanizeApiError(loop, "Failed to configure")).toBe("Failed to configure");
  });

  it("stops unwrapping before an arbitrarily deep payload", () => {
    // Depth is bounded on purpose: past a few levels this is a payload being
    // searched, not a message being unwrapped.
    const deep = { error: { error: { error: { error: { error: { error: "too deep" } } } } } };
    expect(humanizeApiError(deep, "Failed to configure")).toBe("Failed to configure");
  });
});
