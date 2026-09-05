/**
 * How a Hermes turn's exit becomes words for the person: the interrupted
 * exit code, the sentence for it, and the message for any non-zero exit.
 *
 * Out of the route module on purpose: a route file may export handlers and
 * Next's config keys only (the webpack build's route type check refuses
 * anything else), and the test that pins these strings needs a door.
 */
import { hermesFailureMessage } from "@/lib/hermes-cli-message";

/**
 * The exit code `hermes chat -q` uses when a turn is cut short by a signal.
 *
 * It looks like the shell's 128+SIGINT convention, and that reading is wrong in
 * a way that matters. Hermes installs ONE handler for SIGINT, SIGTERM and
 * SIGHUP whose last act is to raise KeyboardInterrupt; the `-q` path catches
 * that around the turn and calls `sys.exit(130)` explicitly. So:
 *
 *   - the code is numeric rather than null (a signal-KILLED child reports
 *     `code === null`), which is why this arrives here at all rather than
 *     through the abort path; and
 *   - 130 does NOT identify which signal arrived. All three produce it, and the
 *     child leaves nothing behind to tell them apart.
 *
 * Verified on-device by injecting each signal into a live turn: every one gave
 * exit 130, an EMPTY stdout, and a stderr holding only the `session_id:`
 * banner. That is precisely the input `hermesFailureMessage` cannot work with —
 * the banner is stripped as bookkeeping, nothing else is there, and the turn
 * used to surface as the bare "hermes exited with code 130".
 */
export const HERMES_INTERRUPTED_EXIT_CODE = 130;

/**
 * What to tell a customer whose turn was cut short.
 *
 * Deliberately says "interrupted", never "cancelled" or "you stopped it": the
 * signal's identity is unrecoverable (see above), so naming a cause we cannot
 * know would be a guess dressed as a diagnosis. A user-initiated Stop does not
 * reach this path at all — that aborts the request, kills the child with
 * SIGKILL, and returns 499.
 *
 * The most common cause on a real device is the web server restarting (an
 * update, or a service restart) while the model was still answering: the
 * harness is a child of that server, so it goes down with it. Hence the
 * reassurance — the message itself is safe, and re-sending is the fix.
 */
export function interruptedTurnMessage(): string {
  return "The assistant was interrupted before it could answer — this usually means "
    + "the device restarted a service while the model was still working. "
    + "Your message was not lost: send it again.";
}

/**
 * The error text for a non-zero exit, preferring whatever the process actually
 * said and falling back to a named cause instead of a raw exit code.
 */
export function hermesExitMessage(code: number | null, stdout: string, stderr: string): string {
  // Named in the journal so a failed resumed turn can be checked from the
  // outside: the banner WAS received, and it was classified as bookkeeping.
  if (/^(?:↻\s*)?Resumed session\b/m.test(stderr)) {
    console.log("[hermes] resume banner on stderr ignored as bookkeeping, not an error");
  }
  const reported = hermesFailureMessage(stdout, stderr);
  if (reported) return reported;
  if (code === HERMES_INTERRUPTED_EXIT_CODE) return interruptedTurnMessage();
  return `hermes exited with code ${code}`;
}
