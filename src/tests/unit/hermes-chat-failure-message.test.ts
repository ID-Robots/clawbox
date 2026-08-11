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
const { hermesFailureMessage, hermesExitMessage, HERMES_INTERRUPTED_EXIT_CODE } = __test;

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

/**
 * An interrupted turn used to surface as "hermes exited with code 130".
 *
 * Captured on-device by sending each of SIGTERM, SIGHUP and SIGINT to a live
 * `hermes chat -q` turn. All three produced identical observable state:
 *   EXIT:   130          (numeric — an explicit sys.exit, not signal death)
 *   STDOUT: (0 bytes)
 *   STDERR: "\nsession_id: 20260811_182550_b9de16\n"  (36 bytes)
 *
 * So 130 carries no information about WHICH signal arrived, and both streams
 * are empty once the banner is stripped. The message must therefore name the
 * situation generically rather than attribute a cause it cannot know.
 */
describe("the message shown for an interrupted Hermes turn", () => {
  // The exact bytes observed on the device, for all three signals.
  const INTERRUPTED_STDERR = "\nsession_id: 20260811_182550_b9de16\n";

  it("no longer surfaces the bare exit code", () => {
    const msg = hermesExitMessage(HERMES_INTERRUPTED_EXIT_CODE, "", INTERRUPTED_STDERR);
    expect(msg).not.toMatch(/exited with code/);
    expect(msg).not.toMatch(/130/);
  });

  it("says the turn was interrupted and that the message can be re-sent", () => {
    const msg = hermesExitMessage(HERMES_INTERRUPTED_EXIT_CODE, "", INTERRUPTED_STDERR);
    expect(msg).toMatch(/interrupted/i);
    expect(msg).toMatch(/send it again/i);
  });

  it("does not blame the user, since the signal's origin is unknowable", () => {
    const msg = hermesExitMessage(HERMES_INTERRUPTED_EXIT_CODE, "", INTERRUPTED_STDERR);
    // A user-initiated Stop aborts the request and returns 499; it never
    // reaches this path. Claiming "you cancelled" here would be a guess.
    expect(msg).not.toMatch(/cancell?ed/i);
    expect(msg).not.toMatch(/\byou stopped\b/i);
  });

  it("never leaks the session banner", () => {
    expect(hermesExitMessage(HERMES_INTERRUPTED_EXIT_CODE, "", INTERRUPTED_STDERR))
      .not.toMatch(/session_id/i);
  });

  it("still prefers a real cause when the process managed to report one", () => {
    // 130 with actual output means the turn said something before going down;
    // that beats the generic interruption text.
    const msg = hermesExitMessage(
      HERMES_INTERRUPTED_EXIT_CODE,
      "",
      "session_id: 20260811_000000_aaaaaa\nHTTP 401: invalid api key",
    );
    expect(msg).toBe("HTTP 401: invalid api key");
  });

  it("leaves every other non-zero exit reporting its code", () => {
    expect(hermesExitMessage(1, "", "session_id: 20260811_000000_aaaaaa"))
      .toBe("hermes exited with code 1");
    expect(hermesExitMessage(2, "", "")).toBe("hermes exited with code 2");
  });

  it("keeps the interruption distinct from the timeout path", () => {
    // The timeout rejects with its own "Hermes timed out" before close fires,
    // so the two must not collapse into one message.
    expect(hermesExitMessage(HERMES_INTERRUPTED_EXIT_CODE, "", INTERRUPTED_STDERR))
      .not.toMatch(/timed out/i);
  });
});
