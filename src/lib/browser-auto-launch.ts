/**
 * Has this desktop session already had its one automatic browser launch?
 *
 * The Browser app starts Chromium by itself when the owner opens the app —
 * once. That "once" used to be a ref on the component, and a ref does not
 * survive what the desktop does to a minimized window: ChromeWindow returns
 * null while `minimized`, so the app's whole subtree is unmounted and the fact
 * is forgotten. Restoring the window then found a stopped browser and started
 * Chromium again on the device's own screen — seconds after the owner had
 * closed it by hand.
 *
 * There is exactly ONE browser on this box, so the fact belongs to the page
 * rather than to a mount: a second Browser window must not be handed a launch
 * of its own either. It is spent by taking it, by finding Chromium already up,
 * by the owner opening or closing the browser themselves (after that the
 * window has nothing left to decide), and by a wizard the owner left without
 * opening it.
 *
 * In memory only, unlike the settings next door in browser-setup.ts: this is
 * not a decision the owner made, it is what has happened since the desktop
 * loaded. Persisting it would turn the automatic launch into a once-ever
 * event, and a reload ends the session — reaching for the app again afterwards
 * is the owner opening it afresh.
 */

let spent = false;

/** Has the automatic launch been used up in this page's lifetime? */
export function autoLaunchSpent(): boolean {
  return spent;
}

/** Use it up: the window has nothing left to decide about the browser. */
export function spendAutoLaunch(): void {
  spent = true;
}

/** Test seam: hand the next mount its automatic launch back. */
export function resetBrowserAutoLaunch(): void {
  spent = false;
}
