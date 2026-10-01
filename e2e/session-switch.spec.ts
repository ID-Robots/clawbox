import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";
import { mockTerminalWebSocket } from "./helpers/mock-backends";

/**
 * TASK-1247 — one browser, one session, in a real browser: separate tabs of one
 * context share the cookie jar, the BroadcastChannel and localStorage exactly
 * as an owner's tabs do. Picking a 12-hour session in one tab (or Switch user)
 * must move every other open ClawBox tab — the desktop with a Terminal window,
 * a standalone Terminal, a /login tab — onto the session that now holds,
 * without anyone pressing reload.
 */

const SIGNED_IN_SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

/** /login's own endpoints: who may sign in, the sign-in itself, the sign-out. */
async function mockLoginApi(page: Page, onSignIn: (body: Record<string, unknown>) => void = () => {}) {
  await page.route(/\/login-api\/users(\?.*)?$/, (route) => route.fulfill({ json: { multiUser: false } }));
  await page.route(/\/login-api\/logout$/, (route) => route.fulfill({ json: { success: true } }));
  await page.route(/\/login-api$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    onSignIn(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { success: true, username: "clawbox" } });
  });
}

async function openTab(page: Page, path: string) {
  await mockTerminalWebSocket(page);
  await installClawboxMocks(page, { initialSetup: SIGNED_IN_SETUP });
  await mockLoginApi(page);
  await page.goto(path);
}

/** Tag the document now on screen, so a test can tell it was replaced by a new one. */
async function markPreviousSession(page: Page) {
  await page.evaluate(() => { (window as unknown as { __previousSession?: boolean }).__previousSession = true; });
}

async function stillOnPreviousSession(page: Page): Promise<boolean | "navigating"> {
  try {
    return await page.evaluate(() => (window as unknown as { __previousSession?: boolean }).__previousSession === true);
  } catch {
    return "navigating";
  }
}

async function openTerminalWindow(page: Page) {
  await openLauncher(page);
  const terminalButton = page.getByTestId("app-launcher").getByRole("button", { name: "Terminal" });
  await terminalButton.focus();
  await terminalButton.press("Enter");
  await expect(page.getByTestId("chrome-window-terminal").locator(".xterm")).toBeVisible();
}

test("picking a 12-hour session in one tab moves every other open tab to it", async ({ page }) => {
  const context = page.context();

  // A desktop with a Terminal window open on the previous session.
  await openTab(page, "/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await openTerminalWindow(page);
  await markPreviousSession(page);

  // A standalone Terminal tab ("Open in new tab").
  const terminalTab = await context.newPage();
  await openTab(terminalTab, "/app/terminal");
  await expect(terminalTab.locator(".xterm")).toBeVisible();
  await markPreviousSession(terminalTab);

  // A tab the middleware sent to /login on its way to the Terminal.
  const waitingLogin = await context.newPage();
  await openTab(waitingLogin, "/login?redirect=%2Fapp%2Fterminal");
  await expect(waitingLogin.locator("#login-password")).toBeVisible();

  // The tab where the owner signs in, with the preselected 12 hours.
  const signIn = await context.newPage();
  const signIns: Array<Record<string, unknown>> = [];
  await mockTerminalWebSocket(signIn);
  await installClawboxMocks(signIn, { initialSetup: SIGNED_IN_SETUP });
  await mockLoginApi(signIn, (body) => signIns.push(body));
  await signIn.goto("/login");
  await signIn.locator("#login-password").fill("correct horse battery");
  await signIn.locator('button[type="submit"]').click();

  // The initiating tab lands on the new session's desktop …
  await expect(signIn).toHaveURL(/\/$/);
  await expect(signIn.getByTestId("desktop-root")).toBeVisible();
  expect(signIns).toEqual([expect.objectContaining({ duration: 43200 })]);

  // … and every other tab followed without a manual reload.
  await expect.poll(() => stillOnPreviousSession(page)).toBe(false);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await expect.poll(() => stillOnPreviousSession(terminalTab)).toBe(false);
  await expect(terminalTab).toHaveURL(/\/app\/terminal$/);
  await expect(terminalTab.locator(".xterm")).toBeVisible();

  await expect(waitingLogin).toHaveURL(/\/app\/terminal$/);
  await expect(waitingLogin.locator(".xterm")).toBeVisible();

  // Back from the new session never lands on the form it was signed in from.
  await signIn.goBack().catch(() => null);
  await expect(signIn).not.toHaveURL(/\/login/);
});

test("Switch user on one desktop takes the other open tabs with it", async ({ page }) => {
  const context = page.context();

  await openTab(page, "/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  const terminalTab = await context.newPage();
  await openTab(terminalTab, "/app/terminal");
  await expect(terminalTab.locator(".xterm")).toBeVisible();
  await markPreviousSession(terminalTab);

  await page.bringToFront();
  await page.getByTestId("shelf-power-button").click();
  await expect(page.getByTestId("system-tray")).toBeVisible();
  await page.getByTestId("system-tray").getByRole("button", { name: /Lock|Switch user/ }).click();

  await expect(page).toHaveURL(/\/login$/);
  // The other tab left the previous session too (with the gate on, the box
  // answers its address with /login; this server runs with the gate off).
  await expect.poll(() => stillOnPreviousSession(terminalTab)).toBe(false);
  await expect(terminalTab).toHaveURL(/\/app\/terminal$/);
});
