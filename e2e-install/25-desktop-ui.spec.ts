/**
 * Desktop UI smoke — every other e2e-install spec drives the API layer
 * directly. This one drives the actual rendered React shell so the
 * shelf, launcher, window manager, and core apps get exercised
 * end-to-end at the click level.
 *
 *   1. Sign in (session may have been cleared by 15-login-relogin)
 *   2. Open the launcher
 *   3. For each core app (Files, Settings, Terminal): click → expect
 *      window → close
 *   4. Verify the system tray opens and closes cleanly
 *
 * Runs at NN=25 between settings (20) and files (30) so the desktop is
 * already alive but no later spec has mutated state we depend on.
 */
import { test, expect } from "@playwright/test";
import { BASE_URL } from "./helpers/container";
import { getStatus } from "./helpers/setup-api";

const SETUP_PASSWORD = "clawbox-e2e-pass";

test.describe.configure({ mode: "serial" });

test.describe("desktop UI happy path", () => {
  test.beforeAll(async () => {
    const status = await getStatus();
    test.skip(
      !status.setup_complete,
      "setup did not complete — desktop UI spec depends on a finished wizard",
    );
  });

  test("login lands on the desktop and the shelf renders", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) {
      await page.fill('input[type="password"]', SETUP_PASSWORD);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith("/login"), {
          timeout: 15_000,
        }),
        page.click('button[type="submit"]'),
      ]);
    }
    // The desktop root has a stable test id used by mocked specs.
    const desktop = page.getByTestId("desktop-root");
    await expect(desktop).toBeVisible({ timeout: 15_000 });
  });

  test("launcher opens and shows installed apps", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) {
      await page.fill('input[type="password"]', SETUP_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 15_000,
      });
    }
    // Click the shelf launcher button. Selector mirrors what e2e/desktop-smoke
    // uses against the same component tree.
    // ChromeShelf renders a mobile + a desktop variant of the launcher
    // button; one is hidden via tailwind responsive classes. Filter to the
    // visible one before clicking.
    const launcherButton = page
      .locator('[data-testid="shelf-launcher-button"]')
      .filter({ visible: true });
    await expect(launcherButton).toBeVisible({ timeout: 10_000 });
    await launcherButton.click();
    const launcher = page.getByTestId("app-launcher");
    await expect(launcher).toBeVisible();
    // Settings is a built-in app, always present regardless of installed state.
    await expect(launcher.getByRole("button", { name: /settings/i })).toBeVisible();
  });

  test("opening Files, Settings, and Terminal from the launcher renders each window", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) {
      await page.fill('input[type="password"]', SETUP_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    }

    // A prior install flow can leave its contextual chat prompt open above
    // the desktop. Close it through the visible control before exercising
    // the windows underneath, just as a user must do in the real UI.
    const chatPopup = page.getByTestId("chat-popup");
    if (await chatPopup.isVisible()) {
      await chatPopup.getByTestId("chat-popup-close").click();
      await expect(chatPopup).toHaveCount(0);
    }

    for (const app of [
      { name: /files/i, id: "files" },
      { name: /settings/i, id: "settings" },
      { name: /terminal/i, id: "terminal" },
    ]) {
      await page
        .locator('[data-testid="shelf-launcher-button"]')
        .filter({ visible: true })
        .click();
      await page
        .getByTestId("app-launcher")
        .getByRole("button", { name: app.name })
        .click();
      const appWindow = page.getByTestId(`chrome-window-${app.id}`);
      await expect(appWindow).toBeVisible({ timeout: 10_000 });
      await appWindow.getByRole("button", { name: "Close" }).click();
      await expect(appWindow).toHaveCount(0);
    }
  });

  test("system tray opens and closes via the shelf power button", async ({
    page,
  }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) {
      await page.fill('input[type="password"]', SETUP_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    }
    const trayToggle = page
      .locator('[data-testid="shelf-power-button"]')
      .filter({ visible: true });
    await expect(trayToggle).toBeVisible({ timeout: 10_000 });
    await trayToggle.click();
    await expect(page.getByTestId("system-tray")).toBeVisible();
    // Click outside to dismiss.
    await page.getByTestId("desktop-root").click({ position: { x: 10, y: 10 } });
    await expect(page.locator('[data-testid="system-tray"]')).toHaveCount(0);
  });
});
