// "Is anything waiting for the owner's approval?", asked on a schedule.
//
// TWO SURFACES ASK IT. Settings → Email lists the approval queue, and the chat
// surface offers a batch card for it. Both need the same answer at the same
// time: a draft approved in one must stop being offered by the other within a
// few seconds, or the owner is looking at two disagreeing accounts of what his
// device is about to send.
//
// The schedule lives here rather than in each of them because it was already
// written twice the moment the second surface needed it, and the two copies
// would drift in exactly the way that is hardest to notice — one of them
// quietly stops polling, and the only symptom is a stale list nobody thinks to
// distrust. One implementation, two callers.
//
// WHAT THE SHAPE IS FOR, since none of the three triggers is redundant:
//
//   the interval  catches a draft that arrives while the owner sits and looks
//                 at a surface that is already open;
//   `focus`       catches the common case — he approved it in the other
//                 surface, or on Telegram, and came back to this tab;
//   `visibilitychange`
//                 catches the phone case, where a backgrounded tab is made
//                 visible again without the window ever taking focus.
//
// And the HIDDEN GUARD is why the interval is safe to run at all: this is a
// Jetson serving its own UI, and a poll behind a hidden tab is work nobody is
// reading. The guard is inside `run`, not around the interval, so it applies to
// every trigger rather than only the timer.

/**
 * How often to re-ask, while a surface that shows the queue is on screen.
 *
 * 15s is short enough that "I just approved that on my phone" is believable
 * when the owner looks back at the desktop, and long enough that a device
 * serving its own dashboard is not re-reading a small JSON file constantly.
 */
export const PENDING_REFRESH_MS = 15_000;

/**
 * Call `refresh` on focus, on becoming visible, and every `intervalMs` — but
 * never while the tab is hidden. Returns the unsubscribe.
 *
 * The caller decides WHEN this is installed (Settings only while its email
 * section is on screen; chat only while the panel is open), so that a surface
 * nobody is looking at is not on a timer. This function decides only how the
 * asking is paced.
 */
export function installPendingRefresh(
  refresh: () => void,
  options: { intervalMs?: number } = {},
): () => void {
  if (typeof window === "undefined") return () => {};
  const intervalMs = options.intervalMs ?? PENDING_REFRESH_MS;

  const run = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    refresh();
  };
  // Only the visible EDGE, not every visibility change: firing on the
  // transition to hidden would be a request whose answer lands in a tab that
  // has already stopped rendering.
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") run();
  };

  const timer = setInterval(run, intervalMs);
  window.addEventListener("focus", run);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", run);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
