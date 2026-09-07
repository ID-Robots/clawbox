/**
 * ONE definition of "the journal of THIS run of a root step".
 *
 * Every root step the web server starts runs in a
 * `clawbox-root-update@<step>.service` instance, and every reader that wants
 * to know what that run said — the marker a skipped fixup leaves, the line
 * that says why a step failed, the progress a follow shows — has to answer two
 * questions at once: WHICH unit, and WHICH run of it.
 *
 * By unit NAME, not by invocation id. `systemctl show
 * clawbox-root-update@<step>.service -p InvocationID` answers EMPTY on a real
 * box: the instance is started ad hoc and referenced by nothing, so systemd
 * garbage-collects it as it exits and answers the query from a freshly
 * instantiated, never-run view of it — the same trap `updater.ts` records for
 * `-p Result`. Measured on both boxes, 2026-09-07: empty on the step that had
 * just written a marker, while 22 statically installed oneshots on the same
 * box still carried theirs. The journal does not have that problem: its
 * entries carry `_SYSTEMD_UNIT` from when they were written, so `-u <unit>`
 * answers long after the unit itself is gone.
 *
 * Which RUN is then `--since`. The journal is persistent on this box
 * (`step_persistent_journal` makes sure of it), so an unbounded read answers
 * with last week's update, or with the run the owner retried five minutes ago,
 * over one that said nothing — a failure invented by the reader. The window
 * opens at the moment the CALLER dispatched the step, so it cannot.
 *
 * A clock that jumps backwards mid-run narrows the window: that can lose a
 * line, it cannot invent one, which is the direction this has to fail in.
 */

/** The systemd instance one `install.sh --step <name>` run happens in. */
export function rootStepUnit(step: string): string {
  return `clawbox-root-update@${step}.service`;
}

/**
 * `journalctl` arguments for what THIS dispatch of `step` wrote.
 *
 * @param sinceMs when the caller started the step, `Date.now()`-style.
 * @param lines   how much of the window's tail to read.
 */
export function rootStepJournalArgs(
  step: string,
  { sinceMs, lines }: { sinceMs: number; lines: number },
): string[] {
  return [
    "-u",
    rootStepUnit(step),
    // systemd's own seconds-since-the-epoch form (systemd.time(7)), so the
    // bound carries no timezone and no locale. FLOORED, so an entry written in
    // the same second as the dispatch is inside the window.
    "--since",
    `@${Math.floor(sinceMs / 1000)}`,
    "-n",
    String(lines),
    "--no-pager",
    "-o",
    "cat",
  ];
}
