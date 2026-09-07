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
 * Which RUN is then `--since`, in systemd's own seconds-since-the-epoch form
 * (systemd.time(7)). The journal is persistent on this box
 * (`step_persistent_journal` makes sure of it), so an unbounded read answers
 * with last week's update, or with the run the owner retried five minutes ago,
 * over one that said nothing — a failure invented by the reader. The window
 * opens at the moment the CALLER dispatched the step, so it cannot.
 *
 * What that window does and does not promise. A clock that steps mid-run only
 * narrows it: that can lose a line, it cannot invent one. A clock that was
 * AHEAD during an earlier run and is corrected between runs can, though —
 * those entries carry stamps in the future and fall inside a later window
 * until real time passes them.
 *
 * The other native bounds, and why not:
 * - `$INVOCATION_ID` inside the unit (or the root launcher echoing
 *   `systemctl show -p InvocationID` while the instance is still loaded) is
 *   the exact per-run id and needs no clock — but it is a WRITER change: no
 *   marker already in a box's journal could be read, and none could be read at
 *   all until every box had taken the update that adds it.
 * - `systemd-run`'s returned id is not our start path and cannot become one:
 *   the polkit action that authorises it is arbitrary passwordless root for
 *   the account the web server runs as, which is why root steps go through
 *   `clawbox-run-root-step.sh` instead (TASK-539).
 * - Journal CURSORS (`--show-cursor` at dispatch, `--after-cursor` on the
 *   read) are monotonic and clock-free, and would close the corrected-clock
 *   case above. Not used: it costs a second journalctl call at every dispatch
 *   and a new failure mode (a cursor that could not be taken) for a clock
 *   history timesyncd makes rare here. Whoever wants that bound should start
 *   at this docblock — every reader goes through this one function.
 *
 * And NOT `RemainAfterExit=yes` on `clawbox-root-update@.service`, which would
 * keep the instance loaded and make both `-p InvocationID` and `-p Result`
 * answer: the unit would then sit in `active (exited)` forever, which is what
 * `waitForRootStepToSettle` waits to leave and what the follow loops read as
 * "still running".
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
