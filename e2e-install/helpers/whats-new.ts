/**
 * The "What's new in 4.3" dialog on the desktop (src/components/WhatsNewCard.tsx).
 *
 * Every box on the release line it announces shows it on the desktop until
 * the owner dismisses it, and a freshly installed box is such a box. It is a
 * modal over the desktop and the chat: its backdrop takes every click meant
 * for the shelf, the launcher or the chat composer until it is closed. Left
 * alone it hides itself after 30 s (NOTICE_AUTO_HIDE_MS), so a click with a
 * longer timeout than that got through by outlasting the clock, and one with
 * a shorter timeout (the chat round trip's Send) did not get through at all.
 *
 * The specs close it the way an owner does, through its own dismiss button.
 * The box records the dismissal, so every later desktop load in the suite
 * comes up without it, on any browser.
 */
import { expect, type Page, type Response } from "@playwright/test";

/** The route whose answer decides whether the desktop draws the dialog. */
const WHATS_NEW_ROUTE = "/setup-api/whats-new";

/** How long the desktop has to ask the route after the navigation that loads it. */
const ANSWER_TIMEOUT_MS = 60_000;

function isWhatsNewAnswer(res: Response): boolean {
  return new URL(res.url()).pathname === WHATS_NEW_ROUTE && res.request().method() === "GET";
}

/**
 * Listen for the box's answer on whether the dialog shows. Call it BEFORE the
 * navigation that loads the desktop, a sign-in included: the desktop asks the
 * route once it mounts, and an answer that went by unheard is a dialog this
 * cannot know about.
 */
export function watchWhatsNew(page: Page): Promise<boolean> {
  const shows = page
    .waitForResponse(isWhatsNewAnswer, { timeout: ANSWER_TIMEOUT_MS })
    .catch((err: unknown) => {
      throw new Error(
        `the desktop never asked ${WHATS_NEW_ROUTE} whether "What's new" shows: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .then(async (res) => res.ok() && ((await res.json()) as { show?: unknown }).show === true);
  // Handled here as well, so a test that fails before it reads the answer
  // leaves no unhandled rejection behind; `dismissWhatsNew` still sees it.
  shows.catch(() => {});
  return shows;
}

/**
 * When the box said the dialog shows, close it through its dismiss button and
 * wait until its backdrop has left the page. Nothing to do when it said no
 * (dismissed earlier in the suite, or a box on another release).
 *
 * Call it before the first click on the desktop, and after any dialog drawn
 * over it (the plan celebration sits a layer above) has been closed.
 */
export async function dismissWhatsNew(page: Page, shows: Promise<boolean>): Promise<void> {
  if (!(await shows)) return;
  const dialog = page.getByTestId("whats-new-card");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^Dismiss What.s new/i }).click();
  await expect(page.getByTestId("whats-new-backdrop")).toHaveCount(0);
}
