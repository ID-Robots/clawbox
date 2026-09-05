import { describe, expect, it } from "vitest";
import { hermesFailureMessage } from "@/lib/hermes-cli-message";
import { hermesExitMessage, HERMES_INTERRUPTED_EXIT_CODE } from "@/lib/hermes-chat-exit";

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
    // A REAL CPython traceback prints an indented SOURCE line under every
    // `File "…"` frame. Omitting it let this test pass against a filter that
    // only knew about the frame header — the very hole it was meant to close.
    const stderr = [
      "session_id: 20260811_000000_aaaaaa",
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/agent.py", line 88, in _call_provider',
      '    raise RuntimeError("upstream refused the request")',
      "RuntimeError: upstream refused the request",
    ].join("\n");
    const msg = hermesFailureMessage("", stderr);
    expect(msg).toBe("RuntimeError: upstream refused the request");
    expect(msg).not.toMatch(/Traceback|File "|raise /);
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
 * Hermes hard-wraps at ~76 columns. Keeping only the first line therefore cut
 * every multi-line message mid-clause, and the half that was dropped was the
 * half the customer could act on. Both stdout blocks below are the exact bytes
 * captured from `hermes chat -q` on the QA box (TASK-451 / TASK-446).
 */
describe("a Hermes message that arrives hard-wrapped", () => {
  it("keeps the remedy half of 'No inference provider configured'", () => {
    const stdout = [
      "No inference provider configured. Run 'hermes model' to choose a provider and",
      "model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in",
      "~/.hermes/.env.",
    ].join("\r\n");

    const msg = hermesFailureMessage(stdout, "");

    // It used to end on a dangling "and".
    expect(msg).not.toMatch(/\band$/);
    expect(msg).toContain("OPENROUTER_API_KEY");
    expect(msg).toContain("~/.hermes/.env");
    expect(msg).toBe(
      "No inference provider configured. Run 'hermes model' to choose a provider and "
      + "model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in ~/.hermes/.env.",
    );
  });

  it("keeps the whole context-window explanation, all five lines of it", () => {
    const stdout = [
      "Failed to initialize agent: Model qwen2.5:3b has a context window of 32,768",
      "tokens, which is below the minimum 64,000 required by Hermes Agent. Choose a",
      "model with at least 64K context. If your server reports a window smaller than",
      "the model's true window, set model.context_length in config.yaml to the real",
      "value (this must be at least 64K).",
    ].join("\n");

    const msg = hermesFailureMessage(stdout, "");

    expect(msg).toContain("at least 64K context");
    expect(msg).toContain("model.context_length");
    expect(msg).toMatch(/\)\.$/);
    expect(msg.length).toBeLessThanOrEqual(400);
  });

  it("does not glue two independent failures together", () => {
    const stdout = [
      "API call failed after 3 retries: HTTP 404: model: claude-opus-4-20250514xxxx",
      "HTTP 401: invalid api key",
    ].join("\n");
    // The second line opens with its own `HTTP nnn` marker, so it is a new
    // record however long the line above it is.
    expect(hermesFailureMessage(stdout, "")).toBe(
      "API call failed after 3 retries: HTTP 404: model: claude-opus-4-20250514xxxx",
    );
  });

  it("leaves a short two-line report as two lines", () => {
    // Nothing was wrapped here — the first line is well under the wrap column.
    expect(hermesFailureMessage("failed early\nsomething else entirely", "")).toBe("failed early");
  });

  it("marks a message it had to cut", () => {
    const long = "error: " + "x".repeat(5000);
    expect(hermesFailureMessage(long, "").endsWith("…")).toBe(true);
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

/**
 * A failed turn on a RESUMED session surfaced the resume banner as the error.
 *
 * Captured verbatim from the owner's box (2026-08-25, session
 * 20260825_165225_be089e): `hermes chat -q … --resume` exited 1 with the real
 * cause on stdout and only bookkeeping on stderr. `errorFromStderr` saw a
 * non-empty stderr line and returned it, so the chat bubble read
 * "Error: ↻ Resumed session …" — a status line dressed as a failure — and
 * the actual `HTTP 403` was discarded without ever being read.
 */
describe("a failed turn on a resumed session", () => {
  // The exact stderr bytes observed on the device.
  const RESUMED_STDERR = [
    "",
    '↻ Resumed session 20260825_165225_be089e "What model are you and what is this machine?" (2 user messages, 7 total messages)',
    "Model restored from session: claude-fable-5 (anthropic)",
    "",
    "session_id: 20260825_165225_be089e",
    "",
  ].join("\n");

  it("never reports the resume banner as the error", () => {
    const msg = hermesFailureMessage("HTTP 403 — Just a moment...", RESUMED_STDERR);
    expect(msg).not.toMatch(/Resumed session/);
    expect(msg).toBe("HTTP 403 — Just a moment...");
  });

  it("treats a resume with nothing else said as silence, so the exit falls back to its code", () => {
    expect(hermesFailureMessage("", RESUMED_STDERR)).toBe("");
    expect(hermesExitMessage(1, "", RESUMED_STDERR)).toBe("hermes exited with code 1");
  });

  it("drops the model-restored line as bookkeeping too", () => {
    expect(hermesFailureMessage("", "Model restored from session: claude-fable-5 (anthropic)")).toBe("");
  });

  it("still lets a genuine stderr cause win on a resumed run", () => {
    const msg = hermesFailureMessage(
      "partial answer text",
      `${RESUMED_STDERR}\nHTTP 401: invalid api key`,
    );
    expect(msg).toBe("HTTP 401: invalid api key");
  });

  it("keeps prose that merely mentions a resumed session", () => {
    // Only a line-leading banner is bookkeeping; an answer ABOUT sessions is not.
    const stdout = "The error came from a Resumed session banner in your logs.";
    expect(hermesFailureMessage(stdout, "")).toBe(stdout);
  });

  it("drops the banner even without its ↻ prefix", () => {
    const msg = hermesFailureMessage(
      "HTTP 403 — Just a moment...",
      'Resumed session 20260825_165225_be089e "t" (1 user message, 5 total messages)',
    );
    expect(msg).toBe("HTTP 403 — Just a moment...");
  });
});

/**
 * The chat bubble showed a line of PYTHON SOURCE when Hermes crashed.
 *
 * Every line was trimmed before it was classified, which threw away the one
 * signal CPython gives for free: it INDENTS everything belonging to a frame —
 * the `File "…"` header, the source line under it, and (3.11+) the `^^^^`
 * anchor beneath that — and returns the exception summary to column 0. With
 * the indentation gone, `raise RuntimeError("upstream refused the request")`
 * matched the "names a failure" heuristic on "RuntimeError", sat earlier in
 * the stream than the real summary, and won. Captured shape below is what
 * CPython 3.11+ prints.
 */
describe("a Python traceback in the output", () => {
  const TRACEBACK = [
    "session_id: 20260811_000000_aaaaaa",
    "Traceback (most recent call last):",
    '  File "/home/clawbox/.hermes/agent.py", line 212, in _turn',
    "    return self._call_provider(payload)",
    "           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
    '  File "/home/clawbox/.hermes/agent.py", line 88, in _call_provider',
    '    raise RuntimeError("upstream refused the request")',
    "RuntimeError: upstream refused the request",
  ].join("\n");

  it("shows the exception summary, never the source line that raised it", () => {
    expect(hermesFailureMessage("", TRACEBACK)).toBe("RuntimeError: upstream refused the request");
  });

  it("shows no fragment of a frame — header, source line or anchor", () => {
    const msg = hermesFailureMessage("", TRACEBACK);
    expect(msg).not.toMatch(/raise |_call_provider|\^\^\^|File "|Traceback/);
  });

  it("still wins over partial answer text left on stdout", () => {
    expect(hermesFailureMessage("half an answer", TRACEBACK))
      .toBe("RuntimeError: upstream refused the request");
  });

  it("reads a traceback on stdout the same way", () => {
    expect(hermesFailureMessage(TRACEBACK, "")).toBe("RuntimeError: upstream refused the request");
  });

  it("reports an exception summary, not a source line, for a chained traceback", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/agent.py", line 88, in _call_provider',
      "    resp = self.session.post(url, json=payload)",
      "ConnectionError: connection refused",
      "",
      "During handling of the above exception, another exception occurred:",
      "",
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/chat.py", line 40, in turn',
      '    raise RuntimeError("the turn failed")',
      "RuntimeError: the turn failed",
    ].join("\n");
    const msg = hermesFailureMessage("", stderr);
    expect(msg).toMatch(/^(?:ConnectionError|RuntimeError): /);
    expect(msg).not.toMatch(/resp = |raise |File "|above exception/);
  });

  it("says nothing rather than guess when the stream is cut off mid-frame", () => {
    // stderr hit the size cap partway through the frames, so no summary line
    // ever arrived. Silence lets the caller fall back to the exit code; a
    // source line here would be a confident wrong answer.
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/agent.py", line 212, in _turn',
      "    return self._call_provider(payload)",
    ].join("\n");
    expect(hermesFailureMessage("", stderr)).toBe("");
    expect(hermesExitMessage(1, "", stderr)).toBe("hermes exited with code 1");
  });

  it("stops dropping indented lines once the traceback has ended", () => {
    // The frame rule is scoped to the traceback. An indented line in ordinary
    // Hermes output after it is still something the customer needs, and here
    // it is the only line naming the failure at all.
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/agent.py", line 88, in run',
      "    resp = self.session.post(url, json=payload)",
      "KeyboardInterrupt",
      "  the provider denied the request; check the API key",
    ].join("\n");
    expect(hermesFailureMessage("", stderr))
      .toBe("the provider denied the request; check the API key");
  });

  it("keeps a sentence that merely starts with File \"…\" after the traceback", () => {
    // `File "` alone used to open a traceback block, so an ordinary diagnostic
    // naming a file was both discarded AND reopened suppression over the lines
    // under it. Only the real frame shape — File "…", line <n> — opens one.
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/agent.py", line 88, in run',
      "    cfg = load(path)",
      "KeyboardInterrupt",
      '  File "config.yaml" was denied to the hermes user',
    ].join("\n");
    const msg = hermesFailureMessage("", stderr);
    expect(msg).toBe('File "config.yaml" was denied to the hermes user');
    expect(msg).not.toMatch(/cfg = load|agent\.py/);
  });

  it("keeps indented prose that was never part of a traceback", () => {
    expect(hermesFailureMessage("    the request was denied by the provider", ""))
      .toBe("the request was denied by the provider");
  });
});
