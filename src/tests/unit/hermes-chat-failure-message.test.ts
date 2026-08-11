import { describe, expect, it } from "vitest";
import { __test } from "@/app/setup-api/hermes/chat/route";

/**
 * A failed chat turn reported "hermes exited with code 1" — true, and useless.
 *
 * Captured from the device for the failing case (a model the provider lists but
 * will not serve):
 *   STDOUT: API call failed after 3 retries: HTTP 404: model: claude-opus-4-20250514
 *   STDERR: session_id: 20260811_001238_b8e073
 *
 * Hermes puts the explanation on STDOUT and leaves stderr holding only the
 * session banner. Stripping that banner — correct in itself — left nothing, so
 * the extractor fell through to the generic string and the one line that told
 * the customer what went wrong was discarded.
 */
const { hermesFailureMessage } = __test;

describe("the message shown for a failed Hermes turn", () => {
  it("uses stdout when stderr holds only the session banner", () => {
    const stdout = "API call failed after 3 retries: HTTP 404: model: claude-opus-4-20250514";
    const stderr = "\nsession_id: 20260811_001238_b8e073\n";
    expect(hermesFailureMessage(stdout, stderr)).toBe(stdout);
  });

  it("never surfaces the session banner itself", () => {
    const msg = hermesFailureMessage("", "session_id: 20260811_001238_b8e073");
    expect(msg).not.toMatch(/session_id/i);
    expect(msg).toBe("");
  });

  it("prefers stderr when it actually says something", () => {
    // A crash reports on stderr; that beats whatever partial text stdout holds.
    const msg = hermesFailureMessage(
      "some partial answer text",
      "session_id: 20260811_000000_aaaaaa\nHTTP 401: invalid api key",
    );
    expect(msg).toBe("HTTP 401: invalid api key");
  });

  it("picks the line that names a failure, not merely the first line", () => {
    const stdout = [
      "Starting turn",
      "Thinking about the request",
      "API call failed after 3 retries: HTTP 404: model: nope",
    ].join("\n");
    expect(hermesFailureMessage(stdout, "")).toMatch(/HTTP 404/);
  });

  it("falls back to the first line when nothing names a failure", () => {
    expect(hermesFailureMessage("something unexpected happened", "")).toBe(
      "something unexpected happened",
    );
  });

  it("drops stack frames rather than showing them in a chat bubble", () => {
    const stderr = [
      "session_id: 20260811_000000_aaaaaa",
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/x.py", line 12, in run',
      "RuntimeError: upstream refused the request",
    ].join("\n");
    const msg = hermesFailureMessage("", stderr);
    expect(msg).toBe("RuntimeError: upstream refused the request");
    expect(msg).not.toMatch(/Traceback|File "/);
  });

  it("returns empty when neither stream says anything, so the caller can be generic", () => {
    expect(hermesFailureMessage("", "")).toBe("");
    expect(hermesFailureMessage("   \n  \n", "  ")).toBe("");
  });

  it("bounds the message so a runaway line cannot fill a chat bubble", () => {
    expect(hermesFailureMessage("error: " + "x".repeat(5000), "").length).toBeLessThanOrEqual(400);
  });
});
