/**
 * The shared browser's clean-start rule, as the web server reaches it.
 *
 * Every launcher of the shared browser follows ONE rule, kept in ONE place:
 * scripts/lib/browser-clean-start.sh. scripts/launch-browser.sh (the unit the
 * keeper and "Open" start) sources it, the x64 desktop session's launcher
 * sources its installed copy, and the routes run it — no copy of their own.
 *
 * What it says for a browser that is already running: its page is brought to
 * the front, and a page is opened only when one was asked for, or when the
 * browser has no page at all. Pressing Open is asking for the browser, not
 * for a page, so a running browser gets no blank tab and no second start page.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import path from "./runtime-path";
import { CONFIG_ROOT } from "./config-store";

const exec = promisify(execFile);

/** The script, in the checkout the server runs from. */
export const CLEAN_START_SCRIPT = path.join(CONFIG_ROOT, "scripts", "lib", "browser-clean-start.sh");

/**
 * `focused`: brought forward (or, with no page, given the start page).
 * `unreachable`: nothing answers on the port. `failed`: it answers, but did
 * not take the request.
 */
export type FocusResult = "focused" | "unreachable" | "failed";

/**
 * Bring the browser answering on `cdpPort` (on this machine) to the owner.
 * `startUrl` is only for a browser with no page left; a running browser with a
 * page is never handed one.
 */
export async function focusRunningBrowser(
  cdpPort: number,
  startUrl: string,
  options: { script?: string } = {},
): Promise<FocusResult> {
  try {
    await exec("bash", [options.script ?? CLEAN_START_SCRIPT, "reuse", String(cdpPort), "", startUrl], { timeout: 20_000 });
    return "focused";
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return "unreachable";
    console.warn("[browser] Could not bring the running browser forward:", err instanceof Error ? err.message : err);
    return "failed";
  }
}
