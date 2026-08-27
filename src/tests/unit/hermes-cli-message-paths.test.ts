import { describe, expect, it } from "vitest";
import { hermesFailureMessage } from "@/lib/hermes-cli-message";

/**
 * Dropping the traceback FRAMES does not get the paths out.
 *
 * A CPython exception summary sits at column 0 — which is exactly why the frame
 * strip keeps it, and why it becomes the message — and the most common summaries
 * quote the path that failed:
 *
 *   FileNotFoundError: [Errno 2] No such file or directory: '/home/clawbox/.hermes/config.yaml'
 *   PermissionError: [Errno 13] Permission denied: '/home/clawbox/.hermes/auth-profiles.json'
 *
 * There is no traceback to strip in the plain-stderr case either. So the line
 * reaches the chat bubble, the 502 body and the durable transcript with the
 * install layout in it, having passed every rule the parser has.
 *
 * The fix redacts the path and keeps the sentence: `FileNotFoundError` and
 * `Permission denied` are what the customer needs; `/home/clawbox/.hermes` is
 * for the journal, which still gets the raw stream.
 */
describe("an on-device path in the line the parser keeps", () => {
  it("redacts an absolute path out of a CPython summary, keeping the cause", () => {
    const stderr = [
      "session_id: 20260827_101500_ab12cd",
      "Traceback (most recent call last):",
      '  File "/home/clawbox/.hermes/config.py", line 118, in set_key',
      "    return _write(path)",
      "FileNotFoundError: [Errno 2] No such file or directory: '/home/clawbox/.hermes/config.yaml'",
    ].join("\n");

    const msg = hermesFailureMessage("", stderr);

    expect(msg).not.toContain("/home/");
    expect(msg).toContain("FileNotFoundError");
    expect(msg).toContain("No such file or directory");
  });

  it("redacts a path on a line that never had a traceback around it", () => {
    const msg = hermesFailureMessage("", "Error: cannot write /home/clawbox/.hermes/config.yaml: permission denied");

    expect(msg).not.toContain("/home/");
    expect(msg).toContain("permission denied");
  });

  it.each([
    "/root/.hermes/config.yaml",
    "/var/lib/hermes/state.db",
    "/etc/clawbox/edition.env",
    "/usr/local/lib/python3.11/hermes/cli.py",
    "/tmp/hermes-abc123/lock",
    "/opt/hermes/bin/hermes",
  ])("redacts %s", (path) => {
    const msg = hermesFailureMessage("", `PermissionError: [Errno 13] Permission denied: '${path}'`);

    expect(msg).not.toContain(path);
    expect(msg).toContain("Permission denied");
  });

  /**
   * A path component may contain a space, and CPython quotes the path it
   * failed on. Redacting only up to the space left the tail on screen:
   *
   *   "… No such file or directory: '<path> Files/credentials.json'"
   *
   * — which still names a directory and a filename. Inside quotes the closing
   * quote is the real end of the path, so that is what bounds the match.
   */
  it("consumes a quoted path with a space in it, leaving no tail", () => {
    const msg = hermesFailureMessage(
      "",
      "FileNotFoundError: [Errno 2] No such file or directory: '/home/alice/Private Files/credentials.json'",
    );

    expect(msg).not.toContain("/home/");
    expect(msg).not.toContain("Files/");
    expect(msg).not.toContain("credentials.json");
    expect(msg).not.toContain("Private");
    expect(msg).toContain("No such file or directory");
  });

  it.each(['"', "'", "`"])("consumes a path quoted with %s", (q) => {
    const msg = hermesFailureMessage("", `PermissionError: Permission denied: ${q}/var/lib/hermes/My State/state.db${q}`);

    expect(msg).not.toContain("/var/");
    expect(msg).not.toContain("state.db");
    expect(msg).toContain("Permission denied");
  });

  /**
   * The line that must NOT be redacted, and the reason the rule is scoped to
   * ABSOLUTE paths.
   *
   * `~/.hermes/.env` is not a leak. It names no user, no home directory and no
   * install layout — it is the file Hermes itself tells the customer to edit,
   * and #515 exists in part to stop that half of the sentence being thrown
   * away (`src/tests/unit/hermes-chat-failure-message.test.ts`, "keeps the
   * remedy half of 'No inference provider configured'"). A redaction wide
   * enough to catch a leading `~` would replace the one actionable fact in the
   * message with `<path>`.
   */
  it("leaves the tilde-relative config file Hermes tells the customer to edit", () => {
    const stdout = [
      "No inference provider configured. Run 'hermes model' to choose a provider and",
      "model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in",
      "~/.hermes/.env.",
    ].join("\r\n");

    const msg = hermesFailureMessage(stdout, "");

    expect(msg).toContain("~/.hermes/.env");
    expect(msg).not.toContain("<path>");
  });

  it("leaves an ordinary sentence with a slash in it alone", () => {
    const msg = hermesFailureMessage("", "Error: 2/3 of the requested models are unavailable");

    expect(msg).toBe("Error: 2/3 of the requested models are unavailable");
  });
});
